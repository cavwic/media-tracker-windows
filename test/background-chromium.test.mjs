import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createBackgroundProcessGuards, BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";

const require = createRequire(import.meta.url), execFileAsync = promisify(execFile);
const executable = path.resolve("fixture-chrome.exe");
function guardsFixture() {
  const calls = [], child = Object.assign(new EventEmitter(), { pid: 73127 });
  const guards = createBackgroundProcessGuards({ executablePath: executable, platform: "win32", systemRoot: "C:\\Windows",
    spawn: (...args) => { calls.push(["spawn", ...args]); return child; },
    spawnSync: (...args) => { calls.push(["spawnSync", ...args]); return { status: 0 }; } });
  return { calls, child, guards };
}

test("guard hides only the exact tool-owned Playwright headless process and its live-PID shell cleanup", () => {
  const { calls, child, guards } = guardsFixture();
  const options = { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], shell: undefined };
  guards.spawn(executable, ["--headless", "--remote-debugging-pipe"], options);
  assert.equal(calls[0][3].windowsHide, true);
  assert.equal(options.windowsHide, undefined, "Caller options are not mutated");
  guards.spawnSync("taskkill /pid 73127 /T /F", { shell: true });
  assert.equal(calls[1][1], path.join("C:\\Windows", "System32", "taskkill.exe"));
  assert.deepEqual(calls[1][2], ["/pid", "73127", "/T", "/F"]);
  assert.equal(calls[1][3].shell, false);
  assert.equal(calls[1][3].windowsHide, true);
  child.emit("close", 0);
  guards.spawnSync("taskkill /pid 73127 /T /F", { shell: true });
  assert.equal(calls[2][1], "taskkill /pid 73127 /T /F", "Exited/reused IDs are no longer authorized");
});

test("guard leaves interactive/private-desktop browsers, other executables and arbitrary kill commands unchanged", () => {
  const { calls, guards } = guardsFixture();
  for (const [command, args] of [[executable, ["--remote-debugging-port=123", "about:blank"]],
    [executable, ["--no-startup-window", "--remote-debugging-port=123"]], [path.resolve("other.exe"), ["--headless", "--remote-debugging-pipe"]]]) {
    const options = { windowsHide: false };
    guards.spawn(command, args, options);
    assert.equal(calls.at(-1)[3], options);
  }
  guards.spawn(executable, ["--headless", "--remote-debugging-pipe"], {});
  for (const command of ["taskkill /pid 99999 /T /F", "taskkill /pid 73127 /T /F & echo other", "taskkill /IM chrome.exe /F"]) {
    const options = { shell: true };
    guards.spawnSync(command, options);
    assert.equal(calls.at(-1)[1], command);
    assert.equal(calls.at(-1)[2], options);
  }
});

test("bundled default headless shell is Console-subsystem while selected headless engine is GUI-subsystem", { skip: process.platform !== "win32" }, async () => {
  const { registry: { registry } } = require("playwright-core/lib/coreBundle");
  const shell = registry.findExecutable("chromium-headless-shell").executablePath();
  const subsystem = async (filename) => {
    const file = await open(filename, "r");
    try {
      const header = Buffer.alloc(64), value = Buffer.alloc(2);
      await file.read(header, 0, 64, 0);
      await file.read(value, 0, 2, header.readUInt32LE(60) + 92);
      return value.readUInt16LE(0);
    } finally { await file.close(); }
  };
  assert.equal(await subsystem(shell), 3);
  assert.equal(await subsystem(BACKGROUND_CHROMIUM_EXECUTABLE), 2);
});

test("offline private-desktop probe verifies fixed startup has no console/window and own-PID force cleanup exits", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "media-tracker-console-fixture-"));
  t.after(async () => { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const reports = {};
  for (const mode of ["original", "fixed"]) {
    const reportPath = path.join(temporary, `${mode}.json`);
    await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-File", path.resolve("test/fixtures/private-console-host.ps1"),
      "-NodeExecutable", process.execPath, "-WorkerPath", path.resolve("test/fixtures/console-browser-probe.mjs"), "-ReportPath", reportPath, "-Mode", mode],
    { windowsHide: true, timeout: 25_000, maxBuffer: 128 * 1024 }).catch(async (error) => {
      error.message += "\n" + await readFile(reportPath, "utf8").catch(() => "Fixture report unavailable");
      throw error;
    });
    reports[mode] = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(reports[mode].error, undefined, JSON.stringify(reports[mode]));
    assert.equal(reports[mode].userDesktopWindows, 0, "Neither test opens anything on the user's current desktop");
  }
  // The hidden/private host may also prevent an original console. Keep the
  // observation, but do not claim this isolated fixture reproduces a user flash.
  t.diagnostic(JSON.stringify(reports));
  assert.equal(reports.fixed.consoleAttached, false);
  assert.equal(reports.fixed.visibleBrowserWindows, 0);
  assert.equal(reports.fixed.cleanupCommand, "taskkill /pid " + reports.fixed.killPid + " /T /F");
  assert.equal(reports.fixed.killExited, true);
});
