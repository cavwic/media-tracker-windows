import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { discoverFollowing } from "../lib/following-discovery.mjs";

// Regression fixtures deliberately contain no captured credentials or response
// bodies. The Instagram self-href counter and Facebook web-host redirect are
// based on observed authenticated DOM/navigation; nested rows, hidden dialogs,
// mutual-follow actions and delay are explicit synthetic robustness cases.
// Every request, including documents and list responses, is fulfilled locally.
const viewer = "fixture_viewer";
const linked = id => ({ id: `real-layout-fixture-${id}`, platformId: id, label: "not_a_username",
  profileDirectory: "D:\\offline-following-real-layout\\never-opened-profile" });
const html = body => `<!doctype html><meta charset="utf-8"><style>
  body{margin:16px}div,main,section,header,nav{min-height:20px}a,button,span{display:inline-block;min-height:20px}
  [hidden]{display:none!important}</style>${body}`;
const home = id => id === "instagram"
  ? `<nav><a href="/direct/inbox/">Inbox</a><a href="/${viewer}/" aria-label="Profile">Own profile</a></nav>`
  : id === "facebook" ? '<button role="button" aria-label="Account">Account</button>'
    : `<nav><a data-e2e="nav-profile" href="/@${viewer}">Profile</a></nav>`;
const profilePath = id => id === "facebook" ? "/profile.php?id=123" : `/${id === "tiktok" ? "@" : ""}${viewer}${id === "instagram" ? "/" : ""}`;
function rows(id, count, { action = "Following", nested = false, recommendations = true } = {}) {
  const prefix = id === "tiktok" ? "@" : "";
  const row = index => nested
    ? `<div class="row"><div class="identity"><div><a href="/${prefix}target_${index}/">Target ${index}</a></div></div>
      <div class="actions"><div class="action-wrapper"><div><button>${action}</button></div></div></div></div>`
    : `<div role="listitem" data-e2e="user-list-item"><a href="/${prefix}target_${index}/">Target ${index}</a><button>${action}</button></div>`;
  return `${Array.from({ length: count }, (_, index) => row(index + 1)).join("")}${recommendations
    ? `<div role="listitem"><a href="/${prefix}not_followed/">Recommended account</a><button>Follow</button></div>` : ""}`;
}
function instagramProfile({ count = 7, nested = true, hiddenDialog = false, delayMs = 0 } = {}) {
  const content = `<div role="dialog" aria-label="Following"><h2>Following</h2><div>${rows("instagram", count, { nested })}</div></div>`;
  return `${hiddenDialog ? '<div role="dialog" hidden><h2>Notifications</h2><div role="listitem"><a href="/wrong_hidden_dialog/">Wrong account</a><button>Following</button></div></div>' : ""}
    <main><header><h1>${viewer}</h1><div><a role="link" href="/${viewer}/" id="following-counter"
      onclick="event.preventDefault();window.followingCounterClicked=true;setTimeout(()=>document.querySelector('#list-host').innerHTML=${JSON.stringify(content).replace(/"/g, "&quot;")},${delayMs})"><span>${count}</span><span>关注</span></a></div></header>
      <article><a href="/unrelated_author/">Post author</a><button>Following</button></article></main><section id="list-host"></section>`;
}

async function withFixture(t, id, { profile, homeBody, redirectFacebook = false, followingPayload, followingDelayMs = 0 } = {}, run) {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests = [], clicks = [];
  let closeCount = 0, releaseCount = 0;
  context.on("close", () => { closeCount += 1; });
  t.after(async () => browser.close());
  await context.exposeBinding("observeFixtureClick", (_source, text) => clicks.push(text));
  await context.addInitScript(() => document.addEventListener("click", event => {
    window.observeFixtureClick((event.target.closest("a,button,[role=link]")?.textContent || "").trim());
  }));
  if (id === "facebook") await context.addCookies([{ name: "c_user", value: "123", domain: ".facebook.com", path: "/" }]);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    requests.push({ host: url.hostname, path: url.pathname, query: url.search, method: route.request().method() });
    if (id === "facebook" && redirectFacebook && url.hostname === "www.facebook.com") {
      // Playwright routing only handles the first request in an HTTP redirect
      // chain. A local-script navigation guarantees the destination is routed
      // and fulfilled too, so this fixture cannot contact the real web host.
      await route.fulfill({ contentType: "text/html", body: html(`<script>location.replace(${JSON.stringify(`https://web.facebook.com${url.pathname}${url.search}`)})</script>`) }); return;
    }
    if (url.pathname === "/api/graphql/") {
      if (followingDelayMs) await new Promise(resolve => setTimeout(resolve, followingDelayMs));
      await route.fulfill({ contentType: "application/json", body: `for (;;);${JSON.stringify(followingPayload)}` }); return;
    }
    let body;
    if (url.pathname === "/") body = homeBody ?? home(id);
    else if (id === "facebook" && url.pathname === "/profile.php" && url.searchParams.get("id") === "123") {
      const sk = url.searchParams.get("sk");
      body = sk === "friends" ? '<main><a role="link" href="/profile.php?id=123&amp;sk=following">Following</a></main>'
        : sk === "following" ? `<main><h2>Following</h2>${rows(id, 2, { action: "Friends" })}</main><script>fetch('/api/graphql/')</script>`
          : profile ?? '<main><header><h1>Own account</h1><a role="link" href="/profile.php?id=123&amp;sk=friends">Friends</a></header></main>';
    } else if (url.pathname.replace(/\/$/, "") === profilePath(id).replace(/\/$/, "")) body = profile;
    else { await route.fulfill({ status: 404, body: "Unplanned offline fixture request" }); return; }
    await route.fulfill({ contentType: "text/html", body: html(body || "") });
  });
  const options = { platform: { id }, linkedAccount: linked(id), settleMs: 50, navigationTimeoutMs: 1800,
    maxDurationMs: 12_000, maxPages: 160, browserType: { launchPersistentContext: async (directory, launchOptions) => {
      assert.equal(directory, linked(id).profileDirectory); assert.equal(launchOptions.headless, true); return context;
    } }, acquireTikTokPage: async input => {
      assert.equal(input.purpose, "following"); return { context, page, markHomeWarmupComplete: async () => {},
        release: async () => { releaseCount += 1; await page.close(); } };
    } };
  return run({ options, context, page, requests, clicks, closed: () => closeCount, released: () => releaseCount });
}

test("observed Instagram self-href role=link counter opens its Following dialog without guessing a route", async t => {
  await withFixture(t, "instagram", { profile: instagramProfile() }, async ({ options, requests, clicks, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.equal(result.accounts.length, 7);
    assert.deepEqual(result.accounts.map(account => account.handle).sort(), Array.from({ length: 7 }, (_, index) => `target_${index + 1}`));
    assert.equal(requests.some(request => /\/following\/?$/.test(request.path)), false);
    assert.deepEqual(clicks, ["7关注"]); assert.equal(closed(), 1);
  });
});

test("Instagram ignores an earlier hidden non-list dialog and traverses bounded nested Following rows", async t => {
  await withFixture(t, "instagram", { profile: instagramProfile({ hiddenDialog: true }) }, async ({ options, clicks }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.equal(result.accounts.length, 7);
    assert.equal(result.accounts.some(account => ["wrong_hidden_dialog", "not_followed", "unrelated_author"].includes(account.handle)), false);
    assert.deepEqual(clicks, ["7关注"]);
  });
});

test("Instagram first list load slower than four seconds is awaited before no-growth detection", async t => {
  await withFixture(t, "instagram", { profile: instagramProfile({ count: 1, nested: true, delayMs: 4700 }) }, async ({ options, clicks }) => {
    const result = await discoverFollowing({ ...options, navigationTimeoutMs: 7000 });
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(account => account.handle), ["target_1"]);
    assert.deepEqual(clicks, ["1关注"]);
  });
});

test("a generic Following mutation control is never used as the missing Instagram counter", async t => {
  const profile = `<main><header><h1>${viewer}</h1><button onclick="window.unfollowed=true">Following</button></header>
    <a role="link" href="/${viewer}/" onclick="window.unknownClicked=true">Own account</a></main>`;
  await withFixture(t, "instagram", { profile }, async ({ options, clicks }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 100 }), { code: "following-list-unavailable" });
    assert.deepEqual(clicks, []);
  });
});

test("observed Facebook web-host redirect retains its authenticated numeric own profile and Friends navigation", async t => {
  const followingPayload = { data: { following: { edges: [1, 2].map(index => ({ node: {
    url: `https://web.facebook.com/target_${index}`, name: `Target ${index}` } })), page_info: { has_next_page: false } } } };
  await withFixture(t, "facebook", { redirectFacebook: true, followingPayload }, async ({ options, requests, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(account => account.handle).sort(), ["target_1", "target_2"]);
    assert.equal(new URL(result.selfProfileUrl).searchParams.get("id"), "123");
    assert.equal(requests.some(request => request.host === "web.facebook.com" && request.query === "?id=123&sk=friends"), true);
    assert.equal(requests.some(request => request.host === "web.facebook.com" && request.query === "?id=123&sk=following"), true);
    assert.equal(closed(), 1);
  });
});

test("TikTok mutual Friend actions in a visible own Following dialog count as existing relationships", async t => {
  const content = `<div role="dialog" aria-label="Following"><h2>Following</h2>${rows("tiktok", 2, { action: "Friends", nested: true })}</div>`;
  const profile = `<main><header><h1>${viewer}</h1><button onclick="document.querySelector('#list-host').innerHTML=${JSON.stringify(content).replace(/"/g, "&quot;")}">
    <span data-e2e="following-count">2</span> Following</button></header></main><section id="list-host"></section>`;
  await withFixture(t, "tiktok", { profile }, async ({ options, clicks, released }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(account => account.handle).sort(), ["target_1", "target_2"]);
    assert.equal(result.accounts.some(account => account.handle === "not_followed"), false);
    assert.equal(clicks.length, 1); assert.equal(released(), 1);
  });
});

test("cancelling the initial slow dialog load closes its owned browser before publishing candidates", async t => {
  await withFixture(t, "instagram", { profile: instagramProfile({ count: 1, delayMs: 6000 }) }, async ({ options, clicks, closed }) => {
    const controller = new AbortController(), progress = [];
    const timer = setTimeout(() => controller.abort(), 250);
    try { await assert.rejects(discoverFollowing({ ...options, signal: controller.signal, navigationTimeoutMs: 7000,
      onProgress: entry => progress.push(entry) }), { name: "AbortError" }); }
    finally { clearTimeout(timer); }
    assert.equal(progress.some(entry => entry.accounts?.length), false); assert.equal(closed(), 1);
    assert.equal(clicks.length <= 1, true);
  });
});

const hydration = data => `<script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: data })}</script>`;
const authenticatedTikTokHome = (uid = "123") => `${home("tiktok")}${hydration({ "webapp.app-context": {
  userInfo: { user: { uid, uniqueId: viewer } } } })}`;
function tiktokZeroProfile({ uid = "123", uniqueId = viewer, count = 0, statusCode = 0, hydrated = true, nonEmpty = false } = {}) {
  const content = `<div role="dialog" aria-label="Following"><h2>Following</h2>${nonEmpty ? rows("tiktok", 2, { action: "Friends", nested: true }) : ""}<div>No more users</div></div>`;
  return `<main><header><h1>${viewer}</h1><button onclick="document.querySelector('#list-host').innerHTML=${JSON.stringify(content).replace(/"/g, "&quot;")}">
    <span data-e2e="following-count">0</span> Following</button></header></main><section id="list-host"></section>${hydrated
    ? hydration({ "webapp.user-detail": { statusCode, userInfo: { user: { id: uid, uniqueId }, stats: { followingCount: count } } } }) : ""}`;
}

test("TikTok zero is confirmed only by successful same-route profile hydration matching the online viewer UID", async t => {
  await withFixture(t, "tiktok", { homeBody: authenticatedTikTokHome(), profile: tiktokZeroProfile() }, async ({ options, clicks, released }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts, []);
    assert.match(result.message, /平台已确认/); assert.deepEqual(clicks, []); assert.equal(released(), 1);
  });
});

for (const [name, profileOptions, homeBody] of [
  ["foreign UID", { uid: "999" }, authenticatedTikTokHome()],
  ["foreign profile handle", { uniqueId: "foreign_owner" }, authenticatedTikTokHome()],
  ["unsuccessful profile response", { statusCode: 403 }, authenticatedTikTokHome()],
  ["missing profile hydration", { hydrated: false }, authenticatedTikTokHome()],
  ["missing online viewer UID", {}, home("tiktok")],
]) {
  test(`TikTok visible zero with ${name} is not accepted as an empty complete list`, async t => {
    // No terminal marker: this represents a failed/unloaded list, not an
    // explicitly empty relationship response. Invalid profile proof must not
    // let the placeholder counter short-circuit this state into success.
    const profile = tiktokZeroProfile(profileOptions).replace("<div>No more users</div>", "<div>Loading accounts</div>");
    await withFixture(t, "tiktok", { homeBody, profile }, async ({ options, clicks, released }) => {
      const progress = [];
      await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 200,
        onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
      assert.equal(progress.some(value => value.accounts?.length), false);
      assert.equal(clicks.length, 1); assert.equal(released(), 1);
    });
  });
}

test("TikTok UI placeholder zero cannot hide a hydrated nonzero Following list", async t => {
  await withFixture(t, "tiktok", { homeBody: authenticatedTikTokHome(), profile: tiktokZeroProfile({ count: 2, nonEmpty: true }) }, async ({ options, clicks, released }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(account => account.handle).sort(), ["target_1", "target_2"]);
    assert.equal(clicks.length, 1); assert.equal(released(), 1);
  });
});

