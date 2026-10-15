import path from "node:path";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { normalizePublicationDate, validPublicationDate } from "./publication-date.mjs";
import { resolvePortableDataDirectory, resolveSourcePython } from "./portable-paths.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = resolvePortableDataDirectory(ROOT).dataDirectory;
const PYTHON = resolveSourcePython(ROOT);
const WORKER = path.join(ROOT, "scripts", "media-source-worker.py");
const MAX_WORKER_INPUT_BYTES = 12 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const SESSION_INSTANCE_ID = randomUUID();
const ACTIVE_SESSION_DIRECTORIES = new Set();
const OWNED_SESSION_NAME = /^mt-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_MARKER = "owned-session.json";
let ownerSidPromise;
const SAME_HOST = (left, right) => left.toLowerCase().replace(/^www\./, "") === right.toLowerCase().replace(/^www\./, "");
const IMAGE_MIME = /^image\/(?:jpe?g|png|gif|webp|avif|bmp|tiff)$/i;
const MESSAGES = {
  "engine-unavailable": "通用采集引擎尚未安装，请先运行 scripts\\setup-source-engines.cmd。",
  "public-engine-not-integrated": "公开发行版未集成 gallery-dl，也不会自动下载或替换该引擎。此平台资料已保留，请改用 yt-dlp 或仅登记信息；内置平台的同步不受影响。",
  "unsupported-engine": "该自定义平台仅登记信息，尚未启用可用的采集引擎。",
  "unsupported-url": "现有通用引擎不支持这个主页链接；可保存平台信息，但不能将其标记为同步成功。",
  "unsupported-media": "发现的媒体暂不能直接保存；当前通用模式支持图片和完整 MP4，不支持 HLS/DASH 或需合并音视频的格式。",
  "no-verifiable-media": "未能识别可验证的媒体，不能据此确认账号为空或历史同步完成。请检查目标链接及登录权限。",
  "read-only-method-required": "该网站提取过程需要额外的 POST 请求，当前只读通用模式未执行，请等待网站规则适配。",
  "external-helper-required": "该网站需要额外的执行组件，当前通用模式未启用该能力。",
  "engine-request-failed": "通用引擎未能读取该网站，可能需要重新登录、人工验证码或网站规则更新；未将本次标记为成功。",
  "metadata-timeout": "通用采集读取超时，请检查网络或缩小目标范围。",
  "metadata-too-large": "通用采集返回的数据超过本次安全上限，已停止读取。",
  "unsafe-url": "目标地址或跳转不是允许的公网 HTTPS 地址，已阻止访问。",
  "target-domain-mismatch": "目标账号链接必须属于已配置平台的主站域名。",
  "profile-busy": "该平台独立登录窗口仍在使用，请先关闭登录窗口后再同步。",
  "profile-invalid": "关联账号的独立资料目录无效，未读取登录数据。",
  "login-unverified": "请先验证此平台关联账号的登录状态，再读取需要登录或关注权限的内容。",
  "extractor-incomplete": "通用引擎未能完整读取该主页，请检查登录权限后重试。",
  "external-embed-unsupported": "该页面嵌入了另一网站的内容，需要将内容链接添加到对应平台后检测。",
  "redirect-limit": "网站跳转次数过多，已停止请求。",
  "media-too-large": "该媒体超过通用下载的大小上限，已停止请求。",
  "unexpected-media-content": "媒体地址返回的不是所需图片或 MP4，请检查登录权限或访问验证。",
};

export class CustomDiscoveryError extends Error {
  constructor(code) {
    super(MESSAGES[code] || "通用采集失败，请检查目标链接及登录权限后重试。");
    this.code = code;
    this.status = code === "engine-unavailable" ? 503 : ["profile-busy", "login-unverified"].includes(code) ? 409
      : ["unsafe-url", "target-domain-mismatch", "profile-invalid"].includes(code) ? 400 : 422;
  }
}

function abortError(signal) {
  return signal?.reason?.name === "TimeoutError" ? new DOMException("通用采集请求超时。", "TimeoutError") : new DOMException("同步已取消。", "AbortError");
}

export function publicSourceAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
    return /^[23][0-9a-f]{3}:/.test(normalized) && !(normalized.startsWith("2001:") && (second < 0x200 || second === 0xdb8))
      && !normalized.startsWith("2002:") && !normalized.includes("%");
  }
  return false;
}

export function sourceUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || hostname.endsWith(".") || /(?:^|\.)localhost$/i.test(hostname) || (net.isIP(hostname) && !publicSourceAddress(hostname))) throw new Error();
    return url;
  } catch { throw new CustomDiscoveryError("unsafe-url"); }
}

function targetUrl(platform, account) {
  if (platform?.engine === "gallery-dl") throw new CustomDiscoveryError("public-engine-not-integrated");
  if (!platform?.custom || !/^custom-[a-z0-9-]+$/i.test(platform.id || "") || !["auto", "yt-dlp"].includes(platform.engine)) {
    throw new CustomDiscoveryError("unsupported-engine");
  }
  const home = sourceUrl(platform.homepageUrl);
  const target = sourceUrl(account?.profileUrl);
  if (!SAME_HOST(home.hostname, target.hostname)) throw new CustomDiscoveryError("target-domain-mismatch");
  return target.href;
}

async function currentOwnerSid() {
  ownerSidPromise ||= execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true, timeout: 10000 })
    .then(({ stdout }) => {
      const sid = stdout.trim();
      if (!/^S-1-5-\d+(?:-\d+)+$/.test(sid)) throw new CustomDiscoveryError("profile-invalid");
      return sid;
    });
  return ownerSidPromise;
}

async function secureDirectory(directory) {
  if (process.platform === "win32") {
    const sid = await currentOwnerSid();
    await execFileAsync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 10000 });
  } else await chmod(directory, 0o700);
}

async function checkedDirectoryChain(directory) {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new CustomDiscoveryError("profile-invalid");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function hasPrivateSessionPermissions(directory) {
  if (process.platform !== "win32") {
    const info = await lstat(directory);
    return info.uid === process.getuid() && (info.mode & 0o077) === 0;
  }
  const sid = await currentOwnerSid();
  // Encode the exact path as data; never interpolate an unescaped path into
  // PowerShell code. This read-only ACL check cannot change any permissions.
  const encoded = Buffer.from(directory, "utf8").toString("base64");
  const command = `$ErrorActionPreference='Stop'; $taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); `
    + "$taskAcl=[IO.Directory]::GetAccessControl($taskPath); "
    + "$taskOwner=$taskAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value; "
    + "$taskRules=@($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | "
    + "Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } | "
    + "ForEach-Object { $_.IdentityReference.Value }); "
    + "@{owner=$taskOwner; protected=$taskAcl.AreAccessRulesProtected; allowed=$taskRules} | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 10000 });
  const acl = JSON.parse(stdout);
  const allowed = Array.isArray(acl.allowed) ? acl.allowed : [acl.allowed];
  return acl.owner === sid && acl.protected === true && allowed.length > 0 && allowed.every((identity) => identity === sid);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Best-effort credential reaper, not a profile/cache cleaner. Only dead-owner
// sessions created by this installation with its marker and private ACL can
// be removed. No recursive deletion, legacy session-* guessing, or symlinks.
export async function cleanupStaleCustomSessions({ dataRoot = DATA_ROOT, processAlive = isProcessAlive } = {}) {
  const parent = path.join(path.resolve(dataRoot), "source-sessions");
  const summary = { removed: 0, retained: 0, unmanaged: 0, retainedReasons: [] };
  await checkedDirectoryChain(path.resolve(dataRoot));
  try { await checkedDirectoryChain(parent); }
  catch (error) { if (error.code === "ENOENT") return summary; throw error; }
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!OWNED_SESSION_NAME.test(entry.name)) { summary.unmanaged++; continue; }
    const directory = path.join(parent, entry.name);
    if (ACTIVE_SESSION_DIRECTORIES.has(directory)) { summary.retained++; continue; }
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("not-owned-directory");
      await checkedDirectoryChain(directory);
      if (!await hasPrivateSessionPermissions(directory)) throw new Error("not-private-directory");
      const contents = await readdir(directory, { withFileTypes: true });
      if (!contents.some((item) => item.name === SESSION_MARKER)
        || contents.some((item) => ![SESSION_MARKER, "cookies.txt"].includes(item.name) || !item.isFile() || item.isSymbolicLink())) throw new Error("not-owned-contents");
      const markerFile = path.join(directory, SESSION_MARKER);
      const markerInfo = await lstat(markerFile);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) throw new Error("invalid-marker");
      const marker = JSON.parse(await readFile(markerFile, "utf8"));
      if (marker.schemaVersion !== 1 || marker.kind !== "media-tracker-custom-session" || marker.directoryName !== entry.name
        || marker.installationRoot !== ROOT || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || marker.pid > 2147483647
        || typeof marker.instanceId !== "string" || !/^[a-f0-9-]{36}$/i.test(marker.instanceId)
        || !Number.isFinite(Date.parse(marker.createdAt))) throw new Error("foreign-marker");
      if (processAlive(marker.pid)) { summary.retained++; continue; }
      // Recheck the directory before touching only these two owned files.
      await checkedDirectoryChain(directory);
      await rm(path.join(directory, "cookies.txt"), { force: true });
      await rm(markerFile);
      await rmdir(directory);
      summary.removed++;
    } catch (error) {
      summary.retained++;
      const reasons = ["not-owned-directory", "not-private-directory", "not-owned-contents", "invalid-marker", "foreign-marker"];
      const reason = reasons.includes(error.message) ? error.message : "cleanup-check-failed";
      if (!summary.retainedReasons.includes(reason)) summary.retainedReasons.push(reason);
    }
  }
  return summary;
}

function cookieForUrl(cookie, url) {
  const rawDomain = String(cookie.domain || "").toLowerCase();
  const domain = rawDomain.replace(/^\./, "");
  const cookiePath = cookie.path || "/";
  return (url.hostname === domain || (rawDomain.startsWith(".") && url.hostname.endsWith(`.${domain}`)))
    && (url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`))
    && (!cookie.secure || url.protocol === "https:") && (!cookie.expires || cookie.expires < 0 || cookie.expires > Date.now() / 1000);
}

export async function exportCustomSession({ platform, linkedAccount, signal, dataRoot = DATA_ROOT,
  launchContext = (profile, options) => chromium.launchPersistentContext(profile, options) }) {
  if (!linkedAccount) return { cookies: [], cookieFile: null, dispose: async () => {} };
  if (linkedAccount.platformId !== platform.id || linkedAccount.loginStatus !== "verified") throw new CustomDiscoveryError("login-unverified");
  const profile = path.resolve(linkedAccount.profileDirectory || "");
  const allowed = path.join(dataRoot, "browser-profiles", platform.id);
  if (path.dirname(profile).toLowerCase() !== allowed.toLowerCase() || !/^[a-z0-9-]+$/i.test(path.basename(profile))) throw new CustomDiscoveryError("profile-invalid");
  await checkedDirectoryChain(profile);
  if (signal?.aborted) throw abortError(signal);
  let context;
  let directory;
  const dispose = async () => {
    if (directory) {
      const exact = directory; directory = null;
      await checkedDirectoryChain(exact);
      await rm(path.join(exact, "cookies.txt"), { force: true });
      await rm(path.join(exact, SESSION_MARKER), { force: true });
      await rmdir(exact).catch(() => {});
      ACTIVE_SESSION_DIRECTORIES.delete(exact);
    }
  };
  try {
    context = await launchContext(profile, { headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE, args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"] });
    if (signal?.aborted) throw abortError(signal);
    const stop = () => { void context.close().catch(() => {}); };
    signal?.addEventListener("abort", stop, { once: true });
    let cookies;
    try {
      if (signal?.aborted) throw abortError(signal);
      const home = sourceUrl(platform.homepageUrl);
      cookies = (await context.cookies()).filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "");
        return SAME_HOST(domain, home.hostname) && !/[\r\n\t]/.test(`${cookie.name}${cookie.value}${cookie.path}${cookie.domain}`);
      });
    } finally {
      signal?.removeEventListener("abort", stop);
      await context.close(); context = null;
    }
    if (signal?.aborted) throw abortError(signal);
    const parent = path.join(dataRoot, "source-sessions");
    await checkedDirectoryChain(dataRoot);
    try { await checkedDirectoryChain(parent); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(parent, { recursive: true });
    await checkedDirectoryChain(parent);
    await cleanupStaleCustomSessions({ dataRoot });
    directory = path.join(parent, `mt-session-${randomUUID()}`);
    await mkdir(directory);
    ACTIVE_SESSION_DIRECTORIES.add(directory);
    await secureDirectory(directory);
    await writeFile(path.join(directory, SESSION_MARKER), JSON.stringify({ schemaVersion: 1, kind: "media-tracker-custom-session",
      directoryName: path.basename(directory), installationRoot: ROOT, pid: process.pid, instanceId: SESSION_INSTANCE_ID,
      createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    const cookieFile = path.join(directory, "cookies.txt");
    const lines = cookies.map((cookie) => [cookie.domain, String(cookie.domain.startsWith(".")).toUpperCase(), cookie.path || "/",
      String(Boolean(cookie.secure)).toUpperCase(), cookie.expires > 0 ? Math.floor(cookie.expires) : 0, cookie.name, cookie.value].join("\t"));
    await writeFile(cookieFile, ["# Netscape HTTP Cookie File", ...lines, ""].join("\n"), { mode: 0o600, flag: "wx" });
    return { cookies, cookieFile, dispose };
  } catch (error) {
    await context?.close().catch(() => {});
    await dispose();
    if (signal?.aborted) throw abortError(signal);
    if (/ProcessSingleton|user data directory is already in use|profile.*in use/i.test(String(error?.message))) throw new CustomDiscoveryError("profile-busy");
    throw error instanceof CustomDiscoveryError ? error : new CustomDiscoveryError("profile-invalid");
  }
}

export async function runCustomSourceWorker(payload, { signal, pythonPath = PYTHON, workerPath = WORKER, timeoutMs = 180000, onMedia } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (payload?.engine === "gallery-dl") throw new CustomDiscoveryError("public-engine-not-integrated");
  const input = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(input, "utf8") > MAX_WORKER_INPUT_BYTES) throw new CustomDiscoveryError("metadata-too-large");
  await access(pythonPath).catch(() => { throw new CustomDiscoveryError("engine-unavailable"); });
  if (signal?.aborted) throw abortError(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ["-I", "-B", workerPath], { windowsHide: true, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    const records = [];
    let result, failure, buffer = "", outputBytes = 0, errorBytes = 0, closed = false, terminating = false;
    const stop = (error) => {
      failure ||= error;
      if (terminating || closed) return;
      terminating = true;
      if (process.platform === "win32" && child.pid) {
        void execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }).catch(() => child.kill());
      } else child.kill();
    };
    const onAbort = () => stop(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(new CustomDiscoveryError("metadata-timeout")), timeoutMs);
    if (signal?.aborted) onAbort();
    child.on("error", () => { failure ||= new CustomDiscoveryError("engine-unavailable"); });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 12 * 1024 * 1024) return stop(new CustomDiscoveryError("metadata-too-large"));
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === "media") { records.push(record); onMedia?.(record, records.length); }
          else if (record.type === "result") result = record;
          else if (record.type === "error") stop(new CustomDiscoveryError(Object.hasOwn(MESSAGES, record.code) ? record.code : "engine-request-failed"));
          else if (record.type === "versions") result = record;
          else stop(new CustomDiscoveryError("engine-request-failed"));
        } catch { stop(new CustomDiscoveryError("engine-request-failed")); }
      }
    });
    child.stderr.on("data", (chunk) => { errorBytes += chunk.length; if (errorBytes > 65536) stop(new CustomDiscoveryError("metadata-too-large")); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      closed = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new CustomDiscoveryError("engine-request-failed"));
      else resolve({ records, result });
    });
    child.stdin.end(input);
  });
}

export function createCustomMediaFetch({ homepageUrl, cookies = [], dnsLookup = lookup, request = https.request } = {}) {
  const home = sourceUrl(homepageUrl);
  return async (value, options = {}) => {
    const signal = options.signal;
    const suppliedRange = new Headers(options.headers || {}).get("range");
    const range = /^bytes=\d+-$/.test(suppliedRange || "") ? suppliedRange : null;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      if (signal?.aborted) throw abortError(signal);
      const url = sourceUrl(value);
      const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((item) => !publicSourceAddress(item.address))) throw new CustomDiscoveryError("unsafe-url");
      const selected = addresses[0];
      const headers = { Referer: home.origin + "/", "User-Agent": "MediaTracker/0.1", "Accept-Encoding": "identity" };
      if (range) headers.Range = range;
      if (SAME_HOST(home.hostname, url.hostname)) {
        const scoped = cookies.filter((cookie) => cookieForUrl(cookie, url));
        if (scoped.length) headers.Cookie = scoped.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      }
      const response = await new Promise((resolve, reject) => {
        const req = request(url, { method: "GET", headers, signal, agent: false,
          lookup: (_host, config, callback) => config.all ? callback(null, [selected]) : callback(null, selected.address, selected.family) }, resolve);
        req.setTimeout(90000, () => req.destroy(new Error("timeout")));
        req.on("error", () => reject(signal?.aborted ? abortError(signal) : new CustomDiscoveryError("engine-request-failed")));
        req.end();
      });
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (!response.headers.location || redirect === 5) throw new CustomDiscoveryError("redirect-limit");
        value = new URL(response.headers.location, url).href;
        continue;
      }
      if (![200, 206].includes(status)) {
        response.destroy();
        const error = new CustomDiscoveryError("engine-request-failed"); error.status = status;
        throw error;
      }
      const mime = String(response.headers["content-type"] || "").split(";")[0].trim();
      const image = IMAGE_MIME.test(mime);
      if ((!image && mime !== "video/mp4") || (options.mediaKind === "video" ? image : options.mediaKind && !image)) {
        response.destroy(); throw new CustomDiscoveryError("unexpected-media-content");
      }
      const maximum = image ? 64 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
      if (Number(response.headers["content-length"]) > maximum) { response.destroy(); throw new CustomDiscoveryError("media-too-large"); }
      let received = 0;
      const body = Readable.toWeb(response).pipeThrough(new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maximum) { response.destroy(); throw new CustomDiscoveryError("media-too-large"); }
          controller.enqueue(chunk);
        },
        flush() { if (!received) throw new CustomDiscoveryError("unexpected-media-content"); },
      }));
      const resultHeaders = new Headers();
      for (const name of ["content-type", "content-length", "content-range"]) if (response.headers[name]) resultHeaders.set(name, String(response.headers[name]));
      return new Response(body, { status, headers: resultHeaders });
    }
    throw new CustomDiscoveryError("redirect-limit");
  };
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function discoverCustomMedia({ platform, account, linkedAccount, knownMediaKeys = [], knownPostCoverage = {}, signal, onProgress, probe = false,
  runWorker = runCustomSourceWorker, sessionExporter = exportCustomSession, fetchFactory = createCustomMediaFetch, maxItems,
  timeoutMs = probe ? 60000 : 180000 } = {}) {
  const url = targetUrl(platform, account);
  const session = await sessionExporter({ platform, linkedAccount, signal });
  try {
    const { records, result } = await runWorker({ engine: platform.engine, url, homepage: platform.homepageUrl,
      cookieFile: session.cookieFile, maxItems: maxItems || (probe ? 5 : 2000), timeoutSeconds: timeoutMs / 1000,
      knownMediaKeys: probe ? [] : knownMediaKeys.filter((key) => /^custom:[a-f0-9]{64}$/.test(key)) }, {
      signal, timeoutMs, onMedia: (_item, count) => onProgress?.({ posts: count, media: count, timelineResponses: 1 }),
    });
    const parseIssues = [];
    const emittedPerPost = new Map();
    for (const item of records) {
      const id = String(item?.postId ?? "");
      emittedPerPost.set(id, (emittedPerPost.get(id) || 0) + 1);
    }
    const proofPostIds = new Set();
    let observedTotal = 0;
    const attachmentProofValid = Array.isArray(result.coveredPosts) && result.coveredPosts.every((item) => {
      if (!item || typeof item.postId !== "string" || !item.postId || item.postId.length > 200 || proofPostIds.has(item.postId)
        || typeof item.mediaComplete !== "boolean" || !Number.isSafeInteger(item.expectedAttachmentCount) || item.expectedAttachmentCount <= 0
        || !Number.isSafeInteger(item.observedCount) || item.observedCount < 0 || item.observedCount > item.expectedAttachmentCount
        || (item.mediaComplete && item.observedCount !== item.expectedAttachmentCount)
        || (emittedPerPost.get(item.postId) || 0) > item.observedCount) return false;
      proofPostIds.add(item.postId);
      observedTotal += item.observedCount;
      return Number.isSafeInteger(observedTotal);
    }) && [...emittedPerPost.keys()].every((id) => proofPostIds.has(id))
      && observedTotal === records.length + result.knownSkipped;
    const proofValid = attachmentProofValid && result.coverageVersion === 1 && typeof result.coverageComplete === "boolean"
      && Array.isArray(result.coverageReasons) && Array.isArray(result.unresolvedPosts) && Array.isArray(result.coveredPosts)
      && Number.isSafeInteger(result.postCount) && result.postCount === result.coveredPosts.length
      && Number.isSafeInteger(result.mediaCount) && result.mediaCount === records.length
      && Number.isSafeInteger(result.knownSkipped) && result.knownSkipped >= 0 && result.knownSkipped <= new Set(knownMediaKeys).size
      && Number.isSafeInteger(result.unsupported) && result.unsupported >= 0
      && result.engine === "yt-dlp";
    const historyComplete = proofValid && result.complete === true && result.coverageComplete === true
      && result.scope === "account" && result.unsupported === 0 && result.coverageReasons.length === 0 && !probe;
    if (!proofValid) parseIssues.push("通用引擎未提供可核验的历史覆盖证据，本次不确认完整历史。");
    if (result.unsupported > 0) parseIssues.push("通用引擎存在尚未解析或不能直接保存的媒体条目，本次不确认完整历史。");
    if (result.coverageReasons?.length) parseIssues.push("通用引擎尚未确认全部分页、作品数量或附件覆盖，本次不确认完整历史。");
    if (!records.length && !(proofValid && (result.knownSkipped > 0 || result.unresolvedPosts.length > 0))) {
      throw new CustomDiscoveryError("no-verifiable-media");
    }
    const posts = new Map();
    const media = new Map();
    for (const record of records) {
      if (typeof record.key !== "string" || !record.key || record.key.length > 1000
        || !["image", "gif", "video"].includes(record.kind)
        || !["string", "number"].includes(typeof record.postId) || !String(record.postId) || String(record.postId).length > 200) {
        throw new CustomDiscoveryError("engine-request-failed");
      }
      const mediaUrl = sourceUrl(record.url).href;
      const postKey = `${result.engine}:${String(record.postId)}`;
      const postId = /^[a-z0-9_-]{1,80}$/i.test(String(record.postId)) ? String(record.postId) : digest(postKey).slice(0, 20);
      const logicalKey = `custom:${digest(record.key)}`;
      // The worker preserves a date-only platform calendar value separately
      // from epoch-derived instants. It has no clock or implied timezone.
      const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(record.createdAt || "") ? validPublicationDate(record.createdAt) : null;
      const post = { postKey, postId, createdAt: calendarDate ? null : record.createdAt || null, postUrl: url,
        mediaComplete: false,
        ...normalizePublicationDate({ createdAt: record.createdAt,
          publicationDate: record.publicationDate || calendarDate,
          dateBasis: record.dateBasis || (calendarDate ? "platform" : "unknown"), displayTimeZone: record.displayTimeZone }) };
      // Do not retain upstream headers, cookies or arbitrary nested metadata.
      if (record.postUrl) {
        try { const source = sourceUrl(record.postUrl); if (SAME_HOST(source.hostname, new URL(url).hostname)) post.postUrl = source.href; } catch {}
      }
      posts.set(postKey, post);
      media.set(logicalKey, { ...post, logicalKey, mediaId: digest(record.key).slice(0, 20), mediaIndex: record.index || 1,
        platformId: platform.id, kind: record.kind, sourceUrl: mediaUrl, extension: record.extension,
        referer: new URL(platform.homepageUrl).origin + "/", sensitive: true });
    }
    if (media.size !== records.length) parseIssues.push("通用引擎返回了重复媒体标识，尚不能核对全部附件覆盖。");
    const unresolvedMedia = [];
    const coveredPostKeys = new Set();
    for (const item of Array.isArray(result.coveredPosts) ? result.coveredPosts : []) {
      if (!item || typeof item.postId !== "string" || !item.postId || item.postId.length > 200 || typeof item.mediaComplete !== "boolean"
        || !Number.isSafeInteger(item.expectedAttachmentCount) || item.expectedAttachmentCount <= 0
        || !Number.isSafeInteger(item.observedCount) || item.observedCount < 0 || item.observedCount > item.expectedAttachmentCount) {
        parseIssues.push("通用引擎返回了无法核对的逐帖覆盖证据，本次不确认完整历史。");
        continue;
      }
      const postKey = `${result.engine}:${item.postId}`;
      if (coveredPostKeys.has(postKey)) parseIssues.push("通用引擎返回了重复的逐帖覆盖证据，本次不确认完整历史。");
      coveredPostKeys.add(postKey);
      const postId = /^[a-z0-9_-]{1,80}$/i.test(item.postId) ? item.postId : digest(postKey).slice(0, 20);
      const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(item.createdAt || "") ? validPublicationDate(item.createdAt) : null;
      const post = posts.get(postKey) || { postKey, postId, postUrl: url, createdAt: calendarDate ? null : item.createdAt || null,
        ...normalizePublicationDate({ createdAt: item.createdAt, publicationDate: item.publicationDate || calendarDate,
          dateBasis: item.dateBasis || (calendarDate ? "platform" : "unknown"), displayTimeZone: item.displayTimeZone }) };
      post.mediaComplete = proofValid && item.mediaComplete;
      post.mediaExpectedCount = item.expectedAttachmentCount;
      if (item.postUrl) {
        try { const source = sourceUrl(item.postUrl); if (SAME_HOST(source.hostname, new URL(url).hostname)) post.postUrl = source.href; } catch {}
      }
      posts.set(postKey, post);
    }
    if ([...posts.keys()].some((key) => !coveredPostKeys.has(key))) parseIssues.push("通用引擎未核对所有已解析作品的附件覆盖，本次不确认完整历史。");
    for (const item of Array.isArray(result.unresolvedPosts) ? result.unresolvedPosts.slice(0, 2000) : []) {
      if (!item || typeof item.postId !== "string" || !item.postId || item.postId.length > 200) {
        parseIssues.push("通用引擎返回了无法核对的待解析作品，本次不确认完整历史。");
        continue;
      }
      const postKey = `${result.engine}:${item.postId}`;
      const postId = /^[a-z0-9_-]{1,80}$/i.test(item.postId) ? item.postId : digest(postKey).slice(0, 20);
      const post = posts.get(postKey) || { postKey, postId, createdAt: null, postUrl: url };
      post.mediaComplete = false;
      const expectedCount = item.expectedAttachmentCount ?? item.expectedCount;
      if (Number.isSafeInteger(expectedCount) && expectedCount > 0) post.mediaExpectedCount = Math.max(post.mediaExpectedCount || 0, expectedCount);
      if (item.postUrl) {
        try { const source = sourceUrl(item.postUrl); if (SAME_HOST(source.hostname, new URL(url).hostname)) post.postUrl = source.href; } catch {}
      }
      posts.set(postKey, post);
      unresolvedMedia.push({ postKey, postId, postUrl: post.postUrl, reason: "通用引擎尚未确认该作品的全部附件，已保留待重试记录。" });
    }
    for (const [postKey, previous] of Object.entries(knownPostCoverage)) {
      if (!postKey || postKey.length > 512 || !previous || typeof previous !== "object") continue;
      const expectedCount = Number.isSafeInteger(previous.mediaExpectedCount) && previous.mediaExpectedCount >= 0 ? previous.mediaExpectedCount : 0;
      const existing = posts.get(postKey);
      const oldId = String(previous.postId || postKey).slice(0, 200);
      const post = existing || { postKey, postId: /^[a-z0-9_-]{1,80}$/i.test(oldId) ? oldId : digest(postKey).slice(0, 20),
        createdAt: null, postUrl: url, mediaComplete: false };
      if (!existing || (post.mediaExpectedCount || 0) < expectedCount) {
        post.mediaComplete = false;
        parseIssues.push("本轮逐帖附件覆盖小于历史已记录的预期，未清除旧的待重试记录。");
      }
      post.mediaExpectedCount = Math.max(post.mediaExpectedCount || 0, expectedCount);
      if (!existing && previous.postUrl) {
        try { const source = sourceUrl(previous.postUrl); if (SAME_HOST(source.hostname, new URL(url).hostname)) post.postUrl = source.href; } catch {}
      }
      posts.set(postKey, post);
    }
    for (const post of posts.values()) {
      if (!post.mediaComplete && !unresolvedMedia.some((item) => item.postKey === post.postKey)) {
        unresolvedMedia.push({ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl,
          reason: "通用引擎尚未确认该作品的全部附件，已保留待重试记录。" });
      }
    }
    const capability = { scope: ["account", "single"].includes(result.scope) ? result.scope : "unknown",
      images: [...media.values()].some((item) => item.kind !== "video"), videos: [...media.values()].some((item) => item.kind === "video"),
      engine: result.engine, extractor: result.extractor, unsupported: result.unsupported || 0,
      incremental: "media-id", knownSkipped: result.knownSkipped || 0,
      historyComplete: historyComplete && parseIssues.length === 0 && unresolvedMedia.length === 0 };
    return { posts: [...posts.values()], media: [...media.values()], complete: capability.historyComplete,
      reachedEnd: capability.historyComplete, reachedKnownBoundary: false, timelineResponses: 1, capability,
      unresolvedMedia, parseIssues: parseIssues.slice(-20), completionReason: capability.historyComplete ? "terminal-page" : null,
      incompleteReason: capability.historyComplete ? "" : parseIssues[0] || "通用引擎尚未确认账号的完整历史，本次已识别媒体会保留，下次继续检查。",
      fetchMedia: fetchFactory({ homepageUrl: platform.homepageUrl, cookies: session.cookies }) };
  } finally { await session.dispose(); }
}

export async function probeCustomMedia(options) {
  const result = await discoverCustomMedia({ ...options, probe: true });
  return { ok: true, capability: result.capability, mediaCount: result.media.length,
    message: result.capability.scope === "account" ? "已识别账号类采集器和可下载媒体；本次仅检测少量元数据，不代表完整历史已同步。"
      : "已识别可下载媒体，但尚不能确认此链接支持完整账号历史；当前仅具备单页或有限范围采集能力。" };
}
