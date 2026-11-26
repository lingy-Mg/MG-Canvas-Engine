import {Control} from "./Controls.tsx";
import {LayerRows,LayerSearchField} from "./LayerRows.tsx";
import {TopicTreePanel} from "./TopicTreePanel.tsx";

export function LayersPanel(){
  return (
  <Control as="aside" id="layers-panel" className="floating-panel layers-panel" aria-label="图层" tabIndex="-1" hidden>
    <div className="panel-title"><strong><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-layers"/></svg>图层</strong><div className="layer-lock-actions">
      <Control as="button" id="layer-hide" type="button" title="隐藏所选图层，仅限本次打开" aria-label="隐藏所选图层" disabled>隐藏</Control>
      <Control as="button" id="layer-show-all" type="button" title="显示当前画板的全部图层" aria-label="显示全部图层" hidden>全显</Control>
      <Control as="button" id="layer-lock" type="button" title="锁定所选图层，仅限本次打开" aria-label="锁定所选图层" disabled>锁定</Control>
      <Control as="button" id="layer-unlock" type="button" title="解锁所选图层" aria-label="解锁所选图层" hidden>解锁</Control>
      <Control as="button" id="close-layers" className="icon-button" type="button" title="收起图层面板" aria-label="收起图层面板"><svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#glyph-close"/></svg></Control>
    </div></div>
    <div className="layer-search" role="search" aria-label="图层名称">
      <Control as="span" id="layer-search-field" className="layer-search-field"><LayerSearchField/></Control>
      <Control as="button" id="layer-search-clear" className="layer-search-clear" type="button" aria-label="清空图层搜索" title="清空图层搜索" hidden>×</Control>
    </div>
    <Control as="p" id="layer-results" className="layer-results" role="status" hidden></Control>
    <TopicTreePanel/>
    <Control as="div" id="layers" aria-label="对象列表"><LayerRows/></Control>
    <Control as="div" id="layer-paging" className="layer-paging" hidden>
      <Control as="div" id="layer-page-controls"><Control as="button" id="layer-newer" className="button" type="button">上一页</Control><Control as="span" id="layer-page-read" aria-live="polite"></Control><Control as="button" id="layer-older" className="button" type="button">下一页</Control></Control>
      <Control as="button" id="layer-locate" className="button" type="button">定位所选图层</Control>
    </Control>
  </Control>
  );
}
