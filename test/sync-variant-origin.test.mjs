import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { SyncStore } from "../lib/sync-store.mjs";

test("global logical record keeps observed variant hash but does not inherit it after content replacement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SyncStore(path.join(root, "sync-index.json"));
  const item = { logicalKey: "post:1", postId: "post", kind: "image" };
  const canonical = "a".repeat(64), variant = "b".repeat(64), replacement = "c".repeat(64);
  await store.markMedia("scope", item, { mediaId: canonical, originMediaId: variant });
  assert.equal((await store.scope("scope")).media[item.logicalKey].originMediaId, variant);
  await store.markMedia("scope", item, { mediaId: canonical });
  assert.equal((await store.scope("scope")).media[item.logicalKey].originMediaId, variant);
  const restored = new SyncStore(store.filePath);
  assert.equal((await restored.scope("scope")).media[item.logicalKey].originMediaId, variant);
  await restored.markMedia("scope", item, { mediaId: replacement });
  assert.equal((await restored.scope("scope")).media[item.logicalKey].originMediaId, undefined);
});
