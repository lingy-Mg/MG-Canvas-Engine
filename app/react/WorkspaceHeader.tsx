import {Control} from "./Controls.tsx";

export function WorkspaceHeader({version}:{version:string}){
  return (
  <header className="header">
    <div className="doc">
      <div className="sigil" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M5 22V10l6 6 5-6 5 6 6-6v12" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round"/></svg></div>
      <div className="doc-info"><Control as="strong" id="project-title" dir="auto">画板</Control><div className="doc-meta"><Control as="span" id="status" role="status" aria-live="polite">未保存</Control><div className="subtitle">开发预览 {version}</div></div></div>
    </div>
    <div className="document-actions" role="group" aria-label="文件">
      <Control as="details" id="file-history" className="file-history"><summary title="重开已保存的画板" aria-label="已存画板"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-history"/></svg><span>历史</span></summary>
        <div className="file-history-list">
      <Control as="button" id="open" className="menu-button" type="button" title="打开最近保存的画板">重开</Control>
      <Control as="button" id="open-other" className="menu-button" type="button" hidden>另一副本</Control>
      <Control as="button" id="open-legacy" className="menu-button" type="button" hidden>旧副本</Control>
      <Control as="button" id="open-fourth" className="menu-button" type="button" hidden>更多副本</Control>
      <Control as="button" id="open-fifth" className="menu-button" type="button" hidden>更多副本</Control>
      <Control as="button" id="open-sixth" className="menu-button" type="button" hidden>更多副本</Control>
      <Control as="button" id="open-seventh" className="menu-button" type="button" hidden>更多副本</Control>
      <Control as="button" id="open-eighth" className="menu-button" type="button" hidden>更多副本</Control>
        </div>
      </Control>
      <Control as="button" id="project-open" className="header-button" type="button" title="导入项目文件" aria-label="导入"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-file"/></svg><span>导入</span></Control>
      <Control as="button" id="project-export" className="header-button" type="button" title="导出项目文件" aria-label="导出"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-upload"/></svg><span>导出</span></Control>
      <Control as="button" id="save" className="button primary" type="button" title="保存（Ctrl+S）"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-save"/></svg><span>保存</span></Control>
    </div>
    <div className="workspace-actions">
      <Control as="div" id="workspace-theme" className="workspace-theme" role="radiogroup" aria-label="工作区外观">
        <label title="浅色"><Control as="input" id="theme-light" type="radio" name="appearance" value="light"/><span><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-sun"/></svg><span>浅色</span></span></label>
        <label title="深色"><Control as="input" id="theme-dark" type="radio" name="appearance" value="dark"/><span><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-moon"/></svg><span>深色</span></span></label>
        <label title="跟随系统"><Control as="input" id="theme-system" type="radio" name="appearance" value="system" defaultChecked/><span><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-display"/></svg><span>跟随系统</span></span></label>
      </Control>
      <div className="panel-switch" role="group" aria-label="工作区面板">
        <Control as="button" id="toggle-layers" className="panel-toggle" type="button" aria-label="图层" title="图层" aria-controls="layers-panel" aria-expanded="false"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-layers"/></svg><span>图层</span></Control>
      </div>
    </div>
  </header>
  );
}
