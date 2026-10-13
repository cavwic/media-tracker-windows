import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { syncScopeKey } from "../lib/sync-store.mjs";
import { openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

const CUSTOM_ID = "custom-11111111-1111-4111-8111-111111111111";
const SECOND_CUSTOM_ID = "custom-22222222-2222-4222-8222-222222222222";
const EARLIER = "2026-09-01T00:00:00.000Z";

async function fixture(t, { linked = false, engine = "auto" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-custom-sync-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("media-tracker-custom-sync-"));
    await rm(root, { recursive: true, force: true });
  });
  const definition = {
    id: CUSTOM_ID, custom: true, label: "Custom Example", homepageUrl: "https://example.test/",
    loginUrl: "https://example.test/login", engine,
  };
  const account = {
    id: "creator", label: "Creator", folderName: "creator", url: "https://example.test/creator",
    ...(linked ? { linkedAccountId: "my-custom-login" } : {}),
  };
  const platform = { id: CUSTOM_ID, label: definition.label, folderName: "Original Folder", accounts: [account] };
  const person = { id: "custom-person", name: "Custom fixture", folderPath: path.join(root, "person"), platforms: [platform] };
  const linkedAccount = {
    id: "my-custom-login", platformId: CUSTOM_ID, loginStatus: "verified", profileDirectory: path.join(root, "browser-profile"),
    cookies: "fixture-secret-never-persist",
  };
  const state = { persons: [person], customPlatforms: [definition], linkedAccounts: linked ? [linkedAccount] : [] };
  const accountRoot = person.folderPath;
  await mkdir(accountRoot, { recursive: true });
  return {
    root, person, platform, definition, account, linkedAccount, accountRoot, state,
    scopeKey: syncScopeKey(person.id, platform.id, account.id),
    indexFile: path.join(root, "sync-index.json"), loadState: async () => state,
  };
}

function media(postId = "post-a", kind = "image", platformId = CUSTOM_ID) {
  return {
    platformId, postId, postKey: postId, logicalKey: `${postId}:${kind}:1`, mediaIndex: 1,
    kind, extension: kind === "image" ? ".jpg" : ".mp4", createdAt: "2026-09-20T00:00:00.000Z",
    sourceUrl: `https://media.example.test/${postId}.${kind === "image" ? "jpg" : "mp4"}`,
    postUrl: `https://example.test/creator/${postId}`,
  };
}

function discovery(items, complete = true, extras = {}) {
  return { posts: items.map(({ postKey, postId, createdAt }) => ({ postKey, postId, createdAt })), media: items, complete, ...extras };
}

async function download(item, root, scope, options) {
  const bytes = options?.fetchMedia ? await (await options.fetchMedia(item.sourceUrl)).text()
    : `custom-fixture-${item.postId}-${item.kind}-${item.mediaIndex}`;
  return fixtureDownload(item, root, scope, options, bytes);
}

async function run(manager, personId = "custom-person") {
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
  throw new Error("Custom sync fixture did not finish");
}

test("custom discovery uses its registry definition and anonymous URL; storage is shared at person root", async (t) => {
  const setup = await fixture(t);
  let disposed = false;
  let fetched = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async (options) => {
      assert.deepEqual(options.platform, setup.definition);
      assert.deepEqual(options.account, setup.account);
      assert.equal(options.linkedAccount, null);
      assert.equal(options.initialComplete, false);
      assert.equal(options.since, null);
      assert.deepEqual(options.knownPosts, {});
      assert.deepEqual(options.knownMediaKeys, []);
      assert.deepEqual(options.retryPosts, []);
      assert.equal(options.signal.aborted, false);
      options.onProgress({ media: 2 });
      return discovery([media(), media("post-b", "video")], true, {
        capability: { supported: true, engine: "yt-dlp" },
        fetchMedia: async (url) => {
          assert.equal(disposed, false);
          fetched += 1;
          return new Response(url.endsWith(".mp4") ? "custom-media-video" : "custom-media-image");
        },
        dispose: async () => { disposed = true; },
      });
    } },
  });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 2);
  assert.equal(fetched, 2);
  assert.equal(disposed, true);
  const scope = await manager.store.scope(setup.scopeKey);
  const index = await openPersonMediaIndex(setup.person);
  assert.equal(await readFile(await index.resolve(scope.media[media().logicalKey].mediaId), "utf8"), "custom-media-image");
  assert.equal(await readFile(await index.resolve(scope.media[media("post-b", "video").logicalKey].mediaId), "utf8"), "custom-media-video");
  assert.equal(scope.initialComplete, true);
  assert.equal((await manager.receipt(setup.person.id)).files[0].platformId, CUSTOM_ID);
  assert.doesNotMatch(await readFile(setup.indexFile, "utf8"), /fetchMedia|"dispose"|fixture-secret-never-persist/);
});

test("custom incremental sync receives the saved boundary and skips already indexed media without fetching again", async (t) => {
  const setup = await fixture(t);
  let calls = 0;
  let downloaded = 0;
  let firstBoundary;
  const manager = new SyncManager({ ...setup,
    discoverers: { custom: async (options) => {
      calls += 1;
      if (calls === 2) {
        assert.equal(options.initialComplete, true);
        assert.equal(options.since, firstBoundary);
        assert.equal(options.knownPosts["post-a"], media().createdAt);
        assert.deepEqual(options.knownMediaKeys, [media().logicalKey]);
      }
      return discovery([media()]);
    } },
    download: async (...args) => { downloaded += 1; return download(...args); },
  });
  assert.equal((await run(manager)).counters.downloaded, 1);
  firstBoundary = (await manager.store.scope(setup.scopeKey)).scanCompletedAt;
  const next = await run(manager);
  assert.equal(next.counters.failed, 0);
  assert.equal(next.counters.downloaded, 0);
  assert.equal(next.counters.logicalDuplicates, 1);
  assert.equal(downloaded, 1);
});

for (const outcome of ["discovery-failed", "incomplete"]) {
  test(`${outcome} custom scan does not advance an existing scan or successful-sync boundary`, async (t) => {
    const setup = await fixture(t);
    const manager = new SyncManager({ ...setup, download,
      discoverers: { custom: async () => {
        if (outcome === "discovery-failed") throw Object.assign(new Error("Custom site not supported by installed engine"), { code: "custom-site-unsupported" });
        return discovery([media()], false);
      } },
    });
    const scope = await manager.store.scope(setup.scopeKey);
    Object.assign(scope, { initialComplete: true, scanCompletedAt: EARLIER, lastSuccessfulSyncAt: EARLIER, existingFilesIndexedAt: EARLIER });
    await manager.store.save();
    const result = await run(manager);
    assert.equal(result.counters.failed, outcome === "incomplete" ? 0 : 1);
    assert.equal(result.counters.warnings, outcome === "incomplete" ? 1 : 0);
    assert.match(result.message, outcome === "incomplete" ? /可读取媒体已同步/ : /失败/);
    if (outcome === "incomplete") {
      assert.doesNotMatch(result.message, /待检查/);
      assert.equal(result.operationStatus, "synced");
      assert.ok(result.warnings.length, "Internal incomplete-range diagnostics remain available without a manual-review alert");
    }
    assert.equal(scope.scanCompletedAt, EARLIER);
    assert.equal(scope.lastSuccessfulSyncAt, EARLIER);
    assert.equal((outcome === "incomplete" ? result.warnings : result.errors)[0].code,
      outcome === "incomplete" ? "timeline-incomplete" : "custom-site-unsupported");
  });
}

test("custom download failures retain pending metadata and retry old media without moving the successful-sync boundary", async (t) => {
  const setup = await fixture(t);
  let retry = false;
  const manager = new SyncManager({ ...setup,
    discoverers: { custom: async ({ retryPosts }) => {
      if (retry) assert.deepEqual(retryPosts, [media().postUrl]);
      return discovery(retry ? [] : [media()]);
    } },
    download: async (...args) => {
      if (!retry) throw new Error("custom media download failure");
      return download(...args);
    },
  });
  const scope = await manager.store.scope(setup.scopeKey);
  scope.lastSuccessfulSyncAt = EARLIER;
  await manager.store.save();
  const failed = await run(manager);
  assert.equal(failed.counters.failed, 1);
  assert.equal(scope.lastSuccessfulSyncAt, EARLIER);
  assert.match(scope.pendingMedia[media().logicalKey].lastError, /download failure/);
  retry = true;
  const recovered = await run(manager);
  assert.equal(recovered.counters.failed, 0);
  assert.equal(recovered.counters.downloaded, 1);
  assert.deepEqual(scope.pendingMedia, {});
  assert.notEqual(scope.lastSuccessfulSyncAt, EARLIER);
});

test("verified custom login is passed to discovery with the same profile resource lock held", async (t) => {
  const setup = await fixture(t, { linked: true });
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async ({ linkedAccount }) => {
      assert.deepEqual(linkedAccount, setup.linkedAccount);
      assert.ok(manager.activeResourceKeys.has(`profile:${path.resolve(linkedAccount.profileDirectory).toLowerCase()}`));
      return discovery([media()]);
    } },
  });
  assert.equal((await run(manager)).counters.failed, 0);
});

for (const invalid of ["missing", "other-platform", "unverified"]) {
  test(`a ${invalid} custom login binding cannot reach the downloader`, async (t) => {
    const setup = await fixture(t, { linked: true });
    if (invalid === "missing") setup.state.linkedAccounts = [];
    if (invalid === "other-platform") setup.linkedAccount.platformId = SECOND_CUSTOM_ID;
    if (invalid === "unverified") setup.linkedAccount.loginStatus = "unknown";
    let calls = 0;
    const manager = new SyncManager({ ...setup,
      discoverers: { custom: async () => { calls += 1; return discovery([media()]); } },
      download,
    });
    const result = await run(manager);
    assert.equal(calls, 0);
    assert.equal(result.counters.failed, 1);
    assert.equal(result.errors[0].code, invalid === "unverified" ? "login-unverified" : "linked-account-missing");
    assert.equal((await manager.store.scope(setup.scopeKey)).scanCompletedAt, null);
  });
}

for (const engine of ["none", "", "invalid-engine"]) {
  test(`custom engine '${engine}' is reported as a failure instead of a zero-media success`, async (t) => {
    const setup = await fixture(t, { engine });
    let calls = 0;
    const manager = new SyncManager({ ...setup, download,
      discoverers: { custom: async () => { calls += 1; return discovery([]); } },
    });
    const result = await run(manager);
    assert.equal(calls, 0);
    assert.equal(result.counters.failed, 1);
    assert.equal(result.counters.unsupportedAccounts, 1);
    assert.equal(result.errors[0].code, "adapter-pending");
    assert.match(result.message, /失败/);
    assert.equal((await manager.store.scope(setup.scopeKey)).initialComplete, false);
  });
}

test("a removed custom platform definition fails explicitly without advancing its index", async (t) => {
  const setup = await fixture(t);
  setup.state.customPlatforms = [];
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async () => { throw new Error("Unexpected custom discovery"); } },
  });
  const result = await run(manager);
  assert.equal(result.counters.failed, 1);
  assert.equal(result.counters.unsupportedAccounts, 1);
  assert.match(result.errors[0].message, /配置已不存在/);
  assert.match(result.message, /失败/);
  assert.equal((await manager.store.scope(setup.scopeKey)).scanCompletedAt, null);
});

test("two custom platform instances keep identical account/media IDs in separate scopes", async (t) => {
  const setup = await fixture(t);
  const otherDefinition = { ...setup.definition, id: SECOND_CUSTOM_ID, label: "Second Site", homepageUrl: "https://second.example.test/" };
  setup.state.customPlatforms.push(otherDefinition);
  setup.person.platforms.push({ id: SECOND_CUSTOM_ID, label: otherDefinition.label, accounts: [{ ...setup.account }] });
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async ({ platform }) => discovery([media("same-post", "image", platform.id)]) },
  });
  const result = await run(manager);
  assert.equal(result.counters.downloaded, 1);
  assert.equal(result.counters.contentDuplicates, 1);
  assert.equal(result.counters.logicalDuplicates, 0);
  const otherKey = syncScopeKey(setup.person.id, SECOND_CUSTOM_ID, setup.account.id);
  assert.notEqual(setup.scopeKey, otherKey);
  const firstScope = await manager.store.scope(setup.scopeKey);
  const secondScope = await manager.store.scope(otherKey);
  assert.notEqual(firstScope, secondScope);
  assert.deepEqual(Object.keys(firstScope.media), ["same-post:image:1"]);
  assert.deepEqual(Object.keys(secondScope.media), ["same-post:image:1"]);
});

test("custom cache cleanup runs after disposal and its failure does not change the media result", async (t) => {
  const setup = await fixture(t, { linked: true });
  const events = [];
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async () => discovery([media()], true, { dispose: async () => events.push("dispose") }) },
    cleanupAccountCache: async ({ linkedAccount, platformId }) => {
      assert.deepEqual(linkedAccount, setup.linkedAccount);
      assert.equal(platformId, CUSTOM_ID);
      events.push("cleanup");
      throw new Error("private cleanup path must not leak");
    },
  });
  const result = await run(manager);
  assert.deepEqual(events, ["dispose", "cleanup"]);
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 1);
  assert.equal(result.cacheCleanup[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /private cleanup path|fixture-secret-never-persist/);
});

test("an incomplete custom scan preserves its profile cache", async (t) => {
  const setup = await fixture(t, { linked: true });
  let cleaned = false;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async () => discovery([media()], false) },
    cleanupAccountCache: async () => { cleaned = true; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.warnings, 1);
  assert.equal(cleaned, false);
  assert.equal(result.cacheCleanup[0].reason, "sync-not-successful");
});

test("cancelling a custom media download disposes its runtime and never cleans its cache", async (t) => {
  const setup = await fixture(t, { linked: true });
  let disposed = 0;
  let cleaned = false;
  const manager = new SyncManager({ ...setup,
    discoverers: { custom: async () => discovery([media()], true, { dispose: async () => { disposed += 1; } }) },
    download: async () => { throw new DOMException("Custom fixture cancelled", "AbortError"); },
    cleanupAccountCache: async () => { cleaned = true; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.status, "cancelled");
  assert.equal(disposed, 1);
  assert.equal(cleaned, false);
  assert.equal((await manager.store.scope(setup.scopeKey)).pendingMedia[media().logicalKey].postId, "post-a");
});

test("metadata budgets skip successful media rather than an entire partially visited multi-image post", async (t) => {
  const setup = await fixture(t);
  const photos = [1, 2, 3].map((index) => ({
    ...media("album"), logicalKey: `album:image:${index}`, mediaIndex: index,
    sourceUrl: `https://media.example.test/album-${index}.jpg`,
  }));
  let scans = 0;
  const manager = new SyncManager({ ...setup,
    discoverers: { custom: async ({ knownPosts, knownMediaKeys, initialComplete }) => {
      scans += 1;
      assert.equal(initialComplete, false);
      assert.deepEqual(knownMediaKeys, photos.slice(0, scans - 1).map(({ logicalKey }) => logicalKey));
      if (scans > 1) assert.equal(knownPosts.album, photos[0].createdAt, "the post is known even though its remaining images are not");
      const remaining = photos.filter(({ logicalKey }) => !knownMediaKeys.includes(logicalKey));
      return discovery(remaining.slice(0, 1), remaining.length === 1);
    } },
    download: (item, ...args) => download({ ...item, postId: `album-${item.mediaIndex}` }, ...args),
  });
  for (let scan = 1; scan <= 3; scan += 1) {
    const result = await run(manager);
    assert.equal(result.counters.downloaded, 1);
    assert.equal(result.counters.failed, 0);
    assert.equal(result.counters.warnings, scan === 3 ? 0 : 1);
  }
  const scope = await manager.store.scope(setup.scopeKey);
  assert.equal(scope.initialComplete, true);
  assert.deepEqual(Object.keys(scope.media), photos.map(({ logicalKey }) => logicalKey));
});

test("failed, cancelled-pending and malformed records are excluded from knownMediaKeys even if their post is known", async (t) => {
  const setup = await fixture(t);
  let checked = false;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async ({ knownPosts, knownMediaKeys }) => {
      checked = true;
      assert.ok(Object.keys(knownPosts).length > 0);
      assert.deepEqual(knownMediaKeys, ["successful:image:1"]);
      throw new Error("Metadata contract checked without fetching files");
    } },
  });
  const scope = await manager.store.scope(setup.scopeKey);
  Object.assign(scope, { existingFilesIndexedAt: EARLIER, initialComplete: false });
  const index = await openPersonMediaIndex(setup.person, { create: true });
  const successful = media("successful");
  const successfulResult = await download(successful, setup.person.folderPath, scope, { mediaIndex: index,
    source: { platformId: setup.platform.id, accountId: setup.account.id, logicalKey: successful.logicalKey } });
  for (const key of ["successful", "failed", "cancelled"]) {
    const item = media(key);
    scope.knownPosts[item.postKey] = item.createdAt;
    scope.media[item.logicalKey] = key === "successful" ? successfulResult : { relativePath: `Image/${key}.jpg`, sha256: key };
    if (key !== "successful") scope.pendingMedia[item.logicalKey] = { ...item, lastError: key === "failed" ? "HTTP 503" : "" };
  }
  scope.media["missing-path:image:1"] = { relativePath: "", sha256: "bad-record" };
  await manager.store.save();
  await run(manager);
  assert.equal(checked, true);
});

test("enabling an additional media type clears metadata skip keys and rescans a known post", async (t) => {
  const setup = await fixture(t);
  setup.account.downloadMedia = { image: false, video: true, gif: true };
  let scans = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async ({ knownPosts, knownMediaKeys, initialComplete }) => {
      scans += 1;
      assert.deepEqual(knownMediaKeys, []);
      assert.equal(initialComplete, false);
      if (scans === 2) assert.equal(knownPosts.album, media("album").createdAt);
      return discovery([media("album", "image"), media("album", "video")]);
    } },
  });
  const first = await run(manager);
  assert.equal(first.counters.downloaded, 1);
  assert.equal(first.counters.skippedByPolicy, 1);
  setup.account.downloadMedia.image = true;
  const next = await run(manager);
  assert.equal(next.counters.failed, 0);
  assert.equal(next.counters.downloaded, 1);
  assert.equal(next.counters.logicalDuplicates, 1);
  assert.deepEqual(Object.keys((await manager.store.scope(setup.scopeKey)).media).sort(), ["album:image:1", "album:video:1"]);
});

test("a missing asset is retried without resetting the successful account timeline boundary", async (t) => {
  const setup = await fixture(t);
  let scans = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { custom: async ({ knownMediaKeys, initialComplete, retryPosts }) => {
      scans += 1;
      assert.deepEqual(knownMediaKeys, scans > 1 ? [media().logicalKey] : []);
      assert.equal(initialComplete, scans > 1);
      assert.deepEqual(retryPosts, []);
      return discovery([media()]);
    } },
  });
  assert.equal((await run(manager)).counters.downloaded, 1);
  const record = (await manager.store.scope(setup.scopeKey)).media[media().logicalKey];
  const index = await openPersonMediaIndex(setup.person);
  const filePath = await index.resolve(record.mediaId);
  await rm(filePath);
  const restored = await run(manager);
  assert.equal(scans, 2);
  assert.equal(restored.counters.failed, 0);
  assert.equal(restored.counters.downloaded, 1);
  assert.equal(await readFile(await index.resolve(record.mediaId), "utf8"), "custom-fixture-post-a-image-1");
});
