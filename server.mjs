import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rename, mkdir, stat, open, unlink } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./lib/background-chromium.mjs";
import {
  PLATFORMS,
  createArchiveDirectories,
  normalizePlatforms,
  pathExists,
  resolvePersonFolder,
} from "./lib/archive.mjs";
import { classifyLogin } from "./lib/auth.mjs";
import { acquireTikTokPage, openTikTokLoginWindow, shutdownTikTokSessions, TikTokBrowserError } from "./lib/tiktok-browser.mjs";
import { inspectTikTokPageLogin } from "./lib/tiktok-login.mjs";
import { buildFolderPickerScript } from "./lib/folder-picker.mjs";
import {
  HomepageDiscoveryError,
  analyzeHomepage,
  normalizeHomepageUrl,
} from "./lib/homepage-discovery.mjs";
import { SyncManager } from "./lib/sync-engine.mjs";
import { ProfileMaintenance, profileBrowserIsRunning } from "./lib/profile-maintenance.mjs";
import { ManualCacheMaintenance } from "./lib/manual-cache-maintenance.mjs";
import { createAppShell } from "./lib/app-shell.mjs";
import { OwnedLoginWindows } from "./lib/owned-login-windows.mjs";
import { inspectRunningTracker, findRunningTracker } from "./lib/running-tracker.mjs";
import { createStartupTiming } from "./lib/startup-timing.mjs";
import { createCustomPlatform, updateCustomPlatform, normalizeCustomPlatforms, getPlatformRegistry,
  validateTargetUrl, assertCustomPublicUrl } from "./lib/platform-registry.mjs";
import { inspectCustomLogin } from "./lib/custom-login.mjs";
import { cleanupStaleCustomSessions } from "./lib/custom-sync.mjs";
import { resolveReceiptFile } from "./lib/file-reveal.mjs";
import { parseWindowsFileActionOutput } from "./lib/windows-file-action.mjs";
import { openPersonFolder } from "./lib/person-folder-open.mjs";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "./lib/person-media-index.mjs";
import { deletePersonDirectory, PersonDeletionError } from "./lib/person-delete.mjs";
import { DedupManager, deduplicatePerson } from "./lib/similarity-dedup.mjs";
import { normalizeDedupToolsSettings, dedupToolsStatus,
  portableToolDirectory, installBundledDedupTools } from "./lib/dedup-tools.mjs";
import { DedupFeature } from "./lib/dedup-feature.mjs";
import { resolveBoundPost, assertBoundProfile } from "./lib/bound-post.mjs";
import { withIdleTikTokProfile } from "./lib/tiktok-browser.mjs";
import { acknowledgeLauncherReady } from "./lib/launcher-ready.mjs";
import { finalizeRuntimeExit } from "./lib/runtime-shutdown.mjs";
import { resolvePortableDataDirectory, hydrateProfilePaths, serializeProfilePaths,
  assertPortableProfilePaths } from "./lib/portable-paths.mjs";
import { UI_LANGUAGES, normalizeUiLanguage, createSystemLanguageProvider } from "./lib/ui-language.mjs";
import { readReleaseIdentity } from "./lib/release-identity.mjs";
import { LocalApiSecurity, PUBLIC_APPLICATION_ID, SESSION_HEADER, assertPublicPortableRoot,
  readLocalSession, writeLocalSession, removeLocalSessionSync } from "./lib/local-api-security.mjs";
import { requiresPublicUseAcknowledgement, publicUseStatus, recordPublicUseAcknowledgement } from "./lib/public-release-policy.mjs";
import { FollowingImportManager, followingSupportedPlatformIds } from "./lib/following-import-manager.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORTABLE_PATHS = resolvePortableDataDirectory(ROOT);
assertPublicPortableRoot(ROOT, PORTABLE_PATHS);
const RELEASE = await readReleaseIdentity({ root: ROOT, portableRoot: PORTABLE_PATHS.portableRoot });
const DATA_DIR = PORTABLE_PATHS.dataDirectory;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SYNC_INDEX_FILE = path.join(DATA_DIR, "sync-index.json");
const PROFILE_DIR = path.join(DATA_DIR, "browser-profiles");
const WINDOWS_FILE_ACTION_SCRIPT = path.join(ROOT, "scripts", "windows-file-action.ps1");
const HOST = "127.0.0.1";
const configuredPort = Number(process.env.MEDIA_TRACKER_PORT || 0);
const PORT_CANDIDATES = configuredPort
  ? [configuredPort]
  : [4178, ...Array.from({ length: 10 }, (_, index) => 43178 + index)];
let portCandidateIndex = 0;
let PORT = PORT_CANDIDATES[portCandidateIndex];

const DEFAULT_STATE = Object.freeze({
  version: 4,
  settings: { theme: "system", language: "system" },
  linkedAccounts: [],
  customPlatforms: [],
  persons: [],
  recentPaths: [],
});

const RUNTIME = Object.freeze({ id: "builtin-chromium", applicationId: PUBLIC_APPLICATION_ID, label: "工具内置 Chromium", windowLifecycleVersion: 1,
  instanceKey: createHash("sha256").update(`${ROOT.toLowerCase()}\0${DATA_DIR.toLowerCase()}`).digest("hex") });
const THEMES = new Set(["system", "light", "dark"]);
let runtimeShuttingDown = false;
let shutdownPromise;
const runtimeAbort = new AbortController();
const activeRequests = new Set();
const verificationContexts = new Set();
const startupTiming = createStartupTiming();
let firstStateReported = false;
startupTiming("modules-loaded");

const PLATFORM_HOME_URLS = Object.freeze({
  x: "https://x.com/home",
  instagram: "https://www.instagram.com/",
  threads: "https://www.threads.com/",
  facebook: "https://www.facebook.com/",
  tiktok: "https://www.tiktok.com/",
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return structuredClone(DEFAULT_STATE);
  const raw = await readFile(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const customPlatforms = normalizeCustomPlatforms(parsed.customPlatforms || []);
  const registry = getPlatformRegistry(customPlatforms);
  const state = {
    version: 4,
    customPlatforms,
    settings: {
      ...(parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings) ? parsed.settings : {}),
      theme: THEMES.has(parsed.settings?.theme) ? parsed.settings.theme : "system",
      language: normalizeUiLanguage(parsed.settings?.language),
      dedupTools: normalizeDedupToolsSettings(parsed.settings?.dedupTools),
    },
    linkedAccounts: Array.isArray(parsed.linkedAccounts)
      ? parsed.linkedAccounts.map((account) => ({
          browserId: RUNTIME.id,
          browserLabel: RUNTIME.label,
          loginStatus: "unverified",
          loginCheckedAt: null,
          loginMessage: "尚未验证登录。",
          ...account,
          platformLabel: registry[account.platformId]?.label || account.platformLabel,
          ...(account.platformId === "tiktok" && account.loginStatus === "verified"
            && account.loginVerificationVersion !== 2 ? {
              loginStatus: "unverified",
              loginMessage: "旧版登录结果尚未通过在线身份检查，请点击“验证登录”；无需重新绑定账号。",
            } : {}),
        }))
      : [],
    persons: Array.isArray(parsed.persons)
      ? parsed.persons.map((person) => ({
          homepageUrl: "",
          homepageAnalysis: null,
          ...person,
          platforms: normalizePlatforms(person.platforms || [], registry),
        }))
      : [],
    recentPaths: Array.isArray(parsed.recentPaths) ? parsed.recentPaths.slice(0, 12) : [],
  };
  // Public source and packaged launches both keep every bound profile under
  // this explicit data root; a copied state cannot silently use another tool.
  const profileOptions = { dataDirectory: DATA_DIR, portable: true };
  const runtimeState = hydrateProfilePaths(state, profileOptions);
  await assertPortableProfilePaths(runtimeState, profileOptions);
  return runtimeState;
}

async function saveState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  const serialized = serializeProfilePaths(state, { dataDirectory: DATA_DIR, portable: PORTABLE_PATHS.portable });
  await writeFile(temporary, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  await rename(temporary, STATE_FILE);
}

async function forwardToRunningTracker(port, running) {
  if (running.shuttingDown) throw new Error("工具正在完整退出，请等待收尾结束后再启动。");
  if (running.applicationId !== PUBLIC_APPLICATION_ID || running.windowLifecycleVersion !== 1 || running.instanceKey !== RUNTIME.instanceKey) {
    throw new Error("旧版后台服务仍在运行。请先完整退出旧版服务，再启动一次；新版本关闭主窗口会自动完整退出。");
  }
  if (process.env.MEDIA_TRACKER_NO_OPEN !== "1") {
    const session = await readLocalSession(DATA_DIR, { instanceKey: RUNTIME.instanceKey, port });
    const response = await fetch(`http://${HOST}:${port}/api/runtime/open-window`, {
      method: "POST", headers: { Origin: `http://${HOST}:${port}`, "Content-Type": "application/json", [SESSION_HEADER]: session.token },
      body: "{}", signal: AbortSignal.timeout(35_000), redirect: "error",
    });
    // Finish the request, then let Node drain transport close callbacks. A
    // forced process.exit here can race Windows libuv's async handle close.
    await response.body?.cancel();
    if (!response.ok) throw new Error("现有工具正在退出或无法打开窗口，请等待结束后再启动。");
    await acknowledgeLauncherReady(DATA_DIR);
  }
  console.log(`Media Tracker 已经在运行：http://${HOST}:${port}`);
}

// A repeat launch must delegate to the process that owns the window, before
// opening another store or profile. A Chromium singleton child exiting is not
// proof that the application's visible window was closed.
const preflightStarted = performance.now();
const runningTracker = await findRunningTracker(PORT_CANDIDATES, { instanceKey: RUNTIME.instanceKey,
  runtimeId: RUNTIME.id, applicationId: PUBLIC_APPLICATION_ID, host: HOST });
startupTiming("existing-service-checked", performance.now() - preflightStarted);
if (runningTracker) {
  await forwardToRunningTracker(runningTracker.port, runningTracker.runtime);
  process.exitCode = 0;
} else {
// The repeat-launch branch does not create stores, browser ownership or a
// listening server. Natural exit can safely drain its completed fetch handles.
const systemLanguage = createSystemLanguageProvider();
const apiSecurity = new LocalApiSecurity();
let sessionReady = false;
const dedupFeature = new DedupFeature({ root: PORTABLE_PATHS.portableRoot || ROOT, loadState, saveState,
  acquireMaintenance: () => syncManager.beginMediaMaintenance(), releaseMaintenance: (token) => syncManager.endMediaMaintenance(token),
  persistTools: (settings) => runStateMutation(async () => {
    const state = await loadState(); state.settings = { ...state.settings, dedupTools: settings }; await saveState(state);
  }),
  signal: runtimeAbort.signal });
await dedupFeature.ready;

const profileMaintenance = new ProfileMaintenance({ profilesRoot: PROFILE_DIR });
const loginWindows = new OwnedLoginWindows({ executable: chromium.executablePath() });
const appShell = createAppShell({ profileDirectory: path.join(DATA_DIR, "builtin-app-profile-v1"),
  onStartupTiming: ({ stage, elapsedMs }) => startupTiming(`window.${stage}`, elapsedMs),
  onLastWindowClosed: ({ reason }) => shutdownRuntime(reason), onError: (error) => console.error("工具窗口错误：", error.message) });
// Startup and the explicit offline reset share an exclusive gate. Merely
// checking existsSync before loading the store would leave a check/start race.
await mkdir(DATA_DIR, { recursive: true });
try {
  const cleanup = await cleanupStaleCustomSessions({ dataRoot: DATA_DIR });
  if (cleanup.removed || cleanup.retained) {
    console.info(`临时会话检查：已清理 ${cleanup.removed}，保留 ${cleanup.retained}。`);
  }
} catch {
  // A failed ownership/permission check must retain the files, never guess at
  // credentials or disclose paths and account details in startup diagnostics.
  console.warn("临时会话检查未完成，已保留现有文件。");
}
const startupGatePath = path.join(DATA_DIR, ".readable-names-maintenance.lock");
const startupGateToken = randomUUID();
let startupGateHandle;
try {
  startupGateHandle = await open(startupGatePath, "wx");
  await startupGateHandle.writeFile(JSON.stringify({ token: startupGateToken, pid: process.pid, operation: "server-start" }));
  await startupGateHandle.sync();
} catch (error) {
  await startupGateHandle?.close().catch(() => {});
  if (startupGateHandle) await unlink(startupGatePath).catch(() => {});
  if (error.code === "EEXIST") throw new Error("索引维护或工具启动正在进行，请等待结束后再启动工具。");
  throw error;
}
await startupGateHandle.close();
function releaseStartupGateSync() {
  try {
    if (JSON.parse(readFileSync(startupGatePath, "utf8")).token === startupGateToken) unlinkSync(startupGatePath);
  } catch (error) { if (error.code !== "ENOENT") console.error("启动锁释放失败：", error.code || error.message); }
}
process.on("exit", () => {
  releaseStartupGateSync();
  try { removeLocalSessionSync(DATA_DIR, apiSecurity.token); }
  catch { console.error("本次本地会话文件未能移除；下次启动会更新会话，不影响媒体和登录资料。"); }
});
const syncManager = new SyncManager({ indexFile: SYNC_INDEX_FILE, loadState,
  cleanupAccountCache: (options) => profileMaintenance.cleanupAccount(options), deduplicate: deduplicatePerson,
  checkDedupTools: (options) => dedupFeature.checkTools(options) });
const dedupManager = new DedupManager({ loadState, reportFile: path.join(DATA_DIR, "dedup-last-run.json"),
  acquireMaintenance: () => syncManager.beginMediaMaintenance(),
  releaseMaintenance: (token) => syncManager.endMediaMaintenance(token) });
// Finish the backed-up, one-time layout upgrade before accepting requests.
const indexStarted = performance.now();
await syncManager.store.ready;
startupTiming("sync-index-ready", performance.now() - indexStarted);
const manualCacheMaintenance = new ManualCacheMaintenance({ profilesRoot: PROFILE_DIR,
  loadState, syncManager, profileMaintenance });
const followingManager = new FollowingImportManager({ loadState, scheduler: syncManager.accountScheduler,
  signal: runtimeAbort.signal,
  withProfileUse: (account, callback) => profileMaintenance.withProfileUse(account.profileDirectory, callback),
  checkProfile: async (account, { signal }) => {
    signal.throwIfAborted();
    try {
      if (!(await stat(account.profileDirectory)).isDirectory()) throw new Error();
    } catch {
      throw Object.assign(new Error("原登录资料不可用，未创建新的空资料夹。"), { code: "profile-missing" });
    }
    // TikTok owns an invisible reusable session; its lease implementation can
    // distinguish that worker from an interactive login window itself.
    if (account.platformId !== "tiktok" && await profileBrowserIsRunning(account.profileDirectory)) {
      throw Object.assign(new Error("独立登录窗口尚未关闭。"), { code: "profile-busy" });
    }
    signal.throwIfAborted();
  } });

async function withAccountBrowserUse(account, callback) {
  const keys = [`login:${account.id}`, `profile:${path.resolve(account.profileDirectory).toLowerCase()}`];
  if (keys.some((key) => syncManager.activeResourceKeys.has(key))) {
    throw new HttpError(409, "该关联账号正在同步或清理缓存，请等待结束后重试。");
  }
  // Reserve the scheduler keys too: a verification that starts first must not
  // race a newly queued sync or its final cache cleanup.
  for (const key of keys) syncManager.activeResourceKeys.add(key);
  syncManager.refreshQueueState();
  try { return await profileMaintenance.withProfileUse(account.profileDirectory, callback); }
  finally {
    for (const key of keys) syncManager.activeResourceKeys.delete(key);
    syncManager.drain();
  }
}
let stateMutationQueue = Promise.resolve();

// Keep configuration read/modify/write operations together so an older request
// cannot resurrect a deleted person. Downloads and read-only requests stay parallel.
function runStateMutation(operation) {
  const result = stateMutationQueue.then(operation);
  stateMutationQueue = result.catch(() => {});
  return result;
}

function modifiesState(request, pathname) {
  return !["GET", "HEAD"].includes(request.method)
    && (/^\/api\/persons(?:\/[^/]+)?$/.test(pathname)
      || /^\/api\/linked-accounts(?:\/|$)/.test(pathname)
      || /^\/api\/platforms(?:\/[^/]+)?$/.test(pathname)
      || pathname === "/api/settings" || pathname === "/api/folders/pick"
      || pathname === "/api/release-policy"
      || pathname === "/api/tools/dedup" || pathname === "/api/tools/dedup/install"
      || pathname === "/api/features/dedup/install"
      || pathname === "/api/cache/remove-unlinked-profiles");
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function assertLocalOrigin(request) {
  apiSecurity.assertLocalRequest(request, PORT);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "请求内容过大。 ");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求内容不是有效的 JSON。 ");
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/vnd.microsoft.icon",
  }[extension] || "application/octet-stream";
}

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new HttpError(404, "页面不存在。 ");

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": body.length,
      ...(RELEASE.buildId ? { "X-Media-Tracker-Build": RELEASE.buildId } : {}),
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "页面不存在。 ");
    throw error;
  }
}

function platformOrThrow(platformId, state = {}) {
  const registry = getPlatformRegistry(state.customPlatforms || []);
  const key = String(platformId || "").toLowerCase();
  const platform = Object.hasOwn(registry, key) ? registry[key] : null;
  if (!platform) throw new HttpError(400, "请选择受支持的社交媒体平台。 ");
  return platform;
}

async function launchInteractivePage(profileDirectory, url) {
  try { return await loginWindows.open(profileDirectory, url); }
  catch { throw new HttpError(503, "无法启动工具专用登录窗口，请检查启动日志中的内置浏览器运行环境。"); }
}

function validatePersonAccounts(platforms, state) {
  for (const group of platforms) {
    const definition = platformOrThrow(group.id, state);
    for (const account of group.accounts) {
      if (definition.custom) account.profileUrl = validateTargetUrl(definition, account.profileUrl);
      if (!account.linkedAccountId) continue;
      const linked = state.linkedAccounts.find((item) => item.id === account.linkedAccountId);
      if (!linked || linked.platformId !== group.id) {
        throw new HttpError(400, `${group.label} 的登录账号不存在或属于其他平台，请重新选择。`);
      }
    }
  }
}

function homepageUrlOrThrow(value) {
  try {
    return normalizeHomepageUrl(value);
  } catch (error) {
    if (error instanceof HomepageDiscoveryError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

function normalizeHomepageAnalysis(value, homepageValue) {
  const homepageUrl = homepageUrlOrThrow(homepageValue);
  if (!homepageUrl || !value || typeof value !== "object") return null;
  const sourceUrl = homepageUrlOrThrow(value.sourceUrl);
  if (sourceUrl !== homepageUrl) return null;
  const scannedAt = Number.isNaN(Date.parse(value.scannedAt)) ? new Date().toISOString() : new Date(value.scannedAt).toISOString();
  return {
    sourceUrl,
    finalUrl: homepageUrlOrThrow(value.finalUrl || sourceUrl),
    title: String(value.title || "").trim().slice(0, 160),
    scannedAt,
    candidateCount: Math.max(0, Math.min(50, Number(value.candidateCount) || 0)),
  };
}

async function pickFolder(initialPath = "") {
  const script = buildFolderPickerScript(initialPath);

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-STA", "-Command", script],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, signal: runtimeAbort.signal },
  );
  return stdout.trim();
}

async function rememberPath(selectedPath) {
  if (!selectedPath) return;
  const state = await loadState();
  const resolved = path.resolve(selectedPath);
  state.recentPaths = [
    resolved,
    ...state.recentPaths.filter((item) => item.toLowerCase() !== resolved.toLowerCase()),
  ].slice(0, 12);
  await saveState(state);
}

async function runWindowsFileAction(action, filePath) {
  if (!new Set(["open", "reveal"]).has(action)) throw new HttpError(400, "不支持的文件操作。 ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_FILE_ACTION_SCRIPT,
        "-Action",
        action,
        "-TargetPath",
        filePath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, signal: runtimeAbort.signal },
    );
    return parseWindowsFileActionOutput(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim();
    console.error(`Windows file action failed (${action}):`, detail);
    if (action === "open") {
      throw new HttpError(500, "Windows 无法使用当前默认关联程序打开该文件，请检查该文件类型的默认应用设置。 ");
    }
    throw new HttpError(500, "Windows 未能打开该文件所在位置。 ");
  }
}

function assertUniquePersonFolder(folderPath, persons, currentId = "") {
  const normalized = path.resolve(folderPath).toLowerCase();
  const other = persons.find((person) => person.id !== currentId
    && path.resolve(person.folderPath).toLowerCase() === normalized);
  if (other) throw new HttpError(409, `该目录已经属于“${other.name}”，请为不同人物选择独立目录。`);
}

async function openConfiguredIndex(person) {
  try {
    return await openPersonMediaIndex(person, { requireExisting: await syncManager.store.personStorageInitialized(person.id) });
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(503, "人物目录当前不可访问，请确认网络共享或磁盘连接后重试。");
    throw error;
  }
}

async function performMediaAction(person, index, mediaId, action) {
  if (!/^[a-f0-9]{64}$/.test(mediaId) || !index.get(mediaId, { includeFingerprint: false })) {
    throw new HttpError(404, "媒体资产记录已不存在，请刷新媒体列表。");
  }
  try {
    return await index.withAssetPath(mediaId, async (filePath) => {
      if (!(await stat(filePath)).isFile()) throw new HttpError(404, "文件已被移动或删除，无法打开。");
      const result = await runWindowsFileAction(action, filePath);
      return { ok: true, action, ...result };
    });
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "文件已被移动或删除，无法打开。");
    throw error;
  }
}

async function classifyPageLogin(platformId, page) {
  await page.waitForTimeout(1000);
  const snapshot = await page.evaluate((currentPlatform) => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const authenticatedSelectors = {
      x: [
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        '[data-testid="SideNav_NewTweet_Button"]',
        'a[href="/compose/post"]',
      ],
      instagram: ['a[href="/direct/inbox/"]', 'a[href="/accounts/edit/"]'],
      threads: ['a[href="/activity"]', 'a[href="/settings"]'],
      facebook: ['a[href*="/me/"]', '[aria-label="Your profile"]'],
      tiktok: ['[data-e2e="profile-icon"]', '[data-e2e="nav-profile"]', 'a[href^="/@"][aria-label]'],
    };
    return {
      url: location.href,
      hasPasswordField: [...document.querySelectorAll('input[type="password"], input[name="pass"]')].some(isVisible),
      hasUsernameField: [...document.querySelectorAll('input[name="username"], input[name="email"][autocomplete="username"]')].some(isVisible),
      hasLoginPrompt: currentPlatform === "tiktok"
        && [...document.querySelectorAll('button[data-e2e*="login"], [data-e2e="top-login-button"], a[href*="/login"]')].some(isVisible),
      hasAuthenticatedMarker: (authenticatedSelectors[currentPlatform] || [])
        .some((selector) => Boolean(document.querySelector(selector))),
    };
  }, platformId);
  return classifyLogin(platformId, snapshot);
}

async function inspectLogin(account, platform) {
  if (platform?.custom) return inspectCustomLogin(platform, account, {
    browserType: { launchPersistentContext: launchVerificationContext },
  });
  if (account.platformId === "tiktok") {
    let session;
    try {
      session = await acquireTikTokPage({ profileDirectory: account.profileDirectory, purpose: "verify" });
      const response = await session.page.goto(PLATFORM_HOME_URLS.tiktok, {
        waitUntil: "domcontentloaded", timeout: 45_000,
      });
      await session.page.waitForTimeout(1200);
      const result = await inspectTikTokPageLogin(session.page, { status: response?.status() || 0 });
      if (result.verified) await session.markHomeWarmupComplete?.();
      return result;
    } catch (error) {
      if (error instanceof TikTokBrowserError || error?.code === "profile-busy") throw new HttpError(error.status || 409, error.message);
      return { verified: false, message: "TikTok 在线登录验证未完成。请在专用窗口确认网络与登录状态后重试；本地 Cookie 不会被当作验证成功。" };
    } finally { await session?.release(); }
  }
  let context;
  try {
    context = await launchVerificationContext(account.profileDirectory, {
      headless: true,
      executablePath: BACKGROUND_CHROMIUM_EXECUTABLE,
      viewport: { width: 1280, height: 800 },
      args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(PLATFORM_HOME_URLS[account.platformId], {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    return await classifyPageLogin(account.platformId, page);
  } catch (error) {
    const message = String(error?.message || error);
    if (/user data directory is already in use|ProcessSingleton|profile.*in use/i.test(message)) {
      throw new HttpError(409, "专用登录窗口仍在运行。请关闭该窗口后再验证登录。 ");
    }
    throw new HttpError(502, "登录验证未完成：无法正常打开平台页面，请检查网络后重试。 ");
  } finally {
    await context?.close().catch(() => {});
  }
}

async function openLocalApp(url) {
  if (runtimeShuttingDown) throw new HttpError(503, "工具正在完整退出，请稍后重新启动。");
  const page = await appShell.open(url);
  if (runtimeShuttingDown || appShell.closing || !appShell.ready || page.isClosed()) throw new HttpError(503, "工具窗口已关闭，尚未确认首次启动成功。");
  await acknowledgeLauncherReady(DATA_DIR);
  return page;
}

async function launchVerificationContext(profile, options) {
  if (runtimeShuttingDown) throw new HttpError(503, "工具正在退出。");
  const context = await chromium.launchPersistentContext(profile, options);
  verificationContexts.add(context);
  context.once("close", () => verificationContexts.delete(context));
  if (runtimeShuttingDown) { await context.close(); throw new HttpError(503, "工具正在退出。"); }
  return context;
}

async function isMediaTrackerRunning(port) {
  return inspectRunningTracker(port, { host: HOST, runtimeId: RUNTIME.id, applicationId: PUBLIC_APPLICATION_ID });
}

function shutdownRuntime(reason = "application-exit", initialExitCode = reason === "window-launch-failed" ? 1 : 0) {
  if (shutdownPromise) return shutdownPromise;
  runtimeShuttingDown = true;
  runtimeAbort.abort();
  console.log(`正在完整退出采集工具（${reason}），取消同步并保存收尾记录。`);
  // Mark the sync scheduler as closing before any await, then release browsers
  // to unblock in-flight readers. Existing state/cache requests are allowed to
  // finish; no new requests or jobs can mutate storage during shutdown.
  const syncDone = syncManager.shutdown({ timeoutMs: 0 });
  const followingDone = followingManager.shutdown();
  const dedupDone = Promise.all([dedupManager.shutdown(), dedupFeature.shutdown()]);
  server.closeIdleConnections?.();
  const windowDone = appShell.close();
  const browserDone = shutdownTikTokSessions();
  const loginDone = loginWindows.close();
  const verificationDone = Promise.allSettled([...verificationContexts].map((context) => context.close()))
    .then((outcomes) => {
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), "登录验证浏览器退出未全部完成。");
    });
  let timer;
  shutdownPromise = (async () => {
    let exitCode = initialExitCode;
    try {
      await Promise.race([
        (async () => {
          const settled = await Promise.allSettled([syncDone, followingDone, dedupDone, windowDone, browserDone, loginDone, verificationDone,
            Promise.allSettled([...activeRequests]), stateMutationQueue]);
          const failed = settled.filter((entry) => entry.status === "rejected");
          for (const entry of settled) if (entry.status === "fulfilled" && entry.value?.errors?.length) {
            for (const detail of entry.value.errors) failed.push({ reason: new Error(`自有浏览器退出未确认：${detail.message || detail.code || "未知错误"}`) });
          }
          if (failed.length) throw new AggregateError(failed.map((entry) => entry.reason), "退出收尾未全部完成。");
          // Keep the listener until normal persistence completes. The final
          // exit coordinator also closes it on rejection/deadline paths.
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("退出收尾超过 45 秒；保留已有媒体和索引，下次启动可重试未完成同步。")), 45_000); }),
      ]);
    } catch (error) {
      exitCode = 1;
      console.error("退出收尾异常：", error.message, ...(error.errors || []).map((item) => item.message));
    } finally {
      clearTimeout(timer);
      await finalizeRuntimeExit({ server, exitCode, releaseGate: releaseStartupGateSync });
    }
  })();
  return shutdownPromise;
}

function tryNextPort(error) {
  if (!['EACCES', 'EADDRINUSE'].includes(error?.code)) return false;
  if (portCandidateIndex >= PORT_CANDIDATES.length - 1) return false;
  const previousPort = PORT;
  portCandidateIndex += 1;
  PORT = PORT_CANDIDATES[portCandidateIndex];
  const reason = error.code === "EACCES" ? "被 Windows 保留或拒绝" : "已被其他程序占用";
  console.warn(`端口 ${previousPort} ${reason}，正在改用 ${PORT}。`);
  server.listen(PORT, HOST);
  return true;
}

async function handleApi(request, response, pathname) {
  const method = request.method || "GET";
  if (method === "GET" && pathname === "/api/session") {
    if (!sessionReady) throw new HttpError(503, "本地服务会话尚在准备，请稍后重试。");
    return sendJson(response, 200, apiSecurity.bootstrap(request, PORT));
  }
  if (!(method === "GET" && pathname === "/api/runtime/status")) apiSecurity.assertAuthenticated(request, PORT);
  if (requiresPublicUseAcknowledgement(method, pathname)) {
    const state = await loadState();
    if (!publicUseStatus(state.settings).acknowledged) {
      const error = new HttpError(428, "首次联网前请阅读并确认公开版使用边界；这不是平台采集许可，未确认不会执行联网操作。");
      error.code = "PUBLIC_USE_ACK_REQUIRED";
      throw error;
    }
  }
  if (pathname === "/api/release-policy" && method === "GET") {
    return sendJson(response, 200, publicUseStatus((await loadState()).settings));
  }
  if (pathname === "/api/release-policy" && method === "POST") {
    const acknowledgement = recordPublicUseAcknowledgement(await readJson(request));
    const state = await loadState();
    state.settings = { ...state.settings, publicReleaseUse: acknowledgement };
    await saveState(state);
    return sendJson(response, 200, publicUseStatus(state.settings));
  }

  if (method === "GET" && pathname === "/api/runtime/status") {
    // A probe is ready only after the protected session file has been saved.
    // The UI may also refresh the non-private system display language here.
    if (!sessionReady) throw new HttpError(503, "本地服务会话尚在准备，请稍后重试。");
    return sendJson(response, 200, { id: RUNTIME.id, applicationId: RUNTIME.applicationId,
      windowLifecycleVersion: RUNTIME.windowLifecycleVersion, instanceKey: RUNTIME.instanceKey,
      release: RELEASE, shuttingDown: runtimeShuttingDown, windowOpen: appShell.ready,
      systemLanguage: systemLanguage.language });
  }
  if (method === "POST" && pathname === "/api/runtime/open-window") {
    const body = await readJson(request);
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw new HttpError(400, "打开工具窗口不接受网址或路径参数。");
    await openLocalApp(`http://${HOST}:${PORT}`);
    return sendJson(response, 200, { ok: true });
  }
  if (method === "POST" && pathname === "/api/runtime/exit") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
      || Object.keys(body).some((key) => key !== "confirm")) throw new HttpError(400, "完整退出需要明确确认。");
    sendJson(response, 202, { ok: true, exiting: true });
    setImmediate(() => { void shutdownRuntime("explicit-exit"); });
    return;
  }

  if (method === "GET" && pathname === "/api/state") {
    const stateStarted = performance.now();
    const state = await loadState();
    const syncSummaries = await syncManager.summaries(state.persons.map((person) => person.id));
    const dedupCapability = await dedupFeature.status();
    sendJson(response, 200, {
      ...state,
      platforms: getPlatformRegistry(state.customPlatforms),
      runtime: { ...RUNTIME, release: RELEASE, systemLanguage: systemLanguage.language, dedupAvailable: dedupCapability.available },
      features: { dedup: dedupCapability },
      releasePolicy: publicUseStatus(state.settings),
      syncConcurrency: "all",
      importFollowingSupportedPlatformIds: followingSupportedPlatformIds(state.customPlatforms),
      syncSummaries,
      dedupStatus: dedupManager.status(),
    });
    if (!firstStateReported) {
      firstStateReported = true;
      startupTiming("interface-data-ready", performance.now() - stateStarted);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/dedup-status") {
    await dedupManager.ready;
    return sendJson(response, 200, dedupManager.status());
  }
  if (method === "GET" && pathname === "/api/features/dedup") {
    assertLocalOrigin(request);
    return sendJson(response, 200, await dedupFeature.status({ inspectTools: true }));
  }
  if (method === "POST" && ["/api/features/dedup/install", "/api/features/dedup/cancel"].includes(pathname)) {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true
      || Object.keys(body).some((key) => key !== "confirmed")) throw new HttpError(400, "组件操作需要明确确认，不接受下载网址、命令或媒体路径。");
    return sendJson(response, 202, pathname.endsWith("/cancel") ? await dedupFeature.cancel(body) : await dedupFeature.startInstall(body));
  }
  if (method === "GET" && pathname === "/api/tools/dedup") {
    assertLocalOrigin(request);
    return sendJson(response, 200, await dedupToolsStatus({ signal: runtimeAbort.signal }));
  }
  if (method === "PUT" && pathname === "/api/tools/dedup") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.directory !== "string"
      || !path.isAbsolute(body.directory.trim()) || /[\0\r\n]/.test(body.directory) || body.directory.length > 4096
      || Object.keys(body).some((key) => key !== "directory")) throw new HttpError(400, "请选择 FFmpeg 和 ffprobe 所在的完整工具目录。");
    const token = syncManager.beginMediaMaintenance();
    try {
      const checked = await dedupFeature.check(dedupFeature.toolsOptions({ directory: body.directory.trim(), signal: runtimeAbort.signal }));
      const state = await loadState();
      state.settings.dedupTools = { directory: portableToolDirectory(checked.directory) };
      await saveState(state);
      dedupFeature.configure(state.settings.dedupTools);
      return sendJson(response, 200, await dedupToolsStatus({ signal: runtimeAbort.signal }));
    } finally { syncManager.endMediaMaintenance(token); }
  }
  if (method === "POST" && pathname === "/api/tools/dedup/install") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true
      || (body.parentDirectory !== undefined && (typeof body.parentDirectory !== "string" || !path.isAbsolute(body.parentDirectory) || /[\0\r\n]/.test(body.parentDirectory) || body.parentDirectory.length > 4096))
      || Object.keys(body).some((key) => !["confirmed", "parentDirectory"].includes(key))) throw new HttpError(400, "组件安装需要明确确认；可选择完整安装父目录，不接受下载网址或命令。");
    const token = syncManager.beginMediaMaintenance();
    try {
      const featureRoot = dedupFeature.root;
      if (dedupFeature.edition === "minimal" && body.parentDirectory !== undefined
        && path.resolve(body.parentDirectory).toLowerCase() !== path.join(featureRoot, "tools").toLowerCase()) {
        throw new HttpError(400, "最小版下载的去重工具仅安装到本软件 tools 目录；已有可信工具可通过指定路径启用。");
      }
      const installed = await installBundledDedupTools({ parentDirectory: body.parentDirectory, signal: runtimeAbort.signal });
      const state = await loadState();
      state.settings.dedupTools = { directory: portableToolDirectory(installed.directory) };
      await saveState(state);
      dedupFeature.configure(state.settings.dedupTools);
      return sendJson(response, 200, await dedupToolsStatus({ signal: runtimeAbort.signal }));
    } finally { syncManager.endMediaMaintenance(token); }
  }
  if (method === "POST" && pathname === "/api/dedup-person") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
      || typeof body.personId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(body.personId)
      || Object.keys(body).some((key) => !["confirm", "personId"].includes(key))) {
      throw new HttpError(400, "单人本地去重需要明确确认并选择采集账号，不接受文件或目录参数。");
    }
    await dedupFeature.checkTools({ signal: runtimeAbort.signal });
    return sendJson(response, 202, await dedupManager.start({ personId: body.personId }));
  }
  if (method === "POST" && pathname === "/api/dedup-close") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
      || typeof body.jobId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.jobId)
      || Object.keys(body).some((key) => !["confirm", "jobId"].includes(key))) throw new HttpError(400, "请选择当前去重结果后关闭，不接受媒体或目录参数。");
    return sendJson(response, 200, await dedupManager.dismiss({ jobId: body.jobId }));
  }
  if (method === "POST" && ["/api/dedup-all", "/api/dedup-cancel"].includes(pathname)) {
    const body = await readJson(request);
    const cancelling = pathname === "/api/dedup-cancel";
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
      || Object.keys(body).some((key) => key !== "confirm" && !(cancelling && key === "closeResults"))
      || (Object.hasOwn(body, "closeResults") && typeof body.closeResults !== "boolean")) throw new HttpError(400, "本地去重操作需要明确确认，不接受文件或目录参数。");
    if (!cancelling) {
      await dedupFeature.checkTools({ signal: runtimeAbort.signal });
      return sendJson(response, 202, await dedupManager.start());
    }
    await dedupManager.ready;
    if (body.closeResults && !dedupManager.running && dedupManager.status().id) {
      return sendJson(response, 202, await dedupManager.dismiss({ jobId: dedupManager.status().id }));
    }
    return sendJson(response, 202, dedupManager.cancel({ closeResults: body.closeResults === true }));
  }
  if (method === "GET" && pathname === "/api/cache/preview") {
    assertLocalOrigin(request);
    if ([...new URL(request.url, `http://${HOST}:${PORT}`).searchParams].length) {
      throw new HttpError(400, "缓存预览不接受自定义文件或目录参数。");
    }
    return sendJson(response, 200, await manualCacheMaintenance.preview());
  }

  if (method === "POST" && pathname === "/api/cache/clean") {
    return sendJson(response, 200, await manualCacheMaintenance.clean(await readJson(request)));
  }

  if (method === "POST" && pathname === "/api/cache/remove-unlinked-profiles") {
    if ([...new URL(request.url, `http://${HOST}:${PORT}`).searchParams].length) {
      throw new HttpError(400, "删除历史资料不接受网址中的文件或目录参数。");
    }
    return sendJson(response, 200, await manualCacheMaintenance.removeUnlinkedProfiles(await readJson(request)));
  }

  if (method === "POST" && pathname === "/api/platforms") {
    const body = await readJson(request);
    const state = await loadState();
    const platform = createCustomPlatform(body, state.customPlatforms);
    state.customPlatforms.push(platform);
    await saveState(state);
    return sendJson(response, 201, { platform, platforms: getPlatformRegistry(state.customPlatforms),
      importFollowingSupportedPlatformIds: followingSupportedPlatformIds(state.customPlatforms) });
  }

  const platformMatch = pathname.match(/^\/api\/platforms\/([^/]+)$/);
  if (method === "PUT" && platformMatch) {
    const body = await readJson(request);
    const state = await loadState();
    const previous = state.customPlatforms.find((item) => item.id === platformMatch[1]);
    if (!previous) throw new HttpError(404, "自定义平台不存在，内置平台不能在此修改。");
    if (state.linkedAccounts.some((account) => account.platformId === previous.id
      && syncManager.activeResourceKeys.has(`login:${account.id}`))) throw new HttpError(409, "该平台正在同步、验证或测试，请等待结束再修改。");
    const platform = updateCustomPlatform(previous, body, state.customPlatforms);
    state.customPlatforms = state.customPlatforms.map((item) => item.id === platform.id ? platform : item);
    const verificationChanged = ["homepageUrl", "loginUrl", "verificationUrl", "loginMarker", "logoutMarker"]
      .some((field) => previous[field] !== platform[field]);
    for (const account of state.linkedAccounts.filter((item) => item.platformId === platform.id)) {
      account.platformLabel = platform.label;
      if (verificationChanged) {
        account.loginStatus = "unverified";
        account.loginCode = "login-rule-changed";
        account.loginMessage = "平台验证规则已更新，请重新验证登录。";
        account.loginCheckedAt = null;
      }
    }
    for (const person of state.persons) person.platforms = normalizePlatforms(person.platforms, getPlatformRegistry(state.customPlatforms));
    await saveState(state);
    return sendJson(response, 200, { platform, platforms: getPlatformRegistry(state.customPlatforms), linkedAccounts: state.linkedAccounts,
      importFollowingSupportedPlatformIds: followingSupportedPlatformIds(state.customPlatforms) });
  }

  const probeMatch = pathname.match(/^\/api\/platforms\/([^/]+)\/probe$/);
  if (method === "POST" && probeMatch) {
    const body = await readJson(request);
    const state = await loadState();
    const platform = platformOrThrow(probeMatch[1], state);
    if (!platform.custom) throw new HttpError(400, "此接口用于自定义平台采集测试。");
    const profileUrl = validateTargetUrl(platform, body.profileUrl);
    const linkedAccount = body.linkedAccountId ? state.linkedAccounts.find((item) => item.id === body.linkedAccountId) : null;
    if (body.linkedAccountId && (!linkedAccount || linkedAccount.platformId !== platform.id)) throw new HttpError(400, "关联登录账号必须属于同一平台。");
    if (linkedAccount && linkedAccount.loginStatus !== "verified") throw new HttpError(409, "请先完成该关联账号的登录验证，再测试目标访问权限。");
    const probe = async () => {
      const { probeCustomMedia } = await import("./lib/custom-sync.mjs");
      return probeCustomMedia({ platform, account: { profileUrl }, linkedAccount,
        signal: AbortSignal.any([runtimeAbort.signal, AbortSignal.timeout(60_000)]) });
    };
    const result = linkedAccount ? await withAccountBrowserUse(linkedAccount, probe) : await probe();
    return sendJson(response, 200, result);
  }

  if (method === "PUT" && pathname === "/api/settings") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length
      || Object.keys(body).some((key) => !["theme", "language"].includes(key))) {
      throw new HttpError(400, "界面设置无效，请选择主题或界面语言。");
    }
    const patch = {};
    if (Object.hasOwn(body, "theme")) {
      const theme = typeof body.theme === "string" ? body.theme.toLowerCase() : "";
      if (!THEMES.has(theme)) throw new HttpError(400, "主题模式无效。 ");
      patch.theme = theme;
    }
    if (Object.hasOwn(body, "language")) {
      const language = typeof body.language === "string" ? body.language.toLowerCase() : "";
      if (!UI_LANGUAGES.has(language)) throw new HttpError(400, "界面语言无效。");
      patch.language = language;
    }
    const state = await loadState();
    state.settings = { ...state.settings, ...patch };
    await saveState(state);
    return sendJson(response, 200, state.settings);
  }

  if (method === "POST" && pathname === "/api/folders/pick") {
    const body = await readJson(request);
    const state = await loadState();
    const initialPath = String(body.initialPath || state.recentPaths[0] || "");
    const selectedPath = await pickFolder(initialPath);
    if (selectedPath) await rememberPath(selectedPath);
    return sendJson(response, 200, { selectedPath });
  }

  if (method === "POST" && pathname === "/api/homepages/analyze") {
    const body = await readJson(request);
    try {
      return sendJson(response, 200, await analyzeHomepage(body.url, { signal: runtimeAbort.signal }));
    } catch (error) {
      if (error instanceof HomepageDiscoveryError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  if (pathname === "/api/following-imports" && method === "POST") {
    if ([...new URL(request.url, `http://${HOST}:${PORT}`).searchParams].length) {
      throw new HttpError(400, "读取已关注列表只接受已绑定账号，不接受网址参数。");
    }
    return sendJson(response, 202, { job: await followingManager.start(await readJson(request)) });
  }
  const followingMatch = pathname.match(/^\/api\/following-imports\/([^/]+)$/);
  if (followingMatch && ["GET", "DELETE"].includes(method)) {
    assertLocalOrigin(request);
    if ([...new URL(request.url, `http://${HOST}:${PORT}`).searchParams].length) {
      throw new HttpError(400, "读取结果不接受网址、文件或登录资料参数。");
    }
    if (method === "DELETE") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
        throw new HttpError(400, "停止读取不接受额外参数。");
      }
      return sendJson(response, 200, { job: followingManager.cancel(followingMatch[1]) });
    }
    return sendJson(response, 200, { job: followingManager.get(followingMatch[1]) });
  }

  if (method === "POST" && pathname === "/api/linked-accounts") {
    const body = await readJson(request);
    const state = await loadState();
    const platform = platformOrThrow(body.platformId, state);
    const label = String(body.label || "").trim();
    if (!label) throw new HttpError(400, "请填写你的账号名称。 ");

    const account = {
      id: crypto.randomUUID(),
      platformId: String(body.platformId).toLowerCase(),
      platformLabel: platform.label,
      label,
      browserId: RUNTIME.id,
      browserLabel: RUNTIME.label,
      profileDirectory: path.join(PROFILE_DIR, String(body.platformId).toLowerCase(), crypto.randomUUID()),
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
      loginStatus: "unverified",
      loginCheckedAt: null,
      loginMessage: "尚未验证登录。",
    };
    state.linkedAccounts.push(account);
    await saveState(state);
    return sendJson(response, 201, account);
  }

  const linkedAccountMatch = pathname.match(/^\/api\/linked-accounts\/([^/]+)$/);
  if (linkedAccountMatch && method === "PUT") {
    const body = await readJson(request);
    const state = await loadState();
    const account = state.linkedAccounts.find((item) => item.id === linkedAccountMatch[1]);
    if (!account) throw new HttpError(404, "关联账号不存在。 ");
    const platform = platformOrThrow(body.platformId || account.platformId, state);
    if (body.platformId && body.platformId !== account.platformId) throw new HttpError(400, "不能将已有登录资料改绑其他平台；请新建关联账号。");
    const label = String(body.label ?? account.label).trim();
    if (!label) throw new HttpError(400, "请填写你的账号名称。 ");
    account.platformId = String(body.platformId || account.platformId).toLowerCase();
    account.platformLabel = platform.label;
    account.label = label;
    await saveState(state);
    return sendJson(response, 200, account);
  }

  if (linkedAccountMatch && method === "DELETE") {
    const state = await loadState();
    const originalLength = state.linkedAccounts.length;
    state.linkedAccounts = state.linkedAccounts.filter((item) => item.id !== linkedAccountMatch[1]);
    if (state.linkedAccounts.length === originalLength) throw new HttpError(404, "关联账号不存在。 ");
    followingManager.cancelForAccount(linkedAccountMatch[1]);
    for (const person of state.persons) {
      for (const platform of person.platforms || []) {
        for (const account of platform.accounts || []) {
          if (account.linkedAccountId === linkedAccountMatch[1]) account.linkedAccountId = "";
        }
      }
    }
    await saveState(state);
    return sendJson(response, 200, { ok: true });
  }

  const openLoginMatch = pathname.match(/^\/api\/linked-accounts\/([^/]+)\/open-login$/);
  if (openLoginMatch && method === "POST") {
    const state = await loadState();
    const account = state.linkedAccounts.find((item) => item.id === openLoginMatch[1]);
    if (!account) throw new HttpError(404, "关联账号不存在。 ");
    const platform = platformOrThrow(account.platformId, state);
    return withAccountBrowserUse(account, async () => {
      if (platform.custom) await assertCustomPublicUrl(platform.loginUrl);
      await mkdir(account.profileDirectory, { recursive: true });
      if (account.platformId === "tiktok") {
        const result = await openTikTokLoginWindow(account.profileDirectory);
        account.lastOpenedAt = new Date().toISOString();
        account.loginStatus = "pending";
        account.loginMessage = result.message;
        await saveState(state);
        return sendJson(response, 200, { ok: true, lastOpenedAt: account.lastOpenedAt,
          loginStatus: account.loginStatus, loginMessage: account.loginMessage });
      }
      await launchInteractivePage(account.profileDirectory, platform.loginUrl);
      account.lastOpenedAt = new Date().toISOString();
      account.loginStatus = "pending";
      account.loginMessage = "独立登录窗口已打开。完成登录后请关闭该窗口，再返回工具验证登录。";
      await saveState(state);
      return sendJson(response, 200, {
        ok: true,
        lastOpenedAt: account.lastOpenedAt,
        loginStatus: account.loginStatus,
        loginMessage: account.loginMessage,
      });
    });
  }

  const openTargetMatch = pathname.match(/^\/api\/linked-accounts\/([^/]+)\/open-target$/);
  if (openTargetMatch && method === "POST") {
    const body = await readJson(request);
    const state = await loadState();
    const account = state.linkedAccounts.find((item) => item.id === openTargetMatch[1]);
    if (!account) throw new HttpError(404, "关联账号不存在。");
    const platform = platformOrThrow(account.platformId, state);
    if (!platform.custom) throw new HttpError(400, "此入口用于自定义平台的专用会话。");
    const url = validateTargetUrl(platform, body.profileUrl);
    await assertCustomPublicUrl(url);
    return withAccountBrowserUse(account, async () => {
      await mkdir(account.profileDirectory, { recursive: true });
      await launchInteractivePage(account.profileDirectory, url);
      account.lastOpenedAt = new Date().toISOString();
      await saveState(state);
      return sendJson(response, 200, { ok: true, message: "已使用这个关联账号的专用会话打开目标主页。请自行关注或申请访问，关闭窗口后重新验证登录并测试采集。" });
    });
  }

  const verifyLoginMatch = pathname.match(/^\/api\/linked-accounts\/([^/]+)\/verify-login$/);
  if (verifyLoginMatch && method === "POST") {
    const state = await loadState();
    const account = state.linkedAccounts.find((item) => item.id === verifyLoginMatch[1]);
    if (!account) throw new HttpError(404, "关联账号不存在。 ");
    const platform = platformOrThrow(account.platformId, state);
    const result = await withAccountBrowserUse(account, () => inspectLogin(account, platform));
    account.loginStatus = result.verified ? "verified" : "failed";
    account.loginCode = result.code || (result.verified ? "verified" : "login-unverified");
    account.loginCheckedAt = new Date().toISOString();
    account.loginMessage = result.message;
    if (account.platformId === "tiktok") {
      account.loginVerificationVersion = 2;
      account.verifiedUsername = result.verified ? result.username : null;
    }
    await saveState(state);
    return sendJson(response, 200, {
      verified: result.verified,
      loginStatus: account.loginStatus,
      loginCode: account.loginCode,
      loginCheckedAt: account.loginCheckedAt,
      loginMessage: account.loginMessage,
    });
  }

  if (method === "POST" && pathname === "/api/persons") {
    if (syncManager.mediaMaintenanceToken) throw new HttpError(409, "本地去重正在进行，请等待完成或停止后再新建人物。");
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    if (!name) throw new HttpError(400, "请填写人物名称。 ");
    const definitionState = await loadState();
    const platforms = normalizePlatforms(body.platforms, getPlatformRegistry(definitionState.customPlatforms));
    validatePersonAccounts(platforms, definitionState);
    const folderPath = resolvePersonFolder({
      name,
      folderMode: body.folderMode,
      selectedPath: body.selectedPath,
    });
    assertUniquePersonFolder(folderPath, definitionState.persons);
    if (body.folderMode === "new" && await pathExists(folderPath)) {
      throw new HttpError(409, "同名人物文件夹已经存在。请选择“使用现有文件夹”，或更换人物名称。 ");
    }

    await createArchiveDirectories(folderPath, platforms);
    await rememberPath(body.folderMode === "new" ? String(body.selectedPath) : folderPath);
    const state = await loadState();
    const person = {
      id: crypto.randomUUID(),
      name,
      note: String(body.note || "").trim(),
      homepageUrl: homepageUrlOrThrow(body.homepageUrl),
      homepageAnalysis: normalizeHomepageAnalysis(body.homepageAnalysis, body.homepageUrl),
      folderPath,
      platforms,
      includeSensitive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await openPersonMediaIndex(person, { create: true });
    state.persons.push(person);
    await saveState(state);
    return sendJson(response, 201, person);
  }

  if (method === "POST" && pathname === "/api/sync-all") {
    const state = await loadState();
    if (state.persons.length === 0) throw new HttpError(409, "请先新建至少一个人物。 ");

    const results = [];
    for (const person of state.persons) results.push(await syncManager.start(person.id));
    const jobs = results.map((result) => result.job);
    const startedCount = results.filter((result) => !result.existing).length;
    return sendJson(response, startedCount ? 202 : 200, {
      personCount: state.persons.length,
      startedCount,
      existingCount: results.length - startedCount,
      concurrency: "all",
      jobs,
    });
  }

  const personPostMatch = pathname.match(/^\/api\/persons\/([^/]+)\/open-post$/);
  if (personPostMatch && method === "POST") {
    const state = await loadState();
    await syncManager.store.ready;
    const resolved = await resolveBoundPost({ state, personId: personPostMatch[1], body: await readJson(request),
      scopes: syncManager.store.index.scopes, openMediaIndex: openConfiguredIndex, profilesRoot: PROFILE_DIR });
    await assertBoundProfile({ ...resolved, profilesRoot: PROFILE_DIR });
    if (resolved.platform.custom) await assertCustomPublicUrl(resolved.url);
    return withAccountBrowserUse(resolved.linked, async () => {
      const open = async () => {
        let running;
        try { running = await profileBrowserIsRunning(resolved.profile); }
        catch { throw new HttpError(503, "暂时无法确认绑定登录窗口是否空闲，请稍后重试；不会退回未登录窗口。"); }
        if (running) throw new HttpError(409, "这份登录资料的窗口已打开，请关闭该窗口后再查看原帖；不会退回未登录窗口。");
        const window = await launchInteractivePage(resolved.profile, resolved.url);
        sendJson(response, 200, { ok: true, message: "已使用绑定账号打开原帖。请关闭原帖窗口后再同步该平台。" });
        // The HTTP response has finished, but the profile lease remains held
        // until this exact owned window exits. Other profiles stay runnable.
        await window.closed;
      };
      if (resolved.platform.id !== "tiktok") return open();
      const result = await withIdleTikTokProfile(resolved.profile, open);
      if (result?.status === "skipped") throw new HttpError(409, "TikTok 登录资料正在使用，请等待结束后查看原帖。");
    });
  }

  const personRecheckMatch = pathname.match(/^\/api\/persons\/([^/]+)\/recheck$/);
  if (personRecheckMatch && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
      || Object.keys(body).some((key) => key !== "confirm")) {
      throw new HttpError(400, "历史补齐需要明确确认，不接受文件、目录或同步边界参数。");
    }
    const state = await loadState();
    const person = state.persons.find((item) => item.id === personRecheckMatch[1]);
    if (!person) throw new HttpError(404, "采集账号不存在，请刷新列表后重试。");
    const result = await syncManager.start(person.id, { forceHistory: true });
    return sendJson(response, result.existing ? 200 : 202, result.job);
  }

  const personSyncMatch = pathname.match(/^\/api\/persons\/([^/]+)\/sync$/);
  if (personSyncMatch && method === "POST") {
    const state = await loadState();
    if (!state.persons.some((person) => person.id === personSyncMatch[1])) {
      throw new HttpError(404, "人物不存在。 ");
    }
    const result = await syncManager.start(personSyncMatch[1]);
    return sendJson(response, result.existing ? 200 : 202, result.job);
  }

  const personFolderMatch = pathname.match(/^\/api\/persons\/([^/]+)\/open-folder$/);
  if (personFolderMatch && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw new HttpError(400, "查看文件只接受人物记录，不接受自定义路径。");
    }
    const state = await loadState();
    const person = state.persons.find((item) => item.id === personFolderMatch[1]);
    if (!person) throw new HttpError(404, "人物不存在。");
    return sendJson(response, 200, await openPersonFolder(person, { signal: runtimeAbort.signal }));
  }

  const newFilesMatch = pathname.match(/^\/api\/persons\/([^/]+)\/new-files$/);
  if (newFilesMatch && method === "GET") {
    const state = await loadState();
    if (!state.persons.some((person) => person.id === newFilesMatch[1])) {
      throw new HttpError(404, "人物不存在。 ");
    }
    return sendJson(response, 200, await syncManager.receipt(newFilesMatch[1]));
  }

  const mediaListMatch = pathname.match(/^\/api\/persons\/([^/]+)\/media$/);
  if (mediaListMatch && method === "GET") {
    const state = await loadState();
    const person = state.persons.find((item) => item.id === mediaListMatch[1]);
    if (!person) throw new HttpError(404, "人物不存在。");
    const index = await openConfiguredIndex(person);
    const params = new URL(request.url, `http://${HOST}:${PORT}`).searchParams;
    const offset = Number(params.get("offset") || 0);
    const limit = Number(params.get("limit") || 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new HttpError(400, "分页参数无效，每页数量应在 1 到 200 之间。");
    }
    return sendJson(response, 200, index.list({ query: (params.get("query") || "").slice(0, 256), offset, limit }));
  }

  const mediaActionMatch = pathname.match(/^\/api\/persons\/([^/]+)\/media\/([^/]+)\/(sources|open|reveal)$/);
  if (mediaActionMatch && ((mediaActionMatch[3] === "sources" && method === "GET")
    || (["open", "reveal"].includes(mediaActionMatch[3]) && method === "POST"))) {
    const state = await loadState();
    const person = state.persons.find((item) => item.id === mediaActionMatch[1]);
    if (!person) throw new HttpError(404, "人物不存在。");
    const mediaId = mediaActionMatch[2];
    const index = await openConfiguredIndex(person);
    if (!/^[a-f0-9]{64}$/.test(mediaId) || !index.get(mediaId, { includeFingerprint: false })) throw new HttpError(404, "媒体资产记录已不存在。");
    if (mediaActionMatch[3] === "sources") {
      return sendJson(response, 200, { mediaId, sources: index.sources(mediaId).map((source) => ({ ...source,
        sourceKey: JSON.stringify([source.platformId, source.accountId, source.logicalKey]) })) });
    }
    return sendJson(response, 200, await performMediaAction(person, index, mediaId, mediaActionMatch[3]));
  }

  const fileActionMatch = pathname.match(/^\/api\/persons\/([^/]+)\/(open|reveal)-new-file$/);
  if (fileActionMatch && method === "POST") {
    const action = fileActionMatch[2];
    const body = await readJson(request);
    const state = await loadState();
    const person = state.persons.find((item) => item.id === fileActionMatch[1]);
    if (!person) throw new HttpError(404, "人物不存在。 ");
    const receiptFile = await syncManager.receiptFile(person.id, String(body.fileId || ""));
    if (!receiptFile) throw new HttpError(404, "这条新增文件记录已不存在，请刷新同步回执。 ");

    const index = await openConfiguredIndex(person);
    try {
      resolveReceiptFile(person, receiptFile, index);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    return sendJson(response, 200, await performMediaAction(person, index, receiptFile.mediaId, action));
  }

  const syncJobMatch = pathname.match(/^\/api\/sync-jobs\/([^/]+)$/);
  if (syncJobMatch && method === "GET") {
    const job = syncManager.get(syncJobMatch[1]);
    if (!job) throw new HttpError(404, "同步任务不存在或本地服务已重新启动。 ");
    return sendJson(response, 200, job);
  }

  const cancelSyncMatch = pathname.match(/^\/api\/sync-jobs\/([^/]+)\/cancel$/);
  if (cancelSyncMatch && method === "POST") {
    const job = syncManager.cancel(cancelSyncMatch[1]);
    if (!job) throw new HttpError(404, "同步任务不存在或本地服务已重新启动。 ");
    return sendJson(response, 200, job);
  }

  const personMatch = pathname.match(/^\/api\/persons\/([^/]+)$/);
  if (personMatch && method === "DELETE") {
    const body = await readJson(request);
    if (typeof body.deleteFiles !== "boolean") {
      throw new HttpError(400, "请明确选择是否保留已同步内容，尚未删除人物。");
    }
    const result = await syncManager.withPersonDeletion(personMatch[1], async () => {
      const state = await loadState();
      const person = state.persons.find((item) => item.id === personMatch[1]);
      if (!person) throw new HttpError(404, "人物不存在。");
      if (body.deleteFiles && body.expectedFolderPath !== person.folderPath) {
        throw new HttpError(409, "人物文件夹已改变或尚未确认路径，请刷新页面后重新选择删除。");
      }
      const removed = body.deleteFiles
        ? await deletePersonDirectory({ personId: person.id, persons: state.persons, projectRoot: ROOT, dataRoot: DATA_DIR })
        : { filesDeleted: false, folderMissing: false };
      state.persons = state.persons.filter((item) => item.id !== person.id);
      await saveState(state);
      await syncManager.removePersonData(person.id);
      clearPersonMediaIndexCache(person.id);
      return { ok: true, personId: person.id, keptFiles: !body.deleteFiles, ...removed };
    });
    return sendJson(response, 200, result);
  }

  if (personMatch && method === "PUT") {
    if (syncManager.mediaMaintenanceToken) throw new HttpError(409, "本地去重正在进行，请等待完成或停止后再修改人物。");
    const body = await readJson(request);
    const state = await loadState();
    const person = state.persons.find((item) => item.id === personMatch[1]);
    if (!person) throw new HttpError(404, "人物不存在。 ");

    const name = String(body.name || "").trim();
    if (!name) throw new HttpError(400, "请填写人物名称。 ");
    const platforms = normalizePlatforms(body.platforms, getPlatformRegistry(state.customPlatforms));
    validatePersonAccounts(platforms, state);
    const folderPath = body.selectedPath
      ? resolvePersonFolder({ name, folderMode: "existing", selectedPath: body.selectedPath })
      : person.folderPath;
    if (path.resolve(folderPath).toLowerCase() !== path.resolve(person.folderPath).toLowerCase()
      && syncManager.isPersonBusy(person.id)) {
      throw new HttpError(409, "人物正在同步，请停止同步并等待结束后再修改存储位置。");
    }
    assertUniquePersonFolder(folderPath, state.persons, person.id);
    const initialized = await syncManager.store.personStorageInitialized(person.id);
    if (!initialized) await createArchiveDirectories(folderPath, platforms);
    await openPersonMediaIndex({ ...person, folderPath }, { create: !initialized, requireExisting: initialized });
    person.name = name;
    person.note = String(body.note || "").trim();
    person.homepageUrl = homepageUrlOrThrow(body.homepageUrl);
    person.homepageAnalysis = normalizeHomepageAnalysis(body.homepageAnalysis, body.homepageUrl);
    person.folderPath = folderPath;
    person.platforms = platforms;
    person.includeSensitive = true;
    person.updatedAt = new Date().toISOString();
    await saveState(state);
    await rememberPath(folderPath);
    return sendJson(response, 200, person);
  }

  throw new HttpError(404, "接口不存在。 ");
}

const server = http.createServer(async (request, response) => {
  let finishRequest;
  const requestDone = new Promise((resolve) => { finishRequest = resolve; });
  activeRequests.add(requestDone);
  try {
    apiSecurity.assertLocalRequest(request, PORT);
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    if (runtimeShuttingDown && !(request.method === "GET" && url.pathname === "/api/runtime/status")) {
      throw new HttpError(503, "工具正在完整退出，请稍后重新启动。");
    }
    if (url.pathname.startsWith("/api/")) {
      if (modifiesState(request, url.pathname)) {
        await runStateMutation(() => handleApi(request, response, url.pathname));
      } else {
        await handleApi(request, response, url.pathname);
      }
    } else {
      await serveStatic(url.pathname, response);
    }
  } catch (error) {
    const status = error instanceof HttpError || error instanceof PersonDeletionError ? error.status
      : ([400, 403, 404, 409, 422, 428, 429, 503].includes(error.status) ? error.status : 500);
    if (status === 500) console.error(error);
    if (!response.destroyed && !response.writableEnded) sendJson(response, status, { error: error?.message || "本地服务发生错误。 ",
      ...(["PUBLIC_USE_ACK_REQUIRED", "local-session-required"].includes(error.code) ? { code: error.code } : {}) });
  } finally { activeRequests.delete(requestDone); finishRequest(); }
});

server.on("error", async (error) => {
  if (error?.code === "EADDRINUSE") {
    const running = await isMediaTrackerRunning(PORT);
    if (running && (!running.instanceKey || running.instanceKey === RUNTIME.instanceKey)) {
      try {
        await forwardToRunningTracker(PORT, running);
        await shutdownRuntime("repeat-launch-forwarded", 0);
      } catch (forwardError) {
        console.error(forwardError.message);
        await shutdownRuntime("repeat-launch-forward-failed", 1);
      }
      return;
    }
    if (tryNextPort(error)) return;
  }
  if (error?.code === "EACCES" && tryNextPort(error)) return;
  console.error(`Media Tracker 无法监听 ${HOST}:${PORT}：${error?.code || error?.message || error}`);
  await shutdownRuntime("listen-failed", 1);
});

server.listen(PORT, HOST, async () => {
  try {
    await writeLocalSession(DATA_DIR, { version: 1, applicationId: PUBLIC_APPLICATION_ID,
      instanceKey: RUNTIME.instanceKey, token: apiSecurity.token, port: PORT, pid: process.pid });
    sessionReady = true;
  } catch {
    console.error("无法安全建立本地服务会话，已停止本次启动；媒体和登录资料未改动。");
    void shutdownRuntime("session-protection-failed", 1);
    return;
  }
  releaseStartupGateSync();
  const url = `http://${HOST}:${PORT}`;
  console.log(`Media Tracker 已启动：${url}`);
  startupTiming("service-listening");
  console.log(process.env.MEDIA_TRACKER_BACKGROUND_START === "1"
    ? "关闭采集工具主窗口会完整退出后台服务；重复启动只唤起已有窗口。"
    : "关闭此窗口即可停止本地服务。 ");
  if (process.env.MEDIA_TRACKER_NO_OPEN !== "1") openLocalApp(url).catch((error) => {
    console.error("工具窗口未能启动：", error.message);
    void shutdownRuntime("window-launch-failed");
  });
});

process.on("SIGINT", () => { void shutdownRuntime("SIGINT"); });
process.on("SIGTERM", () => { void shutdownRuntime("SIGTERM"); });
}
