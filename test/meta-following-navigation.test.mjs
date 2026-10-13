import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { discoverFollowing } from "../lib/following-discovery.mjs";

const domains = { instagram: "www.instagram.com", facebook: "www.facebook.com", tiktok: "www.tiktok.com", threads: "www.threads.com" };
const viewerHandle = "actual_viewer";
const linked = id => ({ id: `offline-${id}`, platformId: id, label: "not_the_viewer",
  profileDirectory: "D:\\offline-meta-following-fixture\\never-opened-profile" });
const documentFor = body => `<!doctype html><meta charset="utf-8"><style>body{margin:20px}a,button,span,div,header,nav{min-height:20px}a,span{display:inline-block}</style>${body}`;
const delayed = (body, ms) => ms ? `<main id="loading">Loading</main><script>setTimeout(()=>document.querySelector('#loading').outerHTML=${JSON.stringify(body).replace(/<\/script/gi, "<\\/script")},${ms})</script>` : body;
const rows = id => `<div role="dialog"><h2>Following</h2><div role="listitem" data-e2e="user-list-item">
  <a href="/${["tiktok", "threads"].includes(id) ? "@" : ""}followed_one/">Followed person</a><button>Following</button></div>
  <div role="listitem"><a href="/${["tiktok", "threads"].includes(id) ? "@" : ""}recommended/">Recommended</a><button>Follow</button></div></div>`;
const payload = id => id === "instagram" ? { users: [{ username: "followed_one", full_name: "Followed person" }], has_more: false }
  : id === "tiktok" ? { userList: [{ user: { uniqueId: "followed_one", nickname: "Followed person" } }], hasMore: false }
  : { data: { following: { edges: [{ node: id === "facebook" ? { url: "https://www.facebook.com/followed_one", name: "Followed person" }
    : { user: { username: "followed_one", full_name: "Followed person" } } }], page_info: { has_next_page: false } } } };
const apiFor = (id, owner = "123") => id === "instagram" ? `/api/v1/friendships/${owner}/following/`
  : id === "tiktok" ? `/api/user/list/?userId=${owner}` : "/api/graphql/";
const homeFor = (id, { avatarAlt = `${viewerHandle}'s profile picture`, tiktokViewerKey = "userInfo", hydrate = true } = {}) => {
  if (id === "instagram") return `<nav><a href="/direct/inbox/">Inbox</a><a href="/${viewerHandle}/"><img src="/fixture-avatar.png" width="24" height="24" alt="${avatarAlt}">Opaque actual display name</a></nav>`;
  if (id === "facebook") return '<button role="button" aria-label="Account">Opaque actual name</button>';
  if (id === "threads") return `<nav><a href="/activity">Activity</a><a href="/@${viewerHandle}" aria-label="Profile">Opaque actual name</a></nav>`;
  const viewer = { uid: "123", uniqueId: viewerHandle };
  const data = { __DEFAULT_SCOPE__: { "webapp.app-context": tiktokViewerKey === "userInfo" ? { userInfo: { user: viewer } } : { [tiktokViewerKey]: viewer } } };
  return `<div data-e2e="profile-icon"><a href="/@${viewerHandle}">Opaque actual name</a></div>${hydrate
    ? `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>` : ""}`;
};
const profileFor = (id, api) => id === "tiktok" ? `<main><button onclick="document.querySelector('#list').hidden=false;fetch('${api}')"><span data-e2e="following-count">1</span> Following</button><div id="list" hidden>${rows(id)}</div></main>`
  : id === "threads" ? `<header><button data-pressable-container="true">Settings</button><button data-pressable-container="true"
    onclick="document.querySelector('#popup').hidden=false;setTimeout(()=>document.querySelector('#following-tab').hidden=false,400)">3 followers</button></header>
    <div id="popup" role="dialog" hidden><button id="following-tab" role="tab" aria-selected="true" hidden
    onclick="document.querySelector('#list').hidden=false;fetch('${api}')">Following</button><div id="list" hidden>${rows(id)}</div></div>`
    : `<main><a href="/${viewerHandle}/following/" onclick="event.preventDefault();document.querySelector('#list').hidden=false;fetch('${api}')">1 Following</a><div id="list" hidden>${rows(id)}</div></main>`;

async function withOffline(t, id, { home, profile, homeDelayMs = 0, profileDelayMs = 0, owner = "123", cookies,
  profileRedirect = "", followingRedirect = "", friendsDelayMs = 0, facebookVanity = false } = {}, run) {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const routes = [], clicks = [];
  let closeCount = 0, releases = 0;
  context.on("close", () => { closeCount += 1; });
  t.after(async () => browser.close());
  await context.exposeBinding("fixtureClick", (_source, text) => clicks.push(text));
  await context.addInitScript(() => document.addEventListener("click", event => window.fixtureClick((event.target.closest("a,button")?.textContent || "").trim())));
  if (cookies || id === "facebook") await context.addCookies(cookies || [{ name: "c_user", value: "123", domain: ".facebook.com", path: "/" }]);
  const ownPath = id === "facebook" ? facebookVanity ? `/${viewerHandle}` : "/profile.php" : `/${["threads", "tiktok"].includes(id) ? "@" : ""}${viewerHandle}${id === "instagram" ? "/" : ""}`;
  const api = apiFor(id, owner);
  // Every document, image and list request is fulfilled locally; this never
  // opens real profiles or sends requests to the platforms under test.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    routes.push({ path: url.pathname, query: url.search, method: route.request().method() });
    if (url.pathname === "/fixture-avatar.png") { await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>' }); return; }
    if (/friendships|user\/list|graphql/.test(url.pathname)) { await route.fulfill({ contentType: "application/json",
      body: `${id === "facebook" ? "for (;;);" : ""}${JSON.stringify(payload(id))}` }); return; }
    let body;
    if (url.pathname === "/") body = delayed(home ?? homeFor(id), homeDelayMs);
    else if (url.pathname === ownPath || id === "facebook" && facebookVanity && ["friends", "friends_following"].some(suffix => url.pathname === `${ownPath}/${suffix}`)) {
      if (id === "facebook") {
        const sk = url.searchParams.get("sk") || (url.pathname.endsWith("/friends") ? "friends" : url.pathname.endsWith("/friends_following") ? "following" : "");
        const followingHref = facebookVanity ? `${ownPath}/friends_following` : "/profile.php?id=123&sk=following";
        const friendsHref = facebookVanity ? `${ownPath}/friends` : "/profile.php?id=123&sk=friends";
        body = sk === "friends" ? delayed(`<main><a href="${followingHref}">Following</a></main>`, friendsDelayMs)
          : sk === "following" ? `${rows(id)}<script>fetch('${api}')</script>`
            : profile ?? `<main><a href="${friendsHref}">Friends</a></main>`;
      } else body = profile ?? profileFor(id, api);
      if (!url.searchParams.get("sk")) body = delayed(body, profileDelayMs);
      if (profileRedirect) body += `<script>history.replaceState(null,'',${JSON.stringify(profileRedirect)})</script>`;
      if (followingRedirect && id === "instagram") body += `<script>document.querySelector('a[href$="following/"]').onclick=()=>{
        const xhr=new XMLHttpRequest();xhr.open('GET',${JSON.stringify(api)},false);xhr.send();history.replaceState(null,'',${JSON.stringify(followingRedirect)});return false;}</script>`;
    } else { await route.fulfill({ status: 404, contentType: "text/plain", body: "Unplanned local fixture request" }); return; }
    await route.fulfill({ contentType: "text/html", body: documentFor(body) });
  });
  const options = { platform: { id }, linkedAccount: linked(id), settleMs: 20, navigationTimeoutMs: 1600,
    maxDurationMs: 8000, maxPages: 40, browserType: { launchPersistentContext: async (directory, args) => {
      assert.equal(directory, linked(id).profileDirectory); assert.equal(args.headless, true); return context;
    } }, acquireTikTokPage: async input => {
      assert.equal(input.purpose, "following"); return { context, page, markHomeWarmupComplete: async () => {},
        release: async () => { releases += 1; await page.close(); } };
    } };
  return run({ context, page, routes, clicks, options, closed: () => closeCount, releases: () => releases });
}

test("Instagram waits for delayed authenticated avatar navigation and its separate following entry", async t => {
  await withOffline(t, "instagram", { homeDelayMs: 400, profileDelayMs: 400 }, async ({ options, routes, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.equal(result.selfProfileUrl, `https://www.instagram.com/${viewerHandle}/`);
    assert.equal(routes.some(route => route.path.includes("not_the_viewer")), false); assert.equal(closed(), 1);
  });
});

test("Instagram accepts its own Chinese navigation avatar with an opaque display name", async t => {
  await withOffline(t, "instagram", { home: homeFor("instagram", { avatarAlt: `${viewerHandle}的头像` }) }, async ({ options }) => {
    const result = await discoverFollowing(options); assert.equal(result.accounts[0].handle, "followed_one");
  });
});

test("Instagram aria-only Profile navigation does not depend on its visible display name", async t => {
  const home = `<nav><a href="/direct/inbox/">Inbox</a><a href="/${viewerHandle}/" aria-label="Profile">Opaque name</a></nav>`;
  await withOffline(t, "instagram", { home }, async ({ options }) => assert.equal((await discoverFollowing(options)).completeness, "complete"));
});

test("Instagram plain-div sidebar jointly identifies its username avatar from visible own navigation", async t => {
  const home = `<div id="sidebar"><div><a href="/direct/inbox/">Messages</a><a href="/explore/">Explore</a>
    <a href="/${viewerHandle}/"><img width="24" height="24" src="/fixture-avatar.png" alt="${viewerHandle}'s profile picture">Opaque display name</a></div></div>
    <main><a href="/recommendation/" aria-label="Profile">Profile</a><article>Feed content</article></main>`;
  await withOffline(t, "instagram", { home }, async ({ options, routes }) => {
    const result = await discoverFollowing(options); assert.equal(result.completeness, "complete");
    assert.equal(result.selfProfileUrl, `https://www.instagram.com/${viewerHandle}/`);
    assert.equal(routes.some(route => route.path.startsWith("/recommendation")), false);
  });
});

test("Instagram full app div and a main recommendation Profile action cannot serve as the own sidebar", async t => {
  const home = '<div><a href="/direct/inbox/">Inbox</a><a href="/explore/">Explore</a><main>'
    + '<a href="/recommendation/" aria-label="Profile">Profile</a><a href="/recommendation/"><img width="24" height="24" src="/fixture-avatar.png" alt="recommendation\'s profile picture">Recommendation</a></main></div>';
  await withOffline(t, "instagram", { home }, async ({ options, routes }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 100 }), { code: "self-profile-unavailable" });
    assert.equal(routes.some(route => route.path.startsWith("/recommendation")), false);
  });
});

test("Instagram refuses article authors and recommendation avatars as the current viewer", async t => {
  const home = '<a href="/direct/inbox/">Inbox</a><article><a href="/foreign_author/" aria-label="Profile">Profile</a></article>'
    + '<aside><a href="/foreign_recommendation/"><img src="/fixture-avatar.png" width="24" height="24" alt="foreign_recommendation\'s profile picture"></a></aside>';
  await withOffline(t, "instagram", { home }, async ({ options, routes }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 120 }), { code: "self-profile-unavailable" });
    assert.equal(routes.some(route => route.path !== "/" && route.path !== "/fixture-avatar.png"), false);
  });
});

test("Instagram rejects cached viewer cookies without visible online authenticated navigation", async t => {
  await withOffline(t, "instagram", { home: `<a href="/${viewerHandle}/" aria-label="Profile">Profile</a>`,
    cookies: [{ name: "ds_user_id", value: "123", domain: ".instagram.com", path: "/" }] }, async ({ options }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 100 }), { code: "self-profile-unavailable" });
  });
});

test("Instagram zero-following count on a redirected foreign profile is not treated as complete", async t => {
  await withOffline(t, "instagram", { profile: '<a href="/foreign_owner/following/">0 Following</a>', profileRedirect: "/foreign_owner/" }, async ({ options }) => {
    await assert.rejects(discoverFollowing(options), { code: "following-list-unavailable" });
  });
});

test("Instagram late own UI with another owner ID cannot import its following response", async t => {
  await withOffline(t, "instagram", { owner: "999", profile: `<a href="/${viewerHandle}/following/" onclick="event.preventDefault();fetch('${apiFor("instagram", "999")}')">Following</a>`,
    cookies: [{ name: "ds_user_id", value: "123", domain: ".instagram.com", path: "/" }] }, async ({ options, routes, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, maxPages: 3, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false);
    assert.equal(routes.some(route => route.path === "/api/v1/friendships/999/following/"), true);
    assert.equal(closed(), 1);
  });
});

test("Instagram fast list response cannot publish accounts before own destination confirmation", async t => {
  await withOffline(t, "instagram", { followingRedirect: "/foreign_owner/following/" }, async ({ options }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: entry => progress.push(entry) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(entry => entry.accounts?.length), false);
  });
});

test("Instagram does not click an existing generic Following action when the profile list entry is missing", async t => {
  await withOffline(t, "instagram", { profile: '<main><button onclick="window.unfollowed=true">Following</button><a href="/foreign_owner/following/">Following</a></main>' }, async ({ options, clicks }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 120 }), { code: "following-list-unavailable" });
    assert.deepEqual(clicks, []);
  });
});

test("Facebook waits for delayed Account marker and its own Friends then Following navigation", async t => {
  await withOffline(t, "facebook", { homeDelayMs: 400, profileDelayMs: 300, friendsDelayMs: 400 }, async ({ options, routes, closed }) => {
    const result = await discoverFollowing(options); assert.equal(result.completeness, "complete");
    assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.equal(result.selfProfileUrl, "https://www.facebook.com/profile.php?id=123");
    assert.equal(routes.some(route => route.query === "?id=123&sk=friends"), true);
    assert.equal(routes.some(route => route.query === "?id=123&sk=following"), true); assert.equal(closed(), 1);
  });
});

test("Facebook cookie plus hidden Account marker is not an authenticated session", async t => {
  await withOffline(t, "facebook", { home: '<button aria-label="Account" style="display:none">Account</button><article><a href="/someone">Someone</a></article>' }, async ({ options }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 100 }), { code: "self-profile-unavailable" });
  });
});

test("Facebook vanity profile navigates through own Friends to friends_following, not another profile", async t => {
  const home = `<nav><a href="/${viewerHandle}" aria-label="Your profile">Opaque display name</a><button aria-label="Account">Account</button></nav>`;
  await withOffline(t, "facebook", { home, facebookVanity: true, friendsDelayMs: 300 }, async ({ options, routes }) => {
    const result = await discoverFollowing(options); assert.equal(result.completeness, "complete");
    assert.equal(result.selfProfileUrl, `https://www.facebook.com/${viewerHandle}`);
    assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.equal(routes.some(route => route.path === `/${viewerHandle}/friends_following`), true);
  });
});

test("TikTok waits for nested app-context viewer and delayed profile counter through its private lease", async t => {
  await withOffline(t, "tiktok", { homeDelayMs: 400, profileDelayMs: 400 }, async ({ options, releases, closed }) => {
    const result = await discoverFollowing(options); assert.equal(result.completeness, "complete");
    assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.equal(result.selfProfileUrl, `https://www.tiktok.com/@${viewerHandle}`); assert.equal(releases(), 1); assert.equal(closed(), 0);
  });
});

test("TikTok accepts user_info app-context hydration without guessing the bound display label", async t => {
  await withOffline(t, "tiktok", { home: homeFor("tiktok", { tiktokViewerKey: "user_info" }) }, async ({ options }) => assert.equal((await discoverFollowing(options)).accounts[0].handle, "followed_one"));
});

test("TikTok own navigation may identify the viewer without a hydration UID", async t => {
  await withOffline(t, "tiktok", { home: homeFor("tiktok", { hydrate: false }) }, async ({ options }) => assert.equal((await discoverFollowing(options)).completeness, "complete"));
});

test("TikTok does not identify a viewer from another user's detail hydration or article link", async t => {
  const home = '<article><a data-e2e="nav-profile" href="/@foreign_owner">Foreign author</a></article>'
    + '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"uid":"123","uniqueId":"foreign_owner"}}}}}</script>';
  await withOffline(t, "tiktok", { home }, async ({ options }) => await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 100 }), { code: "self-profile-unavailable" }));
});

test("Threads waits for its own profile counter then the asynchronously opened Following tab", async t => {
  await withOffline(t, "threads", { homeDelayMs: 300, profileDelayMs: 300 }, async ({ options, clicks }) => {
    const result = await discoverFollowing(options); assert.equal(result.completeness, "complete");
    assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.deepEqual(clicks, ["3 followers", "Following"]);
  });
});

for (const id of ["instagram", "facebook", "tiktok"]) {
  test(`${id} expired online login fails without guessing a profile`, async t => {
    await withOffline(t, id, { home: '<form><input type="password" name="password"><button>Log in</button></form>' }, async ({ options, routes }) => {
      await assert.rejects(discoverFollowing(options), { code: "login-required" });
      assert.deepEqual(routes.map(route => route.path), ["/"]);
    });
  });
  test(`${id} cancellation during delayed readiness closes only its private owned work`, async t => {
    await withOffline(t, id, { homeDelayMs: 10_000 }, async ({ options, closed, releases, routes }) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
      try { await assert.rejects(discoverFollowing({ ...options, signal: controller.signal }), { name: "AbortError" }); }
      finally { clearTimeout(timer); }
      assert.equal(id === "tiktok" ? releases() : closed(), 1); assert.equal(routes.every(route => route.path === "/"), true);
    });
  });
}

