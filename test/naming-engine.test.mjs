import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

function media(post, time, attachment, payload, kind = "image", date = "20260101") {
  return { postId: post, postKey: post, logicalKey: `${post}:${attachment}`, mediaIndex: attachment,
    createdAt: time, publicationDate: date, dateBasis: "platform", displayTimeZone: null,
    payload, kind, extension: kind === "video" ? ".mp4" : ".jpg",
    sourceUrl: `https://unused.example/${post}/${attachment}`, postUrl: `https://unused.example/${post}` };
}
async function run(manager, id) {
  const { job } = await manager.start(id);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = manager.get(job.id);
    if (!manager.activeJobIds.has(job.id) && !["running", "queued"].includes(result.status)) {
      await manager.store.writeQueue;
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  manager.cancel(job.id);
  throw new Error("Naming fixture timed out");
}

test("person sync sorts daily image/video numbering and dynamically resolves older receipts after an earlier source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-naming-engine-"));
  const externalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Local naming/dedup must not call an external service"); };
  t.after(() => { globalThis.fetch = externalFetch; });
  t.after(async () => { clearPersonMediaIndexCache(); await rm(root, { recursive: true, force: true }); });
  const person = { id: "person", name: "人物A", folderPath: path.join(root, "A"),
    platforms: [{ id: "x", label: "X", accounts: [{ id: "a", label: "@account" }] }] };
  const records = [media("B", "2026-01-01T12:00:00Z", 2, "B-video", "video"),
    media("A", "2026-01-01T09:00:00Z", 2, "A-image-2"),
    media("B", "2026-01-01T12:00:00Z", 1, "B-image"),
    media("A", "2026-01-01T09:00:00Z", 1, "A-image-1")];
  let current = records;
  let downloaded = 0;
  const options = { indexFile: path.join(root, "sync-index.json"),
    loadState: async () => ({ persons: [person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ complete: true, media: current,
      posts: current.map(({ postId, createdAt }) => ({ postId, postKey: postId, createdAt })) }) },
    download: async (item, ...args) => { downloaded += 1; return fixtureDownload(item, ...args, item.payload); } };
  const manager = new SyncManager(options);
  const completed = await run(manager, person.id);
  assert.equal(completed.counters.failed, 0);
  assert.equal(completed.namingStatus, "complete");
  const names = await readdir(path.join(person.folderPath, "Image"));
  const expected = { "A-image-1": "01", "A-image-2": "02", "B-image": "03" };
  for (const filename of names) {
    const bytes = await readFile(path.join(person.folderPath, "Image", filename), "utf8");
    assert.match(filename, new RegExp(`^20260101_人物A_${expected[bytes]}_[a-f0-9]{16}\\.jpg$`));
  }
  assert.match((await readdir(path.join(person.folderPath, "Video")))[0], /^20260101_人物A_01_[a-f0-9]{16}\.mp4$/);
  const oldReceipt = await manager.receipt(person.id);
  const shared = oldReceipt.files.find((file) => file.filename.includes("_03_"));
  assert.ok(shared);
  const index = await openPersonMediaIndex(person);
  await index.addSource(shared.mediaId, { platformId: "instagram", accountId: "other", logicalKey: "early:1",
    postId: "early", createdAt: "2025-12-31T08:00:00Z", publicationDate: "20251231", dateBasis: "platform", mediaIndex: 1 });
  await index.finalizeNaming();
  const changedReceipt = await manager.receipt(person.id);
  const changed = changedReceipt.files.find((file) => file.id === shared.id);
  assert.equal(changed.mediaId, shared.mediaId);
  assert.match(changed.filename, /^20251231_人物A_01_/);
  assert.equal(await index.withAssetPath(shared.mediaId, (file) => readFile(file, "utf8")), "B-image");
  assert.equal(index.sources(shared.mediaId).length, 2);
  current = records;
  const second = await run(manager, person.id);
  assert.equal(second.counters.downloaded, 0);
  assert.equal(downloaded, 4);
  assert.equal((await readdir(path.join(person.folderPath, "Image"))).length, 3);
  current = [];
  const originalInfo = index.safeFileInfo.bind(index);
  index.safeFileInfo = async () => { throw new Error("Empty incremental sync must not stat unchanged archive files"); };
  try {
    assert.equal((await run(manager, person.id)).counters.failed, 0);
  } finally { index.safeFileInfo = originalInfo; }
});

test("a naming failure stays explicit without invalidating downloads or retrying their bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-naming-warning-"));
  t.after(async () => { clearPersonMediaIndexCache(); await rm(root, { recursive: true, force: true }); });
  const person = { id: "person", name: "A", folderPath: path.join(root, "A"),
    platforms: [{ id: "x", label: "X", accounts: [{ id: "a", label: "@account" }] }] };
  const record = media("A", "2026-01-01T09:00:00Z", 1, "payload");
  let failNaming = true, downloaded = 0;
  const manager = new SyncManager({ indexFile: path.join(root, "sync-index.json"),
    loadState: async () => ({ persons: [person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ complete: true, media: [record], posts: [{ postId: "A", postKey: "A", createdAt: record.createdAt }] }) },
    download: async (item, ...args) => { downloaded += 1; return fixtureDownload(item, ...args, item.payload); },
    openMediaIndex: async (...args) => {
      const index = await openPersonMediaIndex(...args);
      return new Proxy(index, { get(target, key) {
        if (key === "finalizeNaming" && failNaming) return async () => { throw new Error("fixture player sharing violation"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } });
  const first = await run(manager, person.id);
  assert.equal(first.namingStatus, "pending");
  assert.equal(first.counters.downloaded, 1);
  assert.match(first.errors.at(-1).message, /命名整理未完成/);
  const scope = await manager.store.scope("person:x:a");
  assert.equal(Object.keys(scope.media).length, 1);
  assert.equal(Object.keys(scope.pendingMedia).length, 0);
  failNaming = false;
  const retry = await run(manager, person.id);
  assert.equal(retry.namingStatus, "complete");
  assert.equal(retry.counters.failed, 0);
  assert.equal(downloaded, 1);
});

test("sync filenames use Beijing dates while original publication instants and incremental records stay intact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-beijing-engine-"));
  t.after(async () => { clearPersonMediaIndexCache(); await rm(root, { recursive: true, force: true }); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Beijing date conversion must remain entirely local"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const person = { id: "beijing", name: "人物A", folderPath: path.join(root, "A"),
    platforms: [{ id: "x", label: "X", accounts: [{ id: "a", label: "@account" }] }] };
  const records = [media("before", "2026-10-01T15:59:59Z", 1, "before-midnight", "image", "20261001"),
    media("after", "2026-10-01T16:30:00Z", 1, "after-midnight", "image", "20261001"),
    media("after", "2026-10-01T16:30:00Z", 2, "after-video", "video", "20261001")];
  let downloads = 0;
  const manager = new SyncManager({ indexFile: path.join(root, "sync-index.json"),
    loadState: async () => ({ persons: [person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ complete: true, media: records,
      posts: records.map(({ postId, createdAt }) => ({ postId, postKey: postId, createdAt })) }) },
    download: async (item, ...args) => { downloads += 1; return fixtureDownload(item, ...args, item.payload); } });
  assert.equal((await run(manager, person.id)).counters.failed, 0);
  const index = await openPersonMediaIndex(person);
  const names = (await readdir(path.join(person.folderPath, "Image"))).sort();
  assert.match(names[0], /^20261001_人物A_01_/);
  assert.match(names[1], /^20261002_人物A_01_/);
  assert.match((await readdir(path.join(person.folderPath, "Video")))[0], /^20261002_人物A_01_/);
  const after = index.list().items.find((asset) => index.sources(asset.mediaId).some((source) => source.logicalKey === "after:1"));
  const source = index.sources(after.mediaId)[0];
  assert.equal(source.createdAt, "2026-10-01T16:30:00Z");
  assert.equal(source.publicationDate, "20261002");
  assert.equal(source.dateBasis, "created-at-beijing");
  assert.equal(source.displayTimeZone, "Asia/Shanghai");
  const scope = await manager.store.scope("beijing:x:a");
  assert.equal(scope.knownPosts.after, "2026-10-01T16:30:00Z");
  const next = await run(manager, person.id);
  assert.equal(next.counters.failed, 0);
  assert.equal(next.counters.downloaded, 0);
  assert.equal(downloads, 3);
  assert.deepEqual((await readdir(path.join(person.folderPath, "Image"))).sort(), names);
});
