import {Control,useView,useWorkspace} from "./Controls.tsx";

export function ViewportControls(){
  return (
<>
<span id="selection-count" role="status" aria-atomic="true" hidden></span>
    <div className="view-controls">
      <Control as="div" id="view-zoom" className="zoom-bar" aria-label="画布控件">
        <Control as="button" id="drag-snap" className="flat snap-toggle" type="button" aria-label="拖动对齐与等距吸附" aria-pressed="false" title="移动和复制都可对齐或等距。先按 Alt / Option 再拖动可复制，普通拖动中再按可暂停吸附"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-snap"/></svg><span>吸附</span></Control>
        <Control as="button" id="zoom-out" className="icon-button" aria-label="缩小" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-minus"/></svg></Control>
        <Control as="button" id="fit" className="flat fit-content" type="button" aria-label="回到内容" aria-describedby="zoom-read" aria-keyshortcuts="0" title="回到内容（快捷键 0）">
          <span className="fit-caption">回到内容 <kbd aria-hidden="true">0</kbd></span>
          <Control as="span" id="zoom-read">100%</Control>
        </Control>
        <Control as="button" id="zoom-in" className="icon-button" aria-label="放大" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-plus"/></svg></Control>
      </Control>
    </div>
    <details id="diagnostics" open>
      <summary id="diagnostics-toggle" className="icon-button" title="画布性能" aria-label="画布性能">
        <svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 17h18M4 13l4-4 3 3 4-7 5 3"/></svg>
      </summary>
      <div className="diagnostic-controls">
        <FrameMeterDisplay/>
        <label className="frame-rate"><span>最大帧率</span><Control as="select" id="frame-rate" defaultValue="unlimited" aria-label="最大帧率">
          <option value="30">30 FPS</option><option value="60">60 FPS</option><option value="120">120 FPS</option>
          <option value="140">140 FPS</option><option value="170">170 FPS</option><option value="unlimited">无限制</option>
        </Control></label>
      </div>
    </details>
    <Control as="output" id="flow-help" className="flow-help" aria-live="polite" hidden></Control>
</>
  );
}

function FrameMeterDisplay(){
  const view=useView(useWorkspace().frameMeter);
  return (
    <div id="frame-meter" role="group" aria-label="画布流畅度，最近六秒。限帧时虚线表示依据浏览器刷新节奏估算的正常慢帧间隔。">
      <div className="frame-meter-heading"><span>最低 · 6 秒</span><span id="frame-meter-state">{view.state}</span></div>
      <strong id="frame-meter-min">{view.minimum}</strong>
      <svg viewBox="0 0 148 24" aria-hidden="true">
        <path className="frame-meter-grid" d="M0 8H148M0 16H148"/>
        <path id="frame-meter-budget" visibility={view.budget?"visible":"hidden"} d={view.budget}/>
        <path id="frame-meter-line" d={view.line}/>
        <circle id="frame-meter-low" r="2.4" cx={view.marker?.x} cy={view.marker?.y} data-late={view.marker&&String(view.marker.late)} visibility={view.marker?"visible":"hidden"}/>
      </svg>
    </div>
  );
}
