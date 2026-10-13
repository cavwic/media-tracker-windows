import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54379";
const failure = "未能读取 Instagram 时间线（匹配响应 14 个）；已等待目标作品加载并静默重试一次。";
const technical = "网站本轮未返回这个帖子的全部附件；已保留记录。";

async function fixture(t, { host = true, language = "zh", theme = "dark", width = 1600, height = 1500, clipboard = "modern" } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height }, colorScheme: "dark" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install();
  const nativeCalls = [], errors = [], external = [], requests = [];
  if (host) {
    const native = { frameless: true, maximized: false, minimized: false };
    await page.exposeFunction("__mediaTrackerWindow", (action) => { nativeCalls.push(action); return native; });
    await page.addInitScript((state) => { window.__mediaTrackerWindowState = state; }, native);
  }
  // Clipboard operations are intercepted within the fixture. Never overwrite
  // the user's Windows clipboard while testing selection or the copy button.
  await page.addInitScript((mode) => {
    window.fixtureClipboardWrites = [];
    window.fixtureFallbackWrites = [];
    window.fixtureCopyEvents = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "absent" ? undefined : {
      async writeText(text) {
        if (["rejected", "both-fail"].includes(mode)) throw new Error("Fixture clipboard permission rejected");
        window.fixtureClipboardWrites.push(text);
      },
    } });
    document.execCommand = (command) => {
      if (command !== "copy" || mode === "both-fail") return false;
      window.fixtureFallbackWrites.push({ text: document.activeElement?.value, selected: document.activeElement?.selectionStart === 0 });
      return true;
    };
    document.addEventListener("copy", (event) => {
      const text = window.getSelection()?.toString() || "";
      window.fixtureCopyEvents.push({ trusted: event.isTrusted, text });
      event.preventDefault();
    }, true);
  }, clipboard);
  const model = { runtime: { label: "工具内置 Chromium", systemLanguage: "zh" }, settings: { language, theme },
    platforms: { instagram: { label: "Instagram" } }, linkedAccounts: [],
    persons: ["fixture_person", "other"].map((id) => ({ id, name: id === "fixture_person" ? "fixture_person" : "Other", folderPath: `D:\\Fixture\\${id}`, platforms: [] })),
    syncSummaries: {
      fixture_person: { id: "fixture_person-job", personId: "fixture_person", status: "running", message: "fixture_person progress", counters: { accounts: 1, accountsFinished: 0, failed: 1 },
        errors: [{ platform: "Instagram", account: "fixture_instagram_a", message: failure }],
        warnings: [{ platform: "Instagram", account: "fixture_instagram_b", category: "attachments", message: technical }] },
      other: { id: "other-job", personId: "other", status: "running", message: "Other progress", counters: { accounts: 1, accountsFinished: 0 } },
    } };
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(requests.some((request) => request.method !== "GET"), false); });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    let payload;
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/state") payload = structuredClone(model);
    else if (url.pathname === "/api/runtime/status") payload = model.runtime;
    else if (url.pathname.startsWith("/api/sync-jobs/")) payload = Object.values(model.syncSummaries).find((job) => url.pathname.endsWith(job.id));
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator('.person-card[data-person-id="fixture_person"]').waitFor();
  return { page, model, nativeCalls };
}

function panel(page, kind = "operational-errors") { return page.locator(`.person-card[data-person-id="fixture_person"] .sync-${kind}`); }

async function selectTextByMouse(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const points = await locator.evaluate((node) => {
    const text = node.firstChild;
    const first = document.createRange(); first.setStart(text, 0); first.setEnd(text, 1);
    const last = document.createRange(); last.setStart(text, 14); last.setEnd(text, 15);
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { start: { x: a.left + 1, y: a.top + a.height / 2 }, end: { x: b.right - 1, y: b.top + b.height / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString());
}

for (const [kind, prefix] of [["operational-errors", "未能读取"], ["technical-records", "网站本轮"]]) {
  test(`frameless ${kind} text supports real mouse selection and Ctrl+C without dragging the window`, async (t) => {
    const { page, nativeCalls } = await fixture(t);
    const details = panel(page, kind);
    await details.locator("summary").click();
    const selected = await selectTextByMouse(page, details.locator("li span").first());
    assert.ok(selected?.includes(prefix), `mouse-selected text: ${selected}`);
    assert.equal(nativeCalls.includes("drag"), false);
    await page.keyboard.press("Control+c");
    assert.deepEqual(await page.evaluate(() => window.fixtureCopyEvents), [{ trusted: true, text: selected }]);
    assert.equal(await details.locator("li span").first().evaluate((node) => getComputedStyle(node).cursor), "text");
    const heading = page.locator("#people-title");
    const bounds = await heading.boundingBox();
    await page.mouse.move(bounds.x + 10, bounds.y + 10);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 35, bounds.y + 10, { steps: 3 });
    await page.mouse.up();
    assert.equal(nativeCalls.filter((action) => action === "drag").length, 1, "ordinary blank/title surfaces keep window dragging");
  });
}

test("polling preserves selected text and copies the displayed snapshot, then closing refreshes the details", async (t) => {
  const { page, model, nativeCalls } = await fixture(t);
  const details = panel(page);
  await details.locator("summary").click();
  const selected = await selectTextByMouse(page, details.locator("li span").first());
  await details.locator("ul").evaluate((node) => { window.fixtureErrorList = node; });
  model.syncSummaries.fixture_person.errors.push({ platform: "Instagram", account: "fixture_instagram_a", message: "New failure after poll" });
  model.syncSummaries.other.message = "Other advanced while reading";
  await page.clock.runFor(1200);
  await page.waitForFunction(() => document.querySelector('[data-person-id="other"] .sync-receipt > p').textContent === "Other advanced while reading");
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected);
  assert.equal(await details.locator("ul").evaluate((node) => window.fixtureErrorList === node), true);
  await details.locator(".copy-sync-details").click();
  const text = await page.evaluate(() => window.fixtureClipboardWrites.at(-1));
  assert.ok(text.includes(failure));
  assert.ok(text.includes("Instagram · fixture_instagram_a"));
  assert.ok(!text.includes("New failure after poll"), "copy follows displayed records, not the newer hidden model");
  await details.locator("summary").click();
  await details.locator("summary").click();
  await page.waitForFunction(() => document.querySelector('[data-person-id="fixture_person"] .sync-operational-errors ul').textContent.includes("New failure after poll"));
  assert.equal(nativeCalls.includes("drag"), false);
});

for (const clipboard of ["absent", "rejected"]) {
  test(`the local copy fallback handles ${clipboard} async clipboard and restores selection/focus`, async (t) => {
    const { page, nativeCalls } = await fixture(t, { clipboard });
    const details = panel(page);
    await details.locator("summary").click();
    await selectTextByMouse(page, details.locator("li span").first());
    await details.locator(".copy-sync-details").focus();
    const selected = await page.evaluate(() => window.getSelection()?.toString());
    // Keyboard activation avoids the browser's ordinary pointer focus selection changes.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.fixtureFallbackWrites.length === 1);
    const fallback = await page.evaluate(() => window.fixtureFallbackWrites[0]);
    assert.ok(fallback.text.includes(failure));
    assert.equal(fallback.selected, true);
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected);
    assert.equal(await details.locator(".copy-sync-details").evaluate((node) => document.activeElement === node), true);
    assert.equal(await page.locator('body > textarea[aria-hidden="true"]').count(), 0);
    assert.equal(nativeCalls.includes("drag"), false);
  });
}

test("copy failure keeps the copy button usable and gives the keyboard alternative", async (t) => {
  const { page } = await fixture(t, { clipboard: "both-fail" });
  const details = panel(page);
  await details.locator("summary").click();
  await details.locator(".copy-sync-details").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Ctrl+C"));
  assert.equal(await details.locator(".copy-sync-details").isEnabled(), true);
  assert.equal(await page.locator('body > textarea[aria-hidden="true"]').count(), 0);
});

test("copy actions and confirmation are translated and work in an ordinary browser", async (t) => {
  const { page, nativeCalls } = await fixture(t, { host: false, language: "en" });
  const errors = panel(page), records = panel(page, "technical-records");
  await errors.locator("summary").click();
  assert.equal(await errors.locator(".copy-sync-details").innerText(), "Copy errors");
  await errors.locator(".copy-sync-details").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("currently displayed records"));
  await records.locator("summary").click();
  assert.equal(await records.locator(".copy-sync-details").innerText(), "Copy technical records");
  await records.locator(".copy-sync-details").click();
  assert.ok((await page.evaluate(() => window.fixtureClipboardWrites.at(-1))).includes(technical));
  assert.deepEqual(nativeCalls, []);
});

test("diagnostic copy controls retain the current light/dark styling and fit narrow windows", async (t) => {
  const directory = new URL("../test-artifacts/receipt-copy-ui/", import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const [theme, language, width, height] of [["dark", "zh", 1600, 1000], ["light", "en", 1600, 1000], ["dark", "zh", 390, 1000]]) {
    const { page } = await fixture(t, { theme, language, width, height });
    const details = panel(page);
    await details.locator("summary").click();
    await details.locator("ul").scrollIntoViewIfNeeded();
    const button = details.locator(".copy-sync-details");
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, "copy button fits the actual viewport");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await button.evaluate((node) => getComputedStyle(node).color), theme === "dark" ? "rgb(238, 243, 251)" : "rgb(23, 32, 51)");
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${language}-${width}.png`, directory)), fullPage: false });
  }
});
