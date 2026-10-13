import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir, symlink } from "node:fs/promises";
import { LocalApiSecurity, SESSION_HEADER, PUBLIC_APPLICATION_ID, SESSION_FILENAME,
  writeLocalSession, readLocalSession, removeLocalSessionSync, assertPublicPortableRoot } from "../lib/local-api-security.mjs";
import { inspectRunningTracker } from "../lib/running-tracker.mjs";

const port = 43178;
const origin = `http://127.0.0.1:${port}`;
const token = "a".repeat(64);
const instanceKey = "b".repeat(64);
const request = (headers = {}, changes = {}) => ({ method: "GET", url: "/api/state", headers: { host: `127.0.0.1:${port}`, ...headers }, ...changes });
const throws403 = (fn) => assert.throws(fn, (error) => error.status === 403);

test("private reads and writes require the same cryptographic local session token", () => {
  const guard = new LocalApiSecurity({ token });
  for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    throws403(() => guard.assertAuthenticated(request({}, { method }), port));
    throws403(() => guard.assertAuthenticated(request({ "x-media-tracker-token": "c".repeat(64) }, { method }), port));
    assert.doesNotThrow(() => guard.assertAuthenticated(request({ "x-media-tracker-token": token }, { method }), port));
  }
  for (const supplied of [token.toUpperCase(), `${token},${token}`, "short", [token], null]) {
    throws403(() => guard.assertAuthenticated(request({ "x-media-tracker-token": supplied }), port));
  }
});

test("foreign and same-site-but-cross-origin pages cannot obtain bootstrap or send a forged token", () => {
  const guard = new LocalApiSecurity({ token });
  const hostile = [{ origin: "https://example.com" }, { origin: "null" }, { origin: "http://127.0.0.1:4178" },
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-dest": "iframe" },
    { host: `evil.test:${port}` }, { host: `localhost:${port}` }, { host: "127.0.0.1" }, { host: [`127.0.0.1:${port}`] }];
  for (const headers of hostile) {
    throws403(() => guard.bootstrap(request(headers, { url: "/api/session" }), port));
    throws403(() => guard.assertAuthenticated(request({ ...headers, "x-media-tracker-token": token }), port));
  }
  throws403(() => guard.assertLocalRequest(request({}, { rawHeaders: ["Host", `127.0.0.1:${port}`, "Host", `127.0.0.1:${port}`] }), port));
  throws403(() => guard.assertLocalRequest(request({}, { url: "http://evil.test/api/state" }), port));
});

test("bootstrap accepts same-origin UI or explicit local CLI only and has no arbitrary command parameters", () => {
  const guard = new LocalApiSecurity({ token });
  for (const headers of [{}, { origin }, { origin, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }]) {
    assert.deepEqual(guard.bootstrap(request(headers, { url: "/api/session" }), port), { token, header: SESSION_HEADER, applicationId: PUBLIC_APPLICATION_ID });
  }
  throws403(() => guard.bootstrap(request({}, { method: "POST", url: "/api/session" }), port));
  throws403(() => guard.bootstrap(request({}, { url: "/api/session?path=C:/data" }), port));
  assert.notEqual(new LocalApiSecurity().token, new LocalApiSecurity().token);
});

test("portable public data root is tied to this package and cannot use another tool's portable root", () => {
  const root = path.resolve(os.tmpdir(), "public-package");
  const paths = { portable: true, portableRoot: root, dataDirectory: path.join(root, "data") };
  assert.doesNotThrow(() => assertPublicPortableRoot(path.join(root, "app"), paths));
  assert.doesNotThrow(() => assertPublicPortableRoot(root, paths));
  assert.throws(() => assertPublicPortableRoot(path.resolve(os.tmpdir(), "other-app"), paths), /本软件目录/);
  assert.throws(() => assertPublicPortableRoot(root, { ...paths, dataDirectory: path.join(root, "other-data") }), /本软件目录/);
});

test("session is protected before secret bytes are written; ordinary restart checks and owned cleanup preserve replacements", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { applicationId: PUBLIC_APPLICATION_ID, instanceKey, token, port, pid: process.pid };
  let protectedEmptyFile = false;
  await writeLocalSession(root, record, { protectFile: async (file) => {
    assert.equal((await stat(file)).size, 0);
    protectedEmptyFile = true;
  } });
  assert.equal(protectedEmptyFile, true);
  assert.deepEqual(await readLocalSession(root, { instanceKey, port }), record);
  await assert.rejects(readLocalSession(root, { instanceKey: "c".repeat(64), port }), /身份不匹配/);
  assert.equal(removeLocalSessionSync(root, "c".repeat(64)), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, SESSION_FILENAME), "utf8")), record);
  assert.equal(removeLocalSessionSync(root, token), true);
  assert.equal(removeLocalSessionSync(root, token), false);
});

test("failed protection never writes a secret or replaces a previous record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { applicationId: PUBLIC_APPLICATION_ID, instanceKey, token, port };
  await writeFile(path.join(root, SESSION_FILENAME), JSON.stringify(previous), { mode: 0o600 });
  await assert.rejects(writeLocalSession(root, { ...previous, token: "c".repeat(64) }, { protectFile: async (file) => {
    assert.equal((await stat(file)).size, 0); throw new Error("Permissions unavailable");
  } }), /Permissions unavailable/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, SESSION_FILENAME), "utf8")), previous);
  assert.deepEqual(await readdir(root), [SESSION_FILENAME]);
});

test("public runtime inspection refuses private-edition identity without reading its private state", async () => {
  const calls = [];
  assert.equal(await inspectRunningTracker(port, { applicationId: PUBLIC_APPLICATION_ID, fetch: async (url) => {
    calls.push(url); return new Response(JSON.stringify({ id: "builtin-chromium", instanceKey }), { status: 200 });
  } }), false);
  assert.deepEqual(calls, [`${origin}/api/runtime/status`]);
});
