import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createBackgroundProcessGuards } from "../lib/background-chromium.mjs";

const executablePath = path.resolve("synthetic-private-chrome.exe");
const args = ["--headless", "--remote-debugging-pipe", "--user-data-dir=synthetic-profile"];

function fixture(platform = "win32") {
  const calls = [], children = [];
  const guards = createBackgroundProcessGuards({ platform, executablePath, systemRoot: "C:\\Windows",
    spawn: (...params) => {
      calls.push({ kind: "spawn", params });
      const child = new EventEmitter(); child.pid = 7000 + children.length;
      children.push(child); return child;
    },
    spawnSync: (...params) => { const value = { kind: "spawnSync", params }; calls.push(value); return value; } });
  return { guards, calls, children };
}

test("background guard hides only exact private headless pipe launches without changing arguments or caller options", () => {
  const { guards, calls, children } = fixture();
  const options = { stdio: ["ignore", "pipe", "pipe"], windowsHide: false };
  assert.equal(guards.spawn(executablePath, args, options), children[0]);
  assert.deepEqual(calls[0].params, [executablePath, args, { ...options, windowsHide: true }]);
  assert.equal(options.windowsHide, false);
});

test("registered browser cleanup executes taskkill directly, hidden, and preserves output options", () => {
  const { guards, calls } = fixture();
  const child = guards.spawn(executablePath, args, {});
  const options = { shell: true, encoding: "utf8", maxBuffer: 1024 };
  const result = guards.spawnSync(`taskkill /pid ${child.pid} /T /F`, options);
  assert.equal(result, calls[1]);
  assert.deepEqual(result.params, [path.join("C:\\Windows", "System32", "taskkill.exe"),
    ["/pid", String(child.pid), "/T", "/F"], { ...options, shell: false, windowsHide: true }]);
  assert.equal(options.shell, true);
});

test("managed main app fallback cleanup is hidden and restricted to its own live process", () => {
  const { guards, calls } = fixture();
  const appArgs = ["--remote-debugging-pipe", "--app=http://127.0.0.1:43178/", "--user-data-dir=own-app-profile"];
  const options = { windowsHide: false, detached: true, stdio: "pipe" };
  const child = guards.spawn(executablePath, appArgs, options);
  assert.deepEqual(calls[0].params, [executablePath, appArgs, { ...options, windowsHide: true }]);
  assert.equal(options.windowsHide, false);
  guards.spawnSync(`taskkill /pid ${child.pid} /T /F`, { shell: true });
  assert.deepEqual(calls[1].params, [path.join("C:\\Windows", "System32", "taskkill.exe"),
    ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true }]);
  child.emit("close");
  guards.spawnSync(`taskkill /pid ${child.pid} /T /F`, { shell: true });
  assert.equal(calls[2].params[0], `taskkill /pid ${child.pid} /T /F`, "Closed app PID is no longer owned");
});

test("local app process guard rejects other origins, paths, malformed ports and unmanaged app launches", () => {
  const { guards, calls } = fixture();
  const appUrls = ["https://127.0.0.1:43178/", "http://127.0.0.1.evil:43178/", "http://example.com:43178/",
    "http://127.0.0.1:43178@evil/", "http://localhost:43178/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
    "http://127.0.0.1:43178/account", "http://127.0.0.1:43178/?other=1", "http://127.0.0.1:43178/#other",
    "http://127.0.0.1:43178/ ", "data:text/html,", "about:blank"];
  const options = { windowsHide: false };
  for (const url of appUrls) {
    const appArgs = ["--remote-debugging-pipe", `--app=${url}`];
    guards.spawn(executablePath, appArgs, options);
    assert.deepEqual(calls.at(-1).params, [executablePath, appArgs, options]);
  }
  const variants = [
    [executablePath, ["--remote-debugging-port=43189", "--app=http://127.0.0.1:43178/"], options],
    [path.resolve("user-chrome.exe"), ["--remote-debugging-pipe", "--app=http://127.0.0.1:43178/"], options],
    [executablePath, ["--remote-debugging-pipe", "--app=http://127.0.0.1:43178/"], { shell: true }],
    [executablePath, ["--remote-debugging-pipe", "--app=http://127.0.0.1:43178/", "--app=https://example.com/"], options],
  ];
  for (const params of variants) {
    guards.spawn(...params);
    assert.deepEqual(calls.at(-1).params, params);
  }
  guards.spawnSync("taskkill /pid 7000 /T /F", { shell: true });
  assert.equal(calls.at(-1).params[0], "taskkill /pid 7000 /T /F");
});

test("interactive logins, other executables, port sessions and shell launches remain unchanged", () => {
  const { guards, calls } = fixture();
  const options = { windowsHide: false };
  const cases = [
    [executablePath, ["--remote-debugging-pipe"], options],
    [executablePath, ["--headless", "--remote-debugging-port=43189"], options],
    [path.resolve("user-chrome.exe"), args, options],
    [executablePath, args, { shell: true }],
  ];
  for (const params of cases) guards.spawn(...params);
  assert.deepEqual(calls.map(({ params }) => params), cases);
  guards.spawnSync("taskkill /pid 7000 /T /F", { shell: true });
  assert.equal(calls.at(-1).params[0], "taskkill /pid 7000 /T /F");
});

test("unknown or closed browser PIDs and non-exact cleanup commands are not intercepted", () => {
  const { guards, calls } = fixture();
  const child = guards.spawn(executablePath, args, {});
  const options = { shell: true };
  const commands = ["taskkill /pid 1 /T /F", `taskkill /pid ${child.pid} /T /F & echo injected`,
    `taskkill /pid ${child.pid} /T`, "taskkill /IM chrome.exe /F"];
  for (const command of commands) {
    guards.spawnSync(command, options);
    assert.deepEqual(calls.at(-1).params, [command, options, undefined]);
  }
  child.emit("close");
  const command = `taskkill /pid ${child.pid} /T /F`;
  guards.spawnSync(command, options);
  assert.deepEqual(calls.at(-1).params, [command, options, undefined]);
});

test("failed launches are unregistered and shell-free taskkill requests keep their original behavior", () => {
  const { guards, calls } = fixture();
  const child = guards.spawn(executablePath, args, {});
  const command = `taskkill /pid ${child.pid} /T /F`;
  guards.spawnSync(command, { shell: false });
  assert.deepEqual(calls.at(-1).params, [command, { shell: false }, undefined]);
  child.emit("error", new Error("synthetic launch failure"));
  guards.spawnSync(command, { shell: true });
  assert.deepEqual(calls.at(-1).params, [command, { shell: true }, undefined]);
});

test("non-Windows execution does not alter spawn or cleanup", () => {
  const { guards, calls } = fixture("linux");
  const options = { stdio: "pipe" };
  const child = guards.spawn(executablePath, args, options);
  assert.deepEqual(calls[0].params, [executablePath, args, options]);
  const command = `taskkill /pid ${child.pid} /T /F`;
  guards.spawnSync(command, { shell: true });
  assert.deepEqual(calls.at(-1).params, [command, { shell: true }, undefined]);
});
