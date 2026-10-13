import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { downloadMediaItem } from "../lib/downloader.mjs";
import { analyzeHomepage } from "../lib/homepage-discovery.mjs";
import { publicUseStatus, recordPublicUseAcknowledgement, requiresPublicUseAcknowledgement } from "../lib/public-release-policy.mjs";
import { SyncManager } from "../lib/sync-engine.mjs";

for (const status of [401, 403, 429]) {
  test(`public media HTTP ${status} stops without immediate retry or rendition switching`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "public-access-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let requests = 0;
    await assert.rejects(downloadMediaItem({ kind: "video", sourceUrl: "https://media.example/video.mp4",
      sourceCandidates: [{ sourceUrl: "https://media.example/second.mp4" }], extension: ".mp4", postId: "test" }, root, {},
    { fetchMedia: async () => { requests++; return new Response("refused", { status }); } }), (error) => error.status === status);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(root), []);
  });
  test(`public homepage HTTP ${status} never falls back to another browser`, async () => {
    let requests = 0, launches = 0;
    await assert.rejects(analyzeHomepage("https://creator.example", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetchImpl: async () => { requests++; return new Response("refused", { status }); },
      browserType: { launch: async () => { launches++; throw new Error("should not launch"); } },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(requests, 1); assert.equal(launches, 0);
  });
}

test("risk acknowledgement is explicit and is never reported as platform authorization", () => {
  assert.equal(publicUseStatus().acknowledged, false);
  for (const body of [null, true, {}, { acknowledged: true, version: 0 }, { acknowledged: true, version: 1, permission: true }]) {
    assert.throws(() => recordPublicUseAcknowledgement(body), (error) => error.status === 400);
  }
  const record = recordPublicUseAcknowledgement({ acknowledged: true, version: 1 }, new Date("2026-10-12T00:00:00Z"));
  assert.equal(publicUseStatus({ publicReleaseUse: record }).acknowledged, true);
  assert.equal(publicUseStatus({ publicReleaseUse: record }).platformAuthorizationVerified, false);
  assert.equal(publicUseStatus({ publicReleaseUse: { version: 1, acceptedAt: "broken" } }).acknowledged, false);
  for (const route of ["/api/sync-all", "/api/persons/a/sync", "/api/persons/a/recheck", "/api/persons/a/open-post",
    "/api/linked-accounts/a/open-login", "/api/linked-accounts/a/verify-login", "/api/platforms/a/probe", "/api/homepages/analyze", "/api/following-imports"]) {
    assert.equal(requiresPublicUseAcknowledgement("POST", route), true);
  }
  assert.equal(requiresPublicUseAcknowledgement("GET", "/api/state"), false);
  assert.equal(requiresPublicUseAcknowledgement("POST", "/api/dedup-all"), false);
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} stops remaining media without reporting a successful sync`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "public-account-stop-"));
    const person = { id: "fixture", name: "Fixture", folderPath: path.join(root, "media"),
      platforms: [{ id: "x", label: "X", accounts: [{ id: "target", label: "@fixture" }] }] };
    const items = ["1", "2"].map((postId) => ({ logicalKey: `${postId}:1`, postId, postKey: postId,
      mediaIndex: 1, kind: "image", sourceUrl: `https://media.example/${postId}.jpg`,
      createdAt: "2026-10-01T00:00:00Z", postUrl: `https://x.com/fixture/status/${postId}` }));
    let downloads = 0;
    const manager = new SyncManager({ indexFile: path.join(root, "sync-index.json"),
      loadState: async () => ({ persons: [person], linkedAccounts: [] }),
      discoverers: { x: async () => ({ media: items, posts: items, complete: true, reachedEnd: true,
        completionReason: "terminal-page" }) },
      download: async () => { downloads++; throw Object.assign(new Error("Explicit fixture refusal"), { status }); } });
    t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
    const { job } = await manager.start(person.id);
    const deadline = Date.now() + 5000;
    while (["running", "queued"].includes(manager.get(job.id).status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const receipt = manager.get(job.id);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.operationStatus, "partial");
    assert.equal(receipt.errors.length, 1);
    assert.equal(downloads, 1);
    await manager.store.writeQueue;
    const scope = Object.values(manager.store.index.scopes)[0];
    assert.equal(scope.lastSuccessfulSyncAt, null);
    assert.equal(Object.keys(scope.pendingMedia).length, 2);
  });
}
