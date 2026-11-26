import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "lingy-Mg/MG-Canvas-Engine";
const workflow = "windows.yml";
const root = fileURLToPath(new URL("../", import.meta.url));
const branch = "refs/heads/main";
const [mode, version, ...extra] = process.argv.slice(2);

function run(command, ...args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const git = (...args) => run("git", "-c", "core.fsmonitor=false", ...args);
const gh = (...args) => run("gh", ...args, "--repo", `github.com/${repository}`);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

export function parseRemoteRefs(output) {
  return new Map(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, ref] = line.split(/\s+/);
    return [ref, commit];
  }));
}

function checkVersion() {
  if (!/^((0|[1-9][0-9]{0,4})\.){2}(0|[1-9][0-9]{0,4})$/.test(version ?? "")
      || version.split(".").some((part) => Number(part) > 65535)) {
    throw new Error("版本必须为 Windows 安装器支持的 X.Y.Z，每段为 0–65535。");
  }
  const cargo = read("../src-tauri/Cargo.toml").match(/^\[package\]\s*([^\[]*)/m)?.[1];
  const crate = cargo?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const cargoVersion = cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const locked = read("../src-tauri/Cargo.lock").split(/\[\[package\]\]/)
    .find((entry) => entry.match(/^name = "([^"]+)"/m)?.[1] === crate);
  const lockedVersion = locked?.match(/^version = "([^"]+)"/m)?.[1];
  const tauriVersion = JSON.parse(read("../src-tauri/tauri.conf.json")).version ?? cargoVersion;
  if (!crate || [cargoVersion, lockedVersion, tauriVersion].some((value) => value !== version)) {
    throw new Error(`版本须与 Cargo.toml、Cargo.lock 和 Tauri 有效版本一致（期望 ${version}，实际 ${cargoVersion} / ${lockedVersion} / ${tauriVersion}）。`);
  }
}

function publish() {
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  if (git("status", "--porcelain") || git("symbolic-ref", "HEAD") !== branch) {
    throw new Error("请在干净的 main 分支执行，先提交这次发版包含的改动。");
  }
  const acceptableRemote = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)lingy-Mg\/MG-Canvas-Engine(?:\.git)?$/i;
  for (const urls of [git("remote", "get-url", "--all", "origin"), git("remote", "get-url", "--push", "--all", "origin")]) {
    if (!acceptableRemote.test(urls)) throw new Error(`origin 必须指向 github.com/${repository}。`);
  }
  run("gh", "auth", "status", "--hostname", "github.com", "--active");

  const commit = git("rev-parse", "HEAD");
  const localTag = git("tag", "--list", tag);
  if (localTag && git("rev-parse", `${ref}^{commit}`) !== commit) {
    throw new Error(`本地标签 ${tag} 已指向其他提交。`);
  }
  const refs = parseRemoteRefs(git("ls-remote", "origin", branch, ref, `${ref}^{}`));
  const target = refs.get(`${ref}^{}`) ?? refs.get(ref);
  if (target && target !== commit) throw new Error(`远端标签 ${tag} 已指向其他提交。`);

  const existing = run("gh", "api", "--hostname", "github.com", "--paginate",
    `repos/${repository}/releases?per_page=100`, "--jq",
    `.[] | select(.tag_name == "${tag}") | {isDraft: .draft, url: .html_url}`);
  const release = existing && JSON.parse(existing);
  if (release) {
    if (!target || release.isDraft) throw new Error(`请先检查既有 Release：${release.url}`);
    console.log(release.url);
    return;
  }

  if (!target) {
    if (!refs.has(branch)) throw new Error("请先完成公开 main 分支的首次推送。");
    git("push", "--atomic", "--no-follow-tags", "origin", `HEAD:${branch}`, `HEAD:${ref}`);
    console.log(`已推送 ${tag}，标签推送将触发 Windows 工作流。`);
  } else {
    const runs = JSON.parse(gh("run", "list", "--workflow", workflow, "--commit", commit,
      "--limit", "50", "--json", "headBranch,event,status,url"));
    const running = runs.find((run) => run.headBranch === tag && run.status !== "completed");
    if (running) {
      console.log(running.url);
      return;
    }
    console.log(gh("workflow", "run", workflow, "--ref", tag));
  }
  console.log(`https://github.com/${repository}/actions/workflows/${workflow}?query=branch%3A${tag}`);
}

if (import.meta.main) {
  try {
    if (!["--check-version", "--version"].includes(mode) || extra.length || !version) {
      throw new Error("用法：node scripts/publish.mjs --version X.Y.Z 或 --check-version X.Y.Z");
    }
    checkVersion();
    if (mode === "--version") publish();
  } catch (error) {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  }
}
