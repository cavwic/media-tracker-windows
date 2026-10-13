import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlatforms, PLATFORMS } from "../lib/archive.mjs";

test("legacy and newly added target accounts default to enabled sync", () => {
  for (const syncEnabled of [undefined, null, true, 0, "false"]) {
    const [platform] = normalizePlatforms([{ id: "x", accounts: [{ id: "target", label: "creator", syncEnabled }] }]);
    assert.equal(platform.accounts[0].syncEnabled, true);
  }
});

test("pausing and resuming preserve target identity, login binding and collection policy", () => {
  const original = { id: "target", label: "creator", folderName: "old-account", profileUrl: "https://x.com/creator",
    linkedAccountId: "saved-login", syncEnabled: false, followRequested: true,
    downloadMedia: { image: true, video: false, gif: false }, discoveredFrom: "https://creator.example/", discoveryEvidence: "direct profile link" };
  const normalized = normalizePlatforms([{ id: "x", accounts: [original] }]);
  assert.deepEqual(normalized[0].accounts[0], original);
  assert.deepEqual(normalizePlatforms(JSON.parse(JSON.stringify(normalized))), normalized);
  const resumed = normalizePlatforms([{ ...normalized[0], accounts: [{ ...original, syncEnabled: true }] }]);
  assert.deepEqual(resumed[0].accounts[0], { ...original, syncEnabled: true });
});

test("custom platforms preserve paused accounts without dropping them", () => {
  const registry = { ...PLATFORMS, sample: { label: "Sample", custom: true, folderName: "Sample" } };
  const [platform] = normalizePlatforms([{ id: "sample", accounts: [{ id: "custom", label: "author", syncEnabled: false }] }], registry);
  assert.equal(platform.accounts.length, 1);
  assert.equal(platform.accounts[0].syncEnabled, false);
  assert.equal(platform.accounts[0].id, "custom");
  assert.equal(platform.folderName, "Sample");
});
