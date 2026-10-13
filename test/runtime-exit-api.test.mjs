import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, description, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, { indexVersion = 3 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-runtime-api-"));
  const dataDirectory = path.join(root, "data");
  const archiveDirectory = path.join(root, "archive", "Person", "Image");
  await mkdir(dataDirectory);
  await mkdir(archiveDirectory, { recursive: true });
  const stateFile = path.join(dataDirectory, "state.json");
  const indexFile = path.join(dataDirectory, "sync-index.json");
  const mediaFile = path.join(archiveDirectory, "media-sentinel.jpg");
  const stateBytes = JSON.stringify({ version: 4, settings: { theme: "dark" }, persons: [], linkedAccounts: [],
    customPlatforms: [], recentPaths: [], sentinel: "Do not rewrite settings" });
  const indexBytes = JSON.stringify({ version: indexVersion, layout: "person-v1", scopes: {
    "preserved:x:target": { knownPosts: { old: "2026-01-01T00:00:00Z" }, media: {}, hashes: {},
      pendingMedia: { "old:1": { logicalKey: "old:1", postId: "old", lastError: "Fixture failure" } },
      initialComplete: true, scanCompletedAt: "2026-01-01T00:00:00Z" },
  }, summaries: {}, receipts: {}, storageInitialized: {}, sentinel: "Keep incremental data" });
  const mediaBytes = Buffer.from("Offline media sentinel, never uploaded or deleted.");
  await writeFile(stateFile, stateBytes);
  await writeFile(indexFile, indexBytes);
  await writeFile(mediaFile, mediaBytes);
  const children = [];
  t.after(async () => {
    // Every process and directory here was created by this exact fixture.
    // Never enumerate or terminate the user's actual tool or browser processes.
    for (const service of children) {
      if (service.child.exitCode === null && service.child.signalCode === null) {
        service.child.kill();
        await bounded(service.exited.catch(() => {}), "Fixture service cleanup timed out", 5_000);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDirectory, stateFile, indexFile, mediaFile, stateBytes, indexBytes, mediaBytes, children };
}

function launch(setup, port) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: setup.dataDirectory, MEDIA_TRACKER_PORT: String(port),
      MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const service = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { service.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { service.stderr += chunk.toString(); });
  service.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  service.exited.catch(() => {});
  setup.children.push(service);
  return service;
}

async function started(service) {
  await bounded((async () => {
    while (!service.stdout.includes("Media Tracker 已启动：")) {
      if (service.child.exitCode !== null || service.child.signalCode !== null) {
        throw new Error(`Fixture service exited during startup: ${service.stderr}`);
      }
      await pause(10);
    }
  })(), `Fixture startup timed out: ${service.stderr}`);
}

async function unchanged(setup) {
  assert.equal(await readFile(setup.stateFile, "utf8"), setup.stateBytes);
  assert.equal(await readFile(setup.indexFile, "utf8"), setup.indexBytes);
  assert.deepEqual(await readFile(setup.mediaFile), setup.mediaBytes);
}

async function closeService(service, origin) {
  const response = await fetch(`${origin}/api/runtime/exit`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, exiting: true });
  const outcome = await bounded(service.exited, `Fixture exit timed out: ${service.stderr}`);
  assert.equal(outcome.code, 0, service.stderr);
  assert.equal(outcome.signal, null);
  assert.match(service.stdout, /采集工具已完整退出，后台服务已停止/);
  await assert.rejects(fetch(`${origin}/api/runtime/status`, { signal: AbortSignal.timeout(1_000) }));
}

async function fakeTracker(t, runtime) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const statusSupported = runtime.windowLifecycleVersion === 1;
    response.writeHead(request.url === "/api/runtime/status" && !statusSupported ? 404 : 200,
      { "Content-Type": "application/json", "Connection": "close" });
    response.end(JSON.stringify(request.url === "/api/runtime/status" && statusSupported
      ? { ...runtime, shuttingDown: false, windowOpen: false } : { runtime }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { port: server.address().port, requests, server };
}

test("full-exit API validates origin and exact confirmation, stops its listener, and restart loads current cache APIs without touching media/index/settings", { timeout: 20_000 }, async (t) => {
  const setup = await fixture(t);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const first = launch(setup, port);
  await started(first);
  const runtime = await fetch(`${origin}/api/runtime/status`).then((response) => response.json());
  assert.equal(runtime.id, "builtin-chromium");
  assert.equal(runtime.windowLifecycleVersion, 1);
  assert.equal(runtime.instanceKey, createHash("sha256").update(`${ROOT.toLowerCase()}\0${setup.dataDirectory.toLowerCase()}`).digest("hex"));
  assert.equal(runtime.shuttingDown, false);
  assert.equal(runtime.windowOpen, false, "NO_OPEN fixtures cannot launch Chrome or use real profiles");
  const headers = { Origin: origin, "Content-Type": "application/json" };
  for (const body of [{}, null, [], { confirm: false }, { confirm: "true" }, { confirm: true, path: setup.root }]) {
    const response = await fetch(`${origin}/api/runtime/exit`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const foreign = await fetch(`${origin}/api/runtime/exit`, { method: "POST",
    headers: { ...headers, Origin: "https://unrelated.invalid" }, body: JSON.stringify({ confirm: true }) });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${origin}/api/runtime/status`).then((response) => response.json())).shuttingDown, false);
  await unchanged(setup);
  await closeService(first, origin);
  await unchanged(setup);

  const restarted = launch(setup, port);
  await started(restarted);
  const preview = await fetch(`${origin}/api/cache/preview`, { headers: { Origin: origin } });
  assert.equal(preview.status, 200);
  const report = await preview.json();
  assert.equal(report.status, "empty");
  assert.equal(report.totalBytes, 0);
  assert.deepEqual(report.profiles, []);
  await unchanged(setup);
  await closeService(restarted, origin);
  await unchanged(setup);
});

test("repeat launch delegates to the existing owner before opening another store or startup gate", { timeout: 15_000 }, async (t) => {
  const setup = await fixture(t);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const owner = launch(setup, port);
  await started(owner);
  const gateFile = path.join(setup.dataDirectory, ".readable-names-maintenance.lock");
  const gateBytes = JSON.stringify({ token: "fixture-maintenance-gate", operation: "test-only" });
  await writeFile(gateFile, gateBytes, { flag: "wx" });
  const duplicate = launch(setup, port);
  assert.equal((await bounded(duplicate.exited, "Duplicate launch did not delegate")).code, 0, duplicate.stderr);
  assert.match(duplicate.stdout, /Media Tracker 已经在运行/);
  assert.doesNotMatch(duplicate.stdout, /Media Tracker 已启动：/);
  assert.equal(owner.child.exitCode, null);
  assert.equal((await fetch(`${origin}/api/runtime/status`)).status, 200);
  assert.equal(await readFile(gateFile, "utf8"), gateBytes);
  await unchanged(setup);
  await unlink(gateFile);
  await closeService(owner, origin);
  await unchanged(setup);
});

test("foreign legacy service is never reused or privately inspected and the maintenance gate preserves sentinel data", { timeout: 10_000 }, async (t) => {
  const setup = await fixture(t, { indexVersion: 1 });
  const fake = await fakeTracker(t, { id: "builtin-chromium", label: "Legacy fixture" });
  const gateFile = path.join(setup.dataDirectory, ".readable-names-maintenance.lock");
  const gateBytes = JSON.stringify({ token: "legacy-fixture-sentinel" });
  await writeFile(gateFile, gateBytes);
  const child = launch(setup, fake.port);
  assert.equal((await bounded(child.exited, "Legacy preflight did not fail")).code, 1);
  assert.match(child.stderr, /索引维护或工具启动正在进行/);
  assert.doesNotMatch(child.stdout, /已启动/);
  assert.equal(await readFile(gateFile, "utf8"), gateBytes);
  assert.deepEqual((await readdir(setup.dataDirectory)).sort(), [".readable-names-maintenance.lock", "state.json", "sync-index.json"]);
  await unchanged(setup);
  assert.deepEqual(fake.requests, [{ method: "GET", url: "/api/runtime/status" }]);
});

test("a foreign data-directory instance is never reused or sent window/exit operations on an occupied configured port", { timeout: 10_000 }, async (t) => {
  const setup = await fixture(t);
  const fake = await fakeTracker(t, { id: "builtin-chromium", windowLifecycleVersion: 1, instanceKey: "0".repeat(64) });
  const child = launch(setup, fake.port);
  assert.equal((await bounded(child.exited, "Foreign-instance port collision did not fail")).code, 1);
  assert.match(child.stderr, /无法监听.*EADDRINUSE/);
  assert.doesNotMatch(child.stdout, /已经在运行|已启动/);
  assert.ok(fake.requests.length >= 2);
  assert.ok(fake.requests.every(({ method, url }) => method === "GET" && url === "/api/runtime/status"));
  assert.equal((await fetch(`http://127.0.0.1:${fake.port}/api/state`)).status, 200, "the unrelated owner must still be running");
  await unchanged(setup);
  assert.deepEqual((await readdir(setup.dataDirectory)).sort(), ["state.json", "sync-index.json"]);
});

test("immediate reopen during graceful shutdown is refused without reopening stores or launching a replacement service", { timeout: 15_000 }, async (t) => {
  const setup = await fixture(t);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const owner = launch(setup, port);
  await started(owner);
  // Node's 100 Continue guarantees the server has received and emitted this
  // request. Leave its JSON body unfinished to hold an already-active handler,
  // rather than relying on timing or a real platform/browser operation.
  const request = http.request(`${origin}/api/runtime/open-window`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", Expect: "100-continue",
    "X-Media-Tracker-Token": (await (await globalThis.fetch(`${origin}/api/session`)).json()).token,
  } });
  t.after(() => request.destroy());
  const accepted = new Promise((resolve, reject) => { request.once("continue", resolve); request.once("error", reject); });
  const pendingResponse = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, body }));
      response.once("error", reject);
    });
  });
  pendingResponse.catch(() => {});
  request.flushHeaders();
  await bounded(accepted, "Fixture pending request was not accepted", 5_000);
  request.write("{");

  const exitResponse = await fetch(`${origin}/api/runtime/exit`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  assert.equal(exitResponse.status, 202);
  assert.deepEqual(await exitResponse.json(), { ok: true, exiting: true });
  const statusResponse = await fetch(`${origin}/api/runtime/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).shuttingDown, true);
  assert.equal((await fetch(`${origin}/api/state`)).status, 503);
  assert.equal(owner.child.exitCode, null, "owner must wait for its accepted request to settle");

  const gateFile = path.join(setup.dataDirectory, ".readable-names-maintenance.lock");
  const gateBytes = JSON.stringify({ token: "shutdown-fixture-sentinel" });
  await writeFile(gateFile, gateBytes, { flag: "wx" });
  const duplicate = launch(setup, port);
  assert.equal((await bounded(duplicate.exited, "Reopen during shutdown was not refused")).code, 1);
  assert.match(duplicate.stderr, /正在完整退出/);
  assert.doesNotMatch(duplicate.stdout, /已经在运行|已启动/);
  assert.equal(await readFile(gateFile, "utf8"), gateBytes);
  await unchanged(setup);

  request.end("}");
  const pending = await bounded(pendingResponse, "Accepted request did not finish after body release");
  assert.equal(pending.status, 503);
  assert.match(pending.body, /正在完整退出/);
  const outcome = await bounded(owner.exited, `Owner failed to exit: ${owner.stderr}`);
  assert.equal(outcome.code, 0, owner.stderr);
  assert.match(owner.stdout, /采集工具已完整退出，后台服务已停止/);
  await unchanged(setup);
  assert.equal(await readFile(gateFile, "utf8"), gateBytes);
  await assert.rejects(fetch(`${origin}/api/runtime/status`, { signal: AbortSignal.timeout(1_000) }));
});
