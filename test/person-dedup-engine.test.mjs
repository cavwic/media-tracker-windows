import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { SyncStore, syncScopeKey } from "../lib/sync-store.mjs";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

function item(postId, payload, { kind = "image", extension = ".jpg" } = {}) {
  return { postId, postKey: postId, logicalKey: `${postId}:1`, mediaIndex: 1, kind, extension, payload,
    createdAt: "2026-10-01T10:00:00.000Z", sourceUrl: `https://unused.example/${postId}${extension}`,
    postUrl: `https://unused.example/post/${postId}` };
}

function discovered(media) {
  return { media, complete: true, posts: media.map(({ postId, createdAt }) => ({ postId, postKey: postId, createdAt })) };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-person-dedup-"));
  t.after(async () => { clearPersonMediaIndexCache(); await rm(root, { recursive: true, force: true }); });
  const person = { id: "person-a", name: "A", folderPath: path.join(root, "A"), platforms: [
    { id: "x", label: "X", accounts: [{ id: "a", label: "@account_a" }, { id: "b", label: "@account_b" }] },
    { id: "instagram", label: "Instagram", accounts: [{ id: "c", label: "account_c" }] },
  ] };
  const other = { id: "person-b", name: "B", folderPath: path.join(root, "B"),
    platforms: [{ id: "x", label: "X", accounts: [{ id: "a", label: "@account_d" }] }] };
  const state = { persons: [person, other], linkedAccounts: [] };
  return { root, person, other, state, indexFile: path.join(root, "sync-index.json"), loadState: async () => state };
}

async function run(manager, personId) {
  const { job } = await manager.start(personId);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = manager.get(job.id);
    if (!manager.activeJobIds.has(job.id) && !["queued", "running"].includes(result.status)) {
      await manager.store.writeQueue;
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  manager.cancel(job.id);
  throw new Error("Person-level fixture did not finish");
}

test("person-level local hashes merge cross-platform/account/repost sources, preserve distinct bytes and separate people", async (t) => {
  const setup = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Exact dedup must not call external network APIs"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  let downloads = 0;
  const posts = {
    account_a: [item("one", "shared-image"), item("repost", "shared-image"), item("changed", "different-image-bytes"),
      item("animated", "animated-mp4-bytes", { kind: "gif", extension: ".mp4" }),
      item("true-gif", "GIF89a-fixture", { kind: "gif", extension: ".gif" })],
    account_b: [item("one", "shared-image")], account_c: [item("another-site", "shared-image")],
    account_d: [item("one", "shared-image")],
  };
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async ({ handle }) => discovered(posts[handle]), instagram: async ({ handle }) => discovered(posts[handle]) },
    download: async (media, ...args) => { downloads += 1; return fixtureDownload(media, ...args, media.payload); },
  });
  const first = await run(manager, setup.person.id);
  assert.equal(first.counters.failed, 0);
  assert.equal(first.counters.downloaded, 4);
  assert.equal(first.counters.contentDuplicates, 3);
  assert.equal(first.newFileCount, 4);
  assert.deepEqual((await readdir(setup.person.folderPath)).sort(), ["Image", "Index", "Video"]);
  const index = await openPersonMediaIndex(setup.person);
  const scope = await manager.store.scope(syncScopeKey(setup.person.id, "x", "a"));
  const shared = scope.media["one:1"];
  assert.match(path.basename(index.get(shared.mediaId).relativePath), /^20261001_A_\d{2,}_[a-f0-9]{16,64}\.jpg$/);
  assert.equal(index.sources(shared.mediaId).length, 4);
  assert.deepEqual(new Set(index.sources(shared.mediaId).map(({ platformId, accountId }) => `${platformId}:${accountId}`)), new Set(["x:a", "x:b", "instagram:c"]));
  assert.equal((await readdir(path.join(setup.person.folderPath, "Image"))).length, 3);
  assert.equal((await readdir(path.join(setup.person.folderPath, "Video"))).length, 1);
  assert.match(index.get(scope.media["animated:1"].mediaId).relativePath, /^Video[\\/]/);
  assert.match(index.get(scope.media["true-gif:1"].mediaId).relativePath, /^Image[\\/].+\.gif$/);
  const firstSeen = index.sources(shared.mediaId).map(({ firstSeenAt }) => firstSeenAt);
  const next = await run(manager, setup.person.id);
  assert.equal(next.counters.failed, 0);
  assert.equal(next.counters.logicalDuplicates, 7);
  assert.equal(next.counters.downloaded, 0);
  assert.equal(downloads, 7);
  assert.deepEqual(index.sources(shared.mediaId).map(({ firstSeenAt }) => firstSeenAt), firstSeen);
  assert.equal((await run(manager, setup.other.id)).counters.downloaded, 1);
  const otherIndex = await openPersonMediaIndex(setup.other);
  assert.equal(otherIndex.sources(shared.mediaId).length, 1);
  assert.equal(await readFile(await otherIndex.resolve(shared.mediaId), "utf8"), "shared-image");
});

test("missing initialized Index is a safe failure and does not reset account checkpoints or reach discovery", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  let calls = 0;
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => { calls += 1; return discovered([item("one", "payload")]); } },
    download: (media, ...args) => fixtureDownload(media, ...args, media.payload),
  });
  assert.equal((await run(manager, setup.person.id)).counters.failed, 0);
  const scopeKey = syncScopeKey(setup.person.id, "x", "a");
  const before = structuredClone(await manager.store.scope(scopeKey));
  await rm(path.join(setup.person.folderPath, "Index"), { recursive: true });
  clearPersonMediaIndexCache();
  const restarted = new SyncManager({ ...setup, discoverers: { x: async () => { calls += 1; return discovered([]); } } });
  const failed = await run(restarted, setup.person.id);
  assert.equal(failed.status, "failed");
  assert.equal(calls, 1);
  assert.deepEqual(await restarted.store.scope(scopeKey), before);
});

test("index commit failure retains pending media; a retry uses the durable asset without a second physical file", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  let fail = true;
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovered([item("one", "payload")]) },
    download: async (media, ...args) => {
      const result = await fixtureDownload(media, ...args, media.payload);
      if (fail) throw new Error("fixture failure after durable asset commit");
      return result;
    },
  });
  const failed = await run(manager, setup.person.id);
  assert.equal(failed.counters.failed, 1);
  const scopeKey = syncScopeKey(setup.person.id, "x", "a");
  const persisted = await new SyncStore(setup.indexFile).scope(scopeKey);
  assert.equal(Object.keys(persisted.media).length, 0);
  assert.equal(Object.keys(persisted.pendingMedia).length, 1);
  fail = false;
  const recovered = await run(manager, setup.person.id);
  assert.equal(recovered.counters.failed, 0);
  assert.equal(recovered.counters.contentDuplicates, 1);
  assert.equal((await readdir(path.join(setup.person.folderPath, "Image"))).length, 1);
  assert.deepEqual((await manager.store.scope(scopeKey)).pendingMedia, {});
});

test("snapshot failure prevents a successful account checkpoint while keeping durable media for retry", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovered([item("one", "payload")]) },
    download: (media, ...args) => fixtureDownload(media, ...args, media.payload),
    openMediaIndex: async (...args) => {
      const index = await openPersonMediaIndex(...args);
      return new Proxy(index, { get(target, key) {
        if (key === "compact") return async () => { throw new Error("fixture snapshot write failed"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  });
  const failed = await run(manager, setup.person.id);
  assert.equal(failed.counters.failed, 1);
  const scope = await manager.store.scope(syncScopeKey(setup.person.id, "x", "a"));
  assert.equal(scope.lastSuccessfulSyncAt, null);
  assert.equal(await (await openPersonMediaIndex(setup.person)).has(scope.media["one:1"].mediaId), true);
});

test("an empty incremental discovery does not stat every historical asset on a NAS", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  let scans = 0;
  let assetChecks = 0;
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async ({ knownMediaKeys }) => {
      scans += 1;
      if (scans > 1) { assert.equal(knownMediaKeys.length, 3); return discovered([]); }
      return discovered([item("one", "a"), item("two", "b"), item("three", "c")]);
    } },
    download: (media, ...args) => fixtureDownload(media, ...args, media.payload),
    openMediaIndex: async (...args) => {
      const index = await openPersonMediaIndex(...args);
      return new Proxy(index, { get(target, key) {
        if (key === "has") return async (...params) => { assetChecks += 1; return target.has(...params); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  });
  assert.equal((await run(manager, setup.person.id)).counters.downloaded, 3);
  assetChecks = 0;
  assert.equal((await run(manager, setup.person.id)).counters.failed, 0);
  assert.equal(assetChecks, 0);
});

test("a logical duplicate source write failure stays pending without aborting the remaining media", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  let failFirstSource = false;
  const posts = [item("one", "a"), item("two", "b")];
  const manager = new SyncManager({ ...setup,
    discoverers: { x: async () => discovered(posts) },
    download: (media, ...args) => fixtureDownload(media, ...args, media.payload),
    openMediaIndex: async (...args) => {
      const index = await openPersonMediaIndex(...args);
      return new Proxy(index, { get(target, key) {
        if (key === "addSource") return async (mediaId, source) => {
          if (failFirstSource && source.logicalKey === "one:1") throw new Error("fixture source write failed");
          return target.addSource(mediaId, source);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  });
  assert.equal((await run(manager, setup.person.id)).counters.downloaded, 2);
  failFirstSource = true;
  const failed = await run(manager, setup.person.id);
  assert.equal(failed.counters.failed, 1);
  assert.equal(failed.counters.logicalDuplicates, 1);
  const scope = await manager.store.scope(syncScopeKey(setup.person.id, "x", "a"));
  assert.deepEqual(Object.keys(scope.pendingMedia), ["one:1"]);
  failFirstSource = false;
  const retried = await run(manager, setup.person.id);
  assert.equal(retried.counters.failed, 0);
  assert.equal(retried.counters.downloaded, 0);
  assert.deepEqual(scope.pendingMedia, {});
});

test("a restarted initialized sync recovers a final file whose journal commit was interrupted", async (t) => {
  const setup = await fixture(t);
  setup.person.platforms = setup.person.platforms.slice(0, 1);
  setup.person.platforms[0].accounts = setup.person.platforms[0].accounts.slice(0, 1);
  const emptyDiscovery = { x: async () => discovered([]) };
  const first = new SyncManager({ ...setup, discoverers: emptyDiscovery });
  assert.equal((await run(first, setup.person.id)).counters.failed, 0);
  const pending = item("orphan", "completed-fixture-image");
  const mediaId = createHash("sha256").update(pending.payload).digest("hex");
  const folder = path.join(setup.person.folderPath, "Image");
  await mkdir(folder);
  await writeFile(path.join(folder, `${mediaId}.jpg`), pending.payload);
  await first.store.markPending(syncScopeKey(setup.person.id, "x", "a"), pending);
  clearPersonMediaIndexCache();
  const restarted = new SyncManager({ ...setup, discoverers: emptyDiscovery,
    download: (media, ...args) => fixtureDownload(media, ...args, media.payload),
  });
  const result = await run(restarted, setup.person.id);
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 0);
  assert.equal(result.counters.contentDuplicates, 1);
  assert.equal((await readdir(folder)).length, 1);
  const index = await openPersonMediaIndex(setup.person);
  assert.equal(index.get(mediaId).recovered, true);
  assert.equal(index.sources(mediaId).length, 1);
  const scope = await restarted.store.scope(syncScopeKey(setup.person.id, "x", "a"));
  assert.deepEqual(scope.pendingMedia, {});
  assert.equal(scope.media[pending.logicalKey].mediaId, mediaId);
});
