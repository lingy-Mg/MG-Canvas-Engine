import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const raw=JSON.parse(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8"));
const id="sample-ink",template=raw.document.objects["flow-submit"];
const median=xs=>Number(xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)].toFixed(4));
function timed(fn,n){
  for(let i=0;i<3;i++)fn();
  const ms=[];for(let i=0;i<n;i++){const begin=performance.now();fn();ms.push(performance.now()-begin);}return median(ms);
}
function observeReads(editor,fn){
  const doc=editor.doc,out={enumerations:0,selected:0,other:0,far:0,connectors:0};
  const objects=new Proxy(doc.objects,{
    ownKeys(t){out.enumerations++;return Reflect.ownKeys(t);},
    get(t,k,r){const value=Reflect.get(t,k,r);if(typeof k==="string"&&Object.hasOwn(t,k)){
      if(k===id)out.selected++;else out.other++;if(k.startsWith("far-"))out.far++;if(value.kind==="connector")out.connectors++;
    }return value;}
  });
  Object.defineProperty(editor,"doc",{value:{...doc,objects},configurable:true});
  try{fn();return out;}finally{delete editor.doc;}
}
function observeCommit(history,tx,dispatch){
  const original=Object.assign,values=Object.values,entries=Object.entries,keys=Object.keys;
  const rows=history.doc.objects,tables=new Set([rows]);const work={tableCopies:0,copiedReferences:0,boardEnumerations:0};
  Object.assign=function(target,...sources){
    if(sources.includes(rows)){work.tableCopies++;work.copiedReferences+=history.doc.order.length;tables.add(target);}
    return original(target,...sources);
  };
  const count=fn=>function(target){if(tables.has(target))work.boardEnumerations++;return fn(target);};
  Object.values=count(values);Object.entries=count(entries);Object.keys=count(keys);
  try{const changed=dispatch(history,tx);assert.deepEqual(changed.changeSet.updated,[id]);assert.deepEqual(changed.changeSet.invalidatedConnectors,[]);
    assert.equal(changed.state.past.length,1);return work;
  }finally{Object.assign=original;Object.values=values;Object.entries=entries;Object.keys=keys;}
}
export async function checkInkWork({entry,el,all,layer,clickLayer,waitFor},old){
  const {EditorSession}=await import(new URL("../session/editor.js",entry)),{dispatch}=await import(new URL("../core/history.js",entry));
  const protoSelect=EditorSession.prototype.select;let editor;const results=[];
  EditorSession.prototype.select=function(...args){editor=this;return protoSelect.apply(this,args);};
  try{
    for(const farCount of [0,20_000]){
      const far={},farIds=[];for(let i=0;i<farCount;i++){
        const key="far-"+i;far[key]={...template,id:key,at:{x:1e6+(i%200)*60,y:1e6+Math.floor(i/200)*100}};farIds.push(key);
      }
      const doc={...raw.document,objects:{...far,...raw.document.objects},order:[...farIds,...raw.document.order]};
      const file=JSON.stringify({...raw,document:doc}),oldRow=layer(id),picker=el("project-picker");
      picker.files=[new File([file],"ink-planning.mgcanvas")];picker.emit("change");
      await waitFor(()=>layer(id)&&layer(id)!==oldRow&&el("status").textContent==="项目已打开","load planning fixture");
      clickLayer(id);assert.equal(editor.selection,id);const history=editor.history;assert.equal(history.doc.order.length,doc.order.length);
      for(const combined of old?[false]:[false,true]){
        const field=name=>all(el("inspector")).find(n=>n.name===name);
        const x=field("x"),form=x.closest("form"),edit=(f,v)=>{f.value=String(v);f.emit("input");};
        if(combined){edit(field("selectedInkWidth"),5);edit(field("selectedInkScale"),200);edit(field("selectedInkTurn"),90);edit(field("selectedInkColor"),"#000000");}
        const input=()=>edit(x,5),submit=()=>form.emit("submit");
        let tx;const apply=editor.apply;
        // Stop at the real application/dispatch boundary to time command preparation separately.
        editor.apply=proposal=>{tx=proposal;};
        let inputReads,submitReads,commandReads,inputMs,submitMs,commandMs;
        try{
          inputReads=observeReads(editor,input);submitReads=observeReads(editor,submit);
          assert.equal(tx?.patches.length,1);assert.equal(tx.patches[0].value.at.x,5);
          inputMs=timed(input,51);submitMs=timed(submit,15);
          const property=tx;const direct=()=>editor.transformSelection({x:5,y:199});
          commandReads=observeReads(editor,direct);commandMs=timed(direct,15);tx=property;
        }finally{delete editor.apply;assert.equal(editor.apply,apply);}
        assert.equal(editor.history,history);assert.equal(history.revision,0);
        const commit=observeCommit(history,tx,dispatch);assert.equal(commit.tableCopies,1);assert.equal(commit.copiedReferences,doc.order.length);assert.equal(commit.boardEnumerations,0);
        for(const reads of [submitReads,commandReads]){
          assert.equal(reads.enumerations,old?1:0);assert.equal(reads.far,old?farCount:0);assert.equal(reads.connectors,old?1:0);
          if(!old)assert.equal(reads.other,0);
        }
        assert.equal(inputReads.enumerations,0);assert.equal(inputReads.other,0);assert.equal(inputReads.selected,old?0:1);
        const commitMs=timed(()=>dispatch(history,tx),15);
        results.push({rows:doc.order.length,farCount,combined,inputReads,submitReads,commandReads,commit,
          medianMs:{input:inputMs,submitPlan:submitMs,directPlan:commandMs,immutableCommit:commitMs}});
      }
    }
    console.log(JSON.stringify({runtime:process.version,iterations:{warm:3,input:51,plan:15,commit:15},results}));
  }finally{EditorSession.prototype.select=protoSelect;}
}
