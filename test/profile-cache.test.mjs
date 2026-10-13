import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from "node:fs/promises";
import { CACHE_DIRECTORY_PARTS, clearProfileCache, inspectProfileCache, listProfileDirectories } from "../lib/profile-cache.mjs";

async function fixture(callback) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "media-tracker-cache-test-"));
  const profilesRoot = path.join(sandbox, "browser-profiles");
  const profilePath = path.join(profilesRoot, "x", "account-id");
  await mkdir(profilePath, { recursive: true });
  try {
    await callback({ sandbox, profilesRoot, profilePath });
  } finally {
    // This exact directory was created by this test, never a production profile.
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function put(target, content = "keep") {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("custom platform cache uses the same narrow whitelist and rejects malformed platform directories", async () => {
  await fixture(async ({ profilesRoot }) => {
    const platformId = "custom-12345678-1234-4123-8123-123456789abc";
    const profilePath = path.join(profilesRoot, platformId, "account-id");
    await put(path.join(profilePath, "Default", "Cache", "item"), "cache");
    await put(path.join(profilePath, "Default", "Network", "Cookies"), "login");
    const listed = await listProfileDirectories(profilesRoot);
    assert.ok(listed.includes(profilePath));
    const cleaned = await clearProfileCache({ profilesRoot, profilePath });
    assert.equal(cleaned.status, "cleaned");
    assert.equal(await readFile(path.join(profilePath, "Default", "Network", "Cookies"), "utf8"), "login");
    const invalid = path.join(profilesRoot, "custom-anything", "account-id");
    await put(path.join(invalid, "Default", "Cache", "item"), "keep");
    assert.equal((await clearProfileCache({ profilesRoot, profilePath: invalid })).status, "skipped");
  });
});

test("profile cleanup removes only the eight ordinary caches and preserves login/index/media data", async () => {
  await fixture(async (options) => {
    const { sandbox, profilePath } = options;
    for (const parts of CACHE_DIRECTORY_PARTS) await put(path.join(profilePath, ...parts, "nested", "cached"), "cache");
    const protectedPaths = [
      "Default/Network/Cookies", "Default/Cookies", "Default/Cookies-journal",
      "Default/Local Storage/leveldb/000001.log", "Default/IndexedDB/site/data",
      "Default/Session Storage/data", "Default/Service Worker/CacheStorage/site/cache",
      "Default/Preferences", "Default/Secure Preferences", "Default/Login Data",
      "Local State", "Default/CacheBackup/cache", "Default/Downloads/video.mp4",
    ].map((name) => path.join(profilePath, ...name.split("/")));
    protectedPaths.push(path.join(sandbox, "state.json"), path.join(sandbox, "sync-index.json"));
    for (const target of protectedPaths) await put(target);
    const result = await clearProfileCache(options);
    assert.equal(result.status, "cleaned");
    assert.equal(result.removedBytes, 40);
    assert.equal(result.removedFiles, 8);
    assert.equal(result.removedDirectories, 16);
    assert.deepEqual(result.errors, []);
    for (const target of protectedPaths) assert.equal(await readFile(target, "utf8"), "keep");
    for (const parts of CACHE_DIRECTORY_PARTS) await assert.rejects(lstat(path.join(profilePath, ...parts)), { code: "ENOENT" });
    assert.equal((await clearProfileCache(options)).status, "empty");
  });
});

test("profile cleanup rejects root/platform/default/outside targets and malformed roots", async () => {
  await fixture(async ({ sandbox, profilesRoot, profilePath }) => {
    const cache = path.join(profilePath, "Default", "Cache", "data");
    await put(cache);
    const targets = [profilesRoot, path.join(profilesRoot, "x"), path.join(profilePath, "Default"), sandbox,
      path.join(profilesRoot, "unknown", "account-id"), path.join(profilesRoot, "x", "..", "account-id")];
    for (const target of targets) {
      const result = await clearProfileCache({ profilesRoot, profilePath: target });
      assert.equal(result.status, "skipped", target);
      assert.equal(result.removedFiles, 0);
      assert.equal(result.errors[0].code, "UNSAFE_CACHE_PATH");
    }
    for (const root of [sandbox, "relative-root", path.parse(sandbox).root, null]) {
      assert.equal((await clearProfileCache({ profilesRoot: root, profilePath })).status, "skipped");
    }
    assert.equal(await readFile(cache, "utf8"), "keep");
  });
});

test("profile cleanup handles missing profiles/caches and wrong cache types without throwing", async () => {
  await fixture(async ({ profilesRoot, profilePath }) => {
    assert.equal((await clearProfileCache({ profilesRoot, profilePath })).status, "empty");
    assert.equal((await clearProfileCache({ profilesRoot, profilePath: path.join(profilesRoot, "x", "missing") })).status, "empty");
    const wrongType = path.join(profilePath, "Default", "Cache");
    await put(wrongType);
    const result = await clearProfileCache({ profilesRoot, profilePath });
    assert.equal(result.status, "skipped");
    assert.equal(result.errors[0].code, "UNSAFE_CACHE_PATH");
    assert.equal(await readFile(wrongType, "utf8"), "keep");
    assert.equal((await clearProfileCache()).status, "skipped");
  });
});

test("profile cleanup preserves an entire cache containing a nested junction", async () => {
  await fixture(async (options) => {
    const { sandbox, profilePath } = options;
    const cache = path.join(profilePath, "Default", "Cache");
    await put(path.join(cache, "ordinary"));
    const outside = path.join(sandbox, "outside");
    await put(path.join(outside, "important"));
    await symlink(outside, path.join(cache, "linked"), process.platform === "win32" ? "junction" : "dir");
    await put(path.join(profilePath, "Default", "Code Cache", "ordinary"), "cache");
    const result = await clearProfileCache(options);
    assert.equal(result.status, "partial");
    assert.equal(result.removedFiles, 1);
    assert.equal(await readFile(path.join(cache, "ordinary"), "utf8"), "keep");
    assert.equal(await readFile(path.join(outside, "important"), "utf8"), "keep");
    assert.equal((await lstat(path.join(cache, "linked"))).isSymbolicLink(), true);
  });
});

test("profile cleanup refuses linked profile, platform, Default and cache directories", async () => {
  await fixture(async ({ sandbox, profilesRoot, profilePath }) => {
    const outside = path.join(sandbox, "outside");
    await put(path.join(outside, "Default", "Cache", "important"));
    const type = process.platform === "win32" ? "junction" : "dir";
    const linkedProfile = path.join(profilesRoot, "x", "linked-profile");
    await symlink(outside, linkedProfile, type);
    assert.equal((await clearProfileCache({ profilesRoot, profilePath: linkedProfile })).status, "skipped");
    await symlink(path.dirname(profilePath), path.join(profilesRoot, "instagram"), type);
    assert.equal((await clearProfileCache({ profilesRoot, profilePath: path.join(profilesRoot, "instagram", "account-id") })).status, "skipped");
    await symlink(path.join(outside, "Default"), path.join(profilePath, "Default"), type);
    assert.equal((await clearProfileCache({ profilesRoot, profilePath })).status, "skipped");
    const second = path.join(profilesRoot, "tiktok", "second");
    await mkdir(path.join(second, "Default"), { recursive: true });
    await symlink(path.join(outside, "Default", "Cache"), path.join(second, "Default", "Cache"), type);
    assert.equal((await clearProfileCache({ profilesRoot, profilePath: second })).status, "skipped");
    assert.equal(await readFile(path.join(outside, "Default", "Cache", "important"), "utf8"), "keep");
  });
});

test("list profiles returns only validated platform/id folders and never follows junctions", async () => {
  await fixture(async ({ sandbox, profilesRoot, profilePath }) => {
    const second = path.join(profilesRoot, "tiktok", "second");
    await mkdir(second, { recursive: true });
    await mkdir(path.join(profilesRoot, "unknown", "not-profile"), { recursive: true });
    await put(path.join(profilesRoot, "x", "ordinary-file"));
    await symlink(profilePath, path.join(profilesRoot, "x", "linked-profile"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(await listProfileDirectories(profilesRoot), [profilePath, second].sort());
    assert.deepEqual(await listProfileDirectories(sandbox), []);
    assert.deepEqual(await listProfileDirectories(path.join(sandbox, "missing", "browser-profiles")), []);
  });
});

test("profile preview counts all safe caches without reading contents or mutating any files", async (context) => {
  await fixture(async (options) => {
    const targets = CACHE_DIRECTORY_PARTS.map((parts) => path.join(options.profilePath, ...parts, "nested", "cache-file"));
    for (const target of targets) await put(target, "cache");
    const login = path.join(options.profilePath, "Default", "Network", "Cookies");
    await put(login, "private login data");
    const guarded = ["readFile", "open", "writeFile", "appendFile", "rename", "copyFile", "mkdir", "rm", "unlink", "rmdir"];
    const spies = guarded.map((name) => context.mock.method(fs, name, () => {
      throw new Error(`Read-only preview must not call ${name}`);
    }));
    let result;
    try {
      syncBuiltinESMExports();
      result = await inspectProfileCache(options);
      for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(result, { status: "ready", bytes: 40, files: 8, directories: 16, errors: [], skipped: [] });
    for (const target of targets) assert.equal(await readFile(target, "utf8"), "cache");
    assert.equal(await readFile(login, "utf8"), "private login data");
  });
});

test("profile preview rejects outside paths and linked parents, profiles and candidates", async () => {
  await fixture(async (options) => {
    const { sandbox, profilesRoot, profilePath } = options;
    const outside = path.join(sandbox, "outside");
    const important = path.join(outside, "Default", "Cache", "important");
    await put(important);
    const type = process.platform === "win32" ? "junction" : "dir";
    for (const invalidPath of [outside, profilesRoot, path.join(profilesRoot, "x"), path.join(profilePath, "Default")]) {
      const result = await inspectProfileCache({ profilesRoot, profilePath: invalidPath });
      assert.equal(result.status, "skipped");
      assert.equal(result.bytes, 0);
      assert.equal(result.errors[0].code, "UNSAFE_CACHE_PATH");
    }
    const linkedProfile = path.join(profilesRoot, "x", "linked-profile");
    await symlink(outside, linkedProfile, type);
    assert.equal((await inspectProfileCache({ profilesRoot, profilePath: linkedProfile })).status, "skipped");
    await symlink(path.dirname(profilePath), path.join(profilesRoot, "instagram"), type);
    assert.equal((await inspectProfileCache({ profilesRoot, profilePath: path.join(profilesRoot, "instagram", "account-id") })).status, "skipped");
    await mkdir(path.join(profilePath, "Default"));
    await symlink(path.dirname(important), path.join(profilePath, "Default", "Cache"), type);
    assert.equal((await inspectProfileCache(options)).status, "skipped");
    assert.equal(await readFile(important, "utf8"), "keep");
  });
});

test("profile preview excludes the entire candidate containing a nested junction, not only its linked child", async () => {
  await fixture(async (options) => {
    const { sandbox, profilePath } = options;
    const cache = path.join(profilePath, "Default", "Cache");
    await put(path.join(cache, "aaa-ordinary"), "excluded");
    const outside = path.join(sandbox, "outside");
    await put(path.join(outside, "important"), "excluded");
    await symlink(outside, path.join(cache, "zzz-linked"), process.platform === "win32" ? "junction" : "dir");
    await put(path.join(profilePath, "Default", "Code Cache", "ordinary"), "valid");
    const result = await inspectProfileCache(options);
    assert.equal(result.status, "ready");
    assert.equal(result.bytes, 5);
    assert.equal(result.files, 1);
    assert.equal(result.directories, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.skipped[0].path, cache);
    assert.equal(await readFile(path.join(cache, "aaa-ordinary"), "utf8"), "excluded");
    assert.equal(await readFile(path.join(outside, "important"), "utf8"), "excluded");
    assert.equal((await lstat(path.join(cache, "zzz-linked"))).isSymbolicLink(), true);
  });
});

test("profile preview reports missing, empty and wrong-type cache directories without changing them", async () => {
  await fixture(async (options) => {
    assert.deepEqual(await inspectProfileCache(options), { status: "empty", bytes: 0, files: 0, directories: 0, errors: [], skipped: [] });
    assert.equal((await inspectProfileCache({ profilesRoot: options.profilesRoot, profilePath: path.join(options.profilesRoot, "x", "missing") })).status, "empty");
    const empty = path.join(options.profilePath, "Default", "Code Cache");
    await mkdir(empty, { recursive: true });
    assert.deepEqual(await inspectProfileCache(options), { status: "ready", bytes: 0, files: 0, directories: 1, errors: [], skipped: [] });
    const wrongType = path.join(options.profilePath, "Default", "Cache");
    await put(wrongType);
    const mixed = await inspectProfileCache(options);
    assert.equal(mixed.status, "ready");
    assert.equal(mixed.directories, 1);
    assert.equal(mixed.files, 0);
    assert.equal(mixed.errors[0].code, "UNSAFE_CACHE_PATH");
    assert.equal(await readFile(wrongType, "utf8"), "keep");
    assert.equal((await lstat(empty)).isDirectory(), true);
    assert.equal((await inspectProfileCache()).status, "skipped");
  });
});
