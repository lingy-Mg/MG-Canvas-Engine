import {memo} from "react";
import {Control,useView,useWorkspace} from "./Controls.tsx";
import type {LayerEntry} from "./workspace-ui.ts";

export function LayerSearchField(){
  const version=useView(useWorkspace().searchVersion);
  return <Control as="input" key={version} id="layer-search" type="text" role="searchbox" autoComplete="off" spellCheck={false}
    aria-label="按名称搜索图层" aria-controls="layers" placeholder="搜索图层名称" inputMode="search" enterKeyHint="search"/>;
}
const LayerRow=memo(function LayerRow({row}:{row:LayerEntry}){
  return <button type="button" className="layer" data-id={row.id} data-flow-group={row.group}
    data-locked={String(row.locked)} data-hidden={String(row.hidden)} title={row.title}
    aria-label={row.accessible} aria-pressed={row.selected}>
    <span className={"layer-icon "+row.kind}>{row.glyph}</span>
    <span className="layer-name">{row.label}</span>
    <span className="layer-visibility" hidden={!row.hidden}>{row.visibility}</span>
  </button>;
});
export function LayerRows(){
  const rows=useView(useWorkspace().layers);
  return rows.map(row=><LayerRow key={row.key} row={row}/>);
}
