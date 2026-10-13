import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { syncScopeKey } from "../lib/sync-store.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

const PERSON_ID = "resource-fixture-person";
const ACCOUNT_ID = "resource-fixture-account";
const SCOPE_KEY = syncScopeKey(PERSON_ID, "tiktok", ACCOUNT_ID);

function media(id = "1234567890") {
  return {
    platformId: "tiktok", postId: id, postKey: `tiktok:${id}`, logicalKey: `tiktok:${id}:image:1`,
    kind: "image", mediaIndex: 1, extension: ".jpg", createdAt: "2026-09-01T00:00:00.000Z",
    sourceUrl: `https://media.example.test/${id}.jpg`, postUrl: `https://www.tiktok.com/@fixture_creator/photo/${id}`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-resource-cleanup-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("media-tracker-resource-cleanup-"));
    await rm(root, { recursive: true, force: true });
  });
  const person = {
    id: PERSON_ID, name: "Resource fixture", folderPath: path.join(root, "person"),
    platforms: [{ id: "tiktok", label: "TikTok", accounts: [{
      id: ACCOUNT_ID, label: "@fixture_creator", folderName: "fixture_creator",
    }] }],
  };
  await mkdir(path.join(person.folderPath, "TikTok", "fixture_creator"), { recursive: true });
  return {
    root, person, indexFile: path.join(root, "sync-index.json"),
    loadState: async () => ({ persons: [person], linkedAccounts: [] }),
  };
}

function resource(items = [media()], { disposeError = false } = {}) {
  const calls = { dispose: 0, fetch: 0, download: 0 };
  const discovery = {
    posts: items.map(({ postId, postKey, createdAt }) => ({ postId, postKey, createdAt })),
    media: items,
    complete: true,
    async fetchMedia() {
      assert.equal(calls.dispose, 0, "the media transport must remain alive until downloads finish");
      calls.fetch += 1;
      return new Response("fixture-image", { headers: { "content-type": "image/jpeg" } });
    },
    async dispose() {
      calls.dispose += 1;
      if (disposeError) throw new Error("fixture cleanup failed");
    },
  };
  const download = async (item, root, scope, options) => {
    calls.download += 1;
    const response = await options.fetchMedia(item.sourceUrl);
    const content = await response.text();
    return fixtureDownload(item, root, scope, options, content);
  };
  return { calls, discovery, download };
}

async function run(manager) {
  const { job } = await manager.start(PERSON_ID);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = manager.get(job.id);
    if (current && !["queued", "running"].includes(current.status) && !manager.activeJobIds.has(job.id)) {
      await manager.store.writeQueue;
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  manager.cancel(job.id);
  throw new Error("Fixture sync job did not finish");
}

async function assertRuntimeNotPersisted(setup, manager) {
  const serialized = await readFile(setup.indexFile, "utf8");
  assert.doesNotMatch(serialized, /"(?:dispose|fetchMedia)"/);
  const scope = await manager.store.scope(SCOPE_KEY);
  for (const item of [...Object.values(scope.media), ...Object.values(scope.pendingMedia)]) {
    assert.equal(Object.hasOwn(item, "fetchMedia"), false);
    assert.equal(Object.hasOwn(item, "dispose"), false);
  }
}

test("discovery resources stay alive through a successful download and dispose exactly once", async (t) => {
  const setup = await fixture(t);
  const runtime = resource();
  const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => runtime.discovery }, download: runtime.download });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 1);
  assert.deepEqual(runtime.calls, { dispose: 1, fetch: 1, download: 1 });
  await assertRuntimeNotPersisted(setup, manager);
});

test("an aborted download disposes discovery once and keeps unfinished media in the retry queue", async (t) => {
  const setup = await fixture(t);
  const runtime = resource();
  const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => runtime.discovery }, download: async (item, root, scope, options) => {
    runtime.calls.download += 1;
    await options.fetchMedia(item.sourceUrl);
    throw new DOMException("fixture cancelled", "AbortError");
  } });
  const result = await run(manager);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(runtime.calls, { dispose: 1, fetch: 1, download: 1 });
  assert.deepEqual(Object.keys((await manager.store.scope(SCOPE_KEY)).pendingMedia), [media().logicalKey]);
  await assertRuntimeNotPersisted(setup, manager);
});

test("one ordinary download error does not dispose the transport before the account's remaining files", async (t) => {
  const setup = await fixture(t);
  const runtime = resource([media("1111111111"), media("2222222222")]);
  const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => runtime.discovery }, download: async (...args) => {
    if (args[0].postId === "1111111111") {
      runtime.calls.download += 1;
      await args[3].fetchMedia(args[0].sourceUrl);
      throw new Error("fixture media unavailable");
    }
    return runtime.download(...args);
  } });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 1);
  assert.equal(result.counters.downloaded, 1);
  assert.deepEqual(runtime.calls, { dispose: 1, fetch: 2, download: 2 });
  await assertRuntimeNotPersisted(setup, manager);
});

for (const failingMethod of ["recordDiscovery", "markMedia"]) {
  test(`${failingMethod} failure still disposes the returned discovery resource exactly once`, async (t) => {
    const setup = await fixture(t);
    const runtime = resource();
    const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => runtime.discovery }, download: runtime.download });
    manager.store[failingMethod] = async () => { throw new Error(`fixture ${failingMethod} failed`); };
    const result = await run(manager);
    assert.equal(result.counters.failed, 1);
    assert.match(result.errors[0].message, new RegExp(failingMethod));
    assert.equal(runtime.calls.dispose, 1);
    assert.equal(runtime.calls.download, failingMethod === "recordDiscovery" ? 0 : 1);
    await assertRuntimeNotPersisted(setup, manager);
  });
}

test("discovery throwing before it returns does not invoke a runtime callback or start downloads", async (t) => {
  const setup = await fixture(t);
  const runtime = resource();
  const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => {
    throw new Error("fixture discovery failed before acquiring resources");
  } }, download: runtime.download });
  const result = await run(manager);
  assert.equal(result.counters.failed, 1);
  assert.match(result.errors[0].message, /discovery failed/);
  assert.deepEqual(runtime.calls, { dispose: 0, fetch: 0, download: 0 });
  await assertRuntimeNotPersisted(setup, manager);
});

test("dispose failure does not turn successfully saved media into a failed sync", async (t) => {
  const setup = await fixture(t);
  const runtime = resource(undefined, { disposeError: true });
  const manager = new SyncManager({ ...setup, discoverers: { tiktok: async () => runtime.discovery }, download: runtime.download });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 0);
  assert.equal(runtime.calls.dispose, 1);
});

test("a saved logical key is not fetched again on the next sync but its new discovery resource is disposed", async (t) => {
  const setup = await fixture(t);
  const firstRuntime = resource();
  const first = new SyncManager({ ...setup, discoverers: { tiktok: async () => firstRuntime.discovery }, download: firstRuntime.download });
  assert.equal((await run(first)).counters.downloaded, 1);
  assert.equal(firstRuntime.calls.dispose, 1);

  const nextRuntime = resource();
  const next = new SyncManager({ ...setup, discoverers: { tiktok: async () => nextRuntime.discovery }, download: nextRuntime.download });
  const result = await run(next);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.downloaded, 0);
  assert.equal(result.counters.logicalDuplicates, 1);
  assert.deepEqual(nextRuntime.calls, { dispose: 1, fetch: 0, download: 0 });
  await assertRuntimeNotPersisted(setup, next);
});
