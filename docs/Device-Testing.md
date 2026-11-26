# Windows 与手机验收

## 桌面前端与安装包

在项目根目录执行 `npm run desktop:assets` 和 `npm run check:desktop`。检查会核对工作台与独立 PNG 渲染页的本地资源、工作台的 IPC 权限，以及 Chrome 中的工程导出结果。[Tauri 配置](../src-tauri/tauri.conf.json)

在已安装 Node.js、Rust x64 MSVC 工具链、Windows SDK 和 C++ Build Tools 的构建机上，从 x64 Native Tools 终端运行以下命令。npm 和 Cargo 使用仓库里的锁文件。首次构建需要取得依赖及 Tauri 的 NSIS 工具。每次打包时 Tauri 会联网查询微软当前的 WebView2 x64 离线安装器，并复用匹配的缓存。

```powershell
npm ci
npm run desktop:build
```

默认安装包在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`，实际路径以构建输出为准。包按当前用户安装，并内嵌微软 WebView2 Evergreen 离线安装器。需要调试原生宿主时，可用 `npm exec -- tauri build --debug --no-bundle --target x86_64-pc-windows-msvc -- --locked` 单独构建调试程序。

安装目录包含 [MG Canvas 软件许可](../LICENSE)、[第三方声明](../THIRD-PARTY-NOTICES.md) 和 [Rust 依赖许可](../THIRD-PARTY-RUST.txt)。

如果 Windows 尚未为 `.mgcanvas` 选择打开程序，安装后可在资源管理器中双击打开画板。已有默认程序时，右键文件并从「打开方式」选择 MG Canvas，或在 Windows 设置中更改默认程序。卸载只移除 MG Canvas 注册的文件关联。

安装目录中的 `mgcanvas.exe` 是命令行入口。默认安装位置可用以下命令验证。如果安装时选择了其他位置，请使用该目录中的 `mgcanvas.exe`。

```powershell
& "$env:LOCALAPPDATA\MG Canvas\mgcanvas.exe" --help
```

在未注册 MG Canvas 的 Windows 测试账户中，使用 PowerShell 7.4 或更新版本运行下面的安装包检查。脚本使用临时安装和独立 WebView2 数据目录，并核对含中文与空格路径的冷启动和热打开、安装版 CLI 编辑与撤销、两种 PNG 导出、卸载及默认关联。可以用 `-PreviousInstaller` 先在同一个临时目录装入上一版，以测试升级。

```powershell
pwsh -File scripts/check-installed-desktop.ps1 -Installer "安装包路径.exe" -EvidenceDirectory dist/qa/windows-installed
```

在 Windows 测试账户安装 NSIS 包，从安装目录启动应用并验证卸载。用尚未安装 WebView2 的测试环境断网安装，验证内嵌安装器能够补齐运行时。记录安装包 SHA-256、设备、DPI、系统和 WebView2 版本，再检查以下操作。

- 打开或导入混排画板，移动图形、调整绑定连线并撤销。用实体触控板平移、缩放，在不同 DPI 的显示器间移动窗口，核对指针命中与文字清晰度。
- 用中文输入法编辑流程节点和脑图主题，检查候选词确认、Tab、Enter、Esc 和失焦。用系统剪贴板复制文字、图片和混合选区。
- 用压感笔试写轻重笔画，让手掌和笔尖同时接触，再测试橡皮和撤销。用鼠标复查等宽笔迹。
- 手动保存、重启并恢复画板。在系统文件应用中找到导出的 `.mgcanvas`，重新导入，核对中文、图片字节、流程连线和脑图结构。

## 手机网页

在测试机运行 `npm run desktop:assets`，再运行 `npm run preview -- --lan 192.168.1.20`。将示例地址换成测试机当前的局域网 IPv4，在同一局域网的手机上打开终端给出的网址，结束后用 Ctrl+C 关闭服务。

用 Android Chrome 或 iPhone Safari 核对单指拖动、双指缩放和松开一指后的行为。切换横竖屏并唤起中文键盘，检查节点编辑、工具栏焦点和项目文件导出重开。可使用同一份会议室工程比较不同设备的结果。[会议室样例](fixtures/Meeting-Room-Mobile-QA.mgcanvas)
