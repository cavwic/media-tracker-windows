import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { discoveryDiagnostics, normalizeSyncSummary, legacyHistoryAttemptAt } from "./sync-verification.mjs";

const EMPTY_INDEX = Object.freeze({ version: 3, layout: "person-v1", scopes: {}, summaries: {}, receipts: {}, storageInitialized: {} });
export const SYNC_COMPLETION_VERSION = 1;
export const DEFAULT_READABLE_REBUILD_ID = "readable-names-v1";
const READABLE_REBUILD_IDS = new Set([DEFAULT_READABLE_REBUILD_ID, "legacy-date-v1", "beijing-date-v1"]);

export function readableRebuildRecords(index, rebuildId = DEFAULT_READABLE_REBUILD_ID) {
  if (!READABLE_REBUILD_IDS.has(rebuildId)) throw new Error("不支持的受控重建轮次。");
  const marker = index.readableNamingRebuild;
  if (marker && (marker.version !== 1 || !marker.persons || typeof marker.persons !== "object" || Array.isArray(marker.persons)
    || (marker.runs && (typeof marker.runs !== "object" || Array.isArray(marker.runs))))) {
    throw new Error("命名重建标记无效；未清空同步记录。");
  }
  if (rebuildId === DEFAULT_READABLE_REBUILD_ID) return marker?.persons || {};
  const run = marker?.runs?.[rebuildId];
  if (run && (run.version !== 1 || !run.persons || typeof run.persons !== "object" || Array.isArray(run.persons))) {
    throw new Error("该轮命名重建标记无效；未清空同步记录。");
  }
  return run?.persons || {};
}

async function durableWrite(filePath, contents, { replace = true } = {}) {
  const temporary = replace ? `${filePath}.${randomUUID()}.tmp` : filePath;
  const handle = await open(temporary, "wx");
  try {
    const buffer = Buffer.from(contents);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
      if (!bytesWritten) throw new Error("同步索引未能完整写入。");
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  if (replace) {
    try { await rename(temporary, filePath); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
}

export function syncScopeKey(personId, platformId, accountId) {
  return `${personId}:${platformId}:${accountId}`;
}

function emptyScope() {
  return {
    knownPosts: {},
    media: {},
    hashes: {},
    pendingMedia: {},
    pendingPosts: {},
    initialComplete: false,
    scanCompletedAt: null,
    mediaPolicy: null,
    existingFilesIndexedAt: null,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
  };
}

export class SyncStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.index = structuredClone(EMPTY_INDEX);
    this.ready = this.load();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const original = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(original);
      if (!Number.isInteger(parsed?.version) || parsed.version > 3 || parsed.version < 1) {
        throw new Error("同步索引版本无效；原文件未重置。");
      }
      if (parsed.version < 3) {
        // The user backed up/cleared media. Reset only the old account checkpoints, never state/login profiles.
        const backupPath = `${this.filePath}.v${parsed.version}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
        await durableWrite(backupPath, original, { replace: false });
        const replacement = { ...structuredClone(EMPTY_INDEX), migration: {
          fromVersion: parsed.version, completedAt: new Date().toISOString(), backupFile: path.basename(backupPath),
        } };
        await durableWrite(this.filePath, `${JSON.stringify(replacement, null, 2)}\n`);
        this.index = replacement;
        return;
      }
      if (parsed.layout !== EMPTY_INDEX.layout) throw new Error("同步索引的媒体目录版本不匹配；原文件未重置。");
      if (parsed.completionVerification && (parsed.completionVerification.version !== SYNC_COMPLETION_VERSION
        || typeof parsed.completionVerification.startedAt !== "string"
        || typeof parsed.completionVerification.backupFile !== "string"
        || path.basename(parsed.completionVerification.backupFile) !== parsed.completionVerification.backupFile)) {
        throw new Error("同步完整性核验标记无效；原文件未重置。");
      }
      this.index = {
        version: 3,
        layout: EMPTY_INDEX.layout,
        scopes: parsed?.scopes && typeof parsed.scopes === "object" ? parsed.scopes : {},
        summaries: parsed?.summaries && typeof parsed.summaries === "object" ? parsed.summaries : {},
        receipts: parsed?.receipts && typeof parsed.receipts === "object" ? parsed.receipts : {},
        storageInitialized: parsed?.storageInitialized && typeof parsed.storageInitialized === "object" ? parsed.storageInitialized : {},
        ...(parsed.migration ? { migration: parsed.migration } : {}),
        ...(parsed.readableNamingRebuild ? { readableNamingRebuild: parsed.readableNamingRebuild } : {}),
        ...(parsed.completionVerification ? { completionVerification: parsed.completionVerification } : {}),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async scope(key) {
    await this.ready;
    if (!this.index.scopes[key]) this.index.scopes[key] = emptyScope();
    const scope = this.index.scopes[key];
    scope.knownPosts ||= {};
    scope.media ||= {};
    scope.hashes ||= {};
    scope.pendingMedia ||= {};
    scope.pendingPosts ||= {};
    return scope;
  }

  async save() {
    await this.ready;
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => durableWrite(this.filePath, `${JSON.stringify(this.index, null, 2)}\n`));
    return this.writeQueue;
  }

  async ensureCompletionVerification(key, version = SYNC_COMPLETION_VERSION) {
    await this.ready;
    const scope = await this.scope(key);
    const legacyAttempt = () => legacyHistoryAttemptAt(scope, { version,
      verificationStartedAt: this.index.completionVerification?.startedAt });
    if (scope.completionVersion === version || (!scope.initialComplete && scope.completionVerificationRequired === version && !legacyAttempt())) return;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      if (scope.completionVersion === version) return;
      if (!scope.initialComplete && scope.completionVerificationRequired === version) {
        const fixedAttempt = legacyAttempt();
        if (!fixedAttempt) return;
        const previousHistory = scope.historyVerification;
        scope.historyVerification = { version, status: "pending", lastAttemptAt: fixedAttempt, legacyAttemptRecovered: true };
        try { await durableWrite(this.filePath, `${JSON.stringify(this.index, null, 2)}\n`); }
        catch (error) {
          if (previousHistory === undefined) delete scope.historyVerification;
          else scope.historyVerification = previousHistory;
          throw error;
        }
        return;
      }
      // Back up the actual persisted index once before distrusting legacy
      // completion flags. Never clear media, receipts, retries or watermarks.
      if (!this.index.completionVerification && Object.values(this.index.scopes).some((item) => item.initialComplete && item.completionVersion !== version)) {
        const original = await readFile(this.filePath, "utf8");
        const backupPath = `${this.filePath}.completion-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
        await durableWrite(backupPath, original, { replace: false });
        this.index.completionVerification = { version, startedAt: new Date().toISOString(), backupFile: path.basename(backupPath) };
      }
      const previousComplete = scope.initialComplete;
      const previousRequired = scope.completionVerificationRequired;
      const previousHistory = scope.historyVerification;
      scope.initialComplete = false;
      scope.completionVerificationRequired = version;
      scope.historyVerification = { version, status: "pending", lastAttemptAt: null };
      try { await durableWrite(this.filePath, `${JSON.stringify(this.index, null, 2)}\n`); }
      catch (error) {
        scope.initialComplete = previousComplete;
        if (previousRequired === undefined) delete scope.completionVerificationRequired;
        else scope.completionVerificationRequired = previousRequired;
        if (previousHistory === undefined) delete scope.historyVerification;
        else scope.historyVerification = previousHistory;
        throw error;
      }
    });
    return this.writeQueue;
  }

  async markPostRefreshAttempts(key, urls) {
    const scope = await this.scope(key);
    const selected = new Set(urls);
    let changed = false;
    for (const pending of Object.values(scope.pendingPosts)) {
      if (selected.has(pending.postUrl)) {
        pending.lastAttemptAt = new Date().toISOString();
        pending.attempts = (pending.attempts || 0) + 1;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async markHistoryCheckStarted(key, startedAt) {
    const scope = await this.scope(key);
    scope.historyVerification = { ...scope.historyVerification, version: SYNC_COMPLETION_VERSION,
      status: "pending", lastAttemptAt: startedAt };
    await this.save();
  }

  async personStorageInitialized(personId) {
    await this.ready;
    return Boolean(this.index.storageInitialized[personId]);
  }

  async markPersonStorageInitialized(personId) {
    await this.ready;
    if (this.index.storageInitialized[personId]) return;
    this.index.storageInitialized[personId] = new Date().toISOString();
    await this.save();
  }

  async markPosts(key, posts) {
    const scope = await this.scope(key);
    for (const post of posts) scope.knownPosts[post.postKey] = post.createdAt || true;
    await this.save();
  }

  async seedHash(key, sha256, relativePath) {
    const scope = await this.scope(key);
    scope.hashes[sha256] = relativePath;
  }

  async finishExistingFileIndex(key) {
    const scope = await this.scope(key);
    scope.existingFilesIndexedAt = new Date().toISOString();
    await this.save();
  }

  async markMedia(key, item, record) {
    const scope = await this.scope(key);
    const previousMedia = scope.media[item.logicalKey];
    const originMediaId = record.originMediaId || (previousMedia?.mediaId === record.mediaId ? previousMedia?.originMediaId : null);
    scope.media[item.logicalKey] = {
      postId: item.postId,
      postUrl: item.postUrl || null,
      createdAt: item.createdAt || null,
      publicationDate: item.publicationDate || null,
      dateBasis: item.dateBasis || null,
      displayTimeZone: item.displayTimeZone || null,
      mediaIndex: item.mediaIndex ?? null,
      kind: record.kind || item.kind,
      originalKind: item.kind,
      ...(record.mediaId ? { mediaId: record.mediaId } : { sha256: record.sha256, relativePath: record.relativePath }),
      ...(typeof originMediaId === "string" && /^[a-f0-9]{64}$/.test(originMediaId)
        && originMediaId !== record.mediaId ? { originMediaId } : {}),
      sourceUrl: record.sourceUrl || item.sourceUrl,
      bitrate: Object.hasOwn(record, "bitrate") ? record.bitrate : (item.bitrate ?? null),
      fallbackUsed: Boolean(record.fallbackUsed),
      savedAt: new Date().toISOString(),
      duplicateOf: record.duplicateOf || null,
    };
    delete scope.pendingMedia[item.logicalKey];
    // Compatibility for old direct downloader callers only; production assets are person-index references.
    if (!record.mediaId && record.sha256 && record.relativePath) scope.hashes[record.sha256] = record.relativePath;
    await this.save();
  }

  async recordDiscovery(key, { posts, media, complete, startedAt, mediaPolicy, unresolvedMedia = [],
    availableMediaKeys = [], completionVersion = SYNC_COMPLETION_VERSION, completionReason = null,
    rangeComplete = complete, rangeCompletionReason = completionReason, headCaptured = false, scanMode = "history", diagnostics = {}, unavailablePosts = [] }) {
    const scope = await this.scope(key);
    for (const post of posts) scope.knownPosts[post.postKey] = post.createdAt || true;
    const expectedByPost = new Map(posts.map((post) => [String(post.postKey), Number.isSafeInteger(post.mediaExpectedCount)
      && post.mediaExpectedCount >= 0 ? post.mediaExpectedCount : media.filter((item) => item.postKey === post.postKey).length]));
    const expectedKeys = new Map(posts.map((post) => [String(post.postKey), Array.isArray(post.mediaExpectedKeys)
      ? [...new Set(post.mediaExpectedKeys.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 1000))].slice(0, 2000) : []]));
    for (const post of posts) {
      const previous = Object.hasOwn(scope.pendingPosts, post.postKey) ? scope.pendingPosts[post.postKey] : null;
      const provedKeys = new Set([...availableMediaKeys,
        ...media.filter((item) => item.postKey === post.postKey).map((item) => item.logicalKey)]);
      const oldKeysResolved = (previous?.mediaExpectedKeys || []).every((key) => provedKeys.has(key));
      if (post.mediaComplete === true && oldKeysResolved
        && (expectedByPost.get(String(post.postKey)) || 0) >= (previous?.mediaExpectedCount || 0)) {
        delete scope.pendingPosts[post.postKey];
      }
    }
    const missing = [...posts.filter((post) => post.mediaComplete === false).map((post) => ({ ...post, reason: "media-incomplete" })), ...unresolvedMedia];
    for (const item of missing) {
      const postKey = String(item.postKey || item.postId || "");
      if (!postKey || postKey.length > 512) continue;
      const previous = Object.hasOwn(scope.pendingPosts, postKey) ? scope.pendingPosts[postKey] : null;
      Object.defineProperty(scope.pendingPosts, postKey, { configurable: true, enumerable: true, writable: true, value: {
        postKey, postId: String(item.postId || postKey), postUrl: item.postUrl || previous?.postUrl || null,
        reason: String(item.reason || "media-incomplete").slice(0, 200),
        mediaExpectedCount: Math.max(previous?.mediaExpectedCount || 0, expectedByPost.get(postKey) || 0,
          Number.isSafeInteger(item.mediaExpectedCount) && item.mediaExpectedCount >= 0 ? item.mediaExpectedCount : 0),
        mediaExpectedKeys: [...new Set([...(previous?.mediaExpectedKeys || []), ...(expectedKeys.get(postKey) || [])])].slice(0, 2000),
        firstSeenAt: previous?.firstSeenAt || new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        lastAttemptAt: previous?.lastAttemptAt || null, attempts: previous?.attempts || 0,
      } });
    }
    // An explicit deleted/nonexistent post resolves only an untyped placeholder.
    // Never remove archived media or silently erase a previously known album gap.
    scope.unavailablePosts ||= {};
    for (const item of unavailablePosts) {
      const postKey = String(item.postKey || item.postId || "");
      if (!postKey || postKey.length > 512 || !/^[a-z0-9_-]+$/i.test(postKey)) continue;
      const previous = Object.hasOwn(scope.pendingPosts, postKey) ? scope.pendingPosts[postKey] : null;
      Object.defineProperty(scope.unavailablePosts, postKey, { enumerable: true, configurable: true, writable: true,
        value: { postKey, postId: String(item.postId || postKey), reasonCode: String(item.reasonCode || "post-unavailable").slice(0, 100),
          observedAt: new Date().toISOString() } });
      if (previous && !(previous.mediaExpectedCount > 0) && !previous.mediaExpectedKeys?.length) delete scope.pendingPosts[postKey];
      else if (previous) previous.unavailableReason = scope.unavailablePosts[postKey].reasonCode;
    }
    for (const item of media) {
      if (!scope.media[item.logicalKey] || scope.pendingMedia[item.logicalKey]) {
        // Only parser metadata is persisted. Runtime credentials/request callbacks stay in memory.
        const { fetchMedia, headers, cookies, downloadHeaders, ...metadata } = item;
        scope.pendingMedia[item.logicalKey] = metadata;
      }
    }
    if (complete && !Object.keys(scope.pendingPosts).length) {
      scope.initialComplete = true;
      scope.scanCompletedAt = startedAt;
      scope.mediaPolicy = mediaPolicy;
      scope.completionVersion = completionVersion;
      scope.completionReason = completionReason;
      delete scope.completionVerificationRequired;
      scope.historyVerification = { ...scope.historyVerification, version: completionVersion,
        status: "verified", verifiedAt: new Date().toISOString() };
    }
    if (headCaptured && !scope.incrementalBaselineAt) scope.incrementalBaselineAt = startedAt;
    if (rangeComplete) scope.incrementalCheckpoint = { version: 1, scanStartedAt: startedAt,
      verifiedAt: new Date().toISOString(), completionReason: rangeCompletionReason };
    // Record the policy actually used in a captured recent range. This avoids
    // repeating a full traversal merely because an old album cannot be proved
    // complete, while a transport failure cannot falsely commit a policy change.
    if (headCaptured || rangeComplete || complete) scope.lastScanMediaPolicy = mediaPolicy;
    scope.lastDiscovery = discoveryDiagnostics(diagnostics, { scanMode, checkedAt: new Date().toISOString(), pendingPosts: scope.pendingPosts,
      availableMediaKeys: [...availableMediaKeys, ...media.map((item) => item.logicalKey)] });
    await this.save();
  }

  async markPending(key, item, message = "") {
    const scope = await this.scope(key);
    const { fetchMedia, headers, cookies, downloadHeaders, ...metadata } = item;
    scope.pendingMedia[item.logicalKey] = { ...metadata, lastError: message, lastAttemptAt: new Date().toISOString() };
    await this.save();
  }

  async removePerson(personId) {
    await this.ready;
    for (const key of Object.keys(this.index.scopes)) {
      if (key.startsWith(`${personId}:`)) delete this.index.scopes[key];
    }
    delete this.index.summaries[personId];
    delete this.index.receipts[personId];
    delete this.index.storageInitialized[personId];
    await this.save();
  }

  // Called only by explicit, offline maintenance after filesystem emptiness checks.
  // Missing directories during normal sync must never invoke this operation.
  async rebuildClearedPersons(personIds, { backupFile, completedAt = new Date().toISOString(), expectedContents,
    rebuildId = DEFAULT_READABLE_REBUILD_ID } = {}) {
    await this.ready;
    if (!Array.isArray(personIds) || personIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
      throw new Error("重建人物标识无效。");
    }
    if (!backupFile || path.basename(backupFile) !== backupFile) throw new Error("必须先保存同步索引备份。");
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const marker = this.index.readableNamingRebuild;
      const completed = readableRebuildRecords(this.index, rebuildId);
      const selected = [...new Set(personIds)].filter((id) => !Object.hasOwn(completed, id));
      if (!selected.length) return [];
      const original = await readFile(this.filePath);
      if (expectedContents !== undefined && !original.equals(Buffer.from(expectedContents))) {
        throw new Error("同步索引在维护期间发生变化；未清空同步记录。");
      }
      const backupPath = path.join(path.dirname(this.filePath), backupFile);
      const backupInfo = await lstat(backupPath);
      if (!backupInfo.isFile() || backupInfo.isSymbolicLink() || !original.equals(await readFile(backupPath))) {
        throw new Error("同步索引备份不是完整的原文件；未清空同步记录。");
      }
      const replacement = structuredClone(this.index);
      replacement.readableNamingRebuild = { ...(marker || {}), version: 1, persons: { ...(marker?.persons || {}) } };
      if (rebuildId !== DEFAULT_READABLE_REBUILD_ID) {
        replacement.readableNamingRebuild.runs = { ...(marker?.runs || {}), [rebuildId]: { version: 1, persons: { ...completed } } };
      }
      const newCompleted = readableRebuildRecords(replacement, rebuildId);
      for (const personId of selected) {
        for (const key of Object.keys(replacement.scopes)) {
          if (key.startsWith(`${personId}:`)) delete replacement.scopes[key];
        }
        delete replacement.summaries[personId];
        delete replacement.receipts[personId];
        delete replacement.storageInitialized[personId];
        newCompleted[personId] = { completedAt, backupFile };
      }
      await durableWrite(this.filePath, `${JSON.stringify(replacement, null, 2)}\n`);
      this.index = replacement;
      return selected;
    });
    return this.writeQueue;
  }

  async finishScope(key, { complete, successful }) {
    const scope = await this.scope(key);
    scope.initialComplete ||= Boolean(complete);
    scope.lastSyncAt = new Date().toISOString();
    if (successful) scope.lastSuccessfulSyncAt = scope.lastSyncAt;
    await this.save();
  }

  async saveSummary(personId, summary, newFiles = []) {
    await this.ready;
    this.index.summaries[personId] = structuredClone(summary);
    this.index.receipts[personId] = {
      jobId: String(summary?.id || ""),
      finishedAt: summary?.finishedAt || null,
      files: structuredClone(newFiles),
    };
    await this.save();
  }

  async receipt(personId) {
    await this.ready;
    return this.index.receipts[personId] ? structuredClone(this.index.receipts[personId]) : null;
  }

  async summary(personId) {
    await this.ready;
    const saved = this.index.summaries[personId] ? structuredClone(this.index.summaries[personId]) : null;
    if (saved && ["queued", "running"].includes(saved.status)) {
      saved.status = "failed";
      saved.phase = "failed";
      saved.finishedAt ||= new Date().toISOString();
      saved.message = "上次同步因本地服务关闭而中断，请重新开始增量同步。";
      saved.errors = [
        ...(saved.errors || []),
        { platform: "", account: "", code: "service-interrupted", message: saved.message },
      ].slice(-20);
    }
    return normalizeSyncSummary(saved);
  }
}
