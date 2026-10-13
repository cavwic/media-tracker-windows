import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolvePortableDataDirectory, hydrateProfilePaths, serializeProfilePaths,
  assertPortableProfilePaths, resolveSourcePython, PortablePathError } from "../lib/portable-paths.mjs";

const root = path.resolve("portable-fixture");
const dataDirectory = path.join(root, "data");
const id = "11111111-2222-4333-8444-555555555555";
const profile = `browser-profiles/instagram/${id}`;
const state = { version: 4, settings: { theme: "dark" }, linkedAccounts: [{ id, platformId: "instagram",
  profileDirectory: profile, loginStatus: "verified", loginCheckedAt: "2026-10-08T00:00:00Z" }],
  persons: [{ id: "person", rootPath: "\\\\EXAMPLE-NAS\\FileShare\\Material\\People\\Person" }],
  customPlatforms: [{ id: "custom-demo" }] };

test("portable data stays beside the package rather than a stale data environment override", () => {
  assert.deepEqual(resolvePortableDataDirectory(path.join(root, "app"), {
    MEDIA_TRACKER_PORTABLE_ROOT: root, MEDIA_TRACKER_DATA_DIR: path.resolve("old-private-data"),
  }), { portable: true, portableRoot: root, dataDirectory });
  assert.throws(() => resolvePortableDataDirectory(root, { MEDIA_TRACKER_PORTABLE_ROOT: "relative" }), PortablePathError);
  assert.equal(resolvePortableDataDirectory(root, {}).dataDirectory, dataDirectory);
  assert.equal(resolvePortableDataDirectory(root, { MEDIA_TRACKER_DATA_DIR: "other" }).portable, false);
});

test("relative login paths survive relocation without changing login results or NAS paths", () => {
  const loaded = hydrateProfilePaths(state, { dataDirectory, portable: true });
  assert.equal(loaded.linkedAccounts[0].profileDirectory, path.join(dataDirectory, "browser-profiles", "instagram", id));
  assert.equal(loaded.linkedAccounts[0].loginStatus, "verified");
  assert.deepEqual(loaded.persons, state.persons);
  const saved = serializeProfilePaths(loaded, { dataDirectory, portable: true });
  assert.deepEqual(saved, state);
  assert.equal(loaded.linkedAccounts[0].profileDirectory, path.join(dataDirectory, "browser-profiles", "instagram", id));
  const movedData = path.resolve("moved-package", "data");
  assert.equal(hydrateProfilePaths(saved, { dataDirectory: movedData, portable: true }).linkedAccounts[0].profileDirectory,
    path.join(movedData, "browser-profiles", "instagram", id));
});

test("portable mode accepts legacy absolute profiles only within its current platform directory", () => {
  const absolute = { ...state, linkedAccounts: [{ ...state.linkedAccounts[0],
    profileDirectory: path.join(dataDirectory, "browser-profiles", "instagram", id) }] };
  assert.equal(serializeProfilePaths(absolute, { dataDirectory, portable: true }).linkedAccounts[0].profileDirectory, profile);
  absolute.linkedAccounts[0].profileDirectory = path.resolve("previous-package", "data", "browser-profiles", "instagram", id);
  assert.throws(() => hydrateProfilePaths(absolute, { dataDirectory, portable: true }), PortablePathError);
  assert.strictEqual(hydrateProfilePaths(absolute, { dataDirectory, portable: false }), absolute);
  assert.strictEqual(serializeProfilePaths(absolute, { dataDirectory, portable: false }), absolute);
});

test("portable profiles reject traversal, drive-relative, external, ADS, and platform mismatch paths", () => {
  for (const invalid of ["../browser-profiles/instagram/abc", "browser-profiles/instagram/../abc", "browser-profiles//abc",
    "browser-profiles/x/abc", "browser-profiles/instagram/.", "C:browser-profiles/instagram/abc",
    "browser-profiles/instagram/abc:secret", "\\\\server\\share\\browser-profiles\\instagram\\abc",
    "browser-profiles/instagram/abc/extra", "browser-profiles/instagram/abc\0secret",
    "browser-profiles/instagram/CON", "browser-profiles/instagram/COM1", "", null]) {
    const fixture = { ...state, linkedAccounts: [{ ...state.linkedAccounts[0], profileDirectory: invalid }] };
    assert.throws(() => hydrateProfilePaths(fixture, { dataDirectory, portable: true }), PortablePathError, String(invalid));
    assert.throws(() => serializeProfilePaths(fixture, { dataDirectory, portable: true }), PortablePathError, String(invalid));
  }
  const windowsRelative = { ...state, linkedAccounts: [{ ...state.linkedAccounts[0], profileDirectory: profile.replaceAll("/", "\\") }] };
  assert.equal(serializeProfilePaths(windowsRelative, { dataDirectory, portable: true }).linkedAccounts[0].profileDirectory, profile);
});

test("physical profile checks accept valid and not-yet-created directories but reject junctions and files", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "media-tracker-portable-paths-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const data = path.join(fixture, "data");
  await mkdir(data);
  const options = { dataDirectory: data, portable: true };
  await assertPortableProfilePaths(state, options);
  const parent = path.join(data, "browser-profiles", "instagram");
  await mkdir(parent, { recursive: true });
  await mkdir(path.join(parent, id));
  await assertPortableProfilePaths(state, options);
  await rm(path.join(parent, id), { recursive: true });
  await writeFile(path.join(parent, id), "not a directory");
  await assert.rejects(assertPortableProfilePaths(state, options), PortablePathError);
  await rm(path.join(parent, id));
  const outside = path.join(fixture, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(parent, id), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertPortableProfilePaths(state, options), PortablePathError);
});

test("Python has an explicit absolute portable runtime override while legacy fallback remains unchanged", () => {
  const bundled = path.join(root, "runtime", "python", "python.exe");
  assert.equal(resolveSourcePython(path.join(root, "app"), { MEDIA_TRACKER_SOURCE_PYTHON: bundled }), bundled);
  assert.throws(() => resolveSourcePython(root, { MEDIA_TRACKER_SOURCE_PYTHON: "python.exe" }), PortablePathError);
  assert.equal(resolveSourcePython(root, {}), path.join(root, ".runtime", "sources-python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
});
