import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { discoverFollowing } from "../lib/following-discovery.mjs";

// The selected Following tab inside ProfileAppSection_0 and plain div cards
// with separate avatar/name anchors and a friends-more control are based on
// the observed current Facebook layout. All identities are fictional and all
// requests are locally fulfilled; adversarial scopes below are regression
// fixtures, not a dump of the user's page or login data.
const ownId = "123";
const own = `/profile.php?id=${ownId}`;
const following = `${own}&sk=following`, friends = `${own}&sk=friends`;
const html = body => `<!doctype html><meta charset="utf-8"><style>
  body{margin:20px}div,main,header,section,article{min-height:20px}a,span,button{display:inline-block;min-height:20px}
  [hidden]{display:none!important}</style>${body}`;
const tab = (name, selected = false, href = following) => `<a role="tab" aria-selected="${selected}" href="${href.replace(/&/g, "&amp;")}">${name}</a>`;
const card = (handle = "known_target", name = "Known target") => `<div class="plain-following-card">
  <div><a href="/${handle}/"><span class="avatar"></span></a></div><div><a href="/${handle}/">${name}</a></div>
  <div role="button" aria-label="好友名单更多选项">More</div><div><a href="/${handle}/"><span class="avatar-copy"></span></a></div></div>`;
const semanticRow = handle => `<div role="listitem"><a href="/${handle}/">${handle}</a><button>Following</button></div>`;
function followingPage({ selected = "Following", within = "", outside = "", legacyRow = false, ambiguous = false } = {}) {
  const selectedTabs = `${tab("Following", selected === "Following")}${tab("Followers", selected === "Followers", `${own}&sk=followers`)}`;
  return `<main><div data-pagelet="ProfileAppSection_0"><h2>Friends</h2><div role="tablist">${selectedTabs}</div>
    ${card()}${legacyRow ? semanticRow("followers_only") : ""}${within}<div>No more users</div></div>
    ${ambiguous ? `<div data-pagelet="ProfileAppSection_4">${tab("Following", true)}${card("wrong_second_section", "Wrong second section")}</div>` : ""}
    ${outside}</main>`;
}

async function withOffline(t, pageBody, run) {
  const browser = await chromium.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), requests = [], clicks = [];
  let closed = 0;
  context.on("close", () => { closed += 1; }); t.after(async () => browser.close());
  await context.addCookies([{ name: "c_user", value: ownId, domain: ".facebook.com", path: "/" }]);
  await context.exposeBinding("recordClick", (_source, text) => clicks.push(text));
  await context.addInitScript(() => document.addEventListener("click", event => window.recordClick((event.target.closest("a,button,[role=button]")?.textContent || "").trim())));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url()); requests.push(`${url.pathname}${url.search}`);
    let body;
    if (url.pathname === "/") body = '<button role="button" aria-label="Account">Account</button>';
    else if (url.pathname === "/profile.php" && url.searchParams.get("id") === ownId) {
      const sk = url.searchParams.get("sk");
      body = sk === "following" ? pageBody : sk === "friends" ? `<main><div data-pagelet="ProfileAppSection_0"><h2>Friends</h2>
        ${tab("Friends", true, friends)}${tab("Following")}</div></main>`
        : `<main><header><h1>Own account</h1><a href="${friends.replace(/&/g, "&amp;")}">Friends</a></header></main>`;
    } else { await route.fulfill({ status: 404, body: "Unplanned offline fixture request" }); return; }
    await route.fulfill({ contentType: "text/html", body: html(body) });
  });
  const options = { platform: { id: "facebook" }, linkedAccount: { id: "offline-facebook-section", platformId: "facebook",
    label: "Not a username", profileDirectory: "D:\\offline-facebook-section\\never-opened-profile" }, settleMs: 30,
    navigationTimeoutMs: 250, maxPages: 30, maxDurationMs: 5000, browserType: { launchPersistentContext: async (directory, launchOptions) => {
      assert.equal(directory, "D:\\offline-facebook-section\\never-opened-profile"); assert.equal(launchOptions.headless, true); return context;
    } } };
  await run({ options, requests, clicks, closed: () => closed });
}

test("Facebook observed selected profile section imports plain cards without a Following action and deduplicates avatar/name anchors", async t => {
  await withOffline(t, followingPage(), async ({ options, requests, clicks, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "complete"); assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].handle, "known_target"); assert.equal(result.accounts[0].displayName, "Known target");
    assert.equal(requests.includes(friends), true); assert.equal(requests.includes(following), true);
    assert.deepEqual(clicks, ["Friends", "Following"]); assert.equal(closed(), 1);
  });
});

test("Facebook observed one plain following card without terminal proof remains importable partial rather than claiming the full list", async t => {
  await withOffline(t, followingPage().replace('<div>No more users</div>', ''), async ({ options, closed }) => {
    const result = await discoverFollowing(options);
    assert.equal(result.completeness, "partial"); assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].handle, "known_target"); assert.equal(result.accounts[0].displayName, "Known target");
    assert.equal(result.emptyConfirmed, false); assert.equal(closed(), 1);
  });
});

test("Facebook selected relationship section does not harvest sibling photos, Reels, recommendations or article authors", async t => {
  const outside = `<div data-pagelet="ProfileAppSection_1"><h2>Photos</h2><a href="/photo.php?fbid=987">Photo</a>${card("photo_actor")}${semanticRow("photo_semantic_actor")}</div>
    <div data-pagelet="ProfileAppSection_2"><h2>Reels</h2>${card("reels_actor")}${semanticRow("reels_semantic_actor")}</div>
    <div data-pagelet="RecommendPagelet">${card("outside_recommendation")}${semanticRow("outside_role_recommendation")}</div>`;
  const within = `<article>${card("article_author")}${semanticRow("article_role_actor")}</article>
    <div><a href="/photo.php?fbid=987">Photo navigation</a><a href="/profile.php?id=999&amp;sk=following">Other profile collection</a></div>`;
  await withOffline(t, followingPage({ outside, within }), async ({ options }) => {
    const result = await discoverFollowing(options);
    assert.deepEqual(result.accounts.map(account => account.handle), ["known_target"]);
  });
});

test("Facebook RecommendPagelet inside the same selected section cannot re-enter through semantic Following rows", async t => {
  const within = `<div data-pagelet="RecommendPagelet">${card("plain_recommendation")}${semanticRow("role_recommendation")}</div>
    <div data-pagelet="SuggestedAccountsPagelet">${card("plain_suggestion")}${semanticRow("role_suggestion")}</div>`;
  await withOffline(t, followingPage({ within }), async ({ options }) => {
    const result = await discoverFollowing(options);
    assert.deepEqual(result.accounts.map(account => account.handle), ["known_target"]);
  });
});

test("Facebook an unselected Following tab cannot establish the plain-card relationship scope", async t => {
  await withOffline(t, followingPage({ selected: "" }), async ({ options, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false); assert.equal(closed(), 1);
  });
});

test("Facebook selected Followers cannot be overridden by the sk=following URL or a semantic Following card", async t => {
  await withOffline(t, followingPage({ selected: "Followers", legacyRow: true }), async ({ options, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false); assert.equal(closed(), 1);
  });
});

test("Facebook multiple selected profile collection sections are not accepted as a single following scope", async t => {
  await withOffline(t, followingPage({ ambiguous: true }), async ({ options, closed }) => {
    const progress = [];
    await assert.rejects(discoverFollowing({ ...options, onProgress: value => progress.push(value) }), { code: "following-list-unavailable" });
    assert.equal(progress.some(value => value.accounts?.length), false); assert.equal(closed(), 1);
  });
});

