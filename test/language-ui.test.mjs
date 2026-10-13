import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chooseAppearance } from "./fixtures/appearance-controls.mjs";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54361";
const filename = "20260822_查看来源_01_1234567890abcdef.jpg";
const personName = "同步失败";
const folderPath = "D:\\缓存清理\\图片";
const mediaId = "a".repeat(64);

async function fixture(t, { locale = "en-US", systemLanguage = "zh", preference = "system", width = 1600, running = false } = {}) {
  const context = await browser.newContext({ locale, viewport: { width, height: 1100 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const model = {
    runtime: { label: "工具内置 Chromium", systemLanguage }, settings: { theme: "dark", language: preference },
    platforms: { x: { label: "X" }, instagram: { label: "Instagram" }, tiktok: { label: "TikTok" } },
    linkedAccounts: [{ id: "login", platformId: "x", platformLabel: "X", label: "图片", loginStatus: "verified", loginMessage: "登录验证通过。", browserLabel: "工具内置 Chromium" }],
    persons: [{ id: "person", name: personName, note: "查看来源", folderPath, platforms: [{ id: "x", label: "X", accounts: [{ id: "target", label: "验证登录", linkedAccountId: "login" }] }] }],
    syncSummaries: { person: { id: "job", personId: "person", status: running ? "running" : "completed", message: "正在读取 验证登录 的 X 时间线。", newFileCount: 1,
      counters: { accounts: 1, accountsFinished: running ? 0 : 1, discovered: 1, downloaded: 1, bytes: 2048 } } },
  };
  const calls = [], errors = [], external = [], handlers = new Map();
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const media = { mediaId, filename, relativePath: `Image/${filename}`, kind: "image", bytes: 2048, sourceCount: 1 };
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.startsWith("/api/")) calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    let payload;
    if (handlers.has(url.pathname)) payload = await handlers.get(url.pathname)(request);
    else if (url.pathname === "/api/state") payload = model;
    else if (url.pathname === "/api/runtime/status") payload = model.runtime;
    else if (url.pathname === "/api/settings") { Object.assign(model.settings, request.postDataJSON()); payload = model.settings; }
    else if (url.pathname === "/api/sync-jobs/job") payload = model.syncSummaries.person;
    else if (url.pathname === "/api/persons/person/new-files") payload = { available: true, jobId: "job", files: [{ id: "file", ...media }] };
    else if (url.pathname === "/api/persons/person/media") payload = { items: [media], total: 1, offset: 0, limit: 50 };
    else if (url.pathname.endsWith("/sources")) payload = { sources: [{ platformId: "x", platformLabel: "X", accountId: "target", accountLabel: "验证登录", postId: "42", logicalKey: "42:0", postUrl: "https://x.com/test/status/42", publicationDate: "20260822", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai", createdAt: "2026-08-22T10:00:00Z" }] };
    else if (url.pathname.endsWith("/open") || url.pathname.endsWith("-new-file")) payload = { launched: true, foreground: true };
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    await route.fulfill({ status: payload?._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator(".person-card").waitFor();
  return { page, model, calls, handlers };
}

async function switchLanguage(page, language) {
  await chooseAppearance(page, "language", language);
  await page.waitForFunction((language) => document.documentElement.dataset.language === language, language === "system" ? "zh" : language);
}

test("Windows system display language overrides browser locale; all other system languages use English", async (t) => {
  for (const [locale, systemLanguage, preference, expected] of [
    ["en-US", "zh", "system", "zh"], ["zh-CN", "en", "system", "en"],
    ["fr-FR", "en", "system", "en"], ["zh-TW", "zh", "system", "zh"],
    ["en-US", "en", "zh", "zh"], ["zh-CN", "zh", "en", "en"],
  ]) {
    const { page } = await fixture(t, { locale, systemLanguage, preference });
    assert.equal(await page.locator("html").getAttribute("data-language"), expected);
    assert.equal(await page.locator("html").getAttribute("lang"), expected === "zh" ? "zh-CN" : "en");
    assert.equal(await page.locator("#people-title").textContent(), expected === "zh" ? "目标账号信息" : "Target accounts");
    assert.equal(await page.locator(".person-card h3").textContent(), personName);
    assert.equal(await page.locator(".person-card .note").textContent(), "查看来源");
  }
});

test("the language control precedes theme in the top toolbar, saves separately, and survives reload and system mode", async (t) => {
  const { page, calls, model } = await fixture(t);
  assert.equal(await page.locator("#language-control").evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector("#theme-control")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  await switchLanguage(page, "en");
  await page.waitForFunction(() => localStorage.getItem("media-tracker-language") === "en");
  await page.waitForTimeout(60);
  assert.ok(calls.some((call) => call.path === "/api/settings" && JSON.stringify(call.body) === JSON.stringify({ language: "en" })));
  assert.equal(model.settings.theme, "dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.reload();
  await page.locator(".person-card").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-language"), "en");
  await switchLanguage(page, "system");
  assert.equal(await page.locator('#language-control input[value="system"]').isChecked(), true);
  await page.evaluate(() => window.dispatchEvent(new Event("languagechange")));
  assert.equal(await page.locator("html").getAttribute("data-language"), "zh", "browser language changes cannot override confirmed Windows UI language");
});

test("hot language changes preserve drafts, person and file nodes, expanded receipt and local sources", async (t) => {
  const { page, calls } = await fixture(t, { running: true });
  await page.locator(".new-files-toggle").click();
  const file = page.locator(".new-file-name");
  await file.waitFor();
  await file.evaluate((node) => { window.fixtureFileNode = node; });
  await switchLanguage(page, "en");
  assert.equal(await file.evaluate((node) => window.fixtureFileNode === node), true);
  assert.equal(await file.textContent(), filename);
  assert.equal(await page.locator(".new-files-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(".person-card h3").textContent(), personName);
  assert.match(await page.locator(".sync-receipt > p").first().textContent(), /Reading the X timeline for 验证登录/);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("缓存清理");
  await page.locator("#person-note").fill("媒体与来源");
  await page.locator("#selected-path").fill(folderPath);
  await page.locator("#add-platform-button").click();
  await page.locator('[data-field="label"]').fill("验证登录");
  await switchLanguage(page, "zh", { modal: true });
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await page.locator("#person-name").inputValue(), "缓存清理");
  assert.equal(await page.locator("#person-note").inputValue(), "媒体与来源");
  assert.equal(await page.locator("#selected-path").inputValue(), folderPath);
  assert.equal(await page.locator('[data-field="label"]').inputValue(), "验证登录");
  await page.locator("#close-dialog-button").click();
  await page.locator(".browse-person-media").click();
  await page.locator(".media-file-name").waitFor();
  await page.locator("#media-list .file-sources-button").click();
  await page.locator(".media-source-record").waitFor();
  const sourceRequests = calls.filter((call) => call.path.endsWith("/sources")).length;
  await switchLanguage(page, "en", { modal: true });
  assert.equal(await page.locator(".media-file-name").textContent(), filename);
  assert.match(await page.locator(".media-source-heading strong").textContent(), /验证登录/);
  assert.equal(await page.locator(".media-source-record dt").first().textContent(), "Publication date");
  assert.equal(calls.filter((call) => call.path.endsWith("/sources")).length, sourceRequests, "language changes do not fetch again");
  assert.equal(calls.some((call) => /\/(sync|login|verify-login)$/.test(call.path) && call.method === "POST"), false);
});

test("English copy covers all views, native-file actions and modal controls without translating account data", async (t) => {
  const { page } = await fixture(t, { preference: "en" });
  assert.equal(await page.locator(".sync-person").textContent(), "Incremental sync");
  assert.equal(await page.locator(".browse-person-media").textContent(), "Media and sources");
  assert.equal(await page.locator(".open-person-folder").textContent(), "Open folder");
  await page.locator(".new-files-toggle").click();
  await page.locator(".new-file-name").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("foreground"));
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator(".linked-card h3").textContent(), "图片");
  assert.match(await page.locator(".open-login").textContent(), /Open login window/);
  await page.locator("#create-linked-platform-button").click();
  assert.equal(await page.locator("#platform-dialog-title").textContent(), "Add custom platform");
  assert.equal(await page.locator("#custom-platform-label").getAttribute("placeholder"), "Example: My photo site");
  await page.locator("#cancel-platform-dialog").click();
  await page.locator('[data-view="people"]').click();
  await page.locator(".delete-person").click();
  assert.equal(await page.locator("#confirm-title").textContent(), `Delete person “${personName}”?`);
  await switchLanguage(page, "zh", { modal: true });
  assert.equal(await page.locator("#confirm-title").textContent(), `删除人物“${personName}”？`);
  assert.equal(await page.locator("#confirm-dialog").isVisible(), true);
  await page.locator("#confirm-cancel").click();
});

test("failed saves roll back safely and rapid switching persists the latest choice", async (t) => {
  const { page, handlers, model } = await fixture(t);
  handlers.set("/api/settings", () => ({ _status: 500, error: "Fixture failure" }));
  await chooseAppearance(page, "language", "en");
  await page.waitForFunction(() => document.documentElement.dataset.language === "zh");
  assert.match(await page.locator("#toast").textContent(), /无法保存界面语言/);
  handlers.delete("/api/settings");
  await page.evaluate(() => {
    for (const language of ["en", "zh", "en"]) {
      const input = document.querySelector(`#language-control input[value="${language}"]`);
      input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(150);
  assert.equal(model.settings.language, "en");
  assert.equal(await page.locator("html").getAttribute("data-language"), "en");
});

test("queued and custom-platform progress uses structured names without splitting or translating user labels", async (t) => {
  const { page, model, calls } = await fixture(t, { preference: "en", running: true });
  const waitingPerson = "等待 的 人物；图片";
  const platformName = "自定义 的 平台 · 相册";
  model.syncSummaries.person = { ...model.syncSummaries.person, status: "queued", queuePosition: 2,
    queueWaiting: [{ personName: waitingPerson, platform: platformName, reason: "busy" }],
    queueReason: `等待 ${waitingPerson} 释放 ${platformName} 资源`, message: "旧排队文本" };
  await page.reload();
  await page.locator(".person-card").waitFor();
  assert.equal(await page.locator(".sync-queue-reason").textContent(), `Queue position 2 · Waiting for ${waitingPerson} to release ${platformName}`);
  assert.match(await page.locator(".sync-receipt > p").first().textContent(), /Queue position 2/);
  const accountLabel = "平台 的 账号 <b>视频</b>";
  model.platforms.custom = { label: platformName, custom: true };
  model.persons[0].platforms = [{ id: "custom", label: platformName, accounts: [{ id: "custom-account", label: accountLabel }] }];
  const message = `正在读取 ${accountLabel} 的 ${platformName} 媒体。`;
  model.syncSummaries.person = { ...model.syncSummaries.person, status: "running", currentAccount: `${platformName} · ${accountLabel}`, message };
  await page.reload();
  await page.locator(".person-card").waitFor();
  assert.equal(await page.locator(".sync-receipt > p").first().textContent(), `Reading ${platformName} media for ${accountLabel}.`);
  await switchLanguage(page, "zh");
  assert.equal(await page.locator(".sync-receipt > p").first().textContent(), message);
  assert.equal(await page.locator(".sync-receipt b").count(), 4, "account HTML is displayed as text, never interpreted");
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("English language and theme controls fit desktop and narrow windows with no horizontal overflow", async (t) => {
  for (const width of [1600, 900, 390]) {
    const { page } = await fixture(t, { width, preference: "en" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const language = await page.locator("#language-menu-button").boundingBox();
    const theme = await page.locator("#theme-menu-button").boundingBox();
    assert.ok(Math.abs(language.y - theme.y) < 1 && language.x + language.width <= theme.x,
      "compact language and theme triggers share the top row");
    await page.locator("#create-person-button").click();
    const overflow = await page.locator("#person-dialog").evaluate((node) => ({
      client: node.clientWidth, scroll: node.scrollWidth,
      children: [...node.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > node.getBoundingClientRect().right + 1)
        .slice(0, 12).map((element) => ({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 85) })),
    }));
    assert.ok(overflow.scroll <= overflow.client, JSON.stringify({ width, ...overflow }));
    if (width === 1600) {
      await mkdir(new URL("../test-artifacts/ui-language/", import.meta.url), { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL("../test-artifacts/ui-language/english-person-dialog.png", import.meta.url)), fullPage: true });
    }
    await page.locator("#close-dialog-button").click();
    if ([1600, 390].includes(width)) {
      await mkdir(new URL("../test-artifacts/ui-language/", import.meta.url), { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL(`../test-artifacts/ui-language/english-${width}.png`, import.meta.url)), fullPage: true });
    }
  }
});

test("English copy retains contrasting light theme and long custom platform controls fit", async (t) => {
  const { page } = await fixture(t, { preference: "en" });
  await chooseAppearance(page, "theme", "light");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.locator('[data-view="settings"]').click();
  await page.locator("#create-linked-platform-button").click();
  assert.equal(await page.locator("#platform-dialog").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await mkdir(new URL("../test-artifacts/ui-language/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../test-artifacts/ui-language/english-light-custom-platform.png", import.meta.url)), fullPage: true });
});

test("person actions are horizontal in both languages, keep status on its own row and wrap only in narrow windows", async (t) => {
  for (const preference of ["zh", "en"]) {
    const { page, model, calls } = await fixture(t, { preference });
    for (const width of [1920, 1600, 1024, 921, 920, 900, 641, 640, 540, 480, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const busy of [false, true]) {
        await page.locator("#sync-all-button span:last-child").evaluate((node, label) => { node.textContent = label; },
          preference === "zh" ? busy ? "同步队列运行中" : "一键同步全部" : busy ? "Sync queue running" : "Sync all");
        await page.locator("#dedup-all-button span:last-child").evaluate((node, label) => { node.textContent = label; },
          preference === "zh" ? busy ? "本地去重进行中" : "一键去重" : busy ? "Local deduplication running" : "Deduplicate all");
        const { create, sync, dedup, status } = await page.locator(".people-page-actions").evaluate((node) =>
          Object.fromEntries([["create", "#create-person-button"], ["sync", "#sync-all-button"], ["dedup", "#dedup-all-button"], ["status", "#sync-all-status"]]
            .map(([key, selector]) => [key, node.querySelector(selector).getBoundingClientRect().toJSON()])));
        assert.ok(Math.abs(create.y - sync.y) < 1 && create.x + create.width <= sync.x + 0.1, `${preference}/${width}: create and sync share a row ${JSON.stringify({ create, sync, dedup })}`);
        if (width > 520) assert.ok(Math.abs(sync.y - dedup.y) < 1 && sync.x + sync.width <= dedup.x + 0.1, `${preference}/${width}: all three actions share a row ${JSON.stringify({ create, sync, dedup })}`);
        else assert.ok(dedup.y >= sync.y + sync.height && Math.abs(dedup.x - create.x) < 1, `${preference}/${width}: dedup wraps without a single-column toolbar`);
        assert.ok(status.y >= dedup.y + dedup.height, `${preference}/${width}: hint follows all actions`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${preference}/${width}: no page overflow`);
        const overflow = await page.locator(".people-page-actions").evaluate((node) => [...node.querySelectorAll("button, button span")]
          .filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.id || element.textContent));
        assert.deepEqual(overflow, [], `${preference}/${width}: long running labels fit`);
      }
      if ([1600, 390].includes(width)) {
        await page.locator("#sync-all-button span:last-child").evaluate((node, label) => { node.textContent = label; }, preference === "zh" ? "一键同步全部" : "Sync all");
        await page.locator("#dedup-all-button span:last-child").evaluate((node, label) => { node.textContent = label; }, preference === "zh" ? "一键去重" : "Deduplicate all");
        await mkdir(new URL("../test-artifacts/ui-language/", import.meta.url), { recursive: true });
        await page.screenshot({ path: fileURLToPath(new URL(`../test-artifacts/ui-language/horizontal-actions-${preference}-${width}.png`, import.meta.url)), fullPage: true });
      }
    }
    assert.equal(model.persons.length, 1);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  }
});
