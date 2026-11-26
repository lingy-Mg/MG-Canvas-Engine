# MG Canvas 架构

双击 HTML 可打开装入对应工程的离线编辑器。原生工程可直接导入画板，修改卡片文字、移动节点和调整连线。

| 架构图 | 离线编辑器 | 原生工程 |
| --- | --- | --- |
| 项目总体架构 | [打开 HTML](fixtures/MG-Canvas-Project-Architecture.html) | [打开工程](fixtures/MG-Canvas-Project-Architecture.mgcanvas) |
| 核心渲染引擎 | [打开 HTML](fixtures/MG-Canvas-Rendering-Engine.html) | [打开工程](fixtures/MG-Canvas-Rendering-Engine.mgcanvas) |

## 项目总体架构

`app/main.tsx` 解析入口提供的启动源，通过 `WorkspaceApp` 创建顶栏、图层、工具和对象编辑浮层。`CanvasViewport` 在布局阶段把主画布、反馈画布和视口交给 `startEditor`。每次挂载拥有一个 `EditorSession`，React 控件通过 `WorkspaceUI` 订阅各自的显示状态并派发动作。连续输入、Canvas 2D 绘制及焦点路由由运行时处理。[React 入口](../app/main.tsx) · [工作台](../app/react/WorkspaceApp.tsx) · [画布适配](../app/react/CanvasViewport.tsx) · [控件状态](../app/react/workspace-ui.ts)

| 模块 | 在一次编辑中的职责 |
| --- | --- |
| [core](../core/) | 持有文档格式、校验、原子事务、变更集和历史。持久化契约涵盖对象与资源引用、顺序、端口和分组。 |
| [features](../features/) | 将用户意图转换为领域操作。流程节点自由定位，连线保留端口和手动拐点。脑图通过主题树派生布局。手写、路径、文本、剪贴板和图片各自约束输入。 |
| [session](../session/) | 通过 `EditorSession` 管理相机、选择、锁定、手势的预览／取消／提交，以及文档代次。已确认的编辑进入 `core`；临时状态留在当前挂载。 |
| [scene](../scene/) | 根据文档和会话预览派生图元、布局、绘制和命中顺序。用变更集更新投影和空间索引。 |
| [renderers](../renderers/) | 绘制主层和指针反馈层，消费场景与位图缓存。文档使用世界坐标，命中和工具浮层使用 CSS 像素，Canvas backing store 再应用设备像素比。 |
| [app](../app/) | 组合上述模块，衔接 DOM 输入、React 控件、焦点和中文组合输入。编辑、CLI 会话和页面工具以同一会话入口提交操作。 |
| [platform](../platform/) | 管理工程编解码、手动副本、现场恢复和自动化协议。文件选择、浏览器剪贴板与图片解码目前仍由工作台运行时协调。 |

一次提交经 `editor.listen` 更新场景、图片引用、控件和绘制失效。文档变更与可恢复草稿变更同时进入保存调度。手动保存和现场恢复各有自己的存储键与并发检查。手动保存按工程格式及来源版本选择副本槽位，保留 v1–v6 工程与旧存储键的读取路径。现场恢复按入口路径记录文档、相机、图片和文字草稿，使用 IndexedDB，或在具备 Web Locks 时降级到本地存储，并用退出日志保护待写入现场。[运行时订阅](../app/editor-runtime.ts) · [手动副本](../platform/local-board-copies.ts) · [保存调度](../platform/workspace-recovery.ts) · [存储后端](../platform/workspace-store.ts)

工程文件由 `decodeProject` 校验。资源字节由 `AssetVault` 持有，并按当前文档及撤销、重做引用保留。工作台导入项目时还会验证浏览器实际解码的图片尺寸。位图缓存随可见区域加载资源，释放已淘汰的位图；原始字节仍可用于工程导出。[工程格式](../platform/project.ts) · [图片资源](../features/image-assets.ts) · [位图缓存](../app/image-cache.ts)

CLI 与 stdio MCP 可读取磁盘工程，或通过回环桥接操作授权浏览器页。联机命令通过活跃会话执行，使用修订号、操作 ID 和编辑阻塞条件保护批量事务。CLI 页以磁盘工程启动，手动保存发回桥接服务。本地页从内置样板或内嵌工程启动，再尝试恢复现场或打开手动副本。WebMCP 与页面工具复用同一批工具定义和会话操作。[CLI](../scripts/mgcanvas.mjs) · [联机会话](../app/cli-bridge.ts) · [页面工具](../app/canvas-tool-host.ts) · [MCP 用法](AI-CLI.md)

## 跨入口构建

| 入口 | 构建和存储 |
| --- | --- |
| Web | `npm run build` 生成 `dist/app` 的 HTML、CSS 和本地 React bundle。`npm run preview` 提供 HTTP 入口，存储由该来源提供。 |
| 离线 HTML | 构建将同一 bundle 和 CSS 内嵌。CLI 可向 HTML 加入工程。文件来源的存储可用性由浏览器决定，工程导入和导出用于跨来源迁移。 |
| Tauri | `npm run desktop:assets` 以严格 CSP 所需的外链形式暂存同一 bundle、CSS 和入口。Rust 启动器加载本地 WebView2，现有工程导入、导出和现场恢复沿用 Web API。Web 预览与桌面各有自己的存储来源。 |

[构建脚本](../scripts/build.mjs) · [预览服务器](../scripts/serve.mjs) · [Tauri 启动器](../src-tauri/src/main.rs) · [Tauri 配置](../src-tauri/tauri.conf.json)

## 核心渲染引擎

每个挂载的视口只保留一个待执行的动画帧，`FramePace` 按设定的帧率放行。单纯悬停可只调用指针反馈层。主层更新后同步指针反馈。挂载的中止信号释放待执行帧、尺寸观察和原生监听；文档订阅、场景动画和位图也随卸载清理。[视口生命周期](../app/viewport-lifecycle.ts) · [帧率控制](../app/frame-pace.ts) · [运行时](../app/editor-runtime.ts)

`SceneProjection` 用提交后的变更集更新场景，也能在既有图元上叠加拖动预览及相连的线。相机平移和缩放沿用场景几何。视口查询保留绘制顺序，大板在满足条件时可使用离屏位图或只重绘拖动影响的区域。[场景投影](../scene/projector.ts) · [空间索引](../scene/spatial-grid.ts) · [相机位图](../renderers/canvas2d/camera-raster.ts) · [Canvas 2D](../renderers/canvas2d/canvas.ts)

## 迁移顺序与验收

1. **启动和持久化边界（已实施）。** 工作台通过 `WorkspaceSource` 接收本地或授权会话的启动方式。只有本地工作台打开本地画板存储。平台层持有手动副本的历史键、探测结果、并发比较基线与连接；卸载时已受理的手动保存按序完成，迟到的打开连接会关闭。工作台负责确认切换、应用保存回执及恢复焦点。验收覆盖 Web 和离线编辑、撤销、剪贴板、旧工程回读、手动重开、自动恢复冲突、组合输入，以及 CLI 页的磁盘操作。
2. **Tauri 封装和工作台 UI。** 桌面继续使用 `WorkspaceSource` 的本地入口、`WorkspaceApp` 及现有控件动作，沿用同一工程格式。布局调整须照顾画布可用区域、窗口最小尺寸、高 DPI、主题、面板焦点和快捷键。若增加系统文件对话框或原生保存，先将相应 I/O 交给平台适配，复用 `decodeProject`、图片校验和文档代次检查。仅授权实际使用的 Tauri 能力。验收先运行 `npm run desktop:assets` 和 `npm run check:desktop`，再在 Windows 安装和启动 NSIS 产物，用 WebView2 实测重开及导出、跨重启恢复、IME、剪贴板、触控板和手写笔。
3. **按交互边界继续拆分运行时。** `editor-runtime.ts` 仍同时协调手势、文件／剪贴板、工具状态和选区浮层。后续优先提取需要接入原生宿主的 I/O 及其生命周期，然后按独立的工具或面板迁移。每次从正常应用入口覆盖触发、取消、提交和卸载；以同一份带图片的工程验证重开，以单次撤销验证事务边界。场景失效和坐标转换在修改前后应由现有渲染与设备回归对照。

[设备验收](Device-Testing.md) · [项目验证命令](../package.json)
