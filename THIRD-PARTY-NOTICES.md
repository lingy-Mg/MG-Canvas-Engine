# 第三方软件声明

项目的非商业许可适用于 MG Canvas Engine 的自有内容。各第三方组件由其各自的权利人按上游条款授权。

| 组件 | 上游许可 | 随分发情况 |
| --- | --- | --- |
| [React、React DOM、Scheduler](https://github.com/facebook/react/blob/main/LICENSE) | MIT | 现代浏览器版、Windows 桌面前端及 `docs/fixtures/` 中两个独立 HTML 示例 |
| [Tauri JavaScript API](https://github.com/tauri-apps/tauri/tree/dev/packages/api) | MIT 或 Apache-2.0 | 桌面前端，随本产品按 MIT 分发 |
| [Tauri 与其他 Rust crates](https://crates.io/crates/tauri) | 按 crate 分别授权 | 每个 Windows 发行版本附 `THIRD-PARTY-RUST.txt`，其中列有锁定版本、源码和许可文本 |
| [Microsoft Edge WebView2 Runtime 与 SDK](https://developer.microsoft.com/microsoft-edge/webview2/) | Microsoft WebView2 适用条款 | Evergreen 离线安装器与 Windows 程序的 WebView2 加载器 |
| [NSIS 3.13 与 LZMA 解压模块](https://nsis.sourceforge.io/License) | zlib/libpng、CPL-1.0 与 LZMA 链接例外 | Windows 安装器及其卸载程序。[对应源码](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/) |
| [nsis-tauri-utils 0.5.3](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3) | MIT 或 Apache-2.0 | Windows 安装器插件，随本产品按 MIT 分发 |

`package-lock.json` 和 `src-tauri/Cargo.lock` 记录构建锁定的版本。esbuild 和 Tauri CLI 用于构建，Playwright 和 Chrome 用于验证。`preview/` 的冻结 HTML 和 `docs/fixtures/` 的独立示例仍按原交付形式保存，分发时请一并提供本文件与 `LICENSE`，并保留产物已有的第三方声明。

## React、React DOM 和 Scheduler

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

## Tauri JavaScript API

MIT License

Copyright (c) 2017 - Present Tauri Apps Contributors

## nsis-tauri-utils

MIT License

Copyright (c) 2019 - 2022 Tauri Programme within The Commons Conservancy

## MIT 条款

上述 MIT 组件适用以下条款。

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
