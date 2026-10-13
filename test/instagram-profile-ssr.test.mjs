import test from "node:test";
import assert from "node:assert/strict";
import { discoverInstagramMedia } from "../lib/instagram-sync.mjs";
import { instagramTimelineDocuments, parseInstagramHtml } from "../lib/instagram-media.mjs";

const root = "xdt_api__v1__feed__user_timeline_graphql_connection";
const post = (code, changes = {}) => ({ code, pk: `${code}ID`, taken_at: 1_700_000_000,
  user: { username: "creator", pk: "42" }, image_versions2: { candidates: [{ url: `https://cdn.example/${code}.jpg` }] }, ...changes });
const feed = (nodes = [], next = false, changes = {}) => ({ data: { [root]: { edges: nodes.map(node => ({ node })),
  ...(next === undefined ? {} : { page_info: { has_next_page: next } }) } }, ...changes });
const html = (...payloads) => `<script type="application/json" data-sjs>${JSON.stringify({ require:
  payloads.map(payload => ["RelayPrefetchedStreamCache", "add", null, ["fixture", JSON.stringify(payload)]]) })}</script>`;
const api = (payload, changes = {}) => ({ payload, operation: "PolarisProfilePostsQuery", variables: { username: "creator" }, status: 200, ...changes });

// Entirely in memory: no network, account profiles, files or media downloads.
function fixture({ pages = [{ html: html(feed([post("FIRST")])) }], scrolls = [], dom = [], warning = {}, password = false } = {}) {
  const listeners = new Map();
  let currentUrl = "about:blank", visits = 0, wheels = 0, domReads = 0, closed = false;
  const emit = (entries = []) => {
    for (const entry of entries) {
      const request = { url: () => "https://www.instagram.com/graphql/query", postData: () => new URLSearchParams({
        fb_api_req_friendly_name: entry.operation, variables: JSON.stringify(entry.variables) }).toString() };
      listeners.get("request")?.(request);
      if (entry.unfinished) continue;
      listeners.get("response")?.({ url: request.url, request: () => request, status: () => entry.status,
        json: async () => { listeners.get("requestfinished")?.(request); return entry.payload; } });
      if (entry.status >= 400) listeners.get("requestfinished")?.(request);
    }
  };
  const page = {
    on(name, listener) { listeners.set(name, listener); }, off(name) { listeners.delete(name); },
    url: () => currentUrl, locator: () => ({ first: () => ({ isVisible: async () => password }) }),
    evaluate: async (callback, platform) => platform ? { timeZone: "UTC", records: [] }
      : callback.toString().includes('script[type="application/json"]') ? (dom[Math.min(domReads++, dom.length - 1)] || "") : warning,
    async goto(url) {
      const entry = pages[Math.min(visits++, pages.length - 1)];
      currentUrl = entry.redirect || url;
      emit(entry.api);
      return { status: () => entry.status || 200, text: async () => entry.textHangs ? new Promise(() => {}) : entry.html || "" };
    },
    waitForTimeout: async () => {}, mouse: { wheel: async () => emit(scrolls[wheels++] || []) },
  };
  const context = { pages: () => [page], close: async () => { closed = true; } };
  return { browserType: { launch: async () => ({ newContext: async () => context, close: async () => {} }) },
    get visits() { return visits; }, get wheels() { return wheels; }, get closed() { return closed; } };
}
async function discover(session, options = {}) {
  try { return await discoverInstagramMedia({ handle: "creator", browserType: session.browserType,
    timelineWaitMs: 0, retryTimelineWaitMs: 0, responseWaitMs: 0, scrollWaitMs: 0, maxScrolls: 8, ...options }); }
  finally { assert.equal(session.closed, true); }
}

test("Instagram SSR-only profile feed proves its owned first page and terminal completion", async () => {
  const session = fixture();
  const result = await discover(session);
  assert.equal(result.complete, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.headCaptured, true);
  assert.equal(result.headTraversalCaptured, true);
  assert.equal(result.completionReason, "terminal-page");
  assert.deepEqual(result.posts.map(p => p.postKey), ["FIRST"]);
  assert.equal(session.visits, 1);
});

test("Instagram SSR first page continues through later API pagination", async () => {
  const session = fixture({ pages: [{ html: html(feed([post("FIRST")], true)) }],
    scrolls: [[api(feed([post("LAST")], false), { variables: { username: "creator", after: "NEXT" } })]] });
  const result = await discover(session);
  assert.equal(result.complete, true);
  assert.deepEqual(result.posts.map(p => p.postKey), ["FIRST", "LAST"]);
  assert.equal(result.timelineResponses, 2);
});

test("Instagram later API continuing cursor is not overwritten by an earlier SSR terminal snapshot", async () => {
  const result = await discover(fixture({ pages: [{ html: html(feed([post("FIRST")], false)),
    api: [api(feed([post("API")], true), { variables: { username: "creator", after: "NEXT" } })] }] }), { maxScrolls: 0 });
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
  assert.equal(result.headCaptured, true);
});

test("Instagram multiple SSR feed documents conservatively merge continuing and unknown cursor states", async () => {
  for (const next of [true, undefined]) {
    const first = feed([post("FIRST")], next);
    if (next === undefined) delete first.data[root].page_info;
    for (const payloads of [[first, feed([post("SECOND")], false)], [feed([post("SECOND")], false), first]]) {
      const result = await discover(fixture({ pages: [{ html: html(...payloads) }] }), { maxScrolls: 0 });
      assert.equal(result.complete, false);
      assert.equal(result.reachedEnd, false);
      assert.equal(result.timelineResponses, 1, "SSR modules are a single navigation snapshot");
    }
  }
  const session = fixture({ pages: [{ html: html(feed([post("FIRST")], true), feed([post("SECOND")], false)) }],
    scrolls: [[api(feed([post("LAST")], false), { variables: { username: "creator", after: "NEXT" } })]] });
  assert.equal((await discover(session)).complete, true, "A later authoritative API terminal cursor still wins");
});

test("Instagram DOM streaming cannot conceal a same-navigation continuing SSR module", async () => {
  const result = await discover(fixture({ pages: [{ html: html(feed([post("FIRST")], true)) }],
    dom: [html(feed([post("SECOND")], false))] }), { maxScrolls: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
});

test("Instagram multiple SSR first-page modules are not two distinct incremental cutoff batches", async () => {
  const known = ["A", "B", "C", "D", "E", "F"];
  const result = await discover(fixture({ pages: [{ html: html(feed(known.slice(0, 3).map(code => post(code)), true),
    feed(known.slice(3).map(code => post(code)), true)) }] }),
  { knownPosts: Object.fromEntries(known.map(code => [code, {}])), initialComplete: true, since: "2026-10-11T00:00:00Z", maxScrolls: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedKnownBoundary, false);
});

test("Instagram DOM-streamed data scripts recover a profile with no API feed", async () => {
  const result = await discover(fixture({ pages: [{ html: "<main>Loading</main>" }], dom: ["", html(feed([post("DOM")], false))] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.posts.map(p => p.postKey), ["DOM"]);
});

test("Instagram duplicate navigation and DOM SSR snapshots do not create extra traversal batches", async () => {
  const content = html(feed([post("FIRST")], false));
  const result = await discover(fixture({ pages: [{ html: content }], dom: [content] }));
  assert.equal(result.timelineResponses, 1);
  assert.equal(result.media.length, 1);
});

test("Instagram profile SSR ignores foreign feeds, details and recommendation modules", async () => {
  const foreign = post("FOREIGN", { user: { username: "other", pk: "99" }, coauthor_producers: [{ username: "creator", pk: "42" }] });
  const detail = { data: { xdt_shortcode_media: post("DETAIL") } };
  const recommended = { data: { recommendations: [post("RECOMMENDED")] } };
  const payloads = [feed([foreign]), detail, recommended];
  assert.deepEqual(instagramTimelineDocuments(parseInstagramHtml(html(...payloads)), "creator"), []);
  await assert.rejects(discover(fixture({ pages: [{ html: html(...payloads) }] })), { code: "timeline-unavailable" });
  const result = await discover(fixture({ pages: [{ html: html(feed([post("OWNED")]), detail, recommended) }] }));
  assert.deepEqual(result.posts.map(p => p.postKey), ["OWNED"]);
});

test("Instagram empty SSR requires matching profile metadata in the same feed document", async () => {
  await assert.rejects(discover(fixture({ pages: [{ html: html(feed([])) }] })), { code: "timeline-unavailable" });
  await assert.rejects(discover(fixture({ pages: [{ html: html({ data: { user: { username: "creator", pk: "42" } } }, feed([])) }] })),
    { code: "timeline-unavailable" });
  const payload = feed([]); payload.data.user = { username: "creator", pk: "42" };
  assert.equal((await discover(fixture({ pages: [{ html: html(payload) }] }))).complete, true);
});

test("Instagram legacy profile SSR retains explicit username scope for empty and populated feeds", async () => {
  for (const nodes of [[], [post("LEGACY")]]) {
    const payload = { data: { user: { username: "creator", id: "42", edge_owner_to_timeline_media:
      { edges: nodes.map(node => ({ node })), page_info: { has_next_page: false } } } } };
    assert.equal((await discover(fixture({ pages: [{ html: html(payload) }] }))).complete, true);
  }
});

test("Instagram profile SSR never hides private, login, HTTP or null-feed errors", async (t) => {
  for (const [name, options, code] of [
    ["private", { warning: { privateAccount: true } }, "private-account"],
    ["login", { password: true }, "login-required"],
    ["login redirect", { pages: [{ html: html(feed([post("FIRST")])), redirect: "https://www.instagram.com/accounts/login/" }] }, "login-required"],
    ["HTTP403", { pages: [{ html: html(feed([post("FIRST")])), status: 403 }] }, "profile-http-error"],
    ["null feed", { pages: [{ html: html({ data: { user: { username: "creator" }, [root]: null } }) }] }, "timeline-unavailable"],
  ]) await t.test(name, async () => assert.rejects(discover(fixture(options)), { code }));
});

test("Instagram SSR GraphQL errors remain incomplete and never expose server error messages", async () => {
  const payload = feed([post("FIRST")], false, { errors: [{ path: [root, "edges", 0, "node", "image_versions2"], message: "SECRET_VALUE" }] });
  const result = await discover(fixture({ pages: [{ html: html(payload) }] }), { maxScrolls: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.headCaptured, false);
  assert.equal(result.parseIssues.some(issue => issue.reason === "timeline-graphql-error"), true);
  assert.equal(JSON.stringify(result).includes("SECRET_VALUE"), false);
});

test("Instagram newer clean first-page API can repair an earlier SSR error, not vice versa", async () => {
  const broken = feed([post("FIRST")], false, { errors: [{ path: [root, "page_info"], message: "secret" }] });
  const repaired = await discover(fixture({ pages: [{ html: html(broken), api: [api(feed([post("FIRST")], false))] }] }));
  assert.equal(repaired.complete, true);
  const unrepaired = await discover(fixture({ pages: [{ html: html(feed([post("FIRST")], false)), api: [api(null, { status: 403 })] }] }), { maxScrolls: 0 });
  assert.equal(unrepaired.complete, false);
  assert.equal(unrepaired.parseIssues.some(issue => issue.reason === "timeline-http-403"), true);
});

test("Instagram SSR continuing and unknown pagination states do not imply full history", async () => {
  for (const next of [true, undefined]) {
    const payload = feed([post("FIRST")], next);
    if (next === undefined) delete payload.data[root].page_info;
    const result = await discover(fixture({ pages: [{ html: html(payload) }] }), { maxScrolls: 0 });
    assert.equal(result.complete, false);
    assert.equal(result.rangeComplete, false);
    assert.equal(result.reachedEnd, false);
  }
});

test("Instagram SSR initial head and known API overlap use the existing incremental cutoff", async () => {
  const known = ["A", "B", "C", "D", "E", "F"];
  const result = await discover(fixture({ pages: [{ html: html(feed(known.slice(0, 3).map(code => post(code)), true)) }],
    scrolls: [[api(feed(known.slice(3).map(code => post(code)), true), { variables: { username: "creator", after: "NEXT" } })]] }),
  { knownPosts: Object.fromEntries(known.map(code => [code, {}])), initialComplete: true, since: "2026-10-11T00:00:00Z" });
  assert.equal(result.complete, true);
  assert.equal(result.reachedKnownBoundary, true);
  assert.equal(result.completionReason, "known-boundary");
  assert.equal(result.reachedEnd, false);
});

test("Instagram new named posts query requires a real owned feed and exact request target", async () => {
  const good = api(feed([post("NEW")]), { operation: "PolarisProfilePostsV2Query" });
  assert.equal((await discover(fixture({ pages: [{ api: [good] }] }))).complete, true);
  for (const entry of [
    { ...good, variables: { username: "other" } },
    { ...good, operation: "PolarisProfilePageContentQuery" },
    { ...good, operation: "PolarisSuggestedPostsQuery" },
    { ...good, payload: { data: { media: post("DETAIL") } } },
    { ...good, payload: feed([post("FOREIGN", { user: { username: "other" } })]) },
  ]) await assert.rejects(discover(fixture({ pages: [{ api: [entry] }] })), { code: "timeline-unavailable" });
});

test("Instagram failed hydration exposes only bounded safe operation/root classifications", async () => {
  const session = fixture({ pages: [{ api: [api({ data: { user: { username: "viewer" }, SECRET_ROOT: "secret" } },
    { operation: "SECRET_TOKEN", variables: { username: "other", token: "SECRET_VALUE" } })] }] });
  await assert.rejects(discover(session), error => error.code === "timeline-unavailable"
    && error.message.includes("响应操作：其他命名操作") && error.message.includes("profile-metadata")
    && !/SECRET|viewer/.test(error.message));
});

test("Instagram SSR terminal snapshot still waits for an unresolved known target pagination request", async () => {
  for (const operation of ["PolarisProfilePostsQuery", "PolarisProfilePostsV2Query"]) {
    const result = await discover(fixture({ pages: [{ html: html(feed([post("FIRST")])),
      api: [api(null, { operation, unfinished: true, variables: { username: "creator", after: "NEXT" } })] }] }));
    assert.equal(result.complete, false);
    assert.equal(result.rangeComplete, false);
    assert.equal(result.headCaptured, true);
    assert.equal(result.incompleteReason, "timeline-in-flight");
  }
});

test("Instagram new posts-operation HTTP and GraphQL failures are not hidden by a terminal SSR snapshot", async () => {
  for (const response of [api(null, { operation: "PolarisProfilePostsV2Query", status: 403 }),
    api({ errors: [{ path: [root, "page_info"], message: "secret" }] }, { operation: "PolarisProfilePostsV2Query" })]) {
    const result = await discover(fixture({ pages: [{ html: html(feed([post("FIRST")])), api: [response] }] }), { maxScrolls: 0 });
    assert.equal(result.complete, false);
    assert.equal(result.rangeComplete, false);
    assert.equal(result.parseIssues.some(issue => /timeline-(?:http-403|graphql-error)/.test(issue.reason)), true);
  }
});

test("Instagram streaming navigation body has a bounded read and DOM SSR fallback", async () => {
  const result = await discover(fixture({ pages: [{ textHangs: true }], dom: [html(feed([post("DOM")]))] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.posts.map(post => post.postKey), ["DOM"]);
});

test("Instagram cancellation during a navigation-body read closes the exact background context", async () => {
  const session = fixture({ pages: [{ textHangs: true }] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(discover(session, { signal: controller.signal }), { name: "AbortError" }); }
  finally { clearTimeout(timer); }
});
