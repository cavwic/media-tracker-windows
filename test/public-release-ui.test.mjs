import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Offline UI acceptance only. All responses are mocked; no real service,
// account profile, media, installer, or external website is accessed.
const origin = "http://127.0.0.1:54391";
const token = "b".repeat(64);
const idle = { status: "idle", scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], results: [] };
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out: " + label);
}
const count = (calls, pathname, method = "POST") => calls.filter((call) => call.path === pathname && call.method === method).length;
async function fixture(t, { theme = "dark", applicationId = "media-tracker-public", sessionToken = token,
  sessionStatus = 200, syncing = false, includedTools = false } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", colorScheme: "dark", reducedMotion: "reduce",
    viewport: { width: 1440, height: 1100 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install();
  const feature = { id: "similarity-dedup", available: includedTools, installed: false, included: includedTools,
    installing: false, installAvailable: true, importAvailable: false, packageAvailable: true, progress: null };
  const tools = { ready: false, installAvailable: true, defaultInstallDirectory: "D:\\Fixture\\Public\\tools", directory: "",
    message: "相似去重组件尚未准备；精确去重保留。" };
  const model = { linkedAccounts: [], persons: [{ id: "a", name: "离线示例", folderPath: "D:\\Fixture\\Public\\A", platforms: [] }],
    platforms: { x: { label: "X" } }, settings: { theme, language: "zh" }, runtime: { systemLanguage: "zh" },
    features: { dedup: feature }, dedupStatus: idle,
    syncSummaries: syncing ? { a: { id: "sync-a", personId: "a", status: "running", newFileCount: 0,
      message: "Offline incremental fixture", errors: [], warnings: [], counters: { accounts: 1, accountsFinished: 0 } } } : {} };
  const assets = new Map(await Promise.all(["index.html", "app.js", "styles.css", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [], external = [], errors = [], handlers = new Map();
  let acknowledged = false;
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const call of calls.filter((call) => call.path !== "/api/session")) {
      assert.equal(call.headers["x-media-tracker-token"], token, `private API token: ${call.method} ${call.path}`);
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (!endpoint.startsWith("/api/")) {
      const name = endpoint === "/" ? "index.html" : endpoint.slice(1);
      return route.fulfill({ status: assets.has(name) ? 200 : 404, body: assets.get(name) || "Not found",
        contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" });
    }
    const call = { path: endpoint, method: request.method(), body: request.postDataJSON(), headers: await request.allHeaders() };
    calls.push(call);
    let payload;
    if (endpoint === "/api/session") payload = { _status: sessionStatus, token: sessionToken, header: "X-Media-Tracker-Token", applicationId };
    else if (handlers.has(`${call.method} ${endpoint}`)) payload = await handlers.get(`${call.method} ${endpoint}`)(call);
    else if (endpoint === "/api/state") payload = structuredClone(model);
    else if (endpoint === "/api/features/dedup") payload = structuredClone(feature);
    else if (endpoint === "/api/tools/dedup") payload = structuredClone(tools);
    else if (endpoint === "/api/dedup-status") payload = idle;
    else if (endpoint === "/api/release-policy" && call.method === "POST") {
      assert.deepEqual(call.body, { acknowledged: true, version: 1 });
      acknowledged = true;
      payload = { acknowledged: true, version: 1 };
    } else if (["/api/sync-all", "/api/persons/a/sync", "/api/homepages/analyze"].includes(endpoint) && !acknowledged) {
      payload = { _status: 428, code: "PUBLIC_USE_ACK_REQUIRED", error: "请先阅读公开版使用须知。" };
    } else if (endpoint === "/api/sync-all") {
      const job = { id: "sync-a", personId: "a", status: "completed", newFileCount: 0, errors: [], warnings: [],
        counters: { accounts: 0, accountsFinished: 0 }, message: "Offline complete" };
      model.syncSummaries.a = job;
      payload = { jobs: [job], startedCount: 1, existingCount: 0 };
    } else if (endpoint === "/api/persons/a/sync") {
      payload = { id: "sync-a", personId: "a", status: "completed", newFileCount: 0, errors: [], warnings: [],
        counters: { accounts: 0, accountsFinished: 0 }, message: "Offline complete" };
      model.syncSummaries.a = payload;
    } else if (endpoint === "/api/sync-jobs/sync-a") payload = structuredClone(model.syncSummaries.a);
    else if (endpoint === "/api/homepages/analyze") payload = { sourceUrl: call.body.url, finalUrl: call.body.url,
      title: "Offline authorized links", candidates: [], scannedAt: "2026-01-02T00:00:00Z" };
    else if (endpoint === "/api/features/dedup/install") {
      assert.deepEqual(call.body, { confirmed: true });
      Object.assign(feature, { installing: true, progress: { status: "running", phase: "download", message: "Offline tool preparation" } });
      payload = { ...structuredClone(feature), _status: 202 };
    } else if (endpoint === "/api/features/dedup/cancel") {
      Object.assign(feature, { installing: false, progress: { status: "cancelled", phase: "cancelled", message: "Offline cancelled" } });
      payload = structuredClone(feature);
    } else if (endpoint === "/api/settings") {
      Object.assign(model.settings, call.body);
      payload = { settings: structuredClone(model.settings) };
    } else payload = { _status: 404, error: "Unexpected offline API: " + endpoint };
    await route.fulfill({ status: payload._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  if (applicationId === "media-tracker-public" && sessionToken === token && sessionStatus === 200) {
    await until(async () => await page.locator(".person-card").count() === 1, "authenticated public fixture loaded");
    await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-disabled") === String(!includedTools), "public feature capability rendered");
  } else await until(async () => (await page.locator("#toast").textContent()).includes("无法验证公开版本地服务"), "rejected session bootstrap");
  return { page, calls, model, feature, tools, handlers };
}

async function usageNotice(page, selector = "#sync-all-button") {
  await page.locator(selector).click();
  await until(async () => (await page.locator("#confirm-title").textContent()) === "公开版使用须知", "risk notice after 428");
  assert.equal(await page.locator("#confirm-dialog").evaluate((node) => node.open), true);
}

test("authenticated startup and explicit acknowledgement carry the local API token before retrying sync", async (t) => {
  const { page, calls } = await fixture(t);
  assert.equal(count(calls, "/api/session", "GET"), 1);
  await usageNotice(page);
  assert.equal(count(calls, "/api/sync-all"), 1);
  assert.equal(count(calls, "/api/release-policy"), 0);
  assert.match(await page.locator("#confirm-message").textContent(), /尚未取得平台自动采集许可.*不代表获准自动采集.*不授予许可或免除责任/);
  await page.locator("#confirm-button").click();
  await until(() => count(calls, "/api/sync-all") === 2, "one sync retry after acknowledgement");
  assert.equal(count(calls, "/api/release-policy"), 1);
  assert.equal(count(calls, "/api/session", "GET"), 1, "bootstrap session is reused");
  const actions = calls.filter((call) => call.method === "POST");
  assert.deepEqual(actions.map((call) => call.path), ["/api/sync-all", "/api/release-policy", "/api/sync-all"]);
  assert.deepEqual(actions[1].body, { acknowledged: true, version: 1 });
});

for (const decline of ["cancel", "escape"]) {
  test(`declining usage notice by ${decline} sends no acknowledgement and never retries the gated sync`, async (t) => {
    const { page, calls } = await fixture(t);
    await usageNotice(page, ".sync-person");
    if (decline === "cancel") await page.locator("#confirm-cancel").click();
    else await page.keyboard.press("Escape");
    await until(async () => (await page.locator("#toast").textContent()).includes("尚未确认使用须知"), "cancelled operation receipt");
    assert.equal(count(calls, "/api/release-policy"), 0);
    assert.equal(count(calls, "/api/persons/a/sync"), 1);
    assert.equal(await page.locator(".sync-person").isDisabled(), false);
    assert.equal(await page.locator("#confirm-dialog").evaluate((node) => node.open), false);
  });
}

for (const theme of ["light", "dark", "system"]) {
  test(`${theme} nested usage notice and background polling preserve the unsaved person draft`, async (t) => {
    const { page, calls, model } = await fixture(t, { theme, syncing: true });
    await page.locator("#create-person-button").click();
    await page.locator("#person-name").fill("未保存的采集账号草稿");
    await page.locator("#person-note").fill("保留备注和目录");
    await page.locator("#selected-path").fill("D:\\Fixture\\KeepDraft");
    await page.locator("#homepage-url").fill("https://example.invalid/fixture");
    await page.evaluate(() => { window.retainedDraftDialog = document.querySelector("#person-dialog"); window.retainedDraftInput = document.querySelector("#person-name"); });
    await usageNotice(page, "#analyze-homepage-button");
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "light" : "dark");
    const surface = await page.locator("#confirm-dialog").evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.notEqual(surface, "rgba(0, 0, 0, 0)");
    model.syncSummaries.a.message = "Offline progress changed while reading notice";
    const polls = count(calls, "/api/sync-jobs/sync-a", "GET");
    await page.clock.runFor(1000);
    await until(() => count(calls, "/api/sync-jobs/sync-a", "GET") > polls, "background sync poll");
    assert.equal(await page.locator("#confirm-dialog").evaluate((node) => node.open), true);
    if (theme === "system") {
      await page.emulateMedia({ colorScheme: "light" });
      await until(async () => await page.locator("html").getAttribute("data-theme") === "light", "live system appearance");
    }
    await page.locator("#confirm-cancel").click();
    await until(async () => !(await page.locator("#analyze-homepage-button").isDisabled()), "draft action restored");
    assert.equal(await page.evaluate(() => window.retainedDraftDialog === document.querySelector("#person-dialog")
      && window.retainedDraftInput === document.querySelector("#person-name")), true);
    assert.equal(await page.locator("#person-dialog").evaluate((node) => node.open), true);
    assert.equal(await page.locator("#person-name").inputValue(), "未保存的采集账号草稿");
    assert.equal(await page.locator("#person-note").inputValue(), "保留备注和目录");
    assert.equal(await page.locator("#selected-path").inputValue(), "D:\\Fixture\\KeepDraft");
    assert.equal(count(calls, "/api/homepages/analyze"), 1);
    assert.equal(count(calls, "/api/release-policy"), 0);
  });
}

for (const invalid of [{ applicationId: "media-tracker-private" }, { sessionToken: "not-a-valid-token" }, { sessionStatus: 503 }]) {
  test(`invalid bootstrap ${Object.keys(invalid)[0]} blocks all private APIs`, async (t) => {
    const { page, calls } = await fixture(t, invalid);
    assert.equal(await page.locator(".person-card").count(), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/api/session");
  });
}

test("missing optional tools have a normal cursor; Gyan GPL notice is explicit and refusal never downloads", async (t) => {
  const { page, calls } = await fixture(t);
  for (const selector of ["#dedup-all-button", ".dedup-person"]) {
    assert.equal(await page.locator(selector).evaluate((node) => getComputedStyle(node).cursor), "default");
    assert.equal(await page.locator(selector).evaluate((node) => node.disabled), false, `${selector} keeps preparation reachable despite aria-disabled`);
  }
  await page.locator("#dedup-all-button").focus();
  await page.keyboard.press("Enter");
  await until(async () => await page.locator("#confirm-dialog").evaluate((node) => node.open), "optional tool consent");
  assert.match(await page.locator("#confirm-message").textContent(), /Gyan.*GPL-3\.0-or-later.*不是 MIT.*对应源码义务/);
  await page.locator("#confirm-cancel").click();
  await until(async () => await page.locator("#dedup-all-button").getAttribute("aria-busy") === "false", "idle missing-tool entry restored");
  assert.equal(count(calls, "/api/features/dedup/install"), 0);
  assert.equal(count(calls, "/api/tools/dedup/install"), 0);
  assert.equal(count(calls, "/api/dedup-all"), 0);
  assert.equal(count(calls, "/api/release-policy"), 0);
  assert.equal(await page.locator("#dedup-all-button").evaluate((node) => getComputedStyle(node).cursor), "default");
});

test("manual environment preparation includes GPL notice and cancellation leaves the preparation dialog idle", async (t) => {
  const { page, calls } = await fixture(t, { includedTools: true });
  await page.locator('[data-view="settings"]').click();
  await page.locator("#dedup-tools-settings").click();
  await until(async () => await page.locator("#dedup-tools-dialog").evaluate((node) => node.open), "component settings");
  await page.locator("#dedup-tools-install").click();
  await until(async () => await page.locator("#confirm-dialog").evaluate((node) => node.open), "installation consent");
  assert.match(await page.locator("#confirm-message").textContent(), /Gyan.*GPL-3\.0-or-later.*不是 MIT.*对应源码义务/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#dedup-tools-dialog").evaluate((node) => node.open), true);
  assert.equal(await page.locator("#dedup-tools-dialog").getAttribute("aria-busy"), null);
  assert.equal(await page.locator("#dedup-tools-install").evaluate((node) => getComputedStyle(node).cursor), "pointer");
  assert.equal(count(calls, "/api/tools/dedup/install"), 0);
  assert.equal(count(calls, "/api/dedup-all"), 0);
  await page.locator("#dedup-tools-cancel").click();
});
