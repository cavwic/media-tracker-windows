import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { discoverXMedia, xDetailExplicitlyUnavailable } from "../lib/x-sync.mjs";

const photo = (id) => ({ type: "photo", media_url_https: `https://pbs.twimg.com/media/${id}.jpg` });
const video = (ready = true) => ({ type: "video", video_info: { variants: ready ? [{ content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4" }] : [] } });
function tweet(id, attachments = [photo(id)], author = "creator") {
  return { __typename: "Tweet", rest_id: String(id), core: { user_results: { result: { rest_id: author === "creator" ? "creator-user" : "other-user", legacy: { screen_name: author } } } },
    legacy: { created_at: "Sun Aug 30 09:01:29 +0000 2026", extended_entities: { media: attachments } } };
}
function timeline(tweets = [], { cursor, terminal = false } = {}) {
  const entries = tweets.map((value) => ({ entryId: `tweet-${value.rest_id}`, content: { itemContent: { tweet_results: { result: value } } } }));
  if (cursor !== undefined) entries.push({ entryId: "cursor-bottom", content: { cursorType: "Bottom", value: cursor } });
  return { data: { user: { result: { __typename: "User", rest_id: "creator-user", core: { screen_name: "creator" }, timeline_v2: { timeline: { instructions: [
    { type: "TimelineAddEntries", entries }, ...(terminal ? [{ type: "TimelineTerminateTimeline", direction: "Bottom" }] : []),
  ] } } } } } };
}
function response(payload, { operation = "UserTweets", cursor, postId, status = 200, jsonError = false, hostname = "x.com", userId = "creator-user", screenName = "creator" } = {}) {
  const variables = { ...(operation === "UserByScreenName" ? { screen_name: screenName } : operation !== "TweetDetail" && userId ? { userId } : {}),
    ...(cursor ? { cursor } : {}), ...(postId ? { focalTweetId: postId } : {}) };
  const url = `https://${hostname}/i/api/graphql/fixture/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const request = { url: () => url };
  return { url: () => url, request: () => request,
    status: () => status, json: async () => { if (jsonError) throw new SyntaxError("broken fixture JSON"); return payload; } };
}

async function fixture({ initial = [], html = "<html></html>", visible = [], issued = [], onScroll, onDetail, detailAvailability, ...options } = {}) {
  const page = new EventEmitter();
  let currentUrl = "https://x.com/creator";
  let currentHtml = html;
  let scrolls = 0;
  let contextClosed = false;
  let browserClosed = false;
  let launches = 0;
  let htmlReads = 0;
  const timers = [];
  const detailVisits = [];
  const emit = (responses) => {
    for (const value of responses || []) {
      const request = value.request();
      page.emit("request", request);
      page.emit("response", value);
      page.emit("requestfinished", request);
    }
  };
  page.url = () => currentUrl;
  page.goto = async (url) => {
    currentUrl = url;
    const postId = url.match(/\/status\/(\d+)/)?.[1];
    if (postId) {
      detailVisits.push(postId);
      currentHtml = "<html></html>";
      emit(await onDetail?.(postId));
    } else {
      emit(initial);
      for (const item of issued) {
        const request = item.response.request();
        page.emit("request", request);
        if (item.neverFinished) continue;
        timers.push(setTimeout(() => {
          if (item.failed) page.emit("requestfailed", request);
          else { page.emit("response", item.response); page.emit("requestfinished", request); }
        }, item.delayMs ?? 5));
      }
    }
  };
  page.content = async () => typeof currentHtml === "function" ? currentHtml(htmlReads++) : currentHtml;
  page.waitForTimeout = async () => {};
  page.evaluate = async (_callback, argument) => argument?.kind === "x-visible-posts" ? visible
    : argument?.kind === "x-detail-availability" ? typeof detailAvailability === "function" ? detailAvailability(argument.postId, currentUrl)
      : detailAvailability || {} : { timeZone: "Asia/Shanghai", records: [] };
  page.locator = () => ({ first: () => ({ isVisible: async () => false }) });
  page.mouse = { wheel: async () => { const count = scrolls++; emit(await onScroll?.(count)); } };
  const context = { pages: () => [page], close: async () => { contextClosed = true; } };
  const browserType = {
    launch: async () => { launches += 1; return { newContext: async () => context, close: async () => { browserClosed = true; } }; },
    launchPersistentContext: async () => { launches += 1; return context; },
  };
  let result;
  try { result = await discoverXMedia({ handle: "creator", browserType, maxScrolls: 20, requestSettleTimeoutMs: 100, ...options }); }
  finally {
    for (const timer of timers) clearTimeout(timer);
    assert.equal(launches, 1);
    assert.equal(contextClosed, true);
    if (!options.linkedAccount) assert.equal(browserClosed, true);
  }
  return { result, scrolls, detailVisits };
}

test("X discovery idle scrolling with a continuing cursor never claims the first scan complete", async () => {
  const { result, scrolls } = await fixture({ initial: [response(timeline([tweet(101)], { cursor: "more" }))] });
  assert.equal(scrolls, 6);
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.media.length, 1);
  assert.match(result.incompleteReason, /无进展/);
});

test("X missing cursor or empty entries alone never imply terminal pagination", async () => {
  for (const payload of [timeline([tweet(101)]), timeline([])]) {
    const { result } = await fixture({ initial: [response(payload)] });
    assert.equal(result.complete, false);
    assert.equal(result.reachedEnd, false);
  }
});

test("X explicit bottom terminal and explicit empty bottom cursor complete without extra scrolling", async () => {
  for (const pagination of [{ terminal: true }, { cursor: "" }]) {
    const { result, scrolls } = await fixture({ initial: [response(timeline([tweet(101)], pagination))] });
    assert.equal(result.complete, true);
    assert.equal(result.completionReason, "terminal-page");
    assert.equal(scrolls, 0);
  }
});

test("X first-screen embedded JSON retains newer media before a later older GraphQL page", async () => {
  const firstScreen = timeline([tweet(102, [photo("a"), photo("b")])]);
  const { result } = await fixture({ html: `<html><script type="application/json">${JSON.stringify(firstScreen)}</script></html>`,
    initial: [response(timeline([tweet(101)], { terminal: true }))] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.media.map((item) => item.logicalKey).sort(), ["101:1", "102:1", "102:2"]);
});

test("X normalized INITIAL_STATE is collected without treating hydration as terminal feed evidence", async () => {
  const state = { entities: { tweets: { "102": { id_str: "102", user_id_str: "author", created_at: "Sun Aug 30 09:01:29 +0000 2026",
    extended_entities: { media: [photo("a"), photo("b")] } } }, users: { author: { screen_name: "creator" } } } };
  const { result } = await fixture({ html: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};globalThis.noExecute=true;</script>` });
  assert.equal(result.media.length, 2);
  assert.equal(result.complete, false);
  assert.equal(globalThis.noExecute, undefined);
});

test("X visible first-screen posts omitted by GraphQL are refreshed before completion", async () => {
  const { result, detailVisits } = await fixture({ visible: ["102"], initial: [response(timeline([tweet(101)], { terminal: true }))],
    onDetail: (postId) => [response(timeline([tweet(postId, [photo("a"), photo("b")])]), { operation: "TweetDetail", postId })] });
  assert.deepEqual(detailVisits, ["102"]);
  assert.equal(result.complete, true);
  assert.equal(result.unresolvedMedia.length, 0);
  assert.equal(result.media.length, 3);
});

test("X visible but unparsed first-screen posts prevent a false complete receipt", async () => {
  const { result } = await fixture({ visible: ["102"], initial: [response(timeline([tweet(101)], { terminal: true }))] });
  assert.equal(result.complete, false);
  assert.equal(result.unresolvedMedia[0].postId, "102");
  assert.match(result.incompleteReason, /尚未完整解析/);
});

test("X partially hydrated attachments retain their post for a later retry", async () => {
  const { result, detailVisits } = await fixture({ initial: [response(timeline([tweet(101, [video(false)])], { terminal: true }))] });
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 0);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.unresolvedMedia[0].logicalKey, "101:1");
  assert.deepEqual(detailVisits, ["101"]);
});

test("X delayed media hydration counts as progress and a detail response can resolve the missing attachment", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101, [video(false)])], { terminal: true }))],
    onDetail: (postId) => [response(timeline([tweet(postId, [video()])]), { operation: "TweetDetail", postId })] });
  assert.equal(result.complete, true);
  assert.equal(result.unresolvedMedia.length, 0);
  assert.equal(result.posts[0].mediaComplete, true);
  assert.equal(result.media.length, 1);
});

test("X successfully indexed logical media can satisfy a missing URL, but unknown album items cannot", async () => {
  const recovered = await fixture({ knownMediaKeys: ["101:1"], initial: [response(timeline([tweet(101, [video(false)])], { terminal: true }))] });
  assert.equal(recovered.result.complete, true);
  const partial = tweet(101, [video(false)]);
  partial.legacy.media_count = 2;
  const missing = await fixture({ knownMediaKeys: ["101:1"], initial: [response(timeline([partial], { terminal: true }))] });
  assert.equal(missing.result.complete, false);
  assert.ok(missing.result.unresolvedMedia.some((item) => !item.logicalKey));
});

for (const failure of ["HTTP", "JSON", "GraphQL"]) {
  test(`X unrecovered ${failure} failure cannot be hidden by a later terminal page`, async () => {
    const failed = response(failure === "GraphQL" ? { errors: [{ message: "fixture error" }] } : {},
      { cursor: "failed-page", status: failure === "HTTP" ? 403 : 200, jsonError: failure === "JSON" });
    const { result } = await fixture({ initial: [response(timeline([tweet(101)], { cursor: "more" }))],
      onScroll: (count) => count === 0 ? [failed] : count === 1 ? [response(timeline([tweet(102)], { terminal: true }), { cursor: "last-page" })] : [] });
    assert.equal(result.complete, false);
    assert.equal(result.media.length, 2);
    assert.equal(result.parseIssues.length, 1);
    assert.equal(result.completionReason, null);
  });
}

test("X failure is recovered only by a successful response for the same request cursor", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101)], { cursor: "more" }))],
    onScroll: (count) => count === 0 ? [response({}, { cursor: "page-two", status: 429 })]
      : count === 1 ? [response(timeline([tweet(102)], { terminal: true }), { cursor: "page-two" })] : [] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.parseIssues, []);
});

test("X clean incremental batches can stop at the known boundary without an end cursor", async () => {
  const knownPosts = Object.fromEntries([101, 102, 103, 104, 105, 106].map((id) => [String(id), true]));
  const { result, scrolls } = await fixture({ initialComplete: true, knownPosts, since: "2026-10-05T00:00:00Z",
    initial: [response(timeline([101, 102, 103].map((id) => tweet(id)), { cursor: "next" }))],
    onScroll: (count) => count === 0 ? [response(timeline([104, 105, 106].map((id) => tweet(id)), { cursor: "still-more" }), { cursor: "next" })] : [] });
  assert.equal(result.complete, true);
  assert.equal(result.completionReason, "known-boundary");
  assert.equal(result.reachedEnd, false);
  assert.equal(scrolls, 1);
});

test("X request failures invalidate an old known batch; two fresh clean batches are required after recovery", async () => {
  const knownPosts = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(101 + index), true]));
  const { result, scrolls } = await fixture({ initialComplete: true, knownPosts, since: "2026-10-05T00:00:00Z",
    initial: [response(timeline([101, 102, 103].map((id) => tweet(id)), { cursor: "next" }))],
    onScroll: (count) => count === 0 ? [response({}, { cursor: "next", jsonError: true })]
      : count === 1 ? [response(timeline([104, 105, 106].map((id) => tweet(id)), { cursor: "more" }), { cursor: "next" })]
      : count === 2 ? [response(timeline([107, 108, 109].map((id) => tweet(id)), { cursor: "more-again" }), { cursor: "more" })] : [] });
  assert.equal(result.complete, true);
  assert.equal(result.completionReason, "known-boundary");
  assert.equal(scrolls, 3);
});

test("X stale retry URLs refresh even when their posts already appeared in the profile timeline", async () => {
  const { result, detailVisits } = await fixture({ retryPosts: ["https://x.com/creator/status/101"],
    initial: [response(timeline([tweet(101)], { terminal: true }))],
    onDetail: (postId) => [response(timeline([tweet(postId, [photo("refreshed")])]), { operation: "TweetDetail", postId })] });
  assert.deepEqual(detailVisits, ["101"]);
  assert.equal(result.media[0].sourceUrl, "https://pbs.twimg.com/media/refreshed.jpg?name=orig");
});

test("X replies from the target are retained while foreign authored media and untrusted GraphQL origins are rejected", async () => {
  const own = tweet(101);
  own.legacy.in_reply_to_status_id_str = "999";
  const { result } = await fixture({ initial: [response(timeline([own, tweet(999, [photo("foreign")], "other")], { cursor: "more" })),
    response(timeline([tweet(102)], { terminal: true }), { hostname: "untrusted.example" })] });
  assert.deepEqual(result.posts.map((post) => post.postId), ["101"]);
  assert.deepEqual(result.media.map((item) => item.postId), ["101"]);
  assert.equal(result.complete, false);
});

test("X discovery cancellation still closes its isolated browser resources", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture({ signal: controller.signal, initial: [response(timeline([tweet(101)], { cursor: "more" }))] }), { name: "AbortError" });
});

test("X waits for an already-issued request and retracts an earlier terminal page when more data arrives", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101)], { terminal: true }))],
    issued: [{ response: response(timeline([tweet(102)], { cursor: "more" }), { cursor: "late" }) }] });
  assert.equal(result.media.length, 2);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
});

test("X a never-finished issued request prevents a complete receipt and is waited only within the bound", async () => {
  const start = Date.now();
  const { result } = await fixture({ requestSettleTimeoutMs: 10, initial: [response(timeline([tweet(101)], { terminal: true }))],
    issued: [{ response: response({}, { cursor: "hung" }), neverFinished: true }] });
  assert.equal(result.complete, false);
  assert.match(result.parseIssues[0], /未完成的网络请求/);
  assert.ok(Date.now() - start < 1_000);
});

test("X requestfailed is not lost merely because no response event was delivered", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101)], { terminal: true }))],
    issued: [{ response: response({}, { cursor: "failed-before-headers" }), failed: true }] });
  assert.equal(result.complete, false);
  assert.match(result.parseIssues[0], /网络错误/);
});

test("X a late unknown post retracts an otherwise clean known boundary", async () => {
  const knownPosts = Object.fromEntries([101, 102, 103, 104, 105, 106].map((id) => [String(id), true]));
  const { result } = await fixture({ initialComplete: true, knownPosts, since: "2026-10-05T00:00:00Z",
    initial: [response(timeline([101, 102, 103].map((id) => tweet(id)), { cursor: "next" })),
      response(timeline([104, 105, 106].map((id) => tweet(id)), { cursor: "more" }), { cursor: "next" })],
    issued: [{ response: response(timeline([tweet(107)], { cursor: "still-more" }), { cursor: "more" }) }] });
  assert.equal(result.media.length, 7);
  assert.equal(result.complete, false);
  assert.equal(result.reachedKnownBoundary, false);
});

test("X partial GraphQL errors retain usable media but never confirm completion", async () => {
  const payload = { ...timeline([tweet(101)], { terminal: true }), errors: [{ message: "partial fixture" }] };
  const { result } = await fixture({ initial: [response(payload)] });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.parseIssues[0], /GraphQL/);
});

test("X secondary media-feed terminal or known batches cannot truncate the primary profile feed", async () => {
  const knownPosts = Object.fromEntries([101, 102, 103, 104, 105, 106].map((id) => [String(id), true]));
  const { result } = await fixture({ initialComplete: true, knownPosts, since: "2026-10-05T00:00:00Z",
    initial: [response(timeline([101, 102, 103].map((id) => tweet(id)), { cursor: "next" })),
      response(timeline([104, 105, 106].map((id) => tweet(id)), { terminal: true }), { operation: "UserMedia" })] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.reachedKnownBoundary, false);
});

test("X malformed first-screen hydration cannot be masked by terminal GraphQL pagination", async () => {
  const { result } = await fixture({ html: '<script>window.__INITIAL_STATE__ = {"entities":</script>',
    initial: [response(timeline([tweet(101)], { terminal: true }))] });
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
  assert.match(result.parseIssues[0], /首屏内嵌 JSON/);
});

test("X late first-screen hydration is recaptured before issuing a complete receipt", async () => {
  const firstScreen = timeline([tweet(102, [photo("a"), photo("b")])]);
  const { result } = await fixture({ html: (reads) => reads === 0 ? "<html></html>" : `<script type="application/json">${JSON.stringify(firstScreen)}</script>`,
    initial: [response(timeline([tweet(101)], { terminal: true }))] });
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 3);
});

test("X a hung JSON body is bounded and cannot erase previously discovered media", async () => {
  const hung = response({}, { cursor: "hung-body" });
  hung.json = () => new Promise(() => {});
  const start = Date.now();
  const { result } = await fixture({ requestSettleTimeoutMs: 10,
    initial: [response(timeline([tweet(101)], { cursor: "more" })), hung] });
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
  assert.match(result.parseIssues[0], /正文仍未读取完成/);
  assert.ok(Date.now() - start < 1_000);
});

test("X abort interrupts waiting for a pending request and still closes the isolated context", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(fixture({ signal: controller.signal, requestSettleTimeoutMs: 1_000,
      initial: [response(timeline([tweet(101)], { terminal: true }))],
      issued: [{ response: response({}, { cursor: "waiting" }), neverFinished: true }] }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});

test("X a later smaller album cannot clear an already observed missing attachment count", async () => {
  const partial = tweet(101, [photo("one")]);
  partial.legacy.media_count = 2;
  const { result } = await fixture({ initial: [response(timeline([partial], { terminal: true }))],
    onDetail: (postId) => [response(timeline([tweet(postId, [photo("one")])]), { operation: "TweetDetail", postId })] });
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.equal(result.posts[0].mediaReportedCount, 1);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.postId === "101" && !item.logicalKey));
});

test("X another user's same-operation terminal cannot end the target profile feed in either arrival order", async () => {
  const foreign = timeline([tweet(999, [photo("foreign")], "other")], { terminal: true });
  foreign.data.user.result.rest_id = "other-user";
  foreign.data.user.result.core.screen_name = "other";
  const own = response(timeline([tweet(101)], { cursor: "target-next" }));
  const other = response(foreign, { userId: "other-user" });
  for (const initial of [[other, own], [own, other]]) {
    const { result } = await fixture({ initial });
    assert.equal(result.complete, false);
    assert.equal(result.reachedEnd, false);
    assert.deepEqual(result.media.map((item) => item.postId), ["101"]);
    assert.deepEqual(result.parseIssues, []);
  }
});

test("X unscoped or owner-mismatched terminal responses cannot complete the target timeline", async () => {
  const unscoped = { data: { instructions: [
    { type: "TimelineAddEntries", entries: [tweet(101)] },
    { type: "TimelineTerminateTimeline", direction: "Bottom" },
  ] } };
  const mismatched = timeline([tweet(101)], { terminal: true });
  mismatched.data.user.result.rest_id = "other-user";
  const namedOther = timeline([tweet(101)], { terminal: true });
  namedOther.data.user.result.core.screen_name = "other";
  for (const payload of [unscoped, mismatched, namedOther]) {
    const { result } = await fixture({ initial: [response(payload)] });
    assert.equal(result.complete, false);
    assert.equal(result.reachedEnd, false);
    assert.match(result.parseIssues.join(" "), /归属于目标账号/);
    assert.equal(result.media.length, 1);
  }
});

test("X nested recommendation pagination does not supply the target feed's terminal proof", async () => {
  const value = tweet(101);
  value.related = { instructions: [{ type: "TimelineTerminateTimeline", direction: "Bottom" }] };
  const { result } = await fixture({ initial: [response(timeline([value], { cursor: "target-next" }))] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.parseIssues, []);
});

test("X an empty terminal requires target identity and replays safely when identity arrives later", async () => {
  const empty = timeline([], { terminal: true });
  delete empty.data.user.result.core;
  delete empty.data.user.result.rest_id;
  const lookup = response({ data: { user: { result: { __typename: "User", rest_id: "creator-user",
    core: { screen_name: "creator" } } } } }, { operation: "UserByScreenName" });
  for (const initial of [[lookup, response(empty)], [response(empty), lookup]]) {
    const { result } = await fixture({ initial });
    assert.equal(result.complete, true);
    assert.equal(result.reachedEnd, true);
    assert.equal(result.completionReason, "terminal-page");
    assert.deepEqual(result.parseIssues, []);
  }
  const { result } = await fixture({ initial: [response(empty)] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.match(result.parseIssues.join(" "), /归属于目标账号/);
});

test("X requestless target metadata can confirm a scoped terminal without inventing ownership", async () => {
  const { result } = await fixture({ initial: [response(timeline([], { terminal: true }), { userId: "" })] });
  assert.equal(result.complete, true);
  assert.equal(result.reachedEnd, true);
});

test("X a supplemental media terminal arriving first never replaces the primary posts feed", async () => {
  const { result } = await fixture({ initial: [
    response(timeline([tweet(102)], { terminal: true }), { operation: "UserMedia" }),
    response(timeline([tweet(101)], { cursor: "target-next" })),
  ] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.media.length, 2);
});

test("X cross-round expected album counts survive smaller fresh responses and trigger detail refresh", async () => {
  const { result, detailVisits } = await fixture({ knownPostCoverage: { "101": { mediaExpectedCount: 2 } },
    initial: [response(timeline([tweet(101, [photo("one")])], { terminal: true }))],
    onDetail: (postId) => [response(timeline([tweet(postId, [photo("one")])]), { operation: "TweetDetail", postId })] });
  assert.deepEqual(detailVisits, ["101"]);
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.postId === "101" && !item.logicalKey));
});

test("X cross-round expected media keys must be recovered or proved already saved", async () => {
  const options = { knownPostCoverage: { "101": { mediaExpectedCount: 2, mediaExpectedKeys: ["101:1", "101:2"] } },
    initial: [response(timeline([tweet(101, [photo("one")])], { terminal: true }))] };
  const missing = await fixture(options);
  assert.deepEqual(missing.detailVisits, ["101"]);
  assert.equal(missing.result.complete, false);
  assert.equal(missing.result.posts[0].mediaComplete, false);
  assert.deepEqual(missing.result.posts[0].mediaExpectedKeys, ["101:1", "101:2"]);
  assert.ok(missing.result.unresolvedMedia.some((item) => item.logicalKey === "101:2"));
  const saved = await fixture({ ...options, knownMediaKeys: ["101:2"] });
  assert.equal(saved.result.complete, true);
  assert.equal(saved.result.posts[0].mediaComplete, true);
  assert.deepEqual(saved.detailVisits, []);
});

test("X an older issued terminal arriving last cannot overwrite a newer continuing frontier", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101)], { cursor: "start" }))],
    issued: [
      { response: response(timeline([], { terminal: true }), { cursor: "older-page" }), delayMs: 15 },
      { response: response(timeline([tweet(102)], { cursor: "newer-frontier" }), { cursor: "newer-page" }), delayMs: 5 },
    ] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.parseIssues, []);
});

test("X an older continuing page arriving last cannot erase a newer terminal frontier", async () => {
  const { result } = await fixture({ initial: [response(timeline([tweet(101)], { cursor: "start" }))],
    issued: [
      { response: response(timeline([tweet(102)], { cursor: "old-more" }), { cursor: "older-page" }), delayMs: 15 },
      { response: response(timeline([], { terminal: true }), { cursor: "newer-page" }), delayMs: 5 },
    ] });
  assert.equal(result.complete, true);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.parseIssues, []);
});

test("X already-issued feed responses still retract terminal while the parser is refreshing a detail page", async () => {
  const { result, detailVisits } = await fixture({ requestSettleTimeoutMs: 5, knownPosts: { "101": true },
    initial: [response(timeline([tweet(101, [video(false)])], { terminal: true }))],
    issued: [{ response: response(timeline([tweet(101, [video(true)])], { cursor: "still-more" }), { cursor: "late-feed" }), delayMs: 15 }],
    onDetail: async (postId) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [response(timeline([tweet(postId, [video(true)])]), { operation: "TweetDetail", postId })];
    } });
  assert.deepEqual(detailVisits, ["101"]);
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.deepEqual(result.parseIssues, []);
});

function rootUnavailable(postId, reason = "Deleted") {
  return { data: { tweetResult: { result: { __typename: "TweetUnavailable", ...(reason ? { reason } : {}) } } } };
}

test("X explicit deleted detail observations resolve zero-expectation retries without deleting archive references", async () => {
  const { result, detailVisits } = await fixture({ knownPosts: { "101": true },
    knownMediaKeys: ["101:1"], retryPosts: ["https://x.com/creator/status/101"],
    knownPostCoverage: { "101": { mediaExpectedCount: 0, mediaExpectedKeys: [] } },
    initial: [response(timeline([], { terminal: true }))],
    onDetail: (postId) => [response(rootUnavailable(postId), { operation: "TweetDetail", postId })] });
  assert.deepEqual(detailVisits, ["101"]);
  assert.equal(result.complete, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.unavailablePosts[0].postId, "101");
  assert.equal(result.unavailablePosts[0].reasonCode, "post-deleted");
  assert.deepEqual(result.unresolvedMedia, []);
  assert.equal(result.media.length, 0);
  // Discovery emits no deletion command; existing logical files are supplied
  // only as coverage proof and remain the responsibility of the archive store.
  assert.equal(result.posts[0].mediaExpectedCount, 0);
});

test("X an explicit unavailable marker never clears a positive unproved attachment expectation", async () => {
  const { result } = await fixture({ knownPosts: { "101": true }, retryPosts: ["https://x.com/creator/status/101"],
    knownPostCoverage: { "101": { mediaExpectedCount: 2, mediaExpectedKeys: ["101:1", "101:2"] } },
    initial: [response(timeline([], { terminal: true }))],
    onDetail: (postId) => [response(rootUnavailable(postId), { operation: "TweetDetail", postId })] });
  assert.equal(result.complete, false);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.unavailablePosts.length, 1);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.logicalKey === "101:1"));
  assert.ok(result.unresolvedMedia.some((item) => item.logicalKey === "101:2"));
});

test("X incremental scans stop at a verified known range while retaining older attachment gaps for detail retry", async () => {
  const knownPosts = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(101 + index), true]));
  const partial = tweet(104, [photo("one")]);
  partial.legacy.media_count = 2;
  const { result, scrolls, detailVisits } = await fixture({ scanMode: "incremental", initialComplete: true, knownPosts,
    since: "2026-10-05T00:00:00Z", initial: [response(timeline([101, 102, 103].map((id) => tweet(id)), { cursor: "p2" }))],
    onScroll: (count) => count === 0 ? [response(timeline([partial, tweet(105), tweet(106)], { cursor: "p3" }), { cursor: "p2" })]
      : count === 1 ? [response(timeline([107, 108, 109].map((id) => tweet(id)), { cursor: "p4" }), { cursor: "p3" })]
      : count === 2 ? [response(timeline([110, 111, 112].map((id) => tweet(id)), { cursor: "still-more" }), { cursor: "p4" })] : [],
    onDetail: (postId) => [response(timeline([partial]), { operation: "TweetDetail", postId })] });
  assert.equal(scrolls, 3);
  assert.deepEqual(detailVisits, ["104"]);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.reachedKnownBoundary, true);
  assert.equal(result.rangeCompletionReason, "known-boundary");
  assert.equal(result.complete, false);
  assert.equal(result.completionReason, null);
  assert.ok(result.unresolvedMedia.some((item) => item.postId === "104"));
});

test("X retained bottom UI cursors cannot negate an explicit primary bottom termination", async () => {
  const payload = timeline([tweet(101)], { cursor: "retained-ui-cursor", terminal: true });
  payload.data.user.result.timeline_v2.timeline.instructions.reverse();
  const { result, scrolls } = await fixture({ initial: [response(payload)] });
  assert.equal(result.complete, true);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(scrolls, 0);
});

test("X incomplete first-page media cannot advance the daily baseline even when a later historical page ends", async () => {
  const { result } = await fixture({ scanMode: "incremental", initial: [response(timeline([tweet(101, [video(false)])], { cursor: "more" }))],
    onScroll: (count) => count === 0 ? [response(timeline([tweet(102)], { terminal: true }), { cursor: "more" })] : [] });
  assert.equal(result.reachedEnd, true);
  assert.equal(result.headCaptured, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.complete, false);
});

function emptyDetail(postId) {
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: "TimelineAddEntries", entries: [
    { entryId: `tweet-${postId}`, content: { itemContent: { __typename: "TimelineTweet", itemType: "TimelineTweet",
      tweetDisplayType: "Tweet", tweet_results: {} } } },
  ] }] } } };
}

const unavailableSnapshot = (postId, text = "唔...该页面不存在。请尝试搜索别的内容。") => ({
  url: `https://x.com/creator/status/${postId}`, text, hasTweet: false, hasLoginField: false, hasChallenge: false,
});

test("X successful empty focal API root plus its explicit missing detail page resolves an untyped stale placeholder", async () => {
  const { result } = await fixture({ knownPostCoverage: { "101": { mediaExpectedCount: 0, mediaExpectedKeys: [] } },
    retryPosts: ["https://x.com/creator/status/101"], initial: [response(timeline([], { terminal: true }))],
    onDetail: (postId) => [response(emptyDetail(postId), { operation: "TweetDetail", postId })],
    detailAvailability: (postId) => unavailableSnapshot(postId) });
  assert.equal(result.complete, true);
  assert.equal(result.unavailablePosts[0].postId, "101");
  assert.equal(result.unavailablePosts[0].reasonCode, "post-unavailable");
  assert.equal(result.posts[0].mediaExpectedCount, 0);
  assert.deepEqual(result.unresolvedMedia, []);
});

test("X explicit missing page confirmation preserves positive old attachment expectations and saved logical references", async () => {
  const { result } = await fixture({ knownPostCoverage: { "101": { mediaExpectedCount: 2, mediaExpectedKeys: ["101:1", "101:2"] } },
    knownMediaKeys: ["101:1"], retryPosts: ["https://x.com/creator/status/101"], initial: [response(timeline([], { terminal: true }))],
    onDetail: (postId) => [response(emptyDetail(postId), { operation: "TweetDetail", postId })],
    detailAvailability: (postId) => unavailableSnapshot(postId) });
  assert.equal(result.complete, false);
  assert.equal(result.unavailablePosts[0].reasonCode, "post-unavailable");
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.deepEqual(result.posts[0].mediaExpectedKeys, ["101:1", "101:2"]);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.postId === "101"));
  assert.equal(result.media.length, 0);
});

test("X empty roots alone, a different focal request and GraphQL errors cannot certify remote deletion", async () => {
  for (const variant of ["no-ui", "wrong-request", "graphql-error", "no-api"]) {
    const { result } = await fixture({ retryPosts: ["https://x.com/creator/status/101"], visible: ["101"],
      initial: [response(timeline([], { terminal: true }))],
      onDetail: (postId) => variant === "no-api" ? [] : [response(variant === "graphql-error"
        ? { ...emptyDetail(postId), errors: [{ message: "fixture access error" }] } : emptyDetail(postId),
      { operation: "TweetDetail", postId: variant === "wrong-request" ? "999" : postId })],
      detailAvailability: variant === "no-ui" ? {} : (postId) => unavailableSnapshot(postId) });
    assert.equal(result.complete, false, variant);
    assert.deepEqual(result.unavailablePosts, [], variant);
    assert.ok(result.unresolvedMedia.some((item) => item.postId === "101"), variant);
  }
});

test("X missing-page UI cannot resolve placeholders while login, challenge, generic network failure or a tweet remains visible", () => {
  for (const snapshot of [
    { ...unavailableSnapshot("101"), hasTweet: true },
    { ...unavailableSnapshot("101"), hasLoginField: true },
    { ...unavailableSnapshot("101"), hasChallenge: true },
    unavailableSnapshot("999"),
    unavailableSnapshot("101", "This page doesn't exist. Log in to X"),
    unavailableSnapshot("101", "This page doesn't exist. Something went wrong. Try again."),
    unavailableSnapshot("101", "You are not authorized to view this Post."),
    { ...unavailableSnapshot("101"), url: "https://x.com/i/flow/login" },
  ]) assert.equal(xDetailExplicitlyUnavailable(snapshot, { handle: "creator", postId: "101" }), false);
  for (const text of ["This page doesn’t exist. Try searching for something else.", "唔...该页面不存在。请尝试搜索别的内容。", "このページは存在しません。別のものを検索してみてください。"])
    assert.equal(xDetailExplicitlyUnavailable(unavailableSnapshot("101", text), { handle: "creator", postId: "101" }), true);
});
