import {useCallback,useState} from "react";
import {CanvasViewport} from "./CanvasViewport.tsx";
import type {BindCanvasViewport} from "./CanvasViewport.tsx";
import {startEditor} from "../editor-runtime.ts";
import type {WorkspaceSource} from "../workspace-source.ts";
import {WorkspaceUI} from "./workspace-ui.ts";
import {Control,WorkspaceContext,useView,useWorkspace} from "./Controls.tsx";
import {WorkspaceHeader} from "./WorkspaceHeader.tsx";
import {LayersPanel} from "./LayersPanel.tsx";
import {ViewportControls} from "./ViewportControls.tsx";
import {ToolDock} from "./ToolDock.tsx";
import {GlyphLibrary} from "./GlyphLibrary.tsx";
import {ObjectEditingLayer} from "./ObjectEditingLayer.tsx";

function ContextMenu(){
  const items=useView(useWorkspace().menu);
  return <Control as="div" id="arrange-menu" className="arrange-menu" role="menu" aria-label="画布操作" tabIndex={-1} hidden>
    {items.map(item=>item.separator?<div key={item.key} role="separator" hidden={item.hidden}/>:
      item.status?<p key={item.key} id="flow-layout-feedback" className="layout-feedback" role="status" hidden={item.hidden}>{item.label}</p>:
      <button key={item.key} type="button" role="menuitem" tabIndex={-1} hidden={item.hidden} disabled={item.disabled}
        data-arrange={item.arrange} data-group-action={item.group} data-visibility-action={item.key==="visibility"?"toggle":undefined} data-flow-layout={item.flowLayout} data-drop-node={item.dropNode}
        aria-label={item.label} aria-keyshortcuts={item.shortcut} aria-describedby={item.description} onClick={item.run}>
        {item.shortcut?<><span>{item.label}</span><kbd>{item.shortcut}</kbd></>:item.label}
      </button>)}
  </Control>;
}
export function WorkspaceApp({source,version}:{source:WorkspaceSource;version:string}){
  const [ui]=useState(()=>new WorkspaceUI());
  const bind=useCallback<BindCanvasViewport>(hosts=>startEditor(hosts,ui,source),[ui,source]);
  return <WorkspaceContext.Provider value={ui}>
    <GlyphLibrary/>
    <div id="workspace">
      <WorkspaceHeader version={version}/>
      <LayersPanel/>
      <CanvasViewport bind={bind}>
        <ViewportControls/>
        <ToolDock/>
        <ObjectEditingLayer/>
      </CanvasViewport>
    </div>
    <Control as="input" id="image-picker" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden/>
    <Control as="input" id="project-picker" type="file" accept=".mgcanvas,.md,.markdown,application/json,text/markdown" hidden/>
    <Control as="input" id="markdown-picker" type="file" accept=".md,.markdown,text/markdown,text/plain" hidden/>
    <ContextMenu/>
  </WorkspaceContext.Provider>;
}
