import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserArgumentValue } from "./tiktok-browser.mjs";

const execAsync = promisify(execFile);
const key = (value) => path.resolve(value).toLowerCase();
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

async function inspectProcess(pid) {
  if (process.platform !== "win32") throw new Error("Owned login window inspection requires Windows.");
  const { stdout } = await execAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout.trim() || "null");
}

async function requestWindowClose(pid) {
  await execAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    `$collectorLoginProcess=Get-Process -Id ${pid} -ErrorAction Stop; [void]$collectorLoginProcess.CloseMainWindow()`],
  { windowsHide: true, timeout: 10_000 });
}

async function terminateOwnedTree(pid) {
  await execAsync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
}

export class OwnedLoginWindows {
  constructor({ executable, ownerPid = process.pid, spawnProcess = spawn, inspect = inspectProcess,
    requestClose = requestWindowClose, terminate = terminateOwnedTree, graceMs = 2500 }) {
    this.executable = executable;
    this.ownerPid = ownerPid;
    this.spawnProcess = spawnProcess;
    this.inspect = inspect;
    this.requestClose = requestClose;
    this.terminate = terminate;
    this.graceMs = graceMs;
    this.records = new Set();
    this.pending = new Set();
    this.closing = false;
  }

  open(profile, url) {
    if (this.closing) return Promise.reject(new Error("工具正在退出，不能打开登录窗口。"));
    const operation = this.launch(profile, url);
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  async launch(profile, url) {
    const token = randomUUID();
    const child = this.spawnProcess(this.executable, [`--user-data-dir=${profile}`, "--no-first-run",
      "--disable-background-mode", `--media-tracker-login-session=${token}`, "--new-window", url],
    { detached: true, windowsHide: true, stdio: "ignore" });
    const record = { child, profile, token };
    const closed = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
    this.records.add(record);
    child.once("exit", () => this.records.delete(record));
    try {
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return { closed };
    } catch (error) { this.records.delete(record); throw error; }
  }

  async owned(record) {
    const { child, profile, token } = record;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
    const current = await this.inspect(child.pid);
    return Number(current?.ProcessId) === child.pid && Number(current?.ParentProcessId) === this.ownerPid
      && current?.ExecutablePath && key(current.ExecutablePath) === key(this.executable)
      && browserArgumentValue(current.CommandLine, "media-tracker-login-session") === token
      && key(browserArgumentValue(current.CommandLine, "user-data-dir") || ".") === key(profile);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.pending]);
      const errors = [];
      // Separate profiles have independent windows. Close them together so
      // several login windows do not exhaust the application's exit deadline.
      await Promise.all([...this.records].map(async (record) => {
        try {
          if (!await this.owned(record)) return;
          await this.requestClose(record.child.pid).catch(() => {});
          if (record.child.exitCode === null && record.child.signalCode === null) {
            await new Promise((resolve) => {
              const done = () => { clearTimeout(timer); record.child.removeListener("exit", done); resolve(); };
              const timer = setTimeout(done, this.graceMs);
              record.child.once("exit", done);
            });
          }
          // Recheck identity immediately before the fallback; a recycled PID,
          // profile reused by another process, or unreadable process is not ours.
          if (await this.owned(record)) await this.terminate(record.child.pid);
        } catch (error) { errors.push({ code: error.code || "login-window-close-failed", message: error.message }); }
      }));
      return { errors };
    })();
    return this.closePromise;
  }
}
