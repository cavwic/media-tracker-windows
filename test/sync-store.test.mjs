import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { SyncStore, syncScopeKey } from "../lib/sync-store.mjs";

test("sync index persists logical media, hashes, completion, and receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-index-"));
  const filePath = path.join(root, "sync-index.json");
  const key = syncScopeKey("person", "x", "account");
  try {
    const store = new SyncStore(filePath);
    await store.markPosts(key, [{ postKey: "123", createdAt: "2026-08-30T00:00:00.000Z" }]);
    await store.markMedia(key, { logicalKey: "123:1", postId: "123", kind: "image", sourceUrl: "https://example/media" }, {
      sha256: "abc",
      relativePath: path.join("Image", "file.jpg"),
    });
    await store.finishScope(key, { complete: true, successful: true });
    const newFiles = [{
      id: "file-1",
      platformId: "x",
      platformLabel: "X",
      accountId: "account",
      accountLabel: "creator",
      kind: "image",
      filename: "file.jpg",
      relativePath: path.join("Image", "file.jpg"),
    }];
    await store.saveSummary("person", {
      id: "job",
      personId: "person",
      status: "completed",
      newFileCount: 1,
    }, newFiles);

    const reloaded = new SyncStore(filePath);
    const scope = await reloaded.scope(key);
    assert.equal(scope.knownPosts["123"], "2026-08-30T00:00:00.000Z");
    assert.equal(scope.media["123:1"].sha256, "abc");
    assert.equal(scope.hashes.abc, path.join("Image", "file.jpg"));
    assert.equal(scope.initialComplete, true);
    assert.equal((await reloaded.summary("person")).status, "completed");
    assert.deepEqual((await reloaded.receipt("person")).files, newFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 upgrade preserves an exact backup and resets history only once without changing state or profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-index-upgrade-"));
  const filePath = path.join(root, "sync-index.json");
  const legacy = { version: 2, scopes: { "person:x:account": { media: { old: { sha256: "old" } }, initialComplete: true } }, summaries: { person: {} }, receipts: { person: {} } };
  const original = `${JSON.stringify(legacy, null, 2)}\n`;
  try {
    await writeFile(filePath, original);
    await writeFile(path.join(root, "state.json"), "preserve-persons-accounts-settings");
    await mkdir(path.join(root, "browser-profiles"));
    await writeFile(path.join(root, "browser-profiles", "login"), "preserve-session");
    const store = new SyncStore(filePath); await store.ready;
    assert.equal(store.index.version, 3);
    assert.equal(store.index.layout, "person-v1");
    assert.deepEqual(store.index.scopes, {});
    assert.deepEqual(store.index.receipts, {});
    const backups = (await readdir(root)).filter((name) => name.includes("v2-backup"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(root, backups[0]), "utf8"), original);
    await store.markPersonStorageInitialized("person");
    await store.markPosts("person:x:account", [{ postKey: "new" }]);
    const second = new SyncStore(filePath); await second.ready;
    assert.equal((await second.scope("person:x:account")).knownPosts.new, true);
    assert.equal(await second.personStorageInitialized("person"), true);
    assert.equal((await readdir(root)).filter((name) => name.includes("v2-backup")).length, 1);
    assert.equal(await readFile(path.join(root, "state.json"), "utf8"), "preserve-persons-accounts-settings");
    assert.equal(await readFile(path.join(root, "browser-profiles", "login"), "utf8"), "preserve-session");
    await second.removePerson("person");
    assert.equal(await second.personStorageInitialized("person"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v3 media records reference person assets while retaining repair metadata and GIF policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-index-assets-"));
  try {
    const store = new SyncStore(path.join(root, "sync-index.json"));
    const key = syncScopeKey("person", "x", "account");
    await store.markMedia(key, { logicalKey: "post:1", postId: "post", postUrl: "https://x.com/A/status/post", createdAt: "2026-10-02T00:00:00.000Z", mediaIndex: 1, kind: "gif" },
      { mediaId: "a".repeat(64), sha256: "a".repeat(64), relativePath: path.join("Video", "asset.mp4"), kind: "video" });
    const record = (await store.scope(key)).media["post:1"];
    assert.equal(record.mediaId, "a".repeat(64));
    assert.equal(record.kind, "video");
    assert.equal(record.originalKind, "gif");
    assert.equal(record.mediaIndex, 1);
    assert.equal(Object.hasOwn(record, "relativePath"), false);
    assert.deepEqual((await store.scope(key)).hashes, {});
    assert.equal(record.postUrl, "https://x.com/A/status/post");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a rejected save queue recovers on retry and malformed or unknown indexes are never reset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-index-retry-"));
  const filePath = path.join(root, "sync-index.json");
  try {
    const store = new SyncStore(filePath); await store.ready;
    await mkdir(filePath);
    await assert.rejects(store.markPosts("person:x:a", [{ postKey: "first" }]));
    await rm(filePath, { recursive: true });
    await store.markPosts("person:x:a", [{ postKey: "second" }]);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).scopes["person:x:a"].knownPosts.second, true);
    for (const invalid of ["{broken", JSON.stringify({ version: 99 }), JSON.stringify({ version: 3, layout: "unknown" })]) {
      await writeFile(filePath, invalid);
      const malformed = new SyncStore(filePath);
      await assert.rejects(malformed.ready);
      assert.equal(await readFile(filePath, "utf8"), invalid);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
