import {Control} from "./Controls.tsx";
import {DockRail,InkSwatches,PaperSwatches} from "./DockPalettes.tsx";

export function ToolDock(){
  return (
<>
    <Control as="div" id="path-tools" className="tool-strip secondary-tools" role="group" aria-label="路径操作" hidden>
      <Control as="label" id="path-segment-label" className="dock-control" hidden><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-point"/></svg><span>段</span> <Control as="input" id="path-segment" type="number" inputMode="numeric" min="1" step="1" aria-label="选中路径段"/></Control>
      <Control as="button" id="path-insert" className="tool" type="button" aria-pressed="false" title="点路径插入，Enter 在选中段的参数中点插入" hidden><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-insert"/></svg><span>插入顶点</span></Control>
      <Control as="button" id="path-convert" className="tool" type="button" hidden><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-curve"/></svg><span>转为曲线</span></Control>
      <label className="dock-control part-control"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-point"/></svg><span>目标</span><Control as="select" id="path-part" aria-label="重叠时选择拖动目标" title="重叠时选择拖动目标" hidden><option value="auto">自动选点</option><option value="vertex">顶点</option><option value="out">起点柄</option><option value="in">终点柄</option></Control></label>
      <Control as="button" id="path-finish" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-check"/></svg><span>完成开放路径</span></Control>
      <Control as="button" id="path-close" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-loop"/></svg><span>闭合路径</span></Control>
      <Control as="button" id="path-cancel" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-close"/></svg><span>取消</span></Control>
    </Control>
    <Control as="div" id="mind-tools" className="tool-strip secondary-tools" role="group" aria-label="脑图主题操作" hidden>
      <Control as="button" id="mind-child" className="tool" type="button" title="添加子主题"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-child"/></svg><span>子主题</span></Control>
      <Control as="button" id="mind-sibling" className="tool" type="button" title="添加同级主题"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-sibling"/></svg><span>同级</span></Control>
      <Control as="button" id="mind-edit" className="tool" type="button" title="编辑主题文字"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-edit"/></svg><span>改字</span></Control>
      <Control as="button" id="mind-fold" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-fold"/></svg><span>折叠</span></Control>
      <Control as="button" id="mind-done" className="tool" type="button" title="退出主题编辑"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-check"/></svg><span>完成</span></Control>
    </Control>
    <Control as="div" id="shape-palette" className="tool-strip secondary-tools" role="group" aria-label="形状工具" hidden>
      <Control as="button" id="shape-process" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-rect"/></svg><span>矩形 · 流程</span></Control>
      <Control as="button" id="shape-decision" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-diamond"/></svg><span>菱形 · 判断</span></Control>
      <Control as="button" id="shape-triangle" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-triangle"/></svg><span>三角形</span></Control>
      <Control as="button" id="shape-line" className="tool" type="button"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-line"/></svg><span>自由直线</span></Control>
    </Control>
    <Control as="div" id="ink-tools" className="tool-strip secondary-tools ink-tools" role="group" aria-label="手写工具设置" hidden>
      <Control as="button" id="ink-pen" className="tool ink-tool" type="button" title="普通笔" aria-label="普通笔" aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-ink-pen"/></svg></Control>
      <Control as="button" id="ink-highlighter" className="tool ink-tool" type="button" title="荧光笔" aria-label="荧光笔" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-marker"/></svg></Control>
      <Control as="button" id="ink-eraser" className="tool ink-tool" type="button" title="笔迹橡皮（擦除整笔）" aria-label="笔迹橡皮" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-ink-eraser"/></svg></Control>
      <span className="tool-sep" aria-hidden="true"></span>
      <Control as="button" id="ink-thin" className="tool ink-weight" type="button" aria-label="细笔触" title="细笔触" aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-ink-stroke"/></svg></Control>
      <Control as="button" id="ink-thick" className="tool ink-weight thick" type="button" aria-label="粗笔触" title="粗笔触" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-ink-stroke"/></svg></Control>
      <label className="ink-size"><Control as="input" id="ink-width" type="range" min="1" max="32" step="1" defaultValue="4" aria-label="笔触粗细"/><Control as="output" id="ink-width-value" htmlFor="ink-width">4</Control></label>
      <span className="tool-sep" aria-hidden="true"></span>
      <Control as="div" id="ink-swatches" className="ink-swatches" role="group" aria-label="预设颜色"><InkSwatches/></Control>
      <Control as="label" id="ink-custom" className="ink-custom" title="自选颜色"><Control as="span" id="ink-custom-chip" aria-hidden="true"></Control><Control as="input" id="ink-color" type="color" defaultValue="#223344" aria-label="自选颜色"/></Control>
      <span className="tool-sep" aria-hidden="true"></span>
      <Control as="button" id="ink-finger" className="tool ink-tool" type="button" title="手指书写" aria-label="手指书写" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-hand"/></svg></Control>
    </Control>
    <div id="placement-preview" aria-hidden="true" hidden>
      <svg className="placement-shape" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        <rect width="100" height="100" vectorEffect="non-scaling-stroke"/>
        <polygon className="diamond" points="50,0 100,50 50,100 0,50" vectorEffect="non-scaling-stroke"/>
        <polygon className="triangle" points="50,0 100,100 0,100" vectorEffect="non-scaling-stroke"/>
      </svg>
    </div>
    <Control as="div" id="sticky-palette" className="tool-strip secondary-tools sticky-palette" role="radiogroup" aria-label="便签底色" hidden><PaperSwatches/></Control>
    <Control as="div" id="document-tools" className="tool-strip secondary-tools" role="group" aria-label="文档操作" hidden>
      <Control as="button" id="import-markdown" className="tool" type="button" title="导入 Markdown 文件"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-file"/></svg><span>导入 .md</span></Control>
    </Control>
    <DockRail>
      <div className="dock-group dock-navigation" role="group" aria-label="导航">
        <Control as="button" id="tool-select" className="tool selected" type="button" title="选择" aria-pressed="true">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path className="glyph-solid" strokeWidth="1.2" d="M5 3.5 20 12l-6.8 1.2 3.1 6-3 1.5-3.2-6.2-4.2 4.7Z"/></svg>
          <span>选择</span>
        </Control>
        <Control as="button" id="tool-hand" className="tool" type="button" title="平移" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 13V6a1.5 1.5 0 0 1 3 0v4-5a1.5 1.5 0 0 1 3 0v5-3a1.5 1.5 0 0 1 3 0v4-2a1.5 1.5 0 0 1 3 0v5a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2-2.1l2 1.4"/></svg>
          <span>平移</span>
        </Control>
      </div>
      <Control as="button" id="toggle-creation" className="tool" type="button" aria-expanded="false"
        aria-controls="creation-tools" title="创作工具">
        <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><path d="M17.5 14v7m-3.5-3.5h7"/></svg>
        <span>创作工具</span>
      </Control>
      <Control as="div" id="creation-tools" className="dock-group dock-creation" role="group" aria-label="创作工具">
        <Control as="button" id="tool-shapes" className="tool" type="button" title="图形" aria-controls="shape-palette" aria-expanded="false" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2.8" y="4.2" width="11.2" height="10" rx="2.1"/><path className="glyph-surface" d="m15.8 9 6.5 6.4-6.5 6.2-6.5-6.2Z"/></svg>
          <span>图形</span>
        </Control>
        <Control as="button" id="tool-connect" className="tool" type="button" title="连接" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5.7 17H8c5 0 2.7-10 8-10h2.2"/><circle className="glyph-surface" cx="4.5" cy="17" r="2.1"/><circle className="glyph-surface" cx="19.5" cy="7" r="2.1"/></svg>
          <span>连接</span>
        </Control>
        <Control as="button" id="tool-mind" className="tool" type="button" aria-pressed="false" title="新建脑图">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 12h2.2c3.5 0 2.5-6 6.3-6h1M9.2 12c3.5 0 2.5 6 6.3 6h1"/><rect className="glyph-surface" x="2" y="9.6" width="5.5" height="4.8" rx="1.4"/><rect x="16" y="3.7" width="5.5" height="4.6" rx="1.3"/><rect x="16" y="15.7" width="5.5" height="4.6" rx="1.3"/></svg>
          <span>脑图</span>
        </Control>
        <div className="tool-sep" aria-hidden="true"></div>
        <Control as="button" id="tool-text" className="tool" type="button" title="添加独立文字" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7V4h14v3M12 4v16M9 20h6"/></svg>
          <span>文字</span>
        </Control>
        <Control as="button" id="tool-document" className="tool" type="button" title="放置 Markdown 文档" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5.2 3.2h9l4.8 4.9v12.7H5.2Z"/><path className="glyph-surface" d="M13.6 3.5v5.3h5.1"/><path d="M8.5 12.3h7.2m-7.2 4h5.2"/></svg>
          <span>文档</span>
        </Control>
        <Control as="button" id="tool-sticky" className="tool" type="button" title="放置便签" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path className="glyph-surface" d="M4.4 3.7h15.1a1 1 0 0 1 1 1v9.6l-6.8 6.2H4.4a1 1 0 0 1-1-1V4.7a1 1 0 0 1 1-1Z"/><path d="M13.6 20.1v-5a1 1 0 0 1 1-1h5.5"/></svg>
          <span>便签</span>
        </Control>
        <Control as="button" id="tool-table" className="tool" type="button" title="放置表格" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path className="glyph-surface" d="M3 9V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3Z"/><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-12 0v11m6-11v11"/></svg>
          <span>表格</span>
        </Control>
        <div className="tool-sep" aria-hidden="true"></div>
        <Control as="button" id="tool-path" className="tool" type="button" title="逐点绘制矢量路径" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 17c0-6 4-11 10-11h5"/><path className="glyph-surface" d="M2 15h4v4H2zm15-11h4v4h-4Z"/><path d="M4 17V9"/><circle cx="4" cy="8.5" r="1"/></svg>
          <span>路径</span>
        </Control>
        <Control as="button" id="tool-ink" className="tool" type="button" title="手写" aria-controls="ink-tools" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24"><Control as="use" id="ink-main-icon" href="#glyph-ink-pen"/></svg>
          <Control as="span" id="ink-main-label">手写</Control><Control as="i" id="ink-main-color" aria-hidden="true"></Control>
        </Control>
        <Control as="button" id="tool-image" className="tool" type="button" title="导入 PNG、JPEG 或静态 WebP">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2.8" y="4.4" width="18.4" height="15.2" rx="2.6"/><path className="glyph-surface" d="m3.3 17 5.3-5.2 4.2 4.2 3-3.1 5.1 5.3c-.4.9-1.3 1.4-2.3 1.4H5c-.9 0-1.6-.8-1.7-2.6Z"/><circle className="glyph-solid" cx="15.6" cy="8.6" r="1.2" stroke="none"/></svg>
          <span>图片</span>
        </Control>
      </Control>
      <div className="dock-group dock-history" role="group" aria-label="编辑历史">
        <Control as="button" id="undo" className="tool" type="button" title="撤销" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6 4 11l5 5M4 11h10a5 5 0 0 1 5 5v2"/></svg>
          <span>撤销</span>
        </Control>
        <Control as="button" id="redo" className="tool" type="button" title="重做" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 6 5 5-5 5m5-5H10a5 5 0 0 0-5 5v2"/></svg>
          <span>重做</span>
        </Control>
      </div>
    </DockRail>
</>
  );
}
