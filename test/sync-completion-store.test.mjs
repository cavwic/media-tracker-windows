import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { SyncStore, SYNC_COMPLETION_VERSION } from "../lib/sync-store.mjs";
import { selectScopeScan } from "../lib/sync-verification.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-completion-store-"));
  const file = path.join(root, "sync-index.json");
  const original = JSON.stringify({ version: 3, layout: "person-v1", scopes: {
    "p:facebook:a": { initialComplete: true, knownPosts: { old: "2026-07-24T00:00:00Z" }, media: { "old:1": { mediaId: "asset" } },
      pendingMedia: { "failed:1": { postId: "failed", lastError: "404" } }, hashes: {}, scanCompletedAt: "2026-10-02T00:00:00Z",
      lastSuccessfulSyncAt: "2026-10-02T00:00:00Z", mediaPolicy: "image,video,gif" },
    "p:x:b": { initialComplete: true, knownPosts: { x: true }, media: {} },
  }, summaries: { p: { status: "completed" } }, receipts: { p: { files: [{ mediaId: "asset" }] } }, storageInitialized: { p: "2026-10-02" } }, null, 2);
  await writeFile(file, original);
  return { root, file, original, store: new SyncStore(file) };
}

test("completion upgrade is lazy, backed up once, and never clears files, records, retries, receipts or watermarks", async () => {
  const f = await fixture();
  try {
    await f.store.ready;
    assert.equal(await readFile(f.file, "utf8"), f.original);
    const old = JSON.parse(f.original);
    await Promise.all([f.store.ensureCompletionVerification("p:facebook:a"), f.store.ensureCompletionVerification("p:x:b")]);
    const updated = JSON.parse(await readFile(f.file, "utf8"));
    const backups = (await readdir(f.root)).filter((name) => name.includes("completion-backup"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(f.root, backups[0]), "utf8"), f.original);
    for (const key of Object.keys(old.scopes)) {
      const scope = updated.scopes[key];
      assert.equal(scope.initialComplete, false);
      assert.equal(scope.completionVerificationRequired, SYNC_COMPLETION_VERSION);
      for (const field of ["media", "knownPosts", "pendingMedia", "scanCompletedAt", "lastSuccessfulSyncAt", "mediaPolicy"]) {
        if (Object.hasOwn(old.scopes[key], field)) assert.deepEqual(scope[field], old.scopes[key][field]);
      }
    }
    assert.deepEqual(updated.receipts, old.receipts);
    assert.deepEqual(updated.summaries, old.summaries);
    assert.deepEqual(updated.storageInitialized, old.storageInitialized);
    const restarted = new SyncStore(f.file);
    await restarted.ensureCompletionVerification("p:facebook:a");
    assert.equal((await readdir(f.root)).filter((name) => name.includes("completion-backup")).length, 1);
    await restarted.recordDiscovery("p:facebook:a", { posts: [], media: [], complete: true, startedAt: "2026-10-05T00:00:00Z", completionReason: "terminal-page" });
    const finished = await restarted.scope("p:facebook:a");
    assert.equal(finished.initialComplete, true);
    assert.equal(finished.completionVersion, SYNC_COMPLETION_VERSION);
    assert.equal(finished.completionReason, "terminal-page");
    await new SyncStore(f.file).ensureCompletionVerification("p:facebook:a");
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).scopes["p:facebook:a"].initialComplete, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing attachment metadata persists across restart and cannot be erased by omitted or shrunken posts", async () => {
  const f = await fixture();
  const key = "p:facebook:a";
  const args = { media: [], complete: false, startedAt: "2026-10-05T00:00:00Z" };
  try {
    await f.store.ensureCompletionVerification(key);
    await f.store.recordDiscovery(key, { ...args, posts: [{ postKey: "album", postId: "album", postUrl: "https://example/album", mediaComplete: false, mediaExpectedCount: 3 }],
      unresolvedMedia: [{ postKey: "album", logicalKey: "album:3", reason: "attachment-missing" }] });
    const next = new SyncStore(f.file);
    await next.recordDiscovery(key, { ...args, posts: [], complete: true });
    let scope = await next.scope(key);
    assert.equal(scope.initialComplete, false);
    assert.deepEqual(Object.keys(scope.pendingMedia), ["failed:1"], "Missing URLs are not downloadable pendingMedia");
    assert.equal(scope.pendingPosts.album.mediaExpectedCount, 3);
    await next.recordDiscovery(key, { ...args, posts: [{ postKey: "album", mediaComplete: true, mediaExpectedCount: 2 }], complete: true });
    assert.equal(scope.initialComplete, false);
    assert.ok(scope.pendingPosts.album);
    await next.markPostRefreshAttempts(key, ["https://example/album"]);
    assert.equal(scope.pendingPosts.album.attempts, 1);
    await next.recordDiscovery(key, { ...args, posts: [{ postKey: "album", mediaComplete: true, mediaExpectedCount: 3 }], complete: true });
    assert.deepEqual(scope.pendingPosts, {});
    assert.equal(scope.initialComplete, true);
    assert.equal(scope.completionVersion, SYNC_COMPLETION_VERSION);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed completion-marker persistence rolls back flags and retries safely", async () => {
  const f = await fixture();
  try {
    await f.store.ready;
    f.store.index.completionVerification = { version: SYNC_COMPLETION_VERSION, startedAt: "2026-10-05", backupFile: "fixture-backup.json" };
    // Create a local temporary rename obstruction, never a production path.
    await rm(f.file);
    await mkdir(f.file);
    await assert.rejects(f.store.ensureCompletionVerification("p:facebook:a"));
    const scope = await f.store.scope("p:facebook:a");
    assert.equal(scope.initialComplete, true);
    assert.equal(scope.completionVerificationRequired, undefined);
    await rm(f.file, { recursive: true });
    await writeFile(f.file, f.original);
    await f.store.ensureCompletionVerification("p:facebook:a");
    assert.equal(scope.initialComplete, false);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).scopes["p:facebook:a"].completionVerificationRequired, SYNC_COMPLETION_VERSION);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("legacy history-attempt recovery is fixed across frequent incremental syncs and restarts", async () => {
  const f = await fixture();
  try {
    const scope = await f.store.scope("p:x:b");
    scope.initialComplete = false;
    scope.completionVerificationRequired = SYNC_COMPLETION_VERSION;
    scope.lastSyncAt = "2026-10-05T13:00:00Z";
    scope.scanCompletedAt = "2026-10-02T00:00:00Z";
    scope.lastDiscovery = { scanMode: "incremental", checkedAt: "2026-10-05T13:00:00Z" };
    delete scope.historyVerification;
    f.store.index.completionVerification = { version: SYNC_COMPLETION_VERSION, startedAt: "2026-10-05T12:00:00Z", backupFile: "fixture-backup.json" };
    await f.store.save();
    const originalMedia = structuredClone(scope.media);
    await f.store.ensureCompletionVerification("p:x:b");
    assert.equal(scope.historyVerification.lastAttemptAt, "2026-10-05T12:00:00.000Z");
    assert.equal(scope.historyVerification.legacyAttemptRecovered, true);
    scope.lastSyncAt = "2026-10-06T10:00:00Z";
    await f.store.save();
    const restarted = new SyncStore(f.file);
    await restarted.ensureCompletionVerification("p:x:b");
    const next = await restarted.scope("p:x:b");
    assert.equal(next.historyVerification.lastAttemptAt, "2026-10-05T12:00:00.000Z");
    assert.equal(selectScopeScan(next, { version: SYNC_COMPLETION_VERSION,
      verificationStartedAt: "2026-10-05T12:00:00Z", now: Date.parse("2026-10-06T12:01:00Z") }).mode, "incremental");
    assert.deepEqual(next.media, originalMedia);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed persistence of a recovered legacy attempt does not falsely advance its in-memory schedule", async () => {
  const f = await fixture();
  try {
    const scope = await f.store.scope("p:x:b");
    scope.initialComplete = false;
    scope.completionVerificationRequired = SYNC_COMPLETION_VERSION;
    scope.lastSyncAt = "2026-10-05T13:00:00Z";
    delete scope.historyVerification;
    f.store.index.completionVerification = { version: SYNC_COMPLETION_VERSION, startedAt: "2026-10-05T12:00:00Z", backupFile: "fixture-backup.json" };
    await rm(f.file);
    await mkdir(f.file);
    await assert.rejects(f.store.ensureCompletionVerification("p:x:b"));
    assert.equal(scope.historyVerification, undefined);
    assert.equal(scope.initialComplete, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit unavailable observations clear only zero-media placeholders, preserving albums and archived references", async () => {
  const f = await fixture();
  try {
    const scope = await f.store.scope("p:x:b");
    scope.pendingPosts = { gone: { postKey: "gone", mediaExpectedCount: 0, mediaExpectedKeys: [] },
      album: { postKey: "album", mediaExpectedCount: 3, mediaExpectedKeys: ["album:1"] } };
    scope.media["album:1"] = { mediaId: "archived-asset" };
    await f.store.recordDiscovery("p:x:b", { posts: [], media: [], complete: false, rangeComplete: true,
      startedAt: "2026-10-05T14:00:00Z", scanMode: "incremental", completionReason: "known-boundary",
      unavailablePosts: ["gone", "album"].map(postKey => ({ postKey, reasonCode: "post-deleted" })) });
    assert.equal(scope.pendingPosts.gone, undefined);
    assert.equal(scope.pendingPosts.album.mediaExpectedCount, 3);
    assert.equal(scope.pendingPosts.album.unavailableReason, "post-deleted");
    assert.deepEqual(scope.media["album:1"], { mediaId: "archived-asset" });
    assert.equal(scope.incrementalCheckpoint.scanStartedAt, "2026-10-05T14:00:00Z");
    const restarted = await new SyncStore(f.file).scope("p:x:b");
    assert.ok(restarted.pendingPosts.album);
    assert.equal(restarted.unavailablePosts.gone.reasonCode, "post-deleted");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
