import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeLocalSession, PUBLIC_APPLICATION_ID, SESSION_FILENAME } from "../lib/local-api-security.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function mockOwner(t, { shuttingDown = false, rejectForward = false } = {}) {
  const data = await mkdtemp(path.join(os.tmpdir(), "collector-repeat-exit-"));
  const key = createHash("sha256").update(`${path.resolve(root).toLowerCase()}\0${data.toLowerCase()}`).digest("hex");
  const observed = [];
  const server = http.createServer((request, response) => {
    observed.push({ url: request.url, method: request.method });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/runtime/status") {
      response.end(JSON.stringify({ id: "builtin-chromium", applicationId: PUBLIC_APPLICATION_ID, instanceKey: key, windowLifecycleVersion: 1,
        shuttingDown, windowOpen: true }));
      return;
    }
    if (request.url === "/api/runtime/open-window" && request.method === "POST") {
      response.writeHead(rejectForward ? 503 : 200);
      // Exercise cancellation while a local HTTP transport is still closing;
      // do not open a browser or access any actual profiles/media.
      response.write('{"ok":true}');
      const timer = setTimeout(() => response.end(), 500);
      response.once("close", () => clearTimeout(timer));
      request.resume();
      return;
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeLocalSession(data, { applicationId: PUBLIC_APPLICATION_ID, instanceKey: key,
    token: "a".repeat(64), port: server.address().port, pid: process.pid });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  });
  return { data, port: server.address().port, observed };
}

function launch(entry, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, windowsHide: true,
      env: { ...process.env, MEDIA_TRACKER_PORT: String(fixture.port), MEDIA_TRACKER_DATA_DIR: fixture.data,
        MEDIA_TRACKER_PORTABLE_ROOT: "", MEDIA_TRACKER_NO_OPEN: "0", MEDIA_TRACKER_READY_FILE: "", MEDIA_TRACKER_READY_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Repeat forwarding did not exit naturally. " + stdout + stderr)); }, 15000);
    child.on("error", reject);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test("direct server and bootstrap repeat forwarding drain local transport and exit without starting resources", async (t) => {
  const fixture = await mockOwner(t);
  for (const entry of ["server.mjs", "scripts/start-service.mjs"]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await launch(entry, fixture);
      assert.equal(result.code, 0, entry + "\n" + result.stdout + result.stderr);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /Media Tracker 已经在运行/);
      assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING|libuv/i);
    }
  }
  assert.equal(fixture.observed.filter((request) => request.url === "/api/runtime/open-window").length, 10);
  assert.deepEqual(await readdir(fixture.data), [SESSION_FILENAME], "repeat startup never initializes stores or profile directories");
});

test("refused or closing owners exit with an ordinary failure and do not start another service", async (t) => {
  for (const options of [{ shuttingDown: true }, { rejectForward: true }]) {
    const fixture = await mockOwner(t, options);
    for (const entry of ["server.mjs", "scripts/start-service.mjs"]) {
      const result = await launch(entry, fixture);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING|libuv/i);
    }
    assert.deepEqual(await readdir(fixture.data), [SESSION_FILENAME]);
  }
});

test("startup forwarding and listen races delegate exit without unconditional process.exit", async () => {
  const source = await readFile(path.join(root, "server.mjs"), "utf8");
  assert.doesNotMatch(source, /process\.exit\(/);
  assert.match(source, /process\.exitCode = 0;\s*\} else \{/);
  assert.match(source, /shutdownRuntime\("repeat-launch-forwarded", 0\)/);
  assert.match(source, /shutdownRuntime\("listen-failed", 1\)/);
  assert.match(source, /finalizeRuntimeExit\(\{ server, exitCode, releaseGate: releaseStartupGateSync \}\)/);
});
