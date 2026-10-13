import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { SESSION_FILENAME, PUBLIC_APPLICATION_ID } from "../lib/local-api-security.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IO_GUARD = `
  import cp from 'node:child_process';
  import dns from 'node:dns/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const deny = () => { console.error('PUBLIC_API_FORBIDDEN_EXTERNAL_IO'); throw new Error('PUBLIC_API_FORBIDDEN_EXTERNAL_IO'); };
  const execFile = cp.execFile;
  cp.execFile = (file, args, ...rest) => /\\\\(?:whoami|icacls)\\.exe$/i.test(file) ? execFile(file, args, ...rest) : deny();
  cp.execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => new Promise((resolve, reject) =>
    cp.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  cp.spawn = cp.exec = cp.fork = deny;
  dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = deny;
  syncBuiltinESMExports();
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, options) => new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname === '127.0.0.1' ? fetch(input, options) : deny();
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-api-security-"));
  const data = path.join(root, "data"); await mkdir(data);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(IO_GUARD)}`, path.join(ROOT, "server.mjs")], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, MEDIA_TRACKER_PORTABLE_ROOT: "", MEDIA_TRACKER_DATA_DIR: data,
      MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1",
      MEDIA_TRACKER_SYSTEM_UI_LANGUAGE: "en-US" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  t.after(async () => {
    if (child.exitCode === null) child.kill(); await exited;
    assert.doesNotMatch(output, /PUBLIC_API_FORBIDDEN_EXTERNAL_IO/);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  while (!output.includes("Media Tracker 已启动：")) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Fixture did not start: " + output);
    await pause(10);
  }
  const response = await fetch(`${origin}/api/session`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  const session = await response.json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-Media-Tracker-Token": session.token };
  return { root, data, origin, session, headers, child, exited, output: () => output };
}

test("real service protects all private APIs, bootstrap, static pages and startup identity without leaking credentials", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(f.session.applicationId, PUBLIC_APPLICATION_ID);
  assert.match(f.session.token, /^[a-f0-9]{64}$/);
  for (const route of ["/api/state", "/api/cache/preview", "/api/dedup-status", "/api/release-policy"]) {
    const response = await fetch(f.origin + route);
    assert.equal(response.status, 403, route);
    assert.equal((await response.json()).code, "local-session-required");
  }
  for (const headers of [{ Origin: "https://example.com" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Dest": "iframe" }]) {
    for (const route of ["/api/session", "/api/state", "/"]) {
      assert.equal((await fetch(f.origin + route, { headers: { ...f.headers, ...headers } })).status, 403, route);
    }
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + "/api/runtime/status", { headers: { Host: "evil.test" } }, (response) => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    }); request.once("error", reject);
  });
  assert.equal(hostStatus, 403);
  const runtime = await (await fetch(f.origin + "/api/runtime/status")).json();
  assert.deepEqual(Object.keys(runtime).sort(), ["applicationId", "id", "instanceKey", "release", "shuttingDown", "systemLanguage", "windowLifecycleVersion", "windowOpen"]);
  assert.doesNotMatch(JSON.stringify(runtime), /token|browser-profiles|linkedAccounts|persons|settings/);
  assert.doesNotMatch(f.output(), new RegExp(f.session.token));
  const state = await fetch(f.origin + "/api/state", { headers: f.headers }); assert.equal(state.status, 200);
  assert.equal(state.headers.get("Cache-Control"), "no-store"); assert.equal(state.headers.get("X-Frame-Options"), "DENY");
  const record = JSON.parse(await readFile(path.join(f.data, SESSION_FILENAME), "utf8"));
  assert.equal(record.token, f.session.token);
  const exit = await fetch(f.origin + "/api/runtime/exit", { method: "POST", headers: f.headers, body: '{"confirm":true}' });
  assert.equal(exit.status, 202); assert.equal(await f.exited, 0);
  await assert.rejects(stat(path.join(f.data, SESSION_FILENAME)), { code: "ENOENT" });
});

test("first network action is rejected before DNS or browser access; acknowledgement is versioned and not platform authorization", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const before = await (await fetch(f.origin + "/api/release-policy", { headers: f.headers })).json();
  assert.equal(before.acknowledged, false); assert.equal(before.platformAuthorizationVerified, false);
  for (const route of ["/api/homepages/analyze", "/api/sync-all", "/api/persons/fixture/sync", "/api/persons/fixture/recheck",
    "/api/persons/fixture/open-post", "/api/linked-accounts/fixture/open-login", "/api/linked-accounts/fixture/verify-login", "/api/platforms/fixture/probe"]) {
    const response = await fetch(f.origin + route, { method: "POST", headers: f.headers, body: '{"url":"https://example.com"}' });
    assert.equal(response.status, 428, route); assert.equal((await response.json()).code, "PUBLIC_USE_ACK_REQUIRED");
  }
  const unapproved = await fetch(f.origin + "/api/release-policy", { method: "POST", headers: f.headers, body: '{"acknowledged":false,"version":1}' });
  assert.equal(unapproved.status, 400);
  assert.equal((await (await fetch(f.origin + "/api/release-policy", { headers: f.headers })).json()).acknowledged, false);
  const accepted = await fetch(f.origin + "/api/release-policy", { method: "POST", headers: f.headers, body: '{"acknowledged":true,"version":1}' });
  assert.equal(accepted.status, 200); const acknowledged = await accepted.json();
  assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.platformAuthorizationVerified, false);
  const attemptedSettingsBypass = await fetch(f.origin + "/api/settings", { method: "PUT", headers: f.headers,
    body: '{"publicReleaseUse":{"version":1,"acceptedAt":"2026-10-12T00:00:00Z"}}' });
  assert.equal(attemptedSettingsBypass.status, 400);
  const state = await (await fetch(f.origin + "/api/state", { headers: f.headers })).json();
  assert.deepEqual(state.releasePolicy, acknowledged);
});
