import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, rename, readdir } from "node:fs/promises";
import { ProfileMaintenance } from "../lib/profile-maintenance.mjs";
import { ManualCacheMaintenance, assertCacheCleanupRequest, assertProfileRemovalRequest } from "../lib/manual-cache-maintenance.mjs";

async function put(target, value = "cache") {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function fixture(callback, overrides = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-manual-cache-"));
  const profilesRoot = path.join(temporaryRoot, "browser-profiles");
  const linkedProfile = path.join(profilesRoot, "x", "linked-profile");
  const oldProfile = path.join(profilesRoot, "instagram", "old-profile");
  await put(path.join(linkedProfile, "Default", "Cache", "one"), "12345");
  await put(path.join(oldProfile, "Default", "Code Cache", "two"), "1234567");
  const syncManager = { activeResourceKeys: new Set(), drains: 0, drain() { this.drains += 1; } };
  const profileMaintenance = new ProfileMaintenance({ profilesRoot, isRunning: async () => false,
    idleTikTok: async (_profile, operation) => operation(), ...overrides });
  const state = { linkedAccounts: [{ id: "my-x-login", platformId: "x", label: "我的 X", profileDirectory: linkedProfile }], customPlatforms: [] };
  const manual = new ManualCacheMaintenance({ profilesRoot, loadState: async () => structuredClone(state), syncManager, profileMaintenance });
  try { await callback({ temporaryRoot, profilesRoot, linkedProfile, oldProfile, syncManager, profileMaintenance, state, manual }); }
  finally { await rm(temporaryRoot, { recursive: true, force: true }); }
}

test("manual cache inventory includes ordinary unlinked profiles, previews counts and preserves all protected files", async () => {
  await fixture(async ({ temporaryRoot, linkedProfile, oldProfile, manual, syncManager }) => {
    const protectedFiles = [
      path.join(linkedProfile, "Default", "Network", "Cookies"),
      path.join(linkedProfile, "Default", "Local Storage", "leveldb", "login"),
      path.join(oldProfile, "Default", "IndexedDB", "login"),
      path.join(oldProfile, "Default", "Service Worker", "CacheStorage", "session"),
      path.join(temporaryRoot, "state.json"), path.join(temporaryRoot, "sync-index.json"),
      path.join(temporaryRoot, "person", "Index", "index.json"), path.join(temporaryRoot, "person", "Image", "image.jpg"),
    ];
    for (const target of protectedFiles) await put(target, "keep this");
    const preview = await manual.preview();
    assert.equal(preview.status, "ready");
    assert.equal(preview.totalBytes, 12);
    assert.equal(preview.totalFiles, 2);
    assert.equal(preview.profiles.length, 2);
    assert.equal(preview.profiles.find((entry) => entry.platformId === "x").accountLabel, "我的 X");
    assert.equal(preview.profiles.find((entry) => entry.platformId === "instagram").linked, false);
    assert.ok(!JSON.stringify(preview).includes(temporaryRoot), "server-owned paths must not leak into the public response");
    assert.equal(await readFile(path.join(linkedProfile, "Default", "Cache", "one"), "utf8"), "12345");
    assert.equal(syncManager.activeResourceKeys.size, 0);
    const cleaned = await manual.clean({ confirm: true });
    assert.equal(cleaned.status, "cleaned");
    assert.equal(cleaned.removedBytes, 12);
    assert.equal(cleaned.removedFiles, 2);
    assert.equal(cleaned.cleanedProfiles, 2);
    assert.equal(cleaned.skippedProfiles, 0);
    for (const target of protectedFiles) assert.equal(await readFile(target, "utf8"), "keep this");
    assert.equal((await manual.clean({ confirm: true })).status, "empty");
    assert.equal((await manual.preview()).totalBytes, 0);
    assert.equal(syncManager.activeResourceKeys.size, 0);
  });
});

test("manual cleanup requires explicit confirmation and never accepts user-supplied paths", () => {
  for (const body of [undefined, null, [], true, {}, { confirm: "true" }, { confirm: true, path: "C:\\" },
    { confirm: true, profileId: "linked-profile" }, { confirm: false }, { confirm: true, profilesRoot: "outside" }]) {
    assert.throws(() => assertCacheCleanupRequest(body), (error) => error.status === 400);
  }
  assert.doesNotThrow(() => assertCacheCleanupRequest({ confirm: true }));
});

test("active sync, login, verification and auto cleanup locks skip profiles without releasing someone else's keys", async () => {
  for (const resource of ["profile", "login", "maintenance"]) {
    await fixture(async ({ manual, linkedProfile, syncManager, profileMaintenance }) => {
      const key = resource === "login" ? "login:my-x-login" : `profile:${path.resolve(linkedProfile).toLowerCase()}`;
      if (resource === "maintenance") profileMaintenance.busy.add(process.platform === "win32" ? path.resolve(linkedProfile).toLowerCase() : path.resolve(linkedProfile));
      else syncManager.activeResourceKeys.add(key);
      const preview = await manual.preview();
      assert.equal(preview.profiles.find((entry) => entry.platformId === "x").reason, "profile-busy");
      const cleaned = await manual.clean({ confirm: true });
      assert.equal(cleaned.status, "partial");
      assert.equal(cleaned.skippedProfiles, 1);
      assert.equal(cleaned.removedFiles, 1);
      assert.equal(await readFile(path.join(linkedProfile, "Default", "Cache", "one"), "utf8"), "12345");
      if (resource === "maintenance") assert.equal(profileMaintenance.busy.size, 1);
      else assert.ok(syncManager.activeResourceKeys.has(key));
    });
  }
});

test("running or uninspectable browsers are skipped; no arbitrary browser is closed", async () => {
  for (const isRunning of [async () => true, async () => { throw Object.assign(new Error("process query denied"), { code: "EACCES" }); }]) {
    await fixture(async ({ manual, linkedProfile }) => {
      const preview = await manual.preview();
      assert.equal(preview.status, "partial");
      assert.equal(preview.skippedProfiles, 2);
      const cleaned = await manual.clean({ confirm: true });
      assert.equal(cleaned.removedFiles, 0);
      assert.equal(cleaned.skippedProfiles, 2);
      assert.equal(await readFile(path.join(linkedProfile, "Default", "Cache", "one"), "utf8"), "12345");
    }, { isRunning });
  }
});

test("all idle profiles are reserved before an async clean, duplicate requests rejected, and locks released on completion", async () => {
  let ready, release;
  const entered = new Promise((resolve) => { ready = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ manual, linkedProfile, oldProfile, syncManager, profileMaintenance }) => {
    const first = manual.clean({ confirm: true });
    await entered;
    for (const profile of [linkedProfile, oldProfile]) assert.ok(syncManager.activeResourceKeys.has(`profile:${path.resolve(profile).toLowerCase()}`));
    assert.ok(syncManager.activeResourceKeys.has("login:my-x-login"));
    await assert.rejects(manual.clean({ confirm: true }), (error) => error.status === 409);
    await assert.rejects(manual.preview(), (error) => error.status === 409);
    await assert.rejects(profileMaintenance.withProfileUse(oldProfile, async () => {}), (error) => error.status === 409);
    // SyncManager.canRun uses these same keys: a new job must remain queued.
    assert.equal([`profile:${path.resolve(linkedProfile).toLowerCase()}`].every((key) => !syncManager.activeResourceKeys.has(key)), false);
    release();
    await first;
    assert.equal(syncManager.activeResourceKeys.size, 0);
    assert.equal(profileMaintenance.busy.size, 0);
    assert.equal(manual.cleaning, false);
  }, { clean: async () => { ready(); await wait; return { status: "empty" }; } });
});

test("failed or unreadable inventory reports an error instead of declaring an empty cache", async () => {
  await fixture(async ({ manual, syncManager }) => {
    manual.listProfiles = async (_root, { onError }) => { onError({ code: "EACCES", message: "private path denied" }); return []; };
    const preview = await manual.preview();
    assert.equal(preview.status, "partial");
    assert.equal(preview.errors[0].code, "EACCES");
    const cleaned = await manual.clean({ confirm: true });
    assert.equal(cleaned.status, "partial");
    assert.equal(cleaned.removedFiles, 0);
    manual.listProfiles = async () => { throw new Error("inventory unavailable"); };
    await assert.rejects(manual.clean({ confirm: true }), /inventory unavailable/);
    assert.equal(manual.cleaning, false);
    assert.equal(syncManager.activeResourceKeys.size, 0);
  });
});

test("linked and unlinked junctions are not followed; unsafe cache candidates and all outside data survive", async () => {
  await fixture(async ({ temporaryRoot, profilesRoot, linkedProfile, oldProfile, manual, state }) => {
    const outside = path.join(temporaryRoot, "outside");
    await put(path.join(outside, "Default", "Cache", "important"), "must survive");
    const type = process.platform === "win32" ? "junction" : "dir";
    const linkedJunction = path.join(profilesRoot, "x", "linked-junction");
    await symlink(outside, linkedJunction, type);
    state.linkedAccounts.push({ id: "bad-login", platformId: "x", label: "linked junction", profileDirectory: linkedJunction });
    await symlink(outside, path.join(profilesRoot, "instagram", "unlinked-junction"), type);
    await symlink(outside, path.join(linkedProfile, "Default", "Cache", "nested-junction"), type);
    const preview = await manual.preview();
    assert.equal(preview.status, "partial");
    assert.equal(preview.profiles.find((entry) => entry.profileId === "linked-junction").reason, "unsafe-profile");
    const cleaned = await manual.clean({ confirm: true });
    assert.equal(cleaned.status, "partial");
    assert.equal(cleaned.removedFiles, 1);
    assert.equal(await readFile(path.join(linkedProfile, "Default", "Cache", "one"), "utf8"), "12345");
    assert.equal(await readFile(path.join(outside, "Default", "Cache", "important"), "utf8"), "must survive");
    assert.equal((await lstat(linkedJunction)).isSymbolicLink(), true);
    await assert.rejects(lstat(path.join(oldProfile, "Default", "Code Cache", "two")), { code: "ENOENT" });
  });
});

test("owned idle TikTok cleanup uses existing idleness callback, while preview never retires a worker", async () => {
  const calls = [];
  await fixture(async ({ profilesRoot, manual }) => {
    const profile = path.join(profilesRoot, "tiktok", "old-tiktok");
    await put(path.join(profile, "Default", "Cache", "one"), "cache");
    await manual.preview();
    assert.deepEqual(calls, []);
    const cleaned = await manual.clean({ confirm: true });
    assert.equal(cleaned.removedFiles, 3);
    assert.deepEqual(calls, [profile]);
  }, { idleTikTok: async (profile, operation) => { calls.push(profile); return operation(); } });
});

test("local cache preview and deletion do not call external network or AI services", async (context) => {
  const network = context.mock.method(globalThis, "fetch", () => { throw new Error("unexpected external request"); });
  await fixture(async ({ manual }) => {
    assert.equal((await manual.preview()).totalFiles, 2);
    assert.equal((await manual.clean({ confirm: true })).removedFiles, 2);
    assert.equal(network.mock.callCount(), 0);
  });
});

test("outside, malformed or platform-mismatched configured profiles are unsafe, not reported as merely missing", async () => {
  await fixture(async ({ temporaryRoot, profilesRoot, linkedProfile, state, manual }) => {
    const outside = path.join(temporaryRoot, "outside", "profile");
    await put(path.join(outside, "Default", "Cache", "important"), "keep");
    state.linkedAccounts.push({ id: "outside", platformId: "x", label: "outside", profileDirectory: outside });
    state.linkedAccounts.push({ id: "bad-shape", platformId: "x", label: "bad shape", profileDirectory: path.join(profilesRoot, "x", "nested", "profile") });
    state.linkedAccounts.push({ id: "missing", platformId: "x", label: "missing", profileDirectory: path.join(profilesRoot, "x", "not-yet-created") });
    const preview = await manual.preview();
    assert.equal(preview.profiles.find((entry) => entry.accountLabel === "outside").reason, "unsafe-profile");
    assert.equal(preview.profiles.find((entry) => entry.accountLabel === "bad shape").reason, "unsafe-profile");
    assert.equal(preview.profiles.find((entry) => entry.accountLabel === "missing").reason, "profile-missing");
    state.linkedAccounts[0].platformId = "instagram";
    assert.equal((await manual.preview()).profiles.find((entry) => entry.profileId === "linked-profile").reason, "unsafe-profile");
    assert.equal((await manual.clean({ confirm: true })).removedFiles, 1);
    assert.equal(await readFile(path.join(linkedProfile, "Default", "Cache", "one"), "utf8"), "12345");
    assert.equal(await readFile(path.join(outside, "Default", "Cache", "important"), "utf8"), "keep");
  });
});

test("historical profile preview provides opaque selection IDs and whole-profile counts without deleting login data", async () => {
  await fixture(async ({ manual, oldProfile }) => {
    const cookies = path.join(oldProfile, "Default", "Network", "Cookies");
    await put(cookies, "old-login");
    const first = await manual.preview(), second = await manual.preview();
    const linked = first.profiles.find((entry) => entry.linked);
    const old = first.profiles.find((entry) => !entry.linked);
    assert.equal(linked.removalId, null);
    assert.equal(linked.removable, false);
    assert.equal(old.removable, true);
    assert.match(old.removalId, /^[0-9a-f-]{36}$/);
    assert.equal(old.removalId, second.profiles.find((entry) => !entry.linked).removalId);
    assert.equal(old.profileBytes, 16);
    assert.equal(old.profileFiles, 2);
    assert.match(old.removalWarning, /Cookies.*不可恢复/);
    assert.equal(old.bytes, 7);
    assert.equal(old.files, 1);
    assert.equal(await readFile(cookies, "utf8"), "old-login");
  });
});

test("historical profile deletion requires explicit valid selected IDs and never accepts caller paths", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  for (const body of [null, {}, [], { confirm: false, profileIds: [id] }, { confirm: true, profileIds: [] },
    { confirm: "true", profileIds: [id] }, { confirm: true, profileIds: ["old-profile"] },
    { confirm: true, profileIds: ["../outside"] }, { confirm: true, profileIds: [id, id] },
    { confirm: true, profileIds: [id], path: "C:\\" }, { confirm: true, profileIds: [id], profilesRoot: "outside" }]) {
    assert.throws(() => assertProfileRemovalRequest(body), (error) => error.status === 400);
  }
  assert.doesNotThrow(() => assertProfileRemovalRequest({ confirm: true, profileIds: [id] }));
});

test("selected unlinked historical directory is permanently removed, while current login/media/index and unselected history remain", async () => {
  await fixture(async ({ temporaryRoot, profilesRoot, oldProfile, linkedProfile, manual, syncManager }) => {
    const currentCookie = path.join(linkedProfile, "Default", "Network", "Cookies");
    const currentIndex = path.join(temporaryRoot, "person", "Index", "index.json");
    const media = path.join(temporaryRoot, "person", "Video", "video.mp4");
    const stateFile = path.join(temporaryRoot, "state.json");
    const oldCookie = path.join(oldProfile, "Default", "Network", "Cookies");
    const unselected = path.join(profilesRoot, "facebook", "unselected");
    for (const target of [currentCookie, currentIndex, media, stateFile]) await put(target, "must remain");
    await put(oldCookie, "delete old login");
    await put(path.join(oldProfile, "Default", "IndexedDB", "session"), "old");
    await put(path.join(unselected, "Default", "Cookies"), "unselected login");
    const preview = await manual.preview();
    const selected = preview.profiles.find((entry) => entry.profileId === "old-profile");
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [selected.removalId] });
    assert.equal(report.status, "removed");
    assert.equal(report.removedProfiles, 1);
    assert.equal(report.removedFiles, 3);
    assert.equal(report.removedBytes, 26);
    await assert.rejects(lstat(oldProfile), { code: "ENOENT" });
    assert.equal(await readFile(path.join(unselected, "Default", "Cookies"), "utf8"), "unselected login");
    for (const target of [currentCookie, currentIndex, media, stateFile]) assert.equal(await readFile(target, "utf8"), "must remain");
    assert.equal(syncManager.activeResourceKeys.size, 0);
    assert.equal(manual.cleaning, false);
    assert.ok(!(await manual.preview()).profiles.some((entry) => entry.profileId === "old-profile"));
    await assert.rejects(manual.removeUnlinkedProfiles({ confirm: true, profileIds: [selected.removalId] }), (error) => error.status === 409);
  });
});

test("stale preview IDs cannot remove a profile that is now linked", async () => {
  await fixture(async ({ manual, state, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    state.linkedAccounts.push({ id: "now-linked", platformId: "instagram", label: "Current account", profileDirectory: oldProfile });
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(report.removedFiles, 0);
    assert.equal(report.skippedProfiles, 1);
    assert.equal(report.profiles[0].reason, "linked-profile");
    assert.equal(report.profiles[0].removalId, old.removalId);
    assert.equal(report.profiles[0].linked, true);
    assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("unknown selection IDs reject the entire deletion request before any selected directory is removed", async () => {
  await fixture(async ({ manual, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    await assert.rejects(manual.removeUnlinkedProfiles({ confirm: true,
      profileIds: [old.removalId, "12345678-1234-4123-8123-123456789abc"] }), (error) => error.status === 409);
    assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("historical profiles are not removed when browser/leases/scheduler/maintenance indicate current use", async () => {
  for (const busy of ["browser", "scheduler", "maintenance", "inspection-failed"]) {
    await fixture(async ({ manual, oldProfile, syncManager, profileMaintenance }) => {
      const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
      if (busy === "browser") profileMaintenance.isRunning = async () => true;
      if (busy === "inspection-failed") profileMaintenance.isRunning = async () => { throw new Error("process query denied"); };
      if (busy === "scheduler") syncManager.activeResourceKeys.add("profile:" + path.resolve(oldProfile).toLowerCase());
      if (busy === "maintenance") profileMaintenance.busy.add(process.platform === "win32" ? oldProfile.toLowerCase() : oldProfile);
      const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
      assert.equal(report.removedFiles, 0);
      assert.equal(report.skippedProfiles, 1);
      assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
    });
  }
});

test("whole historical profile deletion rejects nested links even outside the eight cache directories", async () => {
  await fixture(async ({ temporaryRoot, manual, oldProfile }) => {
    const outside = path.join(temporaryRoot, "outside");
    await put(path.join(outside, "important"), "must remain");
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    await symlink(outside, path.join(oldProfile, "Default", "External"), process.platform === "win32" ? "junction" : "dir");
    const fresh = (await manual.preview()).profiles.find((entry) => !entry.linked);
    assert.equal(fresh.removable, false);
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "unsafe-profile");
    assert.equal(await readFile(path.join(outside, "important"), "utf8"), "must remain");
    assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("deletion rechecks the latest bindings after inspecting the whole selected directory", async () => {
  await fixture(async ({ manual, state, oldProfile, profileMaintenance }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    let checks = 0;
    profileMaintenance.isRunning = async () => {
      checks++;
      if (checks === 2) state.linkedAccounts.push({ id: "just-linked", platformId: "instagram", profileDirectory: oldProfile });
      return false;
    };
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(checks, 2);
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "linked-profile");
    assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("recreated same-name profile cannot inherit the old scan ID", async () => {
  await fixture(async ({ temporaryRoot, manual, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    const preserved = path.join(temporaryRoot, "preserved-old-profile");
    await rename(oldProfile, preserved);
    await put(path.join(oldProfile, "Default", "Cookies"), "new profile identity");
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "profile-changed");
    assert.equal(report.profiles[0].removalId, old.removalId);
    assert.equal(await readFile(path.join(oldProfile, "Default", "Cookies"), "utf8"), "new profile identity");
    assert.equal(await readFile(path.join(preserved, "Default", "Code Cache", "two"), "utf8"), "1234567");
    const fresh = (await manual.preview()).profiles.find((entry) => !entry.linked);
    assert.notEqual(fresh.removalId, old.removalId);
    assert.equal(fresh.removable, true);
  });
});

test("profile identity changes detected by preview issue a fresh selection nonce", async () => {
  await fixture(async ({ temporaryRoot, manual, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    await rename(oldProfile, path.join(temporaryRoot, "preserved-profile"));
    await put(path.join(oldProfile, "Default", "Cookies"), "new login");
    const fresh = (await manual.preview()).profiles.find((entry) => !entry.linked);
    assert.notEqual(fresh.removalId, old.removalId);
    await assert.rejects(manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] }), (error) => error.status === 409);
    assert.equal(await readFile(path.join(oldProfile, "Default", "Cookies"), "utf8"), "new login");
  });
});

test("an isolation-directory junction prevents deletion and cannot expose outside files", async () => {
  await fixture(async ({ temporaryRoot, manual, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    const outside = path.join(temporaryRoot, "outside");
    await put(path.join(outside, "important"), "keep");
    await symlink(outside, path.join(temporaryRoot, "browser-profile-removals"), process.platform === "win32" ? "junction" : "dir");
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "unsafe-profile");
    assert.equal(await readFile(path.join(outside, "important"), "utf8"), "keep");
    assert.equal(await readFile(path.join(oldProfile, "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("a platform replaced by a junction during final checks is rejected before moving any profile", async () => {
  await fixture(async ({ temporaryRoot, manual, oldProfile, profileMaintenance }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    const platform = path.dirname(oldProfile), preserved = path.join(temporaryRoot, "preserved-platform");
    const outside = path.join(temporaryRoot, "outside");
    await put(path.join(outside, path.basename(oldProfile), "important"), "outside must remain");
    let checks = 0;
    profileMaintenance.isRunning = async () => {
      if (++checks === 2) {
        await rename(platform, preserved);
        await symlink(outside, platform, process.platform === "win32" ? "junction" : "dir");
      }
      return false;
    };
    const report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "unsafe-profile");
    assert.equal(await readFile(path.join(outside, path.basename(oldProfile), "important"), "utf8"), "outside must remain");
    assert.equal(await readFile(path.join(preserved, path.basename(oldProfile), "Default", "Code Cache", "two"), "utf8"), "1234567");
  });
});

test("failed permanent deletion retains the isolated remaining files and reports their exact location", async (t) => {
  await fixture(async ({ temporaryRoot, manual, oldProfile }) => {
    const old = (await manual.preview()).profiles.find((entry) => !entry.linked);
    const quarantine = path.join(temporaryRoot, "browser-profile-removals");
    const originalUnlink = fs.unlink;
    t.mock.method(fs, "unlink", async (target) => {
      if (path.resolve(target).startsWith(quarantine + path.sep) && path.basename(target) !== "removal.json") {
        throw Object.assign(new Error("fixture locked file"), { code: "EACCES" });
      }
      return originalUnlink(target);
    });
    let report;
    try {
      syncBuiltinESMExports();
      report = await manual.removeUnlinkedProfiles({ confirm: true, profileIds: [old.removalId] });
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(report.status, "partial");
    assert.equal(report.removedProfiles, 0);
    assert.equal(report.removedFiles, 0);
    assert.equal(report.profiles[0].reason, "removal-incomplete");
    const remaining = report.profiles[0].remainingPath;
    assert.ok(path.resolve(remaining).startsWith(quarantine + path.sep));
    assert.equal(await readFile(path.join(remaining, "profile", "Default", "Code Cache", "two"), "utf8"), "1234567");
    const record = JSON.parse(await readFile(path.join(remaining, "removal.json"), "utf8"));
    assert.equal(record.originalProfileDirectory, oldProfile);
    await assert.rejects(lstat(oldProfile), { code: "ENOENT" });
    assert.equal((await readdir(quarantine)).length, 1);
  });
});
