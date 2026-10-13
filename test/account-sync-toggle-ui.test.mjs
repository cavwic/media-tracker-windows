import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { normalizePlatforms } from "../lib/archive.mjs";
import { chooseAppearance } from "./fixtures/appearance-controls.mjs";

// Headless local fixtures only: no real accounts, NAS paths, service restarts,
// media synchronization or external platform requests are used by this suite.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54391";
const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"]
  .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));

async function fixture(t, { host = true, language = "zh", theme = "dark", width = 1600, height = 1100, running = false,
  accountProgress, pausedAccounts = 0, jobStatus = "running", jobErrors = [], allPaused = false } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [], external = [], calls = [], nativeCalls = [];
  const originalPaused = { id: "paused", label: "temporarily-away", folderName: "old-name", profileUrl: "https://x.com/temporarily-away",
    linkedAccountId: "login", syncEnabled: false, followRequested: true, downloadMedia: { image: true, video: false, gif: true },
    discoveredFrom: "https://creator.example/", discoveryEvidence: "profile" };
  const model = { runtime: { label: "工具内置 Chromium", systemLanguage: "zh" }, settings: { language, theme },
    platforms: { x: { label: "X" }, instagram: { label: "Instagram" }, sample: { label: "Sample", custom: true, folderName: "Sample", engine: "none", homepageUrl: "https://sample.example/" } },
    linkedAccounts: [{ id: "login", platformId: "x", label: "local login", loginStatus: "verified" }],
    persons: [{ id: "person", name: "测试人物", note: "Local fixture only", folderPath: "D:\\Fixture\\Person", platforms: [
      { id: "x", label: "X", accounts: [{ id: "legacy", label: "creator", profileUrl: "https://x.com/creator", linkedAccountId: "login" }, originalPaused] },
      { id: "sample", label: "Sample", accounts: [{ id: "custom", label: "other", profileUrl: "https://sample.example/other", syncEnabled: false }] },
    ] }], syncSummaries: {} };
  if (running) model.syncSummaries.person = { id: "job", personId: "person", status: jobStatus, message: "Progress",
    counters: { accounts: accountProgress?.length || 1, accountsFinished: 0, pausedAccounts }, accountProgress, errors: jobErrors };
  if (allPaused) {
    model.persons[0].platforms[0].accounts[0].syncEnabled = false;
    model.syncSummaries.person = { id: "paused-job", personId: "person", status: "completed",
      message: "全部账号已暂停，本次未读取平台或修改增量节点。", counters: { accounts: 0, accountsFinished: 0, pausedAccounts: 3 }, accountProgress: [] };
  }
  if (host) {
    await page.exposeFunction("__mediaTrackerWindow", (action) => { nativeCalls.push(action); return { frameless: true, maximized: false, minimized: false }; });
    await page.addInitScript(() => { window.__mediaTrackerWindowState = { frameless: true, maximized: false, minimized: false }; });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.equal(calls.some((call) => /sync$|sync-all|open-login|verify|cache|dedup/.test(call.path) && call.method !== "GET"), false);
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    let payload;
    if (url.pathname.startsWith("/api/")) calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === "/api/state") payload = structuredClone(model);
    else if (url.pathname === "/api/runtime/status") payload = structuredClone(model.runtime);
    else if (url.pathname === "/api/settings") { Object.assign(model.settings, request.postDataJSON()); payload = { settings: model.settings }; }
    else if (url.pathname === "/api/sync-jobs/job") payload = structuredClone(model.syncSummaries.person);
    else if (url.pathname === "/api/persons/person" && request.method() === "PUT") {
      const input = request.postDataJSON();
      model.persons[0] = { ...model.persons[0], name: input.name, note: input.note, homepageUrl: input.homepageUrl,
        platforms: normalizePlatforms(input.platforms, model.platforms) };
      payload = { person: structuredClone(model.persons[0]) };
    } else if (url.pathname === "/api/persons" && request.method() === "POST") {
      const input = request.postDataJSON();
      const person = { id: "new-person", name: input.name, folderPath: input.selectedPath, platforms: normalizePlatforms(input.platforms, model.platforms) };
      model.persons.push(person); payload = { person };
    } else if (url.pathname === "/api/homepages/analyze") payload = { sourceUrl: "https://creator.example/", finalUrl: "https://creator.example/", title: "Creator", scannedAt: "2026-10-12T00:00:00Z", candidates: [
      { id: "existing-candidate", platformId: "x", platformLabel: "X", label: "temporarily-away", profileUrl: "https://x.com/temporarily-away", evidence: "direct link" },
      { id: "new-candidate", platformId: "instagram", platformLabel: "Instagram", label: "new-creator", profileUrl: "https://www.instagram.com/new-creator/", evidence: "direct link" },
    ] };
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator('.person-card[data-person-id="person"]').waitFor();
  await page.waitForFunction(({ theme, language }) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.language === language, { theme, language });
  return { page, model, calls, nativeCalls, originalPaused: structuredClone(originalPaused) };
}

const row = (page, id) => page.locator(`.account-row[data-account-id="${id}"]`);
const checkbox = (page, id) => row(page, id).locator('input[data-field="syncEnabled"]');
const saveCalls = (calls) => calls.filter((call) => /^\/api\/persons(?:\/person)?$/.test(call.path) && call.method !== "GET");

test("legacy targets are enabled and paused targets are visible without changing account data", async (t) => {
  const { page, calls } = await fixture(t);
  assert.match(await page.locator(".platform-tags").textContent(), /X · 2.*1 个已暂停.*Sample · 1.*1 个已暂停/);
  await page.locator(".edit-person").click();
  assert.equal(await checkbox(page, "legacy").isChecked(), true);
  assert.equal(await checkbox(page, "paused").isChecked(), false);
  assert.equal(await checkbox(page, "custom").isChecked(), false);
  assert.equal(await row(page, "paused").getAttribute("data-sync-state"), "paused");
  assert.equal(await row(page, "paused").locator(".account-sync-status").textContent(), "已暂停");
  assert.match(await page.locator(".account-sync-hint").textContent(), /登录绑定.*历史来源.*增量节点/);
  await page.locator("#close-dialog-button").click();
  assert.equal(saveCalls(calls).length, 0);
});

test("pause/resume survives row additions, live theme/language changes and saved edit roundtrips", async (t) => {
  const { page, model, calls, nativeCalls, originalPaused } = await fixture(t);
  await page.locator(".edit-person").click();
  await checkbox(page, "legacy").uncheck();
  const xPanel = page.locator('.platform-panel[data-platform-id="x"]');
  await xPanel.locator(".add-account-button").click();
  const added = xPanel.locator(".account-row").last();
  assert.equal(await added.locator('[data-field="syncEnabled"]').isChecked(), true);
  await added.locator('[data-field="label"]').fill("later");
  await chooseAppearance(page, "language", "en");
  await chooseAppearance(page, "theme", "light");
  assert.equal(await checkbox(page, "legacy").isChecked(), false);
  assert.equal(await row(page, "legacy").locator(".account-sync-status").textContent(), "Paused");
  assert.equal(await added.locator('[data-field="label"]').inputValue(), "later");
  assert.equal(await row(page, "paused").locator('[data-field="linkedAccountId"]').inputValue(), "login");
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  const saved = saveCalls(calls).at(-1).body.platforms;
  assert.equal(saved[0].accounts[0].syncEnabled, false);
  assert.equal(saved[0].accounts.at(-1).syncEnabled, true);
  assert.deepEqual(model.persons[0].platforms[0].accounts[1], originalPaused);
  await page.locator(".edit-person").click();
  await checkbox(page, "paused").focus();
  await page.keyboard.press("Space");
  assert.equal(await checkbox(page, "paused").isChecked(), true);
  assert.equal(await row(page, "paused").locator(".account-sync-status").textContent(), "Sync enabled");
  assert.equal(nativeCalls.includes("drag"), false);
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(model.persons[0].platforms[0].accounts[1], { ...originalPaused, syncEnabled: true });
});

test("rediscovering a paused account keeps it paused while newly discovered accounts default to enabled", async (t) => {
  const { page, model } = await fixture(t);
  await page.locator(".edit-person").click();
  await page.locator("#homepage-url").fill("https://creator.example/");
  await page.locator("#analyze-homepage-button").click();
  await page.locator(".apply-candidates").click();
  assert.equal(await checkbox(page, "paused").isChecked(), false);
  assert.equal(await page.locator('.platform-panel[data-platform-id="instagram"] [data-field="syncEnabled"]').isChecked(), true);
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  assert.equal(model.persons[0].platforms[0].accounts.find((account) => account.id === "paused").syncEnabled, false);
  assert.equal(model.persons[0].platforms.find((platform) => platform.id === "instagram").accounts[0].syncEnabled, true);
});

test("new-person accounts default enabled and saving preserves explicit pause", async (t) => {
  const { page, calls } = await fixture(t, { host: false });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("New person");
  await page.locator("#selected-path").fill("D:\\Fixture");
  await page.locator("#platform-to-add").selectOption("x");
  await page.locator("#add-platform-button").click();
  const target = page.locator(".account-row");
  await target.locator('[data-field="label"]').fill("new-account");
  assert.equal(await target.locator('[data-field="syncEnabled"]').isChecked(), true);
  await target.locator('[data-field="syncEnabled"]').uncheck();
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  assert.equal(saveCalls(calls).at(-1).body.platforms[0].accounts[0].syncEnabled, false);
  // Closing the draft precedes the asynchronous state refresh/card rendering.
  await page.locator('.person-card[data-person-id="new-person"]').waitFor({ state: "visible" });
  assert.equal(await page.locator('.person-card[data-person-id="new-person"]').count(), 1);
});

test("polling active syncs does not discard an unsaved pause choice", async (t) => {
  const { page } = await fixture(t, { running: true });
  await page.locator(".edit-person").click();
  await checkbox(page, "legacy").uncheck();
  await page.locator("#person-note").fill("Unsaved local draft");
  await page.waitForTimeout(1400);
  assert.equal(await checkbox(page, "legacy").isChecked(), false);
  assert.equal(await page.locator("#person-note").inputValue(), "Unsaved local draft");
});

test("nested custom-platform settings preserve account sync policy and unsaved identity fields", async (t) => {
  const { page, calls, nativeCalls } = await fixture(t);
  await page.locator(".edit-person").click();
  await checkbox(page, "legacy").uncheck();
  await row(page, "legacy").locator('[data-field="label"]').fill("Unsaved creator");
  await page.locator('.platform-panel[data-platform-id="sample"] .edit-custom-platform').click();
  await page.locator("#platform-dialog").waitFor({ state: "visible" });
  await page.locator("#custom-platform-label").fill("Unsaved platform");
  await chooseAppearance(page, "language", "en");
  await page.locator("#cancel-platform-dialog").click();
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await checkbox(page, "legacy").isChecked(), false);
  assert.equal(await checkbox(page, "custom").isChecked(), false);
  assert.equal(await row(page, "legacy").locator('[data-field="label"]').inputValue(), "Unsaved creator");
  assert.equal(saveCalls(calls).length, 0);
  assert.equal(nativeCalls.includes("drag"), false);
});

test("account-level scheduler counts update in place without replacing an expanded error list", async (t) => {
  const { page, model } = await fixture(t, { running: true, pausedAccounts: 2,
    accountProgress: [{ platform: "X", account: "creator", status: "running", phase: "downloading" },
      { platform: "Instagram", account: "other", status: "queued", phase: "queued" }],
    jobErrors: [{ platform: "X", account: "creator", message: "Displayed fixture error" }] });
  const progress = page.locator(".sync-account-progress");
  assert.equal(await progress.textContent(), "1 个账号运行 · 1 个账号等待 · 2 个账号已暂停");
  assert.match(await page.locator("#sync-all-status").textContent(), /账号级并行 · 共用登录会话自动排队/);
  const details = page.locator(".sync-operational-errors");
  await details.locator("summary").click();
  await details.locator("ul").evaluate((node) => { window.fixtureProgressErrorList = node; });
  await progress.evaluate((node) => { window.fixtureAccountProgress = node; });
  model.syncSummaries.person.accountProgress[1].status = "running";
  model.syncSummaries.person.accountProgress[1].phase = "discovering";
  model.syncSummaries.person.errors.push({ platform: "Instagram", account: "other", message: "Hidden later fixture error" });
  await page.waitForFunction(() => document.querySelector(".sync-account-progress").textContent.startsWith("2 个账号运行 · 0 个账号等待"));
  assert.equal(await progress.evaluate((node) => window.fixtureAccountProgress === node), true);
  assert.equal(await details.locator("ul").evaluate((node) => window.fixtureProgressErrorList === node), true);
  assert.equal(await details.locator("ul").textContent(), "X · creator · 失败Displayed fixture error");
});

test("preparing an account queue does not publish misleading zero-account activity", async (t) => {
  const { page } = await fixture(t, { running: true, accountProgress: [] });
  assert.equal(await page.locator(".sync-account-progress").isVisible(), false);
  assert.equal(await page.locator(".sync-account-progress").textContent(), "");
  assert.equal(await page.locator(".sync-receipt .sync-status").textContent(), "正在同步");
});

test("fully paused completion is accurately explained in both languages without claiming a platform read", async (t) => {
  for (const language of ["zh", "en"]) {
    const { page } = await fixture(t, { allPaused: true, language });
    assert.equal(await page.locator(".sync-receipt > p").first().textContent(), language === "zh"
      ? "全部账号已暂停，本次未读取平台或修改增量节点。"
      : "All accounts are paused. No platform was read or incremental checkpoint changed in this run.");
    assert.equal(await page.locator(".sync-account-progress").textContent(), language === "zh" ? "3 个账号已暂停" : "3 accounts paused");
    assert.equal(await page.locator(".sync-account-progress").isVisible(), true);
  }
});

test("sync policy controls follow both themes/languages and stay inside narrow dialogs", async (t) => {
  const directory = new URL("../test-artifacts/account-sync-toggle/", import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const [theme, language, width] of [["dark", "zh", 1600], ["light", "en", 1600], ["dark", "en", 390]]) {
    const { page, nativeCalls } = await fixture(t, { theme, language, width, height: 1100, running: true, pausedAccounts: 2,
      accountProgress: [{ platform: "X", account: "creator", status: "running", phase: "downloading" },
        { platform: "Instagram", account: "other", status: "queued", phase: "queued" }] });
    assert.equal(await page.locator(".sync-account-progress").isVisible(), true);
    assert.equal(await page.locator(".sync-account-progress").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator(".sync-account-progress").evaluate((node) => getComputedStyle(node).color), theme === "dark" ? "rgb(167, 178, 196)" : "rgb(101, 112, 133)");
    await page.screenshot({ path: fileURLToPath(new URL(`progress-${theme}-${language}-${width}.png`, directory)), fullPage: true });
    await page.locator(".edit-person").click();
    await checkbox(page, "legacy").uncheck();
    await row(page, "legacy").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#person-dialog").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await row(page, "legacy").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await row(page, "legacy").locator(".account-sync-status").textContent(), language === "zh" ? "已暂停" : "Paused");
    assert.equal(nativeCalls.includes("drag"), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${language}-${width}.png`, directory)), fullPage: true });
  }
});
