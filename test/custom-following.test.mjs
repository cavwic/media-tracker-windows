import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";
import { createCustomPlatform, getPlatformRegistry } from "../lib/platform-registry.mjs";
import { normalizePlatforms } from "../lib/archive.mjs";
import { canonicalCustomFollowingAccount, discoverCustomFollowing } from "../lib/custom-following.mjs";

const platform = (fields = {}) => createCustomPlatform({ label: "独立网站", homepageUrl: "https://example.com/",
  verificationUrl: "https://example.com/account", followingUrl: "https://example.com/me/following", loginMarker: "#viewer", ...fields });
const publicLookup = async () => [{ address: "8.8.8.8" }];

test("custom target identity is its exact URL, not a guessed username or display name", () => {
  const p = platform();
  assert.equal(canonicalCustomFollowingAccount(p, { name: "@someone", handle: "someone" }), null);
  const a = canonicalCustomFollowingAccount(p, { profileUrl: "https://www.example.com/Users/Alice/?id=ABC&view=Detailed&utm_source=hello#top", displayName: "Alice 张" });
  assert.equal(a.profileUrl, "https://example.com/Users/Alice?id=ABC&view=Detailed");
  assert.equal(a.handle, a.profileUrl);
  assert.equal(a.label, "Alice_ABC");
  assert.equal(a.displayName, "Alice 张");
  assert.notEqual(a.handle, canonicalCustomFollowingAccount(p, { profileUrl: "https://example.com/Users/alice?id=ABC&view=Detailed" }).handle);
  const targets = normalizePlatforms([{ id: p.id, accounts: [{ label: a.label, profileUrl: a.profileUrl }] }], getPlatformRegistry([p]));
  assert.equal(targets[0].accounts[0].profileUrl, a.profileUrl);
});

test("custom profiles reject navigation posts cross-site addresses credentials and sensitive queries", () => {
  const p = platform();
  for (const value of ["/u/alice", "http://example.com/u/alice", "https://example.net/u/alice", "https://api.example.com/u/alice", "https://user:password@example.com/u/alice", "https://example.com:8443/u/alice", "https://127.0.0.1/u/alice", "https://example.com/", "https://example.com/login", "https://example.com/me/following", "https://example.com/u/alice/posts/1", "https://example.com/u/alice/%70osts/1", "https://example.com/u/alice?token=private", "https://example.com/u/alice?session=private", "https://example.com/u/alice?access_token=private", "https://example.com/u/alice?api_key=private", "https://example.com/u/alice?password=private"]) {
    assert.equal(canonicalCustomFollowingAccount(p, { profileUrl: value }), null, value);
  }
  assert.equal(canonicalCustomFollowingAccount(p, { profileUrl: "https://example.com/users/%E5%BC%A0%E4%B8%89" }).label, "张三");
  for (const key of ["refresh_token", "id_token", "session_id", "auth_token", "code", "client_secret", "csrf_token", "APIKEY"]) {
    assert.equal(canonicalCustomFollowingAccount(p, { profileUrl: `https://example.com/u/alice?${key}=private` }), null, key);
  }
});

function fixture({ p = platform(), rows = [{ profileUrl: "https://example.com/u/Alice", displayName: "Alice" }], explicitEnd = true, emptyConfirmed = false,
  scoped = true, loggedIn = true, loggedOut = false, challenge = false, credentials = false, closeFailure = false, fallback = false,
  onRows, redirect, rowsUrl, lookup = publicLookup } = {}) {
  const calls = { goto: [], close: 0, extraClose: 0, browserClose: 0, clicks: 0, ws: 0 };
  let currentUrl = "about:blank", connected = true;
  const page = {
    mainFrame: () => page,
    goto: async url => { calls.goto.push(url); currentUrl = redirect || url; return { status: () => 200 }; },
    waitForTimeout: async () => {},
    evaluate: async fn => {
      if (fn.name === "readCustomFollowingRows") {
        onRows?.();
        return { url: rowsUrl || currentUrl, scoped, explicitEnd, emptyConfirmed, links: rows };
      }
      return { url: currentUrl, loggedIn, loggedOut, challenge, hasCredentialForm: credentials };
    },
  };
  const context = {
    pages: () => [page, { close: async () => { calls.extraClose++; } }],
    route: async (_pattern, handler) => { calls.guard = handler; },
    routeWebSocket: async (_pattern, handler) => { calls.ws++; calls.socketGuard = handler; },
    close: async () => { calls.close++; if (closeFailure) throw new Error("Could not close private profile"); connected = false; },
    browser: () => fallback ? { close: async () => { calls.browserClose++; connected = false; }, isConnected: () => connected } : null,
  };
  const browserType = { launchPersistentContext: async (profile, options) => { calls.profile = profile; calls.options = options; return context; } };
  return { calls, page, context, p, options: { platform: p, linkedAccount: { platformId: p.id, profileDirectory: "fixture-custom-profile" }, browserType,
    lookup, settleMs: 0, navigationTimeoutMs: 0, maxPages: 8 } };
}

test("missing following URL is actionable before any browser or network is launched", async () => {
  const f = fixture({ p: platform({ followingUrl: "" }) });
  await assert.rejects(discoverCustomFollowing(f.options), { code: "following-url-required" });
  assert.equal(f.calls.options, undefined);
});

test("custom following reader uses tool headless profile and returns only canonical data", async () => {
  const f = fixture();
  const progress = [];
  const result = await discoverCustomFollowing({ ...f.options, onProgress: value => progress.push(value) });
  assert.equal(result.completeness, "complete");
  assert.equal(result.emptyConfirmed, false);
  assert.equal(result.accounts[0].label, "Alice");
  assert.deepEqual(f.calls.goto, [f.p.verificationUrl, f.p.followingUrl]);
  assert.equal(f.calls.options.headless, true);
  assert.equal(f.calls.options.executablePath, BACKGROUND_CHROMIUM_EXECUTABLE);
  assert.equal(f.calls.options.serviceWorkers, "block");
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.extraClose, 1);
  assert.equal(f.calls.ws, 1);
  assert.equal(JSON.stringify(result).includes("fixture-custom-profile"), false);
  assert.equal(progress.at(-1).accounts.length, 1);
});

test("login rule online marker is mandatory and password logout or challenges prevent reading", async () => {
  for (const fields of [{ loggedIn: false }, { loggedOut: true }, { challenge: true }, { credentials: true }, { redirect: "https://example.com/login" }]) {
    const f = fixture(fields);
    await assert.rejects(discoverCustomFollowing(f.options), { code: "login-required" });
    assert.equal(f.calls.goto.length, 1);
    assert.equal(f.calls.close, 1);
  }
  const f = fixture({ p: platform({ loginMarker: "" }) });
  await assert.rejects(discoverCustomFollowing(f.options), { code: "login-rule-required" });
  assert.equal(f.calls.options, undefined);
});

test("unknown DOM scope is rejected and a stalled readable list is never claimed complete", async () => {
  const missing = fixture({ rows: [], scoped: false, explicitEnd: false });
  await assert.rejects(discoverCustomFollowing(missing.options), { code: "following-list-unavailable" });
  const stalled = fixture({ explicitEnd: false });
  const partial = await discoverCustomFollowing(stalled.options);
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.accounts.length, 1);
  const empty = fixture({ rows: [] });
  await assert.rejects(discoverCustomFollowing(empty.options), { code: "following-list-unavailable" });
});

test("custom zero lists require explicit scoped platform evidence, not an empty parse or terminal marker", async () => {
  const empty = fixture({ rows: [], emptyConfirmed: true });
  const result = await discoverCustomFollowing(empty.options);
  assert.equal(result.completeness, "complete");
  assert.equal(result.emptyConfirmed, true);
  assert.equal(result.observedCount, 0);
  assert.deepEqual(result.accounts, []);
  assert.equal(empty.calls.close, 1);
  for (const fields of [
    { scoped: false, emptyConfirmed: true },
    { emptyConfirmed: false },
    { emptyConfirmed: "true" },
    { explicitEnd: false, emptyConfirmed: true },
  ]) {
    const f = fixture({ rows: [], ...fields });
    await assert.rejects(discoverCustomFollowing(f.options), { code: "following-list-unavailable" });
    assert.equal(f.calls.close, 1);
  }
});

test("unrecognized profile rows cannot masquerade as a successfully empty following list", async () => {
  for (const rows of [[{ profileUrl: "https://example.net/u/Foreign" }], [{ profileUrl: "https://example.com/posts/123" }]]) {
    for (const emptyConfirmed of [false, true]) {
      const f = fixture({ rows, emptyConfirmed });
      await assert.rejects(discoverCustomFollowing(f.options), { code: "following-list-unavailable" });
      assert.equal(f.calls.close, 1);
    }
  }
});

test("empty custom lists still require online login and never bypass a changed following owner", async () => {
  for (const fields of [{ loggedIn: false }, { loggedOut: true }, { credentials: true }, { challenge: true }]) {
    const f = fixture({ rows: [], emptyConfirmed: true, ...fields });
    await assert.rejects(discoverCustomFollowing(f.options), { code: "login-required" });
    assert.equal(f.calls.goto.length, 1);
  }
  const changed = fixture({ rows: [], emptyConfirmed: true, rowsUrl: "https://example.com/me/following?user=Other" });
  await assert.rejects(discoverCustomFollowing(changed.options), { code: "following-list-unavailable" });
});

test("account cap and canonical URL duplicate handling retain all observed usable rows", async () => {
  const f = fixture({ rows: [{ profileUrl: "https://example.com/u/Alice" }, { profileUrl: "https://www.example.com/u/Alice?utm_source=x" }, { profileUrl: "https://example.com/u/Bob" }] });
  const result = await discoverCustomFollowing({ ...f.options, maxAccounts: 1 });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.completeness, "partial");
});

test("DNS private or mixed responses are rejected before launching even if configured hostname appears public", async () => {
  for (const answers of [[{ address: "127.0.0.1" }], [{ address: "8.8.8.8" }, { address: "192.168.1.1" }]]) {
    const f = fixture({ lookup: async () => answers });
    await assert.rejects(discoverCustomFollowing(f.options), { code: "invalid-platform" });
    assert.equal(f.calls.options, undefined);
  }
});

test("all browser requests are checked and cross-site/private document redirects are blocked", async () => {
  const f = fixture();
  await discoverCustomFollowing(f.options);
  for (const url of ["https://example.net/elsewhere", "http://example.com/u", "https://127.0.0.1/u", "https://example.com:8443/u"]) {
    let continued = false, aborted = false;
    await f.calls.guard({ request: () => ({ url: () => url, isNavigationRequest: () => true, resourceType: () => "document", frame: () => f.page }),
      continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
    assert.equal(continued, false, url); assert.equal(aborted, true, url);
  }
  let socketClosed = false;
  f.calls.socketGuard({ close: () => { socketClosed = true; } });
  assert.equal(socketClosed, true);
});

test("public CDN scripts are allowed but private DNS subresources and background images are blocked", async () => {
  const f = fixture({ lookup: async host => [{ address: host === "private.example.org" ? "192.168.1.1" : "8.8.8.8" }] });
  await discoverCustomFollowing(f.options);
  for (const [url, type, allowed] of [["https://cdn.example.org/client.js", "script", true],
    ["https://private.example.org/client.js", "script", false], ["https://cdn.example.org/large.jpg", "image", false]]) {
    let continued = false, aborted = false;
    await f.calls.guard({ request: () => ({ url: () => url, isNavigationRequest: () => false, resourceType: () => type, frame: () => f.page }),
      continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
    assert.equal(continued, allowed, url); assert.equal(aborted, !allowed, url);
  }
});

test("same-site navigation away from the configured following page cannot supply targets", async () => {
  const f = fixture({ rowsUrl: "https://example.com/u/OtherOwner" });
  await assert.rejects(discoverCustomFollowing(f.options), { code: "following-list-unavailable" });
  assert.equal(f.calls.close, 1);
});

test("same-path query owner cannot be changed or added while harmless pagination may advance", async () => {
  for (const rowsUrl of ["https://example.com/me/following?user=other", "https://example.com/me/following?id=other", "https://example.com/me/following?Owner=OTHER"]) {
    const f = fixture({ rowsUrl });
    await assert.rejects(discoverCustomFollowing(f.options), { code: "following-list-unavailable" });
  }
  const changed = fixture({ p: platform({ followingUrl: "https://example.com/following.php?owner=MyID" }),
    rowsUrl: "https://example.com/following.php?owner=myid" });
  await assert.rejects(discoverCustomFollowing(changed.options), { code: "following-list-unavailable" });
  const valid = fixture({ p: platform({ followingUrl: "https://example.com/following.php?owner=MyID&page=1" }),
    rowsUrl: "https://example.com/following.php?owner=MyID&page=2&cursor=abc" });
  assert.equal((await discoverCustomFollowing(valid.options)).completeness, "complete");
});

test("unknown DOM scope cannot emit targets even if an adapter supplies rows", async () => {
  const f = fixture({ scoped: false, explicitEnd: false });
  const progress = [];
  await assert.rejects(discoverCustomFollowing({ ...f.options, onProgress: item => progress.push(item) }), { code: "following-list-unavailable" });
  assert.equal(progress.some(item => item.accounts.length), false);
});

test("cancellation closes the owned background context and never reports completed", async () => {
  const controller = new AbortController();
  const f = fixture({ onRows: () => controller.abort() });
  await assert.rejects(discoverCustomFollowing({ ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls.close, 1);
});

test("DNS lookup can be cancelled without waiting for an unresolved resolver", async () => {
  const controller = new AbortController();
  const f = fixture({ lookup: async () => { controller.abort(); return new Promise(() => {}); } });
  await assert.rejects(discoverCustomFollowing({ ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls.options, undefined);
});

test("unconfirmed close retains lease with retry callback; disconnected fallback is sufficient", async () => {
  const f = fixture({ closeFailure: true });
  await assert.rejects(discoverCustomFollowing(f.options), error => error.code === "browser-close-failed"
    && error.retainProfileLease === true && typeof error.retryDispose === "function");
  const fallback = fixture({ closeFailure: true, fallback: true });
  assert.equal((await discoverCustomFollowing(fallback.options)).completeness, "complete");
  assert.equal(fallback.calls.browserClose, 1);
});

test("actual rendered custom DOM excludes recommendations followers posts navigation and unsafe links without clicking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-custom-following-"));
  const p = platform();
  let actualContext;
  const html = `<style>body{font:16px sans-serif}li{padding:20px}a,button{display:inline-block}</style>
    <div id="viewer">Own account</div><nav><ul aria-label="Following"><li><a href="/u/Nav">Nav</a></li></ul></nav>
    <main><ul id="following-list">
      <li><a href="/u/Alice"><img src="/avatar">Alice</a><button>Following</button></li>
      <li><a href="/u/Bob">Bob</a><button>Requested</button></li>
      <li><a href="/u/Suggested">Suggested</a><button>Follow</button></li>
      <li class="recommendation"><a href="/u/Recommended">Recommended</a></li>
      <li class="followers"><a href="/u/Follower">Follower</a></li>
      <li><article><a href="/u/PostAuthor">Author</a><button>Following</button></article></li>
      <li><a href="https://evil.example.org/u/Foreign">Foreign</a></li>
      <li><a href="/posts/123">A post</a></li>
      <li><a href="/u/Private?token=secret">Private</a></li>
      <li><a href="/u/Legacy">Legacy list row</a></li>
      <div data-list-end="true">All accounts loaded</div></ul>
      <section class="recommendations"><ul class="following-list"><li><a href="/u/NestedRecommended">Recommended root</a></li></ul></section></main>
    <script>document.addEventListener('click',()=>{window.didClick=true})</script>`;
  const browserType = { launchPersistentContext: async (profile, options) => {
    actualContext = await chromium.launchPersistentContext(profile, options);
    const originalRoute = actualContext.route.bind(actualContext);
    actualContext.route = async (pattern, handler) => originalRoute(pattern, route => handler({ request: () => route.request(),
      abort: (...args) => route.abort(...args), continue: () => route.fulfill({ status: 200, contentType: "text/html", body: html }) }));
    return actualContext;
  } };
  try {
    const result = await discoverCustomFollowing({ platform: p, linkedAccount: { platformId: p.id, profileDirectory: root },
      browserType, lookup: publicLookup, settleMs: 0, navigationTimeoutMs: 1000, maxPages: 2 });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.accounts.map(item => item.label), ["Alice", "Bob", "Legacy"]);
  } finally {
    await actualContext?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("actual rendered custom empty states require scoped zero evidence and never confuse unreadable rows with no following", async () => {
  const cases = [
    ['<div data-following-list><p>No followed accounts</p></div>', true],
    ['<ul id="following-list"><li>暂无关注</li></ul>', true],
    ['<ul id="following-list" data-following-count="0" style="min-height:50px"></ul>', true],
    ['<ul id="following-list" data-has-more="false"><li><span>Opaque account row</span></li></ul>', false],
    ['<ul id="following-list"><li>No more users</li></ul>', false],
    ['<div data-following-list data-has-more="false"><p>暂无关注</p><a href="/u/Opaque">An unparsed profile</a></div>', false],
    ['<section class="recommendations"><ul id="following-list"><li>暂无关注</li></ul></section>', false],
  ];
  for (const [list, isEmpty] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "tracker-custom-empty-"));
    const p = platform();
    let actualContext;
    const html = `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif}li{padding:20px}a,button{display:inline-block}</style>
      <div id="viewer">Own account</div><main>${list}</main>`;
    const browserType = { launchPersistentContext: async (profile, options) => {
      actualContext = await chromium.launchPersistentContext(profile, options);
      const originalRoute = actualContext.route.bind(actualContext);
      actualContext.route = async (pattern, handler) => originalRoute(pattern, route => handler({ request: () => route.request(),
        abort: (...args) => route.abort(...args), continue: () => route.fulfill({ status: 200, contentType: "text/html", body: html }) }));
      return actualContext;
    } };
    try {
      const operation = discoverCustomFollowing({ platform: p, linkedAccount: { platformId: p.id, profileDirectory: root },
        browserType, lookup: publicLookup, settleMs: 0, navigationTimeoutMs: 1000, maxPages: 2 });
      if (isEmpty) {
        const result = await operation.catch(error => { error.message += ` (fixture: ${list})`; throw error; });
        assert.equal(result.emptyConfirmed, true, list);
        assert.equal(result.completeness, "complete", list);
        assert.deepEqual(result.accounts, [], list);
      } else await assert.rejects(operation, { code: "following-list-unavailable" }, list);
    } finally {
      await actualContext?.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
});

