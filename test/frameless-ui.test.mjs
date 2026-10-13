import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chooseAppearance } from "./fixtures/appearance-controls.mjs";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54373";

async function fixture(t, { host = true, maximized = false, language = "zh", theme = "dark", width = 1600, height = 1000, personCount = 1 } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const native = { frameless: true, maximized, minimized: false };
  const nativeCalls = [], requests = [], errors = [], external = [];
  const model = { runtime: { label: "工具内置 Chromium", systemLanguage: "zh" }, settings: { language, theme }, platforms: { x: { label: "X" } }, linkedAccounts: [],
    persons: [{ id: "person", name: "采集账号 A", note: "保留所有来源", folderPath: "D:\\Fixture\\A", platforms: [{ id: "x", label: "X", accounts: [{ id: "target", label: "creator" }] }] }],
    syncSummaries: { person: { id: "job", personId: "person", status: "running", message: "正在读取 creator 的 X 时间线。", counters: { accounts: 1, accountsFinished: 0, downloaded: 0 } } } };
  const firstPerson = structuredClone(model.persons[0]);
  for (let index = 1; index < personCount; index += 1) {
    model.persons.push({ ...structuredClone(firstPerson), id: `person-${index}`, name: `采集账号 ${index + 1}` });
  }
  const handlers = new Map();
  if (host) {
    await page.exposeFunction("__mediaTrackerWindow", async (action) => {
      nativeCalls.push(action);
      if (handlers.has(action)) return handlers.get(action)();
      return structuredClone(native);
    });
    await page.addInitScript((state) => { window.__mediaTrackerWindowState = state; }, native);
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
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === "/api/state") payload = model;
    else if (url.pathname === "/api/runtime/status") payload = model.runtime;
    else if (url.pathname === "/api/settings") { Object.assign(model.settings, request.postDataJSON()); payload = model.settings; }
    else if (url.pathname === "/api/sync-jobs/job") payload = model.syncSummaries.person;
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator(".person-card").first().waitFor();
  if (host) await page.waitForFunction(() => document.documentElement.dataset.windowHost === "frameless");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme === "system" ? "dark" : theme);
  return { page, native, nativeCalls, requests, handlers, model };
}

test("ordinary browsers have no native-looking controls or extra top spacing", async (t) => {
  const { page, requests } = await fixture(t, { host: false });
  assert.equal(await page.locator("#window-chrome").isVisible(), false);
  assert.equal(await page.locator("html").getAttribute("data-window-host"), null);
  assert.ok(Number.parseFloat(await page.locator(".main-content").evaluate((node) => getComputedStyle(node).paddingTop)) >= 68,
    "ordinary browsers reserve space for the appearance toolbar, not native window controls");
  assert.equal(requests.some((item) => /window/.test(item.path)), false);
});

test("the host gets larger themed SVG controls clear of page actions in both languages", async (t) => {
  const { page, requests } = await fixture(t);
  assert.equal(await page.locator("#window-chrome").isVisible(), true);
  assert.equal(await page.locator(".window-controls button").count(), 3);
  const initial = await page.locator("#window-minimize").evaluate((node) => ({ box: node.getBoundingClientRect().toJSON(), background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
  assert.equal(initial.box.width, 56);
  assert.equal(initial.box.height, 48);
  assert.equal(initial.background, "rgb(13, 20, 32)");
  assert.equal(initial.color, "rgb(238, 243, 251)");
  assert.equal(await page.locator("#window-minimize svg").getAttribute("aria-hidden"), "true");
  const actions = await page.locator(".people-page-actions").boundingBox();
  const controls = await page.locator(".window-controls").boundingBox();
  assert.ok(actions.y >= controls.y + controls.height, "the new controls do not cover create/sync/dedup");
  await chooseAppearance(page, "theme", "light");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#window-minimize")).backgroundColor === "rgb(244, 247, 251)");
  assert.equal(await page.locator("#window-minimize").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(244, 247, 251)");
  assert.equal(await page.locator("#window-minimize").evaluate((node) => getComputedStyle(node).color), "rgb(23, 32, 51)");
  await chooseAppearance(page, "language", "en");
  assert.equal(await page.locator("#window-minimize").getAttribute("aria-label"), "Minimize window");
  assert.equal(await page.locator("#window-maximize").getAttribute("aria-label"), "Maximize window");
  assert.equal(await page.locator("#window-close").getAttribute("title"), "Close app and stop its background service");
  assert.equal(requests.some((item) => /\/(sync|login|verify-login)$/.test(item.path)), false);
});

test("maximize labels and restore icons only change after a confirmed native state", async (t) => {
  const { page, native, nativeCalls, handlers } = await fixture(t);
  const maximize = page.locator("#window-maximize");
  await maximize.evaluate((node) => { window.fixtureWindowButton = node; });
  await maximize.click();
  assert.ok(nativeCalls.includes("toggle-maximize"));
  assert.equal(await maximize.getAttribute("data-maximized"), "false", "successful dispatch is not evidence of maximization");
  assert.equal(await maximize.getAttribute("aria-label"), "最大化窗口");
  native.maximized = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("media-tracker-window-state", { detail: { frameless: true, maximized: true, minimized: false } })));
  assert.equal(await maximize.getAttribute("aria-label"), "还原窗口");
  assert.equal(await maximize.getAttribute("aria-pressed"), "true");
  assert.equal(await maximize.locator(".window-restore-icon").isVisible(), true);
  assert.equal(await maximize.locator(".window-maximize-icon").isVisible(), false);
  await chooseAppearance(page, "language", "en");
  assert.equal(await maximize.getAttribute("aria-label"), "Restore window");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("media-tracker-window-state", { detail: { frameless: true, maximized: "false" } })));
  assert.equal(await maximize.getAttribute("data-maximized"), "true", "malformed state never flips the icon");
  handlers.set("toggle-maximize", () => { native.maximized = false; return structuredClone(native); });
  await maximize.click();
  await page.waitForFunction(() => document.querySelector("#window-maximize").dataset.maximized === "false");
  assert.equal(await maximize.getAttribute("aria-label"), "Maximize window");
  await page.waitForTimeout(1650);
  assert.equal(await maximize.evaluate((node) => window.fixtureWindowButton === node), true, "sync and host polling keep the original control node");
});

test("native actions are fixed strings; pure double-click does not enter the drag loop", async (t) => {
  const { page, nativeCalls, requests } = await fixture(t);
  await page.locator("#window-minimize").click();
  await page.waitForFunction(() => !document.querySelector("#window-minimize").disabled);
  assert.ok(nativeCalls.includes("minimize"));
  const drag = page.locator(".window-drag-space");
  await drag.dblclick({ position: { x: 30, y: 12 } });
  assert.equal(nativeCalls.filter((action) => action === "toggle-maximize").length, 1);
  assert.equal(nativeCalls.includes("drag"), false);
  const box = await drag.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 12);
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector("#window-maximize").disabled);
  assert.equal(nativeCalls.filter((action) => action === "drag").length, 1);
  await page.locator("#window-close").click();
  assert.ok(nativeCalls.includes("close"));
  assert.ok(nativeCalls.every((action) => ["get-state", "minimize", "toggle-maximize", "drag", "close"].includes(action)));
  assert.equal(requests.some((item) => item.method !== "GET"), false, "window actions are not broad HTTP commands or writes");
});

async function dragSurface(page, locator, { x = 12, y = 12, key } = {}) {
  const box = await locator.boundingBox();
  assert.ok(box, "the drag target must be visible");
  if (key) await page.keyboard.down(key);
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 20, box.y + y + 8, { steps: 3 });
  await page.mouse.up();
  if (key) await page.keyboard.up(key);
  await page.waitForTimeout(20);
}

test("headings, person names, notes, paths and sidebar blank surfaces can all drag", async (t) => {
  const { page, nativeCalls } = await fixture(t, { width: 1288, height: 907 });
  const targets = ["#people-title", ".person-name-row h3", ".person-card .note", ".folder-path", ".brand-block strong", "#people-summary .summary-pill"];
  for (const selector of targets) {
    const before = nativeCalls.filter((action) => action === "drag").length;
    await dragSurface(page, page.locator(selector).first(), { x: 8, y: 8 });
    assert.equal(nativeCalls.filter((action) => action === "drag").length, before + 1, selector);
  }
  const before = nativeCalls.filter((action) => action === "drag").length;
  await dragSurface(page, page.locator(".sidebar"), { x: 16, y: 300 });
  assert.equal(nativeCalls.filter((action) => action === "drag").length, before + 1, "sidebar blank");
  await dragSurface(page, page.locator(".folder-path").first(), { x: 16, y: 18, key: "Alt" });
  assert.equal(nativeCalls.filter((action) => action === "drag").length, before + 1, "modifier drag remains text selection");
});

test("interactive descendants, text editing, file controls and scrollbar rails never drag", async (t) => {
  const { page, nativeCalls } = await fixture(t, { width: 1288, height: 907, personCount: 14 });
  await page.evaluate(() => {
    const region = document.querySelector("#people-list .person-card");
    const sample = document.createElement("div");
    sample.id = "fixture-interactions";
    sample.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
    sample.innerHTML = '<a href="#">link</a><button><span>file name</span></button><label><input type="radio" name="fixture-radio">radio</label><input value="edit"><textarea>edit</textarea><select><option>select</option></select><details><summary>summary</summary>record</details><div contenteditable="true">editable</div><div role="menu"><span>menu body</span></div><video controls></video>';
    region.prepend(sample);
  });
  const targets = ["#fixture-interactions a", "#fixture-interactions button span", "#fixture-interactions label", "#fixture-interactions input[value]", "#fixture-interactions textarea", "#fixture-interactions select", "#fixture-interactions summary", '#fixture-interactions [contenteditable]', '#fixture-interactions [role="menu"]', "#fixture-interactions video", '.person-card .open-person-folder'];
  for (const selector of targets) {
    await page.locator(selector).first().dispatchEvent("pointerdown", { button: 0, buttons: 1, pointerId: 18, pointerType: "mouse", clientX: 100, clientY: 400 });
    await page.locator(selector).first().dispatchEvent("pointermove", { button: 0, buttons: 1, pointerId: 18, pointerType: "mouse", clientX: 125, clientY: 410 });
    await page.locator(selector).first().dispatchEvent("pointerup", { button: 0, buttons: 0, pointerId: 18, pointerType: "mouse" });
  }
  const region = page.locator("#people-scroll-region");
  const box = await region.boundingBox();
  await dragSurface(page, region, { x: box.width - 3, y: 40 });
  assert.equal(nativeCalls.includes("drag"), false);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("编辑仍正常");
  await dragSurface(page, page.locator("#person-name"), { x: 20, y: 20 });
  assert.equal(await page.locator("#person-name").inputValue(), "编辑仍正常");
  assert.equal(nativeCalls.includes("drag"), false);
});

test("the actual viewport pins title, actions and summary while only the people region scrolls", async (t) => {
  const { page, model, nativeCalls } = await fixture(t, { width: 1288, height: 907, personCount: 14 });
  const header = await page.locator(".people-overview").boundingBox();
  const sidebar = await page.locator(".sidebar").boundingBox();
  const controls = await page.locator(".window-controls").boundingBox();
  const card = await page.locator(".person-card").first().boundingBox();
  const region = page.locator("#people-scroll-region");
  assert.ok(await region.evaluate((node) => node.scrollHeight > node.clientHeight));
  await region.hover({ position: { x: 20, y: 40 } });
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector("#people-scroll-region").scrollTop > 300);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.deepEqual(await page.locator(".people-overview").boundingBox(), header);
  assert.deepEqual(await page.locator(".sidebar").boundingBox(), sidebar);
  assert.deepEqual(await page.locator(".window-controls").boundingBox(), controls);
  assert.ok((await page.locator(".person-card").first().boundingBox()).y < card.y - 300);
  assert.equal(await page.locator("#create-person-button").isVisible(), true);
  assert.equal(await region.evaluate((node) => getComputedStyle(node).scrollbarColor), "rgb(167, 178, 196) rgb(13, 20, 32)");
  const scrollBefore = await region.evaluate((node) => node.scrollTop);
  model.syncSummaries.person.message = "新轮询消息";
  await page.waitForTimeout(1750);
  assert.equal(await region.evaluate((node) => node.scrollTop), scrollBefore, "polling does not reset the list scroll position");
  assert.equal(nativeCalls.includes("drag"), false, "wheel scrolling never moves the host");
  await page.locator('[data-view="settings"]').click();
  const settings = page.locator("#settings-view");
  await settings.evaluate((node) => { node.scrollTop = 400; });
  assert.ok(await settings.evaluate((node) => node.scrollTop > 0), "settings has its own independent scroll");
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("short windows at narrow and intermediate widths retain access to header actions and cards", async (t) => {
  for (const [width, height] of [[390, 600], [666, 320], [900, 350]]) {
    const { page, nativeCalls } = await fixture(t, { width, height, personCount: 14 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const overview = page.locator(".people-overview");
    const region = page.locator("#people-scroll-region");
    assert.ok((await region.boundingBox()).height >= 50, `cards have usable space at ${width}×${height}`);
    await overview.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await region.evaluate((node) => { node.scrollTop = 300; });
    assert.ok(await region.evaluate((node) => node.scrollTop > 0));
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.locator("#create-person-button").click();
    await page.locator("#person-name").fill("小窗口可用");
    assert.equal(await page.locator("#person-name").inputValue(), "小窗口可用");
    assert.equal(nativeCalls.includes("drag"), false);
  }
});

test("the same controls stay usable in nested modal dialogs, and return without disturbing drafts", async (t) => {
  const { page, nativeCalls } = await fixture(t);
  const controls = page.locator("#window-chrome");
  await controls.evaluate((node) => { window.fixtureWindowChrome = node; });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("未保存的名称");
  await page.waitForFunction(() => document.querySelector("#window-chrome").parentElement.id === "person-dialog");
  await page.locator("#window-minimize").click();
  assert.ok(nativeCalls.includes("minimize"));
  await page.locator("#create-person-platform-button").click();
  await page.waitForFunction(() => document.querySelector("#window-chrome").parentElement.id === "platform-dialog");
  await page.locator("#window-maximize").click();
  assert.ok(nativeCalls.includes("toggle-maximize"));
  await page.locator("#cancel-platform-dialog").click();
  await page.waitForFunction(() => document.querySelector("#window-chrome").parentElement.id === "person-dialog");
  assert.equal(await page.locator("#person-name").inputValue(), "未保存的名称");
  await page.locator("#close-dialog-button").click();
  await page.waitForFunction(() => document.querySelector("#window-chrome").parentElement === document.body);
  assert.equal(await controls.evaluate((node) => node === window.fixtureWindowChrome), true);
});

test("system-theme controls, keyboard focus, and narrow layouts remain usable", async (t) => {
  const { page, nativeCalls } = await fixture(t, { width: 390, theme: "system" });
  assert.equal(await page.locator("#window-minimize").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(13, 20, 32)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#window-minimize")).backgroundColor === "rgb(244, 247, 251)");
  assert.equal(await page.locator("#window-minimize").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(244, 247, 251)");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await page.locator(".window-controls").boundingBox();
  const sidebar = await page.locator(".brand-block").boundingBox();
  assert.ok(sidebar.y >= bounds.y + bounds.height);
  await page.locator("#window-minimize").focus();
  assert.equal(await page.locator("#window-minimize").evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
  await page.keyboard.press("Enter");
  assert.ok(nativeCalls.includes("minimize"));
});

test("native failures leave controls available and explain the problem", async (t) => {
  const { page, handlers } = await fixture(t, { language: "en" });
  handlers.set("minimize", () => { throw new Error("Fixture native failure"); });
  await page.locator("#window-minimize").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("window action failed"));
  assert.equal(await page.locator("#window-minimize").isEnabled(), true);
  assert.equal(await page.locator("#window-chrome").isVisible(), true);
});

test("frameless visual fixtures cover light, dark, and modal controls without external requests", async (t) => {
  const directory = new URL("../test-artifacts/frameless-ui/", import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const [theme, language, width, height = 1000, personCount = 1] of [["dark", "zh", 1600], ["light", "en", 1600], ["dark", "en", 390], ["dark", "zh", 1288, 907, 14], ["light", "zh", 1288, 907, 14], ["dark", "zh", 390, 600, 14]]) {
    const { page } = await fixture(t, { theme, language, width, height, personCount });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), theme === "dark" ? "rgb(13, 20, 32)" : "rgb(244, 247, 251)");
    assert.equal(await page.locator("#people-title").evaluate((node) => getComputedStyle(node).color), theme === "dark" ? "rgb(238, 243, 251)" : "rgb(23, 32, 51)");
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${language}-${width}.png`, directory)), fullPage: false });
    if (width === 1288) {
      const heading = await page.locator(".people-overview").boundingBox();
      await page.locator("#people-scroll-region").evaluate((node) => { node.scrollTop = 500; });
      assert.deepEqual(await page.locator(".people-overview").boundingBox(), heading);
      await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${language}-${width}-scrolled.png`, directory)), fullPage: false });
    }
    if (width === 1600 && theme === "dark") {
      await page.locator("#create-person-button").click();
      await page.waitForFunction(() => document.querySelector("#window-chrome").parentElement.id === "person-dialog");
      await page.screenshot({ path: fileURLToPath(new URL("dark-zh-modal-1600.png", directory)), fullPage: false });
    }
  }
});
