import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";
import { ProfileMaintenance } from "../lib/profile-maintenance.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";
import { openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { syncScopeKey } from "../lib/sync-store.mjs";

async function fixture(t, { shared = false, targets = 1, profile = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-sync-cache-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("media-tracker-sync-cache-"));
    await rm(root, { recursive: true, force: true });
  });
  const linkedAccounts = Array.from({ length: shared ? 1 : targets }, (_, index) => ({
    id: `login-${index}`, platformId: "x", loginStatus: "verified",
    ...(profile ? { profileDirectory: path.join(root, "profiles", `profile-${index}`) } : {}),
    secretFixture: "never-persist-this-account-field",
  }));
  const person = {
    id: "cache-person", name: "Cache fixture", folderPath: path.join(root, "person"),
    platforms: [{ id: "x", label: "X", accounts: Array.from({ length: targets }, (_, index) => ({
      id: `target-${index}`, label: `@creator_${index}`, folderName: `creator_${index}`,
      linkedAccountId: linkedAccounts[shared ? 0 : index].id,
    })) }],
  };
  for (const account of person.platforms[0].accounts) {
    await mkdir(path.join(person.folderPath, "X", account.folderName), { recursive: true });
  }
  const state = { persons: [person], linkedAccounts };
  return { root, person, state, indexFile: path.join(root, "sync-index.json"), loadState: async () => state };
}

function discovery(handle, { complete = true, dispose = async () => {} } = {}) {
  const postId = handle.replace(/\D/g, "") || "0";
  const item = {
    platformId: "x", postId, postKey: postId, logicalKey: `${postId}:1`, kind: "image",
    mediaIndex: 1, extension: ".jpg", sourceUrl: `https://example.test/${postId}.jpg`,
  };
  return { posts: [{ postId, postKey: postId }], media: [item], complete, dispose };
}

const download = fixtureDownload;

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Cache cleanup fixture did not settle");
}

async function settle(manager, id) {
  await waitFor(() => !["queued", "running"].includes(manager.get(id)?.status) && !manager.activeJobIds.has(id));
  await manager.store.writeQueue;
  return manager.get(id);
}

async function run(manager, personId = "cache-person") {
  return settle(manager, (await manager.start(personId)).job.id);
}

test("successful sync disposes resources before cleanup and publishes only a safe report", async (t) => {
  const setup = await fixture(t);
  const events = [];
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle, { dispose: async () => events.push("dispose") }) },
    cleanupAccountCache: async ({ linkedAccount, platformId }) => {
      events.push("cleanup");
      assert.deepEqual(linkedAccount, setup.state.linkedAccounts[0]);
      assert.notEqual(linkedAccount, setup.state.linkedAccounts[0], "A run uses an immutable configuration snapshot");
      assert.equal(platformId, "x");
      return {
        status: "cleaned", removedBytes: 512, removedFiles: 2, removedDirectories: 1,
        profileDirectory: linkedAccount.profileDirectory, candidates: [linkedAccount],
        errors: ["private-file-path"], reason: "private-file-path",
      };
    },
  });
  const result = await run(manager);
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 1);
  assert.deepEqual(events, ["dispose", "cleanup"]);
  assert.deepEqual(result.cacheCleanup, [{
    linkedAccountId: "login-0", platformId: "x", status: "cleaned", removedBytes: 512, removedFiles: 2, removedDirectories: 1,
  }]);
  const serialized = await readFile(setup.indexFile, "utf8");
  assert.doesNotMatch(serialized, /profileDirectory|private-file-path|never-persist-this-account-field|cacheCandidates/);
  assert.deepEqual((await manager.store.summary(setup.person.id)).cacheCleanup, result.cacheCleanup);
});

for (const failure of ["download", "discovery", "incomplete"]) {
  test(`${failure} failure retains that profile's cache`, async (t) => {
    const setup = await fixture(t);
    let calls = 0;
    const manager = new SyncManager({ ...setup,
      discoverers: { x: async ({ handle }) => {
        if (failure === "discovery") throw new Error("Discovery fixture failed");
        return discovery(handle, { complete: failure !== "incomplete" });
      } },
      download: async (...args) => {
        if (failure === "download") throw new Error("Download fixture failed");
        return download(...args);
      },
      cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
    });
    const result = await run(manager);
    assert.equal(result.status, "completed");
    assert.equal(result.counters.failed, failure === "incomplete" ? 0 : 1);
    assert.equal(result.counters.warnings, failure === "incomplete" ? 1 : 0);
    assert.equal(calls, 0);
    assert.deepEqual(result.cacheCleanup, [{
      linkedAccountId: "login-0", platformId: "x", status: "skipped", reason: "sync-not-successful",
    }]);
  });
}

test("cancellation during the final dispose preserves every profile cache", async (t) => {
  const setup = await fixture(t, { targets: 2 });
  let calls = 0;
  let disposed = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle, { dispose: async () => {
      disposed += 1;
      if (handle === "creator_1") manager.cancel([...manager.jobs.keys()][0]);
    } }) },
    cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.status, "cancelled");
  assert.equal(disposed, 2);
  assert.equal(calls, 0);
  assert.deepEqual(result.cacheCleanup, []);
});

for (const failedHandle of ["creator_0", "creator_1"]) {
  test(`a shared profile with ${failedHandle} failing is not cleaned after its other target succeeds`, async (t) => {
    const setup = await fixture(t, { shared: true, targets: 2 });
    let calls = 0;
    const manager = new SyncManager({ ...setup, download,
      discoverers: { x: async ({ handle }) => {
        if (handle === failedHandle) throw new Error("Shared fixture failed");
        return discovery(handle);
      } },
      cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
    });
    const result = await run(manager);
    assert.equal(result.counters.downloaded, 1);
    assert.equal(result.counters.failed, 1);
    assert.equal(calls, 0);
    assert.equal(result.cacheCleanup.length, 1);
    assert.equal(result.cacheCleanup[0].status, "skipped");
  });
}

test("all successful targets sharing a profile clean once, after every disposal", async (t) => {
  const setup = await fixture(t, { shared: true, targets: 3 });
  const events = [];
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle, { dispose: async () => events.push(handle) }) },
    cleanupAccountCache: async () => { events.push("cleanup"); return { status: "empty", removedBytes: 0 }; },
  });
  const result = await run(manager);
  assert.equal(result.counters.downloaded, 3);
  assert.deepEqual(events, ["creator_0", "creator_1", "creator_2", "cleanup"]);
  assert.equal(result.cacheCleanup.length, 1);
  assert.equal(result.cacheCleanup[0].status, "empty");
});

test("different linked-account IDs pointing at one profile are deduplicated by profile path", async (t) => {
  const setup = await fixture(t, { targets: 2 });
  setup.state.linkedAccounts[1].profileDirectory = setup.state.linkedAccounts[0].profileDirectory;
  let calls = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle) },
    cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.counters.downloaded, 2);
  assert.equal(calls, 1);
  assert.equal(result.cacheCleanup.length, 1);
});

test("an unrelated profile failure does not prevent a successful profile from cleaning", async (t) => {
  const setup = await fixture(t, { targets: 2 });
  const calls = [];
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => {
      if (handle === "creator_1") throw new Error("Other profile failed");
      return discovery(handle);
    } },
    cleanupAccountCache: async ({ linkedAccount }) => { calls.push(linkedAccount.id); return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.counters.failed, 1);
  assert.deepEqual(calls, ["login-0"]);
  assert.deepEqual(result.cacheCleanup.map(({ status }) => status), ["cleaned", "skipped"]);
});

test("cleanup exceptions preserve successful media results and exclude exception paths", async (t) => {
  const setup = await fixture(t);
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle) },
    cleanupAccountCache: async () => { throw new Error("private-profile-file-location"); },
  });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 1);
  assert.deepEqual(result.cacheCleanup, [{ linkedAccountId: "login-0", platformId: "x", status: "failed", reason: "cleanup-failed" }]);
  assert.doesNotMatch(JSON.stringify(result), /private-profile-file-location/);
});

test("dispose exceptions veto cleanup but do not turn saved media into failures", async (t) => {
  const setup = await fixture(t);
  let calls = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle, { dispose: async () => { throw new Error("Dispose failed"); } }) },
    cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.downloaded, 1);
  assert.equal(calls, 0);
  assert.equal(result.cacheCleanup[0].reason, "resource-release-failed");
});

test("a global job failure after one success retains every profile cache", async (t) => {
  const setup = await fixture(t, { targets: 2 });
  let calls = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle) },
    cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
  });
  const originalScope = manager.store.scope.bind(manager.store);
  manager.store.scope = async (key) => {
    if (key.endsWith("target-1")) throw new Error("Global index fixture failure");
    return originalScope(key);
  };
  const result = await run(manager);
  assert.equal(result.status, "failed");
  assert.equal(result.counters.downloaded, 1);
  assert.equal(calls, 0);
  assert.deepEqual(result.cacheCleanup, []);
});

test("cleanup retains resource locks, delaying the next job using that login", async (t) => {
  const setup = await fixture(t);
  const secondPerson = { ...setup.person, id: "second-person", folderPath: path.join(setup.root, "second") };
  setup.state.persons.push(secondPerson);
  let releaseCleanup;
  let cleanupStarted = false;
  let discoveries = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => { discoveries += 1; return discovery(handle); } },
    cleanupAccountCache: async () => {
      assert.ok(manager.activeResourceKeys.has("login:login-0"));
      if (!cleanupStarted) {
        cleanupStarted = true;
        await new Promise((resolve) => { releaseCleanup = resolve; });
      }
      return { status: "cleaned" };
    },
  });
  const first = (await manager.start(setup.person.id)).job;
  await waitFor(() => cleanupStarted);
  assert.equal((await manager.summaries([setup.person.id]))[setup.person.id].id, first.id,
    "cleanup must not expose the previous saved receipt while the latest one is finishing");
  const second = (await manager.start(secondPerson.id)).job;
  await waitFor(() => manager.get(second.id).accountProgress.some(account => account.status === "queued" && account.waiting.length));
  assert.equal(manager.get(second.id).status, "running");
  assert.equal(discoveries, 1);
  assert.equal(manager.isPersonBusy(setup.person.id), true);
  releaseCleanup();
  await settle(manager, first.id);
  await settle(manager, second.id);
  assert.equal(discoveries, 2);
  assert.equal(manager.activeResourceKeys.size, 0);
});

test("a linked account without a dedicated browser profile is never sent to cleanup", async (t) => {
  const setup = await fixture(t, { profile: false });
  let calls = 0;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle) },
    cleanupAccountCache: async () => { calls += 1; return { status: "cleaned" }; },
  });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.equal(calls, 0);
  assert.deepEqual(result.cacheCleanup, []);
});

test("cache cleanup is opt-in through the server callback", async (t) => {
  const setup = await fixture(t);
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => discovery(handle) },
  });
  const result = await run(manager);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.cacheCleanup, []);
});

test("real cache cleanup preserves login data and saved media across incremental runs", async (t) => {
  const setup = await fixture(t);
  const profilesRoot = path.join(setup.root, "browser-profiles");
  const profileDirectory = path.join(profilesRoot, "x", "login-0");
  setup.state.linkedAccounts[0].profileDirectory = profileDirectory;
  const cache = path.join(profileDirectory, "Default", "Cache", "fixture");
  const cookie = path.join(profileDirectory, "Default", "Network", "Cookies");
  await mkdir(path.dirname(cache), { recursive: true });
  await mkdir(path.dirname(cookie), { recursive: true });
  await writeFile(cache, "recreatable-cache");
  await writeFile(cookie, "synthetic-login-data");
  const maintenance = new ProfileMaintenance({ profilesRoot, isRunning: async () => false });
  let downloads = 0;
  const manager = new SyncManager({ ...setup,
    download: async (...args) => { downloads++; return download(...args); },
    discoverers: { x: async ({ handle }) => discovery(handle) },
    cleanupAccountCache: (options) => maintenance.cleanupAccount(options),
  });
  const first = await run(manager);
  assert.equal(first.cacheCleanup[0].status, "cleaned");
  assert.equal(first.cacheCleanup[0].removedBytes, 17);
  await assert.rejects(readFile(cache), { code: "ENOENT" });
  assert.equal(await readFile(cookie, "utf8"), "synthetic-login-data");
  const scope = await manager.store.scope(syncScopeKey(setup.person.id, "x", "target-0"));
  const savedMedia = await (await openPersonMediaIndex(setup.person)).resolve(scope.media["0:1"].mediaId);
  assert.equal(await readFile(savedMedia, "utf8"), "0");
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, "rebuilt-cache");
  const next = await run(manager);
  assert.equal(next.counters.logicalDuplicates, 1);
  assert.equal(next.counters.downloaded, 0);
  assert.equal(downloads, 1, "cache deletion must not redownload saved indexed media");
  assert.equal(next.cacheCleanup[0].status, "cleaned");
  assert.equal(await readFile(cookie, "utf8"), "synthetic-login-data");
  await assert.rejects(readFile(cache), { code: "ENOENT" });
});

test("profile-path scheduling also isolates aliases and prior login verification", async (t) => {
  const setup = await fixture(t);
  const alias = { ...setup.state.linkedAccounts[0], id: "alias-login" };
  setup.state.linkedAccounts.push(alias);
  const second = structuredClone(setup.person);
  second.id = "alias-person";
  second.folderPath = path.join(setup.root, "alias-person");
  second.platforms[0].accounts[0].linkedAccountId = alias.id;
  setup.state.persons.push(second);
  let discoveries = 0;
  let releaseCleanup;
  const manager = new SyncManager({ ...setup, download,
    discoverers: { x: async ({ handle }) => { discoveries++; return discovery(handle); } },
    cleanupAccountCache: async () => {
      if (discoveries === 1) await new Promise((resolve) => { releaseCleanup = resolve; });
      return { status: "empty" };
    },
  });
  const key = `profile:${path.resolve(alias.profileDirectory).toLowerCase()}`;
  manager.activeResourceKeys.add(key); // Server reserves this while verifying login.
  const firstJob = (await manager.start(setup.person.id)).job;
  await waitFor(() => manager.get(firstJob.id).accountProgress.some(account => account.status === "queued" && account.waiting.length));
  assert.equal(manager.get(firstJob.id).status, "running");
  assert.equal(discoveries, 0);
  manager.activeResourceKeys.delete(key);
  manager.drain();
  await waitFor(() => Boolean(releaseCleanup));
  const secondJob = (await manager.start(second.id)).job;
  await waitFor(() => manager.get(secondJob.id).accountProgress.some(account => account.status === "queued" && account.waiting.length));
  assert.equal(manager.get(secondJob.id).status, "running");
  assert.equal(discoveries, 1);
  releaseCleanup();
  await settle(manager, firstJob.id);
  await settle(manager, secondJob.id);
  assert.equal(discoveries, 2);
  assert.equal(manager.activeResourceKeys.size, 0);
});
