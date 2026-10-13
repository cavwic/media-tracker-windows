import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, realpath, mkdir, readFile, writeFile, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { spawn } from "node:child_process";

const RECEIPT = ".collector-runtime-ready.json";
const INSTALL_LOCK = ".collector-runtime-install.lock.json";
const MODULES = ["yt_dlp", "requests", "certifi", "charset_normalizer", "idna", "urllib3"];
const QUICK_HASH_BYTES = 8 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function safeRelative(value, { directory = false } = {}) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\\:\0<>"|?*\x01-\x1f]/.test(value)
    || value.startsWith("/") || (!directory && value.endsWith("/"))) return false;
  const parts = (directory ? value.replace(/\/$/, "") : value).split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !/[ .]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

async function infoAt(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function assertRuntimeDirectory(directory, { missing = false } = {}) {
  let current = path.resolve(directory);
  for (;;) {
    const info = await infoAt(current);
    if (!info && !missing) throw fail("runtime-path-missing", "运行组件目录不存在：" + current);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(current), current))) {
      throw fail("runtime-path-invalid", "运行组件目录不能是文件、链接或目录联接：" + current);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function regular(filename) {
  const info = await infoAt(filename);
  if (!info || !info.isFile() || info.isSymbolicLink() || !same(await realpath(filename), filename)) {
    throw fail("runtime-file-invalid", "运行组件文件缺失或不是普通文件：" + filename);
  }
  return info;
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function officialURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("runtime-manifest-invalid", "组件下载地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search) {
    throw fail("runtime-manifest-invalid", "组件只能从固定的官方 HTTPS 地址下载。");
  }
  const allowed = (url.hostname === "storage.googleapis.com" && /^\/chrome-for-testing-public\/[\d.]+\/win64\/chrome-win64\.zip$/.test(url.pathname))
    || (url.hostname === "cdn.playwright.dev" && /^\/builds\/cft\/[\d.]+\/win64\/chrome-win64\.zip$/.test(url.pathname))
    || (["www.python.org", "python.org"].includes(url.hostname) && /^\/ftp\/python\/[\d.]+\/python-[\d.]+-embed-amd64\.zip$/.test(url.pathname))
    || (url.hostname === "files.pythonhosted.org" && /^\/packages\/[a-f0-9/]+\/[^/]+\.whl$/.test(url.pathname));
  if (!allowed) throw fail("runtime-manifest-invalid", "发布清单含非允许的官方组件来源。");
  return url.href;
}

function validateArchive(value) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value.sha256 || "")
    || !Number.isSafeInteger(value.maxDownloadBytes) || value.maxDownloadBytes < 1 || value.maxDownloadBytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(value.maxExtractBytes) || value.maxExtractBytes < 1 || value.maxExtractBytes > 1536 * 1024 * 1024) {
    throw fail("runtime-manifest-invalid", "组件清单缺少完整校验值或安全大小上限。");
  }
  officialURL(value.archiveURL);
  if (value.downloadBytes !== undefined && (!Number.isSafeInteger(value.downloadBytes) || value.downloadBytes < 1 || value.downloadBytes > value.maxDownloadBytes)) {
    throw fail("runtime-manifest-invalid", "组件下载大小记录无效。");
  }
  if (value.selectedURLs !== undefined && (!Array.isArray(value.selectedURLs) || value.selectedURLs.length > 3
    || !value.selectedURLs.includes(value.archiveURL))) throw fail("runtime-manifest-invalid", "组件固定跳转清单无效。");
  for (const url of value.selectedURLs || []) officialURL(url);
}

export async function readRuntimeManifest(root) {
  root = path.resolve(root);
  await assertRuntimeDirectory(root);
  const folder = path.join(root, "components"), filename = path.join(folder, "runtime-manifest.json");
  await assertRuntimeDirectory(folder);
  const info = await regular(filename);
  if (info.size > 128 * 1024) throw fail("runtime-manifest-invalid", "组件清单超出大小限制。");
  let manifest;
  try { manifest = JSON.parse(await readFile(filename, "utf8")); }
  catch { throw fail("runtime-manifest-invalid", "组件清单无法读取。"); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== "windows-x64" || !Array.isArray(manifest.components)
    || manifest.components.length !== 2 || new Set(manifest.components.map((item) => item?.id)).size !== 2) {
    throw fail("runtime-manifest-invalid", "运行组件清单版本或平台无效。");
  }
  for (const component of manifest.components) {
    validateArchive(component);
    if (!/^[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}$/.test(component.version || "")
      || !Array.isArray(component.requiredFiles) || !component.requiredFiles.length
      || component.requiredFiles.some((name) => !safeRelative(name))
      || !safeRelative(component.installDirectory) || (component.archiveRoot && !safeRelative(component.archiveRoot))) {
      throw fail("runtime-manifest-invalid", "组件目录或必要文件清单无效。");
    }
    if (component.id === "chromium") {
      if (component.kind !== "zip" || !/^browsers\/chromium-\d+$/.test(component.installDirectory)
        || !component.requiredFiles.includes("chrome-win64/chrome.exe") || component.archiveRoot !== "chrome-win64") {
        throw fail("runtime-manifest-invalid", "独立 Chromium 安装规则无效。");
      }
    } else if (component.id === "python") {
      if (component.kind !== "python-embed" || component.installDirectory !== "python"
        || !/^python\d{2,3}\._pth$/.test(component.pthFile || "") || !component.requiredFiles.includes("python.exe")
        || !Array.isArray(component.wheels) || component.wheels.length !== MODULES.length) {
        throw fail("runtime-manifest-invalid", "便携 Python 安装规则无效。");
      }
      for (const wheel of component.wheels) {
        validateArchive(wheel);
        if (!/^[a-z0-9_-]+$/i.test(wheel.name || "") || !/^[0-9a-zA-Z._+-]+$/.test(wheel.version || "")
          || !/-py[23][^-]*-none-any\.whl$/.test(new URL(wheel.archiveURL).pathname)
          || (wheel.licenseFiles !== undefined && (!Array.isArray(wheel.licenseFiles) || !wheel.licenseFiles.length
            || wheel.licenseFiles.some((name) => !safeRelative(name))))) {
          throw fail("runtime-manifest-invalid", "采集引擎必须使用固定的通用 Python wheel。");
        }
      }
      if (new Set(component.wheels.map((item) => item.name.replaceAll("-", "_"))).size !== MODULES.length
        || !MODULES.every((name) => component.wheels.some((item) => item.name.replaceAll("-", "_") === name))) {
        throw fail("runtime-manifest-invalid", "采集引擎 wheel 清单不完整。");
      }
    } else throw fail("runtime-manifest-invalid", "发现不支持的运行组件。");
  }
  return manifest;
}

const identity = (component) => hashBytes(JSON.stringify(component));
const downloadBytes = (component) => (component.downloadBytes || component.maxDownloadBytes)
  + (component.wheels || []).reduce((total, item) => total + (item.downloadBytes || item.maxDownloadBytes), 0);

async function componentStatus(root, component) {
  const directory = path.join(root, "runtime", ...component.installDirectory.split("/"));
  const base = { id: component.id, name: component.id === "chromium" ? "独立 Chromium 浏览器" : "通用采集 Python 引擎",
    displayName: component.displayName || (component.id === "chromium" ? "独立 Chromium 浏览器" : "通用采集 Python 引擎"),
    license: component.license || null, licenseSummary: component.licenseSummary || null, licenseURL: component.licenseURL || null,
    directory, downloadBytes: downloadBytes(component), ready: false, installed: false };
  try {
    await assertRuntimeDirectory(path.dirname(directory), { missing: true });
    if (!(await infoAt(directory))) return { ...base, state: "missing", message: "尚未下载；仅确认后准备本工具独立运行组件。" };
    base.installed = true;
    await assertRuntimeDirectory(directory);
    const receiptFile = path.join(directory, RECEIPT), receiptInfo = await regular(receiptFile);
    if (receiptInfo.size > 2 * 1024 * 1024) throw fail("runtime-receipt-invalid", "运行组件完成记录过大。");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    if (receipt.schemaVersion !== 1 || receipt.componentId !== component.id || receipt.manifestIdentity !== identity(component)
      || !Array.isArray(receipt.files) || receipt.files.length > 20_000 || !/^[a-f0-9]{64}$/.test(receipt.filesSHA256 || "")
      || receipt.filesSHA256 !== hashBytes(JSON.stringify(receipt.files))) {
      throw fail("runtime-receipt-invalid", "运行组件完成记录与发布版本不匹配。");
    }
    const files = new Map();
    for (const file of receipt.files) {
      if (!safeRelative(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isFinite(file.mtimeMs)
        || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || files.has(file.name.toLowerCase())) {
        throw fail("runtime-receipt-invalid", "运行组件文件校验记录损坏。");
      }
      files.set(file.name.toLowerCase(), file);
    }
    const required = [...component.requiredFiles];
    if (component.id === "python") required.push(component.pthFile, ...MODULES.map((module) => `Lib/site-packages/${module}/__init__.py`),
      ...component.wheels.flatMap((wheel) => (wheel.licenseFiles || []).map((name) => `Lib/site-packages/${name}`)));
    for (const name of required) {
      const record = files.get(name.toLowerCase());
      if (!record) throw fail("runtime-receipt-invalid", "运行组件必要文件未被校验：" + name);
      const filename = path.join(directory, ...name.split("/"));
      await assertRuntimeDirectory(path.dirname(filename));
      const actual = await regular(filename);
      if (actual.size !== record.bytes || actual.mtimeMs !== record.mtimeMs
        || (actual.size <= QUICK_HASH_BYTES && await sha256(filename) !== record.sha256)) {
        throw fail("runtime-component-changed", "运行组件文件已更改或不完整：" + name);
      }
    }
    return { ...base, state: "ready", ready: true, message: "已校验本工具独立运行组件。", integrityMode: "small-file-hashes-and-large-file-identity" };
  } catch (error) {
    return { ...base, state: "invalid", message: error.message + " 未覆盖、清空或重建原目录。请完全关闭工具，将此组件目录改名备份后再运行 EXE 重试；不要改动 data。组件目录：" + directory,
      code: error.code || "runtime-component-invalid" };
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; return true; }
}

async function lockStatus(root) {
  const filename = path.join(root, "runtime", INSTALL_LOCK);
  await assertRuntimeDirectory(path.dirname(filename), { missing: true });
  if (!(await infoAt(filename))) return null;
  const info = await regular(filename);
  if (info.size > 16_384) throw fail("runtime-install-lock-invalid", "组件准备锁文件过大，未删除或覆盖。");
  let value;
  try { value = JSON.parse(await readFile(filename, "utf8")); } catch { throw fail("runtime-install-lock-invalid", "组件准备锁文件损坏，未删除或覆盖。"); }
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1
    || !/^[a-f0-9-]{36}$/.test(value.nonce || "") || value.rootIdentity !== hashBytes(path.resolve(root).toLowerCase())
    || !/^[a-f0-9]{64}$/.test(value.manifestIdentity || "") || !Number.isFinite(Date.parse(value.createdAt))) {
    throw fail("runtime-install-lock-invalid", "组件准备锁不属于此便携包，未删除或覆盖。");
  }
  return { filename, value, alive: processExists(value.ownerPid) };
}

async function claimInstallLock(root, manifest) {
  const runtime = path.join(root, "runtime"), filename = path.join(runtime, INSTALL_LOCK);
  await assertRuntimeDirectory(runtime, { missing: true });
  await mkdir(runtime, { recursive: true }); await assertRuntimeDirectory(runtime);
  const value = { schemaVersion: 1, ownerPid: process.pid, nonce: randomUUID(), rootIdentity: hashBytes(path.resolve(root).toLowerCase()),
    manifestIdentity: hashBytes(JSON.stringify(manifest)), createdAt: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(value) + "\n"), digest = hashBytes(bytes);
  let handle;
  try { handle = await open(filename, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await lockStatus(root);
    if (existing?.alive) throw fail("runtime-install-busy", "已有运行组件准备程序正在执行，请等待完成后重试；本次未重复下载。");
    throw fail("runtime-stale-install-lock", "此前组件准备程序已经退出，锁文件已保留。请将此单独锁文件改名备份后重试，勿删除 runtime 或 data：" + filename);
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const ownInfo = await regular(filename);
  return async () => {
    try {
      await assertRuntimeDirectory(runtime);
      const current = await regular(filename);
      if (current.dev !== ownInfo.dev || current.ino !== ownInfo.ino || current.size !== bytes.length || await sha256(filename) !== digest) return;
      const recorded = JSON.parse(await readFile(filename, "utf8"));
      if (recorded.ownerPid === process.pid && recorded.nonce === value.nonce) await rm(filename);
    } catch { /* An unknown/replaced lock is preserved, never guessed or removed. */ }
  };
}

export async function portableRuntimeStatus({ root, manifest } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("runtime-root-invalid", "必须使用独立便携包的绝对目录。");
  manifest ||= await readRuntimeManifest(root);
  const components = [];
  for (const component of manifest.components) components.push(await componentStatus(root, component));
  const ready = components.every((item) => item.ready);
  let lock, lockMessage = "";
  if (!ready) {
    try {
      lock = await lockStatus(root);
      if (lock) lockMessage = lock.alive ? "已有运行组件准备程序正在执行，请等待完成后重试；不会重复下载。"
        : "此前组件准备程序已经退出，请将此单独锁文件改名备份后重试，勿改动 data：" + lock.filename;
    } catch (error) { lockMessage = error.message; }
  }
  if (lockMessage) for (const item of components) if (!item.ready) item.message = lockMessage;
  return { schemaVersion: 1, ready,
    requiresDownload: !lockMessage && components.some((item) => item.state === "missing"),
    blocked: !!lockMessage || components.some((item) => item.state === "invalid"),
    installInProgress: !!lock?.alive, ...(lockMessage ? { message: lockMessage } : {}),
    totalDownloadBytes: components.filter((item) => item.state === "missing").reduce((total, item) => total + item.downloadBytes, 0), components };
}

async function readExact(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw fail("runtime-zip-invalid", "组件 ZIP 数据不完整。");
  return buffer;
}

/** Parse a pinned ZIP without executing it or buffering the browser in memory. */
export async function inspectRuntimeZip(filename, { maxDownloadBytes, maxExtractBytes, archiveRoot = "" }) {
  const fileInfo = await regular(filename);
  if (fileInfo.size < 22 || fileInfo.size > maxDownloadBytes) throw fail("runtime-zip-invalid", "组件 ZIP 大小无效。");
  const handle = await open(filename, "r");
  try {
    const tailStart = Math.max(0, fileInfo.size - 65_557), tail = await readExact(handle, tailStart, fileInfo.size - tailStart);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw fail("runtime-zip-invalid", "不支持分卷或残缺的 ZIP。");
    const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
    if (count > 20_000 || count !== tail.readUInt16LE(end + 8) || size > 16 * 1024 * 1024 || start + size !== tailStart + end) {
      throw fail("runtime-zip-invalid", "ZIP 目录损坏、过大或使用未支持的 ZIP64。");
    }
    const central = await readExact(handle, start, size), entries = [], seen = new Map(), ranges = [];
    let cursor = 0, total = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw fail("runtime-zip-invalid", "ZIP 条目损坏。");
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), crc = central.readUInt32LE(cursor + 16);
      const compressed = central.readUInt32LE(cursor + 20), bytes = central.readUInt32LE(cursor + 24), nameSize = central.readUInt16LE(cursor + 28);
      const extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32), attributes = central.readUInt32LE(cursor + 38);
      const mode = attributes >>> 16, offset = central.readUInt32LE(cursor + 42), next = cursor + 46 + nameSize + extra + comment;
      if (next > central.length) throw fail("runtime-zip-invalid", "ZIP 路径数据损坏。");
      const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameSize), name = nameBytes.toString("utf8");
      cursor = next;
      const directory = name.endsWith("/"), key = name.replace(/\/$/, "").toLowerCase();
      if (!safeRelative(name, { directory }) || name.includes("\ufffd") || seen.has(key) || (flags & 1)
        || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || (attributes & 0x400)
        || ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000))) {
        throw fail("runtime-zip-invalid", "ZIP 含不安全路径、重名、链接、特殊文件或加密内容。");
      }
      seen.set(key, directory);
      if (archiveRoot && name !== `${archiveRoot}/` && !name.startsWith(`${archiveRoot}/`)) throw fail("runtime-zip-invalid", "ZIP 的固定版本根目录不匹配。");
      total += bytes;
      if (total > maxExtractBytes || bytes > 512 * 1024 * 1024 || offset + 30 > start) throw fail("runtime-zip-invalid", "ZIP 解压大小或位置超出安全限制。");
      const header = await readExact(handle, offset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method) {
        throw fail("runtime-zip-invalid", "ZIP 本地条目与目录不一致。");
      }
      const localNameSize = header.readUInt16LE(26), localExtra = header.readUInt16LE(28), dataStart = offset + 30 + localNameSize + localExtra;
      if (dataStart + compressed > start || !(await readExact(handle, offset + 30, localNameSize)).equals(nameBytes)) {
        throw fail("runtime-zip-invalid", "ZIP 条目文件名或边界不一致。");
      }
      if (!(flags & 8) && (header.readUInt32LE(14) !== crc || header.readUInt32LE(18) !== compressed || header.readUInt32LE(22) !== bytes)) {
        throw fail("runtime-zip-invalid", "ZIP 本地大小或 CRC 不一致。");
      }
      ranges.push([offset, dataStart + compressed]);
      if (directory) { if (bytes !== 0) throw fail("runtime-zip-invalid", "ZIP 目录包含文件数据。"); continue; }
      entries.push({ name, bytes, compressed, crc, method, dataStart });
    }
    if (cursor !== central.length) throw fail("runtime-zip-invalid", "ZIP 目录尾部损坏。");
    ranges.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < ranges.length; index++) if (ranges[index][0] < ranges[index - 1][1]) throw fail("runtime-zip-invalid", "ZIP 本地数据区域重叠。");
    for (const [name] of seen) {
      const parts = name.split("/");
      for (let count = 1; count < parts.length; count++) if (seen.get(parts.slice(0, count).join("/")) === false) throw fail("runtime-zip-invalid", "ZIP 文件与目录路径冲突。");
    }
    return entries;
  } finally { await handle.close(); }
}

async function downloadArchive(descriptor, filename, { signal, fetcher, progress, componentId }) {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300_000)]);
  let url = descriptor.archiveURL, response;
  for (let redirects = 0; redirects <= 2; redirects++) {
    response = await fetcher(url, { signal: requestSignal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get("location") || "", url).href;
    await response.body?.cancel();
    if (!descriptor.selectedURLs?.includes(next) || redirects === 2) throw fail("runtime-download-redirect", "组件下载跳转不属于发布清单中的固定地址。");
    url = next;
  }
  if (!response?.ok || !response.body) throw fail("runtime-download-failed", "组件下载失败（HTTP " + response?.status + "），请检查网络后重试。");
  const length = Number(response.headers.get("content-length"));
  if (length > descriptor.maxDownloadBytes) { await response.body.cancel(); throw fail("runtime-download-too-large", "组件下载超出安全大小上限。"); }
  let bytes = 0, lastReported = 0;
  const hash = createHash("sha256");
  const guard = new Transform({ transform(chunk, encoding, callback) {
    try {
      requestSignal.throwIfAborted(); bytes += chunk.length;
      if (bytes > descriptor.maxDownloadBytes) throw fail("runtime-download-too-large", "组件下载超出安全大小上限。");
      hash.update(chunk);
      if (bytes - lastReported >= 512 * 1024 || bytes === length) {
        progress({ type: "progress", componentId, phase: "download", bytes, totalBytes: descriptor.downloadBytes || length || null }); lastReported = bytes;
      }
      callback(null, chunk);
    } catch (error) { callback(error); }
  } });
  await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(filename, { flags: "wx" }), { signal: requestSignal });
  if ((descriptor.downloadBytes && bytes !== descriptor.downloadBytes) || hash.digest("hex") !== descriptor.sha256.toLowerCase()) {
    throw fail("runtime-hash-mismatch", "组件下载校验失败，未解压或执行；请重新尝试。");
  }
  progress({ type: "progress", componentId, phase: "verified", bytes });
}

async function extractArchive(archive, destination, descriptor, { signal, progress, componentId, prefix = "", seen }) {
  const entries = await inspectRuntimeZip(archive, descriptor), records = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const name = prefix + entry.name;
    if (entry.name.split("/")[0].endsWith(".data")
      && (!/^[^/]+\.data\/data\/share\//.test(entry.name) || /\.(?:exe|dll|pyd|bat|cmd|ps1)$/i.test(entry.name))) {
      throw fail("runtime-wheel-invalid", "该 wheel 需要执行脚本或安装映射，当前固定通用组件不支持。");
    }
    const key = name.toLowerCase();
    if (name === RECEIPT || seen.has(key)) throw fail("runtime-zip-invalid", "组件文件名与其他运行文件冲突。");
    seen.add(key);
    const filename = path.join(destination, ...name.split("/")), parent = path.dirname(filename);
    await assertRuntimeDirectory(parent, { missing: true }); await mkdir(parent, { recursive: true }); await assertRuntimeDirectory(parent);
    let bytes = 0, crc = 0xffffffff;
    const hash = createHash("sha256");
    const guard = new Transform({ transform(chunk, encoding, callback) {
      try {
        signal?.throwIfAborted(); bytes += chunk.length;
        if (bytes > entry.bytes) throw fail("runtime-zip-invalid", "ZIP 实际解压数据超过声明大小。");
        hash.update(chunk);
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        callback(null, chunk);
      } catch (error) { callback(error); }
    } });
    const input = entry.compressed ? createReadStream(archive, { start: entry.dataStart, end: entry.dataStart + entry.compressed - 1 }) : Readable.from([]);
    const streams = entry.method === 8 ? [input, createInflateRaw(), guard, createWriteStream(filename, { flags: "wx" })]
      : [input, guard, createWriteStream(filename, { flags: "wx" })];
    await pipeline(...streams, { ...(signal ? { signal } : {}) });
    if (bytes !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw fail("runtime-zip-invalid", "ZIP 解压文件大小或 CRC 校验失败。");
    const info = await regular(filename);
    records.push({ name, bytes, sha256: hash.digest("hex"), mtimeMs: info.mtimeMs });
  }
  progress({ type: "progress", componentId, phase: "extracted", files: records.length });
  return records;
}

async function validatePython(directory, component, { signal }) {
  const code = "import sys,os,importlib,json; root=os.path.normcase(os.path.realpath(sys.argv[1]));"
    + "mods=[importlib.import_module(n) for n in " + JSON.stringify(MODULES) + "];"
    + "assert os.path.normcase(os.path.realpath(sys.prefix))==root;"
    + "assert all(os.path.commonpath([root,os.path.normcase(os.path.realpath(m.__file__))])==root for m in mods);"
    + "print(json.dumps({'ready':True,'prefix':sys.prefix}))";
  await new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const env = { ...process.env }; delete env.PYTHONHOME; delete env.PYTHONPATH;
    env.PYTHONNOUSERSITE = "1"; env.PYTHONDONTWRITEBYTECODE = "1";
    const child = spawn(path.join(directory, "python.exe"), ["-I", "-B", "-X", "utf8", "-c", code, directory],
      { cwd: directory, windowsHide: true, shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    let stopped, bytes = 0, result = "";
    const stop = (error) => { stopped ||= error; child.kill(); };
    const abort = () => stop(signal.reason || new DOMException("组件准备已取消。", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(fail("runtime-python-check-failed", "便携采集引擎检查超时。")), 30_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) stop(fail("runtime-python-check-failed", "采集引擎检查输出过大。")); else result += chunk.toString("utf8");
    });
    child.once("error", (error) => { stopped ||= fail("runtime-python-check-failed", "便携采集引擎无法运行：" + error.code); });
    child.once("close", (exitCode) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      stopped ? reject(stopped) : exitCode === 0 && result.includes('"ready": true') ? resolve()
        : reject(fail("runtime-python-check-failed", "便携采集引擎隔离验证失败。"));
    });
  });
}

async function validateComponent(directory, component, options) {
  for (const name of component.requiredFiles) await regular(path.join(directory, ...name.split("/")));
  for (const wheel of component.wheels || []) for (const name of wheel.licenseFiles || []) {
    await regular(path.join(directory, "Lib", "site-packages", ...name.split("/")));
  }
  if (component.id === "python") await validatePython(directory, component, options);
}

async function prepareComponent(root, component, { signal, fetcher, progress, validate }) {
  const destination = path.join(root, "runtime", ...component.installDirectory.split("/"));
  const parent = path.dirname(destination), stage = path.join(parent, `.collector-${component.id}-${randomUUID()}.installing`);
  await assertRuntimeDirectory(parent, { missing: true });
  await mkdir(parent, { recursive: true }); await assertRuntimeDirectory(parent);
  if (await infoAt(destination)) throw fail("runtime-install-conflict", "组件目录已存在，未覆盖原文件。");
  await mkdir(stage);
  const stageInfo = await lstat(stage), payload = path.join(stage, "payload");
  await mkdir(payload);
  let committed = false;
  try {
    const seen = new Set(), records = [], archive = path.join(stage, "runtime.zip");
    await downloadArchive(component, archive, { signal, fetcher, progress, componentId: component.id });
    records.push(...await extractArchive(archive, payload, component, { signal, progress, componentId: component.id, seen }));
    for (let index = 0; index < (component.wheels || []).length; index++) {
      const wheel = component.wheels[index], wheelArchive = path.join(stage, `wheel-${index}.zip`);
      await downloadArchive(wheel, wheelArchive, { signal, fetcher, progress, componentId: component.id });
      records.push(...await extractArchive(wheelArchive, payload, wheel, { signal, progress, componentId: component.id, prefix: "Lib/site-packages/", seen }));
    }
    if (component.id === "python") {
      const pth = path.join(payload, component.pthFile); await regular(pth);
      const zipName = component.pthFile.replace("._pth", ".zip"); await regular(path.join(payload, zipName));
      await writeFile(pth, `${zipName}\n.\nLib/site-packages\nimport site\n`, { flag: "r+" });
      // r+ intentionally does not truncate on some platforms; an explicit
      // handle truncation ensures no original embedded _pth tail survives.
      const handle = await open(pth, "r+");
      try { await handle.truncate(Buffer.byteLength(`${zipName}\n.\nLib/site-packages\nimport site\n`)); } finally { await handle.close(); }
      const info = await regular(pth), record = records.find((item) => item.name === component.pthFile);
      Object.assign(record, { bytes: info.size, mtimeMs: info.mtimeMs, sha256: await sha256(pth) });
    }
    signal?.throwIfAborted();
    progress({ type: "progress", componentId: component.id, phase: "validate" });
    await validate(payload, component, { signal });
    const receipt = { schemaVersion: 1, componentId: component.id, manifestIdentity: identity(component),
      downloadSource: { version: component.version, archiveURL: component.archiveURL, sha256: component.sha256,
        license: component.license || null, licenseURL: component.licenseURL || null,
        wheels: (component.wheels || []).map(({ name, version, archiveURL, sha256, license, licenseFiles }) => ({ name, version, archiveURL, sha256, license, licenseFiles })) }, files: records,
      filesSHA256: hashBytes(JSON.stringify(records)) };
    const receiptHandle = await open(path.join(payload, RECEIPT), "wx");
    try { await receiptHandle.writeFile(JSON.stringify(receipt) + "\n", "utf8"); await receiptHandle.sync(); } finally { await receiptHandle.close(); }
    signal?.throwIfAborted(); await assertRuntimeDirectory(parent);
    if (await infoAt(destination)) throw fail("runtime-install-conflict", "组件安装位置被占用，原目录未修改。");
    await rename(payload, destination); committed = true;
    progress({ type: "progress", componentId: component.id, phase: "ready" });
  } finally {
    // Only this exact operation's stage is removed; no runtime/data/root delete.
    try {
      await assertRuntimeDirectory(stage);
      const current = await lstat(stage);
      if (current.dev === stageInfo.dev && current.ino === stageInfo.ino && path.dirname(stage) === parent
        && /^\.collector-(?:chromium|python)-[a-f0-9-]{36}\.installing$/.test(path.basename(stage))) {
        await rm(stage, { recursive: true, force: true });
      }
    } catch (error) {
      progress({ type: "progress", componentId: component.id, phase: "cleanup-preserved", message: "临时目录身份异常或占用，已保留待检查；未删除原运行组件。" });
    }
    if (!committed) progress({ type: "progress", componentId: component.id, phase: "not-committed" });
  }
}

export async function preparePortableRuntime({ root, confirmed = false, signal, fetcher = globalThis.fetch,
  progress = () => {}, validate = validateComponent } = {}) {
  if (confirmed !== true) throw fail("runtime-confirmation-required", "请先确认下载本工具独立运行组件；尚未连接网络。");
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("runtime-root-invalid", "必须使用独立便携包的绝对目录。");
  signal?.throwIfAborted();
  const manifest = await readRuntimeManifest(root), status = await portableRuntimeStatus({ root, manifest });
  if (status.blocked) throw fail(status.installInProgress ? "runtime-install-busy" : "runtime-existing-invalid",
    status.message || status.components.find((item) => item.state === "invalid").message);
  if (status.ready) return status;
  const releaseLock = await claimInstallLock(root, manifest);
  try {
    for (const component of manifest.components) {
      if (status.components.find((item) => item.id === component.id).ready) continue;
      signal?.throwIfAborted();
      await prepareComponent(root, component, { signal, fetcher, progress, validate });
    }
    signal?.throwIfAborted();
  } finally {
    await releaseLock();
  }
  return portableRuntimeStatus({ root, manifest });
}
