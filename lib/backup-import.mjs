// Offline, append-only import. No platform requests and no SyncStore construction.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { clearPersonMediaIndexCache, openPersonMediaIndex } from "./person-media-index.mjs";
import { validPublicationDate } from "./publication-date.mjs";
import { assertReadableRebuildStopped } from "../scripts/rebuild-readable-names.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = /^[a-f0-9]{64}$/;
const MEDIA_FOLDERS = new Set(["image", "video", "gif"]);
const EXTENSIONS = new Map([
  ...[".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".svg"].map((e) => [e, "image"]),
  ...[".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".mpeg", ".mpg", ".3gp", ".ts"].map((e) => [e, "video"]),
]);
const sha = (contents) => createHash("sha256").update(contents).digest("hex");
const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));
const inside = (parent, target) => {
  const relative = path.relative(fold(path.resolve(parent)), fold(path.resolve(target)));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const stamp = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const instant = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
const component = (s) => typeof s === "string" && s.length > 0 && ![".", ".."].includes(s) && !/[\\/\x00-\x1f]/.test(s);
function fail(code, message) { return Object.assign(new Error(message), { code }); }

async function ordinary(target, directory = false) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || !samePath(await realpath(target), target)) {
    throw fail("backup-path-unsafe", `路径不是普通${directory ? "目录" : "文件"}或包含链接：${target}`);
  }
  return info;
}

async function tree(target, { allowMissing = false } = {}) {
  const anchor = path.parse(target).root;
  if (!anchor) throw fail("backup-path-unsafe", "导入需要绝对目录路径。");
  await ordinary(anchor, true); // An unreachable NAS is never an empty directory.
  let current = anchor, missing = false;
  for (const part of path.relative(anchor, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (missing) continue;
    try { await ordinary(current, true); }
    catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; missing = true; }
  }
  return !missing;
}

async function ordinaryRaw(file) { await ordinary(file); return readFile(file); }

async function parallel(items, concurrency, fn) {
  let cursor = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await fn(items[index], index); }
  }));
  return result;
}

/** Recognize common encoded formats; never infer GIF/MP4 from a folder name. */
export function detectBackupFormat(header, fileName) {
  const b = Buffer.from(header), ext = path.extname(fileName).toLowerCase();
  const found = (extension, kind) => ({ extension, kind, formatEvidence: "magic" });
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return found(".jpg", "image");
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return found(".png", "image");
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return found(".gif", "image");
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return found(".webp", "image");
  if (b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp") {
    const boxLength = b.readUInt32BE(0);
    const brands = b.subarray(8, Math.min(b.length, boxLength >= 12 ? boxLength : 64)).toString("ascii");
    if (/avif|avis/.test(brands)) return found(".avif", "image");
    if (/heic|heix|hevc|hevx/.test(brands)) return found(".heic", "image");
    if (/mif1|msf1/.test(brands)) return found(".heif", "image");
    return found(/qt  /.test(brands) ? ".mov" : ".mp4", "video");
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return found(b.includes(Buffer.from("matroska")) ? ".mkv" : ".webm", "video");
  if (b.subarray(0, 2).toString("ascii") === "BM") return found(".bmp", "image");
  if (b.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || b.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return found(".tif", "image");
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "AVI ") return found(".avi", "video");
  if (/^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.toString("utf8"))) return found(".svg", "image");
  // Unrecognized signatures use only an explicitly supported media extension,
  // and the evidence remains visible in the report and source provenance.
  if (EXTENSIONS.has(ext)) return { extension: ext, kind: EXTENSIONS.get(ext), formatEvidence: "extension-fallback" };
  return null;
}

async function digestFile(file, signal) {
  signal?.throwIfAborted();
  const before = await ordinary(file), handle = await open(file, "r");
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
  let bytes = 0, header = Buffer.alloc(0);
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw fail("backup-file-changed", `备份文件在读取前改变：${file}`);
    while (true) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      if (header.length < 512) header = Buffer.concat([header, chunk.subarray(0, 512 - header.length)]);
      hash.update(chunk); bytes += read.bytesRead;
    }
    if (stamp(await handle.stat()) !== stamp(before) || stamp(await ordinary(file)) !== stamp(before)) {
      throw fail("backup-file-changed", `备份文件在读取期间改变：${file}`);
    }
  } finally { await handle.close(); }
  if (!bytes) throw fail("backup-file-empty", `备份媒体为空：${file}`);
  return { sha256: hash.digest("hex"), bytes, header, fileStamp: stamp(before) };
}

function legacyName(fileName) {
  const m = fileName.match(/^(\d{8}|undated)_(.+)_(\d+)\.[^.]+$/i);
  return m ? { date: validPublicationDate(m[1]), postId: m[2], mediaIndex: Number(m[3]) } : { date: null, postId: "", mediaIndex: null };
}

function legacyRelative(value) {
  if (typeof value !== "string") throw fail("backup-manifest-unsafe", "旧清单缺少媒体相对路径。");
  const parts = value.split(/[\\/]/);
  if (parts.length !== 2 || !MEDIA_FOLDERS.has(parts[0].toLowerCase()) || !parts.every(component)) {
    throw fail("backup-manifest-unsafe", "旧清单包含不安全或未知媒体路径。");
  }
  return parts;
}

function canonicalPostUrl(platform, account, postId, kind) {
  if (!postId) return null;
  const handle = String(account.label || account.folderName || "").replace(/^@/, "");
  if (platform.id === "x" && /^\d+$/.test(postId) && /^[\w]+$/.test(handle)) return `https://x.com/${handle}/status/${postId}`;
  if (platform.id === "instagram" && /^[\w-]+$/.test(postId)) return `https://www.instagram.com/p/${postId}/`;
  if (platform.id === "facebook" && /^\d+$/.test(postId)) return `https://www.facebook.com/${postId}`;
  if (platform.id === "tiktok" && /^\d+$/.test(postId) && /^[\w.]+$/.test(handle)) return `https://www.tiktok.com/@${handle}/${kind === "image" ? "photo" : "video"}/${postId}`;
  return null;
}

function safePostUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function knownSourceUrls(index) {
  const result = new Map();
  for (let offset = 0; ; offset += 200) {
    const page = index.list({ offset, limit: 200 });
    for (const asset of page.items) for (const source of index.sources(asset.mediaId)) {
      const key = JSON.stringify([source.platformId, source.accountId, source.logicalKey]);
      const url = safePostUrl(source.postUrl);
      if (url && !result.has(key)) result.set(key, url);
    }
    if (offset + page.items.length >= page.total) break;
  }
  return result;
}

function mappedSources(manifest, person, platform, account) {
  const scope = manifest.scopes[`${person.id}:${platform.id}:${account.id}`];
  const byRelative = new Map(), postCounts = new Map();
  for (const [logicalKey, row] of Object.entries(scope?.media || {})) {
    if (!row || !HASH.test(row.sha256 || "") || !logicalKey) throw fail("backup-manifest-corrupt", "旧媒体清单的哈希或来源标识损坏。");
    const parts = legacyRelative(row.relativePath), key = fold(parts.join(path.sep));
    const parsed = legacyName(parts[1]), postId = String(row.postId || parsed.postId || "");
    const ordinal = (postCounts.get(postId) || 0) + 1; postCounts.set(postId, ordinal);
    const suffix = Number(logicalKey.split(":").at(-1));
    const mediaIndex = Number.isSafeInteger(row.mediaIndex) && row.mediaIndex > 0 ? row.mediaIndex
      : ["x", "tiktok"].includes(platform.id) && Number.isSafeInteger(suffix) && suffix > 0 && suffix <= 10000 ? suffix
        : !row.duplicateOf && parsed.postId === postId && parsed.mediaIndex > 0 ? parsed.mediaIndex : ordinal;
    const record = { row, logicalKey, postId, mediaIndex, createdAt: instant(row.createdAt) || instant(scope.knownPosts?.[postId]), firstSeenAt: instant(row.savedAt) };
    if (!byRelative.has(key)) byRelative.set(key, []);
    byRelative.get(key).push(record);
  }
  return byRelative;
}

function sourcesFor(file, records, person, platform, account, format, importedAt, existingUrls) {
  const parsed = legacyName(path.basename(file));
  if (!records.length) records = [{ logicalKey: `backup-file:${path.basename(file)}`, postId: parsed.postId,
    mediaIndex: parsed.mediaIndex, createdAt: null, firstSeenAt: null }];
  return records.map((record) => {
    // An account-level duplicate can point at another post's physical filename.
    // That file's calendar day remains artifact provenance, not this post's date.
    const legacyDate = record.postId === parsed.postId ? parsed.date : null;
    return { platformId: platform.id, platformLabel: platform.label || platform.id,
    accountId: account.id, accountLabel: account.label || account.folderName || account.id,
    logicalKey: record.logicalKey, postId: record.postId,
    postUrl: existingUrls.get(JSON.stringify([platform.id, account.id, record.logicalKey])) || safePostUrl(record.row?.postUrl)
      || canonicalPostUrl(platform, account, record.postId, format.kind), createdAt: record.createdAt,
    mediaIndex: record.mediaIndex, firstSeenAt: record.firstSeenAt || importedAt,
    publicationDate: record.createdAt ? null : legacyDate, dateBasis: record.createdAt ? "unknown" : legacyDate ? "legacy-filename" : "unknown",
    displayTimeZone: record.createdAt ? null : legacyDate ? "UTC" : null,
    backupImports: [{ backupPath: file, originalFileName: path.basename(file), importedAt,
      legacyPublicationDate: parsed.date, formatEvidence: format.formatEvidence }],
  }; });
}

async function metadata(person, initialized) {
  const directory = path.join(person.folderPath, "Index"), files = [];
  try { await tree(directory); }
  catch (error) { if (error.code === "ENOENT" && !initialized) return files; throw error; }
  for (const name of ["media-index.json", "events.jsonl"]) {
    const file = path.join(directory, name);
    try { const contents = await ordinaryRaw(file); files.push({ file, name, contents, signature: sha(contents) }); }
    catch (error) { if (error.code !== "ENOENT" || initialized) throw error; }
  }
  return files;
}

async function manifestPath(dataDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const names = (await readdir(dataDir)).filter((name) => /^sync-index\.json\.v2-backup-.+\.json$/.test(name));
  if (names.length !== 1) throw fail("backup-manifest-ambiguous", "请用 --manifest 明确指定一个旧 v2 同步清单。");
  return path.join(dataDir, names[0]);
}

async function reviewedVariants(backupRoot, file) {
  if (!file) return { reviewedFile: null, reviewedRaw: null, reviewed: new Map() };
  const reviewedFile = path.resolve(file), reviewedRaw = await ordinaryRaw(reviewedFile), parsed = JSON.parse(reviewedRaw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.variants) || !parsed.variants.length
    || Object.keys(parsed).some((key) => !["version", "variants"].includes(key))) throw fail("backup-review-invalid", "核验授权文件必须是非空 version 1 variants 清单。");
  const reviewed = new Map();
  for (const row of parsed.variants) {
    if (!row || typeof row.backupPath !== "string" || !path.isAbsolute(row.backupPath) || !inside(backupRoot, row.backupPath)
      || samePath(backupRoot, row.backupPath) || !HASH.test(row.expectedSha256 || "") || !HASH.test(row.observedSha256 || "")
      || row.expectedSha256 === row.observedSha256 || row.derivedFromMediaId !== row.expectedSha256
      || !row.originalSource || !["platformId", "accountId", "logicalKey"].every((key) => typeof row.originalSource[key] === "string" && row.originalSource[key].trim())
      || Object.keys(row.originalSource).some((key) => !["platformId", "accountId", "logicalKey"].includes(key))
      || row.evidence?.method !== "local-rotation-reencode" || typeof row.evidence?.details !== "string" || !row.evidence.details.trim() || row.evidence.details.length > 4000
      || Object.keys(row.evidence).some((key) => !["method", "details"].includes(key))
      || Object.keys(row).some((key) => !["backupPath", "expectedSha256", "observedSha256", "derivedFromMediaId", "originalSource", "evidence"].includes(key))) {
      throw fail("backup-review-invalid", "核验授权项的路径、完整哈希、原资产、原来源或本地核验依据无效。");
    }
    const key = fold(path.resolve(row.backupPath));
    if (reviewed.has(key)) throw fail("backup-review-invalid", "核验授权文件包含重复备份路径。");
    await tree(path.dirname(row.backupPath)); await ordinary(row.backupPath);
    reviewed.set(key, { ...row, backupPath: path.resolve(row.backupPath) });
  }
  return { reviewedFile, reviewedRaw, reviewed };
}

async function verifiedVariantSources(ctx, entry, digest, format, current, importedAt, signal) {
  const key = fold(path.resolve(entry.full)), review = ctx.reviewed.get(key);
  if (!review || review.observedSha256 !== digest.sha256 || format.kind !== "image"
    || entry.records.some((record) => record.row.sha256 !== review.expectedSha256)
    || review.originalSource.platformId !== entry.platform.id || review.originalSource.accountId !== entry.account.id) {
    throw fail("backup-hash-mismatch", `备份字节与旧清单 SHA-256 不符且未通过精确核验授权：${entry.full}`);
  }
  const row = entry.records.find((r) => r.logicalKey === review.originalSource.logicalKey && r.row.sha256 === review.expectedSha256);
  const original = current.get(review.derivedFromMediaId);
  if (!row || !original || original.kind !== "image") throw fail("backup-review-invalid", "本地修改副本没有对应旧清单来源或当前原图资产。");
  const originalSource = current.sources(review.derivedFromMediaId).find((s) => s.platformId === review.originalSource.platformId
    && s.accountId === review.originalSource.accountId && s.logicalKey === review.originalSource.logicalKey);
  if (!originalSource || originalSource.postId !== row.postId) throw fail("backup-review-invalid", "本地修改副本的原图没有对应已确认原帖来源。");
  const proof = await digestFile(await current.resolve(review.derivedFromMediaId), signal);
  if (proof.sha256 !== review.derivedFromMediaId || proof.bytes !== original.bytes) throw fail("backup-review-invalid", "本地修改副本的原图实体完整 SHA-256 校验失败。");
  const parsed = legacyName(path.basename(entry.full));
  const dateBasis = ["platform", "session-timezone", "legacy-filename"].includes(originalSource.dateBasis) ? originalSource.dateBasis : "unknown";
  const source = { platformId: originalSource.platformId, platformLabel: originalSource.platformLabel,
    accountId: originalSource.accountId, accountLabel: originalSource.accountLabel,
    logicalKey: `backup-variant:${digest.sha256}:${review.originalSource.logicalKey}`, postId: originalSource.postId,
    postUrl: originalSource.postUrl, createdAt: instant(originalSource.createdAt), mediaIndex: originalSource.mediaIndex,
    publicationDate: originalSource.publicationDate, dateBasis, displayTimeZone: originalSource.displayTimeZone,
    firstSeenAt: importedAt, backupImports: [{ backupPath: entry.full, originalFileName: path.basename(entry.full), importedAt,
      legacyPublicationDate: parsed.date, formatEvidence: format.formatEvidence, attributionEvidence: "local-modified",
      derivedFromMediaId: review.derivedFromMediaId, manifestExpectedSha256: review.expectedSha256, observedSha256: digest.sha256,
      originalSource: { ...review.originalSource }, reviewEvidence: { ...review.evidence } }] };
  ctx.reviewedUses.add(key);
  return { sources: [source], localModified: true, derivedFromMediaId: review.derivedFromMediaId };
}

async function context(options) {
  const dataDir = path.resolve(options.dataDir || path.join(PROJECT_ROOT, "data"));
  const stateFile = path.resolve(options.stateFile || path.join(dataDir, "state.json"));
  const syncFile = path.resolve(options.syncFile || path.join(dataDir, "sync-index.json"));
  if (!options.backupRoot || !path.isAbsolute(options.backupRoot)) throw fail("backup-root-required", "请提供备份根目录的绝对路径。");
  const backupRoot = path.resolve(options.backupRoot);
  await tree(dataDir); await tree(backupRoot);
  if (inside(dataDir, backupRoot) || inside(backupRoot, dataDir)) throw fail("backup-path-overlap", "备份根目录与工具数据目录重叠。");
  const oldFile = await manifestPath(dataDir, options.manifestFile);
  const [stateRaw, syncRaw, manifestRaw] = await Promise.all([ordinaryRaw(stateFile), ordinaryRaw(syncFile), ordinaryRaw(oldFile)]);
  const state = JSON.parse(stateRaw), global = JSON.parse(syncRaw), manifest = JSON.parse(manifestRaw);
  if (!Array.isArray(state.persons) || global.version !== 3 || global.layout !== "person-v1"
    || !global.storageInitialized || manifest.version !== 2 || !manifest.scopes || typeof manifest.scopes !== "object") {
    throw fail("backup-config-invalid", "人物配置、当前人物级索引或旧 v2 清单版本不正确；未导入。");
  }
  const ids = new Set(state.persons.map((p) => p.id));
  if (ids.size !== state.persons.length || (options.personIds || []).some((id) => !ids.has(id))) throw fail("backup-person-invalid", "人物配置重复或选中了不存在的人物。");
  const persons = state.persons.filter((p) => !(options.personIds || []).length || options.personIds.includes(p.id));
  for (const person of persons) {
    if (typeof person.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(person.id)
      || typeof person.folderPath !== "string" || !path.isAbsolute(person.folderPath) || !Array.isArray(person.platforms)) throw fail("backup-person-invalid", "人物标识、路径或平台配置无效。");
    const root = path.resolve(person.folderPath);
    if (samePath(root, path.parse(root).root) || inside(dataDir, root) || inside(root, dataDir) || inside(backupRoot, root) || inside(root, backupRoot)) {
      throw fail("backup-path-overlap", "当前人物目录与共享根、工具数据或备份目录重叠；未导入。");
    }
    for (const other of state.persons) if (other.id !== person.id && (inside(root, other.folderPath) || inside(other.folderPath, root))) {
      throw fail("backup-path-overlap", "人物目录互相重叠；未导入。");
    }
  }
  const review = await reviewedVariants(backupRoot, options.reviewedVariantsFile);
  return { dataDir, stateFile, syncFile, oldFile, backupRoot, stateRaw, syncRaw, manifestRaw, state, global, manifest, persons,
    ...review, reviewedUses: new Set() };
}

async function checkUnchanged(ctx, plans = []) {
  for (const [file, original] of [[ctx.stateFile, ctx.stateRaw], [ctx.syncFile, ctx.syncRaw], [ctx.oldFile, ctx.manifestRaw],
    ...(ctx.reviewedFile ? [[ctx.reviewedFile, ctx.reviewedRaw]] : [])]) {
    if (!Buffer.from(await ordinaryRaw(file)).equals(original)) throw fail("backup-external-change", "导入期间配置、全局同步索引或旧清单发生变化，已停止；不会覆盖这些文件。");
  }
  for (const plan of plans) {
    await checkPersonUnchanged(plan, !!ctx.global.storageInitialized[plan.person.id]);
  }
}

async function checkPersonUnchanged(plan, initialized) {
  const now = await metadata(plan.person, initialized);
  if (JSON.stringify(now.map((f) => [f.name, f.signature])) !== JSON.stringify(plan.metadata.map((f) => [f.name, f.signature]))) {
    throw fail("backup-external-change", `人物 ${plan.person.name} 的 Index 已改变，未覆盖。`);
  }
}

async function planPerson(ctx, person, options) {
  const report = { personId: person.id, name: person.name, mediaFiles: 0, mediaBytes: 0, missingAssets: 0,
    existingAssets: 0, sources: 0, ignoredFiles: 0, fallbackFormats: 0, localModified: 0, errors: [], warnings: [] };
  const plan = { person, report, entries: [], metadata: [] };
  try {
    options.signal?.throwIfAborted();
    await tree(person.folderPath, { allowMissing: !ctx.global.storageInitialized[person.id] });
    plan.metadata = await metadata(person, !!ctx.global.storageInitialized[person.id]);
    clearPersonMediaIndexCache(person.id);
    const current = await openPersonMediaIndex(person, { requireExisting: !!ctx.global.storageInitialized[person.id] });
    const existingUrls = knownSourceUrls(current);
    const names = [...new Set([person.name, path.basename(person.folderPath)].filter(component))], candidates = [];
    for (const name of names) {
      const directory = path.join(ctx.backupRoot, name);
      try { await tree(directory); candidates.push(directory); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (candidates.length !== 1) throw fail("backup-person-directory", candidates.length ? "备份中匹配到了多个同人物目录，请先消除歧义。" : "备份中未找到该配置人物目录。");
    const backupPersonRoot = candidates[0], filePlans = [], recognizedPlatforms = new Set();
    for (const platform of person.platforms) {
      if (!component(platform.label || platform.id) || !Array.isArray(platform.accounts)) throw fail("backup-platform-invalid", "平台目录名无效。");
      const platformDirectory = path.join(backupPersonRoot, platform.label || platform.id);
      recognizedPlatforms.add(fold(path.basename(platformDirectory)));
      let platformExists = true;
      try { await tree(platformDirectory); } catch (error) { if (error.code !== "ENOENT") throw error; platformExists = false; }
      const recognizedAccounts = new Set();
      for (const account of platform.accounts) {
        if (!component(account.folderName || account.label)) throw fail("backup-account-invalid", "旧账号目录名无效。");
        const folderName = account.folderName || account.label, accountRoot = path.join(platformDirectory, folderName);
        recognizedAccounts.add(fold(folderName));
        const rows = mappedSources(ctx.manifest, person, platform, account), found = new Set();
        if (!platformExists) { if (rows.size) report.errors.push(`旧清单中的平台目录不存在：${platform.label || platform.id}`); continue; }
        try { await tree(accountRoot); }
        catch (error) { if (error.code !== "ENOENT") throw error; if (rows.size) report.errors.push(`旧清单中的账号目录不存在：${folderName}`); continue; }
        for (const folder of await readdir(accountRoot, { withFileTypes: true })) {
          if (!MEDIA_FOLDERS.has(folder.name.toLowerCase())) { report.ignoredFiles++; continue; }
          const mediaDirectory = path.join(accountRoot, folder.name); await tree(mediaDirectory);
          for (const file of await readdir(mediaDirectory, { withFileTypes: true })) {
            const full = path.join(mediaDirectory, file.name), relative = fold(path.join(folder.name, file.name));
            if (["thumbs.db", "desktop.ini"].includes(file.name.toLowerCase()) || !EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
              report.ignoredFiles++; continue;
            }
            await ordinary(full);
            found.add(relative); filePlans.push({ full, records: rows.get(relative) || [], platform, account });
          }
        }
        for (const relative of rows.keys()) if (!found.has(relative)) report.errors.push(`旧清单媒体不存在或格式不支持：${platform.label}/${folderName}/${relative}`);
      }
      if (platformExists) for (const extra of await readdir(platformDirectory, { withFileTypes: true })) if (!recognizedAccounts.has(fold(extra.name))) {
        report.warnings.push(`未绑定的旧账号目录未导入：${platform.label}/${extra.name}`);
      }
    }
    for (const extra of await readdir(backupPersonRoot, { withFileTypes: true })) if (!recognizedPlatforms.has(fold(extra.name))) {
      report.ignoredFiles++; if (extra.isDirectory() && !["Index"].includes(extra.name)) report.warnings.push(`未匹配的备份目录未导入：${extra.name}`);
    }
    const seenHashes = new Set(); let completed = 0;
    for (const entry of filePlans) {
      options.signal?.throwIfAborted();
      try {
        const digest = await digestFile(entry.full, options.signal), format = detectBackupFormat(digest.header, entry.full);
        if (!format) throw fail("backup-format-unknown", `无法确定媒体格式：${entry.full}`);
        let variant = { sources: sourcesFor(entry.full, entry.records, person, entry.platform, entry.account, format, options.importedAt, existingUrls), localModified: false };
        if (entry.records.some((record) => record.row.sha256 !== digest.sha256)) {
          variant = await verifiedVariantSources(ctx, entry, digest, format, current, options.importedAt, options.signal);
        } else if (ctx.reviewed.has(fold(path.resolve(entry.full)))) throw fail("backup-review-invalid", "核验授权文件对应的媒体并非指定的不符哈希副本。");
        const { sources } = variant;
        const existing = await current.has(digest.sha256);
        if (existing && current.get(digest.sha256).bytes !== digest.bytes) throw fail("backup-hash-collision", "相同哈希出现不同大小，未合并。");
        plan.entries.push({ ...entry, ...digest, header: undefined, ...format, ...variant, existing });
        report.mediaFiles++; report.mediaBytes += digest.bytes; report.sources += sources.length;
        if (variant.localModified) report.localModified++;
        if (format.formatEvidence === "extension-fallback") report.fallbackFormats++;
        if (!seenHashes.has(digest.sha256)) { report[existing ? "existingAssets" : "missingAssets"]++; seenHashes.add(digest.sha256); }
      } catch (error) { if (options.signal?.aborted) throw error; report.errors.push(error.message); }
      completed++;
      if (completed === filePlans.length || completed % 100 === 0) options.onProgress?.({ phase: "hash", personId: person.id, name: person.name, completed, total: filePlans.length });
    }
  } catch (error) { if (options.signal?.aborted) throw error; report.errors.push(error.message); plan.entries = []; }
  report.eligible = !report.errors.length;
  return plan;
}

async function makePlans(ctx, options) {
  const plans = await parallel(ctx.persons, options.concurrency || 2, (person) => planPerson(ctx, person, options));
  if (ctx.reviewed.size !== ctx.reviewedUses.size) throw fail("backup-review-invalid", "有核验授权项未能匹配所选人物、实际字节、旧来源或完整原图；未开始导入。");
  return plans;
}

function publicReport(ctx, plans, mode, importedAt) {
  return { version: 1, mode, importedAt, backupRoot: ctx.backupRoot, manifestFile: ctx.oldFile,
    reviewedVariantsFile: ctx.reviewedFile, reviewedVariantsSha256: ctx.reviewedRaw ? sha(ctx.reviewedRaw) : null,
    stateSha256: sha(ctx.stateRaw), syncIndexSha256: sha(ctx.syncRaw),
    persons: plans.map((p) => p.report), totals: plans.reduce((sum, p) => {
      for (const key of ["mediaFiles", "mediaBytes", "missingAssets", "existingAssets", "sources", "ignoredFiles", "fallbackFormats", "localModified"]) sum[key] += p.report[key];
      return sum;
    }, { mediaFiles: 0, mediaBytes: 0, missingAssets: 0, existingAssets: 0, sources: 0, ignoredFiles: 0, fallbackFormats: 0, localModified: 0 }),
    configurationUnchanged: true, globalIndexUnchanged: true };
}

async function writeExact(file, contents) {
  const handle = await open(file, "wx");
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  if (!Buffer.from(await readFile(file)).equals(Buffer.from(contents))) throw fail("backup-verification-failed", "导入前的原字节备份校验失败，未修改人物索引。");
}

async function backupBeforeImport(ctx, plans, importedAt) {
  const backupDirectory = path.join(ctx.dataDir, "backups", `media-import-${importedAt.replace(/[:.]/g, "-")}-${randomUUID()}`);
  try { await tree(path.dirname(backupDirectory)); }
  catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(path.dirname(backupDirectory)); await tree(path.dirname(backupDirectory)); }
  await mkdir(backupDirectory);
  await writeExact(path.join(backupDirectory, "state.json"), ctx.stateRaw);
  await writeExact(path.join(backupDirectory, "sync-index.json"), ctx.syncRaw);
  await writeExact(path.join(backupDirectory, "legacy-v2-sync-index.json"), ctx.manifestRaw);
  if (ctx.reviewedRaw) await writeExact(path.join(backupDirectory, "reviewed-variants.json"), ctx.reviewedRaw);
  for (const plan of plans) {
    const destination = path.join(backupDirectory, plan.person.id); await mkdir(destination);
    for (const file of plan.metadata) await writeExact(path.join(destination, file.name), file.contents);
  }
  await writeExact(path.join(backupDirectory, "backup-manifest.json"), `${JSON.stringify({ version: 1, importedAt,
    files: [{ originalPath: ctx.stateFile, backupPath: "state.json", sha256: sha(ctx.stateRaw) },
      { originalPath: ctx.syncFile, backupPath: "sync-index.json", sha256: sha(ctx.syncRaw) },
      ...plans.flatMap((p) => p.metadata.map((f) => ({ originalPath: f.file, backupPath: path.join(p.person.id, f.name), sha256: f.signature })))] })}\n`);
  return backupDirectory;
}

async function copyPartial(entry, person, signal) {
  signal?.throwIfAborted();
  await tree(person.folderPath);
  if (stamp(await ordinary(entry.full)) !== entry.fileStamp) throw fail("backup-file-changed", `备份文件在复制前改变：${entry.full}`);
  const partialPath = path.join(person.folderPath, `.media-tracker-import-${randomUUID()}.part`);
  let source, target, created = false, bytes = 0;
  try {
    source = await open(entry.full, "r");
    target = await open(partialPath, "wx"); created = true;
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    if (stamp(await source.stat()) !== entry.fileStamp) throw fail("backup-file-changed", "备份文件在打开时发生变化。");
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) throw fail("backup-short-write", "导入临时文件未能完整写入。");
        offset += bytesWritten;
      }
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256 || stamp(await ordinary(entry.full)) !== entry.fileStamp) {
      throw fail("backup-file-changed", "复制时备份文件发生变化或校验失败；未提交副本。");
    }
    await target.sync();
    return partialPath;
  } catch (error) {
    await target?.close().catch(() => {});
    if (created) await unlink(partialPath).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([source?.close(), target?.close()]);
  }
}

async function applyPerson(ctx, plan, options) {
  const report = plan.report;
  Object.assign(report, { copiedAssets: 0, reusedFiles: 0, sourceUpdates: 0, localModifiedCopied: 0, localModifiedReused: 0, files: [], completed: false });
  try {
    options.signal?.throwIfAborted();
    await tree(plan.person.folderPath, { allowMissing: !ctx.global.storageInitialized[plan.person.id] });
    await checkPersonUnchanged(plan, !!ctx.global.storageInitialized[plan.person.id]);
    clearPersonMediaIndexCache(plan.person.id);
    const index = await openPersonMediaIndex(plan.person, { create: !ctx.global.storageInitialized[plan.person.id],
      requireExisting: !!ctx.global.storageInitialized[plan.person.id], writable: true, signal: options.signal });
    let completed = 0;
    for (const entry of plan.entries) {
      options.signal?.throwIfAborted();
      let partialPath;
      try {
        if (stamp(await ordinary(entry.full)) !== entry.fileStamp) throw fail("backup-file-changed", `备份文件在导入前改变：${entry.full}`);
        const beforeSources = index.get(entry.sha256) ? index.sources(entry.sha256) : [];
        if (entry.localModified) await verifiedVariantSources(ctx, entry, entry, entry, index, options.importedAt, options.signal);
        const beforeByKey = new Map(beforeSources.map((s) => [JSON.stringify([s.platformId, s.accountId, s.logicalKey]), JSON.stringify(s)]));
        const hadFile = await index.has(entry.sha256);
        if (hadFile) {
          if (index.get(entry.sha256).bytes !== entry.bytes) throw fail("backup-hash-collision", "相同哈希出现不同大小，未合并。");
          for (const source of entry.sources) await index.addSource(entry.sha256, source, { signal: options.signal });
          report.reusedFiles++;
          if (entry.localModified) report.localModifiedReused++;
        } else {
          partialPath = await copyPartial(entry, plan.person, options.signal);
          const result = await index.commitDownloaded({ partialPath, sha256: entry.sha256, bytes: entry.bytes,
            extension: entry.extension, mediaKind: entry.kind, source: entry.sources[0] }, { signal: options.signal });
          partialPath = null;
          if (result.status === "downloaded") { report.copiedAssets++; if (entry.localModified) report.localModifiedCopied++; }
          else { report.reusedFiles++; if (entry.localModified) report.localModifiedReused++; }
          for (const source of entry.sources.slice(1)) await index.addSource(entry.sha256, source, { signal: options.signal });
        }
        report.sourceUpdates += index.sources(entry.sha256).filter((s) => beforeByKey.get(JSON.stringify([s.platformId, s.accountId, s.logicalKey])) !== JSON.stringify(s)).length;
        report.files.push({ backupPath: entry.full, mediaId: entry.sha256, bytes: entry.bytes, kind: entry.kind,
          formatEvidence: entry.formatEvidence, action: hadFile ? "sources-merged" : "copied", sourceCount: entry.sources.length,
          ...(entry.localModified ? { attributionEvidence: "local-modified", derivedFromMediaId: entry.derivedFromMediaId,
            manifestExpectedSha256: entry.derivedFromMediaId, observedSha256: entry.sha256 } : {}) });
      } catch (error) { if (options.signal?.aborted) throw error; report.errors.push(error.message); }
      finally { if (partialPath) await unlink(partialPath).catch(() => {}); }
      completed++;
      if (completed === plan.entries.length || completed % 100 === 0) options.onProgress?.({ phase: "import", personId: plan.person.id, name: plan.person.name, completed, total: plan.entries.length });
    }
    try {
      const naming = await index.finalizeNaming({ signal: options.signal }); report.naming = naming;
      await index.compact();
      for (const file of report.files) file.relativePath = index.get(file.mediaId)?.relativePath || null;
    } catch (error) { report.errors.push(`命名整理未完成：${error.message}`); }
    report.completed = !report.errors.length;
  } catch (error) { report.errors.push(error.message); report.cancelled = !!options.signal?.aborted; }
  report.eligible = !report.errors.length;
}

export async function runBackupImport(options = {}) {
  const importedAt = instant(options.importedAt) || new Date().toISOString();
  const concurrency = Math.max(1, Math.min(8, Number.isInteger(options.concurrency) ? options.concurrency : 2));
  options = { ...options, importedAt, concurrency };
  const ctx = await context(options);
  if (!options.apply) {
    const plans = await makePlans(ctx, options); await checkUnchanged(ctx, plans);
    return publicReport(ctx, plans, "preview", importedAt);
  }
  const assertStopped = options.assertStopped || assertReadableRebuildStopped;
  await assertStopped();
  const lockPath = path.join(ctx.dataDir, ".readable-names-maintenance.lock"), token = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw fail("backup-maintenance-busy", "工具启动或其他维护操作正在占用维护锁；未导入。"); throw error; }
  let report, plans = [], backupDirectory;
  try {
    await lock.writeFile(JSON.stringify({ token, pid: process.pid, operation: "backup-import", startedAt: importedAt })); await lock.sync();
    await assertStopped(); await checkUnchanged(ctx);
    plans = await makePlans(ctx, options);
    await checkUnchanged(ctx, plans); await assertStopped(); options.signal?.throwIfAborted();
    const eligible = plans.filter((p) => p.report.eligible && p.entries.length);
    if (eligible.length) {
      backupDirectory = await backupBeforeImport(ctx, eligible, importedAt);
      await checkUnchanged(ctx, plans); await assertStopped();
      await parallel(eligible, concurrency, (plan) => applyPerson(ctx, plan, options));
    }
    report = publicReport(ctx, plans, "apply", importedAt);
    report.backupDirectory = backupDirectory || null;
    report.cancelled = !!options.signal?.aborted;
    report.completed = !report.cancelled && plans.every((p) => p.report.eligible && (!p.entries.length || p.report.completed));
    await checkUnchanged(ctx); // Global increment boundaries and all config remain byte-identical.
    if (backupDirectory) {
      report.reportFile = path.join(backupDirectory, "import-report.json");
      await writeExact(report.reportFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    await lock.close();
    const owner = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
    if (owner.token === token) await unlink(lockPath);
  }
}

export const previewBackupImport = (options = {}) => runBackupImport({ ...options, apply: false });
export const importBackupMedia = (options = {}) => runBackupImport({ ...options, apply: true });
