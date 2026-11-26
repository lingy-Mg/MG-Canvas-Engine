import type {Id} from "../core/document.ts";
import type {Rect} from "../core/geometry.ts";

const CELL=512, TILE_SIDE=16, TILE_SIZE=CELL*TILE_SIDE;
const MAX_FOOTPRINT=64, MAX_QUERY_TILES=1600, MAX_FINE_PROBES=16384;
const key=(x:number,y:number)=>x+":"+y;

export function cellRange(box:Rect,size=CELL){
  const x1=Math.floor(box.min.x/size), y1=Math.floor(box.min.y/size);
  const x2=Math.floor(box.max.x/size), y2=Math.floor(box.max.y/size);
  const safe=[x1,y1,x2,y2].every(Number.isSafeInteger)&&x1<=x2&&y1<=y2;
  return {x1,y1,x2,y2,safe,count:(x2-x1+1)*(y2-y1+1)};
}

type Tile={fine:Map<number,Set<Id>>;large:Set<Id>};
export type GridQueryWork=Readonly<{
  mode:"indexed"|"extent"|"density"|"fine-limit";tiles:number;fineProbes:number;memberships:number;
}>;

/** Ordinary groups use existing 512-unit buckets. The tile directory holds one
 * reference per occupied bucket; longer groups use tiles directly, up to 64. */
export class SceneGrid{
  private fine=new Map<string,Set<Id>>();
  private tiles=new Map<string,Tile>();
  private oversized=new Set<Id>();

  clear(){this.fine.clear();this.tiles.clear();this.oversized.clear();}
  fineMembers(x:number,y:number):ReadonlySet<Id>|undefined{return this.fine.get(key(x,y));}
  add(id:Id,box:Rect){return this.change(id,box,true);}
  remove(id:Id,box:Rect){this.change(id,box,false);}

  private tile(x:number,y:number){
    const address=key(x,y);
    let tile=this.tiles.get(address);
    if(!tile){tile={fine:new Map(),large:new Set()};this.tiles.set(address,tile);}
    return tile;
  }
  private prune(x:number,y:number,tile:Tile){
    if(!tile.fine.size&&!tile.large.size)this.tiles.delete(key(x,y));
  }
  private changeFine(id:Id,x:number,y:number,add:boolean){
    const address=key(x,y),ids=this.fine.get(address);
    if(ids&&add){ids.add(id);return;}
    if(!add&&(!ids||!ids.delete(id)||ids.size))return;
    const tx=Math.floor(x/TILE_SIDE),ty=Math.floor(y/TILE_SIDE);
    const slot=(y-ty*TILE_SIDE)*TILE_SIDE+(x-tx*TILE_SIDE);
    if(add){
      const members=new Set([id]);
      this.fine.set(address,members);this.tile(tx,ty).fine.set(slot,members);
    }else{
      this.fine.delete(address);
      const tile=this.tiles.get(key(tx,ty))!;
      tile.fine.delete(slot);this.prune(tx,ty,tile);
    }
  }
  private change(id:Id,box:Rect,add:boolean){
    const fine=cellRange(box);
    if(fine.safe&&fine.count<=MAX_FOOTPRINT){
      for(let y=fine.y1;y<=fine.y2;y++)for(let x=fine.x1;x<=fine.x2;x++)this.changeFine(id,x,y,add);
      return true;
    }
    const broad=cellRange(box,TILE_SIZE);
    if(broad.safe&&broad.count<=MAX_FOOTPRINT){
      for(let y=broad.y1;y<=broad.y2;y++)for(let x=broad.x1;x<=broad.x2;x++){
        if(add)this.tile(x,y).large.add(id);
        else{
          const tile=this.tiles.get(key(x,y));
          if(tile){tile.large.delete(id);this.prune(x,y,tile);}
        }
      }
    }else if(add)this.oversized.add(id);
    else this.oversized.delete(id);
    return false;
  }

  /** False requests an exact paint-order scan. A budget never truncates visible results. */
  collect(rect:Rect,groupCount:number,out:Set<Id>,audit?:(work:GridQueryWork)=>void):boolean{
    let tiles=0,fineProbes=0,memberships=0;
    const finish=(mode:GridQueryWork["mode"])=>{
      audit?.({mode,tiles,fineProbes,memberships});
      return mode==="indexed";
    };
    const fine=cellRange(rect),broad=cellRange(rect,TILE_SIZE);
    if(!fine.safe||!broad.safe||broad.count>MAX_QUERY_TILES)return finish("extent");
    const membershipBudget=Math.max(2048,Math.min(32768,Math.ceil(groupCount*.65)));
    const take=(ids:ReadonlySet<Id>)=>{
      if(memberships+ids.size>membershipBudget)return false;
      memberships+=ids.size;
      for(const id of ids)out.add(id);
      return true;
    };
    if(!take(this.oversized))return finish("density");
    for(let ty=broad.y1;ty<=broad.y2;ty++)for(let tx=broad.x1;tx<=broad.x2;tx++){
      const tile=this.tiles.get(key(tx,ty));tiles++;
      if(!tile)continue;
      if(!take(tile.large))return finish("density");
      const ox=tx*TILE_SIDE,oy=ty*TILE_SIDE;
      const x1=Math.max(0,fine.x1-ox),x2=Math.min(TILE_SIDE-1,fine.x2-ox);
      const y1=Math.max(0,fine.y1-oy),y2=Math.min(TILE_SIDE-1,fine.y2-oy);
      const slots=(x2-x1+1)*(y2-y1+1);
      if(fineProbes+Math.min(slots,tile.fine.size)>MAX_FINE_PROBES)return finish("fine-limit");
      // For a small hit rectangle probe its slots. For a wide sparse view visit only occupied buckets.
      if(slots<tile.fine.size){
        for(let y=y1;y<=y2;y++)for(let x=x1;x<=x2;x++){
          const ids=tile.fine.get(y*TILE_SIDE+x);fineProbes++;
          if(ids&&!take(ids))return finish("density");
        }
      }else{
        for(const [slot,ids] of tile.fine){
          const x=slot%TILE_SIDE,y=Math.floor(slot/TILE_SIDE);fineProbes++;
          if(x>=x1&&x<=x2&&y>=y1&&y<=y2&&!take(ids))return finish("density");
        }
      }
    }
    return finish("indexed");
  }
}
