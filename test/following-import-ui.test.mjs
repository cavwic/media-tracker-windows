import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { normalizePlatforms } from "../lib/archive.mjs";
import { chooseAppearance } from "./fixtures/appearance-controls.mjs";

// The UI fixture intercepts every request. No real logins, platforms or media are used.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54532";
const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"]
  .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
const followed = (platformId, handle, label = handle) => ({ platformId, handle, label,
  profileUrl: platformId === "x" ? `https://x.com/${handle}` : `https://www.instagram.com/${handle}/` });

async function fixture(t, { host = true, theme = "dark", language = "zh", width = 1600, jobs = {}, running = false, noBindings = false, customFollowingUrl = "" } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 1100 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const calls = [], external = [], errors = [], nativeCalls = [], jobModel = new Map();
  const paused = { id: "paused", label: "old-display", profileUrl: "https://twitter.com/paused", linkedAccountId: "login-x-2",
    syncEnabled: false, downloadMedia: { image: false, video: true, gif: false }, followRequested: true, folderName: "preserve-name" };
  const model = { runtime: { label: "工具内置 Chromium", systemLanguage: "zh" }, settings: { theme, language },
    importFollowingSupportedPlatformIds: ["x", "instagram", "facebook", "threads", "tiktok"],
    platforms: { x: { label: "X" }, instagram: { label: "Instagram" }, sample: { id: "sample", label: "Sample", custom: true,
      homepageUrl: "https://sample.example/", loginUrl: "https://sample.example/login", engine: "auto", followingUrl: customFollowingUrl } },
    linkedAccounts: noBindings ? [] : [
      { id: "login-x", platformId: "x", label: "My first X", loginStatus: "verified" },
      { id: "login-x-2", platformId: "x", label: "My second X", loginStatus: "verified" },
      { id: "login-ig", platformId: "instagram", label: "My Instagram", loginStatus: "verified" },
      { id: "login-custom", platformId: "sample", label: "My custom platform", loginStatus: "verified" },
    ], persons: [{ id: "person", name: "Existing person", note: "Fixture only", folderPath: "D:\\Fixture\\Person",
      platforms: [{ id: "x", label: "X", accounts: [paused] }] }], syncSummaries: {} };
  if (running) model.syncSummaries.person = { id: "sync", personId: "person", status: "running", counters: { accounts: 1 }, errors: [] };
  if (customFollowingUrl) model.importFollowingSupportedPlatformIds.push("sample");
  if (host) {
    await page.exposeFunction("__mediaTrackerWindow", (action) => { nativeCalls.push(action); return { frameless: true, maximized: false }; });
    await page.addInitScript(() => { window.__mediaTrackerWindowState = { frameless: true, maximized: false }; });
  }
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const call of calls) assert.equal(call.token, "a".repeat(64), `public API token: ${call.path}`);
    assert.equal(nativeCalls.includes("drag"), false);
    assert.equal(calls.some(call => /sync$|sync-all|open-login|verify|cache|dedup/.test(call.path) && call.method !== "GET"), false);
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname === "/api/session") return route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ applicationId: "media-tracker-public", token: "a".repeat(64) }) });
    const body = request.postDataJSON();
    if (url.pathname.startsWith("/api/")) calls.push({ path: url.pathname, method: request.method(), body,
      token: (await request.allHeaders())["x-media-tracker-token"] });
    let payload;
    if (url.pathname === "/api/state") payload = structuredClone(model);
    else if (url.pathname === "/api/runtime/status") payload = structuredClone(model.runtime);
    else if (url.pathname === "/api/settings") { Object.assign(model.settings, body); payload = { settings: model.settings }; }
    else if (url.pathname === "/api/sync-jobs/sync") payload = structuredClone(model.syncSummaries.person);
    else if (url.pathname === "/api/platforms" || url.pathname === "/api/platforms/sample") {
      const id = url.pathname === "/api/platforms" ? "created" : "sample";
      const platform = { ...model.platforms[id], id, custom: true, ...body };
      model.platforms[id] = platform;
      model.importFollowingSupportedPlatformIds = ["x", "instagram", "facebook", "threads", "tiktok",
        ...Object.values(model.platforms).filter(item => item.custom && item.followingUrl).map(item => item.id)];
      payload = { platform, platforms: model.platforms, linkedAccounts: model.linkedAccounts,
        importFollowingSupportedPlatformIds: model.importFollowingSupportedPlatformIds };
    }
    else if (url.pathname === "/api/following-imports") {
      const configured = jobs[body.linkedAccountId] || {};
      if (configured.startError) return route.fulfill({ status: configured.startStatus || 409, contentType: "application/json", body: JSON.stringify({ error: configured.startError }) });
      if (configured.startGate) await configured.startGate;
      const job = { id: `read-${body.linkedAccountId}`, linkedAccountId: body.linkedAccountId,
        platformId: model.linkedAccounts.find(a => a.id === body.linkedAccountId).platformId,
        status: "completed", completeness: "complete", emptyConfirmed: false, accounts: [], message: "Fixture following list", ...configured };
      delete job.startGate;
      jobModel.set(job.id, job);
      payload = { job: structuredClone(job) };
    } else if (url.pathname.startsWith("/api/following-imports/")) {
      const job = jobModel.get(decodeURIComponent(url.pathname.split("/").at(-1)));
      if (job.getError && request.method() === "GET") return route.fulfill({ status: job.getError.status, contentType: "application/json", body: JSON.stringify({ error: job.getError.message }) });
      if (request.method() === "DELETE") { job.status = "cancelled"; job.completeness = "partial"; job.message = "已停止读取；已显示的候选仍可导入，人物及登录资料未修改。"; }
      payload = { job: structuredClone(job) };
    } else if (/^\/api\/persons(?:\/person)?$/.test(url.pathname) && request.method() !== "GET") {
      const person = { ...model.persons[0], id: url.pathname === "/api/persons" ? "new-person" : "person", name: body.name, note: body.note,
        platforms: normalizePlatforms(body.platforms, model.platforms), folderPath: body.selectedPath };
      if (url.pathname === "/api/persons") model.persons.push(person); else model.persons[0] = person;
      payload = { person };
    } else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator(".person-card").first().waitFor();
  return { page, calls, jobModel, model, paused: structuredClone(paused) };
}

const saveCalls = calls => calls.filter(call => /^\/api\/persons(?:\/person)?$/.test(call.path) && call.method !== "GET");
async function openImport(page, edit = false) {
  await page.locator(edit ? ".edit-person" : "#create-person-button").click();
  await page.locator("#import-following-button").click();
  await page.locator("#following-import-dialog").waitFor({ state: "visible" });
}
async function readSource(page, source) {
  await page.locator("#following-import-source").selectOption(source);
  await page.locator("#read-following-import").click();
  await page.waitForFunction(() => !document.querySelector("#read-following-import").disabled);
}

test("multiple own accounts and platforms import into the current draft, not separate people", async t => {
  const { page, calls, model } = await fixture(t, { jobs: {
    "login-x": { accounts: [followed("x", "creator", "Creator Name")] },
    "login-x-2": { accounts: [followed("x", "CREATOR", "Same Creator"), followed("x", "other")] },
    "login-ig": { accounts: [followed("instagram", "creator.ig", "Creator Name")] },
  } });
  await openImport(page);
  await readSource(page, "login-x");
  await page.locator("#select-following-visible").click();
  await readSource(page, "login-x-2");
  assert.equal(await page.locator(".following-import-item").count(), 2);
  await readSource(page, "login-ig");
  await page.locator("#following-import-search").fill("creator");
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  assert.equal(saveCalls(calls).length, 0);
  assert.equal(model.persons.length, 1);
  assert.equal(await page.locator('.platform-panel[data-platform-id="x"] .account-row').count(), 1);
  assert.equal(await page.locator('.platform-panel[data-platform-id="instagram"] .account-row').count(), 1);
  assert.equal(await page.locator("#person-name").inputValue(), "");
  await page.locator("#person-name").fill("Current creator");
  await page.locator("#selected-path").fill("D:\\Fixture");
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  const platforms = saveCalls(calls).at(-1).body.platforms;
  assert.deepEqual(platforms.map(p => [p.id, p.accounts.length]), [["x", 1], ["instagram", 1]]);
  assert.equal(platforms[0].accounts[0].label, "creator");
  assert.equal(platforms[0].accounts[0].linkedAccountId, "login-x");
  assert.equal(platforms[1].accounts[0].linkedAccountId, "login-ig");
  assert.equal(platforms[1].accounts[0].syncEnabled, true);
});

test("a single selected profile offers its display name without changing its target handle", async t => {
  const { page } = await fixture(t, { jobs: { "login-x": { accounts: [followed("x", "creator", "Display Name")] } } });
  await openImport(page);
  await readSource(page, "login-x");
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  assert.equal(await page.locator("#person-name").inputValue(), "Display Name");
  assert.equal(await page.locator('.account-row [data-field="label"]').inputValue(), "creator");
});

test("reimport never silently resumes or changes the binding and policy of an existing paused profile", async t => {
  const { page, calls, paused } = await fixture(t, { jobs: { "login-x": { accounts: [followed("x", "PAUSED", "Different Display")] } } });
  await openImport(page, true);
  await readSource(page, "login-x");
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(saveCalls(calls).at(-1).body.platforms[0].accounts, [paused]);
});

test("polling appends rows in place, retains selected controls and stops without discarding partial results", async t => {
  const { page, jobModel, calls } = await fixture(t, { running: true, jobs: { "login-x": {
    status: "running", completeness: "partial", accounts: [followed("x", "first")],
  } } });
  await openImport(page, true);
  await page.locator("#read-following-import").click();
  const input = page.locator(".following-import-item input").first();
  await input.waitFor();
  await input.check();
  await input.evaluate(node => { window.fixtureFollowingCheckbox = node; });
  jobModel.get("read-login-x").accounts.push(followed("x", "second"));
  await page.waitForFunction(() => document.querySelectorAll(".following-import-item").length === 2);
  assert.equal(await input.evaluate(node => node === window.fixtureFollowingCheckbox), true);
  assert.equal(await input.isChecked(), true);
  await page.locator("#person-note").evaluate(node => { node.value = "retained draft"; });
  await page.locator("#stop-following-import").click();
  await page.locator("#stop-following-import").waitFor({ state: "hidden" });
  assert.match(await page.locator("#following-import-status").textContent(), /部分关注账号/);
  assert.equal(await input.isChecked(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await page.locator("#person-note").inputValue(), "retained draft");
  await page.locator("#import-following-button").click();
  assert.equal(await page.locator(".following-import-item input").first().isChecked(), true);
  await page.locator("#clear-following-selection").click();
  assert.equal(await page.locator("#apply-following-import").isDisabled(), true);
  assert.equal(saveCalls(calls).length, 0);
});

test("a failed empty following read never claims that partial accounts were already returned", async t => {
  const message = "平台尚未提供可确认的当前账号主页入口，请稍后重试；没有使用绑定名称猜测账号。只有平台要求登录时才需要重新验证登录。";
  const { page } = await fixture(t, { jobs: { "login-x": { status: "failed", completeness: "partial", discovered: 0,
    accounts: [], error: message, message } } });
  await openImport(page);
  await readSource(page, "login-x");
  assert.equal(await page.locator("#following-import-status").textContent(), message);
  assert.equal(await page.locator(".following-import-item").count(), 0);
  await chooseAppearance(page, "language", "en");
  const english = await page.locator("#following-import-status").textContent();
  assert.match(english, /profile entry for the current account/);
  assert.doesNotMatch(english, /some currently accessible followed accounts|[\u4e00-\u9fff]/);
});

test("confirmed zero following lists explain the result in both languages without changing an unsaved draft", async t => {
  const message = "当前登录账号的关注列表为空（平台已确认），可手动添加目标账号。";
  const { page, calls } = await fixture(t, { jobs: { "login-ig": {
    accounts: [], discovered: 0, emptyConfirmed: true, message,
  } } });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("Keep my draft");
  await page.locator("#person-note").fill("Keep this note");
  await page.locator("#import-following-button").click();
  await readSource(page, "login-ig");
  assert.equal(await page.locator("#following-import-status").textContent(), message);
  assert.equal(await page.locator(".following-import-empty").textContent(), message);
  assert.equal(await page.locator("#following-import-status").evaluate(node => node.classList.contains("is-error")), false);
  assert.equal(await page.locator("#apply-following-import").isDisabled(), true);
  await chooseAppearance(page, "language", "en");
  assert.match(await page.locator(".following-import-empty").textContent(), /following list is empty \(confirmed by the platform\).*manually/);
  assert.doesNotMatch(await page.locator("#following-import-status").textContent(), /[\u4e00-\u9fff]/);
  await page.locator("#cancel-following-import").click();
  assert.equal(await page.locator("#person-name").inputValue(), "Keep my draft");
  assert.equal(await page.locator("#person-note").inputValue(), "Keep this note");
  assert.equal(saveCalls(calls).length, 0);
});

test("legacy completed zero parses are presented as unavailable instead of an empty or complete list", async t => {
  for (const completeness of ["complete", "partial"]) {
    const { page, calls } = await fixture(t, { jobs: { "login-x": {
      accounts: [], discovered: 0, completeness, message: "已读取平台返回的完整关注列表。勾选账号后只会加入当前人物草稿，不会自动同步。",
    } } });
    await openImport(page);
    await readSource(page, "login-x");
    assert.match(await page.locator("#following-import-status").textContent(), /平台未提供可读取的已关注列表/);
    assert.equal(await page.locator("#following-import-status").evaluate(node => node.classList.contains("is-error")), true);
    assert.match(await page.locator(".following-import-empty").textContent(), /尚未读取到可选择的账号.*重新读取.*手动添加/);
    assert.doesNotMatch(await page.locator("#following-import-status").textContent(), /列表为空|完整关注列表/);
    await chooseAppearance(page, "language", "en");
    assert.match(await page.locator(".following-import-empty").textContent(), /No selectable accounts were read/);
    assert.doesNotMatch(await page.locator("#following-import-status").textContent(), /[\u4e00-\u9fff]/);
    assert.equal(saveCalls(calls).length, 0);
  }
});

test("an active zero-row read says waiting rather than zero following, and cancellation remains retryable", async t => {
  const { page, calls } = await fixture(t, { jobs: { "login-x": {
    status: "running", accounts: [], discovered: 0, completeness: "partial", emptyConfirmed: true,
  } } });
  await openImport(page);
  await page.locator("#read-following-import").click();
  await page.waitForFunction(() => document.querySelector(".following-import-empty")?.textContent.includes("正在读取关注列表"));
  assert.doesNotMatch(await page.locator(".following-import-empty").textContent(), /列表为空|平台已确认/);
  await page.locator("#stop-following-import").click();
  await page.locator("#stop-following-import").waitFor({ state: "hidden" });
  assert.match(await page.locator(".following-import-empty").textContent(), /读取已停止.*重新读取或手动添加/);
  assert.equal(await page.locator("#read-following-import").isDisabled(), false);
  await chooseAppearance(page, "language", "en");
  assert.match(await page.locator(".following-import-empty").textContent(), /Reading stopped.*Read again/);
  assert.equal(saveCalls(calls).length, 0);
});

test("a zero list from another binding keeps previously selected candidates and their controls", async t => {
  const { page, calls } = await fixture(t, { jobs: {
    "login-x": { accounts: [followed("x", "retained")] },
    "login-ig": { accounts: [], discovered: 0, emptyConfirmed: true },
  } });
  await openImport(page);
  await readSource(page, "login-x");
  const input = page.locator(".following-import-item input").first();
  await input.check();
  await input.evaluate(node => { window.fixtureSelectedBeforeEmpty = node; });
  await readSource(page, "login-ig");
  assert.equal(await input.evaluate(node => node === window.fixtureSelectedBeforeEmpty), true);
  assert.equal(await input.isChecked(), true);
  assert.equal(await page.locator(".following-import-item").count(), 1);
  assert.match(await page.locator("#following-import-status").textContent(), /当前登录账号.*平台已确认/);
  assert.equal(await page.locator("#apply-following-import").isDisabled(), false);
  assert.equal(saveCalls(calls).length, 0);
});

test("an inconsistent zero counter never overrides actual returned candidate rows with an empty-list claim", async t => {
  const { page } = await fixture(t, { jobs: { "login-x": {
    accounts: [followed("x", "still_visible")], discovered: 0, emptyConfirmed: true,
  } } });
  await openImport(page);
  await readSource(page, "login-x");
  assert.equal(await page.locator(".following-import-item").count(), 1);
  assert.doesNotMatch(await page.locator("#following-import-status").textContent(), /列表为空|平台已确认/);
});

test("closing while a read start is pending cancels the eventual job instead of leaking work or modifying a draft", async t => {
  let resolveGate;
  const startGate = new Promise(resolve => { resolveGate = resolve; });
  const { page, calls } = await fixture(t, { jobs: { "login-x": { startGate, status: "running", accounts: [followed("x", "first")] } } });
  await openImport(page);
  await page.locator("#read-following-import").click();
  await page.locator("#close-following-import").click();
  await page.locator("#import-following-button").click();
  resolveGate();
  await page.waitForFunction(() => !document.querySelector("#read-following-import").disabled);
  assert.equal(calls.some(call => call.path === "/api/following-imports/read-login-x" && call.method === "DELETE"), true);
  assert.equal(await page.locator(".following-import-item").count(), 0);
  assert.equal(saveCalls(calls).length, 0);
});

test("search and paging limit visible controls and select only the current page", async t => {
  const { page } = await fixture(t, { jobs: { "login-x": { accounts: Array.from({ length: 90 }, (_, i) => followed("x", `target${i}`)) } } });
  await openImport(page);
  await readSource(page, "login-x");
  assert.equal(await page.locator(".following-import-item").count(), 75);
  await page.locator("#select-following-visible").click();
  assert.equal(await page.locator("#following-import-selected").textContent(), "已选择 75 个账号");
  await page.locator("#next-following-page").click();
  assert.equal(await page.locator(".following-import-item").count(), 15);
  await page.locator("#following-import-search").fill("target89");
  await page.locator("#select-following-visible").click();
  assert.equal(await page.locator("#following-import-selected").textContent(), "已选择 76 个账号");
});

test("expired reading jobs release the source controls, keep selections and can be restarted", async t => {
  const { page, jobModel } = await fixture(t, { jobs: { "login-x": { status: "running", accounts: [followed("x", "retained")] } } });
  await openImport(page);
  await page.locator("#read-following-import").click();
  await page.locator(".following-import-item input").waitFor();
  await page.locator("#select-following-visible").click();
  jobModel.get("read-login-x").getError = { status: 404, message: "已关注读取结果已关闭或过期，请重新读取。" };
  await page.waitForFunction(() => !document.querySelector("#read-following-import").disabled);
  assert.equal(await page.locator(".following-import-item input").isChecked(), true);
  assert.equal(await page.locator("#following-import-source").isDisabled(), false);
  assert.match(await page.locator("#following-import-status").textContent(), /过期/);
  await page.locator("#read-following-import").click();
  await page.waitForFunction(() => !document.querySelector("#following-import-status").textContent.includes("过期"));
});

test("display names are opaque text, not HTML or account labels, and stay intact when language changes", async t => {
  const displayName = '<img src="https://unsafe.example/image.png" onerror="alert(1)">中文名字';
  const { page } = await fixture(t, { jobs: { "login-x": { accounts: [{ ...followed("x", "handle", "handle"), displayName }] } } });
  await openImport(page);
  await readSource(page, "login-x");
  assert.equal(await page.locator(".following-import-identity strong").textContent(), displayName);
  assert.equal(await page.locator("#following-import-list img").count(), 0);
  await chooseAppearance(page, "language", "en");
  assert.equal(await page.locator(".following-import-identity strong").textContent(), displayName);
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  assert.equal(await page.locator("#person-name").inputValue(), displayName);
  assert.equal(await page.locator('.account-row [data-field="label"]').inputValue(), "handle");
});

test("a refreshed removed source binding blocks the entire draft import instead of saving stale login IDs", async t => {
  const { page, model, calls } = await fixture(t, { jobs: { "login-x": { accounts: [followed("x", "creator")] } } });
  await openImport(page);
  await readSource(page, "login-x");
  await page.locator("#select-following-visible").click();
  model.linkedAccounts = model.linkedAccounts.filter(account => account.id !== "login-x");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => document.querySelectorAll(".linked-card").length === 3);
  await page.locator("#apply-following-import").click();
  assert.equal(await page.locator("#following-import-dialog").isVisible(), true);
  assert.match(await page.locator("#following-import-status").textContent(), /登录绑定已移除/);
  assert.equal(await page.locator(".account-row").count(), 0);
  assert.equal(saveCalls(calls).length, 0);
  assert.equal(await page.locator(".following-import-item input").isChecked(), true);
});

test("unsupported platforms, missing bindings and login failures provide direction without new login windows", async t => {
  const { page, calls } = await fixture(t, { host: false, jobs: { "login-x": {
    startError: "请先在“我的账号”验证这个账号登录成功，再读取已关注列表；无需重新绑定。",
  } } });
  await openImport(page);
  await page.locator("#read-following-import").click();
  await page.waitForFunction(() => document.querySelector("#following-import-status").textContent.includes("无需重新绑定"));
  await page.locator("#following-import-source").selectOption("login-custom");
  assert.equal(await page.locator("#read-following-import").isDisabled(), true);
  assert.match(await page.locator("#following-import-status").textContent(), /平台设置中添加.*关注页.*手动添加/);
  assert.equal(calls.filter(call => call.path === "/api/following-imports").length, 1);
  const empty = await fixture(t, { noBindings: true, host: false });
  await openImport(empty.page);
  assert.equal(await empty.page.locator("#read-following-import").isDisabled(), true);
  assert.match(await empty.page.locator("#following-import-status").textContent(), /添加登录绑定/);
});

test("old running services explain restart instead of implying the linked login failed", async t => {
  const { page } = await fixture(t, { language: "en", jobs: { "login-x": { startStatus: 404, startError: "接口不存在" } } });
  await openImport(page);
  await page.locator("#read-following-import").click();
  await page.waitForFunction(() => document.querySelector("#following-import-status").textContent.includes("Fully exit"));
  assert.equal(await page.locator("#read-following-import").isDisabled(), false);
  assert.equal(await page.locator("#following-import-source").isDisabled(), false);
});

test("custom platform creation saves an optional following page without changing the login URL or person draft", async t => {
  const { page, calls } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("My unsaved person");
  await page.locator("#person-note").fill("Keep this note");
  await page.locator("#selected-path").fill("D:\\Unsaved");
  await page.locator("#create-person-platform-button").click();
  await page.locator("#custom-platform-label").fill("Local sample");
  await page.locator("#custom-platform-homepage").fill("https://custom.example/");
  await page.locator("#custom-platform-login").fill("https://custom.example/login");
  await page.locator("#custom-platform-following").fill("https://custom.example/me/following");
  await chooseAppearance(page, "language", "en");
  assert.equal(await page.locator("#custom-platform-following").inputValue(), "https://custom.example/me/following");
  assert.equal(await page.locator("#custom-platform-following").evaluate(node => node.closest("label").querySelector("span").textContent), "Following page (optional)");
  assert.equal(await page.locator("#custom-platform-following").getAttribute("required"), null);
  assert.equal(await page.locator("#platform-dialog").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(21, 30, 45)");
  await page.locator("#save-platform-button").click();
  await page.locator("#platform-dialog").waitFor({ state: "hidden" });
  const body = calls.find(call => call.path === "/api/platforms" && call.method === "POST").body;
  assert.equal(body.followingUrl, "https://custom.example/me/following");
  assert.equal(body.loginUrl, "https://custom.example/login");
  assert.equal(await page.locator("#person-name").inputValue(), "My unsaved person");
  assert.equal(await page.locator("#person-note").inputValue(), "Keep this note");
  assert.equal(await page.locator("#selected-path").inputValue(), "D:\\Unsaved");
  assert.equal(saveCalls(calls).length, 0);
});

test("legacy custom settings default to an empty following page and do not block manual target creation", async t => {
  const { page, calls } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#platform-to-add").selectOption("sample");
  assert.equal(await page.locator("#person-following-page-hint").isVisible(), true);
  assert.match(await page.locator("#person-following-page-hint").textContent(), /平台设置中添加.*关注页.*仍可手动添加/);
  await page.locator("#person-following-platform-settings").click();
  assert.equal(await page.locator("#custom-platform-following").inputValue(), "");
  await page.locator("#cancel-platform-dialog").click();
  await page.locator("#add-platform-button").click();
  await page.locator('.account-row [data-field="label"]').fill("Manual target");
  await page.locator('.account-row [data-field="profileUrl"]').fill("https://sample.example/users/Manual");
  await page.locator("#person-name").fill("Manual person");
  await page.locator("#selected-path").fill("D:\\Manual");
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  assert.equal(saveCalls(calls).at(-1).body.platforms[0].id, "sample");
  assert.equal(calls.some(call => call.path === "/api/following-imports"), false);
});

test("missing custom following pages offer platform settings inside the import dialog and enable reading after save", async t => {
  const target = { platformId: "sample", handle: "https://sample.example/users/Creator", label: "Creator", displayName: "Creator",
    profileUrl: "https://sample.example/users/Creator" };
  const { page, calls } = await fixture(t, { jobs: { "login-custom": { accounts: [target] } } });
  await openImport(page);
  await page.locator("#following-import-source").selectOption("login-custom");
  assert.equal(await page.locator("#read-following-import").isDisabled(), true);
  assert.match(await page.locator("#following-import-status").textContent(), /平台设置中添加.*关注页/);
  await page.locator("#following-import-platform-settings").click();
  assert.equal(await page.locator("#custom-platform-login").inputValue(), "https://sample.example/login");
  await page.locator("#custom-platform-following").fill("https://sample.example/me/following");
  await page.locator("#save-platform-button").click();
  await page.locator("#platform-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#following-import-dialog").isVisible(), true);
  assert.equal(await page.locator("#read-following-import").isDisabled(), false);
  assert.equal(await page.locator("#following-import-platform-settings").evaluate(node => node === document.activeElement), true);
  await page.locator("#read-following-import").click();
  await page.locator(".following-import-item").waitFor();
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  assert.equal(await page.locator('.platform-panel[data-platform-id="sample"] [data-field="profileUrl"]').inputValue(), target.profileUrl);
  assert.equal(await page.locator('.platform-panel[data-platform-id="sample"] [data-field="label"]').inputValue(), target.label);
  assert.equal(await page.locator('.platform-panel[data-platform-id="sample"] [data-field="linkedAccountId"]').inputValue(), "login-custom");
  assert.equal(saveCalls(calls).length, 0);
  assert.equal(calls.find(call => call.path === "/api/platforms/sample").body.followingUrl, "https://sample.example/me/following");
  await page.locator("#selected-path").fill("D:\\Fixture\\People");
  await page.locator("#save-person-button").click();
  await page.locator("#person-dialog").waitFor({ state: "hidden" });
  const saved = saveCalls(calls).at(-1).body.platforms.find(platform => platform.id === "sample").accounts[0];
  assert.equal(saved.label, target.label);
  assert.equal(saved.folderName, target.label);
  assert.equal(saved.profileUrl, target.profileUrl);
  assert.equal(saved.linkedAccountId, "login-custom");
});

test("following page validation remains actionable in English without discarding the platform or person draft", async t => {
  const { page, calls } = await fixture(t, { language: "en" });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("Preserved draft");
  await page.locator("#create-person-platform-button").click();
  await page.locator("#custom-platform-label").fill("Validation fixture");
  await page.locator("#custom-platform-homepage").fill("https://sample.example/");
  await page.locator("#custom-platform-following").fill("https://foreign.example/following");
  for (const [error, expected] of [
    ["账号或平台页面地址格式无效。", /address is invalid/],
    ["账号或平台页面地址必须是不含密码、使用标准 HTTPS 的公网域名，不能使用本机或局域网地址。", /public domain.*HTTPS/],
    ["账号及验证页面必须属于该自定义平台的域名；其他平台请分别创建，避免混用登录资料。", /platform's domain/],
  ]) {
    await page.route(`${origin}/api/platforms`, route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error }) }));
    await page.locator("#save-platform-button").click();
    await page.waitForFunction(() => !document.querySelector("#save-platform-button").disabled);
    assert.match(await page.locator("#platform-form-status").textContent(), expected);
    assert.doesNotMatch(await page.locator("#platform-form-status").textContent(), /[\u3400-\u9fff]/);
    assert.equal(await page.locator("#custom-platform-following").inputValue(), "https://foreign.example/following");
  }
  await page.locator("#cancel-platform-dialog").click();
  assert.equal(await page.locator("#person-name").inputValue(), "Preserved draft");
  assert.equal(saveCalls(calls).length, 0);
});

test("custom profile URL identity retains case-sensitive nested paths and saved settings can be cleared safely", async t => {
  const accounts = ["Foo", "foo"].map(name => ({ platformId: "sample", handle: `https://sample.example/u/${name}?tab=Posts`,
    label: name, displayName: name, profileUrl: `https://sample.example/u/${name}?tab=Posts` }));
  const { page, calls } = await fixture(t, { customFollowingUrl: "https://sample.example/me/following", jobs: { "login-custom": { accounts } } });
  await openImport(page);
  await readSource(page, "login-custom");
  assert.equal(await page.locator(".following-import-item").count(), 2);
  await page.locator("#select-following-visible").click();
  await page.locator("#apply-following-import").click();
  assert.equal(await page.locator('.platform-panel[data-platform-id="sample"] .account-row').count(), 2);
  const firstInput = page.locator('.platform-panel[data-platform-id="sample"] [data-field="label"]').first();
  await firstInput.fill("Unsaved custom label");
  await firstInput.evaluate(node => { window.fixtureCustomLabelInput = node; });
  await page.locator('.platform-panel[data-platform-id="sample"] .edit-custom-platform').click();
  assert.equal(await page.locator("#custom-platform-following").inputValue(), "https://sample.example/me/following");
  await page.locator("#custom-platform-following").fill("");
  await chooseAppearance(page, "language", "en");
  await page.locator("#save-platform-button").click();
  await page.locator("#platform-dialog").waitFor({ state: "hidden" });
  assert.equal(await firstInput.inputValue(), "Unsaved custom label");
  // Language reconciliation may replace the input, but saving settings must not replace it again.
  assert.match(await page.locator('.platform-panel[data-platform-id="sample"] .following-page-warning').textContent(), /Add this custom platform's following page/);
  assert.equal(calls.filter(call => call.path === "/api/platforms/sample").at(-1).body.followingUrl, "");
  await page.locator("#import-following-button").click();
  assert.equal(await page.locator("#read-following-import").isDisabled(), true);
  assert.doesNotMatch(await page.locator("#following-import-status").textContent(), /[\u3400-\u9fff]/);
  assert.equal(saveCalls(calls).length, 0);
});

test("import dialog follows both themes/languages, preserves draft and checkbox focus, and fits narrow widths", async t => {
  const directory = new URL("../test-artifacts/following-import/", import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const [theme, language, width] of [["dark", "zh", 1600], ["light", "en", 1600], ["dark", "en", 390]]) {
    const { page, calls } = await fixture(t, { theme, language, width, jobs: { "login-x": { completeness: "partial", accounts: [
      followed("x", "a_very_long_profile_identifier", "Creator display name"), followed("x", "other", "Other creator"),
    ] } } });
    await openImport(page);
    await readSource(page, "login-x");
    const input = page.locator(".following-import-item input").first();
    await input.focus();
    await page.keyboard.press("Space");
    assert.equal(await input.isChecked(), true);
    const nextLanguage = language === "zh" ? "en" : "zh";
    await chooseAppearance(page, "language", nextLanguage);
    assert.equal(await input.isChecked(), true);
    assert.equal(await page.locator("#following-import-dialog").isVisible(), true);
    await chooseAppearance(page, "language", language);
    assert.equal(await page.locator("#following-import-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator(".following-import-item").first().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator("#following-import-dialog").evaluate(node => getComputedStyle(node).backgroundColor), theme === "dark" ? "rgb(21, 30, 45)" : "rgb(255, 255, 255)");
    if (language === "en") { const text = await page.locator("#following-import-dialog").evaluate(node => { const clone = node.cloneNode(true); clone.querySelector("#appearance-toolbar")?.remove(); return clone.textContent; }); assert.equal(/[\u3400-\u9fff]/.test(text), false, text); }
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${language}-${width}.png`, directory)), fullPage: true });
    await page.locator("#cancel-following-import").click();
    assert.equal(await page.locator("#person-dialog").isVisible(), true);
    assert.equal(saveCalls(calls).length, 0);
  }
});

