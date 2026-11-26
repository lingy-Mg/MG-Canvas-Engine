import {MAX_BOARD_PATH_VERTICES,MAX_PATH_VERTICES} from "../core/document.ts";
import type {BoardDocument,VectorPath} from "../core/document.ts";
import {pathSegments,closestSegment,nearestParameter,segmentPoint} from "../core/path-geometry.ts";
import type {PathSegment} from "../core/path-geometry.ts";
import {gridPoint,screenToWorld,worldToScreen} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import type {EditorSession} from "../session/editor.ts";
import type {MovePreview} from "../session/transform.ts";
import {commitPathEdit,finishPath,withPathVertex,withPathControl,withSegmentKind,withInsertedVertex,interiorSplit} from "./vector-path.ts";

export type PathDecor=Readonly<{points:readonly Point[];hover?:Point;drawing:boolean;selected?:PathSegment;insertAt?:Point}>;
type Insertion=Readonly<{index:number;t:number;point:Point}>;
type Press={id:number;type:string;camera:Camera;start:Point;current:Point;index?:number;control?:"out"|"in";site?:Insertion;dragged?:boolean};
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function worldVertices(item:VectorPath){return item.vertices.map(p=>({x:item.at.x+p.x,y:item.at.y+p.y}));}

export class PathInput {
  readonly editor:EditorSession;
  mode?:"draw"|"anchors";
  pointer?:Press;
  preview?:MovePreview;
  points:Point[]=[];
  private hover?:Point;
  private source?:BoardDocument;
  private generation?:symbol;
  private item?:VectorPath;
  private candidate?:VectorPath;
  private segments:readonly PathSegment[]=[];
  private marker?:Insertion;
  inserting=false;
  canInsert=false;
  constructor(editor:EditorSession){this.editor=editor;}
  segment=0;
  part:"auto"|"vertex"|"out"|"in"="auto";
  get segmentCount(){return this.item?this.item.vertices.length-(this.item.closed?0:1):0;}
  get curved(){return Boolean(this.item?.curves?.[this.segment]);}
  choose(index:number){
    if(!this.pointer&&Number.isInteger(index)&&index>=0&&index<this.segmentCount){
      this.segment=index;this.part="auto";
      if(this.inserting)this.marker=this.site(index,.5);
    }
  }
  armInsert(){
    if(!this.item||this.pointer||!this.canInsert)return false;
    this.inserting=!this.inserting;this.marker=this.inserting?this.site(this.segment,.5):undefined;return true;
  }
  stopInsert(){this.inserting=false;this.marker=undefined;this.pointer=undefined;}
  private site(index:number,t:number,touch=false,click?:Point):Insertion|undefined{
    const s=this.segments[index];
    if(!s||!interiorSplit(t))return;
    const point=gridPoint(segmentPoint(s,t)),clearance=(touch?12:6)/this.editor.camera.zoom;
    const nearEnd=(p:Point)=>Math.min(distance(p,s.from),distance(p,s.to))<=clearance;
    if(nearEnd(point)||click&&nearEnd(click))return;
    return {index,t,point};
  }
  private locate(screen:Point,type:string):Insertion|undefined{
    if(!this.item)return;
    const camera=this.editor.camera,p=screenToWorld(screen,camera),touch=type==="touch";
    const hit=closestSegment(this.segments,p,(touch?17:8)/camera.zoom+this.item.strokeWidth/2,this.segment);
    return hit===undefined?undefined:this.site(hit,nearestParameter(this.segments[hit],p),touch,p);
  }
  private insert(site?:Insertion):boolean{
    if(!this.inserting||!this.canInsert||!site||!this.item||!this.generation)return false;
    const item=this.item,value=withInsertedVertex(item,site.index,site.t);
    if(!commitPathEdit(this.editor,item,value,this.generation,"插入路径顶点"))return false;
    const next=this.editor.doc.objects[item.id];
    if(next?.kind==="path")this.start(next,site.index);
    return true;
  }
  insertMidpoint():boolean{return !this.pointer&&this.insert(this.site(this.segment,.5));}
  history(redo:boolean){
    const item=this.item,index=this.segment,part=this.part,generation=this.generation;
    if(item)this.cancel();
    if(redo)this.editor.redo();else this.editor.undo();
    const next=item&&this.editor.doc.objects[item.id];
    if(next?.kind==="path"&&generation===this.editor.generation&&this.editor.selectedIds.length===1&&this.editor.selection===next.id){
      this.start(next,Math.min(index,next.vertices.length-(next.closed?1:2)));
      if(this.curved)this.part=part;
    }
  }
  toggle(){
    const item=this.item;
    if(!item||this.pointer||!this.generation)return false;
    const index=this.segment,value=withSegmentKind(item,index,!this.curved);
    const applied=commitPathEdit(this.editor,item,value,this.generation,this.curved?"曲线转直线":"直线转曲线");
    const next=this.editor.doc.objects[item.id];
    if(applied&&next?.kind==="path")this.start(next,index);
    return applied;
  }
  start(item?:VectorPath,index=0){
    this.cancel();if(item&&(this.editor.isLocked(item.id)||this.editor.isHidden(item.id)))return;
    this.source=this.editor.doc;this.generation=this.editor.generation;
    this.mode=item?"anchors":"draw";this.item=item;this.segment=index;this.part="auto";
    if(item){
      this.segments=pathSegments(item);
      this.canInsert=item.vertices.length<MAX_PATH_VERTICES&&Object.values(this.editor.doc.objects)
        .reduce((count,o)=>count+(o.kind==="path"?o.vertices.length:0),0)<MAX_BOARD_PATH_VERTICES;
    }
  }
  cancel(){
    this.mode=undefined;this.pointer=undefined;this.points=[];this.hover=undefined;
    this.segments=[];this.marker=undefined;this.inserting=false;this.canInsert=false;
    this.source=undefined;this.generation=undefined;this.item=undefined;this.candidate=undefined;this.preview=undefined;
  }
  sync(){
    if(this.inserting&&!this.pointer)this.marker=undefined;
    if(this.mode&&(this.source!==this.editor.doc||this.generation!==this.editor.generation||
      this.pointer&&this.pointer.camera!==this.editor.camera||
      (this.item?this.editor.isLocked(this.item.id)||this.editor.selection!==this.item.id||this.editor.selectedIds.length!==1:this.editor.selectedIds.length>0)))this.cancel();
  }
  decor():PathDecor|undefined{
    if(this.mode==="draw")return {points:this.points,hover:this.hover,drawing:true};
    if(this.item){
      const value=this.candidate??this.item;
      return {points:worldVertices(value),drawing:false,selected:(this.candidate?pathSegments(value):this.segments)[this.segment],insertAt:this.marker?.point};
    }
  }
  down(id:number,type:string,screen:Point):boolean{
    if(!this.mode||this.pointer)return false;
    if(this.inserting){
      this.marker=this.locate(screen,type);
      this.pointer={id,type,camera:this.editor.camera,start:screen,current:screen,site:this.marker};return true;
    }
    let index:number|undefined,control:"out"|"in"|undefined;
    if(this.item){
      const camera=this.editor.camera,radius=type==="touch"?17:8,segments=this.segments;
      let best=Infinity,preferred=false;
      const offer=(p:Point,i:number,side?:"out"|"in")=>{
        const d=distance(worldToScreen(p,camera),screen),favor=this.part===(side??"vertex");
        if(d>radius||preferred&&!favor||preferred===favor&&d>=best)return;
        index=i;control=side;best=d;preferred=favor;
      };
      worldVertices(this.item).forEach((v,i)=>offer(v,i));
      const pair=segments[this.segment]?.controls;
      if(pair){offer(pair.c1,this.segment,"out");offer(pair.c2,this.segment,"in");}
      if(index===undefined){
        const hit=closestSegment(segments,screenToWorld(screen,camera),(radius/camera.zoom)+this.item.strokeWidth/2);
        if(hit===undefined){this.cancel();return false;}
        this.choose(hit);
      }
    }
    this.pointer={id,type,camera:this.editor.camera,start:screen,current:screen,index,control};
    if(this.mode==="draw")this.hover=gridPoint(screenToWorld(screen,this.editor.camera));
    return true;
  }
  move(id:number,screen:Point,type="mouse"){
    if(!this.mode||this.pointer&&this.pointer.id!==id)return;
    if(this.pointer)this.pointer.current=screen;
    if(this.inserting){
      const press=this.pointer;
      if(!press){this.marker=this.locate(screen,type);return;}
      if(distance(press.start,screen)>=(press.type==="touch"?6:3))press.dragged=true;
      const hit=!press.dragged&&press.site?this.locate(screen,press.type):undefined;
      this.marker=hit?.index===press.site?.index?hit:undefined;return;
    }
    const world=screenToWorld(screen,this.editor.camera);
    if(this.mode==="draw"){this.hover=gridPoint(world);return;}
    const press=this.pointer,item=this.item;
    if(!press||!item||press.index===undefined)return;
    const start=screenToWorld(press.start,this.editor.camera);
    const moved=distance(press.start,screen)>=(press.type==="touch"?6:2);
    const delta={x:world.x-start.x,y:world.y-start.y};
    this.candidate=moved?(press.control?withPathControl(item,press.index,press.control,delta):withPathVertex(item,press.index,delta)):undefined;
    this.preview=this.candidate?{ids:[item.id],objects:new Map([[item.id,this.candidate]])}:undefined;
  }
  up(id:number,screen:Point){
    const press=this.pointer;
    if(!press||press.id!==id)return;
    this.move(id,screen);this.pointer=undefined;
    if(this.inserting){
      const site=this.marker;this.marker=undefined;this.insert(site);return;
    }
    if(this.mode==="anchors"&&this.item){
      const original=this.item,candidate=this.candidate;
      this.preview=undefined;this.candidate=undefined;
      if(candidate&&this.generation){
        const segment=this.segment,part=this.part;
        commitPathEdit(this.editor,original,candidate,this.generation,press.control?"移动曲线控制柄":"移动路径顶点");
        const next=this.editor.doc.objects[original.id];
        if(next?.kind==="path"&&this.editor.selection===next.id){this.start(next,segment);this.part=part;}
      }
      return;
    }
    if(this.mode!=="draw")return;
    if(this.points.length>=3&&distance(worldToScreen(this.points[0],this.editor.camera),screen)<=(press.type==="touch"?14:8)){
      this.finish(true);return;
    }
    const point=gridPoint(screenToWorld(screen,this.editor.camera)),last=this.points.at(-1);
    if(this.points.length<MAX_PATH_VERTICES&&(!last||last.x!==point.x||last.y!==point.y))this.points.push(point);
    this.hover=undefined;
  }
  finish(closed:boolean):boolean{
    if(this.mode!=="draw"||this.pointer||!this.generation)return false;
    const applied=finishPath(this.editor,this.generation,this.points,closed);
    if(applied)this.cancel();
    return applied;
  }
  leave(){if(!this.pointer){this.hover=undefined;this.marker=undefined;}}
}
