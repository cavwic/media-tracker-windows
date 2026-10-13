import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { assertReadableRebuildStopped } from "../scripts/rebuild-readable-names.mjs";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (listening) => { socket.destroy(); resolve(listening); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

test("server startup respects the maintenance gate without touching configuration or synchronization records", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "media-tracker-startup-gate-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const state = '{"persons":[],"linkedAccounts":[]}';
  const index = '{"version":3,"layout":"person-v1","scopes":{},"summaries":{},"receipts":{},"storageInitialized":{}}';
  const lock = '{"token":"fixture-maintenance","pid":1}';
  await writeFile(path.join(data, "state.json"), state);
  await writeFile(path.join(data, "sync-index.json"), index);
  await writeFile(path.join(data, ".readable-names-maintenance.lock"), lock);
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.mjs"], { cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.notEqual(code, 0);
  assert.match(output, /索引维护或工具启动正在进行/);
  assert.equal(await readFile(path.join(data, "state.json"), "utf8"), state);
  assert.equal(await readFile(path.join(data, "sync-index.json"), "utf8"), index);
  assert.equal(await readFile(path.join(data, ".readable-names-maintenance.lock"), "utf8"), lock);
});

test("offline rebuild refuses this project's bootstrap process even before a listener exists", {
  skip: process.platform !== "win32", timeout: 35_000,
}, async (t) => {
  // This specifically exercises the pre-listener process guard. Do not query
  // a real app's private /api/state, stop it, or mistake its earlier live-port
  // guard for a failure of this isolated bootstrap assertion.
  const candidates = [4178, ...Array.from({ length: 10 }, (_, index) => 43178 + index)];
  if ((await Promise.all(candidates.map(portIsListening))).some(Boolean)) {
    t.skip("A live service occupies a tracker port; keep it untouched and defer the pre-listener fixture.");
    return;
  }
  const bootstrap = path.resolve(import.meta.dirname, "../scripts/start-service.mjs");
  // A harmless owned stand-in holds the new absolute entrypoint in its command
  // line. It imports nothing, creates no service/profile, and never reads data.
  const child = spawn(process.execPath, ["-e", "console.log('READY'); setInterval(() => {}, 1000)", bootstrap], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned process did not become ready")), 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError); child.off("exit", onExit); child.stdout.off("data", onData);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error("Owned process exited before ready")); };
    const onData = () => { cleanup(); resolve(); };
    child.once("error", onError); child.once("exit", onExit); child.stdout.once("data", onData);
  });
  await assert.rejects(assertReadableRebuildStopped(), /本项目服务进程仍在运行/);
});
