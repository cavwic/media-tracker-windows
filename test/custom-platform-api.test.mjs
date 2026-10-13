import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

const REPO = path.resolve(import.meta.dirname, "..");
const BLOCKED = "CUSTOM_API_FIXTURE_FORBIDDEN_IO";
// Windows can assign an ephemeral port that Fetch refuses before any I/O.
// Match Fetch's blocked-port list, without changing the product's port policy.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
// These API cases must remain entirely local. Fail visibly even if a future
// implementation catches an accidental DNS/browser/engine-launch exception.
const IO_GUARD = `
  import cp from 'node:child_process';
  import dns from 'node:dns/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const deny = () => { console.error('${BLOCKED}'); throw new Error('${BLOCKED}'); };
  const originalExecFile = cp.execFile;
  cp.execFile = (filename, args, ...rest) => {
    if (/\\\\(?:whoami|icacls)\\.exe$/i.test(filename)) return originalExecFile(filename, args, ...rest);
    return deny();
  };
  cp.execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => new Promise((resolve, reject) =>
    cp.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  cp.spawn = cp.exec = cp.fork = deny;
  dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = deny;
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== '127.0.0.1') return deny();
    return originalFetch(input, options);
  };
`;

async function availablePort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error("Could not reserve a Fetch-compatible fixture port");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-custom-api-"));
  const dataDirectory = path.join(root, "data");
  const stateFile = path.join(dataDirectory, "state.json");
  const origin = `http://127.0.0.1:${await availablePort()}`;
  let child;
  let output = "";
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("media-tracker-custom-api-"));
    await rm(root, { recursive: true, force: true });
    assert.doesNotMatch(output, new RegExp(BLOCKED), "API fixture attempted external I/O or launching a browser/engine");
  });
  async function start() {
    let launchError;
    let started = false;
    child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(IO_GUARD)}`, "server.mjs"], {
      cwd: REPO, windowsHide: true,
      env: { ...process.env, MEDIA_TRACKER_DATA_DIR: dataDirectory,
        MEDIA_TRACKER_PORT: new URL(origin).port, MEDIA_TRACKER_NO_OPEN: "1",
        // The launcher normally supplies this read-only UI culture. Keep this
        // API fixture deterministic without permitting any subprocess probe.
        MEDIA_TRACKER_SYSTEM_UI_LANGUAGE: "zh-CN",
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "nonexistent-browsers") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); started ||= /已启动/.test(chunk.toString()); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => { launchError = error; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Custom API fixture exited: ${output}`);
      if (started) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Custom API fixture did not start: ${output}`);
  }
  async function api(route, method = "GET", body) {
    const response = await fetch(`${origin}${route}`, {
      method, headers: { Origin: origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function addPlatform(overrides = {}) {
    const response = await api("/api/platforms", "POST", {
      label: "Custom Gallery", homepageUrl: "https://example.com/", loginUrl: "https://example.com/login", engine: "none", ...overrides,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.platform;
  }
  async function addLinked(platformId, label = "My local fixture") {
    const response = await api("/api/linked-accounts", "POST", { platformId, label });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }
  function personBody(platform, account = {}, name = "Local Creator") {
    return {
      name, folderMode: "new", selectedPath: path.join(root, "archive"),
      platforms: [{ id: platform.id, accounts: [{ label: "Creator", profileUrl: "https://example.com/creator", ...account }] }],
    };
  }
  await start();
  return { root, stateFile, dataDirectory, api, addPlatform, addLinked, personBody, stop, start };
}

test("custom platform registration and editing persist across restart without changing built-in platforms", async (t) => {
  const app = await fixture(t);
  const initial = (await app.api("/api/state")).body;
  const builtinIds = ["x", "instagram", "threads", "facebook", "tiktok"];
  assert.deepEqual(Object.keys(initial.platforms).sort(), [...builtinIds].sort());
  const platform = await app.addPlatform();
  assert.match(platform.id, /^custom-[0-9a-f-]{36}$/);
  assert.equal(platform.custom, true);
  assert.equal(platform.folderName, "Custom Gallery");
  const changed = await app.api(`/api/platforms/${platform.id}`, "PUT", { label: "Renamed Gallery", engine: "auto" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.platform.folderName, "Custom Gallery");
  assert.equal(changed.body.platform.id, platform.id);
  assert.equal(changed.body.platform.engine, "auto");
  assert.equal((await app.api("/api/platforms/x", "PUT", { label: "Not X" })).status, 404);
  await app.stop();
  await app.start();
  const loaded = (await app.api("/api/state")).body;
  assert.equal(loaded.customPlatforms.length, 1);
  assert.deepEqual(loaded.platforms[platform.id], changed.body.platform);
  for (const id of builtinIds) assert.deepEqual(loaded.platforms[id], initial.platforms[id]);
  const persisted = JSON.parse(await readFile(app.stateFile, "utf8"));
  assert.equal(persisted.customPlatforms[0].label, "Renamed Gallery");
});

test("custom linked accounts retain identity while media folders remain person-level after a rename", async (t) => {
  const app = await fixture(t);
  const platform = await app.addPlatform();
  const linked = await app.addLinked(platform.id);
  assert.equal(linked.platformId, platform.id);
  assert.equal(linked.platformLabel, platform.label);
  assert.equal(linked.loginStatus, "unverified");
  assert.equal(path.dirname(linked.profileDirectory), path.join(app.dataDirectory, "browser-profiles", platform.id));
  const created = await app.api("/api/persons", "POST", app.personBody(platform, { linkedAccountId: linked.id }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const person = created.body;
  const originalFolder = path.join(person.folderPath, "Index");
  assert.equal((await stat(originalFolder)).isDirectory(), true);
  for (const folder of [platform.folderName, "Image", "Video", "gif"]) await assert.rejects(stat(path.join(person.folderPath, folder)), { code: "ENOENT" });
  const renamed = await app.api(`/api/platforms/${platform.id}`, "PUT", { label: "Renamed Gallery" });
  assert.equal(renamed.status, 200);
  const state = (await app.api("/api/state")).body;
  const savedPerson = state.persons.find(({ id }) => id === person.id);
  assert.equal(savedPerson.platforms[0].label, "Renamed Gallery");
  assert.equal(savedPerson.platforms[0].folderName, "Custom Gallery");
  assert.equal(savedPerson.platforms[0].accounts[0].linkedAccountId, linked.id);
  assert.equal(state.linkedAccounts[0].platformLabel, "Renamed Gallery");
  const edited = await app.api(`/api/persons/${person.id}`, "PUT", {
    name: person.name, platforms: savedPerson.platforms,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await stat(originalFolder)).isDirectory(), true);
  await assert.rejects(stat(path.join(person.folderPath, "Renamed Gallery")), { code: "ENOENT" });
  const relabeled = await app.api(`/api/linked-accounts/${linked.id}`, "PUT", { label: "Different display name" });
  assert.equal(relabeled.status, 200);
  assert.equal(relabeled.body.profileDirectory, linked.profileDirectory);
  assert.equal(relabeled.body.platformId, platform.id);
  await app.stop();
  await app.start();
  const reloaded = (await app.api("/api/state")).body;
  assert.equal(reloaded.linkedAccounts[0].id, linked.id);
  assert.equal(reloaded.linkedAccounts[0].profileDirectory, linked.profileDirectory);
  assert.equal(reloaded.persons[0].id, person.id);
  assert.equal(reloaded.persons[0].platforms[0].folderName, "Custom Gallery");
  assert.equal(reloaded.persons[0].platforms[0].accounts[0].linkedAccountId, linked.id);
});

test("cross-domain targets and cross-platform linked accounts are rejected before creating folders or launching browsers", async (t) => {
  const app = await fixture(t);
  const platform = await app.addPlatform();
  const customLogin = await app.addLinked(platform.id);
  const xLogin = await app.addLinked("x");
  const badDomain = await app.api("/api/persons", "POST", app.personBody(platform, { profileUrl: "https://example.org/creator" }));
  assert.equal(badDomain.status, 400);
  assert.match(badDomain.body.error, /域名/);
  const badLogin = await app.api("/api/persons", "POST", app.personBody(platform, { linkedAccountId: xLogin.id }));
  assert.equal(badLogin.status, 400);
  assert.match(badLogin.body.error, /其他平台/);
  assert.equal((await app.api(`/api/platforms/${platform.id}/probe`, "POST", {
    profileUrl: "https://example.org/creator",
  })).status, 400);
  assert.equal((await app.api(`/api/platforms/${platform.id}/probe`, "POST", {
    profileUrl: "https://example.com/creator", linkedAccountId: xLogin.id,
  })).status, 400);
  assert.equal((await app.api(`/api/platforms/${platform.id}/probe`, "POST", {
    profileUrl: "https://example.com/creator", linkedAccountId: customLogin.id,
  })).status, 409);
  assert.equal((await app.api(`/api/linked-accounts/${customLogin.id}/open-target`, "POST", {
    profileUrl: "https://example.org/creator",
  })).status, 400);
  assert.equal((await app.api(`/api/linked-accounts/${customLogin.id}`, "PUT", { platformId: "x" })).status, 400);
  await assert.rejects(stat(path.join(app.root, "archive")), { code: "ENOENT" });
  assert.equal((await app.api("/api/state")).body.persons.length, 0);
  const valid = await app.api("/api/persons", "POST", app.personBody(platform, { linkedAccountId: customLogin.id }));
  assert.equal(valid.status, 201);
  for (const invalidAccount of [{ profileUrl: "https://example.org/creator" }, { linkedAccountId: xLogin.id }]) {
    const changed = await app.api(`/api/persons/${valid.body.id}`, "PUT", app.personBody(platform, {
      linkedAccountId: customLogin.id, ...invalidAccount,
    }));
    assert.equal(changed.status, 400);
  }
  const unchanged = (await app.api("/api/state")).body.persons[0];
  assert.equal(unchanged.platforms[0].accounts[0].profileUrl, "https://example.com/creator");
  assert.equal(unchanged.platforms[0].accounts[0].linkedAccountId, customLogin.id);
});

test("custom verification without a login marker returns false without DNS, browser launch, or profile creation", async (t) => {
  const app = await fixture(t);
  const platform = await app.addPlatform();
  const linked = await app.addLinked(platform.id);
  const result = await app.api(`/api/linked-accounts/${linked.id}/verify-login`, "POST", {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.verified, false);
  assert.equal(result.body.loginStatus, "failed");
  assert.match(result.body.loginMessage, /尚未配置登录验证规则/);
  await assert.rejects(stat(linked.profileDirectory), { code: "ENOENT" });
  const saved = (await app.api("/api/state")).body.linkedAccounts.find(({ id }) => id === linked.id);
  assert.equal(saved.loginStatus, "failed");
  assert.ok(saved.loginCheckedAt);
});

test("verification rule changes invalidate a prior verified result while display-only edits preserve it", async (t) => {
  const app = await fixture(t);
  const platform = await app.addPlatform({ loginMarker: "#my-account", verificationUrl: "https://example.com/account" });
  const linked = await app.addLinked(platform.id);
  const fixtureState = JSON.parse(await readFile(app.stateFile, "utf8"));
  Object.assign(fixtureState.linkedAccounts.find(({ id }) => id === linked.id), {
    loginStatus: "verified", loginCheckedAt: "2026-09-29T00:00:00.000Z", loginMessage: "Fixture verified marker",
  });
  await writeFile(app.stateFile, `${JSON.stringify(fixtureState, null, 2)}\n`, "utf8");
  const displayOnly = await app.api(`/api/platforms/${platform.id}`, "PUT", { label: "Display Changed" });
  assert.equal(displayOnly.status, 200);
  assert.equal(displayOnly.body.linkedAccounts[0].loginStatus, "verified");
  const changedRule = await app.api(`/api/platforms/${platform.id}`, "PUT", { loginMarker: "#new-account-menu" });
  assert.equal(changedRule.status, 200);
  assert.equal(changedRule.body.linkedAccounts[0].loginStatus, "unverified");
  assert.equal(changedRule.body.linkedAccounts[0].loginCheckedAt, null);
  assert.match(changedRule.body.linkedAccounts[0].loginMessage, /重新验证/);
  const saved = JSON.parse(await readFile(app.stateFile, "utf8"));
  assert.equal(saved.linkedAccounts[0].loginStatus, "unverified");
  assert.equal(saved.linkedAccounts[0].profileDirectory, linked.profileDirectory);
});

test("engine none probe is explicitly rejected before network, browser, or external downloader execution", async (t) => {
  const app = await fixture(t);
  const platform = await app.addPlatform({ engine: "none" });
  const result = await app.api(`/api/platforms/${platform.id}/probe`, "POST", { profileUrl: "https://example.com/creator" });
  if (result.status === 200) {
    assert.equal(result.body.ok, false);
    assert.match(result.body.message || result.body.error || "", /引擎|采集方式|未启用|未配置|不支持/);
  } else {
    assert.ok([400, 422, 503].includes(result.status), JSON.stringify(result));
    assert.match(result.body.error, /引擎|采集方式|未启用|未配置|不支持/);
  }
});

test("built-in account creation remains available and custom configuration rejects local URLs or duplicate built-in names", async (t) => {
  const app = await fixture(t);
  const xLogin = await app.addLinked("x", "Built-in viewer");
  const builtIn = await app.api("/api/persons", "POST", {
    name: "Built-in creator", folderMode: "new", selectedPath: path.join(app.root, "archive"),
    platforms: [{ id: "x", accounts: [{ label: "creator", linkedAccountId: xLogin.id }] }],
  });
  assert.equal(builtIn.status, 201, JSON.stringify(builtIn.body));
  assert.equal(builtIn.body.platforms[0].id, "x");
  assert.equal(builtIn.body.platforms[0].label, "X");
  assert.equal((await stat(path.join(builtIn.body.folderPath, "Index"))).isDirectory(), true);
  await assert.rejects(stat(path.join(builtIn.body.folderPath, "X")), { code: "ENOENT" });
  const base = { label: "Bad Site", homepageUrl: "https://example.com/", engine: "none" };
  for (const overrides of [{ homepageUrl: "http://127.0.0.1/" }, { homepageUrl: "https://localhost/" }, { label: "X" }, { label: "../escape" }]) {
    assert.equal((await app.api("/api/platforms", "POST", { ...base, ...overrides })).status, 400);
  }
  assert.equal((await app.api("/api/state")).body.customPlatforms.length, 0);
});
