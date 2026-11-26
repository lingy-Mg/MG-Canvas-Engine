import {worldToScreen} from "../../core/geometry.ts";
import type {Camera} from "../../core/geometry.ts";
import type {FlowDecor} from "../../features/flow-input.ts";
import type {canvasThemes,WorkspaceTheme} from "../../platform/theme.ts";
import {connectorArrows} from "../../scene/connector-arrows.ts";

type Palette=typeof canvasThemes[WorkspaceTheme];
export function paintFlowDraft(c:CanvasRenderingContext2D,flow:FlowDecor,camera:Camera,r:number,palette:Palette){
  if(flow?.draft?.length){
    c.setTransform(r,0,0,r,0,0);
    const points=flow.draft.map(p=>worldToScreen(p,camera));
    const arrows=flow.arrow&&connectorArrows(points,2,flow.arrow),shaft=arrows?.shaft??points;
    c.strokeStyle=palette.accent;c.lineWidth=2;c.setLineDash([5,4]);c.beginPath();
    c.moveTo(shaft[0].x,shaft[0].y);for(const p of shaft.slice(1))c.lineTo(p.x,p.y);
    c.stroke();c.setLineDash([]);
    c.fillStyle=palette.accent;
    for(const [tip,a,b] of arrows?.heads??[]){c.beginPath();c.moveTo(tip.x,tip.y);c.lineTo(a.x,a.y);c.lineTo(b.x,b.y);c.closePath();c.fill();}
  }
}
export function paintFlowMarkers(c:CanvasRenderingContext2D,flow:FlowDecor,camera:Camera,r:number,palette:Palette,w:number,h:number){
  if(flow?.markers.length){
    c.setTransform(r,0,0,r,0,0);c.setLineDash([]);c.lineWidth=1.6;
    for(const mark of flow.markers){
      const p=worldToScreen(mark.point,camera);
      if(p.x< -10||p.y< -10||p.x>w+10||p.y>h+10)continue;
      if(mark.kind==="input"&&mark.active){
        c.strokeStyle=palette.valid;c.beginPath();c.arc(p.x,p.y,8,0,2*Math.PI);c.stroke();continue;
      }
      const solid=mark.active||mark.kind==="origin";
      c.fillStyle=solid?palette.accent:palette.handle;c.strokeStyle=palette.accent;c.beginPath();
      if(mark.kind==="waypoint"){
        const size=mark.selected?10:8;c.rect(p.x-size/2,p.y-size/2,size,size);
      }
      else if(mark.kind==="input"){const d=solid?6:4.5;c.moveTo(p.x,p.y-d);c.lineTo(p.x+d,p.y);c.lineTo(p.x,p.y+d);c.lineTo(p.x-d,p.y);c.closePath();}
      else c.arc(p.x,p.y,mark.kind==="endpoint"?5:solid?6:4.5,0,Math.PI*2);
      c.fill();c.stroke();
    }
  }
}
