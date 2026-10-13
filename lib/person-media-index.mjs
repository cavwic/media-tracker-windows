import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { NAMING_VERSION, HASH_LENGTHS, assetDate, namingSource, namingGroups, parseMediaFilename, personLabel, readableRelativePath, validPublicationDate } from "./media-naming.mjs";
import { normalizePublicationDate, validPublicationDate as normalizeLegacyPublicationDate } from "./publication-date.mjs";

const INDEX_VERSION = 3;
const LAYOUT = "person-v1";
const HASH = /^[a-f0-9]{64}$/;
const EXTENSION = /^\.[a-z0-9]{1,12}$/;
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".mpeg", ".mpg", ".3gp", ".ts"]);
const PUBLICATION_INSTANT_BASES = new Set(["created-at-utc", "created-at-beijing"]);
const COLLECTION_DATE_BASES = new Set(["first-collected-utc", "first-collected-beijing"]);
const indexes = new Map();

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function cancelled(signal) {
  signal?.throwIfAborted();
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function metadataStamp(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function emptyIndex(personId) {
  return { version: INDEX_VERSION, layout: LAYOUT, personId, appliedSeq: 0, assets: {}, aliases: {}, pendingMerges: {}, pendingRenames: {}, dirtyNamingGroups: [] };
}

function mediaKind(extension, fallback) {
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if ([".gif", ".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".svg"].includes(extension)) return "image";
  return fallback === "video" ? "video" : "image";
}

function sourceKey(source) {
  return JSON.stringify([source.platformId, source.accountId, source.logicalKey]);
}

function absoluteInstant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeBackupImports(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw failure("invalid-media-source", "备份导入来源记录损坏。");
  const byPath = new Map();
  for (const entry of values) {
    if (!entry || typeof entry.backupPath !== "string" || !path.isAbsolute(entry.backupPath)
      || typeof entry.originalFileName !== "string" || !entry.originalFileName || /[\\/\x00-\x1f]/.test(entry.originalFileName)
      || !absoluteInstant(entry.importedAt) || !["magic", "extension-fallback"].includes(entry.formatEvidence)) {
      throw failure("invalid-media-source", "备份导入来源包含无效路径、时间或格式依据。");
    }
    const normalized = { backupPath: entry.backupPath, originalFileName: entry.originalFileName,
      importedAt: entry.importedAt, legacyPublicationDate: normalizeLegacyPublicationDate(entry.legacyPublicationDate), formatEvidence: entry.formatEvidence };
    if (entry.attributionEvidence !== undefined) {
      if (entry.attributionEvidence !== "local-modified" || !HASH.test(entry.manifestExpectedSha256 || "") || !HASH.test(entry.observedSha256 || "")
        || entry.derivedFromMediaId !== entry.manifestExpectedSha256 || entry.observedSha256 === entry.manifestExpectedSha256
        || !entry.originalSource || !["platformId", "accountId", "logicalKey"].every((k) => typeof entry.originalSource[k] === "string" && entry.originalSource[k].trim())
        || entry.reviewEvidence?.method !== "local-rotation-reencode" || typeof entry.reviewEvidence?.details !== "string"
        || !entry.reviewEvidence.details.trim() || entry.reviewEvidence.details.length > 4000) {
        throw failure("invalid-media-source", "本地修改副本的哈希、原始来源或核验依据损坏。");
      }
      Object.assign(normalized, { attributionEvidence: "local-modified", derivedFromMediaId: entry.derivedFromMediaId,
        manifestExpectedSha256: entry.manifestExpectedSha256, observedSha256: entry.observedSha256,
        originalSource: { platformId: entry.originalSource.platformId, accountId: entry.originalSource.accountId, logicalKey: entry.originalSource.logicalKey },
        reviewEvidence: { method: entry.reviewEvidence.method, details: entry.reviewEvidence.details } });
    }
    const key = process.platform === "win32" ? entry.backupPath.toLowerCase() : entry.backupPath;
    const previous = byPath.get(key);
    if (!previous || Date.parse(normalized.importedAt) < Date.parse(previous.importedAt)) byPath.set(key, normalized);
  }
  return [...byPath.values()];
}

function validateSourceAsset(source, mediaId) {
  const origins = source.originMediaIds || [mediaId];
  for (const provenance of source.backupImports || []) if (provenance.attributionEvidence === "local-modified"
    && (!origins.includes(provenance.observedSha256) || source.platformId !== provenance.originalSource.platformId || source.accountId !== provenance.originalSource.accountId
      || source.logicalKey !== `backup-variant:${provenance.observedSha256}:${provenance.originalSource.logicalKey}`)) {
    throw failure("invalid-media-source", "本地修改副本必须使用真实资产哈希及独立备份来源标识。");
  }
}

function normalizeSource(source, firstSeenAt = new Date().toISOString()) {
  if (!source || !["platformId", "accountId", "logicalKey"].every((key) => typeof source[key] === "string" && source[key].trim())) {
    throw failure("invalid-media-source", "媒体来源缺少平台、账号或媒体标识。");
  }
  let postUrl = null;
  if (source.postUrl) {
    try {
      const url = new URL(source.postUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) postUrl = url.href;
    } catch {}
  }
  const sourceSeen = absoluteInstant(source.firstSeenAt), defaultSeen = absoluteInstant(firstSeenAt);
  firstSeenAt = sourceSeen && (!defaultSeen || Date.parse(sourceSeen) < Date.parse(defaultSeen)) ? sourceSeen : defaultSeen || new Date().toISOString();
  const backupImports = normalizeBackupImports(source.backupImports);
  if (source.originMediaIds !== undefined && (!Array.isArray(source.originMediaIds) || !source.originMediaIds.length
    || source.originMediaIds.some((id) => !HASH.test(id)) || new Set(source.originMediaIds).size !== source.originMediaIds.length)) {
    throw failure("invalid-media-source", "媒体来源的原始版本哈希记录损坏。");
  }
  return {
    platformId: source.platformId, platformLabel: String(source.platformLabel || source.platformId),
    accountId: source.accountId, accountLabel: String(source.accountLabel || source.accountId),
    logicalKey: source.logicalKey, postId: String(source.postId || ""), postUrl,
    createdAt: source.createdAt || null, mediaIndex: source.mediaIndex ?? null,
    ...normalizePublicationDate({ ...source, ...(backupImports.length ? { backupImports } : {}), firstSeenAt }),
    firstSeenAt,
    ...(backupImports.length ? { backupImports } : {}),
    ...(source.originMediaIds ? { originMediaIds: [...source.originMediaIds] } : {}),
  };
}

function validateAsset(asset, id) {
  if (!asset || !HASH.test(id) || asset.mediaId !== id || asset.sha256 !== id
    || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
    || !EXTENSION.test(asset.extension) || !["image", "video"].includes(asset.kind)
    || typeof asset.savedAt !== "string" || !Number.isFinite(Date.parse(asset.savedAt))) {
    throw failure("media-index-corrupt", "人物媒体索引中的资产记录损坏；本次未重置索引。");
  }
  const folder = asset.kind === "video" ? "Video" : "Image";
  const filename = path.basename(asset.relativePath || "");
  const parsed = parseMediaFilename(filename);
  if (!parsed || asset.relativePath !== path.join(folder, filename) || parsed.extension !== asset.extension || !id.startsWith(parsed.hashPrefix)) {
    throw failure("media-index-corrupt", "人物媒体索引包含不安全或不符合统一目录规则的路径。");
  }
  if (parsed.namingVersion && (asset.namingVersion !== NAMING_VERSION || typeof asset.personLabel !== "string"
    || asset.publicationDate !== parsed.publicationDate || asset.daySequence !== parsed.daySequence || asset.sequenceWidth !== parsed.sequenceWidth)) {
    throw failure("media-index-corrupt", "人物媒体可读名称与命名记录不一致。");
  }
  if (asset.similarityFingerprint) validateFingerprint(asset.similarityFingerprint, id, asset.bytes);
}

function recordOf(asset) { const { sources, ...record } = asset; return record; }

function groupKey(asset) { return `${asset.kind}\0${assetDate(asset) || "日期未知"}`; }

function savedGroupKey(asset) { return `${asset.kind}\0${asset.publicationDate || "日期未知"}`; }

function namingDateChanged(asset) { return asset.namingVersion === NAMING_VERSION && asset.publicationDate !== assetDate(asset); }

function rankStamp(asset) {
  const representative = namingSource(asset);
  return representative ? JSON.stringify([representative.publicationDate, representative.dateBasis, representative.createdAt, representative.platformId, representative.accountId,
    representative.postId, representative.mediaIndex, representative.logicalKey]) : "";
}

function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.some((key) => typeof key !== "string" || !/^(image|video)\0(?:\d{8}|日期未知)$/.test(key)
    || (key.split("\0")[1] !== "日期未知" && !validPublicationDate(key.split("\0")[1]))) || new Set(groups).size !== groups.length) {
    throw failure("media-index-corrupt", "人物媒体待整理日期组损坏。");
  }
}

function mergeSource(previous, incoming) {
  if (!previous) return incoming;
  const incomingTimestamp = PUBLICATION_INSTANT_BASES.has(normalizePublicationDate({ ...incoming, firstSeenAt: null }).dateBasis);
  const previousTimestamp = PUBLICATION_INSTANT_BASES.has(normalizePublicationDate({ ...previous, firstSeenAt: null }).dateBasis);
  const firstSeenAt = [previous.firstSeenAt, incoming.firstSeenAt].filter(absoluteInstant).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || incoming.firstSeenAt;
  const backupImports = normalizeBackupImports([...(previous.backupImports || []), ...(incoming.backupImports || [])]);
  const result = { ...incoming, firstSeenAt, ...(backupImports.length ? { backupImports } : {}), postUrl: incoming.postUrl || previous.postUrl || null,
    createdAt: incomingTimestamp ? incoming.createdAt : previousTimestamp ? previous.createdAt : incoming.createdAt || previous.createdAt || null };
  if (previous.originMediaIds || incoming.originMediaIds) result.originMediaIds = [...new Set([...(previous.originMediaIds || []), ...(incoming.originMediaIds || [])])].sort();
  // A rescan may omit both the timestamp and calendar-only date. Retain earlier
  // real publication evidence instead of replacing it with the collection day.
  if (previous.publicationDate && !COLLECTION_DATE_BASES.has(previous.dateBasis)
    && (!incoming.publicationDate || COLLECTION_DATE_BASES.has(incoming.dateBasis) || incoming.dateBasis === "unknown")) {
    result.publicationDate = previous.publicationDate;
    result.dateBasis = previous.dateBasis;
    result.displayTimeZone = previous.displayTimeZone;
  }
  return { ...result, ...normalizePublicationDate(result) };
}

function boundedJson(value, maximum, code) {
  let json;
  try { json = JSON.stringify(value); } catch {}
  if (!value || typeof value !== "object" || Array.isArray(value) || !json || Buffer.byteLength(json) > maximum) {
    throw failure(code, "本地媒体比对记录无效或过大。");
  }
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure(code, "本地媒体比对记录必须为 JSON 对象。");
  return parsed;
}

function validateFingerprint(value, id, bytes) {
  boundedJson(value, 300 * 1024, "media-fingerprint-invalid");
  const stamp = value.fileStamp;
  if (!stamp || stamp.sha256 !== id || stamp.bytes !== bytes || !Number.isFinite(stamp.mtimeMs) || !Number.isFinite(stamp.ctimeMs)) {
    throw failure("media-index-corrupt", "媒体指纹缺少真实文件哈希和时间戳。");
  }
}

function validateAlias(alias, id) {
  validateAsset(alias, id);
  if (!HASH.test(alias.canonicalMediaId || "") || alias.canonicalMediaId === id || !absoluteInstant(alias.mergedAt)
    || !/^[a-f0-9-]{36}$/.test(alias.batchId || "")
    || alias.archivePath !== path.join("Index", "DedupArchive", alias.batchId, path.basename(alias.relativePath))) {
    throw failure("media-index-corrupt", "媒体版本映射包含无效目标或归档路径。");
  }
  boundedJson(alias.evidence, 64 * 1024, "media-index-corrupt");
  if (alias.similarityFingerprint) validateFingerprint(alias.similarityFingerprint, id, alias.bytes);
  if (!alias.originalSources || typeof alias.originalSources !== "object" || Array.isArray(alias.originalSources)) {
    throw failure("media-index-corrupt", "媒体版本缺少原始来源记录。");
  }
  for (const [key, source] of Object.entries(alias.originalSources)) {
    const normalized = normalizeSource(source, source.firstSeenAt || alias.savedAt);
    validateSourceAsset(normalized, id);
    if (key !== sourceKey(normalized)) throw failure("media-index-corrupt", "媒体版本的原始来源标识损坏。");
  }
}

function validateMergeBatch(batch) {
  if (!batch || !/^[a-f0-9-]{36}$/.test(batch.id || "") || !HASH.test(batch.winnerId || "")
    || !absoluteInstant(batch.createdAt) || !Array.isArray(batch.entries) || !batch.entries.length) {
    throw failure("media-journal-corrupt", "媒体版本合并批次损坏。");
  }
  boundedJson(batch.evidence, 64 * 1024, "media-journal-corrupt");
  const ids = new Set(), destinations = new Set();
  for (const entry of batch.entries) {
    validateAsset(entry.asset, entry.mediaId);
    if (entry.asset.sources || entry.fromPath !== entry.asset.relativePath || entry.mediaId === batch.winnerId || ids.has(entry.mediaId)
      || entry.archivePath !== path.join("Index", "DedupArchive", batch.id, path.basename(entry.fromPath)) || destinations.has(entry.archivePath)) {
      throw failure("media-journal-corrupt", "媒体合并批次包含不安全路径或重复资产。");
    }
    ids.add(entry.mediaId); destinations.add(entry.archivePath);
  }
}

function validateBatch(batch) {
  if (!batch || typeof batch.id !== "string" || !/^[a-f0-9-]{36}$/.test(batch.id) || !Array.isArray(batch.entries) || !batch.entries.length) {
    throw failure("media-journal-corrupt", "人物媒体改名批次损坏。");
  }
  validateGroups(batch.groups);
  const ids = new Set(), paths = new Set(), temporaryPaths = new Set();
  for (const entry of batch.entries) {
    validateAsset(entry.asset, entry.mediaId);
    const folder = entry.asset.kind === "video" ? "Video" : "Image";
    const old = parseMediaFilename(path.basename(entry.fromPath || ""));
    const temporary = path.basename(entry.temporaryPath || "");
    if (!old || entry.fromPath !== path.join(folder, path.basename(entry.fromPath)) || !entry.mediaId.startsWith(old.hashPrefix)
      || old.extension !== entry.asset.extension || entry.temporaryPath !== path.join(folder, temporary)
      || !new RegExp(`^\\.mt-[a-f0-9]{16}\\${entry.asset.extension}$`).test(temporary) || entry.toPath !== entry.asset.relativePath
      || ids.has(entry.mediaId) || paths.has(entry.toPath) || temporaryPaths.has(entry.temporaryPath)) {
      throw failure("media-journal-corrupt", "人物媒体改名批次包含不安全或重复路径。");
    }
    ids.add(entry.mediaId); paths.add(entry.toPath); temporaryPaths.add(entry.temporaryPath);
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw failure("index-short-write", "人物媒体索引未能完整写入。");
    offset += bytesWritten;
  }
}

async function durableReplace(filePath, data) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await writeAll(handle, Buffer.from(data));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function hashFile(filePath, signal) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { signal });
  for await (const chunk of stream) { cancelled(signal); hash.update(chunk); }
  return hash.digest("hex");
}

async function assertRoot(root, create) {
  try {
    if (!(await stat(root)).isDirectory()) throw failure("person-folder-invalid", "人物路径不是文件夹。");
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    // In particular, do not interpret an unavailable NAS as permission to build an empty replacement.
    const anchor = path.parse(root).root;
    if (!anchor || !(await stat(anchor)).isDirectory()) throw failure("person-share-unavailable", "人物目录所在磁盘或网络共享不可访问。");
    await mkdir(root, { recursive: true });
  }
}

class PersonMediaIndex {
  constructor(person) {
    if (!person?.id || typeof person.folderPath !== "string" || !path.isAbsolute(person.folderPath)) {
      throw failure("person-folder-invalid", "人物媒体索引需要人物标识和绝对目录路径。");
    }
    this.personId = String(person.id);
    this.personLabel = personLabel(person.name || path.basename(person.folderPath));
    this.root = path.resolve(person.folderPath);
    this.directory = path.join(this.root, "Index");
    this.snapshotPath = path.join(this.directory, "media-index.json");
    this.journalPath = path.join(this.directory, "events.jsonl");
    this.data = emptyIndex(this.personId);
    this.queue = Promise.resolve();
    this.initialized = false;
    this.needsReload = false;
    this.needsTailRepair = false;
    this.allowInitialize = false;
    this.hasSnapshot = false;
    this.hasJournal = false;
    this.orphansRecovered = false;
    this.snapshotStamp = null;
    this.writingSnapshot = false;
    this.physicalPaths = new Map();
  }

  run(operation) {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }

  async load({ create, signal }) {
    cancelled(signal);
    await assertRoot(this.root, create);
    this.allowInitialize ||= create;
    let info;
    try { info = await lstat(this.directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!info) {
      if (!create) return;
      await mkdir(this.directory);
    } else if (!info.isDirectory() || info.isSymbolicLink()) {
      throw failure("media-index-unsafe", "Index 必须是人物目录内的普通文件夹。");
    }
    const resolvedRoot = await realpath(this.root);
    if (!within(resolvedRoot, await realpath(this.directory))) throw failure("media-index-unsafe", "Index 路径位于人物目录之外。");
    if (this.hasSnapshot) await this.assertMetadataFile(this.snapshotPath);
    if (this.hasJournal) await this.assertMetadataFile(this.journalPath);
    this.data = emptyIndex(this.personId);
    this.hasSnapshot = false;
    this.hasJournal = false;
    this.orphansRecovered = false;
    this.snapshotStamp = null;
    this.physicalPaths.clear();
    try {
      await this.assertMetadataFile(this.snapshotPath);
      const snapshot = JSON.parse(await readFile(this.snapshotPath, "utf8"));
      if (snapshot.personId !== this.personId) throw failure("media-index-owner-conflict", "该目录的 Index 属于另一个人物，请选择其他目录；原索引未修改。");
      if (![1, 2, INDEX_VERSION].includes(snapshot.version) || snapshot.layout !== LAYOUT || !Number.isSafeInteger(snapshot.appliedSeq) || snapshot.appliedSeq < 0
        || !snapshot.assets || Array.isArray(snapshot.assets) || typeof snapshot.assets !== "object") {
        throw failure("media-index-corrupt", "人物媒体索引版本或内容损坏；本次未重置索引。");
      }
      const aliases = snapshot.aliases || {};
      if (typeof aliases !== "object" || Array.isArray(aliases)) throw failure("media-index-corrupt", "人物媒体版本映射损坏。");
      for (const [id, alias] of Object.entries(aliases)) {
        validateAlias(alias, id);
        const target = snapshot.assets[alias.canonicalMediaId];
        if (snapshot.assets[id] || !target || alias.kind !== target.kind) throw failure("media-index-corrupt", "媒体版本映射循环、缺失目标或类型不一致。");
        for (const source of Object.values(alias.originalSources)) if ((source.originMediaIds || [id])
          .some((origin) => origin !== alias.canonicalMediaId && aliases[origin]?.canonicalMediaId !== alias.canonicalMediaId)) {
          throw failure("media-index-corrupt", "媒体版本的原始来源指向其他资产。");
        }
      }
      for (const [id, asset] of Object.entries(snapshot.assets)) {
        validateAsset(asset, id);
        if (!asset.sources || typeof asset.sources !== "object" || Array.isArray(asset.sources)) throw failure("media-index-corrupt", "媒体来源索引损坏。");
        for (const [key, source] of Object.entries(asset.sources)) {
          const normalized = normalizeSource({ ...source, originMediaIds: source.originMediaIds || [id] }, source.firstSeenAt || asset.savedAt);
          validateSourceAsset(normalized, id);
          if (normalized.originMediaIds.some((origin) => origin !== id && aliases[origin]?.canonicalMediaId !== id)) {
            throw failure("media-index-corrupt", "媒体来源的原始版本不属于该资产。");
          }
          if (key !== sourceKey(normalized)) throw failure("media-index-corrupt", "媒体来源标识损坏。");
          asset.sources[key] = normalized;
        }
        // Legacy assets obtain a label once, before any later display-name edit.
        asset.personLabel ||= this.personLabel;
      }
      const pendingRenames = snapshot.pendingRenames || {};
      if (typeof pendingRenames !== "object" || Array.isArray(pendingRenames)) throw failure("media-index-corrupt", "人物媒体改名恢复记录损坏。");
      for (const [id, batch] of Object.entries(pendingRenames)) {
        validateBatch(batch);
        if (id !== batch.id) throw failure("media-index-corrupt", "人物媒体改名批次标识不一致。");
      }
      const dirtyNamingGroups = snapshot.dirtyNamingGroups ?? [...new Set(Object.values(snapshot.assets).map(groupKey))];
      validateGroups(dirtyNamingGroups);
      const pendingMerges = snapshot.pendingMerges || {};
      if (typeof pendingMerges !== "object" || Array.isArray(pendingMerges)) throw failure("media-index-corrupt", "人物媒体合并恢复记录损坏。");
      for (const [id, batch] of Object.entries(pendingMerges)) {
        validateMergeBatch(batch);
        if (id !== batch.id || !snapshot.assets[batch.winnerId]) throw failure("media-index-corrupt", "媒体合并批次目标不一致。");
        for (const entry of batch.entries) if (!snapshot.assets[entry.mediaId] || snapshot.assets[entry.mediaId].relativePath !== entry.fromPath
          || snapshot.assets[entry.mediaId].bytes !== entry.asset.bytes || snapshot.assets[entry.mediaId].kind !== snapshot.assets[batch.winnerId].kind) {
          throw failure("media-index-corrupt", "媒体合并批次与当前资产不一致。");
        }
      }
      this.data = { ...snapshot, version: INDEX_VERSION, aliases, pendingMerges, pendingRenames, dirtyNamingGroups };
      this.hasSnapshot = true;
      this.snapshotStamp = metadataStamp(await lstat(this.snapshotPath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.replay({ repair: create, signal });
    for (const asset of Object.values(this.data.assets)) asset.personLabel ||= this.personLabel;
    this.initialized = true;
    if (create) {
      if (!this.hasSnapshot) await this.writeSnapshot();
      if (!this.hasJournal) { await durableReplace(this.journalPath, ""); this.hasJournal = true; }
      await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      await this.recoverOrphans(signal);
    } else if (Object.keys(this.data.pendingRenames).length || Object.keys(this.data.pendingMerges).length) {
      await this.refreshPendingPaths(signal);
    }
  }

  async fileExists(filePath) {
    try { return (await lstat(filePath)).isFile(); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  async assertMetadataFile(filePath) {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw failure("media-index-unsafe", "人物媒体索引文件不是普通文件。");
    if (filePath === this.snapshotPath && this.hasSnapshot && this.snapshotStamp && !this.writingSnapshot
      && metadataStamp(info) !== this.snapshotStamp) {
      let current;
      try { current = JSON.parse(await readFile(filePath, "utf8")); }
      catch { throw failure("media-index-corrupt", "人物媒体快照已被修改且内容损坏；原文件未覆盖。"); }
      if (current.personId !== this.personId) throw failure("media-index-owner-conflict", "该目录的 Index 已被替换为另一个人物的索引；原文件未覆盖。");
      throw failure("media-index-external-change", "人物媒体快照被外部修改，请检查并重启工具后重试；原文件未覆盖。");
    }
  }

  async writeSnapshot() {
    this.writingSnapshot = true;
    try {
      await durableReplace(this.snapshotPath, `${JSON.stringify(this.data)}\n`);
      this.hasSnapshot = true;
      this.snapshotStamp = metadataStamp(await lstat(this.snapshotPath));
    } finally { this.writingSnapshot = false; }
  }

  async replay({ repair, signal }) {
    let contents;
    try { await this.assertMetadataFile(this.journalPath); contents = await readFile(this.journalPath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    this.hasJournal = true;
    let position = 0;
    let previousSeq = null;
    while (position < contents.length) {
      cancelled(signal);
      const end = contents.indexOf(10, position);
      if (end === -1) {
        // Only an unterminated final record is recoverable. Complete malformed records always fail.
        if (repair) {
          const handle = await open(this.journalPath, "r+");
          try { await handle.truncate(position); await handle.sync(); } finally { await handle.close(); }
          this.needsTailRepair = false;
        } else this.needsTailRepair = true;
        break;
      }
      let event;
      try { event = JSON.parse(contents.subarray(position, end).toString("utf8")); }
      catch { throw failure("media-journal-corrupt", "人物媒体日志中存在损坏记录；本次未重置索引。"); }
      if (!Number.isSafeInteger(event.seq) || event.seq < 1 || (previousSeq !== null && event.seq !== previousSeq + 1)) {
        throw failure("media-journal-corrupt", "人物媒体日志序号不连续；本次未重置索引。");
      }
      this.validateEvent(event);
      if (event.seq > this.data.appliedSeq) {
        if (event.seq !== this.data.appliedSeq + 1) throw failure("media-journal-corrupt", "人物媒体日志缺少记录；本次未重置索引。");
        this.apply(event);
      }
      previousSeq = event.seq;
      position = end + 1;
    }
  }

  validateEvent(event) {
    if (event.personId !== this.personId) throw failure("media-journal-corrupt", "人物媒体日志所属人物不正确。");
    if (event.operation === "upsert") {
      validateAsset(event.asset, event.asset?.mediaId);
      if (event.source) validateSourceAsset(normalizeSource(event.source, event.source.firstSeenAt || event.asset.savedAt), event.asset.mediaId);
    } else if (event.operation === "rename-intent") validateBatch(event.batch);
    else if (event.operation === "merge-intent") validateMergeBatch(event.batch);
    else if (event.operation === "merge-commit") {
      if (!/^[a-f0-9-]{36}$/.test(event.batchId || "")) throw failure("media-journal-corrupt", "媒体合并提交记录损坏。");
    }
    else if (event.operation === "similarity-fingerprint") {
      if (!HASH.test(event.mediaId || "") || !Number.isSafeInteger(event.bytes) || event.bytes <= 0) throw failure("media-journal-corrupt", "媒体指纹记录损坏。");
      validateFingerprint(event.fingerprint, event.mediaId, event.bytes);
    }
    else if (event.operation === "naming-clean") validateGroups(event.groups);
    else if (event.operation === "rename-commit") {
      if (typeof event.batchId !== "string" || !Array.isArray(event.assets) || !event.assets.length) throw failure("media-journal-corrupt", "人物媒体改名提交记录损坏。");
      const ids = new Set();
      for (const asset of event.assets) {
        validateAsset(asset, asset?.mediaId);
        if (ids.has(asset.mediaId)) throw failure("media-journal-corrupt", "人物媒体改名提交重复资产。");
        ids.add(asset.mediaId);
      }
    } else throw failure("media-journal-corrupt", "人物媒体日志操作不正确。");
  }

  apply(event) {
    if (event.operation === "similarity-fingerprint") {
      const asset = this.data.assets[event.mediaId];
      if (!asset || asset.bytes !== event.bytes) throw failure("media-journal-corrupt", "媒体指纹目标与当前资产不一致。");
      asset.similarityFingerprint = structuredClone(event.fingerprint);
      this.data.appliedSeq = event.seq;
      return;
    }
    if (event.operation === "merge-intent") {
      const batch = event.batch;
      const winner = this.data.assets[batch.winnerId];
      if (!winner || this.data.pendingMerges[batch.id] || Object.keys(this.data.pendingMerges).length || Object.keys(this.data.pendingRenames).length) {
        throw failure("media-journal-corrupt", "媒体合并意图缺失目标或与未完成操作冲突。");
      }
      for (const entry of batch.entries) {
        const asset = this.data.assets[entry.mediaId];
        if (!asset || asset.relativePath !== entry.fromPath || asset.bytes !== entry.asset.bytes || asset.kind !== winner.kind) {
          throw failure("media-journal-corrupt", "媒体合并意图与当前索引不一致。");
        }
      }
      this.data.pendingMerges[batch.id] = structuredClone(batch);
      this.data.appliedSeq = event.seq;
      return;
    }
    if (event.operation === "merge-commit") {
      const batch = this.data.pendingMerges[event.batchId];
      const winner = batch && this.data.assets[batch.winnerId];
      if (!batch || !winner) throw failure("media-journal-corrupt", "媒体合并提交缺少对应意图。");
      const dirty = new Set([...this.data.dirtyNamingGroups, groupKey(winner), savedGroupKey(winner)]);
      for (const entry of batch.entries) {
        const loser = this.data.assets[entry.mediaId];
        if (!loser || loser.kind !== winner.kind) throw failure("media-journal-corrupt", "媒体合并源资产缺失或类型不一致。");
        dirty.add(groupKey(loser)); dirty.add(savedGroupKey(loser));
        this.data.aliases[entry.mediaId] = { ...recordOf(loser), canonicalMediaId: winner.mediaId, archivePath: entry.archivePath,
          batchId: batch.id, mergedAt: batch.createdAt, evidence: structuredClone(batch.evidence), originalSources: structuredClone(loser.sources) };
        for (const alias of Object.values(this.data.aliases)) if (alias.canonicalMediaId === entry.mediaId) alias.canonicalMediaId = winner.mediaId;
        for (const [key, source] of Object.entries(loser.sources)) {
          const incoming = { ...source, originMediaIds: source.originMediaIds || [loser.mediaId] };
          winner.sources[key] = mergeSource(winner.sources[key], incoming);
        }
        delete this.data.assets[entry.mediaId];
        this.physicalPaths.delete(entry.mediaId);
      }
      dirty.add(groupKey(winner));
      this.data.dirtyNamingGroups = [...dirty];
      delete this.data.pendingMerges[event.batchId];
      this.data.appliedSeq = event.seq;
      return;
    }
    if (event.operation === "naming-clean") {
      this.data.dirtyNamingGroups = this.data.dirtyNamingGroups.filter((key) => !event.groups.includes(key));
      this.data.appliedSeq = event.seq;
      return;
    }
    if (event.operation === "rename-intent") {
      if (this.data.pendingRenames[event.batch.id]) throw failure("media-journal-corrupt", "人物媒体改名批次重复。");
      for (const entry of event.batch.entries) {
        const asset = this.data.assets[entry.mediaId];
        if (!asset || asset.bytes !== entry.asset.bytes || asset.relativePath !== entry.fromPath) throw failure("media-journal-corrupt", "人物媒体改名批次与当前索引不一致。");
      }
      this.data.pendingRenames[event.batch.id] = structuredClone(event.batch);
      this.data.appliedSeq = event.seq;
      return;
    }
    if (event.operation === "rename-commit") {
      const batch = this.data.pendingRenames[event.batchId];
      if (!batch || event.assets.length !== batch.entries.length) throw failure("media-journal-corrupt", "人物媒体改名提交缺少对应意图。");
      for (const asset of event.assets) {
        const entry = batch.entries.find((item) => item.mediaId === asset.mediaId);
        if (!entry || entry.toPath !== asset.relativePath || entry.asset.bytes !== asset.bytes) throw failure("media-journal-corrupt", "人物媒体改名提交与意图不一致。");
        this.data.assets[asset.mediaId] = { ...asset, sources: this.data.assets[asset.mediaId].sources };
        this.physicalPaths.delete(asset.mediaId);
      }
      delete this.data.pendingRenames[event.batchId];
      this.data.dirtyNamingGroups = this.data.dirtyNamingGroups.filter((key) => !batch.groups.includes(key));
      this.data.appliedSeq = event.seq;
      return;
    }
    const current = this.data.assets[event.asset.mediaId];
    if (this.data.aliases[event.asset.mediaId]) throw failure("media-journal-corrupt", "已合并版本不能重新创建为独立资产。");
    const oldGroup = current ? groupKey(current) : null;
    const oldSavedGroup = current ? savedGroupKey(current) : null;
    const oldRank = current ? rankStamp(current) : null;
    if (current && current.bytes !== event.asset.bytes) throw failure("media-index-collision", "同一哈希的媒体大小冲突；文件未合并。");
    const asset = { ...event.asset, personLabel: event.asset.personLabel || current?.personLabel || this.personLabel, sources: current?.sources || {} };
    if (event.source) {
      const normalized = normalizeSource({ ...event.source, originMediaIds: event.source.originMediaIds || [event.asset.mediaId] }, event.source.firstSeenAt || event.asset.savedAt);
      if (normalized.originMediaIds.some((id) => id !== asset.mediaId && this.data.aliases[id]?.canonicalMediaId !== asset.mediaId)) {
        throw failure("media-journal-corrupt", "媒体来源包含未确认的版本映射。");
      }
      const key = sourceKey(normalized);
      asset.sources[key] = mergeSource(asset.sources[key], normalized);
    }
    this.data.assets[asset.mediaId] = asset;
    if (!current || current.namingVersion !== NAMING_VERSION || oldGroup !== groupKey(asset) || oldRank !== rankStamp(asset) || namingDateChanged(asset)) {
      this.data.dirtyNamingGroups = [...new Set([...this.data.dirtyNamingGroups, ...(oldGroup ? [oldGroup] : []), ...(oldSavedGroup ? [oldSavedGroup] : []), groupKey(asset)])];
    }
    this.data.appliedSeq = event.seq;
  }

  async assertWritable(signal) {
    cancelled(signal);
    await assertRoot(this.root, false);
    if (!this.initialized) {
      if (!this.allowInitialize) throw failure("media-index-missing", "人物媒体 Index 已缺失或尚未初始化，未自动重建；请检查目录。");
      await this.load({ create: true, signal }); return;
    }
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure("media-index-unsafe", "人物媒体 Index 不可访问或不是普通目录。");
    if (this.hasSnapshot) await this.assertMetadataFile(this.snapshotPath);
    if (this.hasJournal) await this.assertMetadataFile(this.journalPath);
    if (this.needsReload) {
      await this.load({ create: true, signal });
      this.needsReload = false;
    }
    // A truncated tail seen by a read-only open is repaired before this writer appends.
    else if (this.needsTailRepair) await this.replay({ repair: true, signal });
    if (!this.hasSnapshot) await this.writeSnapshot();
    else await this.assertMetadataFile(this.snapshotPath);
    if (!this.hasJournal) { await durableReplace(this.journalPath, ""); this.hasJournal = true; }
  }

  async append(asset, source, signal) {
    return this.appendEvent({ operation: "upsert", asset, ...(source ? { source } : {}) }, signal);
  }

  async appendEvent(details, signal) {
    cancelled(signal);
    const event = { ...details, personId: this.personId, seq: this.data.appliedSeq + 1 };
    this.validateEvent(event);
    try { await this.assertMetadataFile(this.journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const handle = await open(this.journalPath, "a");
    this.hasJournal = true;
    try {
      await writeAll(handle, Buffer.from(`${JSON.stringify(event)}\n`));
      await handle.sync();
      this.apply(event);
    } catch (error) { this.needsReload = true; throw error; }
    finally { await handle.close(); }
  }

  async safeFileInfo(relativePath) {
    const filePath = path.resolve(this.root, relativePath);
    if (!within(this.root, filePath)) throw failure("media-path-unsafe", "媒体路径不在人物目录内。");
    let info;
    try { info = await lstat(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || !within(await realpath(this.root), await realpath(filePath))) {
      throw failure("media-path-unsafe", "媒体路径不是人物目录内的普通文件。");
    }
    return { filePath, info };
  }

  async locateRenameEntry(entry, signal, trustCurrent = false) {
    if (trustCurrent) {
      const current = await this.safeFileInfo(entry.fromPath);
      if (current && current.info.size === entry.asset.bytes && current.info.mtimeMs === entry.asset.mtimeMs && current.info.ctimeMs === entry.asset.ctimeMs) {
        this.physicalPaths.set(entry.mediaId, entry.fromPath);
        return { ...current, relativePath: entry.fromPath };
      }
    }
    const matches = [];
    for (const relativePath of [...new Set([entry.fromPath, entry.temporaryPath, entry.toPath])]) {
      cancelled(signal);
      const found = await this.safeFileInfo(relativePath);
      if (!found || found.info.size !== entry.asset.bytes) continue;
      if (await hashFile(found.filePath, signal) === entry.mediaId) matches.push({ ...found, relativePath });
    }
    if (matches.length !== 1) throw failure("media-rename-conflict", matches.length
      ? "改名恢复发现多个相同媒体副本，请检查目录；文件未删除或覆盖。"
      : "改名恢复未找到完整媒体文件，请检查网络共享和目录；索引未重置。");
    this.physicalPaths.set(entry.mediaId, matches[0].relativePath);
    return matches[0];
  }

  async refreshPendingPaths(signal) {
    for (const batch of Object.values(this.data.pendingRenames)) {
      for (const entry of batch.entries) await this.locateRenameEntry(entry, signal);
    }
    for (const batch of Object.values(this.data.pendingMerges)) {
      for (const entry of batch.entries) await this.locateMergeEntry(entry, signal);
    }
  }

  async ensureArchiveDirectory(batchId) {
    const resolvedRoot = await realpath(this.root);
    for (const directory of [this.directory, path.join(this.directory, "DedupArchive"), path.join(this.directory, "DedupArchive", batchId)]) {
      try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !within(resolvedRoot, await realpath(directory))) {
        throw failure("media-path-unsafe", "去重归档目录必须位于人物 Index 内，不能使用符号链接。");
      }
    }
  }

  async locateMergeEntry(entry, signal) {
    const found = [];
    for (const relativePath of [entry.fromPath, entry.archivePath]) {
      cancelled(signal);
      const current = await this.safeFileInfo(relativePath);
      if (!current) continue;
      if (current.info.size !== entry.asset.bytes || await hashFile(current.filePath, signal) !== entry.mediaId) {
        throw failure("media-dedup-conflict", "去重源文件或归档目标内容与索引不一致；未覆盖任何文件。");
      }
      found.push({ ...current, relativePath });
    }
    if (found.length !== 1) throw failure("media-dedup-conflict", found.length
      ? "去重源目录与归档中同时存在文件，未自动删除或覆盖。"
      : "去重恢复未找到完整原文件，请检查网络共享；索引未重置。");
    this.physicalPaths.set(entry.mediaId, found[0].relativePath);
    return found[0];
  }

  async recoverPendingMerges(signal) {
    let merged = 0;
    for (const batch of Object.values(this.data.pendingMerges)) {
      validateMergeBatch(batch);
      try {
        cancelled(signal);
        if (!await this.hasUnlocked(batch.winnerId)) throw failure("media-not-found", "去重保留文件缺失或已修改，合并未确认。");
        await this.ensureArchiveDirectory(batch.id);
        const entries = [];
        for (const entry of batch.entries) entries.push({ entry, location: await this.locateMergeEntry(entry, signal) });
        for (const { entry, location } of entries) {
          cancelled(signal);
          if (location.relativePath === entry.archivePath) continue;
          await this.moveRenameFile(entry.fromPath, entry.archivePath);
          this.physicalPaths.set(entry.mediaId, entry.archivePath);
        }
        await this.appendEvent({ operation: "merge-commit", batchId: batch.id }, signal);
        merged += batch.entries.length;
      } catch (error) {
        if (error.name === "AbortError" || signal?.aborted) throw error;
        await this.refreshPendingPaths().catch(() => {});
        throw Object.assign(failure("media-dedup-incomplete", `去重整理未完成：${error.message} 原文件和来源记录保留，下次会继续恢复。`), { cause: error });
      }
    }
    return merged;
  }

  canonicalMediaId(mediaId) {
    if (this.data.assets[mediaId]) return mediaId;
    return this.data.aliases[mediaId]?.canonicalMediaId || null;
  }

  async setSimilarityFingerprint(mediaId, fingerprint, { signal } = {}) {
    return this.run(async () => {
      await this.assertWritable(signal);
      await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      const canonicalId = this.canonicalMediaId(mediaId), asset = this.data.assets[canonicalId];
      if (!asset || !await this.hasUnlocked(canonicalId)) throw failure("media-not-found", "媒体指纹对应的文件不存在或已修改。");
      const current = await this.safeFileInfo(this.physicalPaths.get(canonicalId) || asset.relativePath);
      const fileStamp = { sha256: canonicalId, bytes: asset.bytes, mtimeMs: current.info.mtimeMs, ctimeMs: current.info.ctimeMs };
      const normalized = boundedJson(fingerprint, 300 * 1024, "media-fingerprint-invalid");
      if (normalized.fileStamp && Object.keys(fileStamp).some((key) => normalized.fileStamp[key] !== fileStamp[key])) {
        throw failure("media-fingerprint-stale", "媒体在计算指纹后发生变化，请重新比对；未保存过期指纹。");
      }
      normalized.fileStamp = fileStamp;
      validateFingerprint(normalized, canonicalId, asset.bytes);
      await this.appendEvent({ operation: "similarity-fingerprint", mediaId: canonicalId, bytes: asset.bytes, fingerprint: normalized }, signal);
      return this.get(canonicalId);
    });
  }

  async mergeVariants(winnerId, loserIds, { evidence, signal } = {}) {
    return this.run(async () => {
      await this.assertWritable(signal);
      await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      winnerId = this.canonicalMediaId(winnerId);
      if (!winnerId || !await this.hasUnlocked(winnerId)) throw failure("media-not-found", "去重保留文件不存在或已修改。");
      if (!Array.isArray(loserIds) || loserIds.some((id) => !HASH.test(id))) throw failure("media-dedup-invalid", "去重版本资产列表无效。");
      const normalizedEvidence = boundedJson(evidence, 64 * 1024, "media-dedup-invalid");
      const ids = [...new Set(loserIds.map((id) => this.canonicalMediaId(id)))].filter((id) => id !== winnerId);
      if (ids.includes(null)) throw failure("media-not-found", "去重源媒体不在当前人物索引中。");
      if (!ids.length) return { winnerId, merged: [], archived: [], pending: false };
      const id = randomUUID(), winner = this.data.assets[winnerId], entries = [];
      for (const mediaId of ids) {
        cancelled(signal);
        const asset = this.data.assets[mediaId];
        if (asset.kind !== winner.kind) throw failure("media-dedup-invalid", "图片和视频不能作为相同媒体合并。");
        if (!await this.hasUnlocked(mediaId)) throw failure("media-not-found", "去重源媒体缺失或已修改，未执行合并。");
        const archivePath = path.join("Index", "DedupArchive", id, path.basename(asset.relativePath));
        if (path.join(this.root, archivePath).length > 240) throw failure("media-filename-too-long", "人物路径过长，无法安全创建可恢复去重归档。");
        entries.push({ mediaId, fromPath: asset.relativePath, archivePath, asset: recordOf(asset) });
      }
      const batch = { id, winnerId, entries, createdAt: new Date().toISOString(), evidence: normalizedEvidence };
      await this.ensureArchiveDirectory(id);
      for (const entry of entries) if (await this.safeFileInfo(entry.archivePath)) throw failure("media-dedup-conflict", "去重归档已被占用，未覆盖。");
      await this.appendEvent({ operation: "merge-intent", batch }, signal);
      await this.recoverPendingMerges(signal);
      return { winnerId, merged: ids, archived: entries.map((entry) => ({ mediaId: entry.mediaId, relativePath: entry.archivePath })), pending: false };
    });
  }

  async moveRenameFile(fromPath, toPath) {
    // Destinations are checked immediately before every move. Never replace a known file.
    const destination = path.resolve(this.root, toPath);
    try { await lstat(destination); throw failure("media-rename-conflict", "改名目标已被其他文件占用；文件未覆盖。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const source = await this.safeFileInfo(fromPath);
    if (!source) throw failure("media-rename-conflict", "改名源文件已缺失；索引未重置。");
    const folder = path.dirname(destination);
    if ((await lstat(folder)).isSymbolicLink() || !within(await realpath(this.root), await realpath(folder))) {
      throw failure("media-path-unsafe", "改名目标文件夹位于人物目录之外。");
    }
    await rename(source.filePath, destination);
  }

  async recoverPendingRenames(signal, { trusted = false } = {}) {
    let renamed = 0;
    for (const batch of Object.values(this.data.pendingRenames)) {
      validateBatch(batch);
      try {
        const locations = new Map();
        for (const entry of batch.entries) locations.set(entry.mediaId, await this.locateRenameEntry(entry, signal, trusted));
        // Verify all final destinations before moving anything. Occupied sources in this
        // same batch are safe because every source is staged before final names are used.
        for (const entry of batch.entries) {
          for (const relativePath of [entry.temporaryPath, entry.toPath]) {
            const found = await this.safeFileInfo(relativePath);
            if (!found) continue;
            const owner = batch.entries.find((candidate) => locations.get(candidate.mediaId).relativePath === relativePath);
            if (!owner || (relativePath === entry.temporaryPath && owner.mediaId !== entry.mediaId)) {
              throw failure("media-rename-conflict", "改名目标包含未索引文件；文件未覆盖。");
            }
          }
        }
        for (const entry of batch.entries) {
          cancelled(signal);
          if (locations.get(entry.mediaId).relativePath !== entry.fromPath) continue;
          await this.moveRenameFile(entry.fromPath, entry.temporaryPath);
          this.physicalPaths.set(entry.mediaId, entry.temporaryPath);
          locations.get(entry.mediaId).relativePath = entry.temporaryPath;
        }
        for (const entry of batch.entries) {
          cancelled(signal);
          if (locations.get(entry.mediaId).relativePath === entry.toPath) continue;
          await this.moveRenameFile(entry.temporaryPath, entry.toPath);
          this.physicalPaths.set(entry.mediaId, entry.toPath);
          locations.get(entry.mediaId).relativePath = entry.toPath;
        }
        const assets = [];
        for (const entry of batch.entries) {
          const info = (await this.safeFileInfo(entry.toPath))?.info;
          if (!info || info.size !== entry.asset.bytes) throw failure("media-rename-conflict", "改名后的媒体文件缺失或大小异常。");
          assets.push({ ...entry.asset, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
            ...(entry.asset.similarityFingerprint ? { similarityFingerprint: { ...entry.asset.similarityFingerprint,
              fileStamp: { sha256: entry.mediaId, bytes: entry.asset.bytes, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } } } : {}) });
        }
        await this.appendEvent({ operation: "rename-commit", batchId: batch.id, assets }, signal);
        renamed += batch.entries.length;
      } catch (error) {
        // A filesystem can report an error after a move took effect. Refresh the
        // best current paths for API reads without pretending the batch committed.
        if (error.name === "AbortError" || signal?.aborted) throw error;
        await this.refreshPendingPaths().catch(() => {});
        throw Object.assign(failure("media-naming-incomplete", `命名整理未完成：${error.message} 下次同步会继续恢复，不会重新下载已有文件。`), { cause: error });
      }
    }
    return renamed;
  }

  async chooseReadablePath(asset, occupied = new Set(), signal) {
    for (const length of HASH_LENGTHS) {
      cancelled(signal);
      const candidate = readableRelativePath(this.root, asset, length);
      const comparison = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (occupied.has(comparison)) continue;
      const info = await this.safeFileInfo(candidate);
      const owner = Object.values(this.data.assets).find((item) => item.relativePath === candidate);
      if (!info || owner?.mediaId === asset.mediaId) return candidate;
      // Another indexed source will be staged before this destination is used.
      // Its hash suffix normally differs, but this case also handles a synthetic prefix collision.
      if (owner && owner.mediaId !== asset.mediaId && !owner.mediaId.startsWith(asset.mediaId.slice(0, length))) return candidate;
    }
    throw failure("media-file-collision", "可读文件名的所有哈希后缀均被其他文件占用；文件未覆盖。");
  }

  async finalizeNaming({ signal } = {}) {
    return this.run(async () => {
      await this.assertWritable(signal);
      let renamed = await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      const dirtyGroups = [...this.data.dirtyNamingGroups];
      if (!dirtyGroups.length) return { renamed, pending: false };
      const entries = [], occupied = new Set();
      const affected = Object.values(this.data.assets).filter((asset) => dirtyGroups.includes(groupKey(asset)));
      for (const group of namingGroups(affected).values()) {
        const sequenceWidth = Math.max(2, String(group.length).length);
        for (let offset = 0; offset < group.length; offset++) {
          cancelled(signal);
          const current = group[offset];
          const target = { ...recordOf(current), namingVersion: NAMING_VERSION, personLabel: current.personLabel || this.personLabel,
            publicationDate: assetDate(current), daySequence: offset + 1, sequenceWidth };
          const hashLength = parseMediaFilename(path.basename(current.relativePath))?.hashPrefix.length || 16;
          const expected = readableRelativePath(this.root, target, current.namingVersion === NAMING_VERSION ? hashLength : 16);
          target.relativePath = expected === current.relativePath ? expected : await this.chooseReadablePath(target, occupied, signal);
          occupied.add(process.platform === "win32" ? target.relativePath.toLowerCase() : target.relativePath);
          if (target.relativePath === current.relativePath && target.namingVersion === current.namingVersion
            && target.daySequence === current.daySequence && target.sequenceWidth === current.sequenceWidth && target.publicationDate === current.publicationDate) continue;
          entries.push({ mediaId: current.mediaId, fromPath: current.relativePath, toPath: target.relativePath, asset: target });
        }
      }
      if (entries.length) {
        const id = randomUUID();
        for (const entry of entries) {
          entry.temporaryPath = path.join(path.dirname(entry.fromPath), `.mt-${randomUUID().replaceAll("-", "").slice(0, 16)}${entry.asset.extension}`);
          if (path.join(this.root, entry.temporaryPath).length > 240) throw failure("media-filename-too-long", "人物目录路径过长，无法安全生成媒体改名暂存文件。");
        }
        await this.appendEvent({ operation: "rename-intent", batch: { id, entries, groups: dirtyGroups } }, signal);
        renamed += await this.recoverPendingRenames(signal, { trusted: true });
      } else await this.appendEvent({ operation: "naming-clean", groups: dirtyGroups }, signal);
      return { renamed, pending: false };
    });
  }

  async recoverOrphans(signal) {
    for (const [folder, kind] of [["Image", "image"], ["Video", "video"]]) {
      const directory = path.join(this.root, folder);
      let entries;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !within(await realpath(this.root), await realpath(directory))) {
          throw failure("media-folder-unsafe", "媒体文件夹不是人物目录内的普通目录。");
        }
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        cancelled(signal);
        const parsed = parseMediaFilename(entry.name);
        if (!entry.isFile() || !parsed) continue;
        const filename = entry.name, extension = parsed.extension;
        // Indexed files are already checked cheaply when referenced. Do not rehash the
        // entire archive each sync or restart merely because filenames became readable.
        const known = Object.values(this.data.assets).find((asset) => asset.relativePath === path.join(folder, filename));
        if (known) continue;
        const filePath = path.join(directory, filename);
        const info = await stat(filePath);
        const id = await hashFile(filePath, signal);
        if (!info.size || !id.startsWith(parsed.hashPrefix)) throw failure("media-orphan-corrupt", "发现文件名哈希与内容不一致的未索引媒体；本次未合并。");
        if (this.data.assets[id] || this.data.aliases[id]) throw failure("media-orphan-conflict", "发现同一资产或已合并版本的另一份未索引文件；请检查目录，文件未删除或覆盖。");
        await this.append({ mediaId: id, sha256: id, bytes: info.size, kind, extension,
          relativePath: path.join(folder, filename), savedAt: info.mtime.toISOString(), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
          personLabel: parsed.personLabel || this.personLabel, ...(parsed.namingVersion ? { namingVersion: parsed.namingVersion, publicationDate: parsed.publicationDate,
            daySequence: parsed.daySequence, sequenceWidth: parsed.sequenceWidth } : {}), recovered: true }, null, signal);
      }
    }
    this.orphansRecovered = true;
  }

  get(mediaId, { includeFingerprint = true } = {}) {
    const requestedMediaId = mediaId;
    mediaId = this.canonicalMediaId(mediaId);
    const asset = this.data.assets[mediaId];
    if (!asset) return null;
    const relativePath = this.physicalPaths.get(mediaId);
    const namingPending = Object.values(this.data.pendingRenames).some((batch) => batch.entries.some((entry) => entry.mediaId === mediaId));
    const mergePending = Object.values(this.data.pendingMerges).some((batch) => batch.winnerId === mediaId || batch.entries.some((entry) => entry.mediaId === mediaId));
    const variantCount = Object.values(this.data.aliases).filter((alias) => alias.canonicalMediaId === mediaId).length;
    const { similarityFingerprint, ...withoutFingerprint } = asset;
    const variant = this.data.aliases[requestedMediaId];
    const { similarityFingerprint: variantFingerprint, ...withoutVariantFingerprint } = variant || {};
    return { ...structuredClone(includeFingerprint ? asset : withoutFingerprint), ...(relativePath ? { relativePath } : {}), ...(namingPending ? { namingPending: true } : {}),
      ...(mergePending ? { mergePending: true } : {}), ...(variantCount ? { variantCount } : {}),
      ...(requestedMediaId !== mediaId ? { requestedMediaId, variant: structuredClone(includeFingerprint ? variant : withoutVariantFingerprint) } : {}) };
  }

  async resolve(mediaId) {
    return this.run(() => this.resolveUnlocked(mediaId));
  }

  async withAssetPath(mediaId, callback) {
    if (typeof callback !== "function") throw new TypeError("Asset path callback is required");
    return this.run(async () => callback(await this.resolveUnlocked(mediaId), this.get(mediaId, { includeFingerprint: false })));
  }

  async resolveUnlocked(mediaId) {
    mediaId = this.canonicalMediaId(mediaId);
    const asset = this.data.assets[mediaId];
    if (!asset) throw failure("media-not-found", "媒体不在该人物的索引中。");
    validateAsset(asset, mediaId);
    const pending = Object.values(this.data.pendingRenames).flatMap((batch) => batch.entries).find((entry) => entry.mediaId === mediaId);
    // During a recovered but unfinished batch the true physical filename can be
    // the old, temporary, or final name. All three keep the real media extension.
    if (pending && (!this.physicalPaths.has(mediaId) || !await this.safeFileInfo(this.physicalPaths.get(mediaId)))) await this.locateRenameEntry(pending);
    const pendingMerge = Object.values(this.data.pendingMerges).flatMap((batch) => batch.entries).find((entry) => entry.mediaId === mediaId);
    if (pendingMerge && (!this.physicalPaths.has(mediaId) || !await this.safeFileInfo(this.physicalPaths.get(mediaId)))) await this.locateMergeEntry(pendingMerge);
    const filePath = path.resolve(this.root, this.physicalPaths.get(mediaId) || asset.relativePath);
    if (!within(this.root, filePath)) throw failure("media-path-unsafe", "媒体路径不在人物目录内。");
    const resolvedRoot = await realpath(this.root);
    const folder = path.dirname(filePath);
    if ((await lstat(folder)).isSymbolicLink() || !within(resolvedRoot, await realpath(folder))) throw failure("media-path-unsafe", "媒体文件夹不在人物目录内。");
    const resolvedFile = await realpath(filePath);
    if (!within(resolvedRoot, resolvedFile) || !(await stat(resolvedFile)).isFile()) throw failure("media-path-unsafe", "媒体文件不在人物目录内或不是普通文件。");
    return resolvedFile;
  }

  async has(mediaId) {
    return this.run(() => this.hasUnlocked(mediaId));
  }

  async hasUnlocked(mediaId) {
    mediaId = this.canonicalMediaId(mediaId);
    const asset = this.data.assets[mediaId];
    if (!asset) return false;
    try {
      const filePath = await this.resolveUnlocked(mediaId);
      const info = await stat(filePath);
      if (info.size !== asset.bytes) return false;
      // Indexed unchanged files use a cheap metadata check. Changed files are hashed locally before reuse.
      if (asset.mtimeMs !== info.mtimeMs || asset.ctimeMs !== info.ctimeMs) {
        if (await hashFile(filePath) !== asset.sha256) return false;
        asset.mtimeMs = info.mtimeMs;
        asset.ctimeMs = info.ctimeMs;
      }
      return true;
    }
    catch (error) { if (error.code === "ENOENT" || error.code === "media-not-found") return false; throw error; }
  }

  async addSource(mediaId, source, { signal } = {}) {
    return this.run(async () => {
      await this.assertWritable(signal);
      await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      const originMediaId = mediaId;
      mediaId = this.canonicalMediaId(mediaId);
      const asset = this.data.assets[mediaId];
      if (!asset || !(await this.hasUnlocked(mediaId))) throw failure("media-not-found", "来源对应的媒体文件不存在。");
      const key = sourceKey(normalizeSource(source));
      const normalized = mergeSource(asset.sources[key], normalizeSource({ ...source, originMediaIds: [originMediaId] }, asset.sources[key]?.firstSeenAt));
      if (JSON.stringify(asset.sources[key]) !== JSON.stringify(normalized) || namingDateChanged(asset)) {
        const { sources, ...record } = asset;
        await this.append(record, normalized, signal);
      }
      return this.get(mediaId);
    });
  }

  async commitDownloaded({ partialPath, sha256, bytes, extension, mediaKind: fallbackKind, source }, { signal } = {}) {
    return this.run(async () => {
      await this.assertWritable(signal);
      await this.recoverPendingRenames(signal);
      await this.recoverPendingMerges(signal);
      if (!HASH.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0) throw failure("invalid-media-hash", "媒体哈希或大小无效。");
      extension = String(extension || "").toLowerCase();
      if (!EXTENSION.test(extension)) throw failure("invalid-media-extension", "媒体文件扩展名无效。");
      const partial = path.resolve(partialPath);
      if (!within(this.root, partial) || !partial.endsWith(".part")) throw failure("media-path-unsafe", "临时媒体文件必须位于人物目录内。");
      const partialInfo = await lstat(partial);
      if (!partialInfo.isFile() || partialInfo.isSymbolicLink() || partialInfo.size !== bytes
        || !within(await realpath(this.root), await realpath(partial))) throw failure("media-partial-invalid", "临时媒体文件不完整或路径不安全。");
      const alias = this.data.aliases[sha256];
      if (alias) {
        if (alias.bytes !== bytes || await hashFile(partial, signal) !== sha256) throw failure("media-index-collision", "已合并版本的真实哈希或大小冲突；临时文件未删除。");
        const canonicalId = alias.canonicalMediaId, canonical = this.data.assets[canonicalId];
        if (!canonical || !await this.hasUnlocked(canonicalId)) throw failure("media-not-found", "已合并版本的保留文件缺失或已修改，不能用不同字节覆盖。");
        const key = sourceKey(normalizeSource(source));
        const normalized = mergeSource(canonical.sources[key], normalizeSource({ ...source, originMediaIds: [sha256] }, canonical.sources[key]?.firstSeenAt));
        if (JSON.stringify(canonical.sources[key]) !== JSON.stringify(normalized) || namingDateChanged(canonical)) await this.append(recordOf(canonical), normalized, signal);
        await unlink(partial);
        return { status: "content-duplicate", mediaId: canonicalId, sha256: canonical.sha256, originMediaId: sha256,
          relativePath: canonical.relativePath, bytes: canonical.bytes, observedBytes: bytes, kind: canonical.kind, duplicateOf: canonical.relativePath };
      }
      let asset = this.data.assets[sha256] ? structuredClone(this.data.assets[sha256]) : null;
      if (asset && asset.bytes !== bytes) throw failure("media-index-collision", "同一哈希的媒体大小冲突；文件未合并。");
      const normalized = mergeSource(asset?.sources[sourceKey(source)], normalizeSource({ ...source, originMediaIds: [sha256] }, asset?.sources[sourceKey(source)]?.firstSeenAt));
      let duplicate = Boolean(asset && await this.hasUnlocked(sha256));
      if (!asset) {
        const kind = mediaKind(extension, fallbackKind);
        const publicationDate = normalized.publicationDate;
        const sameDay = Object.values(this.data.assets).filter((item) => item.kind === kind && assetDate(item) === publicationDate);
        const daySequence = Math.max(sameDay.length, ...sameDay.filter((item) => item.publicationDate === publicationDate).map((item) => item.daySequence || 0)) + 1;
        asset = { mediaId: sha256, sha256, bytes, kind, extension, namingVersion: NAMING_VERSION, personLabel: this.personLabel,
          publicationDate, daySequence, sequenceWidth: Math.max(2, String(daySequence).length), savedAt: new Date().toISOString(), sources: {} };
        asset.relativePath = await this.chooseReadablePath(asset, new Set(), signal);
      }
      const finalPath = path.join(this.root, asset.relativePath);
      const previouslyRecovered = this.orphansRecovered;
      if (!duplicate) {
        const folder = path.dirname(finalPath);
        await mkdir(folder, { recursive: true });
        if ((await lstat(folder)).isSymbolicLink() || !within(await realpath(this.root), await realpath(folder))) throw failure("media-path-unsafe", "媒体文件夹位于人物目录之外。");
        if (await this.fileExists(finalPath)) {
          if ((await stat(finalPath)).size !== bytes || await hashFile(finalPath, signal) !== sha256) throw failure("media-file-collision", "目标文件与媒体哈希不一致；文件未覆盖。");
          duplicate = true;
        } else {
          // Sync the completed temporary bytes before making the final name visible.
          const handle = await open(partial, "r+");
          try { await handle.sync(); } finally { await handle.close(); }
          cancelled(signal);
          await rename(partial, finalPath);
          if (!this.data.assets[sha256]) this.orphansRecovered = false;
        }
      }
      const finalInfo = await stat(finalPath);
      asset.mtimeMs = finalInfo.mtimeMs;
      asset.ctimeMs = finalInfo.ctimeMs;
      const { sources, ...record } = asset;
      const existingSource = asset.sources[sourceKey(normalized)];
      if (!duplicate || !this.data.assets[sha256] || JSON.stringify(existingSource) !== JSON.stringify(normalized)
        || this.data.assets[sha256].mtimeMs !== asset.mtimeMs || this.data.assets[sha256].ctimeMs !== asset.ctimeMs || namingDateChanged(asset)) await this.append(record, normalized, signal);
      this.orphansRecovered = previouslyRecovered;
      if (duplicate) await unlink(partial);
      return { status: duplicate ? "content-duplicate" : "downloaded", mediaId: sha256, sha256,
        relativePath: asset.relativePath, bytes, kind: asset.kind, ...(duplicate ? { duplicateOf: asset.relativePath } : {}) };
    });
  }

  list({ query = "", offset = 0, limit = 50 } = {}) {
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    const needle = String(query).trim().toLocaleLowerCase();
    const assets = Object.values(this.data.assets).filter((asset) => !needle || `${path.basename(asset.relativePath)} ${asset.sha256} ${Object.values(this.data.aliases)
      .filter((alias) => alias.canonicalMediaId === asset.mediaId).map((alias) => `${alias.mediaId} ${path.basename(alias.relativePath)}`).join(" ")}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.mediaId.localeCompare(b.mediaId));
    return { items: assets.slice(offset, offset + limit).map((asset) => { const { sources, ...current } = this.get(asset.mediaId, { includeFingerprint: false }); return { ...current,
      filename: path.basename(current.relativePath), sourceCount: Object.keys(sources).length }; }), total: assets.length, offset, limit };
  }

  sources(mediaId) {
    mediaId = this.canonicalMediaId(mediaId);
    const asset = this.data.assets[mediaId];
    if (!asset) throw failure("media-not-found", "媒体不在该人物的索引中。");
    return structuredClone(Object.values(asset.sources));
  }

  async compact() {
    return this.run(async () => {
      await this.assertWritable();
      await this.writeSnapshot();
      // Intents remain in both snapshot and journal until the physical batch is
      // committed. A snapshot must not make an interrupted rename irrecoverable.
      if (Object.keys(this.data.pendingRenames).length || Object.keys(this.data.pendingMerges).length) return { pending: true };
      // Atomic snapshot replacement has succeeded. Replaying the old log is harmless if clearing fails.
      // Windows does not allow ftruncate on append-only handles. Replace a synced empty log instead.
      await durableReplace(this.journalPath, "");
      this.hasJournal = true;
    });
  }
}

export async function openPersonMediaIndex(person, { create = false, requireExisting = false, writable = create, signal } = {}) {
  const resolvedPath = path.resolve(person?.folderPath || "");
  // Windows treats ordinary disk/UNC paths as case-insensitive. Aliases must share the same writer queue.
  const key = `${person?.id}\0${process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath}`;
  let pending = indexes.get(key);
  if (!pending) {
    // An initialized person's missing metadata is an error, even when the caller otherwise permits mkdir.
    pending = (async () => { const index = new PersonMediaIndex(person); await index.load({ create: create && !requireExisting, signal }); return index; })();
    indexes.set(key, pending);
    pending.catch(() => { if (indexes.get(key) === pending) indexes.delete(key); });
  }
  const index = await pending;
  index.personLabel = personLabel(person.name || path.basename(person.folderPath));
  cancelled(signal);
  await assertRoot(index.root, false);
  if (requireExisting && (!index.initialized || !index.hasSnapshot || !index.hasJournal)) throw failure("media-index-missing", "人物媒体 Index、快照或日志已缺失，未自动重建；请检查目录。");
  if (index.initialized) {
    const info = await lstat(index.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure("media-index-unsafe", "人物媒体 Index 不可访问或不是普通目录。");
    if (index.hasSnapshot) await index.assertMetadataFile(index.snapshotPath);
    if (index.hasJournal) await index.assertMetadataFile(index.journalPath);
  }
  if (create) index.allowInitialize = true;
  if (create || writable) await index.run(async () => {
    await index.assertWritable(signal);
    await index.recoverPendingRenames(signal);
    await index.recoverPendingMerges(signal);
    if (!index.orphansRecovered) await index.recoverOrphans(signal);
  });
  return index;
}

export function clearPersonMediaIndexCache(personId) {
  for (const key of indexes.keys()) if (!personId || key.startsWith(`${personId}\0`)) indexes.delete(key);
}
