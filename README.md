# MG Canvas Engine

在同一张无限画布上自由绘图、连接流程节点和编辑自动布局的思维导图。画板支持文字、Markdown 文档、便签、表格、图片和压感笔迹，可导出为包含图片的 `.mgcanvas` 工程。

## 下载与许可

在 GitHub Releases 下载 Windows x64 安装程序 `MG-Canvas-版本-windows-x64-setup.exe`。同页的 `.sha256` 文件用于校验下载。安装按当前用户进行，包含桌面工作台、`mgcanvas.exe` 和 WebView2 Evergreen 离线安装器。[Windows 发行版本](https://github.com/lingy-Mg/MG-Canvas-Engine/releases)

项目公开源码，采用 MG Canvas Engine 非商业软件许可 1.0。个人和组织可为非商业目的使用、研究、修改，并在保留声明的条件下再分发。商业使用、收费分发和收费托管须取得另行书面许可。第三方组件继续依各自许可授权。[非商业许可全文](LICENSE) · [第三方软件声明](THIRD-PARTY-NOTICES.md)

## 本地开发

使用 Node.js 24.3 或更新版本。在项目根目录运行以下命令，然后打开终端显示的本机地址。

```sh
npm ci
npm run build
npm run preview
```

React 入口为 `app/main.tsx`。浏览器、CLI 导出和 Tauri 桌面前端共用本地构建。离线可直接打开构建生成的 `dist/Canvas-M5BE-Preview.html`。已封存的版本也可以直接试用。[M5AS 基线](preview/Canvas-M5AS-Preview.html) · [M5BD 冻结预览](preview/Canvas-M5BD-Preview.html)

在 Windows x64 构建机执行 `npm ci` 和 `npm run desktop:build` 生成当前用户使用的 NSIS 安装包。安装包内含 WebView2 离线安装器。[Windows 构建条件与验收](docs/Device-Testing.md#桌面前端与安装包)

## 验证与清理

| 命令 | 用途 |
| --- | --- |
| `npm test` | 运行 Node 回归，包含旧工程读取、编辑事务、撤销和剪贴板 |
| `npm run verify` | 运行语法检查、Node 回归、构建、打包校验和浏览器界面冒烟 |
| `npm run check:storage-smoke` | 构建后验证浏览器自动保存、冲突与恢复 |
| `npm run desktop:assets`、`npm run check:desktop` | 生成桌面前端并在 Chrome 中按 Tauri 的 CSP 验证 |
| `npm run clean` | 清空整个 `dist/`（含导出样本）、测试报告目录和脚本的 Python 缓存 |

浏览器检查需要 Python Playwright 和 Google Chrome。运行产生的截图和报告放入 `dist/qa/` 或系统临时目录。个人画板请保存在构建目录之外。

## 开发规范

全项目遵循根目录的开发指南。修改模块前也要查看对应目录的 `AGENTS.md`。日常修改在验证后提交到本地 Git。用户明确要求发布版本时，可从公共 `main` 按发布手册执行发版命令。[项目开发与提交规范](AGENTS.md) · [Windows 发版手册](docs/Releasing.md)

## 使用与架构

- [画布操作与快捷键](docs/Editing.md) · [手写与笔压](docs/Ink.md) · [图文精确属性](docs/Precise-text-image-properties.md)
- [项目与渲染架构](docs/Architecture.md) · [Windows 和手机验收](docs/Device-Testing.md)
- [AI CLI、MCP 与页面工具](docs/AI-CLI.md) · [通过 Mermaid 创建流程图](docs/AI-Flow-Drawing.md)

维护者的原始工作副本保留清理前的预览、里程碑记录和旧验收脚本。公共仓库从审阅后的快照开始。
