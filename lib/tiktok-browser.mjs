import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { resolvePortableDataDirectory } from "./portable-paths.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leases = new Set();
const starting = new Map();
const warmedSessions = new Map();
const idleSessions = new Map();
// Only children spawned by this running collector grant full-exit authority.
// A previous instance's metadata is never enough to close a browser.
const ownedSessions = new Map();
const activeOperations = new Set();
const activeReleases = new Map();
const shutdownController = new AbortController();
let shutdownPromise;
let shuttingDown = false;
export const TIKTOK_BACKGROUND_IDLE_MS = 30_000;
const runtimeFile = (profile) => path.join(profile, "media-tracker-session.json");
const keyFor = (profile) => process.platform === "win32" ? profile.toLowerCase() : profile;
const BACKGROUND_SCRIPT = path.join(ROOT, "scripts", "tiktok-background-browser.ps1");
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export class TikTokBrowserError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 409; }
}

function assertRunning() {
  if (shuttingDown) throw new TikTokBrowserError("tool-shutting-down", "采集工具正在退出，不能再打开 TikTok 会话。");
}

function trackOperation() {
  let complete;
  const operation = new Promise((resolve) => { complete = resolve; });
  activeOperations.add(operation);
  return () => { activeOperations.delete(operation); complete(); };
}

export function buildTikTokBrowserArgs(profileDirectory, port, { background = false } = {}) {
  if (!path.isAbsolute(profileDirectory) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid dedicated browser profile or loopback port.");
  }
  // Ordinary bundled Chromium, using only this tool's profile. No fingerprint
  // overrides, disabled security, or modifications to the user's daily browser.
  return [`--user-data-dir=${profileDirectory}`, "--no-first-run", "--disable-background-mode",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
    ...(background ? ["--no-startup-window"] : ["about:blank"])];
}

export function validateLocalDebuggerUrl(value, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1"
      && Number(url.port) === port && !url.username && !url.password
      && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

function profilePath(value) {
  return path.resolve(value || path.join(resolvePortableDataDirectory(ROOT).dataDirectory,
    "browser-profiles", "tiktok-anonymous"));
}

// Windows command lines quote either the whole switch or just its value. Split
// arguments first so a final port flag or a following quoted URL cannot leak into it.
export function parseBrowserCommandLine(commandLine) {
  const input = String(commandLine || "");
  const args = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] || "") && index < input.length) index += 1;
    if (index >= input.length) break;
    let value = "";
    let quoted = false;
    while (index < input.length && (quoted || !/\s/.test(input[index]))) {
      if (input[index] === "\\") {
        let slashes = 0;
        while (input[index] === "\\") { slashes += 1; index += 1; }
        if (input[index] === '"') {
          value += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2) { value += '"'; index += 1; }
          else { quoted = !quoted; index += 1; }
        } else value += "\\".repeat(slashes);
      } else if (input[index] === '"') { quoted = !quoted; index += 1; }
      else { value += input[index]; index += 1; }
    }
    args.push(value);
  }
  return args;
}

export function browserArgumentValue(commandLine, name) {
  const args = Array.isArray(commandLine) ? commandLine : parseBrowserCommandLine(commandLine);
  const flag = `--${name}`;
  let value = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith(`${flag}=`)) value = args[index].slice(flag.length + 1);
    else if (args[index] === flag && args[index + 1] && !args[index + 1].startsWith("--")) value = args[index + 1];
  }
  return value;
}

export async function dedicatedProfileProcesses(profileDirectory) {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((proc) => {
    const args = parseBrowserCommandLine(proc.CommandLine);
    const value = browserArgumentValue(args, "user-data-dir");
    return value && keyFor(path.resolve(value)) === keyFor(profileDirectory)
      && !args.some((arg) => arg === "--type" || arg.startsWith("--type="));
  }).map((proc) => {
    const port = Number(browserArgumentValue(proc.CommandLine, "remote-debugging-port"));
    return { pid: Number(proc.ProcessId), parentPid: Number(proc.ParentProcessId), executablePath: proc.ExecutablePath,
      backgroundSessionId: browserArgumentValue(proc.CommandLine, "media-tracker-background-session"),
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null };
  });
}

function powershellArgumentValue(commandLine, name) {
  const args = parseBrowserCommandLine(commandLine);
  const index = args.findIndex((item) => item.toLowerCase() === `-${name.toLowerCase()}`);
  return index >= 0 ? args[index + 1] : undefined;
}

// A metadata file alone never authorizes closing a browser. Require the exact
// browser and helper process identities, parent relation, profile, port, script,
// and one-time launch ID before treating it as our private-desktop worker.
export function isManagedTikTokBackgroundProcess(saved, browserProcess, helper, profile) {
  if (!saved || saved.mode !== "background" || saved.backgroundVersion !== 1
    || !/^[a-f0-9]{32}$/.test(saved.launchId || "")
    || saved.desktopName !== `MediaTrackerBackground_${saved.launchId}`
    || saved.pid !== browserProcess?.pid || saved.port !== browserProcess?.port
    || saved.helperPid !== browserProcess?.parentPid || saved.launchId !== browserProcess?.backgroundSessionId
    || keyFor(String(browserProcess?.executablePath)) !== keyFor(chromium.executablePath())
    || Number(helper?.ProcessId) !== saved.helperPid || String(helper?.Name).toLowerCase() !== "powershell.exe"
    || keyFor(String(helper?.ExecutablePath)) !== keyFor(POWERSHELL)) return false;
  const argument = (name) => powershellArgumentValue(helper.CommandLine, name);
  return keyFor(String(argument("File"))) === keyFor(BACKGROUND_SCRIPT)
    && keyFor(String(argument("ProfileDirectory"))) === keyFor(profile)
    && keyFor(String(argument("Executable"))) === keyFor(chromium.executablePath())
    && Number(argument("Port")) === saved.port && argument("LaunchId") === saved.launchId;
}

async function backgroundHelper(saved) {
  if (!Number.isSafeInteger(saved?.helperPid) || saved.helperPid < 1) return null;
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"ProcessId = ${saved.helperPid}\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout.trim() || "null");
  } catch { return null; }
}

async function backgroundOwner(saved, browserProcess, profile) {
  return isManagedTikTokBackgroundProcess(saved, browserProcess, await backgroundHelper(saved), profile);
}

export function isCurrentCollectorTikTokSession(session, browserProcess, helper, profile, ownerPid = process.pid) {
  if (!session || session.ownerPid !== ownerPid || session.profile !== profile
    || !Number.isSafeInteger(session.pid) || session.pid < 1 || session.pid !== browserProcess?.pid
    || session.port !== browserProcess?.port
    || keyFor(String(browserProcess?.executablePath)) !== keyFor(chromium.executablePath())) return false;
  if (session.mode === "background") {
    return Number(helper?.ParentProcessId) === ownerPid
      && isManagedTikTokBackgroundProcess(session, browserProcess, helper, profile);
  }
  return session.mode === "interactive" && browserProcess.parentPid === ownerPid && !browserProcess.backgroundSessionId;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function debuggerUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1500), redirect: "error",
  });
  if (!response.ok) throw new Error("Dedicated browser is not ready.");
  const value = (await response.json()).webSocketDebuggerUrl;
  if (!validateLocalDebuggerUrl(value, port)) throw new Error("Invalid loopback debugger endpoint.");
  return value;
}

async function launchBackgroundSession(profile, port, signal) {
  if (process.platform !== "win32") throw new TikTokBrowserError("background-browser-unavailable",
    "TikTok 无窗口后台会话当前仅支持 Windows；未打开可见浏览器。");
  const launchId = randomUUID().replaceAll("-", "");
  const readyFile = path.join(profile, `media-tracker-launch-${launchId}.json`);
  const stopFile = path.join(profile, `media-tracker-stop-${launchId}`);
  const helper = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-File", BACKGROUND_SCRIPT,
    "-Executable", chromium.executablePath(), "-ProfileDirectory", profile, "-Port", String(port), "-LaunchId", launchId],
  // Windows PowerShell exits before executing -File when spawned detached with
  // no console. Hidden + ignored stdio + unref keeps it non-interactive without
  // creating an extra console/taskbar window.
  { stdio: "ignore", windowsHide: true });
  let launchError;
  let verifiedLaunch;
  helper.on("error", (error) => { launchError = error; });
  helper.unref();
  const deadline = Date.now() + 25_000;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let ready;
      try { ready = JSON.parse(await readFile(readyFile, "utf8")); } catch {}
      if (ready?.error) throw new TikTokBrowserError("background-browser-unavailable",
        `无法启动 TikTok 无窗口后台会话${Number.isInteger(ready.nativeError) ? `（Windows ${ready.nativeError}）` : ""}；未打开可见浏览器。`);
      if (ready && ready.launchId === launchId && ready.helperPid === helper.pid
        && ready.desktopName === `MediaTrackerBackground_${launchId}` && Number.isSafeInteger(ready.pid)) {
        const endpoint = await debuggerUrl(port).catch(() => null);
        if (endpoint) {
          const saved = { pid: ready.pid, helperPid: helper.pid, port, mode: "background", backgroundVersion: 1,
            launchId, desktopName: ready.desktopName, createdAt: new Date().toISOString() };
          const processInfo = (await dedicatedProfileProcesses(profile)).find((item) => item.pid === ready.pid);
          if (!await backgroundOwner(saved, processInfo, profile)) throw new TikTokBrowserError("background-browser-unavailable",
            "TikTok 后台会话身份校验失败；未打开可见浏览器。");
          verifiedLaunch = saved;
          await writeFile(runtimeFile(profile), JSON.stringify(saved), { mode: 0o600 });
          ownedSessions.set(keyFor(profile), { ...saved, profile, endpoint, ownerPid: process.pid, child: helper });
          return { endpoint, spawnedForWork: true, profile, mode: "background" };
        }
      }
      if (launchError || helper.exitCode != null) break;
      await delay(150, undefined, { signal });
    }
    throw new TikTokBrowserError("background-browser-unavailable", "无法启动 TikTok 无窗口后台会话，请重启工具后重试；未打开可见浏览器。");
  } catch (error) {
    // Only this unique launch's helper reads the marker. It owns the exact
    // native process handle it created; no process-name matching or user browser
    // termination is involved if startup is cancelled or fails.
    const stopWritten = await writeFile(stopFile, "stop", { mode: 0o600 }).then(() => true, () => false);
    // If the profile becomes unwritable after launch, use only the already
    // verified child and re-check its identity before a best-effort graceful
    // shutdown. Never close an unverified process just to recover from I/O.
    if (!stopWritten && verifiedLaunch) {
      let cleanupBrowser;
      try {
        const exact = (await dedicatedProfileProcesses(profile)).find((item) => item.pid === verifiedLaunch.pid);
        if (await backgroundOwner(verifiedLaunch, exact, profile)) {
          cleanupBrowser = await chromium.connectOverCDP(await debuggerUrl(port), { noDefaults: true, timeout: 3_000 });
          const cdp = await cleanupBrowser.newBrowserCDPSession();
          await cdp.send("Browser.close");
        }
      } catch {} finally { await cleanupBrowser?.close().catch(() => {}); }
    }
    const cleanupDeadline = Date.now() + 5_000;
    while (!launchError && helper.exitCode == null && helper.signalCode == null && Date.now() < cleanupDeadline) {
      await delay(100);
    }
    throw error;
  }
}

async function closeIdleBackgroundSession(endpoint, profile, saved, signal) {
  let browser, cdp;
  try {
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
    cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send("Target.getTargets");
    // A blank URL does not establish ownership: another client may have opened
    // it. Only a genuinely tab-free private worker may be stopped.
    if (targetInfos.some((target) => ["page", "other"].includes(target.type))) {
      throw new TikTokBrowserError("profile-busy", "TikTok 后台工作页尚未结束。请等待或停止同步后，再打开登录窗口；未关闭任何现有页面。");
    }
    signal?.throwIfAborted();
    await cdp.send("Browser.close");
  } finally { await browser?.close().catch(() => {}); }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await dedicatedProfileProcesses(profile)).some((item) => item.pid === saved.pid)) return;
    await delay(150, undefined, { signal });
  }
  throw new TikTokBrowserError("profile-busy", "TikTok 后台会话正在退出，请稍后再打开登录窗口。");
}

async function cancelIdleClose(key) {
  const idle = idleSessions.get(key);
  if (!idle) return;
  clearTimeout(idle.timer);
  if (idle.promise) await idle.promise;
  if (idleSessions.get(key) === idle) idleSessions.delete(key);
}

function scheduleIdleClose(profile, session) {
  if (shuttingDown || session?.mode !== "background") return;
  const key = keyFor(profile);
  const previous = idleSessions.get(key);
  if (previous) clearTimeout(previous.timer);
  const idle = { timer: null, promise: null };
  idle.timer = setTimeout(() => {
    if (leases.has(key) || idleSessions.get(key) !== idle) {
      if (idleSessions.get(key) === idle) idleSessions.delete(key);
      return;
    }
    // New leases wait for this operation before connecting, avoiding a race
    // between the emptiness check and the browser's graceful shutdown.
    idle.promise = (async () => {
      const saved = JSON.parse(await readFile(runtimeFile(profile), "utf8"));
      const proc = (await dedicatedProfileProcesses(profile)).find((item) => item.pid === saved.pid);
      if (!await backgroundOwner(saved, proc, profile)) return;
      const endpoint = await debuggerUrl(saved.port);
      if (endpoint !== session.endpoint) return;
      await closeIdleBackgroundSession(endpoint, profile, saved);
      if (warmedSessions.get(key) === endpoint) warmedSessions.delete(key);
    })().catch(() => {
      // Unknown tabs, changed ownership, and unavailable processes are never
      // force-closed. A later ordinary lease can retry safe idle cleanup.
    }).finally(() => { if (idleSessions.get(key) === idle) idleSessions.delete(key); });
  }, TIKTOK_BACKGROUND_IDLE_MS);
  idle.timer.unref();
  idleSessions.set(key, idle);
}

// Maintenance reserves the same lease as downloads/login. Only a verified,
// tab-free private worker may be closed; interactive or unknown sessions stay.
export async function withIdleTikTokProfile(profileDirectory, callback) {
  assertRunning();
  const profile = profilePath(profileDirectory);
  const key = keyFor(profile);
  if (leases.has(key)) return { status: "skipped", reason: "profile-busy" };
  const completeOperation = trackOperation();
  leases.add(key);
  try {
    await cancelIdleClose(key);
    if (starting.has(key)) await starting.get(key);
    assertRunning();
    const processes = await dedicatedProfileProcesses(profile);
    if (processes.length) {
      let saved;
      try { saved = JSON.parse(await readFile(runtimeFile(profile), "utf8")); } catch {}
      const proc = processes.find((item) => item.pid === saved?.pid);
      if (processes.length !== 1 || !await backgroundOwner(saved, proc, profile)) {
        return { status: "skipped", reason: "profile-busy" };
      }
      try {
        await closeIdleBackgroundSession(await debuggerUrl(saved.port), profile, saved);
      } catch { return { status: "skipped", reason: "profile-busy" }; }
      warmedSessions.delete(key);
    }
    assertRunning();
    return await callback();
  } finally { leases.delete(key); completeOperation(); }
}

async function trackWorkTargets(browser) {
  const cdp = await browser.newBrowserCDPSession();
  const known = new Map();
  const owned = new Set();
  const closing = new Set();
  const pending = new Set();
  let retiring = false;
  const closeTarget = (targetId) => {
    if (closing.has(targetId)) return;
    closing.add(targetId);
    const operation = cdp.send("Target.closeTarget", { targetId }).catch(() => {}).finally(() => pending.delete(operation));
    pending.add(operation);
  };
  const discoverChildren = () => {
    let changed;
    do {
      changed = false;
      for (const info of known.values()) {
        if (!owned.has(info.targetId) && info.openerId && owned.has(info.openerId)) {
          owned.add(info.targetId);
          changed = true;
          // Background collection never requires a popup. Reclaim descendants
          // immediately, including blank/noopener popups, using opener identity
          // rather than the URL. Unrelated or existing tabs are untouched.
          closeTarget(info.targetId);
        }
      }
    } while (changed);
  };
  const onTarget = ({ targetInfo }) => { known.set(targetInfo.targetId, targetInfo); discoverChildren(); };
  const onDestroyed = ({ targetId }) => { known.delete(targetId); };
  cdp.on("Target.targetCreated", onTarget);
  cdp.on("Target.targetInfoChanged", onTarget);
  cdp.on("Target.targetDestroyed", onDestroyed);
  try { await cdp.send("Target.setDiscoverTargets", { discover: true }); }
  catch (error) { await cdp.detach().catch(() => {}); throw error; }
  return {
    async own(context, page) {
      const pageSession = await context.newCDPSession(page);
      try {
        const { targetInfo } = await pageSession.send("Target.getTargetInfo");
        owned.add(targetInfo.targetId);
        if (retiring) closeTarget(targetInfo.targetId);
        discoverChildren();
      } finally { await pageSession.detach().catch(() => {}); }
    },
    async close() {
      retiring = true;
      for (const id of owned) closeTarget(id);
      while (pending.size) await Promise.all([...pending]);
      cdp.off("Target.targetCreated", onTarget);
      cdp.off("Target.targetInfoChanged", onTarget);
      cdp.off("Target.targetDestroyed", onDestroyed);
      await cdp.detach().catch(() => {});
    },
  };
}

async function connectSession(profile, purpose, signal) {
  signal?.throwIfAborted();
  await mkdir(profile, { recursive: true });
  let saved;
  try { saved = JSON.parse(await readFile(runtimeFile(profile), "utf8")); } catch {}
  const processes = await dedicatedProfileProcesses(profile);
  const executable = chromium.executablePath();
  const owned = saved && processes.find((proc) => proc.pid === saved.pid && proc.port === saved.port
    && keyFor(String(proc.executablePath)) === keyFor(executable));
  if (owned) {
    const endpoint = await debuggerUrl(saved.port).catch(() => null);
    if (endpoint) {
      if (saved.mode === "background") {
        if (!await backgroundOwner(saved, owned, profile)) throw new TikTokBrowserError("profile-busy",
          "无法确认现有 TikTok 后台会话的归属，请先退出旧版采集工具后重试；未关闭任何浏览器。");
        if (purpose !== "login") return { endpoint, spawnedForWork: false, profile, mode: "background" };
        await closeIdleBackgroundSession(endpoint, profile, saved, signal);
        if ((await dedicatedProfileProcesses(profile)).length) throw new TikTokBrowserError("profile-busy",
          "TikTok 专用会话状态正在变化，请稍后再打开登录窗口；未关闭任何其他进程。");
      } else if (purpose === "login" && !owned.backgroundSessionId) {
        return { endpoint, spawnedForWork: false, profile, mode: "interactive" };
      } else {
        throw new TikTokBrowserError("profile-interactive-active",
          "请先关闭 TikTok 专用登录窗口，再验证登录或同步。后台会复用已保存的登录状态，不会弹窗，也不会关闭你的日常浏览器。");
      }
    } else if (processes.length) {
      throw new TikTokBrowserError("profile-busy", "TikTok 专用会话暂时无法连接，请关闭旧版专用登录窗口后重试。");
    }
  }
  if (processes.length && !(owned && saved.mode === "background" && purpose === "login")) throw new TikTokBrowserError("profile-busy",
    "TikTok 旧版专用登录窗口仍在运行。请先关闭该专用窗口后重试；不会关闭你的日常浏览器。");

  const port = await freePort();
  if (purpose !== "login") return launchBackgroundSession(profile, port, signal);
  const child = spawn(executable, buildTikTokBrowserArgs(profile, port, { background: purpose !== "login" }),
    { detached: true, stdio: "ignore", windowsHide: true });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (launchError || child.exitCode != null) break;
      const endpoint = await debuggerUrl(port).catch(() => null);
      if (endpoint) {
        const saved = { pid: child.pid, port, mode: "interactive", createdAt: new Date().toISOString() };
        await writeFile(runtimeFile(profile), JSON.stringify(saved), { mode: 0o600 });
        ownedSessions.set(keyFor(profile), { ...saved, profile, endpoint, ownerPid: process.pid, child });
        return { endpoint, spawnedForWork: false, profile, mode: "interactive" };
      }
      await delay(150, undefined, { signal });
    }
    throw new TikTokBrowserError("browser-unavailable", "无法启动 TikTok 专用会话。请关闭旧版专用登录窗口后重试。");
  } catch (error) {
    // This is only the child created above, never another browser/profile.
    if (child.pid && child.exitCode == null) child.kill();
    throw error;
  }
}

async function ensureSession(profile, purpose, signal) {
  const key = keyFor(profile);
  let operation = starting.get(key);
  if (!operation) {
    operation = connectSession(profile, purpose, signal).finally(() => starting.delete(key));
    starting.set(key, operation);
  }
  return operation;
}

// A lease owns only its new work tab. Existing login/user tabs are never navigated
// or closed. Cancelling a sync releases this lease, not the whole login session.
export async function acquireTikTokPage({ profileDirectory, signal, purpose = "sync" } = {}) {
  assertRunning();
  signal = signal ? AbortSignal.any([signal, shutdownController.signal]) : shutdownController.signal;
  if (purpose === "login") throw new TikTokBrowserError("interactive-login-required", "请使用“打开登录窗口”进行交互式登录；后台工作页不会打开可见窗口。");
  signal?.throwIfAborted();
  const profile = profilePath(profileDirectory);
  const key = keyFor(profile);
  if (leases.has(key)) throw new TikTokBrowserError("profile-busy", "该 TikTok 专用会话正在验证或同步，请等待结束后重试。");
  const completeOperation = trackOperation();
  leases.add(key);
  let browser, page, session, workTargets, releasePromise;
  const release = () => {
    releasePromise ||= (async () => {
      signal?.removeEventListener("abort", cancel);
      try {
        if (page && !page.isClosed()) await page.close().catch(() => {});
        await workTargets?.close().catch(() => {});
      } finally {
        // Disconnect only this client now; retain a brief tab-free grace period
        // for the following image-download lease before closing an idle worker.
        try { await browser?.close().catch(() => {}); }
        finally { leases.delete(key); activeReleases.delete(key); scheduleIdleClose(profile, session); }
      }
    })();
    return releasePromise;
  };
  const cancel = () => { void release(); };
  activeReleases.set(key, release);
  try {
    await cancelIdleClose(key);
    session = await ensureSession(profile, purpose, signal);
    signal?.throwIfAborted();
    browser = await chromium.connectOverCDP(session.endpoint, { noDefaults: true, timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Dedicated Chromium has no default context.");
    workTargets = await trackWorkTargets(browser);
    page = await context.newPage();
    await workTargets.own(context, page);
    await page.setViewportSize({ width: 1280, height: 900 });
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    return { context, page, release, background: true,
      needsHomeWarmup: warmedSessions.get(key) !== session.endpoint,
      markHomeWarmupComplete: () => {
        if (releasePromise || signal?.aborted) return false;
        warmedSessions.set(key, session.endpoint);
        return true;
      } };
  } catch (error) { await release(); throw error; }
  finally { completeOperation(); }
}

export async function openTikTokLoginWindow(profileDirectory) {
  assertRunning();
  const profile = profilePath(profileDirectory);
  const key = keyFor(profile);
  if (leases.has(key)) throw new TikTokBrowserError("profile-busy", "该 TikTok 会话正在同步或验证，请等待结束后再打开登录窗口。");
  const completeOperation = trackOperation();
  leases.add(key);
  let browser;
  try {
    await cancelIdleClose(key);
    const session = await ensureSession(profile, "login", shutdownController.signal);
    assertRunning();
    browser = await chromium.connectOverCDP(session.endpoint, { noDefaults: true, timeout: 10_000 });
    const context = browser.contexts()[0];
    let page = context.pages().find((item) => /^https:\/\/(?:www\.)?tiktok\.com(?:\/|$)/i.test(item.url()));
    if (!page) {
      page = context.pages().find((item) => item.url() === "about:blank") || await context.newPage();
      // Login is interactive; do not turn a slow network into a launch failure.
      await page.goto("https://www.tiktok.com/", { waitUntil: "commit", timeout: 20_000 }).catch(() => {});
    }
    // An existing interactive login window may have been minimized by the user.
    // Restore it only for this explicit request; background workers never use it.
    let windowSession;
    try {
      windowSession = await context.newCDPSession(page);
      const { windowId } = await windowSession.send("Browser.getWindowForTarget");
      await windowSession.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    } catch {} finally { await windowSession?.detach().catch(() => {}); }
    await page.bringToFront();
    assertRunning();
    return { message: "TikTok 专用登录窗口已打开。登录完成后，请先关闭该专用窗口，再点击“验证登录”；后台会复用已保存的登录状态，验证和同步不会弹窗。" };
  } finally {
    await browser?.close().catch(() => {});
    leases.delete(key);
    completeOperation();
  }
}

async function closeCurrentCollectorSession(session) {
  const { profile, child } = session;
  if (child.exitCode != null || child.signalCode != null) return { status: "already-closed" };
  const processes = await dedicatedProfileProcesses(profile);
  const proc = processes.find((item) => item.pid === session.pid);
  if (!proc) return { status: "already-closed" };
  const helper = session.mode === "background" ? await backgroundHelper(session) : null;
  if (!isCurrentCollectorTikTokSession(session, proc, helper, profile)) return { status: "skipped", reason: "ownership-changed" };
  const endpoint = await debuggerUrl(session.port).catch(() => null);
  let browser;
  let graceful = false;
  try {
    if (endpoint === session.endpoint) {
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5_000 });
      const cdp = await browser.newBrowserCDPSession();
      // Full application exit differs from idle maintenance: all tabs of this
      // verified current-process private worker/login session belong to it.
      await cdp.send("Browser.close");
      graceful = true;
    }
  } catch {} finally { await browser?.close().catch(() => {}); }
  if (!graceful) {
    // Recheck identity after a failed CDP connection. The unique helper marker
    // reaches only its native process handle/job, never a global browser set.
    const exact = (await dedicatedProfileProcesses(profile)).find((item) => item.pid === session.pid);
    const currentHelper = session.mode === "background" ? await backgroundHelper(session) : null;
    if (!isCurrentCollectorTikTokSession(session, exact, currentHelper, profile)) return { status: "skipped", reason: "ownership-changed" };
    if (session.mode === "background") {
      try { await writeFile(path.join(profile, "media-tracker-stop-" + session.launchId), "stop", { mode: 0o600 }); }
      catch (error) {
        // This retained ChildProcess was spawned here and the helper identity
        // was just revalidated. Its native job collects only its own Chromium.
        if (child.pid === session.helperPid && child.exitCode == null && child.signalCode == null) child.kill();
        else throw error;
      }
    } else if (child.exitCode == null && child.signalCode == null) child.kill();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await dedicatedProfileProcesses(profile)).some((item) => item.pid === session.pid)) return { status: "closed" };
    await delay(100);
  }
  throw new TikTokBrowserError("browser-exit-incomplete", "TikTok 专用会话尚未完全退出。");
}

export function shutdownTikTokSessions() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownController.abort(new TikTokBrowserError("tool-shutting-down", "采集工具正在退出。"));
  shutdownPromise = (async () => {
    const idleWork = [...idleSessions.values()];
    for (const idle of idleWork) clearTimeout(idle.timer);
    await Promise.allSettled(idleWork.map((idle) => idle.promise).filter(Boolean));
    idleSessions.clear();
    await Promise.allSettled([...starting.values(), ...activeOperations]);
    await Promise.allSettled([...activeReleases.values()].map((release) => release()));
    const result = { closed: 0, skipped: 0, errors: [] };
    await Promise.all([...ownedSessions.values()].map(async (session) => {
      try {
        const closed = await closeCurrentCollectorSession(session);
        if (closed.status === "closed") result.closed++;
        else if (closed.status === "skipped") result.skipped++;
      } catch (error) { result.errors.push({ profile: session.profile, message: error.message }); }
    }));
    warmedSessions.clear();
    return result;
  })();
  return shutdownPromise;
}
