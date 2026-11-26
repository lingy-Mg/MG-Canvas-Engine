# Windows 发版

正式仓库是 `lingy-Mg/MG-Canvas-Engine`，默认分支是 `main`。版本由 `src-tauri/Cargo.toml` 的 `[package].version` 决定。GitHub Actions 在 Windows x64 上构建、安装并验收 NSIS 安装包，通过后将安装 EXE 和 SHA-256 文件发布到同名版本标签。

## 准备版本并发布

1. 将待发功能和相应说明提交到公共工作副本的 `main`。确认 `origin` 指向正式仓库且远端有 `main` 分支。
2. 修改 `src-tauri/Cargo.toml` 的 `[package].version`。运行 `cargo check --manifest-path src-tauri/Cargo.toml` 刷新 `Cargo.lock` 并确认锁文件只产生预期变化。如果 Tauri 配置显式设置了 `version`，同步修改它。
3. 验证受影响的功能并提交版本变更。使用已登录 GitHub 且能推送正式仓库的 Git 与 GitHub CLI，在干净的 `main` 工作树运行以下命令。

   ```sh
   node scripts/publish.mjs --version 0.2.0
   ```

4. 打开命令输出的 Actions 地址。也可在 Actions 中获取运行编号后执行以下命令，等待工作流结束并查询 Release。

   ```sh
   gh run watch RUN_ID --exit-status --repo lingy-Mg/MG-Canvas-Engine
   gh release view v0.2.0 --repo lingy-Mg/MG-Canvas-Engine
   ```

发版命令原子推送 `main` 和新标签。相同版本已经发布时返回 Release 链接，已有同标签的运行在进行时返回运行链接，失败后可从指向同一提交的工作副本重跑命令。已有标签指向其他提交时，使用下一个版本。若 GitHub 上传中断留下草稿，维护者应先检查草稿及校验值，再决定发布草稿或清理草稿并重跑。

## Windows 验收

普通分支推送和 PR 执行只读构建与验收。正式标签推送和在该标签上的手动重跑使用相同检查。Windows 验收会执行 `npm run verify`、桌面资源检查、Rust release 单元测试和 `npm run desktop:build`，再对实际生成的安装程序运行 `scripts/check-installed-desktop.ps1`。安装和桌面 CLI、PNG 验收通过后，独立的发布作业核对原始标签和安装包校验值。安装日志可从对应 Actions 运行下载。[GitHub Actions 事件与手动运行](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

## 更新 Rust 依赖许可清单

更改 Windows 运行时依赖时，在项目根目录生成并审阅 `THIRD-PARTY-RUST.txt`，与依赖变更一并提交。[cargo-about 用法](https://embarkstudios.github.io/cargo-about/cli/generate/index.html)

```sh
cargo install cargo-about --version 0.9.3 --locked --features cli
cargo about generate --locked --features custom-protocol --manifest-path src-tauri/Cargo.toml --config scripts/windows-licenses.toml --output-file THIRD-PARTY-RUST.txt scripts/windows-licenses.hbs
```
