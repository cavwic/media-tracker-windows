import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// All assets and APIs are routed offline. No real installer, account binding,
// production service, NAS media or remote download is used by these fixtures.
const origin = "http://127.0.0.1:54368";
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const idle = { status: "idle", scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], results: [] };
const count = (calls, endpoint, method = "POST") => calls.filter((call) => call.path === endpoint && call.method === method).length;
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out: " + description);
}

async function fixture(t, { theme = "dark", language = "zh", syncing = false, persons = true } = {}) {
  const context = await browser.newContext({ locale: language === "en" ? "en-US" : "zh-CN",
    colorScheme: "dark", reducedMotion: "reduce", viewport: { width: 1440, height: 1050 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.clock.install();
  page.setDefaultTimeout(5000);
  const feature = { id: "similarity-dedup", available: false, installed: false, included: false,
    installing: false, installAvailable: true, importAvailable: false, packageAvailable: true,
    message: "相似去重尚未启用；采集与精确去重保留。", progress: null };
  const tools = { ready: false, installAvailable: true, defaultInstallDirectory: "D:\\Fixture\\tools",
    directory: "", message: "未找到同时可用的 FFmpeg 与 ffprobe。" };
  const model = { linkedAccounts: [], persons: persons ? [{ id: "a", name: "采集账号 A", folderPath: "D:\\Fixture\\A", platforms: [] }] : [],
    platforms: { x: { label: "X" } }, settings: { theme, language }, features: { dedup: feature }, dedupStatus: idle,
    syncSummaries: syncing ? { a: { id: "sync-a", personId: "a", status: "running", newFileCount: 0,
      message: "Offline incremental sync", errors: [], warnings: [], counters: { accounts: 1, accountsFinished: 0 } } } : {} };
  const assets = new Map(await Promise.all(["index.html", "app.js", "styles.css", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [], handlers = new Map(), errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (!endpoint.startsWith("/api/")) {
      const name = endpoint === "/" ? "index.html" : endpoint.slice(1);
      return route.fulfill({ status: assets.has(name) ? 200 : 404, body: assets.get(name) || "Not found",
        contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" });
    }
    const call = { path: endpoint, method: request.method(), body: request.postDataJSON() }; calls.push(call);
    let payload;
    if (handlers.has(`${call.method} ${endpoint}`)) payload = await handlers.get(`${call.method} ${endpoint}`)(request);
    else if (endpoint === "/api/state") payload = structuredClone(model);
    else if (endpoint === "/api/features/dedup") payload = structuredClone(feature);
    else if (endpoint === "/api/tools/dedup") payload = structuredClone(tools);
    else if (endpoint === "/api/features/dedup/install") {
      assert.deepEqual(call.body, { confirmed: true });
      Object.assign(feature, { installing: true, progress: { id: "install-a", status: "running", phase: "download", message: "正在下载固定工具包。", bytes: 512, totalBytes: 1024 } });
      payload = { ...structuredClone(feature), _status: 202 };
    } else if (endpoint === "/api/features/dedup/cancel") {
      assert.deepEqual(call.body, { confirmed: true });
      Object.assign(feature, { installing: false, progress: { id: "install-a", status: "cancelled", phase: "cancelled", message: "下载已取消，已采集内容和登录资料保留。" } });
      payload = structuredClone(feature);
    } else if (endpoint === "/api/sync-jobs/sync-a") payload = structuredClone(model.syncSummaries.a);
    else if (endpoint === "/api/dedup-status") payload = idle;
    else if (endpoint === "/api/dedup-all" || endpoint === "/api/dedup-person") payload = { ...idle, id: "dedup-a", status: "running" };
    else payload = { _status: 404, error: "Unexpected offline fixture API: " + endpoint };
    await route.fulfill({ status: payload._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-disabled") === "true", "minimal capability loaded");
  assert.equal(await page.locator(".person-card").count(), persons ? 1 : 0);
  return { page, calls, handlers, feature, tools, model };
}

async function offer(page, selector = "#dedup-all-button") {
  await page.locator(selector).focus();
  await page.keyboard.press("Enter");
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "download consent");
}

async function acceptInstall(page) {
  await offer(page);
  await page.locator("#confirm-button").click();
  await until(() => page.locator("#dedup-tools-dialog").evaluate((node) => node.open), "tool preparation dialog");
  await until(async () => (await page.locator("#dedup-tools-cancel").textContent()).includes("取消下载"), "cancellable preparation");
}

test("unavailable minimal toolbar stays grey, in place and keyboard reachable; No and Escape never download", async (t) => {
  const { page, calls } = await fixture(t);
  assert.equal(await page.locator("#sync-all-button + #dedup-all-button").count(), 1);
  assert.equal(await page.locator("#dedup-all-button").evaluate((node) => node.disabled), false);
  assert.equal(await page.locator("#dedup-all-button").getAttribute("aria-disabled"), "true");
  assert.equal(await page.locator("#dedup-all-button").evaluate((node) => node.classList.contains("dedup-unavailable")), true);
  await offer(page);
  assert.match(await page.locator("#confirm-title").textContent(), /当前无一键去重功能，是否需要下载工具包/);
  assert.match(await page.locator("#confirm-message").textContent(), /Gyan.*GPL-3\.0-or-later.*SHA-256.*不上传媒体或登录信息.*不自动开始去重/);
  await page.locator("#confirm-cancel").click();
  await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-busy") === "false", "offer released after refusal");
  await offer(page);
  await page.keyboard.press("Escape");
  assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
  assert.equal(count(calls, "/api/dedup-all"), 0);
});

test("Yes submits only one confirmed installation, even repeated clicks; completion enables without auto dedup", async (t) => {
  const { page, calls, feature, tools } = await fixture(t);
  await offer(page);
  await page.locator("#confirm-button").evaluate((button) => { button.click(); button.click(); });
  await until(() => count(calls, "/api/features/dedup/install") === 1, "one install");
  await page.locator("#dedup-all-button").evaluate((button) => { button.click(); button.click(); });
  await page.locator("#dedup-tools-install").evaluate((button) => { button.click(); button.click(); });
  assert.equal(count(calls, "/api/features/dedup/install"), 1);
  Object.assign(feature, { available: true, installed: true, installing: false, progress: { status: "completed" } });
  Object.assign(tools, { ready: true, directory: "D:\\Fixture\\tools\\ffmpeg\\bin" });
  await page.clock.runFor(1100);
  await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-disabled") === "false", "feature enabled");
  assert.equal(count(calls, "/api/dedup-all"), 0);
  assert.equal(count(calls, "/api/dedup-person"), 0);
  assert.match(await page.locator("#dedup-tools-status").textContent(), /本次没有自动运行去重/);
  await page.locator("#dedup-tools-cancel").click();
  await page.locator("#dedup-all-button").click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "separate actual dedup confirmation");
  assert.match(await page.locator("#confirm-title").textContent(), /全部人物进行本地去重/);
  await page.locator("#confirm-cancel").click();
});

test("installation cancellation remains available, retains collection actions and never starts dedup", async (t) => {
  const { page, calls, feature } = await fixture(t);
  await acceptInstall(page);
  assert.equal(await page.locator("#dedup-tools-cancel").isDisabled(), false);
  assert.equal(await page.locator("#dedup-tools-progress").isVisible(), true);
  assert.equal(await page.locator("#dedup-tools-progress").evaluate((node) => node.value), 50);
  await page.locator("#dedup-tools-cancel").click();
  await until(() => count(calls, "/api/features/dedup/cancel") === 1, "explicit cancel");
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("下载已取消"), "cancel receipt");
  assert.equal(feature.available, false);
  await page.locator("#dedup-tools-cancel").click();
  assert.equal(await page.locator("#sync-all-button").isDisabled(), false);
  assert.equal(await page.locator("#create-person-button").isDisabled(), false);
  assert.equal(count(calls, "/api/dedup-all"), 0);
});

test("async failure leaves grey feature and visible cause while sync and person creation still work", async (t) => {
  const { page, calls, feature } = await fixture(t);
  await acceptInstall(page);
  Object.assign(feature, { installing: false, progress: { status: "failed", message: "固定工具包 SHA-256 校验失败；原文件未修改。" } });
  await page.clock.runFor(1100);
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("校验失败"), "failure cause");
  assert.equal(await page.locator("#dedup-all-button").getAttribute("aria-disabled"), "true");
  await page.locator("#dedup-tools-cancel").click();
  assert.equal(await page.locator("#sync-all-button").isDisabled(), false);
  await page.locator("#create-person-button").click();
  assert.equal(await page.locator("#person-dialog").evaluate((node) => node.open), true);
  assert.equal(count(calls, "/api/dedup-all"), 0);
});

test("single-person entry uses the same consent; explicit trusted existing path enables without starting work", async (t) => {
  const { page, calls, handlers, feature, tools } = await fixture(t);
  await offer(page, '.dedup-person[data-person-id="a"]');
  await page.locator("#confirm-cancel").click();
  assert.equal(count(calls, "/api/features/dedup/install"), 0);
  await page.locator('[data-view="settings"]').click();
  await page.locator("#dedup-tools-settings").click();
  handlers.set("PUT /api/tools/dedup", (request) => {
    assert.deepEqual(request.postDataJSON(), { directory: "D:\\Trusted\\bin" });
    Object.assign(feature, { available: true, installed: true });
    Object.assign(tools, { ready: true, directory: "D:\\Trusted\\bin" });
    return structuredClone(tools);
  });
  await page.locator("#dedup-tools-existing-path").fill("D:\\Trusted\\bin");
  await page.locator("#dedup-tools-use-existing").click();
  await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-disabled") === "false", "trusted path capability enabled");
  assert.equal(count(calls, "/api/dedup-person"), 0);
  assert.equal(count(calls, "/api/features/dedup/install"), 0);
});

for (const theme of ["light", "dark", "system"]) {
  test(`minimal consent and install progress retain ${theme} theme and stable nodes during sync polling`, async (t) => {
    const { page, calls, model } = await fixture(t, { theme, syncing: true });
    await offer(page);
    const screenshots = path.resolve("packaging/verification"); await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `minimal-dedup-consent-${theme}.png`) });
    await page.locator("#confirm-button").click();
    await until(() => count(calls, "/api/features/dedup/install") === 1, "install began");
    await page.evaluate(() => { window.originalFeatureModal = document.querySelector("#dedup-tools-dialog"); window.originalFeatureInput = document.querySelector("#dedup-tools-install-path"); });
    const input = await page.locator("#dedup-tools-install-path").inputValue();
    model.syncSummaries.a.message = "Updated offline incremental sync";
    await page.clock.runFor(1100);
    await until(() => count(calls, "/api/sync-jobs/sync-a", "GET") > 0, "background sync tick");
    assert.equal(await page.evaluate(() => window.originalFeatureModal === document.querySelector("#dedup-tools-dialog") && window.originalFeatureInput === document.querySelector("#dedup-tools-install-path")), true);
    assert.equal(await page.locator("#dedup-tools-install-path").inputValue(), input);
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "light" : "dark");
    await page.screenshot({ path: path.join(screenshots, `minimal-dedup-progress-${theme}.png`) });
    if (theme === "system") {
      await page.emulateMedia({ colorScheme: "light" });
      await until(async () => await page.locator("html").getAttribute("data-theme") === "light", "live system appearance");
    }
    await page.locator("#dedup-tools-cancel").click();
    assert.equal(count(calls, "/api/dedup-all"), 0);
  });
}

test("minimal consent translates to English without translating the trusted path", async (t) => {
  const { page } = await fixture(t, { language: "en" });
  await offer(page);
  assert.match(await page.locator("#confirm-title").textContent(), /One-click deduplication is not available/);
  assert.equal(await page.locator("#confirm-cancel").textContent(), "No, not now");
  await page.keyboard.press("Escape");
});

test("empty first-run minimal app still offers optional tools with a reachable grey button", async (t) => {
  const { page, calls } = await fixture(t, { persons: false });
  assert.equal(await page.locator("#dedup-all-button").evaluate((button) => button.disabled), false);
  await offer(page);
  await page.locator("#confirm-cancel").click();
  assert.equal(count(calls, "/api/features/dedup/install"), 0);
  assert.equal(count(calls, "/api/dedup-all"), 0);
});

test("immediate installer failure and manual validation failure stay visible without claiming enabled", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  handlers.set("POST /api/features/dedup/install", () => ({ _status: 503, error: "网络连接失败，未修改任何采集内容。" }));
  await offer(page); await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("网络连接失败"), "immediate error");
  handlers.set("PUT /api/tools/dedup", () => ({ _status: 400, error: "所选目录没有可信的 ffprobe.exe。" }));
  await page.locator("#dedup-tools-existing-path").fill("D:\\Unready\\bin");
  await page.locator("#dedup-tools-use-existing").click();
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("没有可信"), "manual error retained");
  assert.equal(await page.locator("#dedup-tools-existing-path").inputValue(), "D:\\Unready\\bin");
  assert.equal(await page.locator("#dedup-all-button").getAttribute("aria-disabled"), "true");
  assert.equal(count(calls, "/api/dedup-all"), 0);
});

test("hot language change preserves optional install dialog and translates live controls", async (t) => {
  const { page, handlers } = await fixture(t);
  await offer(page);
  await page.evaluate(() => window.MediaTrackerI18n.setPreference("en"));
  assert.equal(await page.locator("#confirm-cancel").textContent(), "No, not now");
  assert.match(await page.locator("#confirm-title").textContent(), /One-click deduplication is not available/);
  await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#dedup-tools-cancel").textContent()).includes("Cancel download"), "translated installation controls");
  const original = await page.locator("#dedup-tools-install-path").inputValue();
  await page.evaluate(() => { window.originalFeatureDialog = document.querySelector("#dedup-tools-dialog"); window.MediaTrackerI18n.setPreference("zh"); });
  assert.equal(await page.evaluate(() => window.originalFeatureDialog === document.querySelector("#dedup-tools-dialog")), true);
  assert.equal(await page.locator("#dedup-tools-install-path").inputValue(), original);
  assert.equal(await page.locator("#dedup-tools-cancel").textContent(), "取消下载");
  assert.match(await page.locator("#dedup-tools-install-hint").textContent(), /最小版/);
  await page.locator("#dedup-tools-cancel").click();
});

test("unchanged optional-feature polling leaves completed-card and toolbar button attributes untouched", async (t) => {
  const { page, calls } = await fixture(t);
  await acceptInstall(page);
  await page.evaluate(() => {
    window.optionalButtonMutations = 0;
    for (const button of [document.querySelector("#dedup-all-button"), document.querySelector(".dedup-person")]) {
      new MutationObserver((changes) => { window.optionalButtonMutations += changes.length; })
        .observe(button, { attributes: true, childList: true, subtree: true, characterData: true });
    }
  });
  const initial = count(calls, "/api/features/dedup", "GET");
  await page.clock.runFor(1100);
  await until(() => count(calls, "/api/features/dedup", "GET") > initial, "unchanged optional feature poll");
  assert.equal(await page.evaluate(() => window.optionalButtonMutations), 0);
  await page.locator("#dedup-tools-cancel").click();
});

test("fixed feature preparation and cancellation service receipts translate to English", async (t) => {
  const { page, feature, handlers } = await fixture(t, { language: "en" });
  handlers.set("POST /api/features/dedup/install", () => {
    Object.assign(feature, { installing: true, progress: { status: "running", phase: "verifying",
      message: "正在验证去重工具完整性与运行能力。" } });
    return { ...structuredClone(feature), _status: 202 };
  });
  await offer(page); await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("Verifying the integrity and usability"), "English service progress");
  Object.assign(feature, { installing: false, progress: { status: "cancelled", phase: "cancelled",
    message: "去重工具下载已取消；已完整提交的工具保留，媒体和账号资料未修改。" } });
  await page.clock.runFor(1100);
  await until(async () => (await page.locator("#dedup-tools-status").textContent()).includes("The tool download was cancelled"), "English cancellation receipt");
  assert.match(await page.locator("#dedup-tools-status").textContent(), /media and account data were not changed/);
});
