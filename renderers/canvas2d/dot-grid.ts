import type {Point} from "../../core/geometry.ts";

const SIDE=8;
const RADIUS=.85;

function appendDots(path:CanvasPath,cols:number,rows:number,step:number){
  for(let i=0;i<cols;i++)for(let j=0;j<rows;j++){
    const x=i*step,y=j*step;
    path.moveTo(x+RADIUS,y);path.arc(x,y,RADIUS,0,2*Math.PI);
  }
}

type Tile={cols:number;rows:number;path:Path2D};

/** CSS-space geometry only. The four slots represent full, right, bottom and corner
 * tiles. Color, device ratio and fractional pan are applied when painting. */
export class DotGridPainter {
  private step=0;
  private tiles:(Tile|undefined)[]=[];
  private readonly Path=typeof Path2D==="function"?Path2D:undefined;

  private tile(cols:number,rows:number,step:number){
    if(!this.Path)return;
    if(step!==this.step){this.step=step;this.tiles=[];}
    const slot=(cols<SIDE?1:0)+(rows<SIDE?2:0),cached=this.tiles[slot];
    if(cached?.cols===cols&&cached.rows===rows)return cached.path;
    const path=new this.Path();appendDots(path,cols,rows,step);
    this.tiles[slot]={cols,rows,path};
    return path;
  }

  /** The caller selects the fill color and CSS-to-device transform before painting. */
  draw(ctx:CanvasRenderingContext2D,width:number,height:number,ratio:number,zoom:number,offset:Point){
    let step=22*zoom;
    if(!Number.isFinite(step)||step<=0)return;
    while(step<14)step*=2;
    const left=((offset.x%step)+step)%step,top=((offset.y%step)+step)%step;
    if(left>=width||top>=height)return;

    // Small grids (including high zoom) already fit in one inexpensive path.
    if(Math.ceil(width/step)*Math.ceil(height/step)<=SIDE*SIDE){
      ctx.beginPath();
      for(let x=left;x<width;x+=step)for(let y=top;y<height;y+=step){
        ctx.moveTo(x+RADIUS,y);ctx.arc(x,y,RADIUS,0,2*Math.PI);
      }
      ctx.fill();
      return;
    }

    // Advance the actual visible centers, including at the last partially visible tile.
    for(let x=left;x<width;){
      const tileX=x;let cols=0;
      while(cols<SIDE&&x<width){cols++;x+=step;}
      for(let y=top;y<height;){
        const tileY=y;let rows=0;
        while(rows<SIDE&&y<height){rows++;y+=step;}
        const path=this.tile(cols,rows,step);
        ctx.setTransform(ratio,0,0,ratio,tileX*ratio,tileY*ratio);
        if(path)ctx.fill(path);
        else{
          ctx.beginPath();appendDots(ctx,cols,rows,step);ctx.fill();
        }
      }
    }
  }
}
