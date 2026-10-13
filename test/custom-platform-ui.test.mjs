import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const origin = "http://127.0.0.1:54322";
const customId = "custom-12345678-1234-4123-8123-123456789abc";
const custom = { id: customId, custom: true, label: "示例站", folderName: "示例站", homepageUrl: "https://example.com/", loginUrl: "https://example.com/login", engine: "auto" };

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

async function fixture(t, { theme = "dark", withCustom = false, width = 1400 } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 1100 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const model = {
    persons: [], linkedAccounts: [], syncSummaries: {}, settings: { theme },
    platforms: { x: { label: "X" }, ...(withCustom ? { [customId]: structuredClone(custom) } : {}) },
  };
  if (withCustom) model.linkedAccounts.push({ id: "login-1", platformId: customId, platformLabel: custom.label, label: "我的示例账号", loginStatus: "unverified" });
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [];
  const handlers = new Map();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const pathname = url.pathname;
    const body = request.postDataJSON();
    calls.push({ pathname, body, method: request.method() });
    let payload;
    if (handlers.has(pathname)) payload = await handlers.get(pathname)(body, request);
    else if (pathname === "/api/state") payload = structuredClone(model);
    else if (pathname === "/api/platforms" || pathname === `/api/platforms/${customId}`) {
      const platform = { ...custom, ...body, folderName: custom.folderName };
      model.platforms[customId] = platform;
      if (request.method() === "PUT") model.linkedAccounts.forEach((account) => { account.loginStatus = "unverified"; });
      payload = { platform, platforms: model.platforms, linkedAccounts: model.linkedAccounts };
    } else if (pathname === "/api/linked-accounts") {
      model.linkedAccounts.push({ id: "login-new", ...body, platformLabel: model.platforms[body.platformId].label, loginStatus: "unverified" });
      payload = model.linkedAccounts.at(-1);
    } else if (pathname.endsWith("/open-login")) payload = { loginMessage: "已打开登录窗口，请完成登录后验证。" };
    else if (pathname.endsWith("/verify-login")) {
      model.linkedAccounts[0].loginStatus = "failed";
      model.linkedAccounts[0].loginCode = "login-rule-required";
      model.linkedAccounts[0].loginMessage = "登录验证规则待配置。";
      payload = { verified: false, loginCode: "login-rule-required", loginMessage: "登录验证规则待配置。" };
    } else if (pathname.endsWith("/probe")) payload = { ok: true, capability: { scope: "account", images: true, videos: true }, mediaCount: 2, message: "已读取少量样本。" };
    else if (pathname.endsWith("/open-target")) payload = { message: "已在专用窗口打开目标主页。" };
    else {
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ status: 200, contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator("#linked-platform option").count() > 0, "initial registry");
  return { page, calls, model, handlers };
}

async function addCustomAccount(page) {
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("草稿人物");
  await page.locator("#platform-to-add").selectOption(customId);
  await page.locator("#add-platform-button").click();
  await page.locator('[data-field="label"]').fill("目标作者");
  await page.locator('[data-field="profileUrl"]').fill("https://example.com/author/test");
  await page.locator('[data-field="linkedAccountId"]').selectOption("login-1");
}

test("creating a global platform preserves the entire unsaved person draft and escapes display values", async (t) => {
  const { page, calls } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("尚未保存的人物");
  await page.locator("#person-note").fill("草稿备注");
  await page.locator("#selected-path").fill("D:\\Fixture\\People");
  await page.locator("#add-platform-button").click();
  await page.locator('[data-field="label"]').fill("原有草稿账号");
  await page.locator('[data-media-kind="video"]').uncheck();
  await page.evaluate(() => { window.draftInput = document.querySelector('[data-field="label"]'); });
  await page.locator("#create-person-platform-button").click();
  const label = '<img src=x onerror="window.injected=1">';
  await page.locator("#custom-platform-label").fill(label);
  await page.locator("#custom-platform-homepage").fill("https://example.com/");
  await page.locator("#save-platform-button").click();
  await until(async () => !(await page.locator("#platform-dialog").isVisible()), "platform created");
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
  assert.equal(await page.locator("#person-name").inputValue(), "尚未保存的人物");
  assert.equal(await page.locator("#person-note").inputValue(), "草稿备注");
  assert.equal(await page.locator("#selected-path").inputValue(), "D:\\Fixture\\People");
  assert.equal(await page.locator('[data-field="label"]').inputValue(), "原有草稿账号");
  assert.equal(await page.locator('[data-media-kind="video"]').isChecked(), false);
  assert.equal(await page.evaluate(() => window.draftInput === document.querySelector('[data-field="label"]')), true);
  assert.equal(await page.locator("#platform-to-add").inputValue(), customId);
  assert.equal(await page.locator(`#linked-platform option[value="${customId}"]`).textContent(), `${label} · 自定义`);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("#platform-dialog img").count(), 0);
  assert.equal(calls.filter((item) => item.pathname === "/api/state").length, 1);
  assert.deepEqual(calls.find((item) => item.pathname === "/api/platforms").body, {
    label, homepageUrl: "https://example.com/", loginUrl: "https://example.com/", followingUrl: "", engine: "auto", verificationUrl: "", loginMarker: "", logoutMarker: "",
  });
});

test("platforms created from account binding remain selectable globally and retain the account name", async (t) => {
  const { page, calls } = await fixture(t);
  await page.locator('[data-view="settings"]').click();
  await page.locator("#linked-label").fill("待绑定的我的账号");
  await page.locator("#create-linked-platform-button").click();
  await page.locator("#custom-platform-label").fill("示例站");
  await page.locator("#custom-platform-homepage").fill("https://example.com/");
  await page.locator("#save-platform-button").click();
  await until(async () => !(await page.locator("#platform-dialog").isVisible()), "create from binding");
  assert.equal(await page.locator("#linked-label").inputValue(), "待绑定的我的账号");
  assert.equal(await page.locator("#linked-platform").inputValue(), customId);
  assert.equal(await page.locator(`#platform-to-add option[value="${customId}"]`).count(), 1);
  await page.locator('#linked-account-form button[type="submit"]').click();
  await until(async () => await page.locator(".linked-card").count() === 1, "bound custom account");
  assert.deepEqual(calls.find((item) => item.pathname === "/api/linked-accounts").body, { platformId: customId, label: "待绑定的我的账号" });
  assert.equal(await page.locator(".linked-card .edit-custom-platform").count(), 1);
});

test("a rejected platform definition stays editable without discarding the parent draft", async (t) => {
  const { page } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("必须保留的草稿");
  await page.locator("#create-person-platform-button").click();
  await page.locator("#custom-platform-label").fill("重复平台");
  await page.locator("#custom-platform-homepage").fill("https://example.com/");
  await page.route(`${origin}/api/platforms`, (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "平台名称与现有平台重复。" }) }));
  await page.locator("#save-platform-button").click();
  await until(async () => (await page.locator("#platform-form-status").textContent()).includes("重复"), "validation message");
  assert.equal(await page.locator("#platform-dialog").isVisible(), true);
  assert.equal(await page.locator("#custom-platform-label").inputValue(), "重复平台");
  assert.equal(await page.locator("#save-platform-button").isEnabled(), true);
  await page.locator("#cancel-platform-dialog").click();
  assert.equal(await page.locator("#person-name").inputValue(), "必须保留的草稿");
  assert.equal(await page.locator("#person-dialog").isVisible(), true);
});

test("editing platform verification retains draft fields and the flat person blueprint and resets displayed verification", async (t) => {
  const { page, calls, model } = await fixture(t, { withCustom: true });
  model.linkedAccounts[0].loginStatus = "verified";
  await addCustomAccount(page);
  await page.evaluate(() => { window.draftRow = document.querySelector(".account-row"); });
  await page.locator(".platform-panel .edit-custom-platform").click();
  assert.equal(await page.locator("#custom-platform-homepage").getAttribute("readonly"), "");
  await page.locator("#custom-platform-label").fill("新的显示名称");
  await page.locator("#custom-platform-verification").fill("https://example.com/settings");
  await page.locator("#custom-platform-login-marker").fill('[data-testid="account-menu"]');
  await page.locator("#custom-platform-logout-marker").fill('form[action="/login"]');
  await page.locator("#save-platform-button").click();
  await until(async () => !(await page.locator("#platform-dialog").isVisible()), "settings updated");
  assert.equal(calls.find((item) => item.pathname === `/api/platforms/${customId}`).method, "PUT");
  assert.equal(calls.find((item) => item.pathname === `/api/platforms/${customId}`).body.loginMarker, '[data-testid="account-menu"]');
  assert.equal(await page.locator("#person-name").inputValue(), "草稿人物");
  assert.equal(await page.locator('[data-field="profileUrl"]').inputValue(), "https://example.com/author/test");
  assert.equal(await page.evaluate(() => window.draftRow === document.querySelector(".account-row")), true);
  assert.equal(await page.locator(".platform-display-label").textContent(), "新的显示名称");
  assert.match(await page.locator("#folder-tree").textContent(), /Image[\s\S]*Video[\s\S]*Index/);
  assert.doesNotMatch(await page.locator("#folder-tree").textContent(), /示例站/);
  assert.doesNotMatch(await page.locator("#folder-tree").textContent(), /新的显示名称/);
  assert.match(await page.locator('[data-field="linkedAccountId"] option:checked').textContent(), /未验证/);
});

test("sample probes distinguish account, single, zero and unsupported results and open only the bound profile", async (t) => {
  const { page, calls, handlers } = await fixture(t, { withCustom: true });
  await addCustomAccount(page);
  const endpoint = `/api/platforms/${customId}/probe`;
  await page.locator(".probe-account").click();
  await until(async () => (await page.locator(".account-probe-result").textContent()).includes("已识别账号列表"), "account sample")
    .catch(async (error) => { throw new Error(`${error.message}: ${await page.locator(".account-probe-result").textContent()}; calls=${JSON.stringify(calls.filter((item) => item.pathname.endsWith("/probe")))}`); });
  assert.match(await page.locator(".account-probe-result").textContent(), /不代表.*全部历史/);
  assert.deepEqual(calls.find((item) => item.pathname === endpoint).body, { profileUrl: "https://example.com/author/test", linkedAccountId: "login-1" });
  handlers.set(endpoint, () => ({ ok: true, capability: { scope: "single" }, mediaCount: 1, message: "可读单个作品" }));
  await page.locator(".probe-account").click();
  await until(async () => (await page.locator(".account-probe-result").textContent()).includes("仅确认单条作品"), "single result");
  handlers.set(endpoint, () => ({ ok: true, capability: { scope: "account" }, mediaCount: 0, message: "列表为空" }));
  await page.locator(".probe-account").click();
  await until(async () => (await page.locator(".account-probe-result").textContent()).includes("未取得媒体样本"), "empty result");
  handlers.set(endpoint, () => ({ ok: false, code: "unsupported", message: '<img src=x onerror="window.injected=1">' }));
  await page.locator(".probe-account").click();
  await until(async () => (await page.locator(".account-probe-result").textContent()).includes("暂不支持"), "unsupported result");
  assert.equal(await page.locator(".account-probe-result img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator(".open-account-target").click();
  await until(() => calls.some((item) => item.pathname === "/api/linked-accounts/login-1/open-target"), "open target");
  assert.deepEqual(calls.find((item) => item.pathname === "/api/linked-accounts/login-1/open-target").body, { profileUrl: "https://example.com/author/test" });
  assert.equal(calls.some((item) => /follow|sync/.test(item.pathname)), false);
  await page.locator('[data-field="linkedAccountId"]').selectOption("");
  assert.equal(await page.locator(".open-account-target").isDisabled(), true);
});

test("late probe responses cannot apply to an edited target URL", async (t) => {
  const { page, calls, handlers } = await fixture(t, { withCustom: true });
  await addCustomAccount(page);
  let finish;
  handlers.set(`/api/platforms/${customId}/probe`, () => new Promise((resolve) => { finish = resolve; }));
  await page.locator(".probe-account").click();
  await until(() => calls.some((item) => item.pathname.endsWith("/probe")), "pending probe");
  await page.locator('[data-field="profileUrl"]').fill("https://example.com/author/another");
  finish({ ok: true, capability: { scope: "account" }, mediaCount: 3, message: "OLD RESULT" });
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".account-probe-result").isVisible(), false);
  assert.doesNotMatch(await page.locator(".custom-account-tools").textContent(), /OLD RESULT/);
});

test("opening login never marks a custom account verified and failed verification remains explicit", async (t) => {
  const { page, calls } = await fixture(t, { withCustom: true });
  await page.locator('[data-view="settings"]').click();
  await page.locator(".open-login").click();
  await until(() => calls.filter((item) => item.pathname === "/api/state").length >= 2, "state after login open");
  assert.equal(await page.locator(".login-chip").textContent(), "尚未验证");
  await page.locator(".verify-login").click();
  await until(async () => (await page.locator(".login-chip").textContent()) === "验证待配置", "unconfigured verification");
  assert.match(await page.locator(".linked-card-copy").textContent(), /登录验证规则待配置/);
  await page.locator(".linked-card .edit-custom-platform").click();
  assert.equal(await page.locator("#platform-dialog-title").textContent(), "自定义平台设置");
  assert.match(await page.locator(".platform-verification-settings").textContent(), /不能使用 body 或通用导航/);
});

test("custom platform dialog inherits light, dark and system theme and fits a narrow viewport", async (t) => {
  for (const theme of ["light", "dark", "system"]) {
    const { page } = await fixture(t, { theme, width: 390 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator('[data-view="settings"]').click();
    await page.locator("#create-linked-platform-button").click();
    const colors = await page.locator("#platform-dialog").evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color, width: node.getBoundingClientRect().width, viewport: innerWidth }));
    assert.equal(colors.background, theme === "light" ? "rgb(255, 255, 255)" : "rgb(21, 30, 45)");
    assert.equal(colors.foreground, theme === "light" ? "rgb(23, 32, 51)" : "rgb(238, 243, 251)");
    assert.ok(colors.width <= colors.viewport);
    if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
      await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `custom-platform-mobile-${theme}.png`) });
      await page.setViewportSize({ width: 1400, height: 1100 });
      await page.locator(".platform-verification-settings summary").click();
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `custom-platform-desktop-${theme}.png`) });
    }
    await page.locator("#cancel-platform-dialog").click();
    assert.equal(await page.locator("#platform-dialog").isVisible(), false);
  }
});
