import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chooseAppearance, openAppearanceMenu } from "./fixtures/appearance-controls.mjs";

// Local, headless UI fixtures only. Do not use real profiles, settings, media,
// account sessions or platform network access while testing appearance menus.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54385";
const directory = new URL("../test-artifacts/appearance-toolbar/", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { host = true, width = 1600, height = 1000, theme = "dark", language = "zh",
  systemLanguage = "zh", colorScheme = "dark", running = false } = {}) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width, height }, colorScheme, reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const nativeCalls = [], calls = [], errors = [], external = [], handlers = new Map();
  const model = {
    runtime: { label: "工具内置 Chromium", systemLanguage }, settings: { theme, language },
    platforms: { x: { label: "X" }, instagram: { label: "Instagram" } },
    linkedAccounts: [{ id: "login", platformId: "x", platformLabel: "X", label: "本地账户", loginStatus: "verified" }],
    persons: [{ id: "person", name: "测试人物", note: "所有修改仅用于测试", folderPath: "D:\\Fixture\\Person",
      platforms: [{ id: "x", label: "X", accounts: [{ id: "target", label: "creator", linkedAccountId: "login" }] }] }],
    syncSummaries: {},
  };
  if (running) model.syncSummaries.person = { id: "job", personId: "person", status: "running",
    message: "正在读取 creator 的 X 时间线。", counters: { accounts: 1, accountsFinished: 0, downloaded: 0 } };
  if (host) {
    await page.exposeFunction("__mediaTrackerWindow", (action) => {
      nativeCalls.push(action);
      return { frameless: true, maximized: false, minimized: false };
    });
    await page.addInitScript(() => { window.__mediaTrackerWindowState = { frameless: true, maximized: false, minimized: false }; });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    let payload;
    if (url.pathname.startsWith("/api/")) calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (handlers.has(url.pathname)) payload = await handlers.get(url.pathname)(request);
    else if (url.pathname === "/api/state") payload = structuredClone(model);
    else if (url.pathname === "/api/runtime/status") payload = structuredClone(model.runtime);
    else if (url.pathname === "/api/settings") {
      Object.assign(model.settings, request.postDataJSON());
      payload = { settings: structuredClone(model.settings) };
    } else if (url.pathname === "/api/sync-jobs/job") payload = structuredClone(model.syncSummaries.person);
    else if (url.pathname === "/api/cache/preview") payload = { status: "empty", totalBytes: 0, totalFiles: 0, profiles: [], errors: [] };
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ status: payload?._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator(".person-card").waitFor();
  if (host) await page.waitForFunction(() => document.documentElement.dataset.windowHost === "frameless");
  await page.waitForFunction(({ theme, language, colorScheme, systemLanguage }) =>
    document.documentElement.dataset.theme === (theme === "system" ? colorScheme : theme)
    && document.documentElement.dataset.language === (language === "system" ? systemLanguage : language), { theme, language, colorScheme, systemLanguage });
  return { page, context, calls, handlers, model, nativeCalls };
}

const saves = (calls, kind) => calls.filter((call) => call.path === "/api/settings" && Object.hasOwn(call.body || {}, kind));
async function noOverflow(page, selector = "html") {
  assert.equal(await page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${selector} stays within viewport`);
}

test("compact appearance triggers sit left of minimize with a deliberate gap and no sidebar duplicates", async (t) => {
  const { page } = await fixture(t);
  assert.equal(await page.locator("#appearance-toolbar").isVisible(), true);
  assert.equal(await page.locator(".sidebar #language-control, .sidebar #theme-control").count(), 0);
  assert.equal(await page.locator("#language-control").count(), 1);
  assert.equal(await page.locator("#theme-control").count(), 1);
  assert.equal(await page.locator("#language-menu-button").textContent(), "中/En");
  assert.equal(await page.locator("#theme-menu-button svg").count(), 1);
  assert.equal(await page.locator("#theme-menu-button svg").getAttribute("aria-hidden"), "true");
  assert.equal((await page.locator("#theme-menu-button").textContent()).trim(), "", "theme trigger uses an icon, not a text label");
  const language = await page.locator("#language-menu-button").boundingBox();
  const theme = await page.locator("#theme-menu-button").boundingBox();
  const minimize = await page.locator("#window-minimize").boundingBox();
  assert.ok(Math.abs(language.y - theme.y) < 1 && Math.abs(theme.y - minimize.y) < 1);
  assert.ok(language.x + language.width <= theme.x);
  assert.equal(Math.round(minimize.x - (theme.x + theme.width)), 24);
  assert.equal(await page.locator("#language-menu").isVisible(), false);
  assert.equal(await page.locator("#theme-menu").isVisible(), false);
  for (const kind of ["language", "theme"]) {
    assert.equal(await page.locator(`#${kind}-menu-button`).getAttribute("type"), "button");
    assert.equal(await page.locator(`#${kind}-menu-button`).getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(`#${kind}-menu-button`).getAttribute("aria-controls"), `${kind}-menu`);
  }
});

test("ordinary browsers retain appearance controls without pretending to control their native window", async (t) => {
  const { page, nativeCalls, calls } = await fixture(t, { host: false });
  assert.equal(await page.locator("#window-chrome").isVisible(), false);
  assert.equal(await page.locator("#appearance-toolbar").isVisible(), true);
  const trigger = await page.locator("#theme-menu-button").boundingBox();
  assert.ok(trigger.x + trigger.width <= 1600 && trigger.x > 1400);
  await chooseAppearance(page, "language", "en");
  await chooseAppearance(page, "theme", "light");
  assert.equal(await page.locator("html").getAttribute("data-language"), "en");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.deepEqual(nativeCalls, []);
  assert.equal(calls.some((call) => /window|sync$|login|verify/.test(call.path) && call.method !== "GET"), false);
});

test("menus expose requested option order, are mutually exclusive, and return focus after selection", async (t) => {
  const { page, calls } = await fixture(t);
  await openAppearanceMenu(page, "language");
  assert.deepEqual(await page.locator("#language-control label span").allTextContents(), ["系统", "中文", "En"]);
  assert.deepEqual(await page.locator("#language-control input").evaluateAll((nodes) => nodes.map((node) => node.value)), ["system", "zh", "en"]);
  await page.locator("#theme-menu-button").click();
  assert.equal(await page.locator("#language-menu").isVisible(), false);
  assert.equal(await page.locator("#theme-menu").isVisible(), true);
  assert.deepEqual(await page.locator("#theme-control label span").allTextContents(), ["系统", "深色", "浅色"]);
  assert.deepEqual(await page.locator("#theme-control input").evaluateAll((nodes) => nodes.map((node) => node.value)), ["system", "dark", "light"]);
  await chooseAppearance(page, "theme", "light");
  assert.equal(await page.locator("#theme-menu-button").evaluate((node) => node === document.activeElement), true);
  await page.waitForFunction(() => localStorage.getItem("media-tracker-theme") === "light");
  assert.equal(saves(calls, "theme").length, 1);
});

test("keyboard opens to the current selection and Escape closes only the menu before the parent modal", async (t) => {
  const { page } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("保留未提交名称");
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "person-dialog");
  await page.locator("#language-menu-button").focus();
  await page.keyboard.press("ArrowDown");
  await page.locator("#language-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator('#language-control input[value="zh"]').evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#language-menu").isVisible(), false);
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await page.locator("#person-name").inputValue(), "保留未提交名称");
  assert.equal(await page.locator("#language-menu-button").evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#language-menu").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#person-dialog").isVisible(), false);
});

test("outside clicks close a menu without swallowing the underlying action or focus", async (t) => {
  const { page } = await fixture(t);
  await openAppearanceMenu(page, "theme");
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator("#theme-menu").isVisible(), false);
  assert.equal(await page.locator("#settings-view").isVisible(), true);
  assert.equal(await page.locator('[data-view="settings"]').evaluate((node) => node === document.activeElement), true);
  await openAppearanceMenu(page, "language");
  await page.locator("#linked-label").focus();
  await page.locator("#language-menu").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#linked-label").evaluate((node) => node === document.activeElement), true);
});

test("appearance controls follow the same nodes through nested dialogs and preserve drafts and native buttons", async (t) => {
  const { page, nativeCalls } = await fixture(t);
  await page.evaluate(() => { window.savedToolbar = document.querySelector("#appearance-toolbar"); window.savedLanguage = document.querySelector("#language-menu-button"); });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("未保存名称");
  await page.locator("#create-person-platform-button").click();
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "platform-dialog");
  await page.locator("#custom-platform-label").fill("自定义测试站");
  await chooseAppearance(page, "language", "en");
  await chooseAppearance(page, "theme", "light");
  assert.equal(await page.locator("#custom-platform-label").inputValue(), "自定义测试站");
  await page.locator("#window-minimize").click();
  assert.ok(nativeCalls.includes("minimize"));
  await page.locator("#cancel-platform-dialog").click();
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "person-dialog");
  assert.equal(await page.locator("#person-name").inputValue(), "未保存名称");
  await chooseAppearance(page, "language", "zh");
  await page.locator("#close-dialog-button").click();
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement === document.body);
  assert.deepEqual(await page.evaluate(() => ({ toolbar: window.savedToolbar === document.querySelector("#appearance-toolbar"),
    trigger: window.savedLanguage === document.querySelector("#language-menu-button") })), { toolbar: true, trigger: true });
});

test("a menu remains open with its original nodes and selection during sync polling", async (t) => {
  const { page, model, calls } = await fixture(t, { running: true });
  await openAppearanceMenu(page, "language");
  await page.evaluate(() => { window.savedMenu = document.querySelector("#language-menu"); window.savedChecked = document.querySelector('#language-control input[value="zh"]'); });
  model.syncSummaries.person.message = "下一次进度";
  await page.waitForTimeout(1750);
  assert.ok(calls.some((call) => call.path === "/api/sync-jobs/job"));
  assert.equal(await page.locator("#language-menu").isVisible(), true);
  assert.deepEqual(await page.evaluate(() => ({ menu: window.savedMenu === document.querySelector("#language-menu"),
    checked: window.savedChecked === document.querySelector('#language-control input[value="zh"]'),
    selected: window.savedChecked.checked })), { menu: true, checked: true, selected: true });
});

test("ordinary-browser modals permit real label selection without losing the click to dialog focus", async (t) => {
  const { page, nativeCalls } = await fixture(t, { host: false, language: "en", theme: "dark" });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("保留当前表单");
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "person-dialog");
  await chooseAppearance(page, "language", "zh");
  await page.waitForFunction(() => document.documentElement.dataset.language === "zh");
  await chooseAppearance(page, "theme", "light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await page.locator("#person-name").inputValue(), "保留当前表单");
  assert.deepEqual(nativeCalls, []);
  await page.locator("#close-dialog-button").click();
  await page.locator(".delete-person").click();
  await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "confirm-dialog");
  await chooseAppearance(page, "language", "en");
  await page.waitForFunction(() => document.documentElement.dataset.language === "en");
  assert.equal(await page.locator("#confirm-dialog").isVisible(), true);
  assert.match(await page.locator("#confirm-title").textContent(), /Delete person/);
});

test("keyboard choice and leaving the toolbar preserve usable focus without unnecessary same-choice writes", async (t) => {
  const { page, calls } = await fixture(t);
  await page.locator("#language-menu-button").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.documentElement.dataset.language === "en");
  assert.equal(await page.locator("#language-menu").isVisible(), false);
  assert.equal(await page.locator("#language-menu-button").evaluate((node) => node === document.activeElement), true);
  assert.equal(saves(calls, "language").length, 1);
  await chooseAppearance(page, "language", "en");
  assert.equal(await page.locator("#language-menu-button").evaluate((node) => node === document.activeElement), true);
  assert.equal(saves(calls, "language").length, 1, "an unchanged radio closes the menu but does not write the setting again");
  await page.locator("#theme-menu-button").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator('#theme-control input[value="dark"]').evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Tab");
  await page.locator("#theme-menu").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#window-minimize").evaluate((node) => node === document.activeElement), true);
});

test("failed language and theme saves restore the persisted choice without duplicate handlers", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  handlers.set("/api/settings", () => ({ _status: 500, error: "Local fixture could not save" }));
  await chooseAppearance(page, "language", "en");
  await page.waitForFunction(() => document.documentElement.dataset.language === "zh" && document.querySelector("#toast").textContent.includes("无法保存"));
  assert.equal(await page.locator('#language-control input[value="zh"]').isChecked(), true);
  await chooseAppearance(page, "theme", "light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.locator('#theme-control input[value="dark"]').isChecked(), true);
  assert.equal(saves(calls, "language").length, 1);
  assert.equal(saves(calls, "theme").length, 1);
  handlers.delete("/api/settings");
  for (let index = 0; index < 4; index += 1) {
    await page.locator("#create-person-button").click();
    await openAppearanceMenu(page, "theme");
    await page.keyboard.press("Escape");
    await page.locator("#close-dialog-button").click();
  }
  await chooseAppearance(page, "theme", "light");
  await page.waitForFunction(() => localStorage.getItem("media-tracker-theme") === "light");
  assert.equal(saves(calls, "theme").length, 2, "moving toolbar through dialogs does not duplicate its save handler");
});

test("rapid theme choices preserve the latest pending setting when an older request fails", async (t) => {
  const { page, handlers, model, calls } = await fixture(t);
  const pending = deferred();
  let requestCount = 0;
  handlers.set("/api/settings", async (request) => {
    requestCount += 1;
    if (requestCount === 1) return pending.promise;
    Object.assign(model.settings, request.postDataJSON());
    return { settings: structuredClone(model.settings) };
  });
  await chooseAppearance(page, "theme", "light");
  await chooseAppearance(page, "theme", "dark");
  await chooseAppearance(page, "theme", "system");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator('#theme-control input[value="system"]').isChecked(), true);
  pending.resolve({ _status: 500, error: "Older local fixture request failed" });
  await page.waitForFunction(() => localStorage.getItem("media-tracker-theme") === "system");
  await page.waitForTimeout(120);
  assert.deepEqual(saves(calls, "theme").map((call) => call.body.theme), ["light", "dark", "system"]);
  assert.equal(model.settings.theme, "system");
  assert.equal(await page.locator('#theme-control input[value="system"]').isChecked(), true);
  assert.equal(await page.locator("#toast").textContent(), "", "an obsolete failed request does not roll back or warn over the later successful setting");
});

test("saved system choices survive reload and follow system language and theme rather than browser locale", async (t) => {
  const { page, model, calls } = await fixture(t, { language: "en", theme: "light", systemLanguage: "zh" });
  await chooseAppearance(page, "language", "system");
  await chooseAppearance(page, "theme", "system");
  await page.waitForFunction(() => localStorage.getItem("media-tracker-language") === "system" && localStorage.getItem("media-tracker-theme") === "system");
  await page.waitForTimeout(80);
  assert.equal(model.settings.language, "system");
  assert.equal(model.settings.theme, "system");
  assert.deepEqual(saves(calls, "language")[0].body, { language: "system" });
  assert.deepEqual(saves(calls, "theme")[0].body, { theme: "system" });
  await page.reload();
  await page.locator(".person-card").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-language"), "zh");
  assert.equal(await page.locator('#language-control input[value="system"]').isChecked(), true);
  assert.equal(await page.locator('#theme-control input[value="system"]').isChecked(), true);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
});

test("trigger SVG, option labels and popover blank surfaces never start native dragging", async (t) => {
  const { page, nativeCalls } = await fixture(t);
  await openAppearanceMenu(page, "theme");
  const targets = ["#theme-menu-button svg", "#theme-menu", '#theme-control label:has(input[value="light"])', "#theme-control"];
  for (const selector of targets) {
    const node = page.locator(selector);
    await node.dispatchEvent("pointerdown", { button: 0, buttons: 1, pointerId: 41, pointerType: "mouse", clientX: 1200, clientY: 80 });
    await node.dispatchEvent("pointermove", { button: 0, buttons: 1, pointerId: 41, pointerType: "mouse", clientX: 1220, clientY: 88 });
    await node.dispatchEvent("pointerup", { button: 0, buttons: 0, pointerId: 41, pointerType: "mouse" });
  }
  assert.equal(nativeCalls.includes("drag"), false);
  assert.equal(await page.locator("#theme-menu").isVisible(), true);
});

test("all views and modal menus share light/dark colors, English labels and narrow safe bounds", async (t) => {
  await mkdir(directory, { recursive: true });
  for (const [theme, language, width, host] of [["dark", "zh", 1600, true], ["light", "en", 1600, true],
    ["dark", "en", 390, true], ["light", "zh", 320, false]]) {
    const { page } = await fixture(t, { theme, language, width, height: 907, host });
    for (const view of ["people", "settings", "cache"]) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.locator(`#${view}-view`).waitFor({ state: "visible" });
      await openAppearanceMenu(page, "theme");
      await noOverflow(page);
      const box = await page.locator("#theme-menu").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      assert.equal(await page.locator("#theme-menu").evaluate((node) => getComputedStyle(node).colorScheme), theme);
      assert.deepEqual(await page.locator("#theme-control label span").allTextContents(), language === "en" ? ["System", "Dark", "Light"] : ["系统", "深色", "浅色"]);
      await page.screenshot({ path: fileURLToPath(new URL(`${view}-${theme}-${language}-${width}.png`, directory)), fullPage: false });
      await page.keyboard.press("Escape");
    }
    await page.locator('[data-view="people"]').click();
    await page.locator("#create-person-button").click();
    await page.waitForFunction(() => document.querySelector("#appearance-toolbar").parentElement.id === "person-dialog");
    await openAppearanceMenu(page, "language");
    await noOverflow(page, "#person-dialog");
    const box = await page.locator("#language-menu").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.deepEqual(await page.locator("#language-control label span").allTextContents(), language === "en" ? ["System", "中文", "En"] : ["系统", "中文", "En"]);
    await page.screenshot({ path: fileURLToPath(new URL(`modal-${theme}-${language}-${width}.png`, directory)), fullPage: false });
  }
});

test("my-account name disables input history while preserving linked accounts and the active unsaved draft", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator("#linked-account-form").getAttribute("autocomplete"), "off");
  assert.equal(await page.locator("#linked-label").getAttribute("autocomplete"), "off");
  assert.equal(await page.locator("#linked-label").getAttribute("list"), null, "no application history suggestions");
  assert.equal(await page.locator("#linked-label").inputValue(), "");
  assert.equal(await page.locator(".linked-card h3").textContent(), "本地账户", "existing binding remains visible");
  await page.locator("#linked-platform").selectOption("x");
  await page.locator("#linked-label").fill("只保留当前正在输入的值");
  handlers.set("/api/linked-accounts", () => ({ _status: 500, error: "Local fixture failed to save binding" }));
  await page.locator('#linked-account-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("failed to save binding"));
  assert.equal(await page.locator("#linked-label").inputValue(), "只保留当前正在输入的值", "failed submit preserves the active editable draft");
  assert.equal(await page.locator(".linked-card h3").textContent(), "本地账户");
  assert.equal(model.linkedAccounts.length, 1);
  handlers.set("/api/linked-accounts", (request) => {
    const body = request.postDataJSON();
    const account = { id: "new-local-binding", platformId: body.platformId, platformLabel: "X", label: body.label, loginStatus: "unverified" };
    model.linkedAccounts.push(account);
    return account;
  });
  await page.locator('#linked-account-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#linked-label").value === "" && document.querySelectorAll(".linked-card").length === 2);
  await page.reload();
  await page.locator(".person-card").waitFor();
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator("#linked-label").inputValue(), "", "reload does not refill a previously entered account name");
  assert.deepEqual(await page.locator(".linked-card h3").allTextContents(), ["本地账户", "只保留当前正在输入的值"]);
  assert.equal(calls.filter((call) => call.path === "/api/linked-accounts").length, 2);
  assert.equal(calls.some((call) => /cache|login|verify/.test(call.path) && call.method !== "GET"), false, "no login information or profiles are cleared");
});
