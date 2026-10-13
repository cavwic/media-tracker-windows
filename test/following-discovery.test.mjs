import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFollowingAccount, parseFollowingResponse, discoverFollowing } from "../lib/following-discovery.mjs";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { chromium } from "playwright";

const linked = (id = "x") => ({ id: "own-binding", platformId: id, label: "不是实际账号的绑定名称", profileDirectory: "D:\\offline-fixture\\profile" });
const xUser = (handle, name = handle) => ({ content: { itemContent: { user_results: { result: { legacy: { screen_name: handle, name } } } } } });
const xBody = (handles, terminal = true) => ({ data: { user: { result: { timeline: { timeline: { instructions: [
  { type: "TimelineAddEntries", entries: handles.map((handle) => xUser(handle)) },
  terminal ? { type: "TimelineTerminateTimeline", direction: "Bottom" } : { type: "TimelineAddEntries", entries: [{ content: { cursorType: "Bottom", value: "next" } }] },
] } } } } } });
const xUrl = "https://x.com/i/api/graphql/observed/Following?variables=%7B%22userId%22%3A%22100%22%7D";
const parse = (id, url, body, extras = {}) => parseFollowingResponse(id, { url, body, followingOpened: true, ...extras });

test("canonical account URLs reject foreign hosts, navigation, posts, credentials, ports and scripts", () => {
  for (const [id, handle, expected] of [["x", "target_one", "https://x.com/target_one"], ["instagram", "name.one", "https://www.instagram.com/name.one/"],
    ["threads", "name.one", "https://www.threads.com/@name.one"], ["tiktok", "name_one", "https://www.tiktok.com/@name_one"]]) {
    const record = canonicalFollowingAccount(id, { handle, displayName: "展示名称\x00" });
    assert.equal(record.profileUrl, expected); assert.equal(record.label, handle); assert.equal(record.displayName, "展示名称");
  }
  assert.equal(canonicalFollowingAccount("facebook", { profileUrl: "https://www.facebook.com/people/A-Name/1234567/?ref=test" }).profileUrl,
    "https://www.facebook.com/profile.php?id=1234567");
  assert.equal(canonicalFollowingAccount("facebook", { profileUrl: "https://www.facebook.com/profile.php?id=1234567&sk=following" }).handle, "1234567");
  for (const value of ["https://evil.test/target", "https://x.com.evil.test/target", "https://x.com:8443/target", "https://user:secret@x.com/target",
    "http://x.com/target", "javascript:alert(1)", "https://x.com/home", "https://x.com/target/status/123", "https://x.com/target/followers", "https://x.com/../home"]) {
    assert.equal(canonicalFollowingAccount("x", { profileUrl: value }), null, value);
  }
  assert.equal(canonicalFollowingAccount("instagram", { handle: "../a" }), null);
  assert.equal(canonicalFollowingAccount("tiktok", { profileUrl: "https://www.tiktok.com/plain" }), null);
  assert.equal(canonicalFollowingAccount("custom-example", { handle: "name" }), null);
});

test("X following response is scoped, deduplicated and excludes ads and foreign owners", () => {
  const body = xBody(["Target", "target", "other"]);
  body.data.user.result.timeline.timeline.instructions[0].entries.push({ promotedMetadata: {}, ...xUser("advertiser") });
  const result = parse("x", xUrl, body, { selfId: "100" });
  assert.equal(result.matched, true); assert.equal(result.terminal, true);
  assert.deepEqual(result.accounts.map((account) => account.handle.toLowerCase()).sort(), ["other", "target"]);
  assert.equal(parse("x", xUrl, body, { selfId: "200" }).matched, false);
  assert.equal(parse("x", xUrl.replace("Following", "Followers"), body).matched, false);
  assert.equal(parseFollowingResponse("x", { url: xUrl, body }).matched, false);
  const nonterminal = parse("x", xUrl, xBody(["target"], false));
  assert.equal(nonterminal.terminal, false); assert.equal(nonterminal.cursor, "next");
});

test("Instagram only accepts following connections, preserves usernames with external bio links and strict pagination", () => {
  const url = "https://www.instagram.com/api/v1/friendships/123/following/?count=24";
  const body = { users: [{ username: "target", full_name: "Target", url: "https://external.example/" }], big_list: false, next_max_id: "next" };
  const result = parse("instagram", url, body, { selfId: "123" });
  assert.equal(result.accounts[0].handle, "target"); assert.equal(result.terminal, false);
  assert.equal(parse("instagram", url, { ...body, next_max_id: null }).terminal, true);
  assert.equal(parse("instagram", url.replace("following", "followers"), body).matched, false);
  assert.equal(parse("instagram", url, body, { selfId: "999" }).matched, false);
  assert.equal(parse("instagram", url, { ...body, status: "fail", next_max_id: null }).terminal, false);
  assert.equal(parse("instagram", "https://www.instagram.com/graphql/query", { data: { edge_followed_by: { edges: [{ node: { username: "follower" } }] } } }).matched, false);
  const graph = parse("instagram", "https://www.instagram.com/graphql/query", { data: { edge_follow: {
    edges: [{ node: { username: "followed" } }], page_info: { has_next_page: false } } } });
  assert.equal(graph.accounts[0].handle, "followed"); assert.equal(graph.terminal, true);
});

test("Threads and Facebook parse only explicit following relationships, not feed actors or recommendations", () => {
  const threads = parse("threads", "https://www.threads.com/api/graphql", { data: { viewer: { username: "self" },
    suggested_users: [{ username: "suggested" }], following: { edges: [{ node: { user: { username: "followed" } } }], page_info: { has_next_page: false } } } });
  assert.deepEqual(threads.accounts.map((account) => account.handle), ["followed"]); assert.equal(threads.terminal, true);
  const facebook = parse("facebook", "https://www.facebook.com/api/graphql/", [{ data: { profile: { subscribed_profiles: {
    edges: [{ node: { profile: { name: "Display name", url: "https://www.facebook.com/profile.php?id=12345" } } }], page_info: { has_next_page: false } } } } }]);
  assert.equal(facebook.accounts[0].handle, "12345"); assert.equal(facebook.terminal, true);
  assert.equal(parse("facebook", "https://www.facebook.com/api/graphql/", { data: { timeline: [{ actor: { url: "https://www.facebook.com/feedactor" } }] } }).matched, false);
  assert.equal(parse("facebook", "https://www.facebook.com/api/graphql/", [{ errors: [{ message: "failed" }] }, { data: { following: {
    edges: [], page_info: { has_next_page: false } } } }]).terminal, false);
});

test("TikTok uses observed following UI user-list payload and explicit terminal flag", () => {
  const body = { userList: [{ user: { uniqueId: "target", nickname: "Target" } }, { userInfo: { user: { uniqueId: "other" } } }], hasMore: false, cursor: 30 };
  const result = parse("tiktok", "https://www.tiktok.com/api/user/list/?cursor=0", body);
  assert.deepEqual(result.accounts.map((account) => account.handle), ["target", "other"]); assert.equal(result.terminal, true);
  assert.equal(parse("tiktok", "https://www.tiktok.com/api/recommend/user/", body).matched, false);
  assert.equal(parse("tiktok", "https://www.tiktok.com/api/user/list/", { ...body, hasMore: true }).terminal, false);
  assert.equal(parse("tiktok", "https://www.tiktok.com/api/user/list/", { ...body, status_code: 403 }).terminal, false);
  assert.equal(parse("tiktok", "https://www.tiktok.com/api/user/list/?userId=999", body, { selfId: "123" }).matched, false);
});

function fixture({ id = "x", responseBodies = [xBody(["target"])], expectedCount = null, rowRounds = [[]],
  selfAvailable = true, followingLink = true, failClose = false, fallbackBrowser = false, onWait, onRows, jsonFailure = false, closeHang = false, responseStatus = 200 } = {}) {
  const calls = { goto: [], close: 0, extraClose: 0, clicks: [], roleChecks: [], options: null, profile: null, release: 0, response: 0, browserClose: 0 };
  const listeners = new Map();
  let rows = 0;
  const selfUrl = canonicalFollowingAccount(id, { handle: "self" }).profileUrl;
  const url = id === "x" ? xUrl : id === "instagram" ? "https://www.instagram.com/api/v1/friendships/123/following/"
    : id === "tiktok" ? "https://www.tiktok.com/api/user/list/" : `https://www.${id === "threads" ? "threads.com" : "facebook.com"}/api/graphql/`;
  const emitResponses = () => {
    for (const body of responseBodies) {
      calls.response += 1;
      listeners.get("response")?.({ url: () => url, status: () => responseStatus,
        json: async () => { if (jsonFailure === "hang") return new Promise(() => {}); if (jsonFailure) throw new Error("invalid JSON"); return body; },
        text: async () => `for (;;);${JSON.stringify(body)}\n`, request: () => ({ postData: () => "" }) });
    }
  };
  const locator = (selector) => ({ first() { return this; }, async click() { calls.clicks.push(selector); emitResponses(); },
    getByRole(role) { calls.roleChecks.push(role); return this; }, async isVisible() { return false; } });
  const page = {
    on(event, handler) { listeners.set(event, handler); }, off(event) { listeners.delete(event); },
    async goto(value) { calls.goto.push(value); if (id === "x" && /\/following$/.test(value)) emitResponses(); return { status: () => 200 }; },
    async waitForTimeout() { await onWait?.(calls); },
    async evaluate(fn) {
      if (fn.name === "readNavigationSnapshot") return { url: calls.goto.at(-1), authenticated: true,
        links: selfAvailable ? [{ href: selfUrl, text: "Profile" }] : [],
        viewer: id === "tiktok" && selfAvailable ? { uid: "123", uniqueId: "self" } : null };
      if (fn.name === "readFollowingEntry") return { followingHref: followingLink ? "/self/following" : "", expectedCount, tiktokSelector: id === "tiktok" && followingLink ? "[data-e2e=following-count]" : "" };
      if (fn.name === "readFollowingRows") {
        await onRows?.(calls);
        return { links: rowRounds[Math.min(rows++, rowRounds.length - 1)] || [], explicitEnd: false };
      }
      throw new Error(`Unexpected DOM reader ${fn.name}`);
    },
    locator, getByRole(role) { calls.roleChecks.push(role); return locator(role); },
  };
  const context = { pages: () => [page, { close: async () => { calls.extraClose += 1; } }],
    close: async () => { calls.close += 1; if (closeHang) return new Promise(() => {}); if (failClose) throw new Error("close failed"); },
    browser: () => fallbackBrowser ? { isConnected: () => calls.browserClose === 0, close: async () => { calls.browserClose += 1; } } : null };
  const browserType = { async launchPersistentContext(profile, options) { calls.profile = profile; calls.options = options; return context; } };
  const acquireTikTokPage = async (options) => { calls.options = options; return { page, context,
    release: async () => { calls.release += 1; if (failClose) throw new Error("release failed"); }, markHomeWarmupComplete: () => true }; };
  return { calls, page, context, options: { platform: { id }, linkedAccount: linked(id), browserType, acquireTikTokPage, settleMs: 0, navigationTimeoutMs: 0 } };
}

test("background discovery identifies own profile from nav, closes blank tabs and publishes safe canonical targets", async () => {
  const f = fixture(); const progress = [];
  const result = await discoverFollowing({ ...f.options, onProgress: (entry) => progress.push(entry) });
  assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map((item) => item.handle), ["target"]);
  assert.deepEqual(f.calls.goto, ["https://x.com/home", "https://x.com/self", "https://x.com/self/following"]);
  assert.equal(f.calls.profile, linked().profileDirectory); assert.equal(f.calls.options.headless, true);
  assert.equal(f.calls.options.executablePath, BACKGROUND_CHROMIUM_EXECUTABLE);
  assert.equal(f.calls.extraClose, 1); assert.equal(f.calls.close, 1);
  assert.equal(JSON.stringify(progress).includes("offline-fixture"), false);
  assert.equal(JSON.stringify(result).includes("不是实际账号"), false);
});

test("missing self identity never guesses using bound display name and always closes context", async () => {
  const f = fixture({ selfAvailable: false });
  await assert.rejects(discoverFollowing(f.options), { code: "self-profile-unavailable" });
  assert.deepEqual(f.calls.goto, ["https://x.com/home"]); assert.equal(f.calls.close, 1); assert.equal(f.calls.clicks.length, 0);
});

test("Facebook's online authenticated viewer ID identifies its own profile without guessing the opaque binding name", async () => {
  const f = fixture({ id: "facebook", selfAvailable: false, expectedCount: 0, responseBodies: [] });
  f.context.cookies = async () => [{ name: "c_user", value: "1234567", domain: ".facebook.com" }];
  const result = await discoverFollowing(f.options);
  assert.equal(result.completeness, "complete");
  assert.deepEqual(f.calls.goto, ["https://www.facebook.com/", "https://www.facebook.com/profile.php?id=1234567"]);
  assert.equal(JSON.stringify(result).includes("c_user"), false);
  assert.equal(f.calls.close, 1);
});

test("a cached Facebook viewer cookie alone cannot identify an online unauthenticated session", async () => {
  const f = fixture({ id: "facebook", selfAvailable: false, expectedCount: 0, responseBodies: [] });
  const originalEvaluate = f.page.evaluate;
  f.page.evaluate = async fn => fn.name === "readNavigationSnapshot"
    ? { url: "https://www.facebook.com/", authenticated: false, links: [] } : originalEvaluate(fn);
  f.context.cookies = async () => [{ name: "c_user", value: "1234567", domain: ".facebook.com" }];
  await assert.rejects(discoverFollowing(f.options), { code: "self-profile-unavailable" });
  assert.deepEqual(f.calls.goto, ["https://www.facebook.com/"]);
  assert.equal(f.calls.close, 1);
});

test("X following responses for another viewer ID cannot complete or populate the current session list", async () => {
  const f = fixture({ maxPages: 1 });
  f.context.cookies = async () => [{ name: "twid", value: "u%3D999", domain: ".x.com" }];
  await assert.rejects(discoverFollowing({ ...f.options, maxPages: 1 }), { code: "following-list-unavailable" });
  assert.equal(f.calls.close, 1);
});

test("X a route change during DOM row extraction cannot import another owner's rows", async () => {
  const f = fixture({ responseBodies: [], rowRounds: [[{ handle: "foreign_target" }]] });
  const originalEvaluate = f.page.evaluate;
  f.page.evaluate = async fn => {
    const result = await originalEvaluate(fn);
    return fn.name === "readFollowingRows" ? { ...result, url: "https://x.com/another_owner/following" } : result;
  };
  const progress = [];
  await assert.rejects(discoverFollowing({ ...f.options, onProgress: item => progress.push(item) }), { code: "following-list-unavailable" });
  assert.equal(progress.some(item => item.accounts?.length), false);
  assert.equal(f.calls.close, 1);
});

test("missing following navigation does not click generic Following action buttons", async () => {
  const f = fixture({ id: "instagram", followingLink: false });
  await assert.rejects(discoverFollowing(f.options), { code: "following-list-unavailable" });
  assert.equal(f.calls.roleChecks.includes("button"), false); assert.equal(f.calls.clicks.length, 0); assert.equal(f.calls.close, 1);
});

test("verified zero following count is complete without reading or opening a list", async () => {
  const f = fixture({ expectedCount: 0 });
  const result = await discoverFollowing(f.options);
  assert.equal(result.completeness, "complete"); assert.equal(result.accounts.length, 0);
  assert.equal(f.calls.response, 0); assert.equal(f.calls.clicks.length, 0); assert.equal(f.calls.close, 1);
});

test("stagnant list is partial, never inferred complete; continuous new pages are not cut after five rounds", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => [{ handle: `person${index}` }]);
  const f = fixture({ responseBodies: [], rowRounds: rows });
  const result = await discoverFollowing({ ...f.options, maxPages: 10 });
  assert.equal(result.completeness, "partial"); assert.equal(result.accounts.length, 10);
  const stalled = fixture({ responseBodies: [xBody(["target"], false)] });
  const partial = await discoverFollowing(stalled.options);
  assert.equal(partial.completeness, "partial"); assert.equal(partial.accounts.length, 1); assert.equal(stalled.calls.close, 1);
});

test("matching response JSON failure prevents even a known count from reporting complete", async () => {
  const f = fixture({ jsonFailure: true, expectedCount: 1, rowRounds: [[{ handle: "target" }]] });
  const result = await discoverFollowing(f.options);
  assert.equal(result.accounts.length, 1); assert.equal(result.completeness, "partial");
});

for (const status of [401, 403, 429]) {
  test(`public following HTTP ${status} immediately closes owned work without retrying or reading rows`, async () => {
    let rowReads = 0;
    const f = fixture({ responseStatus: status, jsonFailure: true, onRows: () => rowReads++ });
    await assert.rejects(discoverFollowing(f.options), { code: "access-restricted", status });
    assert.equal(f.calls.response, 1);
    assert.equal(rowReads, 0);
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.goto.length, 3);
  });
}

test("read limit is explicit partial and deduped across network and DOM", async () => {
  const f = fixture({ responseBodies: [xBody(["a", "b", "c"], false)], rowRounds: [[{ handle: "A" }]] });
  const result = await discoverFollowing({ ...f.options, maxAccounts: 2 });
  assert.equal(result.accounts.length, 2); assert.equal(result.completeness, "partial"); assert.match(result.message, /上限/);
});

test("cancellation disposes only private context and does not return success", async () => {
  const controller = new AbortController();
  const f = fixture({ onRows: () => controller.abort() });
  await assert.rejects(discoverFollowing({ ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls.close, 1);
});

test("TikTok uses its dedicated invisible work lease and releases it without closing shared context", async () => {
  const f = fixture({ id: "tiktok", responseBodies: [{ userList: [{ user: { uniqueId: "target" } }], hasMore: false }] });
  const result = await discoverFollowing(f.options);
  assert.equal(result.completeness, "complete"); assert.equal(result.accounts[0].handle, "target");
  assert.equal(f.calls.options.purpose, "following"); assert.equal(f.calls.release, 1); assert.equal(f.calls.close, 0);
});

test("Facebook anti-JSON prefix response is parsed using existing stream assembler", async () => {
  const f = fixture({ id: "facebook", responseBodies: [{ data: { following: { edges: [{ node: { url: "https://www.facebook.com/target" } }],
    page_info: { has_next_page: false } } } }] });
  const result = await discoverFollowing(f.options);
  assert.equal(result.completeness, "complete"); assert.equal(result.accounts[0].handle, "target"); assert.equal(f.calls.close, 1);
});

test("unconfirmed browser cleanup fails with retained profile lease instead of a successful result", async () => {
  const f = fixture({ failClose: true });
  await assert.rejects(discoverFollowing(f.options), { code: "browser-close-failed", retainProfileLease: true });
  assert.equal(f.calls.close, 1);
  const fallback = fixture({ failClose: true, fallbackBrowser: true });
  const result = await discoverFollowing(fallback.options);
  assert.equal(result.completeness, "complete"); assert.equal(fallback.calls.browserClose, 1);
  const tiktok = fixture({ id: "tiktok", responseBodies: [], failClose: true, expectedCount: 0 });
  await assert.rejects(discoverFollowing(tiktok.options), { code: "browser-close-failed", retainProfileLease: true });
});

test("unsupported custom platforms and missing binding never launch any browser", async () => {
  const f = fixture();
  await assert.rejects(discoverFollowing({ ...f.options, platform: { id: "custom-test", custom: true } }), { code: "unsupported-platform" });
  await assert.rejects(discoverFollowing({ ...f.options, linkedAccount: { platformId: "instagram" } }), { code: "login-required" });
  assert.equal(f.calls.goto.length, 0); assert.equal(f.calls.close, 0); assert.equal(f.calls.options, null);
});

test("retained disposal failure supplies a private retry that only resolves after a confirmed close", async () => {
  const f = fixture({ failClose: true });
  let error;
  try { await discoverFollowing(f.options); } catch (value) { error = value; }
  assert.equal(error.retainProfileLease, true); assert.equal(typeof error.retryDispose, "function");
  await assert.rejects(error.retryDispose(), { code: "browser-close-failed" });
  f.context.close = async () => { f.calls.close += 1; };
  await error.retryDispose();
  assert.equal(f.calls.close, 3);
  assert.equal(JSON.stringify(error).includes("retryDispose"), false);
});

test("hung close is bounded and does not incorrectly release the profile", async () => {
  const f = fixture({ closeHang: true });
  await assert.rejects(discoverFollowing({ ...f.options, cleanupTimeoutMs: 20 }), { code: "browser-close-failed", retainProfileLease: true });
});

test("hanging response body does not prevent cancellation or cause late progress", async () => {
  const f = fixture({ jsonFailure: "hang" }); const controller = new AbortController(); const progress = [];
  const running = discoverFollowing({ ...f.options, signal: controller.signal, onProgress: (item) => progress.push(item) });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(running, { name: "AbortError" }); }
  finally { clearTimeout(timer); }
  assert.equal(f.calls.close, 1); assert.equal(progress.length, 0);
});

test("actual local DOM fixtures exclude suggested Follow rows and accept nested Profile SVG navigation", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext();
  const page = await context.newPage();
  let routeCount = 0;
  const home = '<a href="/direct/inbox/">Inbox</a><a href="/self/"><svg aria-label="Profile"><rect width="40" height="40" /></svg></a>';
  const profile = `<a href="/self/following/" onclick="event.preventDefault();document.querySelector('#list').style.display='block'">1 Following</a>
    <div id="list" role="dialog" style="display:none">
      <h2>Following</h2><section><h3>Suggested for you</h3><div role="listitem"><a href="/recommended/">Recommended</a><button>Follow</button></div></section>
      <div role="listitem"><a href="/target/">Target</a><button>Following</button></div>
    </div>`;
  await context.route("**/*", async (route) => { routeCount += 1; await route.fulfill({ status: 200, contentType: "text/html",
    body: new URL(route.request().url()).pathname === "/" ? home : profile }); });
  const controlled = { launchPersistentContext: async () => context };
  try {
    const result = await discoverFollowing({ platform: { id: "instagram" }, linkedAccount: linked("instagram"), browserType: controlled, settleMs: 20 });
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map((account) => account.handle), ["target"]);
    assert.equal(routeCount >= 2, true);
  } finally { await browser.close(); }
});

test("actual local DOM hidden login marker is not proof of authentication", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext(); await context.newPage();
  let routes = 0;
  await context.route("**/*", async (route) => { routes += 1; await route.fulfill({ contentType: "text/html",
    body: '<a style="display:none" href="/direct/inbox/">Inbox</a><a href="/self/">Profile</a>' }); });
  try {
    await assert.rejects(discoverFollowing({ platform: { id: "instagram" }, linkedAccount: linked("instagram"),
      browserType: { launchPersistentContext: async () => context }, settleMs: 0, navigationTimeoutMs: 0 }), { code: "self-profile-unavailable" });
    assert.equal(routes, 1);
  } finally { await browser.close(); }
});

