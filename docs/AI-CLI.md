# AI 画板 CLI

## Windows 桌面工作台

Windows 安装包从 0.2.0 起包含控制台程序 `mgcanvas.exe`。从安装目录运行，或用安装目录下该文件的完整路径。打开平时使用的 MG Canvas 工作台后，同一 Windows 用户和登录会话中的 CLI 会自动连接该窗口。桌面控制通过本机命名管道，无需启动开发服务。0.1.0 工作台没有此控制入口。

```powershell
$mg = '.\mgcanvas.exe'
& $mg --help
& $mg tools
& $mg open 'C:\Boards\会议室.mgcanvas'
$state = & $mg read | ConvertFrom-Json
$state.objects | Format-Table id,kind,label
```

Explorer 双击已关联的 `.mgcanvas` 文件会打开桌面工作台。已有工作台时，文件交给当前窗口。`mgcanvas open` 同样沿用打开项目的流程，包括对活动编辑和未保存内容的检查。`NO_WINDOW` 表示需要先打开工作台。

`tools` 返回实时工具目录、输入 Schema 和注解。`read` 等同于 `call canvas_read`。每次 `call` 接受一个 JSON 参数对象，省略时使用 `{}`。中文参数可通过 UTF-8 文件 `--args-file PATH` 传入，支持 BOM。自动化也可用 `--stdin` 或 `--args-file -` 写入 UTF-8 标准输入，再关闭输入流。单次命令在标准输出返回一行 JSON，中文和其他非 ASCII 字符用 JSON 转义保留。

```powershell
$argsPath = Join-Path $env:TEMP ('mgcanvas-args-' + [guid]::NewGuid() + '.json')
@{
  baseRevision = $state.revision
  operationId = [guid]::NewGuid().ToString()
  mermaid = "flowchart TD`nA[提交申请] --> B[审批通过]"
} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $argsPath
$drawing = & $mg call canvas_draw_flow --args-file $argsPath | ConvertFrom-Json
@{ action = 'fit'; ids = $drawing.nodeIds } |
  ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $argsPath
& $mg call canvas_view --args-file $argsPath
@{
  action = 'undo'
  baseRevision = $drawing.revision
  operationId = [guid]::NewGuid().ToString()
} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $argsPath
& $mg call canvas_history --args-file $argsPath
```

现有 `canvas_edit`、`canvas_draw_flow` 和 `canvas_history` 使用 `baseRevision` 和 `operationId`，与窗口里的撤销历史共用一次提交。结果未知时先读取当前项目。若需要重试同一次编辑，在同一工作台会话中原样重发原参数。收到 `STALE` 时重新读取修订和目标，收到 `BUSY` 时检查 `blockingReasons`。MCP 客户端可用 `mgcanvas mcp` 连接同一工作台。[配置桌面 MCP](Desktop-MCP.md)

```powershell
& $mg export --out 'C:\Boards\会议室副本.mgcanvas'
& $mg png --active --out 'C:\Boards\会议室全图.png'
& $mg png --file 'C:\Boards\会议室副本.mgcanvas' --id flow-submit --scale 2 --out 'C:\Boards\提交节点.png'
```

`export` 导出工作台当前已提交的工程和原始图片。`png --active` 读取同一快照及其 `revision`，`png --file` 可以在关掉工作台后运行。桌面 PNG 使用系统 WebView2。省略 `--id` 时渲染全图，缩放默认为 `auto`，也可以指定 `0.05` 至 `8`。成功的输出包含绝对 `path`、`bytes`、`sha256`，PNG 还包含像素宽高、实际倍率、世界坐标范围和偏移。工程和 PNG 的输出都要求目标路径尚不存在。打开工程的 UTF-8 文件上限为 72 MiB，工具参数上限为 1 MiB。

| 退出码 | 含义 |
| --- | --- |
| 0 | 操作成功 |
| 2 | 命令、参数、项目数据或对象无效 |
| 3 | 修订、操作 ID、输出文件或活动编辑冲突，或用户取消 |
| 4 | 工作台未打开或未就绪，或遇到访问、I/O、渲染错误 |
| 5 | 工作台可能已执行请求，结果待核对 |

开发时可用 `python -B scripts/check-desktop-cli.py --cli <mgcanvas.exe> --gui <mg-canvas-desktop.exe>` 验证这两个已构建的桌面程序。检查使用独立实例名称 `MGCANVAS_INSTANCE` 和独立的 WebView2 数据目录。

## 仓库中的 Node CLI

从项目根目录使用 Node.js 24.3 或更新版本。命令把一个 JSON 对象写入标准输出。非 ASCII 字符使用标准 JSON 转义，在不同代码页下均可用 PowerShell 的 `ConvertFrom-Json` 还原中文。用 Node 直接调用可省去 npm 日志。

```powershell
npm ci
npm run build
node scripts/mgcanvas.mjs capabilities
$board = 'docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas'
node scripts/mgcanvas.mjs inspect --file $board --kind connector
node scripts/mgcanvas.mjs inspect --file $board --map mind-booking
node scripts/mgcanvas.mjs inspect --file $board --id flow-submit
```

## 在打开的 HTML 中编辑

在第一个 PowerShell 窗口创建新目录并启动桥接。保留该窗口，打开标准输出 JSON 的完整 `url`。它只授权一个编辑页。目录已存在时可换一个名字。

```powershell
$demo = Join-Path $env:TEMP 'mgcanvas-first-session'
New-Item -ItemType Directory -Path $demo -ErrorAction Stop
Copy-Item -LiteralPath $board -Destination (Join-Path $demo 'board.mgcanvas')
node scripts/mgcanvas.mjs serve --file "$demo\board.mgcanvas" --session "$demo\session.json"
```

在第二个窗口运行以下命令。批次同时修改流程节点和脑图根主题。页面会立即显示两处修改，按一次撤销即可还原两处。

```powershell
$demo = Join-Path $env:TEMP 'mgcanvas-first-session'
$session = Join-Path $demo 'session.json'
$state = node scripts/mgcanvas.mjs status --session $session | ConvertFrom-Json
$batch = @{
  baseRevision = $state.revision
  operationId = [guid]::NewGuid().ToString()
  operations = @(
    @{ op='update'; id='flow-submit'; fields=@{label='审批完成'} }
    @{ op='topic'; id='mind-booking'; topicId='topic-root'; fields=@{text='预约评审'} }
  )
}
$batch | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 "$demo\batch.json"
node scripts/mgcanvas.mjs apply --session $session --batch "$demo\batch.json"
node scripts/mgcanvas.mjs inspect --session $session --id flow-submit
```

在页面选中流程节点，点对象浮栏的「节点文字」。普通输入会即时写入画布，中文输入法选字后写入。按 Enter 结束本次属性编辑，再移开焦点。再次运行最后一条命令可以读到人手提交的文字。CLI 的查询、导出和预览读取已提交到当前编辑历史的内容。未确认的输入、拖动或属性草稿会阻止远程编辑。

```powershell
$state = node scripts/mgcanvas.mjs status --session $session | ConvertFrom-Json
node scripts/mgcanvas.mjs save --session $session --rev $state.revision
node scripts/mgcanvas.mjs export --session $session --out "$demo\edited.mgcanvas"
node scripts/mgcanvas.mjs preview --session $session --out "$demo\preview.html"
node scripts/mgcanvas.mjs pack --session $session --out "$demo\offline.zip"
node scripts/mgcanvas.mjs verify --file "$demo\offline.zip"
```

关掉桥接后，双击独立预览即可查看内嵌工程。也可以直接打开构建的 HTML，通过「打开项目」选择导出的 `.mgcanvas`。ZIP 包含原图随工程嵌入的 `board.mgcanvas`、可离线编辑的 `index.html` 和列出 SHA-256 及字节数的 `manifest.json`。打包和 ZIP 校验使用 PATH 中的 Python 3。新建、导出、预览和打包只接受尚不存在的输出路径。

## 通过 MCP stdio 连接授权页

普通开发预览和授权页都提供页面内的 `window.mgCanvasTools`。带 WebMCP 功能且在该页面公开 `modelContext.registerTool` 的浏览器，可以让其 WebMCP 客户端发现页面工具。普通预览还可直接从开发者控制台运行 `await mgCanvasTools.callTool('canvas_read')`。终端 CLI 的 `--session` 和外部 MCP 客户端的 stdio 需要下面的 `serve` 授权页。

按上面的步骤构建、启动桥接并打开完整授权地址。把以下配置加入支持 `mcpServers` 的客户端配置，将最后一个参数换成这次启动生成的 `session.json` 绝对路径。客户端会自行启动 stdio 子进程。

```json
{
  "mcpServers": {
    "mgcanvas": {
      "command": "node",
      "args": [
        "C:/path/to/MG-Canvas-Engine/scripts/mgcanvas-mcp.mjs",
        "--session",
        "C:/path/to/session.json"
      ]
    }
  }
}
```

一个 stdio 进程启动时固定到一个会话凭证。可把 `--session` 固定为一个绝对路径，每次先结束旧桥接，再用同一路径启动新桥接、打开它新打印的授权地址，并重启客户端里的 MG Canvas MCP 连接。这样复用同一份客户端配置。若异常退出留下旧描述符，确认旧桥接已停止后清理该文件，再用同一路径启动。需要同时连接多张画板时，为每张画板配置不同的描述符路径和 MCP 连接。stdio 通过本机桥接工作，浏览器无需 WebMCP。

本地联调需要 Python 的官方 `mcp` SDK、`playwright` 和已安装的 Chrome。构建后运行 `python scripts/check-mcp-browser.py`，它会复制示例工程，在独立的可见 Chrome 窗口验证工具目录、批量编辑、旧修订拒绝、撤销和授权页隔离。

内部桥接沿用 `POST /cli` 与页面轮询。命令 `tools/list` 的页面返回值为 `{tools}`，`tools/call` 的参数为 `{name, arguments}`，页面返回 MCP 工具结果。传输错误保留会话错误码，结果未知时先按页面工具说明核对修订与原操作 ID。适配器按顺序转发请求，已发给页面的命令由原会话收尾。会话描述符和授权地址均含凭证，应保存在本机。

## 页面画布工具

WebMCP 和本地 MCP 共用页面工具目录、当前工程和撤销历史。页面初始化和浏览器工作区恢复完成后注册工具。在支持的浏览器中，可以通过 `document.modelContext.getTools()` 发现工具，再用 `executeTool` 调用。[Chrome WebMCP 接口](https://developer.chrome.com/docs/ai/webmcp/imperative-api) · [完整输入 Schema](../platform/canvas-tools.ts)

| 工具 | 用法 |
| --- | --- |
| `canvas_read` | 用 `ids` 精确读取，用 `query` 搜索 ID 或标签，用 `scope:"selection"` 或 `"viewport"` 限定范围。返回选择、视口、修订和一页对象，按 `nextOffset` 翻页。摘要默认 20 个，原生对象详情每页最多 10 个。 |
| `canvas_edit` | `operations` 按顺序描述 `node`、`edge`、`update`、`remove`。节点使用左上角整数世界坐标。边用 `from`、`to` 指定节点 ID，可显式指定端口。更新只提交改动字段。分组成员使用读取结果中的 `group`。 |
| `canvas_draw_flow` | 传入 `mermaid` 源码，或含 `nodes`、`edges` 和可选 `direction`、`groups` 的 `graph`。可用 `origin:{x,y}` 指定位置。省略时结合当前视口和已有空位选择摆放位置，并返回实际 `origin`。Mermaid 名字在每张图内有效，通过 `nodeIdMap`、`edgeIdMap` 取得文档 ID。单层 `subgraph` 成为原生流程组，返回的 `groups` 含实际组 ID、标题 ID 和成员节点 ID。 |
| `canvas_history` | 用 `action:"undo"` 或 `"redo"` 操作页面的共享历史。一个批次或一张新图对应一次撤销。 |
| `canvas_view` | `action:"fit"` 适配全图或指定 `ids`；`action:"locate"` 保持倍率并居中指定对象。用 `measureIds` 可以适配整张图并只测量关键标签。 |

一次查询即可同时获得对象和文字尺寸。例如 `canvas_read({query:"撤销",limit:8})` 的 `objects` 与 `screenText` 通过同一组 ID 对应。`minFontPx` 和 `maxFontPx` 是对象文字按当前倍率换算的 CSS 字号，多种字号时报告两端。显式 ID、文字搜索、选区和视口读取只计量当前结果页。`viewport.width/height` 表示画布，`windowWidth/windowHeight` 表示浏览器窗口，`usableWidth` 是扣除侧栏后的适配宽度，`zoom` 给出最终倍率。`occlusions` 列出当前工具栏相对画布左上角占用的 CSS 像素矩形。工具的 `fit` 和键盘 `0` 都会避开这些浮栏。可以用 `canvas_edit` 调整节点的整数位置、宽高或节点与连线的 `labelFontSize`，再用 `canvas_view({action:"fit",measureIds:[...]})` 复核整图效果。只需看一个区域时，将区域内的对象 ID 传给 `fit` 的 `ids`。

下面的控制台示例读取修订，在当前工程新增一张图，再给其中一个节点改名。每个写操作都需要最近一次读取或编辑返回的 `baseRevision`，以及本次请求独有的 `operationId`。

```js
const call = async (name, args) => {
  const { structuredContent } = await window.mgCanvasTools.callTool(name, args);
  if (!structuredContent.ok) throw new Error(JSON.stringify(structuredContent));
  return structuredContent;
};
const page = await call("canvas_read", { limit: 1 });
const drawing = await call("canvas_draw_flow", {
  baseRevision: page.revision, operationId: crypto.randomUUID(),
  mermaid: "flowchart TD\nA[提交申请] --> B{审核通过}"
});
await call("canvas_edit", {
  baseRevision: drawing.revision, operationId: crypto.randomUUID(),
  operations: [{ op: "update", id: drawing.nodeIdMap.A, fields: { label: "提交申请表" } }]
});
await call("canvas_view", { action: "fit", ids: drawing.nodeIds, measureIds: [drawing.nodeIdMap.A] });
```

重试时原样重发上一次完整请求，包括当时的修订和请求 ID。回执的 `appliedRevision` 是首次提交时的版本，`revision` 是当前版本。收到 `STALE` 时先重新读取相关对象，收到 `BUSY` 时可读取 `blockingReasons`。失败的编辑批次保留批次前的文档，`operationIndex` 从零开始，Mermaid 语法错误带行列。普通编辑页将成功的内容变更交给浏览器自动保存。授权页沿用「保存到工程文件」或 CLI 的 `save` 来写磁盘。

构建后运行 `python scripts/check-canvas-tools-browser.py`。该脚本在独立 Chrome 配置中分别通过原生 WebMCP 和页面入口执行同一组操作，核对实际 Canvas 绘制的字号、两张图复用 Mermaid 名称、两个中文分组、请求重放和刷新恢复。加上 `--replay 验收目录` 可重放追加布局的原始调用，目录中包含 `seed.mgcanvas` 和 `calls.json`。

## 磁盘、会话和重试

| 入口 | 读取及写入的位置 | 并发规则 |
| --- | --- | --- |
| `--file` | 指定文件。`apply` 执行成功即保存 | 从 `inspect/status` 取磁盘修订填入 `baseRevision`。保存时持有同路径的排他锁，检查文件身份、修改时间与内容哈希，在同目录原子替换 |
| `--session` | 已授权页面的当前文档、原图和撤销历史 | `apply` 需要会话修订，一批一次撤销。`save` 或「保存到工程文件」再检查载入时或上次保存后的磁盘修订，成功才标记相应快照已保存 |
| 页面「导出」 | 浏览器下载的独立工程副本 | 保留当前页面草稿和绑定的磁盘文件。发生磁盘冲突时可用它或 CLI 的 `export --session` 另存 |
| 普通离线 HTML | 文件导入、浏览器本地副本或下载 | 直接打开 HTML 无需桥接进程，浏览器保留自身的存储与冲突处理 |

离线批处理可用 `new --out blank.mgcanvas` 建立空白项目。对磁盘文件运行 `status --file` 后，用它的修订构造同样格式的批次，再运行 `apply --file ... --batch ...`。长期撤销历史保存在打开的编辑会话；重开工程重新开始一段历史。`undo`、`redo` 和 `save` 接受 `--session`、`--rev`。

会话 `apply` 收不到响应时，先用 `receipt --session ... --id ...` 查询。`appliedRevision` 是该批次生效时的修订，`revision` 是当前修订。在原会话内，相同 ID 和相同批次可以取回旧结果。更改已用 ID 的内容返回 `ID_CONFLICT`，新 ID 提交旧修订返回 `STALE`。页重载、会话重启、找不到凭证或磁盘命令断连时，先读取当前文件或编辑页并核对内容，再决定是否创建新批次。每个会话最多保留 4096 个成功批次的回执，容量用尽时可保存再开始新会话。

回环地址是 `127.0.0.1`，默认由系统分配端口。页面与 CLI 分用各自的随机凭证。服务校验端口对应的 Host 与 Origin，只接受已声明的命令，保存目标固定在启动时指定的工程。关闭启动命令即可停止服务。异常退出遗留的锁会报告 `BUSY`，应先核对锁文件中记录的进程和当前磁盘内容。磁盘并发保证覆盖采用此锁的写入者；其他程序直接改文件时会在替换前再次检查。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功，含无变化批次 |
| 2 | 命令、数据或文档校验错误 |
| 3 | 修订、操作 ID、目标已存在、活动编辑或文件锁冲突 |
| 4 | I/O、授权、会话离线或 PNG 运行时依赖及渲染错误 |
| 5 | 请求结果未知，先查询状态与回执 |

## 按连接关系整理流程、移动脑图子树

这两种操作均可放入同一个 `apply` 批次，并可与已有编辑混用。操作按数组顺序执行，布局和树移动会读取此前各操作产生的已校验文档。若同批还要创建节点和引用，请先使连接和树关系完整，再执行依赖它们的操作。任一步失败都会保留原项目。无变化的批次沿用原修订。

| 操作 | 参数 | 页面规则 |
| --- | --- | --- |
| `layoutFlow` | 必填 `ids`，值为不重复的对象 ID 数组。可选 `group` 为进入组内编辑时的组 ID | 普通选择会展开完整流程组。提供 `group` 时，所有传入成员均须属于该组。展开后至少有两个节点，且至少有一条可见的双端绑定线连接其中不同节点。内部连线自动读入，也可显式列出。排布沿用箭头方向、回环、图层顺序、间距和碰撞检查。锁定、隐藏、不合法的混选或目标位置占用都会使操作失败。只移动节点，保留端口绑定、线型和手动世界坐标拐点 |
| `moveTopic` | 必填 `id`（脑图 ID）、`topicId`（待移动分支）、`targetId`（落点主题）、`place`。可选 `side` 为 `left` 或 `right` | `child` 放到目标的末个子项并展开目标。`before` 和 `after` 放到目标同级的前方或后方。整棵子树的 ID、后代顺序和外观随分支保留。`side` 只参与根级分支的落点，均衡布局显示分支侧别。根节点不能移动或有同级；自身和后代不能作为落点。与画布拖放一样，源和目标均属于 `id` 指定的同一张图 |

下面的 PowerShell 示例直接使用随项目提供的含图工程。`a`、`b` 属于同一流程组，调用方只需给出对象 ID。

```powershell
$file = Join-Path $env:TEMP ("layout-" + [guid]::NewGuid() + ".mgcanvas")
Copy-Item 'docs/fixtures/M5AG-Layer-Locks.mgcanvas' $file
$target = @('--file', $file)
$state = node scripts/mgcanvas.mjs status @target | ConvertFrom-Json
$batch = @{
  operationId = [guid]::NewGuid().ToString()
  baseRevision = $state.revision
  operations = @(
    @{op='layoutFlow'; ids=@('a','b')}
    @{op='moveTopic'; id='mind-booking'; topicId='topic-booking'; targetId='topic-display'; place='child'}
  )
}
$batchPath = "$file.batch.json"
$batch | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $batchPath
node scripts/mgcanvas.mjs apply @target --batch $batchPath
node scripts/mgcanvas.mjs inspect @target --map mind-booking
```

在 HTML 会话中演练时，先将同一示例工程另复制一份，用前面的 `serve` 命令启动并打开授权页。将 `$target` 设为 `@('--session', $session)`，重新执行从 `$state` 开始的命令即可。一次撤销恢复两项，保存后重开可查看新层级。打开 `capabilities` 的 `operationDetails` 可读取相同约束。

## 按 ID 编辑主题与添加下游节点

磁盘与会话使用相同的五个操作。下表中的 `id` 指脑图或源流程节点。新 ID 可使用 1–128 位字母、数字、下划线、点、冒号或连字符，首位为字母或数字，并排除原型保留名。新主题 ID 需在该脑图内可用，下游节点和线 ID 需在画板的对象、资源、流程组中可用且彼此不同。省略新 ID 时可从成功响应读取分配值。

| 操作 | 参数 | 页面行为和实际返回值 |
| --- | --- | --- |
| `addTopic` | `id, topicId, relation`，可选 `newId, text` | `child` 加为末个子主题，`sibling` 紧随参照主题，两种操作都会展开父主题。根不能添加同级。根级子主题沿用 UI 侧别规则。空文字采用“新主题”，输入按页面规则处理换行和 800 个 UTF-16 单元的字素边界。返回新 `topicId`、`parentId`、从零开始的 `position`、实际文字和显示侧别 |
| `deleteTopic` | `id, topicId` | 按根至叶的树序返回 `removedIds` 及保留的 `parentId`，折叠的后代也会删除。根主题、未知主题、锁定或隐藏的脑图会拒绝。删除范围可在提交前用 `inspect --map` 核对，`baseRevision` 保护核对后的版本。与页面“删除此分支”相同，指定分支后直接执行 |
| `setMapLayout` | `id, layout` | `left` 全部向左，`right` 全部向右，`balanced` 双侧。沿用整张脑图的样式表单，保留各分支已有的侧别偏好。返回 `layout, changed` |
| `setBranchSide` | `id, topicId, side` | 根的直接子主题可设置 `left` 或 `right`。切换时转入双侧布局，保持其他根分支当时的显示侧别及顺序。指定当前侧别返回 `changed:false` 并保留当前布局。返回实际布局和侧别 |
| `addDownstream` | `id`，可选 `nodeId, connectorId, group` | 与流程节点 Tab 一致，从源节点东端口出发，避开可见的非连线对象，创建流程矩形并连到面向源节点的端口。有限范围内没有空位时整批拒绝。组内源节点须给当前 `group`，新节点位于组外。返回两个 ID、节点左上角 `at` 和两端绑定 `from, to`。可在同批用稳定 ID 设置新节点文字 |

成功响应的 `results` 按执行顺序列出上述操作的结果。`index` 是它在原始 `operations` 中从零开始的位置。结果记录操作生效当时的事实，例如同批稍后删除的主题仍有创建记录。会话的 `receipt` 和相同内容、相同 ID 的重试返回当时的结果，包括自动分配的 ID。`appliedRevision` 是当时的修订，`revision` 是查询时的修订。磁盘模式用文件修订保护保存，跨进程重开没有会话回执和撤销栈。

下面的 PowerShell 可从带图片的样例做一次完整编辑。对打开的编辑页执行时，将 `$target` 改为 `@('--session',$session)`，从读取 `$state` 起重跑。先启动绑定同一份初始样例的桥接，使用它给出的网页和会话描述文件。

```powershell
$work = Join-Path $env:TEMP ('canvas-structure-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
$file = Join-Path $work 'input.mgcanvas'
Copy-Item 'docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas' $file
$target = @('--file',$file)
$state = node scripts/mgcanvas.mjs status @target | ConvertFrom-Json
$batch = @{
  operationId = [guid]::NewGuid().ToString()
  baseRevision = $state.revision
  operations = @(
    @{op='setMapLayout';id='mind-booking';layout='left'}
    @{op='addTopic';id='mind-booking';topicId='topic-root';relation='child';newId='review';text='评审'}
    @{op='addTopic';id='mind-booking';topicId='review';relation='sibling';newId='release';text='交付'}
    @{op='addTopic';id='mind-booking';topicId='review';relation='child';newId='draft';text='旧草稿'}
    @{op='deleteTopic';id='mind-booking';topicId='draft'}
    @{op='setBranchSide';id='mind-booking';topicId='release';side='right'}
    @{op='addDownstream';id='flow-review';nodeId='publish';connectorId='to-publish'}
    @{op='update';id='publish';fields=@{label='交付上线'}}
  )
}
$path = Join-Path $work 'batch.json'
$batch | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $path
$response = node scripts/mgcanvas.mjs apply @target --batch $path | ConvertFrom-Json
$response.results | Format-Table index,op,topicId,nodeId,connectorId
if ($target[0] -eq '--session') { node scripts/mgcanvas.mjs save @target --rev $response.revision }
node scripts/mgcanvas.mjs inspect @target --map mind-booking
node scripts/mgcanvas.mjs preview @target --out (Join-Path $work 'view.html')
node scripts/mgcanvas.mjs export @target --out (Join-Path $work 'result.mgcanvas')
node scripts/mgcanvas.mjs pack @target --out (Join-Path $work 'board.zip')
node scripts/mgcanvas.mjs verify --file (Join-Path $work 'board.zip')
```

## 按对象 ID 对齐、分布和移层

在 `apply` 批次中使用 `arrange`。它与页面「排列」菜单共用所选对象的几何边界、整数取整、分组和图层顺序规则。`--file` 使用磁盘工程，`--session` 使用已授权页面的已提交文档及页面当前的锁定和可见性。按 ID 排列会保留页面原有选区。

| `command` | 对象与效果 |
| --- | --- |
| `left`、`center`、`right` | 至少两个可移动单元。左边、水平中心或右边对齐到选区边界或中心 |
| `top`、`middle`、`bottom` | 至少两个可移动单元。顶边、垂直中心或底边对齐，另一轴坐标保持原值 |
| `distribute-x`、`distribute-y` | 至少三个可移动单元。固定轴上的首尾对象，将中间对象按边到边的间隔分布，再按整数坐标取整。可以保留重叠。若等距会颠倒原空间次序，则保持原状 |
| `front`、`back`、`forward`、`backward` | 一个或多个对象。前两项置顶、置底，后两项将每段连续选层相对邻层上移、下移一步。所选对象内部顺序保留。跨越锁定或隐藏图层会被拒绝 |

`ids` 是非空且无重复的画板对象 ID 数组。普通选择某个组成员时，同组可见成员及组内连线按页面规则一起选入，整个组作为一个几何单元。可选字段 `group` 指定组内编辑范围，所有输入 ID 都须属于同一指定组。直接给出隐藏层 ID、选中锁定层、或需移动锁定连线的手动拐点时，整批返回 `CONFLICT`。锁定和隐藏属于打开中的页面。独立文件没有这两项临时状态。

只有两端都自由的连线可作为独立几何单元。绑定端点随节点投影。两端节点同向等量移动时，可见连线的手动拐点同移一次。图层顺序操作也可以显式选连线。旋转形状、路径、笔迹和组沿用引擎的可见几何边界。独立 Node 进程沿用引擎的文字估宽。长主题文字的实际字形会影响脑图边界，需要按页面字形对齐时可在会话内排列并用 PNG 复核。

`capabilities.operationDetails.arrange.inputSchema` 返回所需字段、命令枚举、ID 数组约束及可选组参数。成功时 `results` 中每项包含批次下标 `index`、`command`、展开后的 `selectedIds`、`changed` 和 `changedIds`。移层的 `changedIds` 只列出栈位置实际改变的所选层。合法的原位操作返回 `changed: false`。一批排列与其他修改共享一次撤销，批内后续操作会看到前面操作的结果。

以下示例复制自带工程，按拍图时的版本提交一个批次，再生成结果图。若要操作已打开的页面，将 `$target` 设为 `@('--session', $session)`，使用该页面中实际存在的对象 ID。

```powershell
$runDir = Join-Path $env:TEMP ('mg-arrange-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $runDir | Out-Null
$board = Join-Path $runDir 'work.mgcanvas'
Copy-Item 'docs/fixtures/M5AG-Layer-Locks.mgcanvas' $board
$target = @('--file', $board)
$frame = node scripts/mgcanvas.mjs png @target --out "$runDir\before.png" | ConvertFrom-Json
if (-not $frame.ok) { throw 'PNG capture failed' }
$ids = @('standalone','qa-picture','sample-ink')
$batch = @{
  baseRevision = $frame.revision
  operationId = [guid]::NewGuid().ToString()
  operations = @(
    @{ op='arrange'; command='top'; ids=$ids }
    @{ op='arrange'; command='distribute-x'; ids=$ids }
    @{ op='arrange'; command='front'; ids=@('qa-picture') }
  )
}
$batch | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 "$runDir\batch.json"
$result = node scripts/mgcanvas.mjs apply @target --batch "$runDir\batch.json" | ConvertFrom-Json
if (-not $result.ok) { throw ($result | ConvertTo-Json -Compress) }
$result.results
node scripts/mgcanvas.mjs png @target --out "$runDir\after.png"
```

## 让 AI 读取画布 PNG

`png` 生成可直接交给视觉模型的静态图。`--file` 取已保存工程，`--session` 取页面当时已提交的文档和嵌入资源；返回值标明 `source` 与快照 `revision`。两种模式均绘制文档内的图层，包括仅在当前页面隐藏的图层。草稿、选框、把手和编辑器面板仅出现在交互页面。

```powershell
npm run build
$board = 'docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas'
$out = Join-Path $env:TEMP ('canvas-png-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $out | Out-Null
node scripts/mgcanvas.mjs png --file $board --out "$out\board.png"
node scripts/mgcanvas.mjs png --file $board --id flow-submit --scale 2 --out "$out\node.png"
```

已有授权页面时可运行 `node scripts/mgcanvas.mjs png --session $session --out "$out\session.png"`。全图采用文档图层顺序。`--id` 单独绘制一个对象，连线照常解析两端锚点，脑图遵守保存的折叠状态。PNG 使用与 UI 相同的 Canvas2D 绘制、中文字体、嵌入图片解码和浅色点阵背景（`#f3f5f9`），像素比固定为 1。默认 `--scale auto` 保留 24 像素边距，以至多每世界单位 1 像素缩放到 1600 × 1200 以内。固定缩放可用 `0.05` 至 `8`。单边上限 4096 像素，总面积上限 8,388,608 像素，范围内解码后的图片共用 3000 万像素预算。超过限制时可用自动缩放或单对象模式。空文档生成 256 × 192 的背景图。

成功 JSON 包含 PNG 路径、字节数、SHA-256、`width/height`、实际 `scale`、世界坐标 `bounds`、像素偏移 `offset` 和渲染对象数。像素位置按 `world × scale + offset` 换算。输出路径必须为新文件。字体来自本机，跨系统的字形和抗锯齿可能不同。

渲染需要 Node.js 24.3+、当前构建、Python 3、该 Python 环境中的 `playwright`，以及本机已安装的 Chrome、Edge 或 Chromium。可用 `$env:MGCANVAS_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'` 指定本机可执行文件。驱动以临时配置启动离线 Chromium，用本地文件和浏览器管道完成渲染。CLI 不会下载安装依赖。现有 `preview` 仍可独立生成可交互的 HTML。

| PNG 错误码 | 退出码 | 处理 |
| --- | --- | --- |
| `RENDER_DEPENDENCY` / `BROWSER_UNAVAILABLE` | 4 | 根据消息核对构建产物、Python 与 Playwright，或指定已安装的本机浏览器 |
| `NOT_FOUND` / `INVALID` / `TOO_LARGE` | 2 | 核对源、对象 ID、缩放与输出上限 |
| `RENDER_FAILED` | 4 | 核对浏览器或图片解码错误，已有输出不会被替换 |
| `EXISTS` | 3 | 改用新输出文件名 |

### 看到标记后按版本编辑

1. 用 `png` 捕获全图或单对象，保留响应的 `revision`、实际 `scale` 和 `offset`。独立解码 PNG，取得目标内部像素 `(px, py)`。
2. 用 `x = (px - offset.x) / scale` 和 `y = (py - offset.y) / scale` 换回世界坐标。用同一修订的 `inspect` 读取对象边界，结合形状和颜色确认唯一目标 ID。碰到重叠歧义时，可为候选 ID 另拍单对象 PNG，再作判断。
3. 在会话内用 `edit-state` 检查草稿和目标保护状态。给批次新的 `operationId`，用捕获时的 `revision` 作为 `baseRevision`。成功后重新拍图并保存或导出。返回 `STALE` 时，基于新快照重新识别和判断。响应丢失时先查原操作 ID 的 `receipt`。
4. 实时协作前，由用户启动回环桥接、打开授权页面。遇到未提交草稿，由页面用户提交或取消。已有磁盘工程的识图、编辑、复核、导出和打包均可独立运行。

## 查询编辑阻塞与显式控制图层

对打开的授权页面运行 `edit-state --session` 可读取所选对象 ID、选中的主题范围、聚焦主题、组内范围、`busy`、`activeDraft` 及 `blockingReasons`。可选的 `--id` 将 `layers` 限定为一个对象。每一层分别报告 `locked`、`directlyHidden`、实际 `hidden`、导致连线隐藏的端点 `hiddenBy` 和原因码。状态响应只含标识和状态；正在输入的文字与表单数值始终留在页面。

```powershell
$state = node scripts/mgcanvas.mjs edit-state --session $session --id flow-submit | ConvertFrom-Json
$state | Select-Object selectedIds,activeDraft,blockingReasons,stateRevision
$state.layers | Format-Table id,locked,hidden,directlyHidden
```

`INSPECTOR_DRAFT` 表示属性有未提交的值；只有焦点时是 `INSPECTOR_FOCUS`，同样阻塞写入。`TEXT_EDITOR`、`MIND_TOPIC_DRAFT`、`PATH_DRAFT`、`PROPERTY_PREVIEW`、`FLOW_EDIT`、`INK_STROKE` 指向相应的输入或预览；`POINTER_GESTURE`、`PATH_TOOL`、`SAVING`、`IMPORTING`、`REOPENING` 指出交互或文件操作占用。层级原因 `LOCKED`、`HIDDEN`、`HIDDEN_ENDPOINT` 可与这些页面原因共存。涉及组、顺序或关联对象的文档编辑还需通过现有事务校验。

要主动修改某一图层，可执行以下示例。每条命令给一个目标 ID、一个明确布尔值以及 `edit-state` 返回的 `stateRevision`。该版本绑定本次页面、文档、锁定和可见性。编辑文档仍使用 `revision`。无效或陈旧请求保留页面状态，活动草稿返回 `BUSY`。响应丢失时先重新读取状态。

```powershell
$state = node scripts/mgcanvas.mjs edit-state --session $session --id flow-submit | ConvertFrom-Json
$locked = node scripts/mgcanvas.mjs set-layer --session $session --id flow-submit --rev $state.stateRevision --locked true | ConvertFrom-Json
node scripts/mgcanvas.mjs set-layer --session $session --id flow-submit --rev $locked.stateRevision --locked false
```

`--visible false|true` 使用页面的隐藏/显示规则。隐藏节点会同时隐藏其绑定连线；显示受隐藏端点影响的连线也会显示相应端点。响应的 `affectedIds` 列出实际变化的层，锁定状态独立保留。单层状态修改仅属于此次打开的页面，不写入工程、改变文档修订或增加撤销步骤。

## 操作覆盖

`inspect` 默认返回完整文档，包括模型版本、图层顺序、全部对象、资源元数据及流程组。`--kind connector` 可查看端口绑定和世界坐标拐点。`--map` 返回有序主题行，包含父 ID、深度及折叠主题的后代。导出工程包含原始图片字节。`capabilities` 列出每个操作接受的字段。

| 分类 | 页面上可完成的工作 | CLI 的实际覆盖 |
| --- | --- | --- |
| 直接 CLI | 创建、读写、预览、保存和导出工程；编辑图层、图片、文字、自由形状、采样笔迹、矢量路径、流程节点和连接线 | `new/inspect/apply/save/export/preview/png/pack/verify`；`create/update/remove/addImage/order/groups/theme` 接受模型字段。端点、线型、拐点、顶点、笔压和曲柄均可读写。会话有 `undo/redo` |
| 直接 CLI | 脑图主题增删、移动、重排、折叠、改文字与外观，整图方向与分支换侧；流程图添加并绑定下游节点、自动整理 | `addTopic/deleteTopic/moveTopic/topic/setMapLayout/setBranchSide`、`addDownstream/layoutFlow`。节点、连接和主题产生于同一文档事务 |
| 直接 CLI | 六向对齐、横纵等距分布、置顶置底和升降一层 | `arrange` 按 ID 复用页面几何和选层规则。可在一个批次中排列多组对象 |
| 组合 CLI | 复制粘贴后的文档结果、跨画板复制、连同图片复制对象或分支、移动多选、删除节点时保留相连线 | 用 `inspect` 或 `export` 读取对象、树及原资源，分配新 ID 并重映射引用，按需组合创建、图片导入、分组、重绑或脱离端点和整数几何更新 |
| 直接 CLI | 查看选择和阻塞原因，显式锁定、解锁、隐藏或显示指定层；按文档或对象输出静态图 | `edit-state/set-layer` 和 `png`。状态只含已提交数据或会话元信息，PNG 提供世界到像素的映射 |
| 页面工具 | 读取当前选区、按 ID 定位或者适配视口并取得 CSS 字号 | `canvas_read`、`canvas_view` 通过 WebMCP 或本机 MCP 会话调用 |
| 仅 UI | 设置当前选区，提交或取消页面正在输入的草稿，交互吸附、局部存储副本恢复 | 活动草稿由页面用户处理 |
| 明确不适用 | 实体笔压采集、系统输入法合成、系统剪贴板授权、文件选择器及指针轨迹；跨独立进程恢复磁盘编辑的撤销栈 | 这些依赖设备、浏览器或内存会话。对已有采样、文本、剪贴结果的文档编辑可用以上直接或组合命令完成。页面的原生分支拖放限于同一张脑图；跨图转移可用两棵树的原子更新表达 |

## 复测

```powershell
npm run check:syntax
npm test
npm run build
npm run check:bundle
npm run check:ui-smoke
npm run check:storage-smoke
npm run check:clipboard-smoke
python scripts/check-ai-browser.py
python scripts/check-ai-browser.py --png
python -B scripts/check-ai-browser.py --png --arrange --out (Join-Path $env:TEMP ('mg-arrange-proof-' + [guid]::NewGuid()))
```

`--png` 额外使用 Pillow 作为独立 PNG 解码器。它比较实际中文字形、嵌入图片四个象限和旋转三角形的内外像素，在实际页面检查草稿保密、阻塞写入、直接及间接隐藏、陈旧状态和显式解锁，并测试浏览器缺失、像素超限及输出防覆盖。加 `--out 新目录` 可保留 PNG 与可重开的测试工程。

`--arrange` 用 Pillow 在磁盘和真实页面的两种缩放下独立定位负坐标色标，按同版 `inspect` 确认 ID，再用捕获版本改文字、顶边对齐、横向等距和置顶。它核对屏上几何、一次撤销与重做、保护图层引发的整批回滚及两端导出的工程字节。页面更新后旧 PNG 请求得到 `STALE`。关桥后还会在断网 HTML 中重开排列结果并核对原图资源。`arrange/` 内保留编辑前后 PNG、初始与结果工程及记录坐标、版本和返回 ID 的 `verification.json`。

浏览器验收使用本机 Python Playwright 和 Chrome 或 Edge 的独立无界面配置。可用 `--browser EXE` 指定浏览器，用 `--out 新目录` 保留工程、HTML、ZIP、实际离线页面截图和验证记录。测试从真实页面的几何输入框和主题树读取布局坐标及后代层级，并核对一次撤销、重做和离线重开。测试还会在页面批次生效后切断调用方连接，随后真实编辑页面并核验回执。两个写入者交换保存顺序，另有两个独立 CLI 进程争用同一修订的回归。结构编辑验收分别从磁盘和浏览器会话加载含图工程，检查根分支误删整批回滚、新建和删除 ID、一次页面撤销与重做，以及回执重读。关闭桥接后，两份 HTML 均在断网 Chromium 中展示，再导入两份导出工程并重新导出，比对全部结构和原图字节。保留结果时，根目录存会话样例，`disk/` 存独立磁盘样例。
