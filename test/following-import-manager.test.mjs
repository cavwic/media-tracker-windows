import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { FollowingImportManager, followingSupportedPlatformIds } from "../lib/following-import-manager.mjs";
import { AccountResourceScheduler } from "../lib/account-resource-scheduler.mjs";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function setup(options = {}) {
  const profileDirectory = path.join(os.tmpdir(), "following-import-test", "browser-profiles", "x", "profile-a");
  const state = { linkedAccounts: [
    { id: "binding-a", platformId: "x", label: "My X", profileDirectory, loginStatus: "verified" },
    { id: "binding-b", platformId: "instagram", label: "My Instagram",
      profileDirectory: path.join(os.tmpdir(), "following-import-test", "browser-profiles", "instagram", "profile-b"), loginStatus: "verified" },
  ], customPlatforms: [], persons: [{ id: "existing-person", name: "Existing", platforms: [] }], settings: { theme: "dark" } };
  const activeKeys = new Set();
  const scheduler = new AccountResourceScheduler(activeKeys);
  const calls = [];
  const manager = new FollowingImportManager({ loadState: async () => state, scheduler,
    discover: async (input) => { calls.push(input); return { accounts: [], completeness: "complete", emptyConfirmed: true }; }, ...options });
  return { manager, state, scheduler, activeKeys, calls, profileDirectory };
}

const customId = "custom-12345678-1234-4234-8234-123456789abc";
function useCustomPlatform(fixture, followingUrl = "https://example.com/account/following") {
  const platform = { id: customId, label: "Custom Gallery", custom: true, homepageUrl: "https://example.com/",
    loginUrl: "https://example.com/login", followingUrl, loginMarker: "#account-menu", engine: "none" };
  fixture.state.customPlatforms = [platform];
  fixture.state.linkedAccounts[0].platformId = customId;
  fixture.state.linkedAccounts[0].profileDirectory = path.join(os.tmpdir(), "following-import-test", "browser-profiles", customId, "profile-a");
  return platform;
}

async function until(predicate, message = "fixture condition did not become true") {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("following import validates request IDs and requires an existing verified binding", async () => {
  const fixture = setup();
  try {
    for (const body of [null, [], {}, { linkedAccountId: "" }, { linkedAccountId: 3 },
      { linkedAccountId: "binding-a", profileDirectory: "C:/caller-path" },
      { linkedAccountId: "binding-a", url: "https://attacker.invalid/" }]) {
      await assert.rejects(fixture.manager.start(body), error => [400, 404].includes(error.status));
    }
    await assert.rejects(fixture.manager.start({ linkedAccountId: "unknown" }), error => error.status === 404);
    fixture.state.linkedAccounts[0].loginStatus = "unverified";
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => [400, 409, 422].includes(error.status));
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("unsupported custom platforms fail before discovery or resource allocation", async () => {
  const fixture = setup();
  fixture.state.linkedAccounts[0].platformId = "custom-12345678-1234-4234-8234-123456789abc";
  try {
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => [400, 409, 422].includes(error.status));
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("zero parsed accounts never claim a successful empty list without explicit platform evidence", async () => {
  for (const result of [
    { accounts: [], completeness: "complete" },
    { accounts: [], completeness: "partial", emptyConfirmed: false },
    { accounts: [], completeness: "complete", emptyConfirmed: "true" },
    { accounts: [{ profileUrl: "https://foreign.example/not-a-profile" }], completeness: "complete" },
    { accounts: [{ profileUrl: "https://foreign.example/not-a-profile" }], completeness: "complete", emptyConfirmed: true },
    { completeness: "complete", emptyConfirmed: true },
  ]) {
    const fixture = setup({ discover: async () => result });
    const before = structuredClone(fixture.state);
    try {
      const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
      assert.equal(started.emptyConfirmed, false);
      const job = await fixture.manager.wait(started.id);
      assert.equal(job.status, "failed");
      assert.equal(job.completeness, "partial");
      assert.equal(job.emptyConfirmed, false);
      assert.equal(job.discovered, 0);
      assert.equal(job.errorCode, "following-ui-missing");
      assert.match(job.message, /平台未提供可读取的已关注列表/);
      assert.doesNotMatch(job.message, /列表为空|完整关注列表/);
      assert.equal(fixture.activeKeys.size, 0);
      assert.deepEqual(fixture.state, before);
    } finally { await fixture.manager.shutdown(); }
  }
});

test("a platform-confirmed zero list has explicit complete empty status without changing a binding or draft", async () => {
  const fixture = setup({ discover: async () => ({ accounts: [], completeness: "complete", emptyConfirmed: true }) });
  const before = structuredClone(fixture.state);
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "completed");
    assert.equal(job.completeness, "complete");
    assert.equal(job.emptyConfirmed, true);
    assert.equal(job.discovered, 0);
    assert.equal(job.errorCode, "");
    assert.equal(job.message, "当前登录账号的关注列表为空（平台已确认），可手动添加目标账号。");
    assert.deepEqual(job.accounts, []);
    assert.equal(fixture.activeKeys.size, 0);
    assert.deepEqual(fixture.state, before);
  } finally { await fixture.manager.shutdown(); }
});

test("empty-list evidence cannot discard valid candidates already received during progress", async () => {
  const fixture = setup({ discover: async ({ onProgress }) => {
    onProgress({ accounts: [{ handle: "retained_target" }] });
    return { accounts: [], completeness: "partial", emptyConfirmed: true };
  } });
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "completed");
    assert.equal(job.completeness, "partial");
    assert.equal(job.emptyConfirmed, false);
    assert.equal(job.discovered, 1);
    assert.equal(job.accounts[0].handle, "retained_target");
    assert.doesNotMatch(job.message, /关注列表为空/);
  } finally { await fixture.manager.shutdown(); }
});

test("custom following capability is advertised only after configuring its optional following page", async () => {
  const fixture = setup();
  const platform = useCustomPlatform(fixture, "");
  assert.equal(followingSupportedPlatformIds(fixture.state.customPlatforms).includes(customId), false);
  platform.followingUrl = "https://example.com/account/following";
  assert.equal(followingSupportedPlatformIds(fixture.state.customPlatforms).includes(customId), true);
  await fixture.manager.shutdown();
});

test("a custom binding without a following page provides direction without starting a browser or modifying verification", async () => {
  const fixture = setup();
  useCustomPlatform(fixture, "");
  const before = structuredClone(fixture.state);
  try {
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => error.status === 409 && /关注页/.test(error.message));
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
    assert.deepEqual(fixture.state, before);
  } finally { await fixture.manager.shutdown(); }
});

test("configured custom following candidates use same-site profile URLs, retain case-sensitive identities and share the existing profile lease", async () => {
  let fixture;
  fixture = setup({ discover: async input => {
    assert.equal(input.platform.followingUrl, "https://example.com/account/following");
    assert.equal(fixture.activeKeys.size, 2);
    return { completeness: "complete", accounts: [
      { profileUrl: "https://example.com/users/Artist", displayName: "Artist", platformId: "x" },
      { profileUrl: "https://example.com/users/artist", displayName: "Different artist" },
      { profileUrl: "https://example.com/users/Artist", displayName: "Repeated" },
      { profileUrl: "https://another.example/users/foreign", displayName: "Foreign" },
    ] };
  } });
  useCustomPlatform(fixture);
  const before = structuredClone(fixture.state);
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "completed");
    assert.equal(job.discovered, 2);
    assert.deepEqual(job.accounts.map(item => item.profileUrl).sort(), ["https://example.com/users/Artist", "https://example.com/users/artist"]);
    assert.equal(job.accounts.every(item => item.platformId === customId), true);
    assert.deepEqual(fixture.state, before);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("a queued custom import never uses a changed or removed following page configuration", async () => {
  for (const change of ["url", "remove", "marker"]) {
    const fixture = setup();
    const platform = useCustomPlatform(fixture);
    const release = await fixture.scheduler.acquire({ keys: ["login:binding-a"] });
    try {
      const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
      assert.equal(job.status, "queued");
      if (change === "url") platform.followingUrl = "https://example.com/another/following";
      else if (change === "remove") fixture.state.customPlatforms = [];
      else platform.loginMarker = "#different-account-menu";
      release();
      const result = await fixture.manager.wait(job.id);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "platform-changed");
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.state.linkedAccounts[0].loginStatus, "verified");
    } finally { release(); await fixture.manager.shutdown(); }
  }
});

test("different platform bindings discover concurrently without altering configuration", async () => {
  const gate = deferred();
  const began = [];
  const fixture = setup({ discover: async ({ linkedAccount }) => {
    began.push(linkedAccount.id);
    await gate.promise;
    return { accounts: [], completeness: "complete", emptyConfirmed: true };
  } });
  const before = structuredClone(fixture.state);
  try {
    const first = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const second = await fixture.manager.start({ linkedAccountId: "binding-b" });
    await until(() => began.length === 2);
    assert.deepEqual(new Set(began), new Set(["binding-a", "binding-b"]));
    assert.equal(fixture.activeKeys.size, 4);
    gate.resolve();
    const jobs = await Promise.all([fixture.manager.wait(first.id), fixture.manager.wait(second.id)]);
    assert.deepEqual(jobs.map(job => job.status), ["completed", "completed"]);
    assert.deepEqual(fixture.state, before);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { gate.resolve(); await fixture.manager.shutdown(); }
});

test("repeated requests reuse an active binding import instead of launching duplicate browsers", async () => {
  const gate = deferred();
  let reads = 0;
  const fixture = setup({ discover: async () => { reads++; await gate.promise; return { accounts: [], completeness: "complete", emptyConfirmed: true }; } });
  try {
    const first = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const repeat = await fixture.manager.start({ linkedAccountId: "binding-a" });
    assert.equal(repeat.id, first.id);
    await until(() => reads === 1);
    gate.resolve();
    assert.equal((await fixture.manager.wait(first.id)).status, "completed");
    assert.equal(reads, 1);
  } finally { gate.resolve(); await fixture.manager.shutdown(); }
});

test("alias bindings sharing a physical profile use the same FIFO browser lease", async () => {
  const firstGate = deferred();
  const reads = [];
  const fixture = setup({ discover: async ({ linkedAccount }) => {
    reads.push(linkedAccount.id);
    if (linkedAccount.id === "binding-a") await firstGate.promise;
    return { accounts: [], completeness: "complete", emptyConfirmed: true };
  } });
  fixture.state.linkedAccounts[1].profileDirectory = fixture.profileDirectory;
  try {
    const first = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => reads.length === 1);
    const second = await fixture.manager.start({ linkedAccountId: "binding-b" });
    await until(() => fixture.scheduler.pending.length === 1);
    assert.equal(fixture.manager.get(second.id).status, "queued");
    assert.deepEqual(reads, ["binding-a"]);
    firstGate.resolve();
    await Promise.all([fixture.manager.wait(first.id), fixture.manager.wait(second.id)]);
    assert.deepEqual(reads, ["binding-a", "binding-b"]);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { firstGate.resolve(); await fixture.manager.shutdown(); }
});

test("imports respect sync and cache maintenance keys already held outside the importer", async () => {
  const fixture = setup();
  const profileKey = `profile:${path.resolve(fixture.profileDirectory).toLowerCase()}`;
  fixture.activeKeys.add(profileKey);
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.scheduler.pending.length === 1);
    assert.equal(fixture.manager.get(job.id).status, "queued");
    assert.equal(fixture.calls.length, 0);
    fixture.activeKeys.delete(profileKey);
    fixture.scheduler.drain();
    assert.equal((await fixture.manager.wait(job.id)).status, "completed");
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { fixture.activeKeys.delete(profileKey); fixture.scheduler.drain(); await fixture.manager.shutdown(); }
});

test("cancelled queued imports leave no discovery or scheduler reservations", async () => {
  const fixture = setup();
  const profileKey = `profile:${path.resolve(fixture.profileDirectory).toLowerCase()}`;
  fixture.activeKeys.add(profileKey);
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.scheduler.pending.length === 1);
    fixture.manager.cancel(job.id);
    const finished = await fixture.manager.wait(job.id);
    assert.equal(finished.status, "cancelled");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.scheduler.pending.length, 0);
    assert.deepEqual([...fixture.activeKeys], [profileKey]);
  } finally { fixture.activeKeys.delete(profileKey); fixture.scheduler.drain(); await fixture.manager.shutdown(); }
});

test("active cancellation retains the lease until the collector closes its browser", async () => {
  const disposed = deferred();
  let started = false;
  let cleanupStarted = false;
  const fixture = setup({ discover: async ({ signal }) => {
    started = true;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    cleanupStarted = true;
    await disposed.promise;
    throw new DOMException("fixture cancelled", "AbortError");
  } });
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => started);
    fixture.manager.cancel(job.id);
    await until(() => cleanupStarted);
    assert.equal(fixture.manager.get(job.id).cancelRequested, true);
    assert.equal(fixture.activeKeys.size, 2);
    assert.equal(fixture.manager.get(job.id).status, "running");
    disposed.resolve();
    assert.equal((await fixture.manager.wait(job.id)).status, "cancelled");
    assert.equal(fixture.activeKeys.size, 0);
  } finally { disposed.resolve(); await fixture.manager.shutdown(); }
});

test("shutdown aborts queued and active imports and waits for browser cleanup", async () => {
  const disposed = deferred();
  let started = false;
  const fixture = setup({ discover: async ({ signal }) => {
    started = true;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await disposed.promise;
    throw new DOMException("fixture cancelled", "AbortError");
  } });
  fixture.state.linkedAccounts[1].profileDirectory = fixture.profileDirectory;
  try {
    const active = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => started);
    const queued = await fixture.manager.start({ linkedAccountId: "binding-b" });
    await until(() => fixture.scheduler.pending.length === 1);
    let done = false;
    const stop = fixture.manager.shutdown().then(() => { done = true; });
    await fixture.manager.wait(queued.id);
    assert.equal(done, false);
    assert.equal(fixture.activeKeys.size, 2);
    disposed.resolve();
    await stop;
    assert.equal(fixture.manager.get(active.id).status, "cancelled");
    assert.equal(fixture.manager.get(queued.id).status, "cancelled");
    assert.equal(fixture.activeKeys.size, 0);
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => [409, 503].includes(error.status));
  } finally { disposed.resolve(); await fixture.manager.shutdown(); }
});

test("bindings removed while queued cannot read orphaned login profiles", async () => {
  const fixture = setup();
  const key = `profile:${path.resolve(fixture.profileDirectory).toLowerCase()}`;
  fixture.activeKeys.add(key);
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.scheduler.pending.length === 1);
    fixture.state.linkedAccounts = fixture.state.linkedAccounts.filter(account => account.id !== "binding-a");
    fixture.activeKeys.delete(key);
    fixture.scheduler.drain();
    const finished = await fixture.manager.wait(job.id);
    assert.equal(finished.status, "failed");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { fixture.activeKeys.delete(key); fixture.scheduler.drain(); await fixture.manager.shutdown(); }
});

test("queued profile identity changes fail safely rather than using the old lease", async () => {
  const fixture = setup();
  const key = `profile:${path.resolve(fixture.profileDirectory).toLowerCase()}`;
  fixture.activeKeys.add(key);
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.scheduler.pending.length === 1);
    fixture.state.linkedAccounts[0].profileDirectory = path.join(os.tmpdir(), "following-import-new-profile");
    fixture.activeKeys.delete(key);
    fixture.scheduler.drain();
    assert.equal((await fixture.manager.wait(job.id)).status, "failed");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { fixture.activeKeys.delete(key); fixture.scheduler.drain(); await fixture.manager.shutdown(); }
});

test("a binding whose login verification changes while queued is not read with stale verification", async () => {
  const fixture = setup();
  const key = `profile:${path.resolve(fixture.profileDirectory).toLowerCase()}`;
  fixture.activeKeys.add(key);
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.scheduler.pending.length === 1);
    fixture.state.linkedAccounts[0].loginStatus = "failed";
    fixture.activeKeys.delete(key);
    fixture.scheduler.drain();
    const finished = await fixture.manager.wait(job.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "login-required");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { fixture.activeKeys.delete(key); fixture.scheduler.drain(); await fixture.manager.shutdown(); }
});

test("public jobs hide credentials and raw collector error details", async () => {
  const secret = "cookie-token-do-not-return";
  const fixture = setup({ discover: async () => {
    throw Object.assign(new Error(`profile=${os.tmpdir()} Cookie: auth_token=${secret}`), { code: "raw-backend-secret" });
  } });
  fixture.state.linkedAccounts[0].cookies = [{ value: secret }];
  fixture.state.linkedAccounts[0].authorization = `Bearer ${secret}`;
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const finished = await fixture.manager.wait(job.id);
    assert.equal(finished.status, "failed");
    const publicText = JSON.stringify(finished);
    assert.equal(publicText.includes(secret), false);
    assert.equal(publicText.includes(fixture.profileDirectory), false);
    assert.equal(publicText.includes("raw-backend-secret"), false);
    assert.equal("controller" in finished, false);
    assert.equal("linkedAccount" in finished, false);
    assert.equal("resourceKeys" in finished, false);
  } finally { await fixture.manager.shutdown(); }
});

test("custom following errors provide safe specific guidance without exposing raw page or login details", async () => {
  for (const [code, expected, message] of [
    ["following-url-unsafe", "following-url-unsafe", /其他网站或非公网/],
    ["following-list-unavailable", "custom-following-ui-missing", /专用适配/],
    ["login-rule-required", "login-rule-required", /配置并验证登录/],
    ["login-rule-invalid", "login-rule-invalid", /修改后重新验证登录/],
  ]) {
    const fixture = setup({ discover: async () => { throw Object.assign(new Error("private session token"), { code }); } });
    useCustomPlatform(fixture);
    const before = structuredClone(fixture.state);
    try {
      const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
      const finished = await fixture.manager.wait(started.id);
      assert.equal(finished.status, "failed");
      assert.equal(finished.errorCode, expected);
      assert.match(finished.error, message);
      assert.equal(JSON.stringify(finished).includes("private session token"), false);
      assert.deepEqual(fixture.state, before);
      assert.equal(fixture.activeKeys.size, 0);
    } finally { await fixture.manager.shutdown(); }
  }
});

test("profile-use failures release browser leases without attempting collection", async () => {
  const fixture = setup({ withProfileUse: async () => {
    throw Object.assign(new Error("profile busy"), { code: "profile-busy", status: 409 });
  } });
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    assert.equal((await fixture.manager.wait(job.id)).status, "failed");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("collector results are canonical platform profiles, deduplicated and stripped of private fields", async () => {
  const secret = "result-cookie-secret";
  const fixture = setup({ discover: async () => ({ completeness: "complete", accounts: [
    { handle: "Alice", displayName: "Alice Name", platformId: "facebook", linkedAccountId: "attacker-binding",
      profileUrl: "https://twitter.com/Alice?secret=drop-this", cookie: secret, avatarUrl: "https://invalid.example/avatar" },
    { handle: "alice", profileUrl: "https://x.com/alice" },
    { handle: "Bob", full_name: "Bob Name" },
    { handle: "Mallory", profileUrl: "https://foreign.example/Mallory" },
    { handle: "Mallory", profileUrl: "https://user:password@x.com/Mallory" },
    { handle: "Mallory", profileUrl: "javascript:alert(1)" },
    { handle: "home" }, { handle: "../unsafe" },
  ] }) });
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "completed");
    assert.equal(job.discovered, 2);
    assert.equal(job.completeness, "complete");
    assert.deepEqual(job.accounts.map(account => account.profileUrl), ["https://x.com/Alice", "https://x.com/Bob"]);
    assert.deepEqual(job.accounts.map(account => account.platformId), ["x", "x"]);
    assert.equal(job.linkedAccountId, "binding-a");
    assert.equal(JSON.stringify(job).includes(secret), false);
    assert.equal(JSON.stringify(job).includes("attacker-binding"), false);
    assert.equal(JSON.stringify(job).includes("secret=drop-this"), false);
    for (const account of job.accounts) {
      assert.equal("cookies" in account, false);
      assert.equal("avatarUrl" in account, false);
      assert.equal("linkedAccountId" in account, false);
    }
  } finally { await fixture.manager.shutdown(); }
});

test("partially read candidates remain available after an online read fails", async () => {
  const fixture = setup({ discover: async ({ onProgress }) => {
    onProgress({ accounts: [{ handle: "already_visible" }] });
    throw Object.assign(new Error("Raw response includes a private cookie"), { code: "network" });
  } });
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "failed");
    assert.equal(job.completeness, "partial");
    assert.equal(job.discovered, 1);
    assert.equal(job.accounts[0].handle, "already_visible");
    assert.equal(job.errorCode, "network");
    assert.equal(JSON.stringify(job).includes("private cookie"), false);
  } finally { await fixture.manager.shutdown(); }
});

test("public result copies cannot mutate stored candidates, job status or original binding configuration", async () => {
  let captured;
  const gate = deferred();
  const fixture = setup({ discover: async input => {
    captured = input;
    input.onProgress({ accounts: [{ handle: "real_target", displayName: "Real Target" }] });
    await gate.promise;
    return { completeness: "complete", accounts: [] };
  } });
  const before = structuredClone(fixture.state);
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => Boolean(captured));
    const copy = fixture.manager.get(started.id);
    copy.status = "completed";
    copy.accounts[0].handle = "tampered";
    copy.accounts.push({ handle: "invented" });
    captured.linkedAccount.label = "collector-local-label";
    assert.equal(fixture.manager.get(started.id).status, "running");
    assert.equal(fixture.manager.get(started.id).accounts[0].handle, "real_target");
    assert.equal(fixture.manager.get(started.id).accounts.length, 1);
    assert.deepEqual(fixture.state, before);
    gate.resolve();
    const finished = await fixture.manager.wait(started.id);
    assert.equal(finished.accounts[0].displayName, "Real Target");
    assert.equal(finished.accountLabel, "My X");
    assert.deepEqual(fixture.state, before);
  } finally { gate.resolve(); await fixture.manager.shutdown(); }
});

test("maximum candidate count stays bounded and cannot claim a complete list at the limit", async () => {
  const fixture = setup({ maxAccounts: 2, discover: async ({ onProgress }) => {
    onProgress({ accounts: [{ handle: "first" }, { handle: "second" }, { handle: "third" }] });
    return { completeness: "complete", accounts: [{ handle: "fourth" }] };
  } });
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "completed");
    assert.equal(job.discovered, 2);
    assert.equal(job.completeness, "partial");
    assert.deepEqual(job.accounts.map(account => account.handle), ["first", "second"]);
  } finally { await fixture.manager.shutdown(); }
});

test("deadline aborts preserve candidates and wait for collector cleanup before releasing the profile", async () => {
  const cleanup = deferred();
  let aborted = false;
  const fixture = setup({ timeoutMs: 25, discover: async ({ signal, onProgress }) => {
    onProgress({ accounts: [{ handle: "deadline_saved" }] });
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    aborted = true;
    await cleanup.promise;
    throw new DOMException("deadline fixture", "AbortError");
  } });
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => aborted);
    assert.equal(fixture.activeKeys.size, 2);
    assert.equal(fixture.manager.get(started.id).status, "running");
    cleanup.resolve();
    const job = await fixture.manager.wait(started.id);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "deadline");
    assert.equal(job.accounts[0].handle, "deadline_saved");
    assert.equal(fixture.activeKeys.size, 0);
  } finally { cleanup.resolve(); await fixture.manager.shutdown(); }
});

test("finished results expire and bounded job retention prunes only completed jobs", async () => {
  let clock = 1_000;
  const fixture = setup({ now: () => clock, maxJobs: 1, retentionMs: 100 });
  try {
    const first = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await fixture.manager.wait(first.id);
    const second = await fixture.manager.start({ linkedAccountId: "binding-b" });
    await fixture.manager.wait(second.id);
    assert.throws(() => fixture.manager.get(first.id), error => error.status === 404);
    assert.equal(fixture.manager.jobs.size, 1);
    clock += 100;
    assert.throws(() => fixture.manager.get(second.id), error => error.status === 404);
    assert.equal(fixture.manager.jobs.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("active job capacity refuses new imports instead of dropping running browser owners", async () => {
  const gate = deferred();
  const fixture = setup({ maxJobs: 1, discover: async () => { await gate.promise; return { accounts: [], completeness: "complete", emptyConfirmed: true }; } });
  try {
    const first = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => fixture.activeKeys.size === 2);
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-b" }), error => error.status === 429);
    assert.equal(fixture.manager.get(first.id).status, "running");
    gate.resolve();
    assert.equal((await fixture.manager.wait(first.id)).status, "completed");
  } finally { gate.resolve(); await fixture.manager.shutdown(); }
});

test("a pre-aborted runtime cannot create queued jobs or touch profiles", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = setup({ signal: controller.signal });
  try {
    await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => error.status === 503);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
    assert.equal(fixture.manager.jobs.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("invalid profile paths cannot be supplied through a cached binding", async () => {
  const fixture = setup();
  try {
    for (const value of ["relative/profile", "", "C:\\unsafe\0profile", null]) {
      fixture.state.linkedAccounts[0].profileDirectory = value;
      await assert.rejects(fixture.manager.start({ linkedAccountId: "binding-a" }), error => error.status === 409);
    }
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("unconfirmed browser closure retains the profile lease and result until shutdown retries cleanup", async () => {
  let clock = 1_000;
  let retried = 0;
  const privateSecret = "private-browser-disposal-detail";
  const fixture = setup({ now: () => clock, retentionMs: 10, maxJobs: 1,
    discover: async ({ onProgress }) => {
      onProgress({ accounts: [{ handle: "close_saved" }] });
      throw Object.assign(new Error(privateSecret), { code: "browser-close-failed", retainProfileLease: true,
        retryDispose: async () => { retried++; } });
    } });
  fixture.state.linkedAccounts[1].profileDirectory = fixture.profileDirectory;
  try {
    const started = await fixture.manager.start({ linkedAccountId: "binding-a" });
    const failed = await fixture.manager.wait(started.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "browser-close-failed");
    assert.equal(failed.accounts[0].handle, "close_saved");
    assert.equal(fixture.activeKeys.size, 2);
    assert.equal(JSON.stringify(failed).includes(privateSecret), false);
    assert.equal("retryDispose" in failed, false);
    assert.equal("release" in failed, false);
    clock += 100;
    fixture.manager.prune();
    assert.equal(fixture.manager.get(started.id).errorCode, "browser-close-failed");
    assert.equal(fixture.manager.jobs.size, 1);
    for (const id of ["binding-a", "binding-b"]) {
      await assert.rejects(fixture.manager.start({ linkedAccountId: id }), error => error.status === 409);
    }
    await fixture.manager.shutdown();
    assert.equal(retried, 1);
    assert.equal(fixture.activeKeys.size, 0);
  } finally { await fixture.manager.shutdown(); }
});

test("cancelled imports with failed browser cleanup stay failed and shutdown cannot silently release an unclosed profile", async () => {
  let started = false;
  let cleanupCanFinish = false;
  const fixture = setup({ discover: async ({ signal }) => {
    started = true;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("private failed browser process"), { code: "browser-close-failed", retainProfileLease: true,
      retryDispose: async () => { if (!cleanupCanFinish) throw new Error("private retry failure"); } });
  } });
  try {
    const job = await fixture.manager.start({ linkedAccountId: "binding-a" });
    await until(() => started);
    fixture.manager.cancel(job.id);
    const failed = await fixture.manager.wait(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "browser-close-failed");
    assert.equal(failed.cancelRequested, true);
    assert.equal(fixture.activeKeys.size, 2);
    await assert.rejects(fixture.manager.shutdown(), error => error instanceof AggregateError
      && error.errors.length === 1 && !error.errors[0].message.includes("private retry"));
    assert.equal(fixture.activeKeys.size, 2);
    assert.equal(fixture.manager.get(job.id).status, "failed");
    cleanupCanFinish = true;
    await fixture.manager.shutdown();
    assert.equal(fixture.activeKeys.size, 0);
  } finally { cleanupCanFinish = true; await fixture.manager.shutdown(); }
});

