import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { discoverFollowing, parseFollowingResponse } from "../lib/following-discovery.mjs";

const endpoints = { instagram: "https://www.instagram.com/api/v1/friendships/123/following/",
  tiktok: "https://www.tiktok.com/api/user/list/?userId=123", facebook: "https://web.facebook.com/api/graphql/",
  threads: "https://www.threads.com/api/graphql/" };
const parse = (platform, body) => parseFollowingResponse(platform, { url: endpoints[platform], body,
  followingOpened: true, selfId: "123" });
const connection = (edges, hasNextPage = false) => ({ data: { following: { edges, page_info: { has_next_page: hasNextPage } } } });

for (const [name, platform, body] of [
  ["missing Instagram users", "instagram", { has_more: false }],
  ["non-array Instagram users", "instagram", { users: {}, has_more: false }],
  ["invalid Instagram relationship entries", "instagram", { users: [{ username: "../bad" }], has_more: false }],
  ["invalid TikTok relationship entries", "tiktok", { userList: [{ user: { uniqueId: "../bad" } }], statusCode: 0, hasMore: false }],
  ["failed TikTok status with an empty terminal array", "tiktok", { userList: [], statusCode: 403, hasMore: false }],
  ["invalid Facebook relationship entries", "facebook", connection([{ node: { name: "Missing profile URL" } }])],
  ["invalid Threads relationship entries", "threads", connection([{ node: { user: { username: "../bad" } } }])],
]) {
  test(`${name} cannot provide terminal or empty-list proof`, () => {
    const result = parse(platform, body);
    assert.equal(result.matched, true); assert.equal(result.error, true);
    assert.equal(result.terminal, false); assert.equal(result.emptyConfirmed, false);
    assert.deepEqual(result.accounts, []);
  });
}

for (const [platform, emptyTerminal, emptyNonterminal] of [
  ["instagram", { users: [], has_more: false }, { users: [], has_more: true }],
  ["tiktok", { userList: [], statusCode: 0, hasMore: false }, { userList: [], statusCode: 0, hasMore: true }],
  ["facebook", connection([]), connection([], true)],
  ["threads", connection([]), connection([], true)],
]) {
  test(`${platform} recognized empty relationship array requires a successful explicit terminal response`, () => {
    const complete = parse(platform, emptyTerminal), partial = parse(platform, emptyNonterminal);
    assert.equal(complete.matched, true); assert.equal(complete.error, false);
    assert.equal(complete.terminal, true); assert.equal(complete.emptyConfirmed, true); assert.deepEqual(complete.accounts, []);
    assert.equal(partial.matched, true); assert.equal(partial.error, false);
    assert.equal(partial.terminal, false); assert.equal(partial.emptyConfirmed, false); assert.deepEqual(partial.accounts, []);
  });
}

test("a nonempty response containing only the current viewer is not raw empty-list proof", () => {
  const result = parse("instagram", { users: [{ username: "fixture_viewer" }], has_more: false });
  assert.equal(result.terminal, true); assert.equal(result.error, false); assert.equal(result.emptyConfirmed, false);
  assert.equal(result.accounts.length, 1);
});

const viewer = "fixture_viewer";
const bodyDocument = body => `<!doctype html><meta charset="utf-8"><style>
  body{margin:20px}main,header,section,article,div{min-height:20px}a,button,span{display:inline-block;min-height:20px}
  [hidden]{display:none!important}</style>${body}`;
const account = id => ({ id: `empty-proof-${id}`, platformId: id, label: "Not a username",
  profileDirectory: "D:\\offline-empty-proof-fixture\\never-opened-profile" });
const profileHref = id => id === "facebook" ? "/profile.php?id=123" : `/${id === "tiktok" ? "@" : ""}${viewer}${id === "instagram" ? "/" : ""}`;
const ownHome = id => id === "facebook" ? '<button role="button" aria-label="Account">Account</button>'
  : id === "tiktok" ? `<nav><a data-e2e="nav-profile" href="${profileHref(id)}">Profile</a></nav>`
    : `<nav><a href="/direct/inbox/">Inbox</a><a href="${profileHref(id)}" aria-label="Profile">Profile</a></nav>`;
const targetRow = id => `<div role="listitem" data-e2e="user-list-item"><a href="/${id === "tiktok" ? "@" : ""}target/">Target</a><button>Following</button></div>`;
const popupOnClick = popup => `document.querySelector('#popup-host').innerHTML=${JSON.stringify(popup).replace(/"/g, "&quot;")}`;
const instagramProfile = popup => `<main><header><h1>${viewer}</h1><a role="link" href="/${viewer}/" id="own-counter"
  onclick="event.preventDefault();${popupOnClick(popup)}"><span>1</span><span>关注</span></a></header></main><section id="popup-host"></section>`;
const tiktokProfile = popup => `<main><header><h1>${viewer}</h1><button id="own-counter" onclick="${popupOnClick(popup)}">
  <span data-e2e="following-count">1</span> Following</button></header></main><section id="popup-host"></section>`;

async function withDom(t, id, { profile, responseBody, responseStatus = 200 } = {}, run) {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const requests = [], clicks = []; let closeCount = 0, releases = 0;
  context.on("close", () => { closeCount += 1; }); t.after(async () => browser.close());
  await context.exposeBinding("recordFixtureClick", (_source, id) => clicks.push(id));
  await context.addInitScript(() => document.addEventListener("click", event => {
    window.recordFixtureClick(event.target.closest("a,button,[role=link],[role=tab]")?.id || "unlabelled");
  }));
  if (id === "facebook" || id === "instagram") await context.addCookies([{ name: id === "facebook" ? "c_user" : "ds_user_id",
    value: "123", domain: `.${id}.com`, path: "/" }]);
  // Documents and requests are fulfilled individually. No HTTP redirects,
  // real profile directories, captured cookies or external network access.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname);
    let body;
    if (/friendships|user\/list|graphql/.test(url.pathname)) {
      await route.fulfill({ status: responseStatus, contentType: "application/json", body: JSON.stringify(responseBody || {}) }); return;
    }
    if (url.pathname === "/") body = ownHome(id);
    else if (id === "facebook" ? url.pathname === "/profile.php" && url.searchParams.get("id") === "123"
      : url.pathname.replace(/\/$/, "") === profileHref(id).replace(/\/$/, "")) body = profile;
    else { await route.fulfill({ status: 404, body: "Unplanned offline fixture URL" }); return; }
    await route.fulfill({ contentType: "text/html", body: bodyDocument(body) });
  });
  const options = { platform: { id }, linkedAccount: account(id), settleMs: 30, navigationTimeoutMs: 250,
    maxDurationMs: 5000, maxPages: 30, browserType: { launchPersistentContext: async (directory, launchOptions) => {
      assert.equal(directory, account(id).profileDirectory); assert.equal(launchOptions.headless, true); return context;
    } }, acquireTikTokPage: async input => ({ context, page, markHomeWarmupComplete: async () => {},
      release: async () => { assert.equal(input.purpose, "following"); releases += 1; await page.close(); } }) };
  await run({ options, page, requests, clicks, closed: () => closeCount, released: () => releases });
}

test("collector removing its own account from a nonempty terminal response cannot confirm an empty list", async t => {
  const profile = `<main><a href="/${viewer}/following/" id="own-entry" onclick="event.preventDefault();fetch('/api/v1/friendships/123/following/')">Following</a></main>`;
  await withDom(t, "instagram", { profile, responseBody: { users: [{ username: viewer }], has_more: false } }, async ({ options, requests, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(requests.includes("/api/v1/friendships/123/following/"), true);
    assert.equal(progress.some(value => value.accounts?.length), false); assert.equal(closed(), 1);
  });
});

test("HTTP failure cannot turn a recognized empty terminal relationship array into success", async t => {
  const profile = `<main><a href="/${viewer}/following/" onclick="event.preventDefault();fetch('/api/v1/friendships/123/following/')">Following</a></main>`;
  await withDom(t, "instagram", { profile, responseStatus: 403, responseBody: { users: [], has_more: false } }, async ({ options, requests, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "access-restricted", status: 403 });
    assert.equal(requests.filter(url => url === "/api/v1/friendships/123/following/").length, 1);
    assert.equal(progress.some(value => value.accounts?.length), false);
    assert.equal(closed(), 1);
  });
});

test("an unparsed DOM relationship row followed by a generic end marker cannot confirm zero accounts", async t => {
  const popup = '<div role="dialog"><h2>Following</h2><div role="listitem"><a href="/unparsed_target/">Visible account</a><button>Unknown relation label</button></div><div>No more users</div></div>';
  await withDom(t, "instagram", { profile: instagramProfile(popup) }, async ({ options, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false); assert.equal(closed(), 1);
  });
});

for (const id of ["instagram", "tiktok"]) {
  test(`${id} explicitly selected Followers tab outranks an unrelated Following heading and list identifier`, async t => {
    const popup = `<div role="dialog"><h2>Following</h2><button role="tab" aria-selected="true">Followers</button>
      <button role="tab" aria-selected="false">Following</button><div ${id === "tiktok" ? 'data-e2e="follow-list"' : ""}>${targetRow(id)}</div><div>No more users</div></div>`;
    await withDom(t, id, { profile: id === "tiktok" ? tiktokProfile(popup) : instagramProfile(popup) }, async ({ options, closed, released }) => {
      const progress = [];
      await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
      assert.equal(progress.some(value => value.accounts?.length), false);
      assert.equal(id === "tiktok" ? released() : closed(), 1);
    });
  });
}

test("Facebook clicks the unique own Following tab rather than an earlier excluded same-name article tab", async t => {
  const popup = `<div role="dialog"><h2>Following</h2>${targetRow("facebook")}<div>No more users</div></div>`;
  const profile = `<article><button role="tab" id="article-tab" onclick="window.badClick=true">Following</button></article>
    <main><header><h1>Own account</h1><button role="tab" id="own-following-tab" onclick="${popupOnClick(popup)}">Following</button></header></main><section id="popup-host"></section>`;
  await withDom(t, "facebook", { profile }, async ({ options, clicks, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(value => value.handle), ["target"]);
    assert.deepEqual(clicks, ["own-following-tab"]); assert.equal(closed(), 1);
  });
});

