import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { classifyTikTokLogin, inspectTikTokPageLogin } from "../lib/tiktok-login.mjs";

const viewer = { uid: "123456789", uniqueId: "archive_viewer" };
const authenticated = { url: "https://www.tiktok.com/", status: 200, viewer };

test("TikTok verification requires a successful official page and the current viewer identity", () => {
  assert.deepEqual(classifyTikTokLogin(authenticated), {
    verified: true, username: "archive_viewer",
    message: "已在线确认 TikTok 账号 @archive_viewer 处于登录状态。",
  });
  for (const url of ["https://nottiktok.com/", "https://tiktok.com.example.test/", "http://www.tiktok.com/", "chrome-error://chromewebdata/", "https://user@www.tiktok.com/"]) {
    assert.equal(classifyTikTokLogin({ ...authenticated, url }).verified, false, url);
  }
  for (const status of [0, 403, 429, 500]) {
    assert.equal(classifyTikTokLogin({ ...authenticated, status }).verified, false, String(status));
  }
  assert.equal(classifyTikTokLogin({ ...authenticated, networkError: "net::ERR_CONNECTION_RESET" }).verified, false);
  for (const viewer of [null, {}, { uid: "0", uniqueId: "creator" }, { uid: "123456" }, { uniqueId: "creator" }]) {
    assert.equal(classifyTikTokLogin({ ...authenticated, viewer }).verified, false);
  }
  assert.equal(classifyTikTokLogin({ url: authenticated.url, hasAuthenticatedMarker: true, author: viewer }).verified, false);
});

test("TikTok visible login and verification challenges override stale embedded viewer data", () => {
  for (const blocked of [{ hasCaptcha: true }, { hasPasswordField: true }, { hasUsernameField: true }, { hasLoginPrompt: true },
    { url: "https://www.tiktok.com/login/phone-or-email" }, { url: "https://www.tiktok.com/captcha/" }]) {
    assert.equal(classifyTikTokLogin({ ...authenticated, ...blocked }).verified, false);
  }
});

test("TikTok inspection fails closed when the page cannot be read", async () => {
  const result = await inspectTikTokPageLogin({ evaluate: async () => { throw new Error("closed"); } });
  assert.equal(result.verified, false);
});

test("offline DOM fixtures distinguish the logged-in viewer from profile authors and refusal pages", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.setOffline(true);
  const embedded = (scope) => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: scope })}</script>`;
  const viewerHtml = embedded({ "webapp.app-context": { user: viewer } });
  const fixtures = new Map([
    ["/viewer", { body: `${viewerHtml}<p>For You</p><input type="password" hidden><button data-e2e="top-login-button" style="display:none">Log in</button>` }],
    ["/author", { body: `${embedded({ "webapp.user-detail": { userInfo: { user: viewer } } })}<a href="/@archive_viewer" aria-label="Creator profile">Creator</a>` }],
    ["/login-prompt", { body: `${viewerHtml}<button data-e2e="top-login-button">Log in</button>` }],
    ["/challenge", { body: `${viewerHtml}<div id="captcha_container" style="width:300px;height:100px">Verify to continue</div>` }],
    ["/forbidden", { status: 403, body: `${viewerHtml}<h1>Access denied</h1>` }],
    ["/empty", { body: "<h1>Please wait</h1>" }],
  ]);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const fixture = url.hostname === "www.tiktok.com" ? fixtures.get(url.pathname) : null;
    if (!fixture) return route.abort();
    await route.fulfill({ contentType: "text/html", ...fixture });
  });
  const page = await context.newPage();
  for (const pathname of fixtures.keys()) {
    const response = await page.goto(`https://www.tiktok.com${pathname}`);
    const result = await inspectTikTokPageLogin(page, { status: response.status() });
    assert.equal(result.verified, pathname === "/viewer", pathname);
    if (result.verified) assert.equal(result.username, viewer.uniqueId);
  }
});
