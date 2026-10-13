import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { APP_TITLEBAR_BINDING, APP_TITLEBAR_THEMES, attachAppTitlebarTheme } from "../lib/app-titlebar-theme.mjs";
import { createAppShell } from "../lib/app-shell.mjs";

function fixture({ send, startupError, reporter } = {}) {
  const calls = [];
  const errors = [];
  let detaches = 0;
  const frame = { url: () => "http://127.0.0.1:54362/" };
  const page = { mainFrame: () => frame, bindings: new Map(), initScripts: [], evaluations: [],
    async exposeBinding(name, callback) { this.bindings.set(name, callback); },
    async addInitScript(fn, args) { this.initScripts.push({ fn, args }); },
    async evaluate(fn, args) { this.evaluations.push({ fn, args }); },
  };
  const session = {
    async send(method, args) { calls.push({ method, args }); if (send) return send(method, args); return { id: "fixed-theme-id" }; },
    async detach() { detaches++; },
  };
  const context = { browser: () => ({ newBrowserCDPSession: async () => { if (startupError) throw startupError; return session; } }) };
  const start = () => attachAppTitlebarTheme({ context, page, url: frame.url(), onError: reporter || ((error) => errors.push(error)) });
  const request = (theme, source = { page, frame }) => page.bindings.get(APP_TITLEBAR_BINDING)(source, theme);
  return { start, page, frame, context, request, calls, errors, get detaches() { return detaches; } };
}

test("titlebar palette matches the actual light/dark frost and ink CSS tokens; themes have no code or permissions", async () => {
  const styles = await readFile(path.join(import.meta.dirname, "../public/styles.css"), "utf8");
  const blocks = { light: styles.split(':root[data-theme="dark"]')[0], dark: styles.split(':root[data-theme="dark"]')[1] };
  for (const theme of ["light", "dark"]) {
    const manifest = JSON.parse(await readFile(path.join(APP_TITLEBAR_THEMES[theme], "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["manifest_version", "name", "theme", "version"]);
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(Object.keys(manifest.theme), ["colors"]);
    const rgb = (token) => blocks[theme].match(new RegExp(`--${token}:\\s*#([a-f0-9]{6})`, "i"))[1].match(/../g).map((value) => parseInt(value, 16));
    assert.deepEqual(manifest.theme.colors.frame, rgb("frost"));
    assert.deepEqual(manifest.theme.colors.frame_inactive, rgb("frost"));
    assert.deepEqual(manifest.theme.colors.tab_background_text, rgb("ink"));
  }
});

test("titlebar binding accepts only the exact primary top frame and local origin with light/dark values", async () => {
  const f = fixture();
  const controller = await f.start();
  assert.equal(f.page.initScripts.length, 1);
  assert.equal(f.page.evaluations.length, 1);
  for (const value of [null, undefined, "system", "__proto__", "C:\\evil", { path: "C:\\evil" }]) assert.equal(await f.request(value), false);
  assert.equal(await f.request("light", { page: {}, frame: f.frame }), false);
  assert.equal(await f.request("light", { page: f.page, frame: { url: () => f.frame.url() } }), false);
  f.frame.url = () => "http://127.0.0.1:54363/";
  assert.equal(await f.request("light"), false);
  f.frame.url = () => "https://example.com/";
  assert.equal(await f.request("dark"), false);
  f.frame.url = () => "about:blank";
  assert.equal(await f.request("dark"), false);
  assert.deepEqual(f.calls, []);
  f.frame.url = () => "http://127.0.0.1:54362/#people";
  assert.equal(await f.request("light"), true);
  assert.deepEqual(f.calls, [{ method: "Extensions.loadUnpacked", args: { path: APP_TITLEBAR_THEMES.light } }]);
  assert.equal(controller.theme, "light");
  await controller.close();
  assert.equal(f.detaches, 1);
  assert.equal(await f.request("dark"), false);
  assert.equal(f.calls.length, 1);
});

test("rapid titlebar switching coalesces queued updates and never leaves an older theme applied last", async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const f = fixture({ send: async () => { if (f.calls.length === 1) await hold; } });
  const controller = await f.start();
  const first = f.request("light");
  const second = f.request("dark");
  const third = f.request("light");
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(f.calls.length, 1, "A superseded intermediate theme need not be loaded");
  assert.equal(await f.request("dark"), true);
  assert.equal(f.calls.length, 2);
  assert.equal(controller.theme, "dark");
  const boundary = f.request("light").then(() => Promise.resolve().then(() => f.request("dark")));
  await boundary;
  assert.equal(controller.theme, "dark", "A microtask-boundary request must not be stranded");
  await controller.close();
});

test("timed-out native commands retain no applied theme and do not resume queued changes", { timeout: 5000 }, async () => {
  const f = fixture({ send: () => new Promise(() => {}) });
  const controller = await f.start();
  const first = f.request("light");
  await Promise.resolve();
  const second = f.request("dark");
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(controller.theme, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /timed out/);
  assert.equal(await f.request("dark"), false);
  assert.equal(f.calls.length, 1);
  await controller.close();
});

test("close bounds detach and in-flight theme waits without leaving a shutdown-blocking adapter", { timeout: 5000 }, async () => {
  const f = fixture({ send: () => new Promise(() => {}) });
  f.context.browser = () => ({ newBrowserCDPSession: async () => ({
    send: () => new Promise(() => {}), detach: () => new Promise(() => {}),
  }) });
  const controller = await f.start();
  const inFlight = f.request("dark");
  await Promise.resolve();
  const began = performance.now();
  await controller.close();
  assert.ok(performance.now() - began < 600, "A stuck CDP detach cannot block app shutdown");
  assert.equal(await f.request("light"), false);
  assert.equal(await inFlight, false);
  assert.equal(controller.theme, undefined);
  assert.deepEqual(f.errors, [], "Closing a window is not a theme error");
});

test("CDP compatibility failure is diagnosed once without failing the tool or leaking a session", async () => {
  const f = fixture({ send: () => { throw new Error("Extensions protocol unavailable"); } });
  const controller = await f.start();
  assert.equal(await f.request("light"), false);
  assert.equal(await f.request("dark"), false);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /titlebar theme.*tool can still run.*protocol unavailable/);
  assert.equal(f.calls.length, 1);
  await controller.close();
  assert.equal(f.detaches, 1);
  for (const reporter of [() => { throw new Error("diagnostic failed"); }, async () => { throw new Error("diagnostic rejected"); }]) {
    const broken = fixture({ startupError: new Error("Unsupported browser"), reporter });
    const safe = await broken.start();
    await safe.close();
  }
});

test("owned app shell isolates optional titlebar setup, launches no public debugging port and disposes its adapter", async () => {
  let args;
  let closes = 0;
  let contextsClosed = 0;
  const page = { isClosed: () => false, url: () => "http://127.0.0.1:54362/", once() {}, async bringToFront() {} };
  const context = { pages: () => [page], once() {}, browser: () => ({ once() {} }), async close() { contextsClosed++; } };
  const errors = [];
  const browserType = { executablePath: () => "C:\\private\\chrome.exe", async launchPersistentContext(_profile, options) { args = options; return context; } };
  for (const fails of [false, true]) {
    const shell = createAppShell({ profileDirectory: "D:\\isolated-app-profile", browserType, platform: "win32", onError: (error) => errors.push(error),
      titlebarThemeFactory: async ({ context: owned, page: primary, url }) => {
        assert.equal(owned, context); assert.equal(primary, page); assert.equal(url, page.url());
        if (fails) throw new Error("Theme fixture unavailable");
        return { async close() { closes++; } };
      } });
    assert.equal(await shell.open(page.url()), page);
    assert.equal(shell.ready, true);
    assert.ok(args.ignoreDefaultArgs.includes("--disable-extensions"));
    assert.ok(args.args.includes("--enable-unsafe-extension-debugging"));
    assert.ok(args.args.every((arg) => !arg.startsWith("--remote-debugging-port") && !arg.startsWith("--load-extension")));
    await shell.close();
  }
  assert.equal(closes, 1);
  assert.equal(contextsClosed, 2);
  assert.equal(errors.length, 1);
});

test("real isolated Chromium observes theme switches, reload and system resolution with one page and no outside requests", { timeout: 20_000 }, async (t) => {
  try { await access(chromium.executablePath()); } catch { t.skip("Bundled Chromium is not installed."); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), "collector-titlebar-offline-"));
  const bootstrap = await readFile(path.join(import.meta.dirname, "../public/theme-bootstrap.js"), "utf8");
  const styles = await readFile(path.join(import.meta.dirname, "../public/styles.css"), "utf8");
  const server = http.createServer((_req, response) => response.end(`<!doctype html><html><head><title>Offline collector titlebar test</title><script>${bootstrap}</script><style>${styles}</style></head><body>Offline owned-window fixture</body></html>`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let context;
  let controller;
  t.after(async () => {
    await controller?.close(); await context?.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("collector-titlebar-offline-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  context = await chromium.launchPersistentContext(profile, { headless: true,
    // Resolve a controlled dark system preference in this document-only
    // fixture. Production shell leaves the native preference unemulated.
    colorScheme: "dark", timeout: 5000 });
  const outside = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    outside.push(route.request().url()); return route.abort();
  });
  const page = context.pages()[0];
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const errors = [];
  const loads = [];
  // Headless Chromium has no native frame; its extension-theme install may
  // wait forever for a frame consumer. Exercise the real document/binding
  // integration with a protocol adapter here; the opt-in headed test below
  // loads the actual bundled themes and reads native window pixels.
  const adapterContext = { browser: () => ({ newBrowserCDPSession: async () => ({
    async send(method, args) { loads.push({ method, args }); return { id: "isolated-theme-fixture" }; }, async detach() {},
  }) }) };
  controller = await attachAppTitlebarTheme({ context: adapterContext, page, url, onError: (error) => errors.push(error) });
  const waitTheme = async (theme) => {
    const deadline = Date.now() + 4000;
    while (controller.theme !== theme && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(controller.theme, theme);
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), theme === "dark" ? "#0d1420" : "#f4f7fb");
  };
  await waitTheme("dark");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await waitTheme("light");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await waitTheme("dark");
  await page.evaluate(() => localStorage.setItem("media-tracker-theme", "light"));
  await page.reload();
  await waitTheme("light");
  await page.evaluate(() => localStorage.setItem("media-tracker-theme", "system"));
  await page.reload();
  await waitTheme("dark");
  assert.equal(context.pages().length, 1);
  assert.deepEqual(loads.map((call) => call.args.path), [APP_TITLEBAR_THEMES.dark, APP_TITLEBAR_THEMES.light, APP_TITLEBAR_THEMES.dark, APP_TITLEBAR_THEMES.light, APP_TITLEBAR_THEMES.dark]);
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
});

test("native Windows titlebar pixels match the current CSS background after repeated switches", {
  skip: process.platform !== "win32" || process.env.MEDIA_TRACKER_NATIVE_TITLEBAR_TEST !== "1",
  timeout: 20_000,
}, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "collector-titlebar-native-"));
  const server = http.createServer((_req, response) => response.end('<!doctype html><html data-theme="light"><title>Offline collector native titlebar fixture</title><style>:root{--frost:#f4f7fb} :root[data-theme=dark]{--frost:#0d1420} body{background:var(--frost)}</style><body>Local offline fixture only</body></html>'));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let context;
  let controller;
  t.after(async () => {
    await controller?.close(); await context?.close(); await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("collector-titlebar-native-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null, colorScheme: null,
    ignoreDefaultArgs: ["about:blank", "--enable-automation", "--disable-extensions"],
    args: [`--app=${url}`, "--enable-unsafe-extension-debugging"] });
  const page = context.pages()[0];
  await page.waitForLoadState("domcontentloaded");
  controller = await attachAppTitlebarTheme({ context, page, url });
  const session = await context.browser().newBrowserCDPSession();
  const pid = (await session.send("SystemInfo.getProcessInfo")).processInfo.find((info) => info.type === "browser").id;
  await session.detach();
  for (const theme of ["light", "dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const deadline = Date.now() + 4000;
    while (controller.theme !== theme && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(controller.theme, theme);
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "fixtures/titlebar-sample.ps1"),
      "-BrowserProcessId", String(pid), "-OutputPath", path.join(profile, `${theme}.png`)], { windowsHide: true, timeout: 5000 });
    assert.equal(stdout.trim(), theme === "light" ? "#f4f7fb" : "#0d1420");
    assert.equal(context.pages().length, 1);
  }
});
