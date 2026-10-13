import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { SyncStore, syncScopeKey } from "../lib/sync-store.mjs";
import { createSyncBoundary } from "../lib/sync-boundary.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";
import { openPersonMediaIndex } from "../lib/person-media-index.mjs";

const PERSON_ID = "person-incremental";
const SCOPE_KEY = syncScopeKey(PERSON_ID, "x", "account-x");

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function media(postId) {
  return {
    platformId: "x", postId, postKey: postId, logicalKey: `${postId}:1`, mediaIndex: 1,
    kind: "video", sourceUrl: `https://video.example/${postId}.mp4`, extension: ".mp4",
    createdAt: "2026-09-01T10:00:00.000Z", postUrl: `https://x.com/creator/status/${postId}`,
  };
}

function discovery(items, complete = true) {
  return { posts: items.map(({ postKey, postId, createdAt }) => ({ postKey, postId, createdAt })), media: items, complete };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-incremental-"));
  const person = {
    id: PERSON_ID, name: "Incremental fixture", folderPath: path.join(root, "person"),
    platforms: [{ id: "x", label: "X", accounts: [{ id: "account-x", label: "@creator", folderName: "creator" }] }],
  };
  await mkdir(path.join(person.folderPath, "X", "creator"), { recursive: true });
  return {
    root, person, indexFile: path.join(root, "sync-index.json"),
    loadState: async () => ({ persons: [person], linkedAccounts: [] }),
  };
}

const saveDownload = fixtureDownload;

async function settle(manager, id) {
  await waitFor(() => {
    const job = manager.get(id);
    return job && !["queued", "running"].includes(job.status) && !manager.activeJobIds.has(id);
  }, "The sync job did not finish");
  await manager.store.writeQueue;
  return manager.get(id);
}

async function run(manager) {
  const { job } = await manager.start(PERSON_ID);
  return settle(manager, job.id);
}

test("a recent boundary updates its own checkpoint without claiming unverified historical completion or redownloading", async () => {
  const setup = await fixture();
  try {
    const first = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(first);
    const scope = await first.store.scope(SCOPE_KEY);
    const historicalTime = scope.scanCompletedAt;
    Object.assign(scope, { initialComplete: false, completionVerificationRequired: 1, completionVersion: undefined,
      historyVerification: { status: "pending", lastAttemptAt: new Date().toISOString() } });
    await first.store.save();
    const downloads = [];
    const next = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "incremental");
      assert.equal(options.initialComplete, true);
      return { ...discovery([media("old"), media("new")]), completionReason: "known-boundary", reachedKnownBoundary: true, rangeComplete: true };
    } }, download: async (item, ...args) => { downloads.push(item.postId); return saveDownload(item, ...args); } });
    const job = await run(next);
    const saved = await next.store.scope(SCOPE_KEY);
    assert.equal(job.counters.failed, 0);
    assert.equal(job.counters.historyPendingAccounts, 1);
    assert.ok(job.warnings.some(i => i.code === "history-verification-pending"));
    assert.deepEqual(downloads, ["new"]);
    assert.equal(saved.initialComplete, false);
    assert.equal(saved.completionVersion, undefined);
    assert.equal(saved.scanCompletedAt, historicalTime);
    assert.ok(saved.incrementalCheckpoint);
    const restarted = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "incremental");
      assert.equal(options.since, saved.incrementalCheckpoint.scanStartedAt);
      return { ...discovery([]), completionReason: "known-boundary", reachedKnownBoundary: true };
    } }, download: saveDownload });
    assert.equal((await run(restarted)).counters.failed, 0);
    assert.equal((await restarted.store.scope(SCOPE_KEY)).initialComplete, false);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("manual complete recheck bypasses history cooldown without redownloading indexed files or clearing provenance", async () => {
  const setup = await fixture();
  try {
    const first = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(first);
    const scope = await first.store.scope(SCOPE_KEY);
    scope.initialComplete = false;
    scope.completionVersion = undefined;
    scope.completionVerificationRequired = 1;
    scope.historyVerification = { status: "pending", lastAttemptAt: new Date().toISOString() };
    await first.store.save();
    const oldMediaId = scope.media["old:1"].mediaId;
    const downloads = [];
    const manager = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "history");
      assert.equal(options.initialComplete, false);
      assert.equal(options.since, null);
      assert.ok(options.knownMediaKeys.includes("old:1"));
      return { ...discovery([media("old"), media("new")]), reachedEnd: true, completionReason: "terminal-page" };
    } }, download: async (item, ...args) => { downloads.push(item.postId); return saveDownload(item, ...args); } });
    const started = await manager.start(PERSON_ID, { forceHistory: true });
    const job = await settle(manager, started.job.id);
    assert.equal(job.forceHistory, true);
    assert.equal(job.counters.failed, 0);
    assert.equal(job.counters.warnings, 0);
    assert.deepEqual(downloads, ["new"]);
    const saved = await manager.store.scope(SCOPE_KEY);
    assert.equal(saved.media["old:1"].mediaId, oldMediaId);
    assert.equal(saved.initialComplete, true);
    assert.equal(saved.historyVerification.status, "verified");
    assert.ok(saved.media["new:1"]);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("manual recheck preserves an attachment gap and refuses unsafe option values", async () => {
  const setup = await fixture();
  try {
    const manager = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(manager);
    const scope = await manager.store.scope(SCOPE_KEY);
    scope.pendingPosts.album = { postKey: "album", postId: "album", postUrl: media("album").postUrl,
      mediaExpectedCount: 3, mediaExpectedKeys: ["album:1", "album:2", "album:3"] };
    await manager.store.save();
    const repair = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.ok(options.retryPosts.includes(media("album").postUrl));
      return { ...discovery([media("old")]), reachedEnd: true, completionReason: "terminal-page" };
    } }, download: async () => { throw new Error("No repeat download allowed"); } });
    await assert.rejects(repair.start(PERSON_ID, { forceHistory: "true" }), { code: "invalid-sync-option" });
    const started = await repair.start(PERSON_ID, { forceHistory: true });
    const job = await settle(repair, started.job.id);
    assert.equal(job.counters.failed, 0);
    assert.ok(job.counters.warnings > 0);
    const saved = await repair.store.scope(SCOPE_KEY);
    assert.equal(saved.pendingPosts.album.mediaExpectedCount, 3);
    assert.deepEqual(saved.pendingPosts.album.mediaExpectedKeys, ["album:1", "album:2", "album:3"]);
    assert.ok(saved.media["old:1"]);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("a verified recent range preserves old missing albums while keeping the incremental boundary usable", async () => {
  const setup = await fixture();
  try {
    const manager = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(manager);
    const scope = await manager.store.scope(SCOPE_KEY);
    scope.pendingPosts.album = { postKey: "album", postId: "album", postUrl: media("album").postUrl, mediaExpectedCount: 3, mediaExpectedKeys: [] };
    await manager.store.save();
    const next = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.initialComplete, true);
      assert.ok(options.retryPosts.includes(media("album").postUrl));
      return { ...discovery([media("new")], false), rangeComplete: true, reachedKnownBoundary: true,
        rangeCompletionReason: "known-boundary",
        unresolvedMedia: [{ postKey: "album", postId: "album", mediaExpectedCount: 3, reason: "attachment-missing" }],
        parseIssues: [{ postKey: "album", reason: "attachment-missing" }] };
    } }, download: saveDownload });
    const job = await run(next), saved = await next.store.scope(SCOPE_KEY);
    assert.equal(job.counters.failed, 0);
    assert.equal(job.counters.pendingAccounts, 1);
    assert.equal(saved.pendingPosts.album.mediaExpectedCount, 3);
    assert.ok(Date.parse(saved.incrementalCheckpoint.scanStartedAt) >= Date.parse(job.startedAt));
    assert.equal(saved.incrementalCheckpoint.completionReason, "known-boundary");
    assert.equal(saved.lastDiscovery.rangeComplete, true);
    assert.equal(saved.lastDiscovery.rangeCompletionReason, "known-boundary");
    assert.ok(saved.media["old:1"]);
    assert.ok(saved.media["new:1"]);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("real feed access failures remain errors while partial discovered media is saved", async () => {
  const setup = await fixture();
  try {
    const manager = new SyncManager({ ...setup, discoverers: { x: async () => ({ ...discovery([media("ok")], false),
      parseIssues: [{ reason: "timeline-http-403" }] }) }, download: saveDownload });
    const job = await run(manager);
    assert.equal(job.counters.downloaded, 1);
    assert.equal(job.counters.failed, 1);
    assert.equal(job.counters.warnings, 0);
    assert.equal(job.errors[0].code, "timeline-read-failed");
    const scope = await manager.store.scope(SCOPE_KEY);
    assert.equal(scope.initialComplete, false);
    assert.equal(scope.incrementalCheckpoint, undefined);
    assert.deepEqual(scope.lastDiscovery.parseIssueCodes, ["timeline-http-403"]);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("legacy completion metadata cannot force a new full scan or redownload committed assets", async () => {
  const setup = await fixture();
  try {
    const first = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(first);
    const oldScope = await first.store.scope(SCOPE_KEY);
    delete oldScope.completionVersion;
    delete oldScope.completionReason;
    await first.store.save();
    const downloads = [];
    const repair = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.initialComplete, true);
      assert.equal(options.scanMode, "incremental");
      assert.equal(options.knownPosts.old, media("old").createdAt);
      assert.ok(options.knownMediaKeys.includes("old:1"));
      return discovery([media("old"), media("new")]);
    } }, download: async (item, root, scope, options) => {
      downloads.push(item.postId);
      assert.notEqual(item.postId, "old", "Existing file is never downloaded again during metadata recheck");
      return saveDownload(item, root, scope, options);
    } });
    const repaired = await run(repair);
    assert.equal(repaired.counters.failed, 0);
    assert.deepEqual(downloads, ["new"]);
    const next = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.initialComplete, true);
      return discovery([]);
    } }, download: async () => { throw new Error("No downloads expected"); } });
    assert.equal((await run(next)).counters.failed, 0);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("adapter parse failures override its premature complete flag while preserving discovered downloads", async () => {
  const setup = await fixture();
  try {
    const manager = new SyncManager({ ...setup, discoverers: { x: async () => ({ ...discovery([media("partial")]),
      parseIssues: ["unconfirmed-pagination"] }) }, download: saveDownload });
    const job = await run(manager);
    assert.equal(job.counters.downloaded, 1);
    assert.ok(job.warnings.some((item) => item.code === "timeline-incomplete"));
    assert.equal(job.counters.failed, 0);
    const scope = await manager.store.scope(SCOPE_KEY);
    assert.equal(scope.initialComplete, false);
    assert.equal(scope.scanCompletedAt, null);
    assert.ok(scope.media["partial:1"].mediaId);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("missing URL posts use a persistent metadata retry, not a bogus download, and resolve on the next scan", async () => {
  const setup = await fixture();
  const item = media("missing");
  try {
    const first = new SyncManager({ ...setup, discoverers: { x: async () => ({ posts: [{ postKey: "missing", postId: "missing",
      postUrl: item.postUrl, mediaExpectedCount: 1, mediaExpectedKeys: [item.logicalKey], mediaComplete: false }], media: [], complete: true,
      unresolvedMedia: [{ postKey: "missing", postId: "missing", postUrl: item.postUrl, logicalKey: item.logicalKey, reason: "media-url-missing" }] }) },
      download: async () => { throw new Error("An item with no URL must not be downloaded"); } });
    const partial = await run(first);
    assert.ok(partial.warnings.some((entry) => entry.code === "timeline-incomplete"));
    assert.equal(partial.counters.failed, 0);
    const pending = await first.store.scope(SCOPE_KEY);
    assert.deepEqual(pending.pendingMedia, {});
    assert.equal(pending.pendingPosts.missing.mediaExpectedCount, 1);
    const second = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.initialComplete, false);
      assert.deepEqual(options.retryPosts, [item.postUrl]);
      assert.equal(options.knownPostCoverage.missing.mediaExpectedCount, 1);
      return { ...discovery([item]), posts: [{ postKey: item.postKey, mediaComplete: true, mediaExpectedCount: 1,
        mediaExpectedKeys: [item.logicalKey] }] };
    } }, download: saveDownload });
    assert.equal((await run(second)).counters.failed, 0);
    const finished = await second.store.scope(SCOPE_KEY);
    assert.deepEqual(finished.pendingPosts, {});
    assert.ok(finished.media[item.logicalKey].mediaId);
    assert.equal(finished.initialComplete, true);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("a manually deleted pending-post asset cannot be used as coverage proof from a stale index", async () => {
  const setup = await fixture();
  const item = media("pending");
  try {
    const first = new SyncManager({ ...setup, discoverers: { x: async () => discovery([item]) }, download: saveDownload });
    await run(first);
    const scope = await first.store.scope(SCOPE_KEY);
    const index = await openPersonMediaIndex(setup.person);
    const file = await index.resolve(scope.media[item.logicalKey].mediaId);
    scope.pendingPosts.pending = { postKey: item.postKey, postId: item.postId, postUrl: item.postUrl,
      mediaExpectedCount: 1, mediaExpectedKeys: [item.logicalKey] };
    await first.store.save();
    await rm(file); // User deletion simulated only inside the temporary fixture.
    let checked = false;
    const next = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      checked = true;
      assert.equal(options.knownMediaKeys.includes(item.logicalKey), false);
      return { posts: [], media: [], complete: true };
    } }, download: async () => { throw new Error("No new URL was supplied"); } });
    const job = await run(next);
    assert.equal(checked, true);
    assert.ok(job.warnings.some((entry) => entry.code === "timeline-incomplete"));
    assert.ok((await next.store.scope(SCOPE_KEY)).pendingPosts.pending);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("completed discovery persists its boundary and failed media; a restarted manager retries old failures beyond the boundary", async () => {
  const setup = await fixture();
  try {
    const first = new SyncManager({ ...setup,
      discoverers: { x: async (options) => {
        assert.equal(options.initialComplete, false);
        return discovery([media("old-ok"), media("old-failed")]);
      } },
      download: async (item, root, scope, options) => {
        if (item.postId === "old-failed") throw new Error("HTTP 404");
        return saveDownload(item, root, scope, options);
      },
    });
    const firstJob = await run(first);
    assert.equal(firstJob.counters.failed, 1);
    const diskStore = new SyncStore(setup.indexFile);
    const persisted = await diskStore.scope(SCOPE_KEY);
    assert.equal(persisted.initialComplete, true);
    assert.ok(persisted.scanCompletedAt);
    assert.match(persisted.pendingMedia["old-failed:1"].lastError, /404/);
    assert.deepEqual(Object.keys(persisted.media), ["old-ok:1"]);

    const downloaded = [];
    let discoverCalls = 0;
    const second = new SyncManager({ ...setup,
      discoverers: { x: async (options) => {
        discoverCalls += 1;
        assert.equal(options.initialComplete, true);
        assert.equal(options.since, persisted.scanCompletedAt);
        assert.equal(Object.keys(options.knownPosts).length, 2);
        assert.deepEqual(options.retryPosts, [media("old-failed").postUrl]);
        return discovery([media("new")]);
      } },
      download: async (item, root, scope, options) => { downloaded.push(item.postId); return saveDownload(item, root, scope, options); },
    });
    const secondJob = await run(second);
    assert.equal(discoverCalls, 1);
    assert.equal(secondJob.counters.failed, 0);
    assert.deepEqual(downloaded, ["old-failed", "new"]);
    const finalScope = await new SyncStore(setup.indexFile).scope(SCOPE_KEY);
    assert.deepEqual(Object.keys(finalScope.pendingMedia), []);
    assert.deepEqual(Object.keys(finalScope.media).sort(), ["new:1", "old-failed:1", "old-ok:1"]);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("an incomplete timeline scan cannot advance an existing or migrated legacy time boundary", async () => {
  const setup = await fixture();
  try {
    const earlier = "2026-09-01T00:00:00.000Z";
    const manager = new SyncManager({ ...setup, discoverers: { x: async () => discovery([], false) }, download: saveDownload });
    const scope = await manager.store.scope(SCOPE_KEY);
    Object.assign(scope, { initialComplete: true, scanCompletedAt: earlier, lastSuccessfulSyncAt: earlier, existingFilesIndexedAt: earlier });
    await manager.store.save();
    const incomplete = await run(manager);
    assert.equal(incomplete.warnings.some((error) => error.code === "timeline-incomplete"), true);
    assert.equal(scope.scanCompletedAt, earlier);

    // Version-1 indexes have only lastSuccessfulSyncAt; it must not become a false scan watermark.
    scope.scanCompletedAt = null;
    scope.lastSuccessfulSyncAt = earlier;
    await manager.store.save();
    await run(manager);
    assert.equal(scope.scanCompletedAt || scope.lastSuccessfulSyncAt, earlier);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("cancelling during downloads preserves the whole discovered queue across process restarts", async () => {
  const setup = await fixture();
  try {
    let downloading = false;
    const manager = new SyncManager({ ...setup,
      discoverers: { x: async () => discovery([media("one"), media("two"), media("three")]) },
      download: async (item, root, scope, { signal }) => {
        downloading = true;
        await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new DOMException("cancelled", "AbortError"));
          signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        });
      },
    });
    const { job } = await manager.start(PERSON_ID);
    await waitFor(() => downloading, "Download did not begin");
    manager.cancel(job.id);
    assert.equal((await settle(manager, job.id)).status, "cancelled");
    const persisted = await new SyncStore(setup.indexFile).scope(SCOPE_KEY);
    assert.equal(persisted.initialComplete, true);
    assert.deepEqual(Object.keys(persisted.pendingMedia).sort(), ["one:1", "three:1", "two:1"]);

    const downloaded = [];
    const restarted = new SyncManager({ ...setup,
      discoverers: { x: async (options) => {
        assert.equal(options.initialComplete, true);
        assert.deepEqual(options.retryPosts, []);
        return discovery([]);
      } },
      download: async (item, root, scope, options) => { downloaded.push(item.postId); return saveDownload(item, root, scope, options); },
    });
    const result = await run(restarted);
    assert.equal(result.counters.downloaded, 3);
    assert.deepEqual(downloaded.sort(), ["one", "three", "two"]);
    assert.deepEqual(Object.keys((await restarted.store.scope(SCOPE_KEY)).pendingMedia), []);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("deletion lock rejects starts already waiting for state and is released after a failed deletion", async () => {
  const setup = await fixture();
  try {
    let releaseState;
    const manager = new SyncManager({ ...setup, loadState: () => new Promise((resolve) => { releaseState = resolve; }) });
    const starting = manager.start(PERSON_ID);
    const rejected = assert.rejects(starting, { code: "person-deleting" });
    let releaseDeletion;
    const deleting = manager.withPersonDeletion(PERSON_ID, () => new Promise((resolve) => { releaseDeletion = resolve; }));
    releaseState(await setup.loadState());
    await rejected;
    assert.equal(manager.jobs.size, 0);
    releaseDeletion();
    await deleting;
    await assert.rejects(manager.withPersonDeletion(PERSON_ID, async () => { throw new Error("NAS unavailable"); }), /NAS unavailable/);
    assert.equal(manager.deletingPersonIds.has(PERSON_ID), false);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("simultaneous start requests for one person create only one job", async () => {
  const setup = await fixture();
  try {
    const manager = new SyncManager(setup);
    manager.drain = () => {};
    const results = await Promise.all([manager.start(PERSON_ID), manager.start(PERSON_ID)]);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    assert.equal(manager.jobs.size, 1);
    assert.equal(results.filter((result) => result.existing).length, 1);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("a completed deletion also invalidates a start holding a stale state snapshot", async () => {
  const setup = await fixture();
  try {
    let releaseState;
    const manager = new SyncManager({ ...setup, loadState: () => new Promise((resolve) => { releaseState = resolve; }) });
    const starting = manager.start(PERSON_ID);
    const rejected = assert.rejects(starting, { code: "person-deleting" });
    await manager.withPersonDeletion(PERSON_ID, async () => { await manager.removePersonData(PERSON_ID); });
    releaseState(await setup.loadState());
    await rejected;
    assert.equal(manager.jobs.size, 0);
    assert.equal(await manager.store.summary(PERSON_ID), null);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("old-post URL refreshes are capped at 50 failed posts, prioritizing the least recently retried", async () => {
  const setup = await fixture();
  try {
    let observed = false;
    const manager = new SyncManager({ ...setup,
      discoverers: { x: async (options) => {
        observed = true;
        assert.equal(options.retryPosts.length, 50);
        assert.equal(options.retryPosts[0], media("failed-0").postUrl);
        assert.equal(options.retryPosts[49], media("failed-49").postUrl);
        assert.equal(options.retryPosts.includes(media("not-attempted").postUrl), false);
        throw new Error("probe-complete");
      } },
    });
    const scope = await manager.store.scope(SCOPE_KEY);
    for (let index = 54; index >= 0; index -= 1) {
      const item = media(`failed-${index}`);
      scope.pendingMedia[item.logicalKey] = { ...item, lastError: "HTTP 403", lastAttemptAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString() };
    }
    const untouched = media("not-attempted");
    scope.pendingMedia[untouched.logicalKey] = untouched;
    await manager.store.save();
    const result = await run(manager);
    assert.equal(observed, true);
    assert.equal(result.errors.at(-1).message, "probe-complete");
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("incremental boundaries ignore pinned posts and repeated batches, then stop on two distinct old known batches", () => {
  const old = (id) => ({ postKey: id, createdAt: "2026-08-01T00:00:00.000Z" });
  const posts = [1, 2, 3, 4, 5, 6, 7].map((id) => old(String(id)));
  const boundary = createSyncBoundary({ initialComplete: true, since: "2026-09-01T00:00:00.000Z", knownPosts: Object.fromEntries(posts.map((post) => [post.postKey, true])) });
  assert.equal(boundary.observe([posts[0]]), false);
  assert.equal(boundary.observe(posts.slice(1, 4)), false);
  assert.equal(boundary.observe(posts.slice(1, 4)), false);
  assert.equal(boundary.observe(posts.slice(4, 7)), true);
  const firstScan = createSyncBoundary({ initialComplete: false, knownPosts: Object.fromEntries(posts.map((post) => [post.postKey, true])) });
  assert.equal(firstScan.observe(posts.slice(0, 3)), false);
  assert.equal(firstScan.observe(posts.slice(3, 6)), false);
});

test("boundary confirmation is reset by newly discovered old posts and ignores explicit pins and duplicates", () => {
  const old = (id, extra = {}) => ({ postKey: id, createdAt: "2026-08-01T00:00:00.000Z", ...extra });
  const knownPosts = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [String(index), true]));
  const boundary = createSyncBoundary({ initialComplete: true, since: "2026-09-01T00:00:00.000Z", knownPosts });
  assert.equal(boundary.observe([old("0"), old("0"), old("0")]), false);
  assert.equal(boundary.observe([old("1", { pinned: true }), old("2", { pinned: true }), old("3", { pinned: true })]), false);
  assert.equal(boundary.observe([old("4"), old("5"), old("6")]), false);
  assert.equal(boundary.observe([old("not-known")]), false);
  assert.equal(boundary.observe([old("7"), old("8"), old("9")]), false);
  assert.equal(boundary.observe([old("10"), old("11"), old("12")]), true);
});

test("persisted pending metadata excludes runtime credentials and callbacks", async () => {
  const setup = await fixture();
  try {
    const store = new SyncStore(setup.indexFile);
    const item = { ...media("credential-test"), cookies: [{ value: "secret-cookie" }], headers: { Cookie: "secret-cookie" }, downloadHeaders: { Cookie: "secret-cookie" }, fetchMedia() {} };
    await store.recordDiscovery(SCOPE_KEY, { posts: [], media: [item], complete: true, startedAt: "2026-09-01T00:00:00.000Z", mediaPolicy: "video" });
    await store.markPending(SCOPE_KEY, item, "timeout");
    const serialized = await readFile(setup.indexFile, "utf8");
    assert.doesNotMatch(serialized, /secret-cookie|downloadHeaders|fetchMedia/);
    assert.equal((await store.scope(SCOPE_KEY)).pendingMedia[item.logicalKey].lastError, "timeout");
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test("X, Instagram, Facebook and TikTok ordinary scans keep proven checkpoints despite obsolete history flags and pending albums", async () => {
  for (const platformId of ["x", "instagram", "facebook", "tiktok"]) {
    const setup = await fixture();
    setup.person.platforms[0].id = platformId;
    setup.person.platforms[0].label = platformId;
    setup.person.platforms[0].accounts[0].profileUrl = platformId === "facebook" ? "https://www.facebook.com/creator" : "";
    const key = syncScopeKey(PERSON_ID, platformId, "account-x");
    try {
      const bootstrap = new SyncManager({ ...setup, discoverers: { [platformId]: async () => discovery([media("old")]) }, download: saveDownload });
      await run(bootstrap);
      const scope = await bootstrap.store.scope(key), checkpoint = scope.incrementalCheckpoint.scanStartedAt;
      scope.initialComplete = false;
      scope.completionVersion = undefined;
      scope.completionVerificationRequired = 1;
      scope.historyVerification = { status: "pending", lastAttemptAt: "2020-01-01T00:00:00Z" };
      scope.pendingPosts.album = { postId: "album", postUrl: media("album").postUrl, mediaExpectedCount: 3 };
      await bootstrap.store.save();
      const next = new SyncManager({ ...setup, discoverers: { [platformId]: async (options) => {
        assert.equal(options.scanMode, "incremental", platformId);
        assert.equal(options.initialComplete, true, platformId);
        assert.equal(options.since, checkpoint, platformId);
        assert.deepEqual(options.retryPosts, [media("album").postUrl]);
        return { ...discovery([media("old")], false), rangeComplete: true, reachedKnownBoundary: true,
          rangeCompletionReason: "known-boundary" };
      } }, download: async () => { throw new Error("Known local media must not be downloaded again"); } });
      const result = await run(next), saved = await next.store.scope(key);
      assert.equal(result.operationStatus, "synced", platformId);
      assert.doesNotMatch(result.message, /待检查/);
      assert.equal(saved.pendingPosts.album.mediaExpectedCount, 3);
      assert.equal(saved.initialComplete, false, "Recent success must not fake complete history");
      assert.ok(saved.lastSuccessfulSyncAt, "Successfully captured recent range records success despite old diagnostics");
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  }
});

test("narrowing media selection remains incremental and newly enabling a type performs one scoped history backfill", async () => {
  const setup = await fixture();
  try {
    const bootstrap = new SyncManager({ ...setup, discoverers: { x: async () => discovery([media("old")]) }, download: saveDownload });
    await run(bootstrap);
    setup.person.platforms[0].accounts[0].downloadMedia = { image: true, video: false, gif: false };
    const narrowed = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "incremental");
      assert.ok(options.since);
      return { ...discovery([], false), rangeComplete: true, reachedKnownBoundary: true };
    } }, download: saveDownload });
    await run(narrowed);
    assert.equal((await narrowed.store.scope(SCOPE_KEY)).lastScanMediaPolicy, "image");
    setup.person.platforms[0].accounts[0].downloadMedia.video = true;
    const widened = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "history");
      assert.equal(options.since, null);
      assert.equal(options.initialComplete, false);
      return { ...discovery([], false), rangeComplete: true, headCaptured: true,
        parseIssues: [{ reason: "attachment-missing", postKey: "old-album" }] };
    } }, download: saveDownload });
    const enlarged = await run(widened);
    assert.equal(enlarged.accountResults[0].scanReason, "media-policy-expanded");
    const restarted = new SyncManager({ ...setup, discoverers: { x: async (options) => {
      assert.equal(options.scanMode, "incremental", "Old diagnostic gaps must not repeat the media-type backfill");
      return { ...discovery([]), reachedKnownBoundary: true, completionReason: "known-boundary" };
    } }, download: saveDownload });
    assert.equal((await run(restarted)).operationStatus, "synced");
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});
