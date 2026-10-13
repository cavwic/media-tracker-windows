import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { discoverFollowing } from "../lib/following-discovery.mjs";

const binding = { id: "offline-x-binding", platformId: "x", label: "not_the_viewer",
  profileDirectory: "D:\\offline-x-navigation-fixture\\never-opened-profile" };
const profileHref = "/actual_viewer";
const followingHref = `${profileHref}/following`;
const accountSwitcher = '<button data-testid="SideNav_AccountSwitcher_Button"><span>Viewer display name</span><span>@actual_viewer</span></button>';
const profileNavigation = `<header role="banner"><nav aria-label="Primary"><a data-testid="AppTabBar_Profile_Link" href="${profileHref}">Profile</a>${accountSwitcher}</nav></header>`;
const newPostMarker = '<button data-testid="SideNav_NewTweet_Button">Post</button>';
const followingResponse = { data: { user: { result: { timeline: { timeline: { instructions: [
  { type: "TimelineAddEntries", entries: [{ content: { itemContent: { user_results: { result:
    { rest_id: "200", core: { screen_name: "followed_one", name: "Followed person" } } } } } }] },
  { type: "TimelineTerminateTimeline", direction: "Bottom" },
] } } } } } };
const documentFor = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:20px; } nav, main, button, a, span { min-height:20px; } a,span { display:inline-block; }
</style></head><body>${body}</body></html>`;
const revealAfter = (body, delayMs) => `<main id="app">Loading</main><script>setTimeout(() => {
  document.querySelector('#app').outerHTML = ${JSON.stringify(body)};
}, ${delayMs});</script>`;

async function withOfflineX(t, { home = profileNavigation, profile = `${profileNavigation}<main><a href="${followingHref}">1 Following</a></main>`,
  following = '<main><div data-testid="UserCell"><a href="/followed_one">Followed person</a><button>Following</button></div></main>',
  homeDelayMs = 0, profileDelayMs = 0, cookies = [], followingOwner = "100", followingRedirect = "", earlyFollowingResponse = false } = {}, run) {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const routes = [];
  let closed = 0;
  context.on("close", () => { closed += 1; });
  t.after(async () => { await browser.close(); });
  if (cookies.length) await context.addCookies(cookies);
  // Every request, including scripts, is fulfilled locally. No production
  // browser profile or real X page is opened by this fixture.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    routes.push({ pathname: url.pathname, method: route.request().method() });
    if (/\/Following$/.test(url.pathname)) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(followingResponse) });
      return;
    }
    let body;
    if (url.pathname === "/home") body = homeDelayMs ? revealAfter(home, homeDelayMs) : home;
    else if (url.pathname === profileHref) body = profileDelayMs ? revealAfter(profile, profileDelayMs) : profile;
    else if (url.pathname === followingHref) {
      if (followingRedirect) {
        const earlyRequest = earlyFollowingResponse ? `const xhr = new XMLHttpRequest(); xhr.open('GET', '/i/api/graphql/offline_fixture/Following?variables=' +
          encodeURIComponent(JSON.stringify({userId:${JSON.stringify(followingOwner)}})), false); xhr.send();` : "";
        const redirectedBody = `${profileNavigation}<main><div data-testid="UserCell"><a href="/foreign_target">Foreign target</a><button>Following</button></div></main>
          <script>${earlyRequest} history.replaceState(null, '', ${JSON.stringify(followingRedirect)});</script>`;
        await route.fulfill({ status: 200, contentType: "text/html", body: documentFor(redirectedBody) });
        return;
      }
      body = `${following}<script>
        setTimeout(() => fetch('/i/api/graphql/offline_fixture/Following?variables=' + encodeURIComponent(JSON.stringify({userId:${JSON.stringify(followingOwner)}}))), 20);
      </script>`;
    }
    else { await route.fulfill({ status: 404, contentType: "text/plain", body: "Unplanned offline fixture request" }); return; }
    await route.fulfill({ status: 200, contentType: "text/html", body: documentFor(body) });
  });
  const options = { platform: { id: "x" }, linkedAccount: binding,
    browserType: { launchPersistentContext: async (directory, launchOptions) => {
      assert.equal(directory, binding.profileDirectory);
      assert.equal(launchOptions.headless, true);
      assert.equal(launchOptions.executablePath, BACKGROUND_CHROMIUM_EXECUTABLE);
      return context;
    } }, settleMs: 20, navigationTimeoutMs: 1200, maxDurationMs: 7000, maxPages: 30 };
  return run({ page, context, routes, options, closed: () => closed });
}

test("X waits for asynchronously hydrated own navigation and following profile entry", async t => {
  await withOfflineX(t, { homeDelayMs: 400, profileDelayMs: 400 }, async ({ options, routes, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.accounts.map(account => account.handle), ["followed_one"]);
    assert.equal(result.selfProfileUrl, `https://x.com${profileHref}`);
    assert.deepEqual(routes.filter(route => !route.pathname.includes("/i/api/")).map(route => route.pathname), ["/home", profileHref, followingHref]);
    assert.equal(closed(), 1);
  });
});

test("X own profile navigation supports aria labels without legacy profile link test ID", async t => {
  const home = `<header role="banner"><nav aria-label="Primary"><a href="${profileHref}" aria-label="Profile"><svg width="24" height="24"></svg></a>${newPostMarker}</nav></header>`;
  await withOfflineX(t, { home }, async ({ options }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete");
    assert.equal(result.selfProfileUrl, `https://x.com${profileHref}`);
    assert.equal(result.accounts[0].handle, "followed_one");
  });
});

test("X own profile navigation supports a Profile SVG label inside the main nav anchor", async t => {
  const home = `<header role="banner"><nav aria-label="Primary"><a href="${profileHref}"><svg aria-label="Profile" width="24" height="24"></svg></a>${newPostMarker}</nav></header>`;
  await withOfflineX(t, { home }, async ({ options }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.selfProfileUrl, `https://x.com${profileHref}`);
    assert.equal(result.completeness, "complete");
  });
});

test("X own profile test ID may be nested inside the actual navigation anchor", async t => {
  const home = `<header role="banner"><nav aria-label="Primary"><a href="${profileHref}"><span data-testid="AppTabBar_Profile_Link">Profile</span></a>${newPostMarker}</nav></header>`;
  await withOfflineX(t, { home }, async ({ options }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.selfProfileUrl, `https://x.com${profileHref}`);
    assert.equal(result.completeness, "complete");
  });
});

test("X online account switcher uniquely identifies the viewer independently of the binding label", async t => {
  await withOfflineX(t, { home: `<header role="banner"><nav>${accountSwitcher}</nav></header>` }, async ({ options, routes }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete");
    assert.equal(result.selfProfileUrl, `https://x.com${profileHref}`);
    assert.equal(routes.some(route => route.pathname.includes(binding.label)), false);
    assert.equal(JSON.stringify(result).includes(binding.profileDirectory), false);
  });
});

test("X never infers the current viewer from article authors or account-switching menu entries", async t => {
  const home = `<header role="banner"><nav>${newPostMarker}<button data-testid="SideNav_AccountSwitcher_Button">Account menu</button></nav></header>
    <article><a href="/article_author" aria-label="Profile">@article_author</a></article>
    <div role="menu"><a href="/another_login" aria-label="Profile">@another_login</a></div>`;
  await withOfflineX(t, { home }, async ({ options, routes, closed }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 180 }), { code: "self-profile-unavailable" });
    assert.deepEqual(routes.map(route => route.pathname), ["/home"]);
    assert.equal(closed(), 1);
  });
});

test("X refuses ambiguous account switcher handles instead of guessing a login identity", async t => {
  const home = '<button data-testid="SideNav_AccountSwitcher_Button"><span>@first_login</span><span>@second_login</span></button>';
  await withOfflineX(t, { home }, async ({ options, routes }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 180 }), { code: "self-profile-unavailable" });
    assert.deepEqual(routes.map(route => route.pathname), ["/home"]);
  });
});

test("X a stale own navigation handle conflicting with the live account switcher is not trusted", async t => {
  const home = `<header role="banner"><nav><a data-testid="AppTabBar_Profile_Link" href="/stale_viewer">Profile</a>${accountSwitcher}</nav></header>`;
  await withOfflineX(t, { home }, async ({ options, routes }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 180 }), { code: "self-profile-unavailable" });
    assert.deepEqual(routes.map(route => route.pathname), ["/home"]);
  });
});

test("X navigation does not mistake the home Following feed tab for the viewer's following list", async t => {
  const home = `${profileNavigation}<main><a role="tab" aria-selected="true" href="/home">Following</a></main>`;
  await withOfflineX(t, { home }, async ({ options, routes }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete");
    assert.deepEqual(routes.filter(route => !route.pathname.includes("/i/api/")).map(route => route.pathname), ["/home", profileHref, followingHref]);
  });
});

test("X a foreign following link or generic Following tab cannot redirect the import to someone else", async t => {
  const profile = `${profileNavigation}<main><a href="/foreign_owner/following">5 Following</a>
    <a role="tab" href="/foreign_owner/following">Following</a></main>`;
  await withOfflineX(t, { profile }, async ({ options, routes, closed }) => {
    const result = await discoverFollowing({ ...options, navigationTimeoutMs: 180 });
    assert.equal(result.completeness, "complete");
    assert.equal(routes.some(route => route.pathname === followingHref), true);
    assert.equal(routes.some(route => route.pathname.startsWith("/foreign_owner")), false);
    assert.equal(closed(), 1);
  });
});

test("X cached viewer ID alone does not identify a session without online authenticated navigation", async t => {
  await withOfflineX(t, { home: '<main><article><a href="/actual_viewer">@actual_viewer</a></article></main>',
    cookies: [{ name: "twid", value: "u%3D100", domain: ".x.com", path: "/" }] }, async ({ options, routes }) => {
    await assert.rejects(discoverFollowing({ ...options, navigationTimeoutMs: 180 }), { code: "self-profile-unavailable" });
    assert.deepEqual(routes.map(route => route.pathname), ["/home"]);
  });
});

test("X rejects a following page SPA redirect to a different owner's route without importing its users", async t => {
  await withOfflineX(t, { followingRedirect: "/foreign_owner/following" }, async ({ page, options, routes, closed }) => {
    await assert.rejects(discoverFollowing(options), { code: "following-list-unavailable" });
    assert.equal(new URL(page.url()).pathname, "/foreign_owner/following");
    assert.equal(routes.some(route => route.pathname.includes("/i/api/")), false);
    assert.equal(closed(), 1);
  });
});

test("X a fast following response cannot publish users before its own following route is confirmed", async t => {
  await withOfflineX(t, { followingRedirect: "/foreign_owner/following", earlyFollowingResponse: true,
    cookies: [{ name: "twid", value: "u%3D100", domain: ".x.com", path: "/" }] }, async ({ options, routes, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: result => progress.push(result) }), { code: "following-list-unavailable" });
    assert.equal(routes.some(route => /\/Following$/.test(route.pathname)), true);
    assert.equal(progress.some(result => result.accounts?.length > 0), false);
    assert.equal(closed(), 1);
  });
});

test("X authenticated viewer UID excludes a following response whose requested owner is different", async t => {
  await withOfflineX(t, { following: "<main>No visible users yet</main>", followingOwner: "999",
    cookies: [{ name: "twid", value: "u%3D100", domain: ".x.com", path: "/" }] }, async ({ options, routes, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, maxPages: 3, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false);
    assert.equal(routes.some(route => /\/Following$/.test(route.pathname)), true);
    assert.equal(closed(), 1);
  });
});

test("X abort during delayed identity hydration promptly closes only the fixture context", async t => {
  await withOfflineX(t, { homeDelayMs: 10000 }, async ({ options, routes, closed }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(discoverFollowing({ ...options, signal: controller.signal }), { name: "AbortError" }); }
    finally { clearTimeout(timer); }
    assert.equal(closed(), 1);
    assert.equal(routes.some(route => route.pathname === followingHref), false);
  });
});

