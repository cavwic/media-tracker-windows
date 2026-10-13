import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createCustomPlatform, updateCustomPlatform, normalizeCustomPlatforms,
  getPlatformRegistry, normalizeCustomUrl, validateTargetUrl, assertCustomPublicUrl } from "../lib/platform-registry.mjs";
import { normalizePlatforms, requiredDirectories } from "../lib/archive.mjs";

const make = (fields = {}) => createCustomPlatform({ label: "示例平台", homepageUrl: "https://example.com/", ...fields });

test("custom catalog preserves builtin identity and legacy folder metadata without account directories", () => {
  const before = make();
  const after = updateCustomPlatform(before, { label: "显示新名称", id: "evil", folderName: "evil" }, [before]);
  assert.equal(after.id, before.id);
  assert.equal(after.folderName, before.folderName);
  const registry = getPlatformRegistry([after]);
  assert.equal(registry.x.label, "X");
  assert.equal(Object.getPrototypeOf(registry), null);
  const platforms = normalizePlatforms([{ id: before.id, accounts: [{ label: "someone" }] }], registry);
  assert.equal(platforms[0].label, "显示新名称");
  assert.deepEqual(requiredDirectories("archive", platforms), [path.join("archive", "Index")]);
  assert.throws(() => normalizePlatforms([{ id: "__proto__", accounts: [{ label: "someone" }] }], registry));
});

test("custom definitions reject duplicate names, invalid ids, directories and engines", () => {
  const platform = make();
  for (const fields of [{ label: "X" }, { label: "Instagram" }, { label: "../evil" }, { label: "con" }, { engine: "powershell" }]) {
    assert.throws(() => make(fields));
  }
  assert.throws(() => createCustomPlatform({ label: "示例平台", homepageUrl: "other.example.com" }, [platform]));
  assert.throws(() => normalizeCustomPlatforms([{ ...platform, id: "__proto__" }]));
  assert.throws(() => normalizeCustomPlatforms([{ ...platform, folderName: "../elsewhere" }]));
  assert.throws(() => normalizeCustomPlatforms([platform, platform]));
  assert.throws(() => normalizeCustomPlatforms(Array(101).fill(platform)));
});

test("custom target URL requires the configured site, with only www alias accepted", () => {
  const platform = make();
  assert.equal(normalizeCustomUrl("example.com/u#fragment"), "https://example.com/u");
  assert.equal(validateTargetUrl(platform, "www.example.com/u"), "https://www.example.com/u");
  for (const url of ["evil.example.com/u", "example.com.evil.net", "https://user:pass@example.com/", "http://example.com", "https://example.com:8443", "https://127.0.0.1", "https://[::1]", "file:///c:/test", "https://foo.local", "https://localhost", "https://example.com."]) {
    assert.throws(() => validateTargetUrl(platform, url), url);
  }
  assert.throws(() => make({ loginUrl: "https://accounts.other.com/" }));
  assert.throws(() => updateCustomPlatform(platform, { homepageUrl: "https://other.com/" }, [platform]));
});

test("login markers are data, must be specific, and cannot be script configuration", () => {
  assert.equal(make({ loginMarker: "[data-testid='account-menu']", logoutMarker: "#login" }).logoutMarker, "#login");
  for (const loginMarker of ["body", "*", "html", "body[data-theme]", "html:not(#never)", "#menu, body.light", "body > #menu", "#menu\n#other", "x".repeat(501)]) assert.throws(() => make({ loginMarker }));
});

test("optional following page preserves login metadata and only accepts the configured public HTTPS site", () => {
  const before = make({ loginUrl: "https://example.com/login", verificationUrl: "https://example.com/account",
    loginMarker: "#account-menu", logoutMarker: "#sign-in" });
  assert.equal(before.followingUrl, "");
  const after = updateCustomPlatform(before, { followingUrl: "https://www.example.com/following" }, [before]);
  assert.equal(after.followingUrl, "https://www.example.com/following");
  for (const field of ["id", "folderName", "homepageUrl", "loginUrl", "verificationUrl", "loginMarker", "logoutMarker", "engine"]) {
    assert.equal(after[field], before[field], field);
  }
  assert.equal(updateCustomPlatform(after, { followingUrl: "" }, [after]).followingUrl, "");
  for (const followingUrl of ["https://other.example/following", "http://example.com/following", "https://127.0.0.1/following",
    "https://user:secret@example.com/following", "https://example.com:8443/following"]) {
    assert.throws(() => make({ followingUrl }), followingUrl);
  }
  const legacy = { ...before };
  delete legacy.followingUrl;
  assert.equal(normalizeCustomPlatforms([legacy])[0].followingUrl, "");
});

test("custom network check rejects private and mixed DNS answers without fetching", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(assertCustomPublicUrl("https://example.com", async () => [{ address }]), /拒绝/);
  }
  await assert.rejects(assertCustomPublicUrl("https://example.com", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }]), /拒绝/);
  await assert.rejects(assertCustomPublicUrl("https://example.com", async () => []), /拒绝/);
  assert.equal(await assertCustomPublicUrl("https://example.com", async () => [{ address: "8.8.8.8" }]), "https://example.com/");
});
