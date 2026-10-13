import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const missing = () => failure("similarity-tools-unavailable", "相似去重需要 FFmpeg 和 ffprobe；请安装去重组件或指定已有工具目录。精确去重和媒体采集不受影响。");
const SUFFIX = process.platform === "win32" ? ".exe" : "";
const MAX_ARCHIVE = 256 * 1024 * 1024, MAX_EXTRACTED = 512 * 1024 * 1024;
let configuration = { root: process.env.MEDIA_TRACKER_PORTABLE_ROOT || PROJECT_ROOT, directory: "", allowSystemTools: true };
const checks = new Map();

export function normalizeDedupToolsSettings(value) {
  const directory = typeof value?.directory === "string" ? value.directory.trim() : "";
  if (directory.length > 4096 || /[\0\r\n]/.test(directory)) return { directory: "" };
  return { directory };
}

export function configureSimilarityTools(settings, { root = process.env.MEDIA_TRACKER_PORTABLE_ROOT || PROJECT_ROOT, allowSystemTools = true } = {}) {
  configuration = { root: path.resolve(root), ...normalizeDedupToolsSettings(settings), allowSystemTools: allowSystemTools === true };
  checks.clear();
}

function configuredDirectory(directory, root) {
  if (!directory) return "";
  const resolved = path.resolve(root, directory);
  if (!path.isAbsolute(directory)) {
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure("similarity-tools-path-invalid", "工具的相对路径必须位于采集工具目录内。", 400);
  }
  return resolved;
}

export function portableToolDirectory(directory, root = configuration.root) {
  const resolved = path.resolve(directory), relative = path.relative(root, resolved);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative || "." : resolved;
}

async function regularFile(file) {
  try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink() ? info : null; }
  catch (error) { if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return null; throw error; }
}

async function pairAt(directory) {
  for (const bin of [directory, path.join(directory, "bin")]) {
    const ffmpeg = path.join(bin, "ffmpeg" + SUFFIX), ffprobe = path.join(bin, "ffprobe" + SUFFIX);
    const stats = await Promise.all([regularFile(ffmpeg), regularFile(ffprobe)]);
    if (stats.every(Boolean)) return { directory: bin, ffmpeg, ffprobe, stamp: stats.map((s) => `${s.size}:${s.mtimeMs}:${s.ctimeMs}`).join("|") };
  }
  return null;
}

function runCheck(executable, args, { signal, timeout = 8_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, done = false, stopped;
    const output = [];
    const stop = (error) => { stopped ||= error; child.kill(); };
    const abort = () => stop(signal.reason || new DOMException("组件检查已取消。", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(failure("similarity-tools-check-failed", "去重工具检查超时，请重新选择可运行的 FFmpeg 工具。")), timeout);
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(Buffer.concat(output).toString("utf8")); };
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) stop(failure("similarity-tools-check-failed", "去重工具返回内容超出检查上限。"));
      else output.push(chunk);
    });
    child.once("error", () => finish(failure("similarity-tools-check-failed", "去重工具无法运行，请确认选择的是适用于当前 Windows 的 FFmpeg 和 ffprobe。")));
    child.once("close", (code) => finish(stopped || (code !== 0 ? failure("similarity-tools-check-failed", "去重工具检查未通过，请重新选择完整 FFmpeg 工具目录。") : null)));
  });
}

export async function checkDedupTools({ directory = configuration.directory, root = configuration.root, signal, env = process.env, execute = runCheck,
  allowSystemTools = configuration.allowSystemTools } = {}) {
  root = path.resolve(root);
  const selected = configuredDirectory(directory, root);
  let pair;
  if (selected) pair = await pairAt(selected);
  else {
    pair = await pairAt(path.join(root, "tools", "ffmpeg"));
    if (!pair) {
      let versions = [];
      try { versions = (await readdir(path.join(root, "tools"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^ffmpeg-[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.name))
        .map((entry) => entry.name).sort((a, b) => b.localeCompare(a, "en", { numeric: true })); }
      catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error; }
      for (const version of versions) { pair = await pairAt(path.join(root, "tools", version)); if (pair) break; }
    }
    if (!pair && allowSystemTools && env.MEDIA_TRACKER_FFMPEG && env.MEDIA_TRACKER_FFPROBE) {
      const ffmpeg = env.MEDIA_TRACKER_FFMPEG, ffprobe = env.MEDIA_TRACKER_FFPROBE;
      if (path.isAbsolute(ffmpeg) && path.isAbsolute(ffprobe)) {
        const stats = await Promise.all([regularFile(ffmpeg), regularFile(ffprobe)]);
        if (stats.every(Boolean)) pair = { directory: path.dirname(ffmpeg), ffmpeg, ffprobe, stamp: stats.map((s) => `${s.size}:${s.mtimeMs}:${s.ctimeMs}`).join("|") };
      }
    }
    if (!pair && allowSystemTools) for (const entry of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const candidate = entry.replace(/^"|"$/g, "");
      if (path.isAbsolute(candidate)) pair = await pairAt(candidate);
      if (pair) break;
    }
  }
  if (!pair) throw missing();
  const key = `${pair.ffmpeg}|${pair.ffprobe}|${pair.stamp}`;
  if (execute === runCheck && checks.has(key)) { signal?.throwIfAborted(); return { ...checks.get(key) }; }
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    execute(pair.ffmpeg, ["-version"], { signal }), execute(pair.ffprobe, ["-version"], { signal }),
  ]);
  if (!/^ffmpeg version\s+\S+/m.test(ffmpegVersion) || !/^ffprobe version\s+\S+/m.test(ffprobeVersion)) throw failure("similarity-tools-check-failed", "选择的程序不是可验证的 FFmpeg 和 ffprobe。");
  const filters = await execute(pair.ffmpeg, ["-hide_banner", "-filters"], { signal });
  if (!["scale", "select"].every((filter) => new RegExp(`\\s${filter}\\s`).test(filters))) throw failure("similarity-tools-check-failed", "FFmpeg 缺少本地去重所需的 scale/select 滤镜，请使用完整构建。");
  const { stamp, ...tools } = pair;
  const result = { ...tools, ready: true, ffmpegVersion: ffmpegVersion.split(/\r?\n/)[0].slice(0, 160), ffprobeVersion: ffprobeVersion.split(/\r?\n/)[0].slice(0, 160) };
  if (execute === runCheck) checks.set(key, result);
  return { ...result };
}

export async function readBundledDedupPackage({ root = configuration.root, manifestPath = path.join(root, "components", "ffmpeg-package.json") } = {}) {
  try {
    let info = await regularFile(manifestPath);
    if (!info && path.resolve(root) === PROJECT_ROOT && manifestPath === path.join(root, "components", "ffmpeg-package.json")) {
      manifestPath = path.join(PROJECT_ROOT, "packaging", "ffmpeg-package.json");
      info = await regularFile(manifestPath);
    }
    if (!info || info.size > 16_384) return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256 || "") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(manifest.version || "")) return null;
    if (manifest.archiveRoot && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(manifest.archiveRoot)) return null;
    if (manifest.remoteURL) {
      const url = new URL(manifest.remoteURL);
      if (url.protocol !== "https:" || url.hostname !== "www.gyan.dev" || url.username || url.password || url.port || url.search || url.hash
        || !/^\/ffmpeg\/builds\/packages\/ffmpeg-[a-zA-Z0-9._-]+-essentials_build\.zip$/.test(url.pathname)) return null;
      return { ...manifest, remoteURL: url.href };
    }
    if (typeof manifest.file !== "string" || path.basename(manifest.file) !== manifest.file || !/\.zip$/i.test(manifest.file)) return null;
    const archivePath = path.join(path.dirname(manifestPath), manifest.file), archiveInfo = await regularFile(archivePath);
    if (!archiveInfo || archiveInfo.size > MAX_ARCHIVE) return null;
    return { ...manifest, archivePath };
  } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError || error.code === "ERR_INVALID_URL") return null; throw error; }
}

export async function dedupToolsStatus(options = {}) {
  const root = path.resolve(options.root || configuration.root), bundle = await readBundledDedupPackage({ ...options, root });
  const common = { defaultInstallDirectory: path.join(root, "tools"), installAvailable: !!bundle, downloadRequired: !!bundle?.remoteURL, componentVersion: bundle?.version || null,
    componentLicense: bundle?.license || "", componentProvider: bundle?.provider || "", componentSource: bundle?.source || "" };
  try { return { ...common, ...(await checkDedupTools(options)), reason: "ready", message: "本地相似去重组件已就绪；不会上传媒体或调用 AI。" }; }
  catch (error) {
    if (error?.name === "AbortError") throw error;
    return { ...common, ready: false, directory: configuredDirectory(options.directory ?? configuration.directory, root), ffmpeg: "", ffprobe: "", reason: error.code || "similarity-tools-check-failed", message: error.message };
  }
}

// Bounded ZIP parser for the publisher-controlled component. Extract no scripts,
// media, links or arbitrary paths. Full SHA-256 is verified before decoding.
export function decodeDedupPackageZip(buffer, { archiveRoot = "" } = {}) {
  if (buffer.length > MAX_ARCHIVE) throw failure("similarity-package-invalid", "去重组件包超出安全大小限制。");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw failure("similarity-package-invalid", "去重组件不是受支持的完整 ZIP 包。");
  const count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), centralStart = buffer.readUInt32LE(end + 16);
  if (count > 1000 || centralStart + centralSize !== end || buffer.readUInt16LE(end + 8) !== count) throw failure("similarity-package-invalid", "去重组件 ZIP 目录损坏。");
  let cursor = centralStart, total = 0;
  const files = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw failure("similarity-package-invalid", "去重组件 ZIP 条目损坏。");
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), compressed = buffer.readUInt32LE(cursor + 20), bytes = buffer.readUInt32LE(cursor + 24);
    const nameSize = buffer.readUInt16LE(cursor + 28), extraSize = buffer.readUInt16LE(cursor + 30), commentSize = buffer.readUInt16LE(cursor + 32), mode = buffer.readUInt32LE(cursor + 38) >>> 16, offset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameSize + extraSize + commentSize > end) throw failure("similarity-package-invalid", "去重组件 ZIP 路径损坏。");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
    cursor += 46 + nameSize + extraSize + commentSize;
    if (!name || name.length > 512 || /[\\:\0<>"|?*]/.test(name) || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || (mode & 0xf000) === 0xa000 || flags & 1 || ![0, 8].includes(method)) throw failure("similarity-package-invalid", "去重组件含不安全路径、链接或加密内容。");
    const key = name.toLowerCase();
    if (seen.has(key)) throw failure("similarity-package-invalid", "去重组件含重名路径。");
    seen.add(key);
    if (name.endsWith("/")) continue;
    if (archiveRoot && !name.startsWith(`${archiveRoot}/`)) throw failure("similarity-package-invalid", "去重组件的版本目录不匹配。");
    const relativeName = archiveRoot ? name.slice(archiveRoot.length + 1) : name;
    // Complete third-party packages may also contain ffplay and documentation.
    // Validate all entry paths but extract only required binaries and notices.
    if (!/^(?:bin\/(?:ffmpeg|ffprobe)\.exe|bin\/[a-zA-Z0-9._-]+\.dll|licenses\/[a-zA-Z0-9._/-]+|(?:LICENSE|NOTICE|SOURCE|README)(?:[a-zA-Z0-9._-]*)?)$/i.test(relativeName)) continue;
    total += bytes;
    if (total > MAX_EXTRACTED || bytes > 256 * 1024 * 1024 || offset + 30 > centralStart || buffer.readUInt32LE(offset) !== 0x04034b50) throw failure("similarity-package-invalid", "去重组件解压大小或文件位置异常。");
    const localNameSize = buffer.readUInt16LE(offset + 26), localExtraSize = buffer.readUInt16LE(offset + 28), dataStart = offset + 30 + localNameSize + localExtraSize;
    if (dataStart + compressed > centralStart || buffer.subarray(offset + 30, offset + 30 + localNameSize).toString("utf8") !== name || buffer.readUInt16LE(offset + 8) !== method || buffer.readUInt16LE(offset + 6) !== flags) throw failure("similarity-package-invalid", "去重组件 ZIP 条目不一致。");
    const raw = buffer.subarray(dataStart, dataStart + compressed), content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: bytes + 1 });
    if (content.length !== bytes) throw failure("similarity-package-invalid", "去重组件文件不完整。");
    files.push({ name: relativeName, content });
  }
  if (cursor !== end || !["bin/ffmpeg.exe", "bin/ffprobe.exe"].every((name) => files.some((file) => file.name.toLowerCase() === name))) throw failure("similarity-package-invalid", "去重组件缺少 FFmpeg 或 ffprobe。");
  return files;
}

async function assertNoLinkedParent(directory) {
  let current = path.resolve(directory);
  for (;;) {
    try { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw failure("similarity-tools-path-invalid", "组件安装位置不能是文件、链接或目录联接。", 400); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

async function downloadComponent(url, { signal, fetcher = globalThis.fetch } = {}) {
  const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)]);
  // URL is from the fixed publisher manifest, never from an API request.
  const response = await fetcher(url, { signal: downloadSignal, redirect: "error" });
  if (!response.ok || !response.body) throw failure("similarity-package-download-failed", "去重组件下载失败，请检查网络后重试或指定已有工具目录。", 503);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_ARCHIVE) { await response.body.cancel(); throw failure("similarity-package-invalid", "去重组件下载超出大小限制。"); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    downloadSignal.throwIfAborted(); bytes += chunk.length;
    if (bytes > MAX_ARCHIVE) throw failure("similarity-package-invalid", "去重组件下载超出大小限制。");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function installBundledDedupTools({ parentDirectory, root = configuration.root, manifestPath, signal, check = checkDedupTools, fetcher } = {}) {
  const bundle = await readBundledDedupPackage({ root, manifestPath });
  if (!bundle) throw failure("similarity-package-unavailable", "发布包没有可验证的去重组件来源，请指定已有 FFmpeg 和 ffprobe 的目录。", 422);
  const parent = parentDirectory || path.join(root, "tools");
  if (typeof parent !== "string" || !path.isAbsolute(parent) || /[\0\r\n]/.test(parent)) throw failure("similarity-tools-path-invalid", "请选择完整的本地组件安装路径。", 400);
  await assertNoLinkedParent(parent);
  const destination = path.join(parent, `ffmpeg-${bundle.version}`), stage = path.join(parent, `.ffmpeg-${bundle.version}-${randomUUID()}.installing`);
  try { await lstat(destination); throw failure("similarity-tools-install-conflict", "该版本组件目录已存在；请指定已有目录或选择其他安装位置，不会覆盖。", 409); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  signal?.throwIfAborted();
  let archive;
  try { archive = bundle.remoteURL ? await downloadComponent(bundle.remoteURL, { signal, fetcher }) : await readFile(bundle.archivePath); }
  catch (error) { if (signal?.aborted || error?.name === "AbortError") throw error; throw failure("similarity-package-download-failed", "去重组件下载或读取失败，请检查网络后重试或指定已有工具目录。", 503); }
  if (createHash("sha256").update(archive).digest("hex") !== bundle.sha256.toLowerCase()) throw failure("similarity-package-hash-mismatch", "去重组件校验失败，未安装。请重新获取完整发布包。", 422);
  const files = decodeDedupPackageZip(archive, { archiveRoot: bundle.archiveRoot });
  await mkdir(parent, { recursive: true });
  await assertNoLinkedParent(parent);
  await mkdir(stage);
  let committed = false;
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const target = path.join(stage, ...file.name.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx", mode: file.name.endsWith(".exe") ? 0o755 : 0o644 });
    }
    // Keep provenance beside the independent optional program. This does not
    // turn a source revision link into a complete corresponding-source offer.
    await writeFile(path.join(stage, "media-tracker-component-source.json"), JSON.stringify({ schemaVersion: 1,
      version: bundle.version, sha256: bundle.sha256, license: bundle.license || null,
      provider: bundle.provider || null, sourceRevision: bundle.source || null,
      downloadURL: bundle.remoteURL || null, completeCorrespondingSourceVerified: false }, null, 2) + "\n", { flag: "wx" });
    await check({ root, directory: path.join(stage, "bin"), signal });
    signal?.throwIfAborted();
    await assertNoLinkedParent(parent);
    // No replacement: an existing final directory must remain untouched.
    try { await lstat(destination); throw failure("similarity-tools-install-conflict", "组件安装位置已被占用，原目录未修改。", 409); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(stage, destination);
    committed = true;
    return { directory: path.join(destination, "bin"), version: bundle.version };
  } finally {
    if (!committed) {
      // Remove only this operation's unique staging directory; refuse cleanup
      // if an ancestor was replaced with a link/junction during the install.
      try { await assertNoLinkedParent(stage); await rm(stage, { recursive: true, force: true }); } catch {}
    }
  }
}
