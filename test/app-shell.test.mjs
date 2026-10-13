import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { createAppShell } from "../lib/app-shell.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
class FakePage extends EventEmitter {
  constructor(url) { super(); this.address = url; this.closed = false; this.focuses = 0; this.navigations = []; }
  url() { return this.address; }
  isClosed() { return this.closed; }
  async goto(url) { this.navigations.push(url); this.address = url; }
  async bringToFront() { this.focuses++; }
  async close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
}
class FakeContext extends EventEmitter {
  constructor(pages) { super(); this.items = pages; this.ownerBrowser = new EventEmitter(); this.closes = 0; }
  pages() { return this.items.filter((page) => !page.isClosed()); }
  browser() { return this.ownerBrowser; }
  async close() {
    this.closes++;
    await Promise.all(this.items.map((page) => page.close()));
    this.emit("close"); this.ownerBrowser.emit("disconnected");
  }
}
function fixture({ pages, pending, callback, errors = [], timingCallback, errorCallback } = {}) {
  const page = new FakePage("http://127.0.0.1:43178/");
  const context = new FakeContext(pages || [page]);
  const calls = [];
  const notices = [];
  const timings = [];
  const browserType = {
    executablePath: () => "C:\\private\\chrome.exe",
    async launchPersistentContext(profile, options) { calls.push({ profile, options }); await pending; return context; },
  };
  const shell = createAppShell({ profileDirectory: "D:\\tool\\data\\builtin-app-profile-v1", browserType,
    onLastWindowClosed: callback || ((notice) => notices.push(notice)), onError: errorCallback || ((error) => errors.push(error)),
    onStartupTiming: timingCallback || ((timing) => timings.push(timing)) });
  return { shell, page, context, calls, notices, errors, timings };
}

test("owned app shell launches exactly one private GUI page without a blank startup argument", async () => {
  const { shell, page, context, calls, notices } = fixture();
  assert.equal(await shell.open("http://127.0.0.1:43178/"), page);
  assert.equal(shell.ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile, "D:\\tool\\data\\builtin-app-profile-v1");
  assert.equal(calls[0].options.executablePath, "C:\\private\\chrome.exe");
  assert.equal(calls[0].options.headless, false);
  assert.equal(calls[0].options.viewport, null);
  assert.equal(calls[0].options.colorScheme, null, "Do not emulate a light system theme in the managed app window");
  assert.deepEqual(calls[0].options.ignoreDefaultArgs, ["about:blank", "--enable-automation"]);
  assert.deepEqual(calls[0].options.args, ["--no-first-run", "--disable-background-mode", "--app=http://127.0.0.1:43178/"]);
  await shell.close(); await tick();
  assert.equal(context.closes, 1);
  assert.deepEqual(notices, []);
  assert.equal(shell.closing, true);
});

test("concurrent and repeated opening focuses the same app without navigation or extra launches", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { shell, page, calls, timings } = fixture({ pending });
  const first = shell.open("http://127.0.0.1:43178/");
  const second = shell.open("http://127.0.0.1:43178/");
  release();
  assert.deepEqual(await Promise.all([first, second]), [page, page]);
  await shell.open("http://127.0.0.1:43178/");
  assert.equal(calls.length, 1);
  assert.equal(page.focuses, 3);
  assert.deepEqual(page.navigations, []);
  assert.equal(timings.length, 4, "Repeated focus must not record another browser launch");
  await shell.close();
});

test("startup diagnostics contain only ordered local stage names and finite elapsed milliseconds", async () => {
  const { shell, timings, notices } = fixture();
  await shell.open("http://127.0.0.1:43178/");
  assert.deepEqual(timings.map((timing) => timing.stage), ["launch-start", "browser-context-ready", "primary-page-ready", "window-focused"]);
  for (let i = 0; i < timings.length; i++) {
    assert.deepEqual(Object.keys(timings[i]).sort(), ["elapsedMs", "stage"]);
    assert.ok(Number.isFinite(timings[i].elapsedMs));
    assert.ok(timings[i].elapsedMs >= 0);
    if (i) assert.ok(timings[i].elapsedMs >= timings[i - 1].elapsedMs);
  }
  await shell.close();
  assert.deepEqual(notices, []);
});

for (const mode of ["sync", "async"]) {
  test(`${mode} startup diagnostics failure cannot block window readiness or intentional shutdown`, async () => {
    const failure = new Error("Offline timing callback failure");
    const timingCallback = mode === "sync" ? () => { throw failure; } : async () => { throw failure; };
    const { shell, page, context, notices, errors } = fixture({ timingCallback });
    assert.equal(await shell.open("http://127.0.0.1:43178/"), page);
    await tick();
    assert.equal(shell.ready, true);
    assert.deepEqual(errors, [failure, failure, failure, failure]);
    await shell.close();
    assert.equal(context.closes, 1);
    assert.deepEqual(notices, []);
  });
}

test("a failing timing error reporter is also isolated from opening and closing the owned window", async () => {
  for (const reporter of [() => { throw new Error("Offline reporter error"); }, async () => { throw new Error("Offline reporter rejection"); }]) {
    const { shell, page, notices } = fixture({ timingCallback: () => { throw new Error("Offline timing failure"); }, errorCallback: reporter });
    assert.equal(await shell.open("http://127.0.0.1:43178/"), page);
    await tick();
    assert.equal(shell.ready, true);
    await shell.close();
    assert.deepEqual(notices, []);
  }
});

test("reload, navigation and unrelated context events never request backend shutdown", async () => {
  const { shell, page, context, notices } = fixture();
  await shell.open("http://127.0.0.1:43178/");
  page.emit("framenavigated"); page.emit("load"); page.emit("domcontentloaded");
  page.emit("requestfailed"); context.emit("page", new FakePage("https://example.com/"));
  await tick();
  assert.deepEqual(notices, []);
  assert.equal(shell.ready, true);
  await shell.close();
});

test("native primary-window close signals shutdown once even when context and browser also close", async () => {
  const { shell, page, context, notices } = fixture();
  await shell.open("http://127.0.0.1:43178/");
  await page.close(); context.emit("close"); context.browser().emit("disconnected");
  await tick();
  assert.deepEqual(notices, [{ reason: "app-window-closed" }]);
  assert.equal(shell.ready, false);
  assert.equal(shell.closing, true);
  await assert.rejects(shell.open("http://127.0.0.1:43178/"), /shutting down/);
  await shell.close();
  assert.equal(notices.length, 1);
});

test("native frame close that already ended its owned context is a successful idempotent shutdown", async () => {
  const page = new FakePage("http://127.0.0.1:43178/");
  const context = new FakeContext([page]);
  const notices = [], errors = [];
  let frameCloses = 0;
  context.close = async () => { context.closes++; throw new Error("browserContext.close: Target page, context or browser has been closed"); };
  const shell = createAppShell({ profileDirectory: "D:\\isolated\\app-profile", platform: "win32",
    browserType: { executablePath: () => "private.exe", launchPersistentContext: async () => context },
    onLastWindowClosed: (notice) => notices.push(notice), onError: (error) => errors.push(error),
    windowFrameFactory: async () => ({ focus: async () => {}, close: async () => {
      frameCloses++; await page.close(); context.emit("close"); context.browser().emit("disconnected");
    } }),
  });
  await shell.open("http://127.0.0.1:43178/");
  const first = shell.close(), second = shell.close();
  assert.equal(first, second);
  await first; await tick();
  assert.equal(frameCloses, 1);
  assert.equal(context.closes, 0, "Do not close the already-ended owned context again");
  assert.equal(shell.ready, false);
  assert.deepEqual(notices, []);
  assert.deepEqual(errors, []);
});

for (const event of ["close", "disconnected"]) {
  test(`${event} observed during owned context.close permits only the known target-closed race`, async () => {
    const { shell, context, notices, errors } = fixture();
    await shell.open("http://127.0.0.1:43178/");
    context.close = async () => {
      context.closes++;
      if (event === "close") context.emit("close"); else context.browser().emit("disconnected");
      throw new Error("browserContext.close: Target page, context or browser has been closed");
    };
    await shell.close();
    assert.equal(context.closes, 1);
    assert.deepEqual(notices, []);
    assert.deepEqual(errors, []);
  });
}

test("unobserved target-closed errors and genuine close failures are not treated as successful shutdown", async () => {
  for (const [failure, emitClose] of [
    [new Error("browserContext.close: Target page, context or browser has been closed"), false],
    [new Error("Private context close failed to flush state"), false],
    [new Error("Private context close failed to flush state"), true],
  ]) {
    const { shell, context } = fixture();
    await shell.open("http://127.0.0.1:43178/");
    context.close = async () => { context.closes++; if (emitClose) context.emit("close"); throw failure; };
    await assert.rejects(shell.close(), (error) => error === failure);
    assert.equal(context.closes, 1);
  }
});

test("page crash alone does not suppress an actual context close failure", async () => {
  const { shell, page, context, notices } = fixture();
  await shell.open("http://127.0.0.1:43178/");
  page.emit("crash"); await tick();
  const failure = new Error("Private context still needs cleanup");
  context.close = async () => { context.closes++; throw failure; };
  await assert.rejects(shell.close(), (error) => error === failure);
  assert.equal(context.closes, 1);
  assert.deepEqual(notices, [{ reason: "app-window-crashed" }]);
});

for (const event of ["context-close", "browser-disconnected", "page-crash"]) {
  test(`${event} stops the owning app lifecycle without depending on web unload`, async () => {
    const { shell, page, context, notices } = fixture();
    await shell.open("http://127.0.0.1:43178/");
    if (event === "context-close") context.emit("close");
    else if (event === "browser-disconnected") context.browser().emit("disconnected");
    else page.emit("crash");
    await tick();
    assert.equal(notices.length, 1);
    assert.equal(shell.ready, false);
    await shell.close();
  });
}

test("startup discards stale blank/restored pages and uses the actual current service port", async () => {
  const blank = new FakePage("about:blank");
  const app = new FakePage("http://127.0.0.1:4178/");
  const extra = new FakePage("chrome://newtab/");
  const { shell, notices } = fixture({ pages: [blank, app, extra] });
  assert.equal(await shell.open("http://127.0.0.1:43178/"), app);
  assert.equal(blank.isClosed(), true); assert.equal(extra.isClosed(), true);
  assert.deepEqual(app.navigations, ["http://127.0.0.1:43178/"]);
  assert.deepEqual(notices, []);
  await shell.close();
});

test("primary-window close does not let an owned popup keep the background alive", async () => {
  const { shell, page, context, notices } = fixture();
  await shell.open("http://127.0.0.1:43178/");
  const popup = new FakePage("https://example.com/");
  context.items.push(popup); context.emit("page", popup);
  await page.close(); await tick();
  assert.equal(popup.isClosed(), false);
  assert.equal(notices.length, 1);
  await shell.close();
  assert.equal(popup.isClosed(), true);
});

test("intentional shutdown during a pending launch closes the owned context without recursion", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { shell, context, notices } = fixture({ pending });
  const opened = shell.open("http://127.0.0.1:43178/");
  const closed = shell.close();
  release();
  await assert.rejects(opened, /shutting down/);
  await closed; await tick();
  assert.ok(context.closes >= 1);
  assert.deepEqual(notices, []);
});

test("shutdown callback rejection is reported once without an unhandled event promise", async () => {
  const failure = new Error("shutdown fixture failed");
  const { shell, page, context, errors } = fixture({ callback: async () => { throw failure; } });
  await shell.open("http://127.0.0.1:43178/");
  await page.close(); context.emit("close");
  await tick();
  assert.deepEqual(errors, [failure]);
  await shell.close();
});

test("no-window startup and launch errors clean up only the context owned by the shell", async () => {
  const { shell, context, notices } = fixture({ pages: [] });
  await assert.rejects(shell.open("http://127.0.0.1:43178/"), /did not open/);
  assert.equal(context.closes, 1);
  assert.equal(shell.ready, false);
  await tick();
  assert.deepEqual(notices, []);
  const failed = createAppShell({ profileDirectory: "D:\\fixture", browserType: {
    executablePath: () => "fixture", launchPersistentContext: async () => { throw new Error("launch failed"); },
  } });
  await assert.rejects(failed.open("http://127.0.0.1:43178/"), /launch failed/);
  await failed.close();
});

test("shell rejects external service URLs without launching any browser", async () => {
  for (const url of ["https://example.com/", "file:///C:/private", "http://evil.example/"]) {
    const { shell, calls } = fixture();
    await assert.rejects(shell.open(url), /local tool service/);
    assert.deepEqual(calls, []);
    await shell.close();
  }
});

test("offline bundled Chromium owns one app page and closing it signals exit; reload does not", { timeout: 20_000 }, async (t) => {
  try { await access(chromium.executablePath()); } catch { t.skip("Bundled Chromium is not installed."); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), "collector-app-shell-offline-"));
  const server = http.createServer((_request, response) => response.end("<title>Offline app shell fixture</title>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context;
  let notify;
  let calls = 0;
  const closed = new Promise((resolve) => { notify = resolve; });
  const shell = createAppShell({ profileDirectory: profile, launchTimeoutMs: 10_000,
    browserType: {
      executablePath: () => chromium.executablePath(),
      async launchPersistentContext(directory, options) {
        // Exercise the real --app startup/page lifetime without displaying a
        // test window. Production remains headless:false and uses its own data.
        context = await chromium.launchPersistentContext(directory, { ...options, headless: true });
        return context;
      },
    },
    onLastWindowClosed: (notice) => { calls++; notify(notice); },
  });
  t.after(async () => {
    await shell.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("collector-app-shell-offline-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const page = await shell.open(url);
  assert.equal(shell.ready, true);
  assert.equal(context.pages().length, 1);
  assert.equal(page.url(), url);
  await page.reload();
  assert.equal(shell.ready, true);
  assert.equal(calls, 0);
  assert.equal(await shell.open(url), page);
  assert.equal(context.pages().length, 1);
  await page.close();
  assert.deepEqual(await closed, { reason: "app-window-closed" });
  await shell.close();
  assert.equal(context.browser()?.isConnected(), false);
  assert.equal(calls, 1);
});

test("managed app preserves native dark preference while explicit light/dark and system UI modes remain usable", { timeout: 20_000 }, async (t) => {
  try { await access(chromium.executablePath()); } catch { t.skip("Bundled Chromium is not installed."); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), "collector-app-theme-offline-"));
  const server = http.createServer((_request, response) => response.end(`<!doctype html><title>Offline native theme fixture</title>
    <input type="radio" name="theme" value="system"><input type="radio" name="theme" value="light"><input type="radio" name="theme" value="dark">`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shell = createAppShell({ profileDirectory: profile, launchTimeoutMs: 10_000, browserType: {
    executablePath: () => chromium.executablePath(),
    launchPersistentContext: (directory, options) => chromium.launchPersistentContext(directory, {
      ...options, headless: true,
      // Give only this isolated test browser a native dark default. This does
      // not change Windows or production profiles. Omitting colorScheme:null
      // regresses this case because Playwright overrides the default to light.
      args: [...options.args, "--force-dark-mode"],
    }),
  } });
  t.after(async () => {
    await shell.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("collector-app-theme-offline-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const page = await shell.open(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true,
    "Playwright must not replace the native browser dark preference with emulated light");
  const frontend = await readFile(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  const applyThemeSource = frontend.match(/function applyTheme\(preference\) \{[\s\S]*?\r?\n\}(?=\r?\n\r?\nfunction requestChoice)/)?.[0];
  assert.ok(applyThemeSource, "Exercise the real frontend theme function, not a separately rewritten implementation");
  for (const [preference, expected] of [["system", "dark"], ["light", "light"], ["dark", "dark"], ["system", "dark"]]) {
    const result = await page.evaluate(({ source, preference }) => {
      const apply = new Function("systemTheme", "preference", `${source}; applyTheme(preference);`);
      apply(window.matchMedia("(prefers-color-scheme: dark)"), preference);
      return { preference: document.documentElement.dataset.themePreference,
        theme: document.documentElement.dataset.theme,
        stored: localStorage.getItem("media-tracker-theme"),
        checked: [...document.querySelectorAll('input[name="theme"]')].filter((input) => input.checked).map((input) => input.value),
        nativeDark: matchMedia("(prefers-color-scheme: dark)").matches };
    }, { source: applyThemeSource, preference });
    assert.deepEqual(result, { preference, theme: expected, stored: preference, checked: [preference], nativeDark: true });
  }
});
