import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { acquireTikTokPage, buildTikTokBrowserArgs, browserArgumentValue, dedicatedProfileProcesses,
  isManagedTikTokBackgroundProcess, openTikTokLoginWindow, parseBrowserCommandLine, TIKTOK_BACKGROUND_IDLE_MS,
  validateLocalDebuggerUrl, withIdleTikTokProfile } from "../lib/tiktok-browser.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/tiktok-background-browser.ps1");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
async function connect(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
  const endpoint = (await response.json()).webSocketDebuggerUrl;
  assert.ok(validateLocalDebuggerUrl(endpoint, port));
  return chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
}
async function temporarySession({ interactive = false } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "media-tracker-tiktok-browser-中文 空格-"));
  let observer, child, saved;
  const clean = async () => {
    if (observer?.isConnected()) {
      const cdp = await observer.newBrowserCDPSession().catch(() => null);
      await cdp?.send("Browser.close").catch(() => {}); await observer.close().catch(() => {});
    }
    await waitFor(async () => !(await dedicatedProfileProcesses(profile)).length, "Temporary Chromium did not exit").catch(() => child?.kill());
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("media-tracker-tiktok-browser-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    if (interactive) {
      const port = await freePort();
      child = spawn(chromium.executablePath(), buildTikTokBrowserArgs(profile, port, { background: true }), { stdio: "ignore", windowsHide: true });
      saved = { pid: child.pid, port, mode: "interactive" };
      observer = await waitFor(() => connect(port).catch(() => null), "Temporary debugger did not become ready");
      await writeFile(path.join(profile, "media-tracker-session.json"), JSON.stringify(saved));
    } else {
      const lease = await acquireTikTokPage({ profileDirectory: profile });
      assert.equal(lease.needsHomeWarmup, true); await lease.release();
      assert.equal(lease.markHomeWarmupComplete(), false);
      saved = JSON.parse(await readFile(path.join(profile, "media-tracker-session.json"), "utf8"));
      observer = await connect(saved.port);
    }
    return { profile, saved, observer, clean };
  } catch (error) { await clean(); throw error; }
}
async function desktopWindows(saved) {
  assert.match(saved.desktopName, /^MediaTrackerBackground_[a-f0-9]{32}$/);
  assert.ok(Number.isSafeInteger(saved.pid));
  const source = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class WorkerDesktopTest {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
 public delegate bool Callback(IntPtr hwnd,IntPtr unused);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool EnumDesktopWindows(IntPtr desktop,Callback callback,IntPtr unused);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 public static int Count(IntPtr desktop,uint pid) { int count=0; if(!EnumDesktopWindows(desktop,delegate(IntPtr hwnd,IntPtr unused){uint found;GetWindowThreadProcessId(hwnd,out found);if(found==pid)count++;return true;},IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return count; }
}
'@
$workerDesktop = [WorkerDesktopTest]::OpenDesktop('${saved.desktopName}',0,$false,0x41)
if ($workerDesktop -eq [IntPtr]::Zero) { throw 'Missing worker desktop' }
try {
 $current = [WorkerDesktopTest]::GetThreadDesktop([WorkerDesktopTest]::GetCurrentThreadId())
 @{privateWindows=[WorkerDesktopTest]::Count($workerDesktop,${saved.pid});currentWindows=[WorkerDesktopTest]::Count($current,${saved.pid});administrator=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress
} finally { [void][WorkerDesktopTest]::CloseDesktop($workerDesktop) }
`;
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", source], { windowsHide: true, timeout: 15_000 });
  return JSON.parse(stdout.trim());
}

test("ordinary browser arguments isolate profiles without headless, automation, or security overrides", () => {
  const profile = path.resolve(os.tmpdir(), "Media Tracker profile with spaces");
  const args = buildTikTokBrowserArgs(profile, 43210, { background: true });
  for (const value of [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=43210", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--no-startup-window"]) assert.ok(args.includes(value));
  assert.equal(args.includes("--start-minimized"), false); assert.equal(args.includes("about:blank"), false);
  assert.equal(buildTikTokBrowserArgs(profile, 43210).at(-1), "about:blank");
  assert.equal(args.some((arg) => /headless|enable-automation|no-sandbox|disable-web-security|user-agent|disable-blink-features/.test(arg)), false);
  for (const invalid of [0, -1, 65536, 123.5, "123"]) assert.throws(() => buildTikTokBrowserArgs(profile, invalid));
  assert.throws(() => buildTikTokBrowserArgs("relative-profile", 43210));
});
test("debugger endpoints must match the expected loopback port and browser path", () => {
  const valid = "ws://127.0.0.1:43210/devtools/browser/abcd-1234";
  assert.equal(validateLocalDebuggerUrl(valid, 43210), true);
  for (const url of [valid.replace("127.0.0.1", "localhost"), valid.replace("127.0.0.1", "192.168.1.2"), valid.replace(":43210", ":43211"), valid.replace("ws:", "wss:"), valid.replace("127.0.0.1", "user:pass@127.0.0.1"), `${valid}?token=x`, `${valid}#x`, valid.replace("browser/", "page/"), "not a URL"]) assert.equal(validateLocalDebuggerUrl(url, 43210), false, url);
  assert.equal(validateLocalDebuggerUrl("ws://127.0.0.1/devtools/browser/id", 0), false);
  assert.equal(validateLocalDebuggerUrl(valid, "43210"), false);
});
test("Windows quoted arguments preserve profile paths and parse the final debug port", () => {
  const profile = String.raw`C:\Fixture\Person Name\TikTok profile`;
  for (const command of [`"C:\\Chrome folder\\chrome.exe" "--user-data-dir=${profile}" --remote-debugging-port=43210`, `chrome.exe --user-data-dir="${profile}" "--remote-debugging-port=43210"`, `chrome.exe --user-data-dir "${profile}" --remote-debugging-port 43210`, `chrome.exe "--user-data-dir=${profile}" --remote-debugging-port=43210 "about:blank"`]) {
    assert.equal(browserArgumentValue(command, "user-data-dir"), profile); assert.equal(browserArgumentValue(command, "remote-debugging-port"), "43210");
  }
  assert.equal(browserArgumentValue("chrome.exe --remote-debugging-port=123 --remote-debugging-port=456", "remote-debugging-port"), "456");
  assert.equal(browserArgumentValue("chrome.exe --remote-debugging-port=", "remote-debugging-port"), "");
  assert.deepEqual(parseBrowserCommandLine('chrome.exe "about:blank" ""'), ["chrome.exe", "about:blank", ""]);
  assert.equal(browserArgumentValue(String.raw`chrome.exe "--user-data-dir=C:\profile with space\\" --remote-debugging-port=43210`, "user-data-dir"), "C:\\profile with space\\");
});
test("ownership requires the real helper parent, script, executable, profile, port, and launch ID", () => {
  const launchId = "a".repeat(32), profile = path.resolve(os.tmpdir(), "Media Tracker profile with spaces");
  const saved = { mode: "background", backgroundVersion: 1, pid: 101, helperPid: 102, port: 43210, launchId, desktopName: `MediaTrackerBackground_${launchId}` };
  const proc = { pid: 101, parentPid: 102, port: 43210, executablePath: chromium.executablePath(), backgroundSessionId: launchId };
  const helper = { ProcessId: 102, Name: "powershell.exe", ExecutablePath: powershell, CommandLine: `"${powershell}" -NoProfile -File "${script}" -Executable "${chromium.executablePath()}" -ProfileDirectory "${profile}" -Port 43210 -LaunchId ${launchId}` };
  assert.equal(isManagedTikTokBackgroundProcess(saved, proc, helper, profile), true);
  for (const [key, value] of Object.entries({ mode: "interactive", backgroundVersion: 99, pid: 999, helperPid: 999, port: 1, launchId: "bad", desktopName: "Default" })) assert.equal(isManagedTikTokBackgroundProcess({ ...saved, [key]: value }, proc, helper, profile), false, key);
  for (const [key, value] of Object.entries({ parentPid: 999, executablePath: "unrelated-browser.exe", backgroundSessionId: "b".repeat(32) })) assert.equal(isManagedTikTokBackgroundProcess(saved, { ...proc, [key]: value }, helper, profile), false, key);
  assert.equal(isManagedTikTokBackgroundProcess(saved, proc, { ...helper, CommandLine: helper.CommandLine.replace(script, "unrelated.ps1") }, profile), false);
  assert.equal(isManagedTikTokBackgroundProcess(saved, proc, helper, `${profile}-other`), false);
});
test("background API rejects login purpose and pre-aborted work before touching a profile", async () => {
  await assert.rejects(acquireTikTokPage({ purpose: "login" }), (error) => error.code === "interactive-login-required");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(acquireTikTokPage({ signal: controller.signal }), (error) => error.name === "AbortError");
});

test("private-desktop leases render, stream images, preserve other tabs, and have zero current-desktop windows", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const session = await temporarySession();
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
  let apiHits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/image-fixture") { response.writeHead(200, { "Content-Type": "image/png" }); response.end(imageBytes); }
    else if (request.url === "/api/visible") { apiHits++; response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}'); }
    else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<title>Local login fixture</title><p>Local fixture only</p><div style="height:3000px"></div><div id="end">End</div>'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}/login-fixture`;
  try {
    assert.equal(session.saved.mode, "background"); assert.equal(session.saved.backgroundVersion, 1);
    const matches = await dedicatedProfileProcesses(session.profile);
    assert.equal(matches.length, 1); assert.equal(matches[0].pid, session.saved.pid); assert.equal(matches[0].parentPid, session.saved.helperPid);
    const context = session.observer.contexts()[0]; assert.equal(context.pages().length, 0);
    const other = await context.newPage(); await other.goto(address);
    const userBlank = await context.newPage();
    const controller = new AbortController();
    const lease = await acquireTikTokPage({ profileDirectory: session.profile, signal: controller.signal });
    assert.equal(lease.background, true); assert.equal(lease.needsHomeWarmup, true, "A released, unconfirmed warm-up must remain pending");
    lease.markHomeWarmupComplete();
    await lease.page.goto(`${address}?work=1`);
    assert.equal(await lease.page.locator("p").count(), 1); assert.equal(await lease.page.locator("p").isVisible(), true); assert.equal(await lease.page.locator("p").innerText(), "Local fixture only");
    assert.deepEqual(await lease.page.evaluate(() => ({ width: innerWidth, height: innerHeight, headless: /HeadlessChrome/.test(navigator.userAgent), webdriver: navigator.webdriver })), { width: 1280, height: 900, headless: false, webdriver: false });
    await lease.page.evaluate(() => {
      window.fixtureEvents = { scroll: 0, raf: 0, visible: false };
      addEventListener("scroll", () => { window.fixtureEvents.scroll++; });
      requestAnimationFrame(() => { window.fixtureEvents.raf++; });
      new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { window.fixtureEvents.visible = true; fetch("/api/visible"); } }).observe(document.getElementById("end"));
      document.getElementById("end").scrollIntoView();
    });
    await lease.page.waitForFunction(() => window.fixtureEvents.scroll > 0 && window.fixtureEvents.raf > 0 && window.fixtureEvents.visible, null, { timeout: 5000 });
    await waitFor(() => apiHits > 0, "Lazy-load API did not run");
    const previousScroll = await lease.page.evaluate(() => scrollY);
    await lease.page.mouse.move(100, 100); await lease.page.mouse.wheel(0, -1000);
    await lease.page.waitForFunction((previous) => scrollY < previous, previousScroll, { timeout: 5000 });
    const windows = await desktopWindows(session.saved);
    assert.equal(windows.currentWindows, 0); assert.ok(windows.privateWindows > 0);
    t.diagnostic(`Private desktop isolation verified; administrator=${windows.administrator}`);
    await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), (error) => error.code === "profile-busy");
    const workSession = await lease.context.newCDPSession(lease.page);
    let completeImage, rejectImage;
    const receivedImage = new Promise((resolve, reject) => { completeImage = resolve; rejectImage = reject; });
    const imageTimer = setTimeout(() => rejectImage(new Error("Image interception timed out")), 5000);
    workSession.on("Fetch.requestPaused", (event) => {
      void (async () => {
        if (!event.responseStatusCode) return workSession.send("Fetch.continueRequest", { requestId: event.requestId });
        assert.equal(event.responseStatusCode, 200);
        const { stream } = await workSession.send("Fetch.takeResponseBodyAsStream", { requestId: event.requestId });
        const chunks = [];
        while (true) { const chunk = await workSession.send("IO.read", { handle: stream, size: 1024 }); chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")); if (chunk.eof) break; }
        await workSession.send("IO.close", { handle: stream });
        await workSession.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }); completeImage(Buffer.concat(chunks));
      })().catch(rejectImage);
    });
    await workSession.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    const imageNavigation = lease.page.goto(`http://127.0.0.1:${server.address().port}/image-fixture`, { waitUntil: "commit" }).catch(() => {});
    try { assert.deepEqual(await receivedImage, imageBytes); } finally { clearTimeout(imageTimer); }
    await imageNavigation; await workSession.send("Fetch.disable"); await workSession.detach();
    controller.abort(); await Promise.all([lease.release(), lease.release()]);
    assert.equal(lease.page.isClosed(), true); assert.equal(other.isClosed(), false); assert.equal(userBlank.isClosed(), false);
    assert.equal(await other.title(), "Local login fixture"); assert.equal(session.observer.isConnected(), true);
    await assert.rejects(openTikTokLoginWindow(session.profile), (error) => error.code === "profile-busy"); assert.equal(other.isClosed(), false);
    const failedConnect = t.mock.method(chromium, "connectOverCDP", async (_endpoint, options) => { assert.equal(options.noDefaults, true); throw new Error("fixture-connect-failure"); });
    await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), /fixture-connect-failure/); failedConnect.mock.restore();
    let disconnected = 0;
    const failedPage = t.mock.method(chromium, "connectOverCDP", async () => ({ contexts: () => [{ newPage: async () => { throw new Error("fixture-page-failure"); } }],
      newBrowserCDPSession: () => session.observer.newBrowserCDPSession(), close: async () => { disconnected++; } }));
    await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), /fixture-page-failure/); failedPage.mock.restore(); assert.equal(disconnected, 1);
    const recovered = await acquireTikTokPage({ profileDirectory: session.profile }); assert.equal(recovered.needsHomeWarmup, false); await recovered.release();
    const after = JSON.parse(await readFile(path.join(session.profile, "media-tracker-session.json"), "utf8")); assert.equal(after.pid, session.saved.pid); assert.equal(after.launchId, session.saved.launchId);
    await writeFile(path.join(session.profile, "media-tracker-session.json"), JSON.stringify({ ...after, helperPid: 999999999 }));
    await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), (error) => error.code === "profile-busy"); assert.equal(other.isClosed(), false);
    await writeFile(path.join(session.profile, "media-tracker-session.json"), JSON.stringify(after));
  } finally { t.mock.restoreAll(); await session.clean(); await new Promise((resolve) => server.close(resolve)); }
});

test("owned popup tabs are reclaimed, tab-free workers exit after idle grace, and fresh workers need warm-up", { skip: process.platform !== "win32", timeout: 80_000 }, async () => {
  const session = await temporarySession();
  let lease;
  let reopenedObserver;
  try {
    const context = session.observer.contexts()[0];
    // Observe creation at the protocol level: the worker can close its popup
    // before Playwright has finished initializing a Page object for that tab.
    const cdp = await session.observer.newBrowserCDPSession();
    let createdPages = 0;
    cdp.on("Target.targetCreated", ({ targetInfo }) => { if (targetInfo.type === "page") createdPages++; });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    lease = await acquireTikTokPage({ profileDirectory: session.profile });
    lease.markHomeWarmupComplete();
    await lease.page.goto("data:text/html,<title>Worker popup fixture</title>");
    await lease.page.evaluate(() => { window.open("about:blank", "fixture-child"); });
    await lease.page.evaluate(() => { window.open("about:blank", "fixture-noopener", "noopener"); });
    await waitFor(() => createdPages >= 3, "Expected work tab and both popup fixtures");
    await waitFor(async () => (await cdp.send("Target.getTargets")).targetInfos.filter((info) => info.type === "page").length === 1,
      "Owned popup targets remained alive");
    await lease.release();
    assert.equal((await cdp.send("Target.getTargets")).targetInfos.filter((info) => ["page", "other"].includes(info.type)).length, 0);
    await cdp.detach();
    // Discovery hands over to the image stream without reopening Chromium or
    // accumulating a second work page during the idle grace interval.
    lease = await acquireTikTokPage({ profileDirectory: session.profile, purpose: "download" });
    assert.equal(lease.needsHomeWarmup, false);
    assert.equal(JSON.parse(await readFile(path.join(session.profile, "media-tracker-session.json"), "utf8")).pid, session.saved.pid);
    assert.equal(context.pages().length, 1);
    await lease.release();
    await waitFor(() => !session.observer.isConnected(), "Idle worker stayed connected", TIKTOK_BACKGROUND_IDLE_MS + 15_000);
    await waitFor(async () => !(await dedicatedProfileProcesses(session.profile)).length, "Idle worker process did not exit");
    lease = await acquireTikTokPage({ profileDirectory: session.profile });
    assert.equal(lease.needsHomeWarmup, true, "A retired endpoint must not keep the old home warm-up cache");
    const next = JSON.parse(await readFile(path.join(session.profile, "media-tracker-session.json"), "utf8"));
    assert.notEqual(next.launchId, session.saved.launchId);
    reopenedObserver = await connect(next.port);
    await lease.release();
  } finally {
    await lease?.release();
    if (reopenedObserver?.isConnected()) {
      const cdp = await reopenedObserver.newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
      await reopenedObserver.close().catch(() => {});
    }
    await session.clean();
  }
});

test("an unrelated blank page prevents background shutdown and is never mistaken for a disposable worker", { skip: process.platform !== "win32", timeout: 55_000 }, async () => {
  const session = await temporarySession();
  try {
    const blank = await session.observer.contexts()[0].newPage();
    const lease = await acquireTikTokPage({ profileDirectory: session.profile });
    await lease.release();
    await assert.rejects(openTikTokLoginWindow(session.profile), (error) => error.code === "profile-busy");
    assert.equal(blank.isClosed(), false);
    // Releasing again schedules safe idle inspection; an unknown about:blank
    // remains protected even after the grace interval has elapsed.
    const next = await acquireTikTokPage({ profileDirectory: session.profile });
    await next.release();
    await new Promise((resolve) => setTimeout(resolve, TIKTOK_BACKGROUND_IDLE_MS + 2_500));
    assert.equal(blank.isClosed(), false);
    assert.equal(session.observer.isConnected(), true);
    assert.equal((await dedicatedProfileProcesses(session.profile))[0].pid, session.saved.pid);
  } finally { await session.clean(); }
});
test("interactive or legacy browsers are not reused for background work or automatically closed", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const session = await temporarySession({ interactive: true });
  try {
    await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), (error) => error.code === "profile-interactive-active" && /关闭.*专用登录窗口/.test(error.message));
    assert.equal(session.observer.isConnected(), true); assert.equal(session.observer.contexts()[0].pages().length, 0);
    assert.equal((await dedicatedProfileProcesses(session.profile))[0].pid, session.saved.pid);
  } finally { await session.clean(); }
});

test("cache maintenance waits for an idle worker to exit and blocks new leases until deletion finishes", { skip: process.platform !== "win32", timeout: 40_000 }, async () => {
  const session = await temporarySession();
  try {
    const lease = await acquireTikTokPage({ profileDirectory: session.profile });
    let cleanCalls = 0;
    const clean = async () => {
      cleanCalls++;
      assert.equal((await dedicatedProfileProcesses(session.profile)).length, 0);
      await assert.rejects(acquireTikTokPage({ profileDirectory: session.profile }), (error) => error.code === "profile-busy");
      await assert.rejects(openTikTokLoginWindow(session.profile), (error) => error.code === "profile-busy");
      return { status: "cleaned" };
    };
    assert.equal((await withIdleTikTokProfile(session.profile, clean)).reason, "profile-busy");
    assert.equal(cleanCalls, 0);
    await lease.release();
    assert.equal((await withIdleTikTokProfile(session.profile, clean)).status, "cleaned");
    assert.equal(cleanCalls, 1);
    assert.equal(session.observer.isConnected(), false);
  } finally { await session.clean(); }
});

test("cache maintenance never retires user pages or interactive sessions", { skip: process.platform !== "win32", timeout: 40_000 }, async () => {
  for (const interactive of [false, true]) {
    const session = await temporarySession({ interactive });
    try {
      const page = await session.observer.contexts()[0].newPage();
      let cleanCalls = 0;
      const result = await withIdleTikTokProfile(session.profile, async () => { cleanCalls++; });
      assert.equal(result.reason, "profile-busy");
      assert.equal(cleanCalls, 0);
      assert.equal(page.isClosed(), false);
      assert.equal(session.observer.isConnected(), true);
    } finally { await session.clean(); }
  }
});
