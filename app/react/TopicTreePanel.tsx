import {useView,useWorkspace} from "./Controls.tsx";

export function TopicTreePanel(){
  const tree=useView(useWorkspace().topics);
  return <section id="topic-tree" className="topic-tree" aria-label="当前脑图的主题层级" hidden={!tree}>
    {tree&&<>
      <button id="topic-tree-toggle" type="button" aria-expanded={tree.opened} aria-controls="topic-tree-body" onClick={tree.toggle}>
        {tree.opened?"▾ ":"▸ "}主题 · {tree.title}
      </button>
      <div id="topic-tree-body" className="topic-tree-body" hidden={!tree.opened}>
        <p id="topic-tree-status" className="topic-tree-status" role="status">{tree.status}</p>
        <button id="topic-tree-current" type="button" hidden={!tree.current} onClick={tree.locate}>定位当前主题 · {tree.current}</button>
        <div id="topic-tree-list" className="topic-tree-list" role="tree" aria-label="当前脑图主题"
          aria-description="方向键浏览，空格选中。已选主题按 Tab 新增子主题，Enter 新增同级，F2 改名。Esc 返回画布。">
          {tree.rows.map(row=>{
            const title=[row.caption,row.context].filter(Boolean).join(" · ");
            return <button key={tree.epoch+"/"+row.id} type="button" role="treeitem" className="topic-row" data-map-id={tree.mapId}
              data-topic-id={row.id} aria-level={row.level} aria-setsize={row.size} aria-posinset={row.position}
              aria-label={title} title={title} aria-selected={row.id===tree.active} aria-expanded={row.expanded}
              tabIndex={row.id===tree.cursor?0:-1} style={{paddingInlineStart:row.indent}} onFocus={()=>tree.focus(row.id)}
              onClick={e=>tree.choose(row.id,e.target instanceof Element&&e.target.classList.contains("topic-caret"))}
              onKeyDown={e=>tree.key(e.nativeEvent,row.id)}>
              <span className="topic-caret" aria-hidden="true">{row.expanded===undefined?"":row.expanded?"▾":"▸"}</span>
              <span className="topic-row-copy"><span className="topic-caption">{row.caption}</span><span className="topic-context" hidden={!row.context}>{row.context}</span></span>
            </button>;
          })}
        </div>
        <div className="topic-tree-pager" hidden={tree.pages<=1}>
          <button id="topic-tree-prev" type="button" disabled={!tree.page} onClick={()=>tree.turn(-1)}>上页</button>
          <span>{tree.page+1} / {tree.pages}</span>
          <button id="topic-tree-next" type="button" disabled={tree.page+1>=tree.pages} onClick={()=>tree.turn(1)}>下页</button>
        </div>
      </div>
    </>}
  </section>;
}
