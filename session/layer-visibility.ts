import type {BoardDocument,Id} from "../core/document.ts";
import {objectById} from "../core/document.ts";
import {incidentConnectorIds} from "../core/history.ts";

/** Only this open board owns the directly hidden IDs. Bound lines derive their
 * visibility from both ends without changing the connector or its route. */
export class LayerVisibility {
  private direct=new Set<Id>();
  private document?:BoardDocument;
  private effective:ReadonlySet<Id>=new Set();
  revision=0;

  hidden(doc:BoardDocument):ReadonlySet<Id>{
    if(this.document===doc)return this.effective;
    const next=new Set<Id>();
    for(const id of this.direct){
      const item=objectById(doc,id);
      if(!item)continue;
      next.add(id);
      if(item.kind==="shape")for(const edge of incidentConnectorIds(doc,id))next.add(edge);
    }
    this.document=doc;
    if(next.size!==this.effective.size||[...next].some(id=>!this.effective.has(id)))this.effective=next;
    return this.effective;
  }
  isDirectlyHidden(id:Id):boolean{return this.direct.has(id);}
  hasHiddenEndpoint(doc:BoardDocument,id:Id):boolean{
    const item=objectById(doc,id);
    return item?.kind==="connector"&&[item.from,item.to].some(end=>end.kind==="anchor"&&this.direct.has(end.objectId));
  }
  set(doc:BoardDocument,ids:readonly Id[],visible:boolean):boolean{
    if(!ids.length||ids.some(id=>!objectById(doc,id)))return false;
    let changed=false;
    for(const id of ids){
      if(visible){
        if(this.direct.delete(id))changed=true;
        const item=doc.objects[id];
        if(item.kind==="connector")for(const end of [item.from,item.to]){
          if(end.kind==="anchor"&&this.direct.delete(end.objectId))changed=true;
        }
      }else if(!this.direct.has(id)){this.direct.add(id);changed=true;}
    }
    if(changed){this.document=undefined;this.revision++;}
    return changed;
  }
  clear():boolean{
    if(!this.direct.size)return false;
    this.direct.clear();this.document=undefined;this.revision++;return true;
  }
}
