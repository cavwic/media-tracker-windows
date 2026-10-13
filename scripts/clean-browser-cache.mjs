// Manual maintenance only. No arguments means preview; never invoked on startup.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { clearProfileCache, inspectProfileCache, listProfileDirectories } from "../lib/profile-cache.mjs";
import { profileBrowserIsRunning } from "../lib/profile-maintenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProfilesRoot = path.join(root, "data", "browser-profiles");
const execFileAsync = promisify(execFile);
const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

export function parseCleanupArgs(args) {
  if (!args.length || (args.length === 1 && args[0] === "--preview")) return "preview";
  if (args.length === 1 && ["--interactive", "--apply", "--help"].includes(args[0])) return args[0].slice(2);
  throw new Error("参数无效。仅支持 --preview、--interactive、--apply、--help；不接受其他目录或强制删除参数。");
}

export async function assertToolStopped() {
  if (process.platform !== "win32") throw new Error("此维护脚本的占用检查仅支持 Windows。");
  const ports = new Set([4178, ...Array.from({ length: 10 }, (_, i) => 43178 + i)]);
  const configured = Number(process.env.MEDIA_TRACKER_PORT);
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) ports.add(configured);
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -in @(${[...ports].join(",")}) } | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const parsed = JSON.parse(stdout.trim() || "[]");
  const listeners = Array.isArray(parsed) ? parsed : [parsed];
  for (const port of listeners) {
    if (!ports.has(port)) throw new Error("本地服务检查返回了异常结果，未进行删除。");
    let payload;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
        signal: AbortSignal.timeout(2_000), redirect: "error",
      });
      if (!response.ok) throw new Error("Unknown service");
      payload = await response.json();
    } catch {
      throw new Error(`无法确认本机 ${port} 端口的服务是否已退出，暂不清理。请先退出工具及启动命令窗口。`);
    }
    if (payload?.runtime?.id === "builtin-chromium") {
      throw new Error(`工具后台服务仍在运行（端口 ${port}）。请关闭工具及启动命令窗口后重试；仅关闭主界面可能不够。`);
    }
  }
}

async function askConfirmation() {
  if (!process.stdin.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question("输入 DELETE 并回车确认删除；直接回车取消：")).trim() === "DELETE"; }
  finally { reader.close(); }
}

export async function runCacheCleanup({ mode = "preview", profilesRoot = defaultProfilesRoot,
  write = console.log, confirm = askConfirmation, listProfiles = listProfileDirectories,
  inspect = inspectProfileCache, clean = clearProfileCache, isRunning = profileBrowserIsRunning,
  assertStopped = assertToolStopped } = {}) {
  if (!["preview", "interactive", "apply", "help"].includes(mode)) throw new Error("Invalid cleanup mode");
  if (mode === "help") {
    write("用法：node scripts/clean-browser-cache.mjs [--preview | --interactive | --apply]");
    write("默认仅预览；--interactive 预览后输入 DELETE 确认；--apply 明确执行删除。");
    return { exitCode: 0, removedBytes: 0 };
  }
  write(`清理范围：${profilesRoot}`);
  write("仅处理 8 类普通缓存；保留 Cookie、网站存储、登录设置、同步索引及下载媒体。");
  const profiles = await listProfiles(profilesRoot);
  if (!profiles.length) {
    write("未找到可安全处理的账号资料夹：目录可能不存在、不可读或包含链接。未进行删除。");
    return { exitCode: 2, removedBytes: 0 };
  }
  let previewBytes = 0;
  let previewWarnings = 0;
  const candidates = [];
  for (const profilePath of profiles) {
    const report = await inspect({ profilesRoot, profilePath });
    const label = path.relative(profilesRoot, profilePath);
    const warning = report.errors.length ? `，${report.errors.length} 项无法安全读取、将保留` : "";
    write(`${label}：${size(report.bytes)} / ${report.files} 个缓存文件${warning}`);
    previewBytes += report.bytes;
    previewWarnings += report.errors.length;
    if (report.status === "ready") candidates.push(profilePath);
  }
  write(`预计可清理：${size(previewBytes)}。此处只扫描文件信息，没有删除。`);
  if (mode === "preview" || !candidates.length) return { exitCode: previewWarnings ? 2 : 0, removedBytes: 0, previewBytes };
  write("请先退出工具及启动命令窗口、关闭专用登录窗口；清理结束前不要重新启动工具。");
  write("删除的缓存不进入回收站，但浏览器可自动重建；下一次访问会重新加载部分网页资源。");
  if (mode === "interactive" && !await confirm()) {
    write("已取消，没有删除文件。");
    return { exitCode: 0, removedBytes: 0, cancelled: true };
  }
  // Manual maintenance never closes browsers, kills processes, or elevates rights.
  let removedBytes = 0, removedFiles = 0, skippedProfiles = 0, stopped = false;
  for (const profilePath of candidates) {
    try { await assertStopped(); }
    catch (error) { write(error.message); stopped = true; break; }
    const label = path.relative(profilesRoot, profilePath);
    try {
      if (await isRunning(profilePath)) {
        write(`跳过 ${label}：浏览器仍在使用，或无法确认已退出。`);
        skippedProfiles++;
        continue;
      }
      const result = await clean({ profilesRoot, profilePath });
      removedBytes += result.removedBytes;
      removedFiles += result.removedFiles;
      const incomplete = ["partial", "skipped", "failed"].includes(result.status);
      if (incomplete) skippedProfiles++;
      write(`${label}：已删除 ${result.removedFiles} 个缓存文件，释放 ${size(result.removedBytes)}${incomplete ? "；部分缓存因占用、权限或路径检查未清理" : ""}。`);
    } catch {
      skippedProfiles++;
      write(`跳过 ${label}：无法完成占用检查或清理，请关闭专用浏览器后重试。`);
    }
  }
  write(`本次实际删除 ${removedFiles} 个缓存文件，释放 ${size(removedBytes)}。登录资料、同步索引及正式媒体未纳入删除范围。`);
  if (skippedProfiles || stopped) write("有未处理项；不要强制删除或提升权限，可确认工具完全退出后重试。");
  return { exitCode: skippedProfiles || stopped ? 2 : 0, removedBytes, removedFiles, skippedProfiles, stopped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runCacheCleanup({ mode: parseCleanupArgs(process.argv.slice(2)) })).exitCode; }
  catch (error) { console.error(`清理未完成：${error.message}`); process.exitCode = 1; }
}
