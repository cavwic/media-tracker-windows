import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm } from "node:fs/promises";
import { resolveBoundPost, assertBoundProfile, validateRecordedPostUrl } from "../lib/bound-post.mjs";
import { syncScopeKey } from "../lib/sync-store.mjs";

const MEDIA_ID = "a".repeat(64);
const UNKNOWN_MEDIA_ID = "b".repeat(64);
const POST = "FIXTURE00001";
const sourceKey = (source) => JSON.stringify([source.platformId, source.accountId, source.logicalKey]);
const postBody = (extra = {}) => ({ platformId: "instagram", accountId: "ig-a", postId: POST, ...extra });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-bound-post-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const data = path.join(root, "data");
  const profilesRoot = path.join(data, "browser-profiles");
  const profiles = { first: path.join(profilesRoot, "instagram", "first"), second: path.join(profilesRoot, "instagram", "second"),
    x: path.join(profilesRoot, "x", "x-session") };
  await Promise.all(Object.values(profiles).map((directory) => mkdir(directory, { recursive: true })));
  const person = { id: "person-a", name: "A", folderPath: path.join(root, "A"), platforms: [
    { id: "instagram", label: "Instagram", accounts: [
      { id: "ig-a", label: "@first", linkedAccountId: "login-first" },
      { id: "ig-b", label: "@second", linkedAccountId: "login-second" },
    ] },
    { id: "x", label: "X", accounts: [{ id: "x-a", label: "@first", linkedAccountId: "login-x" }] },
  ] };
  const other = { id: "person-b", name: "B", folderPath: path.join(root, "B"), platforms: structuredClone(person.platforms) };
  const state = { version: 4, persons: [person, other], linkedAccounts: [
    { id: "login-first", platformId: "instagram", profileDirectory: profiles.first },
    { id: "login-second", platformId: "instagram", profileDirectory: profiles.second },
    { id: "login-x", platformId: "x", profileDirectory: profiles.x },
  ], customPlatforms: [], recentPaths: [], settings: { theme: "dark" } };
  const scopes = {
    [syncScopeKey(person.id, "instagram", "ig-a")]: { pendingPosts: {
      first: { postId: POST, postUrl: `https://www.instagram.com/p/${POST}/`, expectedMediaCount: 3 },
      fallback: { postKey: "fallback", postUrl: "https://www.instagram.com/p/fallback/" },
    }, media: { downloaded: { postId: "old-post", postUrl: "https://www.instagram.com/p/old-post/" } } },
    [syncScopeKey(person.id, "instagram", "ig-b")]: { pendingPosts: {
      second: { postId: POST, postUrl: `https://www.instagram.com/reel/${POST}/` },
    } },
    [syncScopeKey(other.id, "instagram", "ig-a")]: { pendingPosts: {
      other: { postId: POST, postUrl: `https://www.instagram.com/tv/${POST}/` },
    } },
    [syncScopeKey(person.id, "x", "x-a")]: { pendingPosts: {
      x: { postId: "123", postUrl: "https://x.com/first/status/123" },
    } },
  };
  const sources = [
    { platformId: "instagram", accountId: "ig-a", logicalKey: "post:a:0", postId: POST, postUrl: `https://www.instagram.com/p/${POST}/` },
    { platformId: "instagram", accountId: "ig-b", logicalKey: "post:a:0", postId: POST, postUrl: `https://www.instagram.com/reel/${POST}/` },
    { platformId: "x", accountId: "x-a", logicalKey: "123:0", postId: "123", postUrl: "https://x.com/first/status/123" },
  ];
  const calls = [];
  const openMediaIndex = async (owner) => {
    calls.push(owner.id);
    return {
      get(id, options) {
        assert.equal(typeof id, "string");
        assert.equal(options.includeFingerprint, false);
        return owner.id === person.id && id === MEDIA_ID ? { mediaId: MEDIA_ID } : null;
      },
      sources(id) { assert.equal(id, MEDIA_ID); return sources; },
    };
  };
  const resolve = (body, options = {}) => resolveBoundPost({ state, personId: person.id, body, scopes,
    openMediaIndex, profilesRoot, ...options });
  return { root, data, profilesRoot, profiles, person, other, state, scopes, sources, calls, resolve };
}

test("pending-post resolution chooses exact person/platform/account/current binding rather than first platform session", async (t) => {
  const env = await fixture(t);
  const first = await env.resolve(postBody());
  assert.equal(first.linked.id, "login-first");
  assert.equal(first.profile, env.profiles.first);
  assert.equal(first.url, `https://www.instagram.com/p/${POST}/`);
  const second = await env.resolve(postBody({ accountId: "ig-b" }));
  assert.equal(second.linked.id, "login-second");
  assert.equal(second.profile, env.profiles.second);
  assert.equal(second.url, `https://www.instagram.com/reel/${POST}/`);
  const other = await env.resolve(postBody(), { personId: env.other.id });
  assert.equal(other.person.id, env.other.id);
  assert.equal(other.url, `https://www.instagram.com/tv/${POST}/`);
  const x = await env.resolve({ platformId: "x", accountId: "x-a", postId: "123" });
  assert.equal(x.linked.id, "login-x");
  assert.equal(x.profile, env.profiles.x);
  assert.equal(x.url, "https://x.com/first/status/123");
  assert.equal(env.calls.length, 0, "pending references do not inspect or mutate person media indexes");
});

test("recorded postKey and stored downloaded source remain resolvable after pending item disappears", async (t) => {
  const env = await fixture(t);
  assert.equal((await env.resolve(postBody({ postId: "fallback" }))).url, "https://www.instagram.com/p/fallback/");
  assert.equal((await env.resolve(postBody({ postId: "old-post" }))).url, "https://www.instagram.com/p/old-post/");
  await assert.rejects(env.resolve(postBody({ postId: "not-recorded" })), { status: 404 });
  await assert.rejects(env.resolve(postBody({ accountId: "not-recorded" })), { status: 404 });
  await assert.rejects(env.resolve(postBody({ platformId: "x" })), { status: 404 });
  await assert.rejects(env.resolve(postBody(), { personId: "unknown" }), { status: 404 });
});

test("media source tuple selects exact indexed source and current account binding", async (t) => {
  const env = await fixture(t);
  for (const [index, expected] of [[0, "login-first"], [1, "login-second"], [2, "login-x"]]) {
    const resolved = await env.resolve({ mediaId: MEDIA_ID, sourceKey: sourceKey(env.sources[index]) });
    assert.equal(resolved.linked.id, expected);
    assert.equal(resolved.url, env.sources[index].postUrl);
  }
  await assert.rejects(env.resolve({ mediaId: UNKNOWN_MEDIA_ID, sourceKey: sourceKey(env.sources[0]) }), { status: 404 });
  await assert.rejects(env.resolve({ mediaId: MEDIA_ID, sourceKey: '["instagram","ig-a","wrong-key"]' }), { status: 404 });
  await assert.rejects(env.resolve({ mediaId: MEDIA_ID, sourceKey: JSON.stringify(["instagram", "ig-a", "post:a:0", "extra"]) }), { status: 404 });
  await assert.rejects(env.resolve({ mediaId: MEDIA_ID, sourceKey: '[ "instagram", "ig-a", "post:a:0" ]' }), { status: 404 });
  await assert.rejects(env.resolve({ mediaId: MEDIA_ID, sourceKey: sourceKey(env.sources[0]) }, { personId: env.other.id }), { status: 404 });
});

test("only exact identifier bodies are accepted, never client URLs/profile paths/cookies or coercible media ids", async (t) => {
  const env = await fixture(t);
  for (const body of [undefined, null, [], "url", {}, { url: env.sources[0].postUrl },
    { ...postBody(), url: env.sources[0].postUrl }, { ...postBody(), profile: env.profiles.first },
    { ...postBody(), cookies: "fixture" }, { ...postBody(), linkedAccountId: "login-second" },
    { ...postBody(), mediaId: MEDIA_ID, sourceKey: sourceKey(env.sources[0]) },
    { mediaId: [MEDIA_ID], sourceKey: sourceKey(env.sources[0]) },
    { mediaId: {}, sourceKey: sourceKey(env.sources[0]) },
    { mediaId: MEDIA_ID.toUpperCase(), sourceKey: sourceKey(env.sources[0]) },
    { mediaId: MEDIA_ID.slice(1), sourceKey: sourceKey(env.sources[0]) },
    { mediaId: MEDIA_ID, sourceKey: [sourceKey(env.sources[0])] },
    { mediaId: MEDIA_ID, sourceKey: "a".repeat(1001) },
    { mediaId: MEDIA_ID, sourceKey: "invalid\u0000tuple" },
  ]) await assert.rejects(env.resolve(body), { status: 400 });
  for (const key of ["platformId", "accountId", "postId"]) {
    for (const value of [undefined, null, 1, true, [], {}, "", "a".repeat(1001), "bad\nvalue", "bad\u0000value"]) {
      await assert.rejects(env.resolve(postBody({ [key]: value })), { status: 400 });
    }
  }
  assert.equal(env.calls.length, 0, "malformed references fail before any media-index access");
});

test("removed target accounts and removed/mismatched bindings do not fall back to another valid login", async (t) => {
  const env = await fixture(t);
  for (const alter of [
    (state) => { state.persons[0].platforms[0].accounts = state.persons[0].platforms[0].accounts.filter((item) => item.id !== "ig-a"); },
    (state) => { state.persons[0].platforms = state.persons[0].platforms.filter((item) => item.id !== "instagram"); },
    (state) => { state.linkedAccounts = state.linkedAccounts.filter((item) => item.id !== "login-first"); },
    (state) => { state.persons[0].platforms[0].accounts[0].linkedAccountId = "login-x"; },
    (state) => { delete state.persons[0].platforms[0].accounts[0].linkedAccountId; },
    (state) => { state.linkedAccounts[0].profileDirectory = ""; },
  ]) {
    const changed = structuredClone(env.state);
    alter(changed);
    await assert.rejects(env.resolve(postBody(), { state: changed }), { status: 409 });
    await assert.rejects(env.resolve({ mediaId: MEDIA_ID, sourceKey: sourceKey(env.sources[0]) }, { state: changed }), { status: 409 });
  }
});

test("recorded original-post URL is enforced by platform, not just https or a matching substring", async (t) => {
  const env = await fixture(t);
  const valid = [
    ["instagram", `https://www.instagram.com/p/${POST}/?utm_source=test#details`, `https://www.instagram.com/p/${POST}/`],
    ["instagram", `https://instagram.com/reel/${POST}/`, `https://instagram.com/reel/${POST}/`],
    ["x", "https://twitter.com/first/status/123?redirect=https://evil.example#part", "https://twitter.com/first/status/123"],
    ["tiktok", "https://www.tiktok.com/@first.person/photo/123?lang=en", "https://www.tiktok.com/@first.person/photo/123"],
    ["threads", "https://www.threads.com/@first/post/abc_-/#part", "https://www.threads.com/@first/post/abc_-/"],
    ["facebook", "https://www.facebook.com/permalink.php?story_fbid=123&id=456&next=https://evil.example#part", "https://www.facebook.com/permalink.php?story_fbid=123&id=456"],
    ["facebook", "https://www.facebook.com/first/posts/123?utm_source=test", "https://www.facebook.com/first/posts/123"],
  ];
  for (const [id, value, expected] of valid) assert.equal(validateRecordedPostUrl({ id }, value), expected);
  for (const value of [undefined, null, 1, [env.sources[0].postUrl], "not a url", "http://www.instagram.com/p/abc/",
    "https://name:password@www.instagram.com/p/abc/", "https://www.instagram.com:444/p/abc/",
    "https://instagram.com.evil.example/p/abc/", "https://evil.example/instagram.com/p/abc/",
    "https://www.instagram.com/accounts/login/", "https://www.instagram.com/p/abc/extra",
    "https://www.instagram.com/p/abc/%2fextra", "https://www.instagram.com/redirect?url=https://evil.example",
    "https://x.com/first/status/123", "javascript:alert(1)", "file:///C:/Windows/not-a-post", "https://127.0.0.1/p/abc/",
    `https://www.instagram.com/p/${"a".repeat(4100)}/`,
  ]) assert.throws(() => validateRecordedPostUrl({ id: "instagram" }, value), { status: 400 });
  const changed = structuredClone(env.scopes);
  changed[syncScopeKey(env.person.id, "instagram", "ig-a")].pendingPosts.first.postUrl = "https://evil.example/p/abc/";
  await assert.rejects(env.resolve(postBody(), { scopes: changed }), { status: 400 });
});

test("custom-platform original posts must use configured exact public domain and cannot select a different platform binding", async (t) => {
  const env = await fixture(t);
  const id = "custom-12345678-1234-1234-1234-123456789abc";
  const custom = { id, custom: true, homepageUrl: "https://media.example.com/", label: "Media" };
  const profile = path.join(env.profilesRoot, id, "custom-session");
  await mkdir(profile, { recursive: true });
  env.state.customPlatforms.push(custom);
  env.person.platforms.push({ id, accounts: [{ id: "custom-account", linkedAccountId: "custom-login" }] });
  env.state.linkedAccounts.push({ id: "custom-login", platformId: id, profileDirectory: profile });
  env.scopes[syncScopeKey(env.person.id, id, "custom-account")] = { pendingPosts: {
    item: { postId: "post-1", postUrl: "https://media.example.com/person/posts/post-1#section" },
  } };
  const resolved = await env.resolve({ platformId: id, accountId: "custom-account", postId: "post-1" });
  assert.equal(resolved.platform.custom, true);
  assert.equal(resolved.linked.id, "custom-login");
  assert.equal(resolved.url, "https://media.example.com/person/posts/post-1");
  for (const value of ["https://media.example.com.evil.example/posts/a", "https://other.example.com/posts/a",
    "https://127.0.0.1/posts/a", "https://media.example.com:444/posts/a", "https://user:pass@media.example.com/posts/a"]) {
    assert.throws(() => validateRecordedPostUrl(custom, value), { status: 400 });
  }
});

test("binding profile must be a direct child of its own platform directory", async (t) => {
  const env = await fixture(t);
  for (const profile of [path.join(env.root, "outside", "login"), env.profilesRoot,
    path.join(env.profilesRoot, "instagram"), path.join(env.profiles.first, "nested"),
    path.join(env.profilesRoot, "x", "foreign"), path.join(env.profilesRoot, "instagram", "..", "foreign"),
  ]) {
    const changed = structuredClone(env.state);
    changed.linkedAccounts[0].profileDirectory = profile;
    await assert.rejects(env.resolve(postBody(), { state: changed }), { status: 400 });
    await assert.rejects(assertBoundProfile({ profile, platform: { id: "instagram" }, profilesRoot: env.profilesRoot }), { status: 400 });
  }
  await assertBoundProfile({ profile: env.profiles.first, platform: { id: "instagram" }, profilesRoot: env.profilesRoot });
});

test("missing profile and a non-directory profile fail without creating an unlogged browser profile", async (t) => {
  const env = await fixture(t);
  const missing = path.join(env.profilesRoot, "instagram", "missing");
  await assert.rejects(assertBoundProfile({ profile: missing, platform: { id: "instagram" }, profilesRoot: env.profilesRoot }), { status: 409 });
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  const file = path.join(env.profilesRoot, "instagram", "not-a-directory");
  await writeFile(file, "fixture, not cookies");
  await assert.rejects(assertBoundProfile({ profile: file, platform: { id: "instagram" }, profilesRoot: env.profilesRoot }), { status: 400 });
  assert.equal(await readFile(file, "utf8"), "fixture, not cookies");
});

test("symlink/junction at root, platform or profile is rejected even if its target remains inside temporary fixture", async (t) => {
  const env = await fixture(t);
  const kind = process.platform === "win32" ? "junction" : "dir";
  const rootAlias = path.join(env.root, "root-alias");
  await symlink(env.profilesRoot, rootAlias, kind);
  await assert.rejects(assertBoundProfile({ profile: path.join(rootAlias, "instagram", "first"),
    platform: { id: "instagram" }, profilesRoot: rootAlias }), { status: 400 });
  const anotherRoot = path.join(env.root, "another-root");
  await mkdir(anotherRoot);
  await symlink(path.join(env.profilesRoot, "instagram"), path.join(anotherRoot, "instagram"), kind);
  await assert.rejects(assertBoundProfile({ profile: path.join(anotherRoot, "instagram", "first"),
    platform: { id: "instagram" }, profilesRoot: anotherRoot }), { status: 400 });
  const profileAlias = path.join(env.profilesRoot, "instagram", "alias");
  await symlink(env.profiles.first, profileAlias, kind);
  await assert.rejects(assertBoundProfile({ profile: profileAlias, platform: { id: "instagram" }, profilesRoot: env.profilesRoot }), { status: 400 });
});

function waitForService(child) {
  return new Promise((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => finish(new Error(`Fixture service startup timed out: ${output}\n${errors}`)), 12_000);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrors);
      child.off("error", onError);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onOutput = (chunk) => { output = (output + chunk).slice(-65_536); if (output.includes("已启动")) finish(); };
    const onErrors = (chunk) => { errors = (errors + chunk).slice(-65_536); };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Fixture service exited ${code}: ${output}\n${errors}`));
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrors);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("open-post HTTP negatives use temporary state only, reject origin/client URL/missing binding/profile and preserve all records", async (t) => {
  const env = await fixture(t);
  const missing = path.join(env.profilesRoot, "instagram", "missing-session");
  env.state.linkedAccounts[0].profileDirectory = missing;
  const scope = env.scopes[syncScopeKey(env.person.id, "instagram", "ig-a")];
  scope.pendingPosts.unsafe = { postId: "unsafe", postUrl: "https://evil.example/p/unsafe/" };
  scope.pendingPosts.credentials = { postId: "credentials", postUrl: "https://user:pass@www.instagram.com/p/credentials/" };
  scope.pendingPosts.login = { postId: "login", postUrl: "https://www.instagram.com/accounts/login/" };
  const stateFile = path.join(env.data, "state.json"), indexFile = path.join(env.data, "sync-index.json");
  await writeFile(stateFile, JSON.stringify(env.state));
  await writeFile(indexFile, JSON.stringify({ version: 3, layout: "person-v1", scopes: env.scopes,
    summaries: {}, receipts: {}, storageInitialized: {} }));
  const beforeState = await readFile(stateFile), beforeIndex = await readFile(indexFile);
  const socket = http.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true,
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: env.data, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  });
  await waitForService(child);
  const request = (body, { requestOrigin = origin, personId = env.person.id } = {}) => fetch(`${origin}/api/persons/${personId}/open-post`, {
    method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [{}, [], { url: env.sources[0].postUrl }, { ...postBody(), profileDirectory: missing },
    { ...postBody(), linkedAccountId: "login-second" }, { ...postBody(), cookies: "fixture" },
    { mediaId: [MEDIA_ID], sourceKey: sourceKey(env.sources[0]) }, postBody({ accountId: null }),
  ]) assert.equal((await request(body)).status, 400);
  assert.equal((await request(postBody(), { requestOrigin: "https://untrusted.example" })).status, 403);
  assert.equal((await request(postBody(), { personId: "missing-person" })).status, 404);
  assert.equal((await request(postBody({ postId: "not-recorded" }))).status, 404);
  for (const postId of ["unsafe", "credentials", "login"]) assert.equal((await request(postBody({ postId }))).status, 400);
  const missingResponse = await request(postBody());
  assert.equal(missingResponse.status, 409);
  assert.match((await missingResponse.json()).error, /登录资料目录.*无法访问/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  const removed = structuredClone(env.state);
  removed.linkedAccounts = removed.linkedAccounts.filter((item) => item.id !== "login-first");
  await writeFile(stateFile, JSON.stringify(removed));
  assert.equal((await request(postBody())).status, 409, "another Instagram login must never be used as anonymous fallback");
  await writeFile(stateFile, beforeState);
  assert.deepEqual(await readFile(stateFile), beforeState);
  assert.deepEqual(await readFile(indexFile), beforeIndex);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
});
