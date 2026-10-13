import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clearProfileCache, listProfileDirectories } from "./profile-cache.mjs";
import { browserArgumentValue, withIdleTikTokProfile } from "./tiktok-browser.mjs";

const execFileAsync = promisify(execFile);
const keyFor = (profile) => {
  const resolved = path.resolve(profile);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export async function profileBrowserIsRunning(profile) {
  // Fail closed on unsupported platforms or process-query errors. This tool's
  // background browser implementation and cache maintenance target Windows.
  if (process.platform !== "win32") throw new Error("Unsupported process inspection platform");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter \"Name = 'chrome.exe' OR Name = 'chrome-headless-shell.exe' OR Name = 'chromium.exe' OR Name = 'msedge.exe'\" | Select-Object CommandLine) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).some((item) => {
    // An unreadable browser command line means we cannot establish idleness.
    if (!item?.CommandLine) return true;
    const value = browserArgumentValue(item.CommandLine, "user-data-dir");
    return value && keyFor(value) === keyFor(profile);
  });
}

export class ProfileMaintenance {
  constructor({ profilesRoot, isRunning = profileBrowserIsRunning, clean = clearProfileCache,
    listProfiles = listProfileDirectories, idleTikTok = withIdleTikTokProfile }) {
    this.profilesRoot = path.resolve(profilesRoot);
    this.isRunning = isRunning;
    this.clean = clean;
    this.listProfiles = listProfiles;
    this.idleTikTok = idleTikTok;
    this.busy = new Set();
  }

  async withProfileUse(profile, callback) {
    const key = keyFor(profile);
    if (this.busy.has(key)) {
      const error = new Error("该账号正在验证或清理缓存，请稍后重试。");
      error.status = 409;
      error.code = "profile-busy";
      throw error;
    }
    this.busy.add(key);
    try { return await callback(); }
    finally { this.busy.delete(key); }
  }

  async cleanupAccount({ linkedAccount, platformId }) {
    const profile = linkedAccount?.profileDirectory;
    if (!profile) return { status: "skipped", reason: "no-profile" };
    if (this.busy.has(keyFor(profile))) return { status: "skipped", reason: "profile-busy" };
    return this.withProfileUse(profile, async () => {
      try {
        // Validate ownership/path before attempting any browser shutdown.
        const profiles = await this.listProfiles(this.profilesRoot);
        if (!profiles.some((candidate) => keyFor(candidate) === keyFor(profile))
          || keyFor(path.dirname(profile)) !== keyFor(path.join(this.profilesRoot, platformId))) {
          return { status: "skipped", reason: "unsafe-profile" };
        }
        const cleanup = async () => {
          if (await this.isRunning(profile)) return { status: "skipped", reason: "profile-busy" };
          return this.clean({ profilesRoot: this.profilesRoot, profilePath: profile });
        };
        return platformId === "tiktok" ? await this.idleTikTok(profile, cleanup) : await cleanup();
      } catch {
        return { status: "skipped", reason: "cleanup-unavailable" };
      }
    });
  }
}
