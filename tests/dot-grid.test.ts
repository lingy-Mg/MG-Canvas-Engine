import assert from "node:assert/strict";
import {test} from "node:test";
import {DotGridPainter} from "../renderers/canvas2d/dot-grid.ts";

type Dot={x:number;y:number;r:number};
class RecordingPath {
  dots:Dot[]=[];
  moveTo(){}
  arc(x:number,y:number,r:number){this.dots.push({x,y,r});}
}
class Drawing extends RecordingPath {
  paths:RecordingPath[]=[];
  batchSizes:number[]=[];
  moves=0;
  centers:Dot[]=[];
  matrix=[1,1,0,0];
  setTransform(a:number,_b:number,_c:number,d:number,e:number,f:number){this.matrix=[a,d,e,f];}
  beginPath(){this.dots=[];}
  moveTo(){this.moves++;}
  fill(path?:RecordingPath){
    this.batchSizes.push((path??this).dots.length);
    if(path)this.paths.push(path);
    const [a,d,e,f]=this.matrix;
    for(const {x,y,r} of (path??this).dots)this.centers.push({x:a*x+e,y:d*y+f,r:a*r});
  }
}
function painter(cached:boolean){
  const old=Object.getOwnPropertyDescriptor(globalThis,"Path2D");
  Object.defineProperty(globalThis,"Path2D",{configurable:true,value:cached?RecordingPath:undefined});
  try{return new DotGridPainter();}finally{
    if(old)Object.defineProperty(globalThis,"Path2D",old);else Reflect.deleteProperty(globalThis,"Path2D");
  }
}
function paint(grid:DotGridPainter,w:number,h:number,z:number,dpr:number,x=0,y=0){
  const c=new Drawing();c.setTransform(dpr,0,0,dpr,0,0);
  grid.draw(c as unknown as CanvasRenderingContext2D,w,h,dpr,z,{x,y});
  return c;
}
function expected(w:number,h:number,z:number,r:number,dx:number,dy:number){
  const step=22*z*2**Math.max(0,Math.ceil(Math.log2(14/(22*z))));
  const phase=(v:number)=>((v%step)+step)%step, dots:Dot[]=[];
  for(let x=phase(dx);x<w;x+=step)for(let y=phase(dy);y<h;y+=step)dots.push({x:r*x,y:r*y,r:.85*r});
  return dots;
}
const ordered=(dots:Dot[])=>dots.sort((a,b)=>a.x-b.x||a.y-b.y);
function close(actual:Dot[],wanted:Dot[]){
  assert.equal(actual.length,wanted.length);ordered(actual);ordered(wanted);
  for(const [i,p] of actual.entries()){
    assert(Math.abs(p.x-wanted[i].x)<1e-8&&Math.abs(p.y-wanted[i].y)<1e-8);
    assert.equal(p.r,wanted[i].r);
  }
}

test("dot lattice retains world phase, radius and density over DPR, zoom and signed subpixel cameras",()=>{
  for(const cached of [true,false]){
    const grid=painter(cached);
    for(const z of [.05,.25,14/22-1e-8,14/22,1,2.3,16])for(const dpr of [1,1.25,2,3]){
      for(const [dx,dy] of [[0,0],[37,-51],[10.375,-7.25],[2**40+.125,-(2**40)-.875]]){
        close(paint(grid,458,318,z,dpr,dx,dy).centers,expected(458,318,z,dpr,dx,dy));
      }
    }
  }
});
test("subpixel panning tracks the same world dots through a modulo wrap and whole-period translations",()=>{
  const grid=painter(true),z=.05,r=1.5,period=17.6;
  for(let n=-16;n<=16;n++){
    const dx=period+n/8,dy=-period+n/8;
    close(paint(grid,356,248,z,r,dx,dy).centers,expected(356,248,z,r,dx,dy));
    close(paint(grid,356,248,z,r,dx+period*16,dy-period*16).centers,expected(356,248,z,r,dx+period*16,dy-period*16));
  }
});
test("a full-HD lattice reuses native tiles across frames, fractional pan and DPR",()=>{
  const grid=painter(true),a=paint(grid,1920,1080,.05,1);
  assert.equal(a.centers.length,6820);assert.equal(a.paths.length,112);assert.equal(a.moves,0);
  assert.equal(new Set(a.paths).size,4);assert.deepEqual([...new Set(a.paths)].map(p=>p.dots.length),[64,48,48,36]);
  for(const next of [paint(grid,1920,1080,.05,1),paint(grid,1920,1080,.05,2,.25,-17.5)])
    assert(next.paths.length===a.paths.length&&next.paths.every((p,i)=>p===a.paths[i]));
});
test("the full tile survives resizes, edge and corner slots are replaced, and a new spacing clears all four",()=>{
  const grid=painter(true);
  const tall=paint(grid,400,1550,1,1);
  const full=tall.paths.find(p=>p.dots.length===64)!,tail=tall.paths.at(-1)!;
  assert(full&&tail!==full);assert.equal(tail.dots.length,21);
  const resized=paint(grid,400,1600,1,1).paths;
  assert(resized.includes(full));assert(!resized.includes(tail));
  const back=paint(grid,400,1550,1,1).paths;assert(back.includes(full)&&!back.includes(tail));
  const changed=paint(grid,400,1550,.95,1).paths;
  assert(!changed.includes(full)&&!changed.includes(back.at(-1)!));
});
test("without Path2D each fill contains at most 64 circles and matches the cached geometry including clipped edges",()=>{
  const c=paint(painter(false),831,2191,.05,1.25,-.25,17.5),p=paint(painter(true),831,2191,.05,1.25,-.25,17.5);
  assert.equal(c.paths.length,0);assert.equal(c.moves,c.centers.length);
  assert.equal(c.dots.length,p.paths.at(-1)?.dots.length);
  assert(c.batchSizes.every(n=>n<=64));assert.deepEqual(c.batchSizes,p.batchSizes);
  close(c.centers,p.centers);
});
test("sparse high-zoom and sub-dot surfaces do not allocate a retained tile or paint beyond the last center",()=>{
  const grid=painter(true);
  const sparse=paint(grid,1920,1080,16,2);
  assert.equal(sparse.paths.length,0);assert.equal(sparse.moves,24);
  assert.deepEqual(paint(grid,.5,.5,1,1,1,1).centers,[]);
  for(const z of [0,Infinity,NaN])assert.deepEqual(paint(grid,100,100,z,1).centers,[]);
});
