import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { browserArgumentValue, parseBrowserCommandLine, validateLocalDebuggerUrl } from "../lib/tiktok-browser.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/tiktok-background-browser.ps1");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const samePath = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

async function waitFor(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function processSnapshot() {
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'powershell.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const records = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(records) ? records : [records];
}

function descendants(snapshot, rootPid) {
  const known = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      if (known.has(Number(item.ParentProcessId)) && !known.has(Number(item.ProcessId))) {
        known.add(Number(item.ProcessId)); changed = true;
      }
    }
  }
  return snapshot.filter((item) => known.has(Number(item.ProcessId)));
}

async function temporaryWorker() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-helper-test-中文 空格-"));
  const launchId = randomUUID().replaceAll("-", "");
  const port = await freePort();
  const readyFile = path.join(profile, `media-tracker-launch-${launchId}.json`);
  const stopFile = path.join(profile, `media-tracker-stop-${launchId}`);
  const helper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", script,
    "-Executable", chromium.executablePath(), "-ProfileDirectory", profile, "-Port", String(port), "-LaunchId", launchId],
  { windowsHide: true, stdio: "ignore" });
  let browser;
  let ready;
  let spawnError;
  helper.on("error", (error) => { spawnError = error; });
  const assertOwner = async () => {
    const snapshot = await processSnapshot();
    const child = snapshot.find((item) => Number(item.ProcessId) === ready.pid);
    const owner = snapshot.find((item) => Number(item.ProcessId) === helper.pid);
    assert.ok(child && owner, "Only this test's live browser and helper may be stopped");
    assert.equal(Number(child.ParentProcessId), helper.pid);
    assert.ok(samePath(child.ExecutablePath, chromium.executablePath()));
    assert.equal(browserArgumentValue(child.CommandLine, "user-data-dir"), profile);
    assert.equal(browserArgumentValue(child.CommandLine, "media-tracker-background-session"), launchId);
    assert.equal(Number(browserArgumentValue(child.CommandLine, "remote-debugging-port")), port);
    assert.ok(samePath(owner.ExecutablePath, powershell));
    const args = parseBrowserCommandLine(owner.CommandLine);
    const value = (name) => args[args.findIndex((arg) => arg.toLowerCase() === name.toLowerCase()) + 1];
    assert.ok(samePath(value("-File"), script));
    assert.equal(value("-ProfileDirectory"), profile);
    assert.equal(value("-LaunchId"), launchId);
    return descendants(snapshot, ready.pid);
  };
  const cleanup = async () => {
    // The unique marker only controls the child created for this temporary profile.
    await writeFile(stopFile, "stop").catch(() => {});
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession().catch(() => null);
      await cdp?.send("Browser.close").catch(() => {});
      await browser.close().catch(() => {});
    }
    await waitFor(() => helper.exitCode !== null || helper.signalCode !== null || spawnError,
      "Temporary helper did not exit", 10_000).catch(async () => {
        if (ready) { await assertOwner(); helper.kill(); }
      });
    await waitFor(async () => !(await processSnapshot()).some((item) =>
      browserArgumentValue(item.CommandLine, "user-data-dir") === profile), "Temporary browser did not exit");
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("media-tracker-helper-test-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  try {
    ready = await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (helper.exitCode !== null || helper.signalCode !== null) throw new Error("Private desktop helper exited before startup");
      let status;
      try { status = JSON.parse(await readFile(readyFile, "utf8")); } catch { return false; }
      assert.equal(status.error, undefined, JSON.stringify(status));
      assert.equal(status.launchId, launchId);
      assert.equal(status.helperPid, helper.pid);
      assert.equal(status.desktopName, `MediaTrackerBackground_${launchId}`);
      return status;
    }, "Private desktop launch status did not arrive");
    await assertOwner();
    browser = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        const endpoint = (await response.json()).webSocketDebuggerUrl;
        assert.ok(validateLocalDebuggerUrl(endpoint, port));
        return await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 3000 });
      } catch { return false; }
    }, "Private desktop debugger did not become ready");
    const page = await browser.contexts()[0].newPage();
    await page.setContent("<title>Temporary background helper test</title><p>Local test only</p>");
    assert.equal(await page.locator("p").innerText(), "Local test only");
    return { helper, ready, browser, profile, stopFile, assertOwner, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function assertTreeExited(tree) {
  await waitFor(async () => {
    const remaining = await processSnapshot();
    return tree.every((old) => !remaining.some((current) =>
      Number(current.ProcessId) === Number(old.ProcessId) && current.CreationDate === old.CreationDate));
  }, "The helper's captured browser process tree did not exit");
}

test("private desktop browser is job-guarded before its initial thread resumes", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /LimitFlags\s*=\s*0x2000/);
  const create = source.indexOf("if (-not [MediaTrackerPrivateDesktop]::CreateProcess(");
  const assign = source.indexOf("if (-not [MediaTrackerPrivateDesktop]::AssignProcessToJobObject(");
  const resume = source.indexOf("if ([MediaTrackerPrivateDesktop]::ResumeThread(");
  const publish = source.indexOf("Publish-LaunchStatus @{ pid=");
  assert.ok(create > 0 && create < assign && assign < resume && resume < publish);
  assert.match(source.slice(create, assign), /0x08000404/);
  assert.match(source, /CreateJobObject\(\[IntPtr\]::Zero,\$null\)/);
  assert.match(source, /CloseHandle\(\$browserJob\)/);
});

test("abrupt termination of this test's exact helper reclaims its entire Chromium tree", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const worker = await temporaryWorker();
  try {
    const tree = await worker.assertOwner();
    assert.ok(tree.length >= 2, "Test must include browser subprocesses, not just an empty root process");
    assert.equal(worker.helper.kill(), true);
    await assertTreeExited(tree);
    await waitFor(() => !worker.browser.isConnected(), "CDP did not disconnect after helper exit");
  } finally { await worker.cleanup(); }
});

test("normal Browser.close exits the helper and leaves no captured Chromium children", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const worker = await temporaryWorker();
  try {
    const tree = await worker.assertOwner();
    const cdp = await worker.browser.newBrowserCDPSession();
    await cdp.send("Browser.close");
    await waitFor(() => worker.helper.exitCode !== null, "Helper did not exit after normal browser close");
    assert.equal(worker.helper.exitCode, 0);
    await assertTreeExited(tree);
  } finally { await worker.cleanup(); }
});

test("unique launch cancellation marker reclaims the browser and its child processes", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const worker = await temporaryWorker();
  try {
    const tree = await worker.assertOwner();
    await writeFile(worker.stopFile, "stop");
    await waitFor(() => worker.helper.exitCode !== null, "Helper ignored its own launch cancellation marker");
    await assertTreeExited(tree);
  } finally { await worker.cleanup(); }
});
