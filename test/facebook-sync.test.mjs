import test from "node:test";
import assert from "node:assert/strict";
import { discoverFacebookMedia } from "../lib/facebook-sync.mjs";

const photo = (id, url = true) => ({ __typename: "Photo", id,
  ...(url ? { image: { uri: `https://scontent.xx.fbcdn.net/${id}.jpg`, width: 1000, height: 800 } } : {}) });
const post = (id, media = [photo(id)], changes = {}) => ({ __typename: "Story", post_id: id, actors: [{ id: "target" }],
  creation_time: 1_787_391_896, permalink_url: `https://www.facebook.com/target/posts/${id}`, attachments: [{ media }], ...changes });
const feed = (posts, next) => ({ data: { node: { __typename: "User", id: "target", timeline_list_feed_units: {
  edges: posts.map((node) => ({ node })), ...(typeof next === "boolean" ? { page_info: { has_next_page: next } } : {}),
} } } });
const api = (payload, changes = {}) => ({ payload, operation: "ProfileCometTimelineFeed", status: 200, ...changes });
const html = (payload) => `<script type="application/json" data-sjs>${JSON.stringify({ require: [
  ["RelayPrefetchedStreamCache", "add", null, ["key", JSON.stringify(payload)]],
] })}</script>`;

// Pure local test doubles exercise production discovery, with no browser,
// sockets, NAS files, credentials or platform requests.
function fixture({ initial = [], scrolls = [], ssr = "", details = {} } = {}) {
  const listeners = new Map(), timers = new Set();
  let url = "about:blank", scrollCount = 0, contextClosed = false, browserClosed = false;
  const emit = (name, value) => listeners.get(name)?.(value);
  const entries = (items) => {
    for (const entry of items) {
      const request = { url: () => "https://www.facebook.com/api/graphql/", postData: () => new URLSearchParams({
        fb_api_req_friendly_name: entry.operation, variables: JSON.stringify({ id: entry.target || "target",
          ...(entry.operation.includes("Pagination") ? { cursor: "after" } : {}), ...(entry.variables || {}) }),
      }).toString() };
      emit("request", request);
      if (entry.hangRequest) continue;
      const respond = () => {
        if (entry.failed) { emit("requestfailed", request); return; }
        emit("response", { request: () => request, url: request.url, status: () => entry.status, text: async () => {
          if (entry.hangBody) return new Promise(() => {});
          if (entry.badJson) return "{broken";
          return Array.isArray(entry.payload) ? entry.payload.map((item) => JSON.stringify(item)).join("\n") : JSON.stringify(entry.payload);
        } });
        queueMicrotask(() => emit("requestfinished", request));
      };
      if (entry.delayMs) { const timer = setTimeout(respond, entry.delayMs); timers.add(timer); }
      else respond();
    }
  };
  const page = {
    on(name, handler) { listeners.set(name, handler); },
    url: () => url,
    content: async () => url.includes("/posts/") ? details[url]?.html || "" : ssr,
    evaluate: async () => ({ timeZone: "Asia/Shanghai", records: [] }),
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async () => {},
    async goto(target) {
      url = target;
      entries(target.includes("/posts/") ? details[target]?.responses || [] : initial);
      return { status: () => 200, text: async () => target.includes("/posts/") ? details[target]?.html || "" : ssr };
    },
    mouse: { wheel: async () => { entries(scrolls[scrollCount++] || []); } },
  };
  const context = { pages: () => [page], close: async () => { contextClosed = true; for (const timer of timers) clearTimeout(timer); } };
  const browserType = { launch: async () => ({ newContext: async () => context, close: async () => { browserClosed = true; } }) };
  return { browserType, get scrollCount() { return scrollCount; }, get closed() { return contextClosed && browserClosed; } };
}
async function discover(session, changes = {}) {
  try { return await discoverFacebookMedia({ profileUrl: "https://www.facebook.com/target", profileId: "target",
    browserType: session.browserType, maxScrolls: 9, settleTimeoutMs: 50, ...changes }); }
  finally { assert.equal(session.closed, true); }
}

test("Facebook Wyy regression: SSR August album is not omitted while July pagination stalls", async () => {
  const august = post("august", [photo("aug-a"), photo("aug-b")]);
  const session = fixture({ ssr: html(feed([august], true)), initial: [api(feed([post("july")], true), { operation: "ProfileCometTimelineFeedPaginationQuery" })] });
  const result = await discover(session);
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.posts.map((item) => item.postId).sort(), ["august", "july"]);
  assert.equal(result.media.length, 3);
  assert.ok(session.scrollCount >= 7);
});

test("Facebook explicit target end and complete head, including an empty profile, can finish", async (t) => {
  for (const posts of [[post("first")], []]) await t.test(`${posts.length} posts`, async () => {
    const result = await discover(fixture({ initial: [api(feed(posts, false))] }));
    assert.equal(result.complete, true);
    assert.equal(result.completionReason, "terminal-page");
    assert.deepEqual(result.unresolvedMedia, []);
  });
});

test("Facebook unknown pagination and idle scrolls do not prove completion", async () => {
  const result = await discover(fixture({ initial: [api(feed([post("p")]))] }));
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
});

test("Facebook terminal pagination without first-page evidence remains incomplete", async () => {
  const result = await discover(fixture({ scrolls: [[api(feed([post("p")], false), { operation: "ProfileCometTimelineFeedPaginationQuery" })]] }));
  assert.equal(result.complete, false);
  assert.match(result.incompleteReason, /首屏/);
});

test("Facebook ranked feeds cannot cut off from known old posts alone", async () => {
  const knownPosts = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), true]));
  const result = await discover(fixture({ initial: [api(feed([0, 1, 2].map((id) => post(String(id))), true))],
    scrolls: [[api(feed([3, 4, 5].map((id) => post(String(id))), true), { operation: "ProfileCometTimelineFeedPaginationQuery" })]] }),
  { initialComplete: true, knownPosts, since: "2026-10-05T00:00:00Z" });
  assert.equal(result.complete, false);
  assert.equal(result.reachedKnownBoundary, false);
});

test("Facebook fragment catalog fills referenced media, while missing URLs/album children stay unresolved", async () => {
  const p = post("p", [photo("a", false)]);
  const resolved = await discover(fixture({ initial: [api([feed([p], false), { data: { node: photo("a") } }])] }));
  assert.equal(resolved.complete, true);
  assert.equal(resolved.media.length, 1);
  const missing = await discover(fixture({ initial: [api(feed([p], false))] }));
  assert.equal(missing.complete, false);
  assert.equal(missing.posts[0].mediaComplete, false);
  assert.equal(missing.unresolvedMedia[0].reason, "media-url-missing");
});

test("Facebook failed paging responses never become success through a different terminal page", async (t) => {
  for (const entry of [api(null, { status: 403 }), api(null, { badJson: true }),
    api({ ...feed([], false), errors: [{ message: "PRIVATE_RESPONSE" }] }), api({}, {}), api(null, { failed: true })]) {
    await t.test(JSON.stringify(entry), async () => {
      const result = await discover(fixture({ initial: [api(feed([post("p")], true))], scrolls: [[
        { ...entry, operation: "ProfileCometTimelineFeedPaginationQuery", variables: { cursor: "missing-page" } },
        api(feed([], false), { operation: "ProfileCometTimelineFeedPaginationQuery", variables: { cursor: "terminal-page" } }),
      ]] }));
      assert.equal(result.complete, false);
      assert.ok(result.parseIssues.length);
      assert.equal(JSON.stringify(result).includes("PRIVATE_RESPONSE"), false);
    });
  }
});

test("Facebook Wyy real response shape: streamed edges and deferred pagination complete without tile errors", async () => {
  const head = feed([post("head")]);
  const streamed = { path: ["node", "timeline_list_feed_units", "edges", 1], data: { node: post("streamed") },
    label: "ProfileCometTimelineFeed_user$stream$ProfileCometTimelineFeed_user_timeline_list_feed_units" };
  const pageInfo = { path: ["node", "timeline_list_feed_units"], data: { page_info: { has_next_page: false } },
    label: "ProfileCometTimelineFeed_user$defer$page_info" };
  const result = await discover(fixture({ initial: [
    api({ data: {}, errors: [{ message: "PRIVATE_TILE_ERROR" }] }, { operation: "ProfileCometTilesFeedPaginationQuery" }),
    api([head, streamed, pageInfo], { operation: "ProfileCometTimelineFeedRefetchQuery" }),
  ] }));
  assert.equal(result.complete, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.parseIssues, []);
});

test("Facebook optional component errors do not mask successfully read target feed", async () => {
  const data = feed([post("p")], false);
  data.data.node.header = { errors: [{ message: "PRIVATE_NESTED_ERROR" }] };
  data.data.node.timeline_list_feed_units.edges[0].node.feedback = { comments: { errors: [{ message: "PRIVATE_COMMENTS_ERROR" }] } };
  data.errors = [{ path: ["node", "header"], message: "PRIVATE_OPTIONAL_ERROR" }];
  const result = await discover(fixture({ initial: [api(data)] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.parseIssues, []);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("Facebook exact paging retry resolves its own transient error but preserves real attachment gaps", async () => {
  const result = await discover(fixture({ initial: [api(feed([post("head")], true))], scrolls: [[
    api(null, { operation: "ProfileCometTimelineFeedPaginationQuery", status: 503 }),
    api(feed([post("retry", [photo("retry", false)])], false), { operation: "ProfileCometTimelineFeedPaginationQuery" }),
  ]] }));
  assert.equal(result.complete, false);
  assert.equal(result.rangeComplete, true);
  assert.deepEqual(result.parseIssues, []);
  assert.equal(result.unresolvedMedia[0].reason, "media-url-missing");
});

test("Facebook a deferred feed error remains incomplete despite terminal metadata", async () => {
  const result = await discover(fixture({ initial: [api([feed([post("p")]),
    { path: ["node", "timeline_list_feed_units"], data: { page_info: { has_next_page: false } },
      errors: [{ message: "PRIVATE_FEED_ERROR" }] },
  ])] }));
  assert.equal(result.complete, false);
  assert.equal(result.rangeComplete, false);
  assert.ok(result.parseIssues.includes("graphql-error"));
  assert.equal(result.headCaptured, false);
});

test("Facebook unfinished response streams cannot confirm a complete head or history", async () => {
  for (const marker of [{ extensions: { is_final: false } }, { hasNext: true }]) {
    const result = await discover(fixture({ initial: [api({ ...feed([post("p")], false), ...marker })] }));
    assert.equal(result.complete, false);
    assert.equal(result.rangeComplete, false);
    assert.equal(result.headCaptured, false);
    assert.ok(result.parseIssues.includes("timeline-relay-stream-incomplete"));
  }
  const closed = await discover(fixture({ initial: [api([
    { ...feed([post("p")], false), extensions: { is_final: false } }, { extensions: { is_final: true } },
  ])] }));
  assert.equal(closed.complete, true);
  assert.equal(closed.headCaptured, true);
});

test("Facebook a late older failed attempt does not revoke its newer successful exact retry", async () => {
  const result = await discover(fixture({ initial: [api(feed([post("head")], true))], scrolls: [[
    api(null, { operation: "ProfileCometTimelineFeedPaginationQuery", status: 503, delayMs: 5 }),
    api(feed([post("retry")], false), { operation: "ProfileCometTimelineFeedPaginationQuery" }),
  ]] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.parseIssues, []);
});

test("Facebook a late older success cannot clear a newer same-page failure", async () => {
  const result = await discover(fixture({ initial: [api(feed([post("head")], true))], scrolls: [[
    api(feed([post("retry")], false), { operation: "ProfileCometTimelineFeedPaginationQuery", delayMs: 5 }),
    api(null, { operation: "ProfileCometTimelineFeedPaginationQuery", status: 503 }),
  ]] }));
  assert.equal(result.complete, false);
  assert.ok(result.parseIssues.includes("timeline-http-failure"));
});

test("Facebook a target request binds an alias before unrelated SSR Page terminal metadata", async () => {
  const wrong = feed([], false); wrong.data.node.__typename = "Page"; wrong.data.node.id = "other";
  const result = await discover(fixture({ ssr: html(wrong), initial: [api(feed([post("head")], true))] }), { profileId: "" });
  assert.equal(result.profileId, "target");
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.media.length, 1);
});

test("Facebook waits for issued pagination requests, revoking an early terminal on late continuation", async () => {
  const result = await discover(fixture({ initial: [api(feed([post("head")], false)),
    api(feed([post("late")], true), { operation: "ProfileCometTimelineFeedPaginationQuery", delayMs: 5 })] }));
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.posts.length, 2);
});

test("Facebook an older late terminal response cannot override a newer continuing page", async () => {
  const result = await discover(fixture({ ssr: html(feed([post("ssr")], true)), initial: [
    api(feed([post("older")], false), { delayMs: 5 }),
    api(feed([post("newer")], true), { operation: "ProfileCometTimelineFeedPaginationQuery" }),
  ] }));
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
});

test("Facebook pending requests and body reads have bounded incomplete exits", async (t) => {
  for (const hung of [{ hangRequest: true }, { hangBody: true }]) await t.test(JSON.stringify(hung), async () => {
    const result = await discover(fixture({ initial: [api(feed([post("head")], false)), api(feed([], false), hung)] }),
      { maxScrolls: 0, settleTimeoutMs: 5 });
    assert.equal(result.complete, false);
    assert.ok(result.parseIssues.includes("timeline-pending-timeout"));
  });
});

test("Facebook successful post refresh resolves missing URL even when the post was already encountered", async () => {
  const url = "https://www.facebook.com/target/posts/p";
  const result = await discover(fixture({ initial: [api(feed([post("p", [photo("p", false)])], false))],
    details: { [url]: { html: html(feed([post("p")], false)) } } }), { retryPosts: [url] });
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 1);
  assert.deepEqual(result.unresolvedMedia, []);
});

test("Facebook same-scan and previous-scan expected albums cannot shrink into complete posts", async () => {
  const partial = post("p", [photo("one")], { attachments: [{ subattachments: { count: 2, nodes: [{ media: photo("one") }] } }] });
  const current = await discover(fixture({ initial: [api(feed([partial], true))],
    scrolls: [[api(feed([post("p", [photo("one")])], false))]] }));
  assert.equal(current.complete, false);
  assert.equal(current.posts[0].mediaExpectedCount, 2);
  const next = await discover(fixture({ initial: [api(feed([post("p", [photo("one")])], false))] }),
    { knownPostCoverage: { p: { mediaExpectedCount: 2 } } });
  assert.equal(next.complete, false);
  assert.equal(next.posts[0].mediaExpectedCount, 2);
  const substituted = await discover(fixture({ initial: [api(feed([post("p", [photo("new")])], false))] }),
    { knownPostCoverage: { p: { mediaExpectedCount: 1, mediaExpectedKeys: ["p:missing"] } } });
  assert.equal(substituted.complete, false);
  assert.ok(substituted.unresolvedMedia.some((item) => item.reason === "previous-attachment-reference-missing"));
  const omitted = await discover(fixture({ initial: [api(feed([], false))] }),
    { knownPostCoverage: { p: { mediaExpectedCount: 2 } } });
  assert.equal(omitted.complete, false);
  assert.equal(omitted.unresolvedMedia[0].postKey, "p");
});

test("Facebook cancellation closes only its own fixture session", async () => {
  const controller = new AbortController(); controller.abort();
  const session = fixture();
  await assert.rejects(discoverFacebookMedia({ signal: controller.signal, browserType: session.browserType }), { name: "AbortError" });
  assert.equal(session.closed, false, "No browser was launched before cancellation");
});
