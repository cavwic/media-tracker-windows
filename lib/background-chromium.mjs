import path from "node:path";
import childProcess from "node:child_process";
import { chromium } from "playwright";

// The bundled chrome-headless-shell.exe is a Windows CONSOLE executable, while
// chrome.exe is a GUI executable. Playwright 1.62's process launcher does not set
// windowsHide. Use the regular bundled engine in headless mode, not that shell.
export const BACKGROUND_CHROMIUM_EXECUTABLE = chromium.executablePath();
const INSTALLED = Symbol.for("media-tracker.backgroundChromiumProcessGuard.v1");

export function createBackgroundProcessGuards({ spawn, spawnSync, executablePath, systemRoot = process.env.SystemRoot || "C:\\Windows", platform = process.platform }) {
  const key = (value) => path.resolve(String(value || "")).toLowerCase();
  const browserPath = key(executablePath);
  const live = new Set();
  const isLocalApp = (args) => {
    const appArguments = args.filter((arg) => typeof arg === "string" && arg.startsWith("--app="));
    if (appArguments.length !== 1) return false;
    // The managed desktop shell opens exactly the loopback service root. Do
    // not treat arbitrary Chrome apps, platform login URLs or lookalike hosts
    // as ours, even if they use the same bundled executable.
    const match = /^--app=http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(appArguments[0]);
    return Boolean(match && Number(match[1]) <= 65_535);
  };
  const isOwnedBrowser = (command, args, options) => platform === "win32" && key(command) === browserPath
    && Array.isArray(args) && (args.some((arg) => /^--headless(?:=|$)/.test(arg)) || isLocalApp(args))
    && args.includes("--remote-debugging-pipe") && !options?.shell;
  return {
    spawn(command, args, options) {
      if (!isOwnedBrowser(command, args, options)) return spawn(command, args, options);
      const child = spawn(command, args, { ...options, windowsHide: true });
      if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
        live.add(child.pid);
        const forget = () => live.delete(child.pid);
        child.once("close", forget); child.once("error", forget);
      }
      return child;
    },
    spawnSync(command, args, options) {
      const match = typeof command === "string" ? /^taskkill \/pid (\d+) \/T \/F$/i.exec(command) : null;
      const actualOptions = Array.isArray(args) ? options : args;
      if (platform === "win32" && match && actualOptions?.shell === true && live.has(Number(match[1]))) {
        // Guard only the exact dependency cleanup command for a browser this
        // process launched. No shell, process-name matching, user browsers or
        // interactive login windows are involved; do not edit node_modules.
        return spawnSync(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", match[1], "/T", "/F"],
          { ...actualOptions, shell: false, windowsHide: true });
      }
      return spawnSync(command, args, options);
    },
  };
}

// Playwright's CJS bundle reads this object dynamically. Native ESM bindings in
// our other modules are deliberately not synchronized/replaced. The guard is
// restricted to our private headless engine/local managed app and live-PID
// cleanup. Other interactive login browsers and user browsers are untouched.
if (process.platform === "win32" && !childProcess[INSTALLED]) {
  const guards = createBackgroundProcessGuards({ spawn: childProcess.spawn.bind(childProcess), spawnSync: childProcess.spawnSync.bind(childProcess),
    executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  childProcess.spawn = guards.spawn;
  childProcess.spawnSync = guards.spawnSync;
  Object.defineProperty(childProcess, INSTALLED, { value: true });
}
