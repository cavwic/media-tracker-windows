import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Fully routed, offline UI fixtures: no production service, profiles, media,
// installers, ffmpeg processes, component downloads or external HTTP requests.
const origin = "http://127.0.0.1:54349";
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const idle = { status: "idle", scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], results: [] };
const missing = { ready: false, installAvailable: true, directory: "", defaultInstallDirectory: "D:\\Portable\\tools",
  message: "相似去重需要 FFmpeg 和 ffprobe；请安装组件或指定已有工具目录。" };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out: " + label);
}
async function fixture(t, { theme = "dark", colorScheme = "dark", syncing = false, status = missing } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 1000 }, colorScheme, reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.clock.install();
  const model = { linkedAccounts: [], platforms: { x: { label: "X" } }, settings: { theme }, dedupStatus: idle,
    persons: [{ id: "a", name: "测试人物", platforms: [], folderPath: "D:\\Fixture\\A" }],
    syncSummaries: syncing ? { a: { id: "sync-a", personId: "a", status: "running", newFileCount: 0,
      message: "Offline sync fixture", errors: [], warnings: [], counters: { accounts: 1, accountsFinished: 0 } } } : {} };
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "styles.css", "theme-bootstrap.js"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [], handlers = new Map(), external = [], errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (!pathname.startsWith("/api/")) {
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      return route.fulfill({ status: assets.has(name) ? 200 : 404,
        contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
        body: assets.get(name) || "Not found" });
    }
    const call = { path: pathname, method: request.method(), body: request.postDataJSON() };
    calls.push(call);
    let payload;
    if (handlers.has(`${call.method} ${pathname}`)) payload = await handlers.get(`${call.method} ${pathname}`)(request);
    else if (pathname === "/api/state") payload = structuredClone(model);
    else if (pathname === "/api/tools/dedup") payload = structuredClone(status);
    else if (pathname === "/api/dedup-status") payload = structuredClone(model.dedupStatus);
    else if (pathname === "/api/sync-jobs/sync-a") payload = structuredClone(model.syncSummaries.a);
    else if (pathname === "/api/dedup-all" || pathname === "/api/dedup-person") {
      model.dedupStatus = { ...idle, id: "offline-dedup", scope: pathname.endsWith("person") ? "person" : "all",
        personId: call.body.personId || null, status: "running", currentPersonId: "a", message: "Offline dedup fixture" };
      payload = structuredClone(model.dedupStatus);
    } else if (pathname === "/api/folders/pick") payload = { selectedPath: "D:\\Selected\\Tools" };
    else payload = { _status: 404, error: "Unexpected fixture API: " + pathname };
    await route.fulfill({ status: payload._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator(".person-card").count() === 1, "fixture UI loaded");
  return { page, calls, handlers, model };
}
const count = (calls, path, method) => calls.filter((call) => call.path === path && (!method || call.method === method)).length;
async function showTools(page) {
  await page.locator("#dedup-all-button").click();
  await until(() => page.locator("#dedup-tools-dialog").evaluate((node) => node.open), "missing tools modal");
}

test("missing tools preflight blocks dedup; declining installation or Escape issues no mutating API", async (t) => {
  const { page, calls } = await fixture(t);
  await showTools(page);
  assert.equal(count(calls, "/api/tools/dedup", "GET"), 1);
  assert.equal(await page.locator("#dedup-tools-install-path").inputValue(), missing.defaultInstallDirectory);
  assert.match(await page.locator("#dedup-tools-help").textContent(), /FFmpeg.*ffprobe.*不上传媒体.*不使用 AI/);
  await page.locator("#dedup-tools-cancel").click();
  await until(async () => !(await page.locator("#dedup-all-button").isDisabled()), "dedup unlocked after decline");
  await showTools(page);
  await page.keyboard.press("Escape");
  await until(async () => !(await page.locator("#dedup-all-button").isDisabled()), "dedup unlocked after escape");
  assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
});

test("component installation requires a second confirmation; declining does not install or start dedup", async (t) => {
  const { page, calls } = await fixture(t);
  await showTools(page);
  await page.locator("#dedup-tools-install").click();
  assert.match(await page.locator("#confirm-title").textContent(), /下载并安装/);
  assert.match(await page.locator("#confirm-message").textContent(), /Gyan.*GPL-3\.0-or-later.*SHA-256.*不改系统设置.*下载完成前不开始去重/);
  await page.locator("#confirm-cancel").click();
  assert.equal(await page.locator("#dedup-tools-dialog").evaluate((node) => node.open), true);
  assert.equal(count(calls, "/api/tools/dedup/install", "POST"), 0);
  assert.equal(count(calls, "/api/dedup-all", "POST"), 0);
  await page.locator("#dedup-tools-cancel").click();
});

test("manual trusted-tool path is validated before existing dedup confirmation and starts only one job", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  const toolPath = "D:\\本地工具\\ffmpeg\\bin";
  handlers.set("PUT /api/tools/dedup", async (request) => {
    assert.deepEqual(request.postDataJSON(), { directory: toolPath });
    return { ...missing, ready: true, directory: toolPath, message: "组件已就绪" };
  });
  await showTools(page);
  await page.locator("#dedup-tools-existing-path").fill(toolPath);
  await page.locator("#dedup-tools-use-existing").click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "dedup confirmation after verified manual path");
  assert.equal(count(calls, "/api/tools/dedup", "PUT"), 1);
  assert.equal(count(calls, "/api/dedup-all", "POST"), 0);
  assert.match(await page.locator("#confirm-title").textContent(), /本地去重/);
  await page.locator("#confirm-button").click();
  await until(() => count(calls, "/api/dedup-all", "POST") === 1, "one dedup job");
  assert.equal(count(calls, "/api/tools/dedup/install", "POST"), 0);
});

test("manual validation failure retains the modal and selected path without creating a dedup job", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  handlers.set("PUT /api/tools/dedup", () => ({ _status: 400, error: "未找到同时可用的 FFmpeg 和 ffprobe。" }));
  await showTools(page);
  await page.locator("#dedup-tools-existing-path").fill("D:\\not-ready");
  await page.locator("#dedup-tools-use-existing").click();
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("未找到"), "validation error visible");
  assert.equal(await page.locator("#dedup-tools-dialog").evaluate((node) => node.open), true);
  assert.equal(await page.locator("#dedup-tools-existing-path").inputValue(), "D:\\not-ready");
  assert.equal(count(calls, "/api/dedup-all", "POST"), 0);
  assert.equal(await page.locator("#dedup-tools-use-existing").isDisabled(), false);
});

test("validated ready tools bypass the preparation dialog but not dedup confirmation", async (t) => {
  const { page, calls } = await fixture(t, { status: { ...missing, ready: true, directory: "D:\\Tools\\bin" } });
  await page.locator("#dedup-all-button").click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "confirmation for ready components");
  assert.equal(await page.locator("#dedup-tools-dialog").evaluate((node) => node.open), false);
  assert.equal(count(calls, "/api/dedup-all", "POST"), 0);
  await page.locator("#confirm-cancel").click();
});

test("single-person dedup uses the same missing-tools guard and cancellation cannot launch work", async (t) => {
  const { page, calls } = await fixture(t);
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await until(() => page.locator("#dedup-tools-dialog").evaluate((node) => node.open), "person preflight");
  await page.locator("#dedup-tools-cancel").click();
  await until(async () => !(await page.locator('.dedup-person[data-person-id="a"]').isDisabled()), "person dedup unlocked");
  assert.equal(count(calls, "/api/dedup-person", "POST"), 0);
  assert.equal(count(calls, "/api/tools/dedup/install", "POST"), 0);
});

for (const theme of ["light", "dark", "system"]) {
  test(`tool modal follows ${theme} theme and background sync polling preserves fields and nodes`, async (t) => {
    const { page, calls, model } = await fixture(t, { theme, colorScheme: "dark", syncing: true });
    await page.locator('[data-view="settings"]').click();
    await page.locator("#dedup-tools-settings").click();
    await until(() => page.locator("#dedup-tools-dialog").evaluate((node) => node.open), "tool settings modal");
    const expected = theme === "light" ? "light" : "dark";
    assert.equal(await page.locator("html").getAttribute("data-theme"), expected);
    const background = await page.locator("#dedup-tools-dialog").evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.notEqual(background, "rgba(0, 0, 0, 0)");
    const padding = await page.locator("#dedup-tools-dialog").evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft));
    assert.ok(padding >= 20, "component fields and labels have safe dialog padding");
    await page.locator("#dedup-tools-existing-path").fill("D:\\Keep\\in-progress-path");
    await page.evaluate(() => { window.retainedToolsModal = document.querySelector("#dedup-tools-dialog"); window.retainedToolsInput = document.querySelector("#dedup-tools-existing-path"); });
    model.syncSummaries.a.message = "Changed sync fixture status";
    await page.clock.runFor(800);
    await until(() => count(calls, "/api/sync-jobs/sync-a", "GET") > 0, "background sync poll");
    assert.equal(await page.evaluate(() => window.retainedToolsModal === document.querySelector("#dedup-tools-dialog")
      && window.retainedToolsInput === document.querySelector("#dedup-tools-existing-path")), true);
    assert.equal(await page.locator("#dedup-tools-existing-path").inputValue(), "D:\\Keep\\in-progress-path");
    if (theme === "system") {
      await page.emulateMedia({ colorScheme: "light" });
      await until(async () => await page.locator("html").getAttribute("data-theme") === "light", "system theme switches while modal stays open");
      await until(async () => await page.locator("#dedup-tools-dialog").evaluate((node) => getComputedStyle(node).backgroundColor) !== background,
        "themed modal surface finishes its style update");
      assert.notEqual(await page.locator("#dedup-tools-dialog").evaluate((node) => getComputedStyle(node).backgroundColor), background);
    }
    await page.locator("#dedup-tools-cancel").click();
    assert.equal(count(calls, "/api/tools/dedup/install", "POST"), 0);
  });
}
