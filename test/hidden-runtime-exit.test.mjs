import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const windowsRoot = process.env.SystemRoot || "C:\\Windows";
const powershell = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, message, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function availablePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

test("hidden Windows launcher exits with its service and preserves offline configuration, index and media", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async (t) => {
  // The fixture never exercises the launcher's dependency-install fallback:
  // unavailable local runtimes skip instead of creating any network traffic.
  try {
    await access(powershell);
    const { chromium } = await import("playwright");
    await access(chromium.executablePath());
  } catch { t.skip("Required local Windows/Chromium runtime is not installed."); return; }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-hidden-runtime-exit-"));
  const data = path.join(temporary, "isolated data");
  const profile = path.join(data, "browser-profiles", "x", "offline-fixture");
  const mediaDirectory = path.join(temporary, "archive", "Person", "Video");
  await mkdir(profile, { recursive: true });
  await mkdir(mediaDirectory, { recursive: true });
  const stateFile = path.join(data, "state.json");
  const indexFile = path.join(data, "sync-index.json");
  const mediaFile = path.join(mediaDirectory, "media-sentinel.mp4");
  const profileFile = path.join(profile, "login-sentinel.txt");
  const stateBytes = JSON.stringify({ version: 4, settings: { theme: "dark" }, persons: [], customPlatforms: [],
    linkedAccounts: [{ id: "offline-fixture", platformId: "x", label: "Preserved binding", profileDirectory: profile,
      loginStatus: "verified", loginCheckedAt: "2026-01-01T00:00:00Z" }], recentPaths: [], sentinel: "Preserve configuration" });
  const indexBytes = JSON.stringify({ version: 3, layout: "person-v1", scopes: {
    "old:x:account": { knownPosts: { old: "2026-01-01T00:00:00Z" }, media: {}, hashes: {},
      pendingMedia: { "old:1": { logicalKey: "old:1", postId: "old", lastError: "Offline sentinel" } },
      initialComplete: true, scanCompletedAt: "2026-01-01T00:00:00Z" },
  }, summaries: {}, receipts: {}, storageInitialized: {}, sentinel: "Preserve incremental boundary" });
  const mediaBytes = Buffer.from("Offline media sentinel: no platform download or real archive access.");
  const profileBytes = "Offline login profile sentinel; never launch this profile.";
  await writeFile(stateFile, stateBytes);
  await writeFile(indexFile, indexBytes);
  await writeFile(mediaFile, mediaBytes);
  await writeFile(profileFile, profileBytes);

  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      // Failure cleanup is scoped to the retained launcher process created by
      // this fixture. Its tree contains only its hidden private Node service.
      await run(path.join(windowsRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 }).catch(() => {});
      await bounded(exited.catch(() => {}), "Owned hidden-launcher cleanup timed out", 3_000);
    }
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("collector-hidden-runtime-exit-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", path.join(ROOT, "scripts", "start-hidden.ps1"), "-NoErrorDialog"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});

  await bounded((async () => {
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Hidden launcher exited during startup: ${output}`);
      const response = await fetch(`${origin}/api/runtime/status`, { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok) {
        const runtime = await response.json();
        assert.equal(runtime.id, "builtin-chromium");
        assert.equal(runtime.windowLifecycleVersion, 1);
        assert.equal(runtime.windowOpen, false, "NO_OPEN must not display a browser or access any platform");
        break;
      }
      await pause(25);
    }
  })(), `Hidden launcher did not start its isolated service: ${output}`);
  assert.equal(child.exitCode, null);

  const response = await fetch(`${origin}/api/runtime/exit`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, exiting: true });
  const result = await bounded(exited, `Hidden launcher/service did not terminate: ${output}`);
  assert.deepEqual(result, { code: 0, signal: null }, output);
  await assert.rejects(fetch(`${origin}/api/runtime/status`, { signal: AbortSignal.timeout(1_000) }));

  assert.equal(await readFile(stateFile, "utf8"), stateBytes);
  assert.equal(await readFile(indexFile, "utf8"), indexBytes);
  assert.deepEqual(await readFile(mediaFile), mediaBytes);
  assert.equal(await readFile(profileFile, "utf8"), profileBytes);
  const logNames = await readdir(path.join(data, "startup-logs"));
  const outLogs = logNames.filter((name) => name.endsWith(".out.log"));
  const errLogs = logNames.filter((name) => name.endsWith(".err.log"));
  assert.equal(outLogs.length, 1); assert.equal(errLogs.length, 1);
  const logs = await readFile(path.join(data, "startup-logs", outLogs[0]), "utf8");
  assert.match(logs, /Starting Media Tracker without a console window/);
  assert.match(logs, /\[startup\] launcher-ready elapsed=\d+ms/);
  assert.match(logs, /\[startup\] bootstrap-start elapsed=\d+ms/);
  assert.match(logs, /\[startup\] runtime-ready elapsed=\d+ms/);
  assert.match(logs, /\[startup\] launcher-exited elapsed=\d+ms/);
  assert.match(logs, /Media Tracker 已启动：/);
  assert.match(logs, /正在完整退出采集工具（explicit-exit）/);
  assert.match(logs, /采集工具已完整退出，后台服务已停止/);
  assert.equal(await readFile(path.join(data, "startup-logs", errLogs[0]), "utf8"), "");
  assert.equal(output, "", "Hidden launcher should route service output into its own logs");
  assert.deepEqual((await readdir(data)).sort(), ["browser-profiles", "startup-logs", "state.json", "sync-index.json"]);
});
