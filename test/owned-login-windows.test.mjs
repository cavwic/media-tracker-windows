import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { OwnedLoginWindows } from "../lib/owned-login-windows.mjs";
import { browserArgumentValue } from "../lib/tiktok-browser.mjs";

function fixture({ unreadable = false, reused = false, graceful = true, changeIdentity = false } = {}) {
  const calls = [];
  const executable = path.resolve("fixture-chromium", "chrome.exe");
  const profile = path.resolve("fixture-data", "browser-profiles", "instagram", "login-fixture");
  let processInfo;
  let child;
  const manager = new OwnedLoginWindows({ executable, ownerPid: 42, graceMs: 1,
    spawnProcess: (file, args, options) => {
      calls.push({ action: "spawn", file, args, options });
      child = new EventEmitter();
      Object.assign(child, { pid: 1234, exitCode: null, signalCode: null, unref: () => {} });
      processInfo = { ProcessId: child.pid, ParentProcessId: 42, ExecutablePath: executable,
        CommandLine: args.map((arg) => `"${arg}"`).join(" ") };
      queueMicrotask(() => { child.emit("spawn"); if (reused) { child.exitCode = 0; child.emit("exit", 0); } });
      return child;
    },
    inspect: async () => { if (unreadable) throw new Error("cannot inspect"); return processInfo; },
    requestClose: async (pid) => {
      calls.push({ action: "close", pid });
      if (changeIdentity) processInfo.ParentProcessId = 999;
      if (graceful) { child.exitCode = 0; child.emit("exit", 0); }
    },
    terminate: async (pid) => { calls.push({ action: "terminate", pid }); child.exitCode = 1; child.emit("exit", 1); },
  });
  return { manager, calls, profile, executable, mutate: (values) => Object.assign(processInfo, values),
    exit: () => { child.exitCode = 0; child.emit("exit", 0); } };
}

test("an opened post returns its exact owned window lifetime, not merely the launch", async () => {
  const item = fixture();
  const opened = await item.manager.open(item.profile, "https://www.instagram.com/p/FIXTURE00001/");
  let closed = false;
  opened.closed.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "a caller must keep its profile lease until the window exits");
  item.exit();
  await opened.closed;
  assert.equal(closed, true);
  assert.equal(item.manager.records.size, 0);
  await item.manager.close();
  assert.equal(item.calls.length, 1, "already exited windows must not be closed again");
});

test("application shutdown settles open post lifetimes for profile lock release", async () => {
  const item = fixture();
  const first = await item.manager.open(item.profile, "https://x.com/fixture/status/1");
  await item.manager.close();
  await first.closed;
  assert.equal(item.manager.records.size, 0);
});

test("post lifetime is already settled if Chromium hands the launch to another process", async () => {
  const item = fixture({ reused: true });
  const first = await item.manager.open(item.profile, "https://www.facebook.com/fixture/posts/123");
  await first.closed;
  assert.equal(item.manager.records.size, 0);
  await item.manager.close();
  assert.equal(item.calls.length, 1, "never claim ownership of a pre-existing browser");
});

test("login window launch retains the original ordinary homepage flow and only closes its exact owned child", async () => {
  const { manager, calls, profile, executable } = fixture();
  await manager.open(profile, "https://www.instagram.com/");
  assert.equal(calls[0].file, executable);
  assert.equal(calls[0].args.at(-1), "https://www.instagram.com/");
  assert.ok(calls[0].args.includes("--new-window"));
  assert.equal(browserArgumentValue(calls[0].args, "user-data-dir"), profile);
  assert.match(browserArgumentValue(calls[0].args, "media-tracker-login-session"), /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls[0].options, { detached: true, windowsHide: true, stdio: "ignore" });
  const close = manager.close();
  assert.equal(manager.close(), close);
  assert.deepEqual(await close, { errors: [] });
  assert.deepEqual(calls.slice(1), [{ action: "close", pid: 1234 }]);
  await assert.rejects(manager.open(profile, "https://www.instagram.com/"), /正在退出/);
});

test("Chrome singleton handoff and foreign parent/executable/profile identities are never closed", async () => {
  for (const values of [null, { ParentProcessId: 999 }, { ExecutablePath: path.resolve("ordinary-chrome.exe") },
    { CommandLine: '"--user-data-dir=foreign-profile"' }, { ProcessId: 999 }]) {
    const item = fixture({ reused: !values });
    await item.manager.open(item.profile, "https://www.facebook.com/");
    if (values) item.mutate(values);
    await item.manager.close();
    assert.equal(item.calls.length, 1);
  }
});

test("fallback is exact owned PID only and ownership is revalidated after the graceful wait", async () => {
  const owned = fixture({ graceful: false });
  await owned.manager.open(owned.profile, "https://x.com/home");
  await owned.manager.close();
  assert.deepEqual(owned.calls.slice(1), [{ action: "close", pid: 1234 }, { action: "terminate", pid: 1234 }]);
  const changed = fixture({ graceful: false, changeIdentity: true });
  await changed.manager.open(changed.profile, "https://x.com/home");
  await changed.manager.close();
  assert.deepEqual(changed.calls.slice(1), [{ action: "close", pid: 1234 }]);
});

test("unreadable ownership never triggers forced closure and is reported", async () => {
  const item = fixture({ unreadable: true });
  await item.manager.open(item.profile, "https://x.com/home");
  assert.equal((await item.manager.close()).errors.length, 1);
  assert.equal(item.calls.length, 1);
});

test("several independently owned login windows close concurrently without losing identity checks", async () => {
  const executable = path.resolve("fixture-chromium", "chrome.exe");
  const children = new Map();
  const requested = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const manager = new OwnedLoginWindows({ executable, ownerPid: 42,
    spawnProcess: (file, args) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 2000 + children.size, exitCode: null, signalCode: null, unref: () => {} });
      children.set(child.pid, { child, CommandLine: args.map((arg) => `"${arg}"`).join(" ") });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    inspect: async (pid) => ({ ProcessId: pid, ParentProcessId: 42, ExecutablePath: executable,
      CommandLine: children.get(pid).CommandLine }),
    requestClose: async (pid) => {
      requested.push(pid);
      if (requested.length === 3) release();
      await pending;
      const { child } = children.get(pid);
      child.exitCode = 0;
      child.emit("exit", 0);
    },
    terminate: async () => { assert.fail("all fixture windows closed gracefully"); },
  });
  for (let index = 0; index < 3; index++) {
    await manager.open(path.resolve("fixture-data", `login-${index}`), "https://www.instagram.com/");
  }
  const deadline = setTimeout(release, 1500);
  try {
    const closing = manager.close();
    // Every close request must start before any fixture releases its window.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requested.sort(), [2000, 2001, 2002]);
    assert.deepEqual(await closing, { errors: [] });
  } finally { clearTimeout(deadline); release(); }
});
