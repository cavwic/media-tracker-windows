import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

// This preload is never imported by the application. Isolate only this HTTP
// fixture's Windows browser-process inventory from unrelated UI tests starting
// and exiting Chromium at the same time. Those races can correctly produce an
// unreadable CommandLine and make the real production guard fail closed.
const data = path.resolve(process.env.MEDIA_TRACKER_DATA_DIR || "");
const temporaryRoot = path.dirname(data);
const key = (value) => process.platform === "win32" ? value.toLowerCase() : value;
if (process.env.MEDIA_TRACKER_NO_OPEN !== "1" || path.basename(data) !== "data"
  || !/^unlinked-profile-api-[a-z0-9_-]+$/i.test(path.basename(temporaryRoot))
  || key(path.dirname(temporaryRoot)) !== key(path.resolve(os.tmpdir()))) {
  throw new Error("The process-list fixture is restricted to its own NO_OPEN temporary test directory.");
}

const query = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter \"Name = 'chrome.exe' OR Name = 'chrome-headless-shell.exe' OR Name = 'chromium.exe' OR Name = 'msedge.exe'\" | Select-Object CommandLine) | ConvertTo-Json -Compress";
const exactQuery = (file, args) => path.basename(file).toLowerCase() === "powershell.exe"
  && Array.isArray(args) && args.length === 4 && args[0] === "-NoProfile" && args[1] === "-NonInteractive"
  && args[2] === "-Command" && args[3] === query;
const originalExecFile = childProcess.execFile;

function fixtureExecFile(file, args, ...remaining) {
  if (!exactQuery(file, args)) return originalExecFile(file, args, ...remaining);
  const callback = remaining.at(-1);
  if (typeof callback !== "function") return originalExecFile(file, args, ...remaining);
  if (process.env.UNLINKED_PROFILE_API_LIVE_CIM === "1") {
    return originalExecFile(file, args, ...remaining.slice(0, -1), (error, stdout, stderr) => {
      let rows = [];
      try { const parsed = JSON.parse(stdout.trim() || "[]"); rows = Array.isArray(parsed) ? parsed : [parsed]; }
      catch {}
      // Counts only: never log actual browser command lines or credentials.
      process.stderr.write(`Fixture CIM diagnostic: failed=${Boolean(error)} rows=${rows.length} unreadable=${rows.filter((row) => !row?.CommandLine).length}\n`);
      callback(error, stdout, stderr);
    });
  }
  const fixtureChild = new EventEmitter();
  fixtureChild.kill = () => false;
  queueMicrotask(() => callback(null, "[]", ""));
  return fixtureChild;
}

// execFile's promisified contract resolves both stdout/stderr and exposes the
// exact returned child. Preserve it for unmatched real OS subprocesses too.
fixtureExecFile[promisify.custom] = (...args) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = fixtureExecFile(...args, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
  promise.child = child;
  return promise;
};
childProcess.execFile = fixtureExecFile;
syncBuiltinESMExports();
