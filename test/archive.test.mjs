import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  PLATFORMS,
  createArchiveDirectories,
  normalizePlatforms,
  requiredDirectories,
  sanitizeSegment,
} from "../lib/archive.mjs";

test("Instagram, Facebook, and TikTok login windows open their platform home pages", () => {
  assert.equal(PLATFORMS.instagram.loginUrl, "https://www.instagram.com/");
  assert.equal(PLATFORMS.facebook.loginUrl, "https://www.facebook.com/");
  assert.equal(PLATFORMS.tiktok.loginUrl, "https://www.tiktok.com/");
});

test("sanitizeSegment protects Windows paths", () => {
  assert.equal(sanitizeSegment(" 账号:A/B* "), "账号_A_B_");
  assert.equal(sanitizeSegment("CON"), "CON_");
  assert.throws(() => sanitizeSegment("<>:*?"), /不能为空/);
});

test("normalizePlatforms accepts multiple accounts on one platform", () => {
  const platforms = normalizePlatforms([
    {
      id: "x",
      accounts: [
        { id: "a", label: "账号 A", profileUrl: "https://x.com/a" },
        { id: "b", label: "账号 B", profileUrl: "https://x.com/b" },
      ],
    },
  ]);
  assert.equal(platforms[0].label, "X");
  assert.deepEqual(platforms[0].accounts.map((account) => account.folderName), ["账号 A", "账号 B"]);
  assert.deepEqual(platforms[0].accounts[0].downloadMedia, { image: true, video: true, gif: true });
  assert.equal(platforms[0].accounts[0].followRequested, false);
});

test("normalizePlatforms preserves per-account follow and media choices", () => {
  const [platform] = normalizePlatforms([
    {
      id: "instagram",
      accounts: [{
        label: "creator",
        followRequested: true,
        downloadMedia: { image: true, video: false, gif: false },
        discoveredFrom: "https://creator.example/",
      }],
    },
  ]);
  assert.equal(platform.accounts[0].followRequested, true);
  assert.deepEqual(platform.accounts[0].downloadMedia, { image: true, video: false, gif: false });
  assert.equal(platform.accounts[0].discoveredFrom, "https://creator.example/");
});

test("duplicate account identities are rejected case-insensitively", () => {
  assert.throws(() => normalizePlatforms([
    { id: "x", accounts: [{ label: "Account" }, { label: "account" }] },
  ]), /重复/);
});

test("legacy folder names do not determine account identity or media paths", () => {
  const [platform] = normalizePlatforms([{ id: "x", accounts: [
    { id: "a", label: "Account A", folderName: "old", profileUrl: "https://x.com/a" },
    { id: "b", label: "Account B", folderName: "old", profileUrl: "https://x.com/b" },
  ] }]);
  assert.equal(platform.accounts.length, 2);
  assert.deepEqual(requiredDirectories("Person", [platform]), [path.join("Person", "Index")]);
});

test("archive creation creates only Person/Index until media is downloaded", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-"));
  try {
    const personFolder = path.join(temporaryRoot, "人物 M");
    const platforms = normalizePlatforms([
      { id: "x", accounts: [{ label: "A" }, { label: "B" }] },
    ]);
    const expected = requiredDirectories(personFolder, platforms);
    assert.deepEqual(expected, [path.join(personFolder, "Index")]);

    await createArchiveDirectories(personFolder, platforms);
    for (const directory of expected) {
      assert.equal((await stat(directory)).isDirectory(), true);
    }
    for (const folder of ["X", "Image", "Video", "gif"]) {
      await assert.rejects(stat(path.join(personFolder, folder)), { code: "ENOENT" });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
