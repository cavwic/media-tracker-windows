import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chooseAppearance } from "./fixtures/appearance-controls.mjs";

// A local route fixture: never open production profiles, clean real caches or
// contact a platform while exercising the maintenance controls and layout.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54326";
const preview = () => ({
  scannedAt: "2026-10-05T03:00:00Z", status: "ready", totalBytes: 3_145_728,
  totalFiles: 12, skippedProfiles: 1, errors: [], profiles: [
    { platformId: "x", profileId: "linked-a", platformLabel: "X", accountLabel: "我的 X 账号", linked: true, bytes: 2_097_152, files: 7, status: "ready", errors: [] },
    { platformId: "instagram", profileId: "linked-b", platformLabel: "Instagram", accountLabel: "我的 Instagram 账号", linked: true, bytes: 1_048_576, files: 5, status: "ready", errors: [] },
    { platformId: "tiktok", profileId: "linked-c", platformLabel: "TikTok", accountLabel: "正在登录的账号", linked: true, bytes: 0, files: 0, status: "skipped", reason: "profile-in-use", message: "账号窗口正在使用，已跳过。", errors: [] },
  ],
});
const cleaned = () => ({
  completedAt: "2026-10-05T03:01:00Z", status: "cleaned", removedBytes: 3_145_728,
  removedFiles: 12, cleanedProfiles: 2, skippedProfiles: 1, errors: [], profiles: [
    { ...preview().profiles[0], status: "cleaned", removedBytes: 2_097_152, removedFiles: 7 },
    { ...preview().profiles[1], status: "cleaned", removedBytes: 1_048_576, removedFiles: 5 },
    preview().profiles[2],
  ],
});
const historyId = "cb30c02d-981e-4aad-9602-d7d96b1cb3a1";
const historyPreview = () => ({ ...preview(), profiles: [...preview().profiles,
  { platformId: "instagram", platformLabel: "Instagram", profileId: "old-attempt", accountLabel: "历史浏览器资料（当前未绑定）",
    linked: false, removalId: historyId, removable: true, profileBytes: 20_971_520, profileFiles: 50, bytes: 0, files: 0, status: "empty", errors: [] },
  { platformId: "x", platformLabel: "X", profileId: "busy-attempt", accountLabel: "历史浏览器资料（当前未绑定）",
    linked: false, removalId: "81f823f6-2010-42de-a950-58f18d288716", removable: false, bytes: 0, files: 0,
    status: "skipped", message: "历史资料的浏览器正在使用，请关闭后重新扫描。", errors: [] },
] });
const removedHistory = () => ({ status: "removed", removedProfiles: 1, skippedProfiles: 0, removedBytes: 20_971_520,
  removedFiles: 50, profiles: [{ ...historyPreview().profiles[3], status: "removed" }], errors: [] });

async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { theme = "dark", colorScheme = "dark", width = 1600, running = false } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 1000 }, colorScheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  t.after(() => context.close());
  const model = {
    persons: Array.from({ length: 10 }, (_, index) => ({
      id: `person-${index}`, name: index === 0 ? `很长的采集账号名称_${"LongAccountName".repeat(15)}` : `采集账号 ${index}`,
      note: index === 0 ? "没有空格的长备注".repeat(18) : "本地测试资料",
      folderPath: `\\\\EXAMPLE-NAS\\FileShare\\People\\${"非常长的路径段".repeat(14)}\\person-${index}`,
      platforms: [{ id: "x", label: "X", accounts: [{ id: `a-${index}`, label: `target_${"account".repeat(10)}` }] }],
    })),
    linkedAccounts: [], platforms: { x: { label: "X" }, instagram: { label: "Instagram" }, tiktok: { label: "TikTok" } },
    settings: { theme }, syncSummaries: {},
  };
  if (running) model.syncSummaries["person-1"] = {
    id: "job-live", personId: "person-1", status: "running", message: "正在同步本地测试",
    newFileCount: 0, counters: { accounts: 1, accountsFinished: 0, downloaded: 0 },
  };
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [], handlers = new Map(), errors = [], unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) calls.push({ pathname, method: request.method(), body: request.postDataJSON() });
    let payload;
    if (handlers.has(pathname)) payload = await handlers.get(pathname)(request);
    else if (pathname === "/api/state") payload = structuredClone(model);
    else if (pathname === "/api/cache/preview") payload = preview();
    else if (pathname === "/api/cache/clean") payload = cleaned();
    else if (pathname === "/api/settings") {
      model.settings = { ...model.settings, ...request.postDataJSON() };
      payload = { settings: structuredClone(model.settings) };
    } else if (pathname === "/api/sync-jobs/job-live") payload = structuredClone(model.syncSummaries["person-1"]);
    else {
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ status: 200, contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets.get(name) });
    }
    await route.fulfill({ status: payload?._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator(".person-card").count() === 10, "initial local cards");
  return { page, context, model, calls, handlers };
}

async function enterCache(page) {
  await page.locator("#cache-nav-button").click();
  await until(async () => await page.locator("#cache-view").isVisible()
    && !(await page.locator("#cache-preview-button").isDisabled()), "cache preview settled");
}
const callsTo = (calls, pathname) => calls.filter((call) => call.pathname === pathname);
async function noOverflow(page, selector = "body") {
  assert.equal(await page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true,
    `${selector} should not overflow horizontally`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    `the document should fit the viewport: ${JSON.stringify(await page.evaluate(() => ({ width: innerWidth,
      document: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll("body *")]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8).map((node) => ({ tag: node.tagName, id: node.id, class: node.className, right: node.getBoundingClientRect().right })) })))}`);
}

test("cache maintenance is anchored at the sidebar bottom and preview is read-only and explicit", async (t) => {
  const { page, calls } = await fixture(t);
  assert.equal(await page.locator(".sidebar-bottom #cache-nav-button[data-view='cache']").count(), 1);
  const nav = await page.locator("#cache-nav-button").boundingBox();
  const lastPrimary = await page.locator(".primary-nav .nav-item").last().boundingBox();
  assert.ok(nav.y > 700 && nav.y > lastPrimary.y + lastPrimary.height, "desktop cleanup navigation is at the sidebar bottom");
  assert.equal(callsTo(calls, "/api/cache/preview").length, 0);
  await enterCache(page);
  assert.equal(callsTo(calls, "/api/cache/preview").length, 1);
  assert.equal(callsTo(calls, "/api/cache/preview")[0].method, "GET");
  assert.match(await page.locator("#cache-summary").textContent(), /3(?:\.0)?\s*(?:MB|MiB)/i);
  assert.match(await page.locator("#cache-files-value").textContent(), /12/);
  const rows = await page.locator("#cache-profile-list").textContent();
  assert.match(rows, /我的 X 账号|我的 Instagram 账号/);
  assert.match(rows, /正在登录的账号/);
  assert.match(rows, /跳过|使用/);
  assert.match(await page.locator("#cache-view").textContent(), /登录|账号/);
  assert.match(await page.locator("#cache-view").textContent(), /媒体|图片|视频/);
  await page.locator('[data-view="people"]').click();
  await enterCache(page);
  assert.equal(callsTo(calls, "/api/cache/preview").length, 1, "cached report survives navigation");
  await page.locator("#cache-preview-button").click();
  await until(() => callsTo(calls, "/api/cache/preview").length === 2, "explicit rescan");
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0, "reading the report cannot clean anything");
});

test("cache cleanup requires confirmation, cancels safely and allows only one pending POST", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  await enterCache(page);
  await page.locator("#cache-clean-button").click();
  assert.equal(await page.locator("#confirm-dialog").isVisible(), true);
  assert.equal(await page.locator("#confirm-button").textContent(), "清理缓存");
  assert.equal(await page.locator("#cache-clean-button").isDisabled(), true);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0);
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator("#cache-clean-button").isDisabled()), "cancel restores controls");
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0);
  const pending = deferred();
  handlers.set("/api/cache/clean", () => pending.promise);
  await page.locator("#cache-clean-button").click();
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/cache/clean").length === 1, "confirmed cleanup request");
  assert.deepEqual(callsTo(calls, "/api/cache/clean")[0], { pathname: "/api/cache/clean", method: "POST", body: { confirm: true } });
  assert.equal(await page.locator("#cache-clean-button").isDisabled(), true);
  assert.equal(await page.locator("#cache-preview-button").isDisabled(), true);
  await page.locator("#cache-clean-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/cache/clean").length, 1);
  pending.resolve(cleaned());
  await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "cleanup completed");
  assert.match(await page.locator("#cache-status").textContent(), /清理|释放/);
  assert.match(await page.locator("#cache-summary").textContent(), /3(?:\.0)?\s*(?:MB|MiB)/i);
  assert.equal(callsTo(calls, "/api/cache/preview").length, 1, "keep the cleanup receipt rather than replace it automatically");
  await page.locator("#cache-preview-button").click();
  await until(() => callsTo(calls, "/api/cache/preview").length === 2, "fresh preview on demand");
});

test("a pending scan cannot duplicate requests and a failed rescan preserves the last report", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  const pending = deferred();
  handlers.set("/api/cache/preview", () => pending.promise);
  await page.locator("#cache-nav-button").click();
  await until(() => callsTo(calls, "/api/cache/preview").length === 1, "initial scan pending");
  assert.equal(await page.locator("#cache-preview-button").isDisabled(), true);
  assert.equal(await page.locator("#cache-clean-button").isDisabled(), true);
  await page.locator('[data-view="people"]').click();
  await page.locator("#cache-nav-button").click();
  await page.locator("#cache-preview-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/cache/preview").length, 1);
  pending.resolve(preview());
  await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "pending scan settled");
  await page.evaluate(() => { window.retainedCacheRow = document.querySelector(".cache-profile-row"); });
  handlers.set("/api/cache/preview", () => ({ _status: 500, error: "测试缓存目录暂时不可读取" }));
  await page.locator("#cache-preview-button").click();
  await until(async () => (await page.locator("#cache-status").textContent()).includes("测试缓存目录暂时不可读取"), "scan error shown");
  assert.equal(await page.locator("#cache-status").evaluate((node) => node.classList.contains("is-error")), true);
  assert.equal(await page.evaluate(() => window.retainedCacheRow === document.querySelector(".cache-profile-row")), true);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0);
  handlers.set("/api/cache/preview", () => ({ _status: 404, error: "接口不存在" }));
  await page.locator("#cache-preview-button").click();
  await until(async () => (await page.locator("#cache-status").textContent()).includes("后台服务还是旧版本"), "old running service is explained");
  assert.match(await page.locator("#cache-status").textContent(), /仅关闭主窗口再打开不会更新后台/);
  assert.equal(await page.evaluate(() => window.retainedCacheRow === document.querySelector(".cache-profile-row")), true);
});

test("cache account labels, IDs and diagnostic text are escaped and fit narrow screens", async (t) => {
  const { page, handlers } = await fixture(t, { width: 320 });
  const label = '<img src=x onerror="window.injected=1">' + "LongAccountName".repeat(15);
  const message = '<script>window.injected=2</script>' + "非常长的目录说明".repeat(20);
  handlers.set("/api/cache/preview", () => ({ ...preview(), profiles: [{ ...preview().profiles[0],
    accountLabel: label, platformLabel: "自定义平台", profileId: "id_" + "a".repeat(160), linked: false,
    status: "skipped", message, bytes: 0, files: 0,
  }] }));
  await enterCache(page);
  assert.equal(await page.locator(".cache-profile-heading h3").textContent(), label);
  assert.equal(await page.locator(".cache-profile-message").textContent(), message);
  assert.match(await page.locator(".cache-profile-id").textContent(), /当前未绑定/);
  assert.equal(await page.locator("#cache-profile-list img, #cache-profile-list script").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await noOverflow(page);
  await noOverflow(page, "#cache-profile-list");
});

test("empty, skipped, partial and failed cleanup reports stay actionable without unsafe retries", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  handlers.set("/api/cache/preview", () => ({ scannedAt: "2026-10-05T03:00:00Z", status: "empty", totalBytes: 0, totalFiles: 0, profiles: [], skippedProfiles: 0, errors: [] }));
  await enterCache(page);
  assert.match(await page.locator("#cache-space-value").textContent(), /^0/);
  assert.equal(await page.locator("#cache-clean-button").isDisabled(), true);
  assert.match(await page.locator("#cache-status").textContent(), /没有|无需|空/);
  handlers.set("/api/cache/preview", () => ({ ...preview(), status: "partial", errors: [{ message: "测试缓存文件暂时无法读取" }] }));
  await page.locator("#cache-preview-button").click();
  await until(async () => !(await page.locator("#cache-clean-button").isDisabled()), "partial report still usable");
  assert.match(await page.locator("#cache-view").textContent(), /测试缓存文件暂时无法读取/);
  handlers.set("/api/cache/clean", () => ({ _status: 409, error: "正在同步，稍后再清理缓存。" }));
  await page.locator("#cache-clean-button").click();
  await page.locator("#confirm-button").click();
  await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "failure restores controls");
  assert.match(await page.locator("#cache-status").textContent(), /正在同步，稍后再清理缓存/);
  assert.match(await page.locator("#cache-profile-list").textContent(), /我的 X 账号/);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 1);
  handlers.set("/api/cache/clean", () => ({ ...cleaned(), status: "partial", removedBytes: 2_097_152, removedFiles: 7, errors: [{ message: "测试缓存文件被占用，已保留" }], profiles: [cleaned().profiles[0], { ...cleaned().profiles[1], status: "partial", removedBytes: 0, removedFiles: 0, errors: [{ message: "测试缓存文件被占用，已保留" }] }] }));
  await page.locator("#cache-clean-button").click();
  await page.locator("#confirm-button").click();
  await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "partial result finished");
  assert.match(await page.locator("#cache-view").textContent(), /测试缓存文件被占用，已保留/);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 2);
});

test("sync polling retains cache report nodes and the pending confirmation dialog", async (t) => {
  const { page, calls, model } = await fixture(t, { running: true });
  await page.clock.install();
  await enterCache(page);
  await page.evaluate(() => { window.savedCacheList = document.querySelector("#cache-profile-list"); window.savedCacheContents = window.savedCacheList.firstElementChild; });
  await page.locator("#cache-clean-button").click();
  await page.evaluate(() => { window.savedConfirmation = document.querySelector("#confirm-dialog"); });
  model.syncSummaries["person-1"].message = "后台同步进度已更新";
  await page.clock.runFor(1_300);
  await until(() => calls.some((call) => call.pathname === "/api/sync-jobs/job-live"), "background sync poll");
  assert.deepEqual(await page.evaluate(() => ({
    list: window.savedCacheList === document.querySelector("#cache-profile-list"),
    row: window.savedCacheContents === document.querySelector("#cache-profile-list").firstElementChild,
    dialog: window.savedConfirmation === document.querySelector("#confirm-dialog"),
    open: document.querySelector("#confirm-dialog").open,
    focused: document.activeElement === document.querySelector("#confirm-cancel"),
  })), { list: true, row: true, dialog: true, open: true, focused: true });
  assert.equal(callsTo(calls, "/api/cache/preview").length, 1);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0);
  await page.locator("#confirm-cancel").click();
});

test("wide screens use five columns, narrower screens wrap safely and long account content never overflows", async (t) => {
  const { page } = await fixture(t);
  for (const width of [2560, 1920, 1600, 1366, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.locator("#people-list").evaluate((node) => {
      const cards = [...node.querySelectorAll(".person-card")];
      const firstY = cards[0].getBoundingClientRect().y;
      return { columns: cards.filter((card) => Math.abs(card.getBoundingClientRect().y - firstY) < 2).length,
        width: node.getBoundingClientRect().width, fit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1) };
    });
    if (width >= 1600) assert.equal(layout.columns, 5, `${width}px should fit five cards`);
    else if (width > 700) assert.ok(layout.columns >= 2 && layout.columns < 5, `${width}px should adapt to fewer columns`);
    else assert.equal(layout.columns, 1, `${width}px mobile should have one readable card`);
    assert.equal(layout.fit, true, `${width}px cards contain their long names and paths`);
    await noOverflow(page);
    if (width === 2560) assert.ok(layout.width > 1700, "the old 1240px content cap is removed");
    if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS && [1920, 1600, 390].includes(width)) {
      await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `people-grid-${width}-dark.png`), fullPage: false });
    }
  }
});

test("cache reports and confirmations follow light, dark and system themes, including narrow screens", async (t) => {
  for (const theme of ["light", "dark", "system"]) {
    const { page } = await fixture(t, { theme, colorScheme: "light", width: 390 });
    await enterCache(page);
    const resolved = theme === "system" ? "light" : theme;
    assert.equal(await page.locator("html").getAttribute("data-theme"), resolved);
    await noOverflow(page);
    await noOverflow(page, "#cache-view");
    await page.locator("#cache-clean-button").click();
    assert.equal(await page.locator("#confirm-dialog").isVisible(), true);
    assert.equal(await page.locator("#confirm-dialog").evaluate((node) => getComputedStyle(node).colorScheme), resolved);
    assert.equal(await page.locator("#confirm-dialog").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    await page.locator("#confirm-cancel").click();
    if (theme === "system") {
      await page.emulateMedia({ colorScheme: "dark" });
      await until(async () => await page.locator("html").getAttribute("data-theme") === "dark", "system theme changes");
    }
    if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
      await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `cache-mobile-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `cache-desktop-${theme}.png`), fullPage: false });
    }
  }
});

test("the theme trigger is always visible and explicit choices override live system changes", async (t) => {
  const { page, calls } = await fixture(t, { theme: "system", colorScheme: "dark", width: 1920 });
  assert.equal(await page.locator("#theme-control").count(), 1);
  for (const view of ["people", "settings", "cache"]) {
    await page.locator(`[data-view="${view}"]`).click();
    assert.equal(await page.locator("#theme-menu-button").isVisible(), true);
    assert.equal(await page.locator("#theme-control").isVisible(), false);
  }
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  const pick = async (value) => {
    await chooseAppearance(page, "theme", value);
    await until(() => callsTo(calls, "/api/settings").at(-1)?.body?.theme === value, "theme setting saved");
    await until(() => page.locator(`#theme-control input[value="${value}"]`).isChecked(), "radio state applied");
  };
  await pick("light");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await pick("dark");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await pick("system");
  await until(async () => await page.locator("html").getAttribute("data-theme") === "light", "follow light system");
  await page.emulateMedia({ colorScheme: "dark" });
  await until(async () => await page.locator("html").getAttribute("data-theme") === "dark", "follow dark system");
  await page.setViewportSize({ width: 820, height: 1000 });
  await noOverflow(page);
  await page.setViewportSize({ width: 320, height: 1000 });
  await noOverflow(page);
});

test("only safe unbound history is selectable; both deletion confirmations can cancel without requests", async (t) => {
  const { page, calls, handlers } = await fixture(t, { width: 390 });
  handlers.set("/api/cache/preview", historyPreview);
  await enterCache(page);
  assert.equal(await page.locator("input[data-removal-id]").count(), 1);
  assert.equal(await page.locator(".cache-profile-protected").count(), 3);
  assert.equal(await page.locator("#cache-remove-profiles-button").isDisabled(), true);
  await page.locator("input[data-removal-id]").check();
  assert.match(await page.locator("#cache-selected-status").textContent(), /已选 1/);
  assert.match(await page.locator(".cache-profile-select").textContent(), /20(?:\.0)? MB/);
  await noOverflow(page);
  if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
    await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, "cache-history-selection-dark-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, "cache-history-selection-dark-desktop.png"), fullPage: false });
  }
  await page.locator("#cache-remove-profiles-button").click();
  assert.equal(await page.locator("#confirm-button").textContent(), "继续确认");
  assert.equal(await page.locator("#cache-preview-button").isDisabled(), true);
  assert.equal(await page.locator("input[data-removal-id]").isDisabled(), true);
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator("#cache-remove-profiles-button").isDisabled()), "first cancellation");
  await page.locator("#cache-remove-profiles-button").click();
  await page.locator("#confirm-button").click();
  await until(async () => await page.locator("#confirm-button").textContent() === "永久删除所选资料", "second confirmation");
  assert.match(await page.locator("#confirm-message").textContent(), /Cookie|网站存储/);
  assert.match(await page.locator("#confirm-message").textContent(), /不进回收站|不能撤销/);
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator("#cache-remove-profiles-button").isDisabled()), "second cancellation");
  assert.equal(callsTo(calls, "/api/cache/remove-unlinked-profiles").length, 0);
  assert.equal(callsTo(calls, "/api/cache/clean").length, 0);
});

test("history deletion retains selection during polling and submits only selected issued IDs once", async (t) => {
  const { page, calls, handlers, model } = await fixture(t, { running: true });
  const pending = deferred();
  handlers.set("/api/cache/preview", historyPreview);
  handlers.set("/api/cache/remove-unlinked-profiles", () => pending.promise);
  await page.clock.install();
  await enterCache(page);
  await page.locator("input[data-removal-id]").check();
  await page.evaluate(() => { window.savedHistoryCheckbox = document.querySelector("input[data-removal-id]"); });
  await page.locator("#cache-remove-profiles-button").click();
  model.syncSummaries["person-1"].message = "同步仍在后台运行";
  await page.clock.runFor(1_300);
  await until(() => callsTo(calls, "/api/sync-jobs/job-live").length > 0, "poll happens");
  assert.equal(await page.evaluate(() => window.savedHistoryCheckbox === document.querySelector("input[data-removal-id]")), true);
  assert.equal(await page.locator("input[data-removal-id]").isChecked(), true);
  await page.locator("#confirm-button").click();
  await until(async () => await page.locator("#confirm-button").textContent() === "永久删除所选资料", "second confirmation");
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/cache/remove-unlinked-profiles").length === 1, "deletion submitted");
  assert.deepEqual(callsTo(calls, "/api/cache/remove-unlinked-profiles")[0].body, { confirm: true, profileIds: [historyId] });
  await page.locator("#cache-remove-profiles-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/cache/remove-unlinked-profiles").length, 1);
  pending.resolve(removedHistory());
  await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "deletion finished");
  assert.equal(await page.locator("input[data-removal-id]").count(), 0);
  assert.equal(await page.locator(".cache-profile-protected").count(), 3);
  assert.match(await page.locator("#cache-removal-receipt").textContent(), /已删除 1/);
  assert.match(await page.locator("#cache-removal-receipt").textContent(), /登录信息.*保留/);
});

test("stale binding, partial deletion and legacy API failures preserve readable receipts without automatic retries", async (t) => {
  const { page, calls, handlers } = await fixture(t);
  handlers.set("/api/cache/preview", historyPreview);
  await enterCache(page);
  const submit = async () => {
    await page.locator("input[data-removal-id]").check();
    await page.locator("#cache-remove-profiles-button").click();
    await page.locator("#confirm-button").click();
    await until(async () => await page.locator("#confirm-button").textContent() === "永久删除所选资料", "second confirmation");
    await page.locator("#confirm-button").click();
    await until(async () => !(await page.locator("#cache-preview-button").isDisabled()), "request completed");
  };
  handlers.set("/api/cache/remove-unlinked-profiles", () => ({ _status: 404, error: "接口不存在" }));
  await submit();
  assert.match(await page.locator("#cache-status").textContent(), /完全关闭工具后重新打开/);
  assert.equal(await page.locator("input[data-removal-id]").isChecked(), true);
  handlers.set("/api/cache/remove-unlinked-profiles", () => ({ ...removedHistory(), status: "partial", removedProfiles: 0,
    removedFiles: 0, removedBytes: 0, profiles: [{ ...historyPreview().profiles[3], linked: true, status: "skipped",
      message: "该资料现在仍被账号绑定使用，禁止删除。" }] }));
  await submit();
  assert.equal(await page.locator("input[data-removal-id]").count(), 0);
  assert.match(await page.locator("#cache-removal-receipt").textContent(), /禁止删除/);
  await page.locator("#cache-preview-button").click();
  await until(async () => await page.locator("input[data-removal-id]").count() === 1, "rescan new fixture");
  handlers.set("/api/cache/remove-unlinked-profiles", () => ({ ...removedHistory(), status: "partial", removedProfiles: 0,
    profiles: [{ ...historyPreview().profiles[3], status: "partial", remainingPath: 'D:\\fixture\\<remaining>', message: "剩余文件已保留" }] }));
  await submit();
  assert.match(await page.locator("#cache-removal-receipt").textContent(), /剩余文件位置.*<remaining>/);
  assert.equal(await page.locator("#cache-removal-receipt remaining").count(), 0);
  assert.equal(callsTo(calls, "/api/cache/remove-unlinked-profiles").length, 3);
});
