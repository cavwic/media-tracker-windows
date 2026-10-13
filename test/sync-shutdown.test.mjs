import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { SyncStore, syncScopeKey } from "../lib/sync-store.mjs";
import { openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function cancelled(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Fixture cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function media(postId) {
  return { platformId: "x", postId, postKey: postId, logicalKey: `${postId}:1`, mediaIndex: 1,
    kind: "image", extension: ".jpg", sourceUrl: `https://fixture.invalid/${postId}.jpg`,
    postUrl: `https://x.com/fixture/status/${postId}`, createdAt: "2026-09-01T10:00:00Z" };
}

function discovery(items, dispose) {
  return { media: items, posts: items.map(({ postKey, postId, createdAt }) => ({ postKey, postId, createdAt })),
    complete: true, dispose };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persons = ["active", "queued", "parallel"].map((id) => ({ id, name: id, folderPath: path.join(root, id),
    platforms: [{ id: "x", label: "X", accounts: [{ id: `target-${id}`, label: `@${id}`, linkedAccountId: id === "parallel" ? "other-login" : "shared-login" }] }] }));
  for (const person of persons) await mkdir(person.folderPath);
  const state = { persons, linkedAccounts: ["shared-login", "other-login"].map((id) => ({ id, platformId: "x",
    loginStatus: "verified", profileDirectory: path.join(root, "profiles", id) })) };
  return { root, state, indexFile: path.join(root, "sync-index.json"), loadState: async () => state };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitForQueuedAccount(manager, jobId) {
  for (let i = 0; i < 100; i++) {
    if (manager.get(jobId).accountProgress.some(account => account.status === "queued" && account.waiting.length)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture account did not enter the shared-session queue");
}

test("shutdown cancels every active job, persists queued cancellation without starting it, and retains committed media plus retries", { timeout: 10_000 }, async (t) => {
  const setup = await fixture(t);
  const activeDownload = deferred();
  const parallelDownload = deferred();
  const disposing = deferred();
  const releaseDispose = deferred();
  const discoveries = [];
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async ({ handle }) => {
      discoveries.push(handle);
      return discovery(handle === "active" ? [media("saved"), media("pending"), media("not-started")] : [media("parallel-pending")],
        handle === "active" ? async () => { disposing.resolve(); await releaseDispose.promise; } : undefined);
    } },
    download: async (item, root, scope, options) => {
      if (item.postId === "saved") return fixtureDownload(item, root, scope, options);
      (item.postId === "pending" ? activeDownload : parallelDownload).resolve();
      return cancelled(options.signal);
    },
  });
  const first = (await manager.start("active")).job;
  await activeDownload.promise;
  const queued = (await manager.start("queued")).job;
  await waitForQueuedAccount(manager, queued.id);
  assert.equal(manager.get(queued.id).status, "running");
  assert.equal(manager.get(queued.id).accountProgress[0].status, "queued");
  const parallel = (await manager.start("parallel")).job;
  await parallelDownload.promise;
  const exiting = manager.shutdown();
  assert.equal(manager.shutdown(), exiting, "repeated close requests must reuse the same shutdown");
  let finished = false;
  exiting.then(() => { finished = true; });
  await disposing.promise;
  await tick();
  assert.equal(finished, false, "shutdown must wait for runtime disposal and final receipts");
  assert.equal(manager.get(queued.id).status, "cancelled");
  assert.equal(manager.pendingJobIds.length, 0);
  await assert.rejects(manager.start("queued"), { code: "service-shutting-down" });
  releaseDispose.resolve();
  await exiting;
  assert.deepEqual(discoveries.sort(), ["active", "parallel"]);
  assert.equal(manager.get(first.id).status, "cancelled");
  assert.equal(manager.get(parallel.id).status, "cancelled");
  assert.equal(manager.activeJobIds.size, 0);
  assert.equal(manager.activeRunPromises.size, 0);
  assert.equal(manager.activeResourceKeys.size, 0);
  const persisted = new SyncStore(setup.indexFile);
  const scope = await persisted.scope(syncScopeKey("active", "x", "target-active"));
  assert.deepEqual(Object.keys(scope.media), ["saved:1"]);
  assert.deepEqual(Object.keys(scope.pendingMedia).sort(), ["not-started:1", "pending:1"]);
  assert.equal((await persisted.summary("queued")).status, "cancelled");
  assert.equal((await persisted.receipt("queued")).jobId, queued.id);
  const receipt = await persisted.receipt("active");
  assert.equal(receipt.files.length, 1);
  const index = await openPersonMediaIndex(setup.state.persons[0], { requireExisting: true });
  assert.equal(await readFile(await index.resolve(receipt.files[0].mediaId), "utf8"), "saved");
});

test("shutdown does not accept a start whose state read finishes after closing", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const stateRead = deferred();
  const manager = new SyncManager({ ...setup, loadState: () => stateRead.promise });
  const starting = manager.start("active");
  const rejected = assert.rejects(starting, { code: "service-shutting-down" });
  await manager.shutdown();
  stateRead.resolve(setup.state);
  await rejected;
  assert.equal(manager.jobs.size, 0);
  manager.drain();
  assert.equal(manager.activeJobIds.size, 0);
});

test("shutdown waits for in-progress naming and retains the committed asset on cancellation", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const naming = deferred();
  const releaseNaming = deferred();
  let namingSignal;
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovery([media("saved")]) }, download: fixtureDownload,
    openMediaIndex: async (...args) => {
      const index = await openPersonMediaIndex(...args);
      const finalize = index.finalizeNaming.bind(index);
      index.finalizeNaming = async (options) => {
        namingSignal = options.signal;
        naming.resolve();
        await releaseNaming.promise;
        return finalize(options);
      };
      return index;
    },
  });
  const job = (await manager.start("active")).job;
  await naming.promise;
  let finished = false;
  const exiting = manager.shutdown().then(() => { finished = true; });
  assert.equal(namingSignal.aborted, true);
  await tick();
  assert.equal(finished, false);
  releaseNaming.resolve();
  await exiting;
  assert.equal(manager.get(job.id).status, "cancelled");
  const persisted = new SyncStore(setup.indexFile);
  const receipt = await persisted.receipt("active");
  assert.equal(receipt.files.length, 1);
  const index = await openPersonMediaIndex(setup.state.persons[0], { requireExisting: true });
  assert.equal(await readFile(await index.resolve(receipt.files[0].mediaId), "utf8"), "saved");
});

test("shutdown waits for completed-job automatic cleanup before the final summary write", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const cleaning = deferred();
  const releaseCleanup = deferred();
  const manager = new SyncManager({ ...setup, download: fixtureDownload,
    discoverers: { x: async () => discovery([media("saved")]) },
    cleanupAccountCache: async () => { cleaning.resolve(); await releaseCleanup.promise; return { status: "empty" }; },
  });
  const job = (await manager.start("active")).job;
  await cleaning.promise;
  assert.equal(manager.get(job.id).status, "completed");
  let finished = false;
  const exiting = manager.shutdown().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  releaseCleanup.resolve();
  await exiting;
  const persisted = new SyncStore(setup.indexFile);
  assert.equal((await persisted.summary("active")).cacheCleanup[0].status, "empty");
});

test("shutdown flushes an independently pending sync-store write and reports failures", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const manager = new SyncManager(setup);
  await manager.store.ready;
  const writing = deferred();
  manager.store.writeQueue = writing.promise;
  let finished = false;
  const exiting = manager.shutdown().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  writing.resolve();
  await exiting;

  const failedManager = new SyncManager(setup);
  await failedManager.store.ready;
  failedManager.store.writeQueue = Promise.reject(new Error("NAS unavailable"));
  await assert.rejects(failedManager.shutdown(), (error) => {
    assert.equal(error.code, "shutdown-persistence-failed");
    assert.match(error.errors[0].message, /NAS unavailable/);
    return true;
  });
});

test("queued cancellation persistence failures cannot become a successful shutdown", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const manager = new SyncManager(setup);
  manager.drain = () => {};
  await manager.start("active");
  manager.store.saveSummary = async () => { throw new Error("Receipt write denied"); };
  await assert.rejects(manager.shutdown(), (error) => {
    assert.equal(error.code, "shutdown-persistence-failed");
    assert.match(error.errors[0].message, /Receipt write denied/);
    return true;
  });
});

test("an active job's final receipt failure is reported even if a later queued write succeeds", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const downloading = deferred();
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovery([media("pending")]) },
    download: async (item, root, scope, { signal }) => { downloading.resolve(); return cancelled(signal); },
  });
  await manager.start("active");
  await downloading.promise;
  await manager.start("queued");
  const saveSummary = manager.store.saveSummary.bind(manager.store);
  manager.store.saveSummary = async (personId, ...args) => {
    if (personId === "active") throw new Error("Active receipt write denied");
    return saveSummary(personId, ...args);
  };
  t.mock.method(console, "error", () => {});
  await assert.rejects(manager.shutdown(), (error) => {
    assert.equal(error.code, "shutdown-persistence-failed");
    assert.ok(error.errors.some((cause) => /Active receipt write denied/.test(cause.message)));
    return true;
  });
  assert.equal(manager.activeJobIds.size, 0);
  assert.equal((await new SyncStore(setup.indexFile).summary("queued")).status, "cancelled");
});

test("shutdown deadline reports a hang without abandoning cancellation or deleting indexed media", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const downloading = deferred();
  const disposing = deferred();
  const releaseDispose = deferred();
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovery([media("saved"), media("pending")], async () => {
      disposing.resolve(); await releaseDispose.promise;
    }) },
    download: async (item, root, scope, options) => {
      if (item.postId === "saved") return fixtureDownload(item, root, scope, options);
      downloading.resolve();
      return cancelled(options.signal);
    },
  });
  const job = (await manager.start("active")).job;
  await downloading.promise;
  const exiting = manager.shutdown({ timeoutMs: 25 });
  await disposing.promise;
  await assert.rejects(exiting, { code: "sync-shutdown-timeout" });
  assert.equal(manager.activeJobIds.has(job.id), true, "the deadline cannot release locks prematurely");
  assert.equal(manager.jobs.get(job.id).controller.signal.aborted, true);
  await assert.rejects(manager.start("parallel"), { code: "service-shutting-down" });
  releaseDispose.resolve();
  await manager.shutdownCompletion;
  assert.equal(manager.activeJobIds.size, 0);
  const persisted = new SyncStore(setup.indexFile);
  const receipt = await persisted.receipt("active");
  const scope = await persisted.scope(syncScopeKey("active", "x", "target-active"));
  assert.equal(receipt.files.length, 1);
  assert.deepEqual(Object.keys(scope.pendingMedia), ["pending:1"]);
  const index = await openPersonMediaIndex(setup.state.persons[0], { requireExisting: true });
  assert.equal(await readFile(await index.resolve(receipt.files[0].mediaId), "utf8"), "saved");
});
