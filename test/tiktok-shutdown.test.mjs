import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { isCurrentCollectorTikTokSession } from "../lib/tiktok-browser.mjs";

const moduleUrl = pathToFileURL(path.resolve("lib/tiktok-browser.mjs"));
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const script = path.resolve("scripts/tiktok-background-browser.ps1");
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function connect(port) {
  const response = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1000) });
  const endpoint = (await response.json()).webSocketDebuggerUrl;
  return chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 3000 });
}
async function cleanupTemporary(profile, observers, children, api) {
  for (const browser of observers) {
    if (!browser?.isConnected()) continue;
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await cdp?.send("Browser.close").catch(() => {});
    await browser.close().catch(() => {});
  }
  await waitFor(async () => !(await api.dedicatedProfileProcesses(profile)).length, "Temporary browser did not exit")
    .catch(() => { for (const child of children) if (child?.exitCode == null && child?.signalCode == null) child.kill(); });
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith("media-tracker-shutdown-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("full-exit ownership requires current collector identity, not just saved metadata", () => {
  const ownerPid = 501, launchId = "a".repeat(32);
  const profile = path.resolve(os.tmpdir(), "shutdown ownership fixture");
  const session = { mode: "background", backgroundVersion: 1, pid: 101, helperPid: 102, ownerPid, profile,
    port: 43210, launchId, desktopName: "MediaTrackerBackground_" + launchId };
  const proc = { pid: 101, parentPid: 102, port: 43210, executablePath: chromium.executablePath(), backgroundSessionId: launchId };
  const helper = { ProcessId: 102, ParentProcessId: ownerPid, Name: "powershell.exe", ExecutablePath: powershell,
    CommandLine: '"' + powershell + '" -NoProfile -File "' + script + '" -Executable "' + chromium.executablePath()
      + '" -ProfileDirectory "' + profile + '" -Port 43210 -LaunchId ' + launchId };
  assert.equal(isCurrentCollectorTikTokSession(session, proc, helper, profile, ownerPid), true);
  assert.equal(isCurrentCollectorTikTokSession({ ...session, ownerPid: 502 }, proc, helper, profile, ownerPid), false);
  assert.equal(isCurrentCollectorTikTokSession(session, proc, { ...helper, ParentProcessId: 502 }, profile, ownerPid), false);
  assert.equal(isCurrentCollectorTikTokSession(session, proc, helper, profile + "-other", ownerPid), false);
  assert.equal(isCurrentCollectorTikTokSession({ ...session, ownerPid: undefined }, proc, helper, profile, ownerPid), false);
  const interactive = { ...session, mode: "interactive" };
  const interactiveProc = { ...proc, parentPid: ownerPid, backgroundSessionId: "" };
  assert.equal(isCurrentCollectorTikTokSession(interactive, interactiveProc, null, profile, ownerPid), true);
  assert.equal(isCurrentCollectorTikTokSession(interactive, { ...interactiveProc, parentPid: 999 }, null, profile, ownerPid), false);
  assert.equal(isCurrentCollectorTikTokSession(interactive, proc, null, profile, ownerPid), false);
  assert.equal(isCurrentCollectorTikTokSession(interactive, { ...interactiveProc, executablePath: "chrome.exe" }, null, profile, ownerPid), false);
});

test("shutdown is idempotent and rejects new work without creating profiles", async () => {
  const api = await import(moduleUrl.href + "?empty-shutdown");
  const operation = api.shutdownTikTokSessions();
  assert.equal(api.shutdownTikTokSessions(), operation);
  assert.deepEqual(await operation, { closed: 0, skipped: 0, errors: [] });
  await assert.rejects(api.acquireTikTokPage(), (error) => error.code === "tool-shutting-down");
  await assert.rejects(api.openTikTokLoginWindow(), (error) => error.code === "tool-shutting-down");
  let calls = 0;
  await assert.rejects(api.withIdleTikTokProfile(undefined, () => { calls++; }), (error) => error.code === "tool-shutting-down");
  assert.equal(calls, 0);
});

test("shutdown during a pending acquisition cancels launch and leaves no worker", {
  skip: process.platform !== "win32", timeout: 35_000,
}, async () => {
  const api = await import(moduleUrl.href + "?pending-shutdown");
  const profile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-shutdown-pending-"));
  try {
    const pending = api.acquireTikTokPage({ profileDirectory: profile });
    // Observe the rejection immediately to avoid an unhandled cancellation.
    const observed = pending.then((lease) => ({ lease }), (error) => ({ error }));
    const result = await api.shutdownTikTokSessions();
    const completed = await observed;
    assert.equal(completed.error?.code, "tool-shutting-down");
    assert.deepEqual(result, { closed: 0, skipped: 0, errors: [] });
    assert.equal((await api.dedicatedProfileProcesses(profile)).length, 0);
  } finally { await cleanupTemporary(profile, [], [], api); }
});

test("full exit releases work, closes owned nonempty background sessions, and preserves unowned legacy sessions", {
  skip: process.platform !== "win32", timeout: 65_000,
}, async () => {
  const api = await import(moduleUrl.href + "?owned-shutdown");
  const ownedProfile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-shutdown-owned-中文 空格-"));
  const legacyProfile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-shutdown-legacy-"));
  let ownedObserver, legacyObserver, legacyChild, lease;
  try {
    lease = await api.acquireTikTokPage({ profileDirectory: ownedProfile });
    await lease.page.goto("data:text/html,<title>Local work only</title>");
    const saved = JSON.parse(await readFile(path.join(ownedProfile, "media-tracker-session.json"), "utf8"));
    ownedObserver = await connect(saved.port);
    // Idle cleanup deliberately protects this non-worker page. Full application
    // exit may close it because the entire session was spawned by this process.
    const extraPage = await ownedObserver.contexts()[0].newPage();
    await extraPage.goto("data:text/html,<title>Owned extra page</title>");
    const legacyPort = await freePort();
    legacyChild = spawn(chromium.executablePath(), api.buildTikTokBrowserArgs(legacyProfile, legacyPort, { background: true }),
      { stdio: "ignore", windowsHide: true });
    legacyObserver = await waitFor(() => connect(legacyPort).catch(() => null), "Legacy fixture not ready");
    await writeFile(path.join(legacyProfile, "media-tracker-session.json"),
      JSON.stringify({ pid: legacyChild.pid, port: legacyPort, mode: "interactive" }));
    await assert.rejects(api.acquireTikTokPage({ profileDirectory: legacyProfile }), (error) => error.code === "profile-interactive-active");
    const operation = api.shutdownTikTokSessions();
    assert.equal(api.shutdownTikTokSessions(), operation);
    const result = await operation;
    assert.deepEqual(result, { closed: 1, skipped: 0, errors: [] });
    assert.equal(lease.page.isClosed(), true);
    assert.equal(ownedObserver.isConnected(), false);
    assert.equal((await api.dedicatedProfileProcesses(ownedProfile)).length, 0);
    assert.equal(legacyObserver.isConnected(), true);
    assert.equal((await api.dedicatedProfileProcesses(legacyProfile))[0].pid, legacyChild.pid);
    assert.equal(JSON.parse(await readFile(path.join(ownedProfile, "media-tracker-session.json"), "utf8")).launchId, saved.launchId);
  } finally {
    await lease?.release();
    await cleanupTemporary(ownedProfile, [ownedObserver], [], api);
    await cleanupTemporary(legacyProfile, [legacyObserver], [legacyChild], api);
  }
});

test("failed shutdown CDP uses only the owned helper marker and preserves profile files", {
  skip: process.platform !== "win32", timeout: 35_000,
}, async (t) => {
  const api = await import(moduleUrl.href + "?fallback-shutdown");
  const profile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-shutdown-fallback-"));
  let lease;
  try {
    await writeFile(path.join(profile, "local-preserved-fixture"), "keep");
    lease = await api.acquireTikTokPage({ profileDirectory: profile });
    await lease.release();
    t.mock.method(chromium, "connectOverCDP", async () => { throw new Error("Local shutdown connection failure"); });
    assert.deepEqual(await api.shutdownTikTokSessions(), { closed: 1, skipped: 0, errors: [] });
    assert.equal((await api.dedicatedProfileProcesses(profile)).length, 0);
    assert.equal(await readFile(path.join(profile, "local-preserved-fixture"), "utf8"), "keep");
  } finally {
    t.mock.restoreAll();
    await lease?.release();
    await cleanupTemporary(profile, [], [], api);
  }
});
