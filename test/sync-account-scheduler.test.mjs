import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { AccountResourceScheduler } from "../lib/account-resource-scheduler.mjs";
import { syncScopeKey } from "../lib/sync-store.mjs";
import { openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function waitFor(predicate, message = "The offline account pipeline did not settle") {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
async function waitGate(gate, signal) {
  const aborted = deferred();
  const abort = () => aborted.reject(new DOMException("Fixture cancelled", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([gate.promise, aborted.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}

function item(platformId, postId) {
  return { platformId, postId, postKey: postId, logicalKey: `${postId}:1`, mediaId: `${postId}-media`, mediaIndex: 1,
    kind: "image", extension: ".jpg", sourceUrl: `https://fixture.invalid/${postId}.jpg`,
    postUrl: platformId === "instagram" ? `https://www.instagram.com/p/${postId}/` : `https://x.com/fixture/status/${postId}`,
    createdAt: "2026-09-01T10:00:00.000Z", publicationDate: "20260901", displayTimeZone: "Asia/Shanghai", dateBasis: "platform-timestamp" };
}
function discovery(items = [], additions = {}) {
  return { posts: items.map(({ postKey, postId, createdAt, postUrl }) => ({ postKey, postId, createdAt, postUrl, mediaComplete: true })),
    media: items, complete: true, reachedEnd: true, completionReason: "terminal-page", ...additions };
}

async function setup(t, definitions, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-account-pipeline-"));
  const linked = new Map();
  const persons = definitions.map(({ id, accounts }) => {
    const grouped = new Map();
    accounts.forEach((entry, position) => {
      const platform = entry.platform || "x";
      const binding = entry.binding === null ? null : entry.binding || `${id}-${platform}-login`;
      if (binding && !linked.has(binding)) linked.set(binding, { id: binding, platformId: platform, loginStatus: "verified",
        profileDirectory: path.join(root, "profiles", entry.profile || binding) });
      if (!grouped.has(platform)) grouped.set(platform, { id: platform, label: platform === "x" ? "X" : platform, accounts: [] });
      const handle = entry.handle || id;
      grouped.get(platform).accounts.push({ id: entry.id || `${id}-${platform}-${position}`, label: `@${handle}`,
        ...(platform === "facebook" ? { profileUrl: `https://www.facebook.com/profile.php?id=${entry.profileId || "123456"}` } : {}),
        ...(platform.startsWith("custom-") ? { profileUrl: `https://fixture.invalid/${handle}/` } : {}),
        ...(binding ? { linkedAccountId: binding } : {}),
        ...(entry.syncEnabled === undefined ? {} : { syncEnabled: entry.syncEnabled }) });
    });
    return { id, name: `Fixture ${id}`, folderPath: path.join(root, id), platforms: [...grouped.values()] };
  });
  for (const person of persons) await mkdir(person.folderPath);
  const state = { persons, linkedAccounts: [...linked.values()], customPlatforms: [
    { id: "custom-fixture", custom: true, label: "Fixture", engine: "auto", requiresLogin: false },
  ] };
  const { beforeShutdown, ...options } = changes;
  const manager = new SyncManager({ indexFile: path.join(root, "sync-index.json"), loadState: async () => state, ...options });
  t.after(async () => { await beforeShutdown?.(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, state, manager, person: persons[0], indexFile: path.join(root, "sync-index.json") };
}
async function settle(manager, jobId) {
  await waitFor(() => !manager.activeJobIds.has(jobId) && !["queued", "running"].includes(manager.get(jobId)?.status));
  await manager.store.writeQueue;
  return manager.get(jobId);
}

test("account resource FIFO reserves only that session, cancellation removes queued requests, and releases are idempotent", async () => {
  const active = new Set(["login:x"]), scheduler = new AccountResourceScheduler(active);
  const olderAbort = new AbortController(), laterAbort = new AbortController();
  const olderWaiting = [], laterWaiting = [];
  const older = scheduler.acquire({ keys: ["login:x", "login:x"], labels: { "login:x": "X" }, owner: { personName: "Older" },
    signal: olderAbort.signal, onWaiting: (waiting) => olderWaiting.push(waiting) });
  const later = scheduler.acquire({ keys: ["login:x"], labels: { "login:x": "X" }, owner: { personName: "Later" },
    signal: laterAbort.signal, onWaiting: (waiting) => laterWaiting.push(waiting) });
  const cancelled = assert.rejects(older, { name: "AbortError" });
  const releaseInstagram = await scheduler.acquire({ keys: ["login:instagram"], owner: { personName: "Free" } });
  assert.equal(scheduler.pending.length, 2);
  assert.ok(active.has("login:instagram"), "A blocked X lease must not reserve the free Instagram session");
  olderAbort.abort(); await cancelled;
  assert.equal(scheduler.pending.length, 1);
  assert.deepEqual(olderWaiting[0], [{ platform: "X", reason: "busy" }]);
  assert.equal(laterWaiting.at(-1)[0].reason, "busy");
  active.delete("login:x"); scheduler.drain();
  const releaseLater = await later;
  releaseInstagram(); releaseInstagram(); releaseLater(); releaseLater();
  assert.equal(active.size, 0);
  assert.equal(scheduler.active.size, 0);
  assert.equal(scheduler.pending.length, 0);
});

test("closing the account scheduler rejects queued sessions but never force-releases an active browser session", async () => {
  const active = new Set(), scheduler = new AccountResourceScheduler(active);
  const release = await scheduler.acquire({ keys: ["profile:fixture"], owner: { personName: "Active" } });
  const waiting = scheduler.acquire({ keys: ["profile:fixture"], owner: { personName: "Queued" } });
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  scheduler.close(); await rejected;
  assert.ok(active.has("profile:fixture"));
  assert.equal(scheduler.pending.length, 0);
  await assert.rejects(scheduler.acquire({ keys: [] }), { name: "AbortError" });
  release();
  assert.equal(active.size, 0);
  assert.equal(scheduler.active.size, 0);
});

test("URL-only X, Instagram, Facebook and custom lookup releases the shared profile before its media download", async (t) => {
  for (const platform of ["x", "instagram", "facebook", "custom-fixture"]) {
    await t.test(platform, async (t) => {
      const downloading = deferred(), releaseDownload = deferred(), lookups = [];
      let count = 0;
      const discoverer = async () => { count += 1; lookups.push(count); return discovery(count === 1 ? [item(platform, "FIRST")] : []); };
      const session = await setup(t, [
        { id: "first", accounts: [{ platform, binding: "shared" }] },
        { id: "later", accounts: [{ platform, binding: "shared" }] },
      ], { discoverers: { [platform === "custom-fixture" ? "custom" : platform]: discoverer },
        download: async (media, root, scope, options) => {
          downloading.resolve(); await waitGate(releaseDownload, options.signal);
          return fixtureDownload(media, root, scope, options);
        } });
      t.after(() => releaseDownload.resolve());
      const first = (await session.manager.start("first")).job;
      await downloading.promise;
      const later = (await session.manager.start("later")).job;
      await waitFor(() => lookups.length === 2, `${platform} kept its URL-only browser profile locked during an unrelated HTTP download`);
      assert.equal(session.manager.get(first.id).status, "running");
      const publicFirst = session.manager.get(first.id);
      assert.equal(publicFirst.accountProgress[0].phase, "downloading");
      assert.doesNotMatch(JSON.stringify(publicFirst), /profiles|login:|profile:|fixture\.invalid/);
      assert.equal((await settle(session.manager, later.id)).status, "completed");
      releaseDownload.resolve();
      const completed = await settle(session.manager, first.id);
      assert.equal(completed.counters.downloaded, 1);
      assert.equal(completed.counters.accountsFinished, 1);
      assert.equal(completed.counters.failed, 0);
    });
  }
});

test("TikTok and any adapter returning dispose keep the profile exclusive through downloads and disposal", async (t) => {
  for (const [platform, withDispose, anonymous] of [["tiktok", true, false], ["x", true, false], ["tiktok", false, true]]) {
    await t.test(`${platform}-${withDispose ? "dispose" : "anonymous"}`, async (t) => {
      const downloading = deferred(), releaseDownload = deferred(), disposing = deferred(), releaseDispose = deferred();
      const lookups = [];
      const session = await setup(t, [
        { id: "first", accounts: [{ platform, binding: anonymous ? null : "shared" }] },
        { id: "later", accounts: [{ platform, binding: anonymous ? null : "shared" }] },
      ], { beforeShutdown: () => { releaseDownload.resolve(); releaseDispose.resolve(); }, discoverers: { [platform]: async ({ handle }) => {
        lookups.push(handle);
        return discovery(handle === "first" ? [item(platform, "FIRST")] : [], handle === "first" && withDispose
          ? { dispose: async () => { disposing.resolve(); await releaseDispose.promise; } } : {});
      } }, download: async (media, root, scope, options) => {
        downloading.resolve(); await waitGate(releaseDownload, options.signal);
        return fixtureDownload(media, root, scope, options);
      } });
      t.after(() => { releaseDownload.resolve(); releaseDispose.resolve(); });
      const first = (await session.manager.start("first")).job;
      await downloading.promise;
      const later = (await session.manager.start("later")).job;
      await waitFor(() => session.manager.get(later.id).accountProgress.some(progress => progress.waiting.length));
      assert.deepEqual(lookups, ["first"]);
      releaseDownload.resolve();
      if (withDispose) {
        await disposing.promise; await tick();
        assert.deepEqual(lookups, ["first"], "The profile must remain locked until dispose actually finishes");
        assert.equal(session.manager.get(first.id).status, "running");
        releaseDispose.resolve();
      }
      await waitFor(() => lookups.includes("later"));
      assert.equal((await settle(session.manager, first.id)).status, "completed");
      assert.equal((await settle(session.manager, later.id)).status, "completed");
      assert.equal(session.manager.activeResourceKeys.size, 0);
    });
  }
});

test("same-person independent downloads overlap while exact-byte commits retain all sources and finalize once after every pipeline settles", async (t) => {
  const releaseDownloads = deferred(), entered = [], finished = [];
  let namingCalls = 0, dedupCalls = 0, index;
  const session = await setup(t, [{ id: "person", accounts: [
    { platform: "x", handle: "alpha", id: "account-a" },
    { platform: "instagram", handle: "bravo", id: "account-b" },
  ] }], {
    discoverers: { x: async () => discovery([item("x", "POST_A")]), instagram: async () => discovery([item("instagram", "POST_B")]) },
    openMediaIndex: async (...args) => {
      index = await openPersonMediaIndex(...args);
      const finalize = index.finalizeNaming.bind(index);
      index.finalizeNaming = async (options) => {
        namingCalls += 1; assert.equal(finished.length, 2, "Naming cannot race another account's download or source commit");
        return finalize(options);
      };
      return index;
    },
    download: async (media, root, scope, options) => {
      entered.push(media.postId); await waitGate(releaseDownloads, options.signal);
      const result = await fixtureDownload(media, root, scope, options, "identical-offline-media-bytes");
      finished.push(media.postId); return result;
    },
    deduplicate: async (_person, _index, options) => {
      dedupCalls += 1; assert.equal(finished.length, 2, "Local deduplication must wait for all account pipelines");
      assert.equal(options.mediaIds.length, 1, "An exact duplicate must not create another physical receipt file");
      return { scanned: 1, total: 1, merged: 0, review: 0, archivedBytes: 0, errors: [] };
    },
  });
  t.after(() => releaseDownloads.resolve());
  const job = (await session.manager.start("person")).job;
  await waitFor(() => entered.length === 2, "Both independent account downloads must be active at the same time");
  assert.equal(namingCalls, 0); assert.equal(dedupCalls, 0);
  releaseDownloads.resolve();
  const result = await settle(session.manager, job.id);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.accounts, 2);
  assert.equal(result.counters.accountsFinished, 2);
  assert.equal(result.counters.downloaded, 1);
  assert.equal(result.counters.contentDuplicates, 1);
  assert.equal(result.newFileCount, 1);
  assert.equal(result.counters.failed, 0);
  assert.equal(namingCalls, 1); assert.equal(dedupCalls, 1);
  const assets = index.list({ limit: 10 });
  assert.equal(assets.total, 1);
  const sources = index.sources(assets.items[0].mediaId);
  assert.deepEqual(new Set(sources.map(source => `${source.platformId}:${source.accountId}`)), new Set(["x:account-a", "instagram:account-b"]));
  assert.equal((await readdir(path.join(session.person.folderPath, "Image"))).length, 1);
  assert.equal(await readFile(await index.resolve(assets.items[0].mediaId), "utf8"), "identical-offline-media-bytes");
});

test("parallel account progress is summed, final discovered counts are not overwritten, and another account's error does not mark a healthy account failed", async (t) => {
  const xProgress = deferred(), igProgress = deferred(), releaseX = deferred(), releaseInstagram = deferred();
  const cleanup = [];
  const session = await setup(t, [{ id: "person", accounts: [{ platform: "x", id: "account-a" }, { platform: "instagram", id: "account-b" }] }], {
    discoverers: {
      x: async ({ onProgress, signal }) => { onProgress({ media: 2 }); xProgress.resolve(); await waitGate(releaseX, signal); throw new Error("Offline X failure"); },
      instagram: async ({ onProgress, signal }) => { onProgress({ media: 3 }); igProgress.resolve(); await waitGate(releaseInstagram, signal); return discovery([item("instagram", "FIRST")]); },
    }, download: fixtureDownload,
    cleanupAccountCache: async ({ platformId }) => { cleanup.push(platformId); return { status: "empty" }; },
  });
  t.after(() => { releaseX.resolve(); releaseInstagram.resolve(); });
  const job = (await session.manager.start("person")).job;
  await Promise.all([xProgress.promise, igProgress.promise]);
  assert.equal(session.manager.get(job.id).counters.discovered, 5);
  assert.deepEqual(session.manager.get(job.id).accountProgress.map(progress => progress.discovered).sort(), [2, 3]);
  releaseX.resolve();
  await waitFor(() => session.manager.get(job.id).errors.length === 1);
  releaseInstagram.resolve();
  const result = await settle(session.manager, job.id);
  assert.equal(result.counters.discovered, 3, "A failed account keeps its two observed candidates; Instagram replaces only its own provisional count with one result");
  assert.equal(result.counters.downloaded, 1);
  assert.equal(result.counters.failed, 1);
  assert.equal(result.counters.accountsFinished, 2);
  assert.equal(result.accountProgress.find(progress => progress.platformId === "instagram").status, "synced");
  assert.equal(result.accountResults.find(progress => progress.platformId === "instagram").operationStatus, "synced");
  assert.deepEqual(cleanup, ["instagram"]);
  assert.equal(result.cacheCleanup.find(report => report.platformId === "x").reason, "sync-not-successful");
});

test("simultaneous account download byte progress is aggregated and finishing one account leaves the other's progress intact", async (t) => {
  const started = [], releaseX = deferred(), releaseInstagram = deferred();
  const session = await setup(t, [{ id: "person", accounts: [{ platform: "x", id: "account-a" }, { platform: "instagram", id: "account-b" }] }], {
    beforeShutdown: () => { releaseX.resolve(); releaseInstagram.resolve(); },
    discoverers: { x: async () => discovery([item("x", "XPOST")]), instagram: async () => discovery([item("instagram", "IGPOST")]) },
    download: async (media, root, scope, options) => {
      options.onProgress(media.platformId === "x" ? 10 : 20);
      started.push(media.platformId);
      await waitGate(media.platformId === "x" ? releaseX : releaseInstagram, options.signal);
      return fixtureDownload(media, root, scope, options, media.platformId === "x" ? "a".repeat(128) : "b".repeat(256));
    },
  });
  const job = (await session.manager.start("person")).job;
  await waitFor(() => started.length === 2);
  assert.equal(session.manager.get(job.id).currentBytes, 30);
  assert.deepEqual(session.manager.get(job.id).accountProgress.map(progress => progress.currentBytes).sort((a, b) => a - b), [10, 20]);
  releaseX.resolve();
  await waitFor(() => session.manager.get(job.id).accountProgress.find(progress => progress.platformId === "x").status === "synced");
  assert.equal(session.manager.get(job.id).currentBytes, 20);
  assert.equal(session.manager.get(job.id).accountProgress.find(progress => progress.platformId === "instagram").currentBytes, 20);
  releaseInstagram.resolve();
  const result = await settle(session.manager, job.id);
  assert.equal(result.currentBytes, 0);
  assert.equal(result.counters.bytes, 384);
  assert.equal(result.counters.downloaded, 2);
  assert.equal(result.counters.accountsFinished, 2);
});

test("an account setup rejection does not abandon a sibling pipeline or finish the parent before the sibling's commit", async (t) => {
  const instagramStarted = deferred(), releaseInstagram = deferred();
  const session = await setup(t, [{ id: "person", accounts: [{ platform: "x", id: "broken" }, { platform: "instagram", id: "healthy" }] }], {
    beforeShutdown: () => releaseInstagram.resolve(),
    discoverers: { x: async () => { throw new Error("The broken scope must fail before discovery"); },
      instagram: async ({ signal }) => { instagramStarted.resolve(); await waitGate(releaseInstagram, signal); return discovery([item("instagram", "SAVED")]); } },
    download: fixtureDownload,
  });
  await session.manager.store.ready;
  const getScope = session.manager.store.scope.bind(session.manager.store);
  session.manager.store.scope = async (key) => {
    if (key === syncScopeKey("person", "x", "broken")) throw new Error("Offline scope setup denied");
    return getScope(key);
  };
  const job = (await session.manager.start("person")).job;
  await instagramStarted.promise;
  await tick();
  assert.equal(session.manager.get(job.id).status, "running", "The parent must await allSettled, not reject on the first account error");
  releaseInstagram.resolve();
  const result = await settle(session.manager, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.counters.downloaded, 1);
  assert.equal(result.counters.accountsFinished, 2);
  assert.equal(result.accountProgress.find(progress => progress.accountId === "broken").status, "failed");
  assert.equal(result.accountProgress.find(progress => progress.accountId === "healthy").status, "synced");
  const healthy = await getScope(syncScopeKey("person", "instagram", "healthy"));
  assert.ok(healthy.media["SAVED:1"].mediaId);
  assert.equal(session.manager.activeResourceKeys.size, 0);
});

test("editing account switches and bindings cannot change the configuration or lease identity of an already prepared run", async (t) => {
  const entered = deferred(), release = deferred(), observed = [];
  const session = await setup(t, [{ id: "person", accounts: [
    { platform: "x", id: "a", handle: "first", binding: "shared" },
    { platform: "x", id: "b", handle: "second", binding: "shared" },
  ] }], { beforeShutdown: () => release.resolve(), discoverers: { x: async ({ handle, linkedAccount, signal }) => {
    observed.push({ handle, profile: linkedAccount.profileDirectory });
    if (handle === "first") { entered.resolve(); await waitGate(release, signal); }
    return discovery();
  } } });
  const originalProfile = session.state.linkedAccounts[0].profileDirectory;
  const job = (await session.manager.start("person")).job;
  await entered.promise;
  for (const account of session.person.platforms[0].accounts) {
    account.syncEnabled = false;
    account.label = "@edited";
  }
  session.state.linkedAccounts[0].profileDirectory = path.join(session.root, "profiles", "edited");
  release.resolve();
  const completed = await settle(session.manager, job.id);
  assert.deepEqual(observed, [{ handle: "first", profile: originalProfile }, { handle: "second", profile: originalProfile }]);
  assert.equal(completed.counters.accountsFinished, 2);
  const next = await settle(session.manager, (await session.manager.start("person")).job.id);
  assert.equal(next.counters.pausedAccounts, 2);
  assert.equal(next.counters.accounts, 0);
  assert.equal(observed.length, 2);
});

test("all-paused targets do not open the media index or read scopes and preserve every account's checkpoints", async (t) => {
  let opened = 0, discovered = 0, downloaded = 0;
  const session = await setup(t, [{ id: "person", accounts: [
    { platform: "x", id: "account-a", syncEnabled: false }, { platform: "instagram", id: "account-b", syncEnabled: false },
  ] }], { openMediaIndex: async () => { opened += 1; throw new Error("Paused accounts must not open storage"); },
    discoverers: { x: async () => { discovered += 1; throw new Error("Paused X discovered"); },
      instagram: async () => { discovered += 1; throw new Error("Paused Instagram discovered"); } },
    download: async () => { downloaded += 1; throw new Error("Paused download"); } });
  await session.manager.store.ready;
  const key = syncScopeKey("person", "x", "account-a");
  const scope = await session.manager.store.scope(key);
  Object.assign(scope, { knownPosts: { older: "2026-01-01T00:00:00.000Z" }, initialComplete: true, completionVersion: 1,
    scanCompletedAt: "2026-09-01T00:00:00.000Z", incrementalCheckpoint: { version: 1, scanStartedAt: "2026-09-20T00:00:00.000Z", completionReason: "known-boundary" } });
  await session.manager.store.save();
  const before = structuredClone(session.manager.store.index.scopes);
  session.manager.store.scope = async () => { throw new Error("Paused accounts must not read or create account scopes"); };
  session.manager.store.ensureCompletionVerification = async () => { throw new Error("Paused accounts must not reset verification markers"); };
  const started = (await session.manager.start("person")).job;
  const result = await settle(session.manager, started.id);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.accounts, 0);
  assert.equal(result.counters.pausedAccounts, 2);
  assert.equal(result.counters.accountsFinished, 0);
  assert.deepEqual(result.accountProgress, []);
  assert.deepEqual(session.manager.store.index.scopes, before);
  assert.deepEqual([opened, discovered, downloaded], [0, 0, 0]);
  assert.equal(session.manager.activeResourceKeys.size, 0);
});

test("pausing and re-enabling an account keeps its increment boundary, existing media skip keys and login binding", async (t) => {
  const snapshots = [], downloads = [];
  let opened = 0;
  const session = await setup(t, [{ id: "person", accounts: [{ platform: "x", handle: "target", id: "account-a" }] }], {
    openMediaIndex: async (...args) => { opened += 1; return openPersonMediaIndex(...args); },
    discoverers: { x: async (options) => { snapshots.push(options); return discovery([item("x", "KNOWN")]); } },
    download: async (media, ...args) => { downloads.push(media.logicalKey); return fixtureDownload(media, ...args); },
  });
  const first = (await session.manager.start("person")).job;
  assert.equal((await settle(session.manager, first.id)).counters.downloaded, 1);
  const key = syncScopeKey("person", "x", "account-a"), before = structuredClone(await session.manager.store.scope(key));
  const account = session.person.platforms[0].accounts[0], originalBinding = account.linkedAccountId;
  account.syncEnabled = false;
  const paused = (await session.manager.start("person")).job;
  assert.equal((await settle(session.manager, paused.id)).counters.pausedAccounts, 1);
  assert.deepEqual(await session.manager.store.scope(key), before);
  assert.equal(opened, 1); assert.equal(snapshots.length, 1);
  account.syncEnabled = true;
  const resumed = (await session.manager.start("person")).job;
  const result = await settle(session.manager, resumed.id);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].scanMode, "incremental");
  assert.equal(snapshots[1].since, before.incrementalCheckpoint.scanStartedAt);
  assert.equal(snapshots[1].initialComplete, true);
  assert.ok(snapshots[1].knownMediaKeys.includes("KNOWN:1"));
  assert.equal(snapshots[1].linkedAccount.id, originalBinding);
  assert.equal(account.linkedAccountId, originalBinding);
  assert.deepEqual(downloads, ["KNOWN:1"]);
  assert.equal(result.counters.downloaded, 0);
  assert.equal(result.counters.logicalDuplicates, 1);
  assert.equal(result.counters.accountsFinished, 1);
  assert.equal(result.counters.pausedAccounts, 0);
});
