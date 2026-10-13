import test from "node:test";
import assert from "node:assert/strict";
import { extractXTimeline, parseXInitialState, resolveXHandle } from "../lib/x-media.mjs";

function tweet(id, screenName, media, createdAt = "Sun Aug 30 09:01:29 +0000 2026") {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: { user_results: { result: { core: { screen_name: screenName } } } },
    legacy: { created_at: createdAt, possibly_sensitive: true, extended_entities: { media } },
  };
}

test("X handles are resolved from profile URLs before display labels", () => {
  assert.equal(resolveXHandle({ profileUrl: "https://x.com/Creator_1/media", label: "显示名" }), "Creator_1");
  assert.equal(resolveXHandle({ label: "@fallback" }), "fallback");
  assert.equal(resolveXHandle({ profileUrl: "https://x.com/home", label: "not a handle!" }), "");
});

test("X timeline parser keeps target media and selects the highest bitrate MP4", () => {
  const targetTweet = tweet("123", "Creator_1", [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/example.jpg" },
    {
      type: "video",
      video_info: { variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/list.m3u8" },
        { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/low.mp4" },
        { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
        { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
      ] },
    },
    {
      type: "animated_gif",
      video_info: { variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/animation.mp4" }] },
    },
  ]);
  const otherTweet = tweet("999", "somebody_else", [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/other.jpg" },
  ]);
  const payload = { data: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: targetTweet } } } } },
    { content: { itemContent: { tweet_results: { result: otherTweet } } } },
  ] }] } };

  const result = extractXTimeline(payload, "creator_1");
  assert.deepEqual(result.posts.map((post) => post.postId), ["123"]);
  assert.deepEqual(result.media.map((item) => item.kind), ["image", "video", "gif"]);
  assert.equal(result.media[0].sourceUrl, "https://pbs.twimg.com/media/example.jpg?name=orig");
  assert.equal(result.media[1].sourceUrl, "https://video.twimg.com/high.mp4");
  assert.equal(result.media[1].bitrate, 2176000);
  assert.deepEqual(result.media[1].variants, [
    { sourceUrl: "https://video.twimg.com/high.mp4", bitrate: 2176000 },
    { sourceUrl: "https://video.twimg.com/low.mp4", bitrate: 256000 },
  ]);
  assert.equal(result.media[2].extension, ".mp4");
  assert.equal(result.media[0].sensitive, true);
  assert.deepEqual(result.media.map((item) => item.logicalKey), ["123:1", "123:2", "123:3"]);
});

test("X parser distinguishes explicit terminal pagination from unknown or continuing cursors", () => {
  const cursor = (value) => ({ data: { instructions: [{ type: "TimelineAddEntries", entries: [
    { content: { cursorType: "Bottom", ...(value === undefined ? {} : { value }) } },
  ] }] } });
  assert.equal(extractXTimeline(cursor("more"), "creator").pagination.endConfirmed, false);
  assert.equal(extractXTimeline(cursor(undefined), "creator").pagination.endConfirmed, false);
  assert.equal(extractXTimeline(cursor(""), "creator").pagination.endConfirmed, true);
  assert.equal(extractXTimeline({ data: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } }, "creator").pagination.endConfirmed, false);
  assert.equal(extractXTimeline({ data: { instructions: [{ type: "TimelineTerminateTimeline", direction: "Bottom" }] } }, "creator").pagination.endConfirmed, true);
  assert.equal(extractXTimeline({ data: { instructions: [{ type: "TimelineTerminateTimeline", direction: "Top" }] } }, "creator").pagination.endConfirmed, false);
  assert.equal(extractXTimeline({ data: { instructions: [
    { type: "TimelineTerminateTimeline", direction: "Bottom" },
    { type: "TimelineAddEntries", entries: [{ content: { cursorType: "Bottom", value: "newer-frontier" } }] },
  ] } }, "creator").pagination.endConfirmed, true);
});

test("X parser reports unhydrated and unsupported attachments instead of silently completing their posts", () => {
  const value = tweet("101", "creator", [
    { type: "photo" }, { type: "video", video_info: { variants: [] } }, { type: "unknown" },
  ]);
  const parsed = extractXTimeline(value, "creator");
  assert.equal(parsed.posts[0].mediaComplete, false);
  assert.equal(parsed.media.length, 0);
  assert.deepEqual(parsed.unresolvedMedia.map((item) => item.logicalKey), ["101:1", "101:2", "101:3"]);
  assert.deepEqual(parsed.unresolvedMedia.map((item) => item.postId), ["101", "101", "101"]);
  assert.deepEqual(parsed.posts[0].mediaExpectedKeys, ["101:1", "101:2"]);
});

test("X scoped pagination belongs only to the top-level user timeline container", () => {
  const value = tweet("109", "creator", []);
  value.related = { instructions: [{ type: "TimelineTerminateTimeline", direction: "Bottom" }] };
  const parsed = extractXTimeline({ data: { user: { result: { rest_id: "target-id", core: { screen_name: "creator" },
    timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [
      { content: { cursorType: "Bottom", value: "target-next" } }, value] }] } } } } } }, "creator");
  assert.equal(parsed.pagination.endConfirmed, true);
  assert.equal(parsed.timelineScope.present, true);
  assert.equal(parsed.timelineScope.ownerId, "target-id");
  assert.equal(parsed.timelineScope.ownerHandle, "creator");
  assert.equal(parsed.timelineScope.pagination.endConfirmed, false);
  assert.deepEqual(parsed.targetUserIds, ["target-id"]);
});

test("X preview-only media and declared album counts remain incomplete", () => {
  const preview = tweet("102", "creator", []);
  delete preview.legacy.extended_entities;
  preview.legacy.entities = { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/preview.jpg" }] };
  const parsedPreview = extractXTimeline(preview, "creator");
  assert.equal(parsedPreview.media.length, 1);
  assert.equal(parsedPreview.posts[0].mediaComplete, false);
  assert.equal(parsedPreview.posts[0].mediaExpectedCount, 1);
  const partial = tweet("103", "creator", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/one.jpg" }]);
  partial.legacy.media_count = 2;
  assert.equal(extractXTimeline(partial, "creator").posts[0].mediaComplete, false);
  assert.equal(extractXTimeline(partial, "creator").posts[0].mediaExpectedCount, 2);
});

test("X same-payload larger partial album versions cannot hide behind earlier complete smaller versions", () => {
  const small = tweet("110", "creator", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/one.jpg" }]);
  const larger = tweet("110", "creator", [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/one.jpg" }, { type: "photo" },
  ]);
  for (const entries of [[small, larger], [larger, small]]) {
    const parsed = extractXTimeline({ entries }, "creator");
    assert.equal(parsed.posts[0].mediaExpectedCount, 2);
    assert.deepEqual(parsed.posts[0].mediaExpectedKeys, ["110:1", "110:2"]);
    assert.equal(parsed.posts[0].mediaComplete, false);
    assert.ok(parsed.unresolvedMedia.some((item) => item.logicalKey === "110:2"));
    assert.equal(parsed.media.length, 1);
  }
});

test("X same-payload earlier full album still proves a later missing URL without losing coverage", () => {
  const full = tweet("111", "creator", [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/one.jpg" },
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/two.jpg" },
  ]);
  const partial = tweet("111", "creator", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/one.jpg" }, { type: "photo" }]);
  for (const entries of [[full, partial], [partial, full]]) {
    const parsed = extractXTimeline({ entries }, "creator");
    assert.equal(parsed.posts[0].mediaExpectedCount, 2);
    assert.equal(parsed.posts[0].mediaComplete, true);
    assert.deepEqual(parsed.unresolvedMedia, []);
    assert.equal(parsed.media.length, 2);
  }
});

test("X pins propagate to the boundary, target replies remain, and nested quoted authors do not form feed posts", () => {
  const pinned = tweet("104", "creator", []);
  const reply = tweet("105", "creator", []);
  reply.legacy.in_reply_to_status_id_str = "999";
  const foreign = tweet("999", "other", []);
  foreign.quoted_status_result = { result: tweet("106", "creator", []) };
  const parsed = extractXTimeline({ data: { instructions: [
    { type: "TimelinePinEntry", entry: { content: { itemContent: { tweet_results: { result: pinned } } } } },
    { type: "TimelineAddEntries", entries: [reply, foreign] },
  ] } }, "creator");
  assert.deepEqual(parsed.posts.map((post) => post.postId), ["104", "105"]);
  assert.equal(parsed.posts[0].pinned, true);
  assert.equal(parsed.posts[1].pinned, false);
});

test("X independently identified unreadable target entries retain an unresolved post identity", () => {
  const parsed = extractXTimeline({ data: { instructions: [{ type: "TimelineAddEntries", entries: [
    { entryId: "tweet-107", content: { itemContent: { itemType: "TimelineTweet", tweet_results: { result: { __typename: "TweetUnavailable" } } } } },
  ] }] } }, "creator", { expectedPostIds: ["107"] });
  assert.equal(parsed.unresolvedMedia[0].postId, "107");
  assert.equal(parsed.unresolvedMedia[0].postUrl, "https://x.com/creator/status/107");
});

function unavailableEntry(postId, result, { repost = false } = {}) {
  return { entryId: `tweet-${postId}`, content: { itemContent: { itemType: "TimelineTweet",
    ...(repost ? { socialContext: { contextType: "Retweet" } } : {}),
    ...(result === undefined ? {} : { tweet_results: { result } }),
  } } };
}

test("X explicit deleted and unavailable root entries are terminal observations, not invented missing attachments", () => {
  for (const result of [
    { __typename: "TweetUnavailable", reason: "Deleted" },
    { __typename: "TweetTombstone", tombstone: { text: { text: "This Post was deleted by the Post author." } } },
    { __typename: "TweetTombstone", tombstone: { text: { text: "This Tweet is unavailable." } } },
  ]) {
    const parsed = extractXTimeline({ instructions: [{ type: "TimelineAddEntries", entries: [unavailableEntry("201", result)] }] }, "creator");
    assert.deepEqual(parsed.unresolvedMedia, []);
    assert.equal(parsed.media.length, 0);
    assert.equal(parsed.posts[0].postKey, "201");
    assert.equal(parsed.posts[0].mediaComplete, true);
    assert.equal(parsed.posts[0].mediaExpectedCount, 0);
    assert.equal(parsed.unavailablePosts[0].postId, "201");
    assert.match(parsed.unavailablePosts[0].reasonCode, /^post-(?:deleted|unavailable)$/);
    assert.deepEqual(parsed.resolvedPostIds, ["201"]);
  }
});

test("X blank unavailable results require independent target evidence and unknown-author reposts do not fabricate target gaps", () => {
  const blank = { __typename: "TweetUnavailable" };
  const feed = (entry) => ({ instructions: [{ type: "TimelineAddEntries", entries: [entry] }] });
  assert.deepEqual(extractXTimeline(feed(unavailableEntry("202", blank)), "creator").unresolvedMedia, []);
  assert.deepEqual(extractXTimeline(feed(unavailableEntry("202", blank, { repost: true })), "creator", { expectedPostIds: ["202"] }).unresolvedMedia, []);
  const incomplete = extractXTimeline(feed(unavailableEntry("202", blank)), "creator", { expectedPostIds: ["202"] });
  assert.equal(incomplete.unresolvedMedia[0].postId, "202");
  assert.deepEqual(incomplete.unavailablePosts, []);
  const absent = extractXTimeline(feed(unavailableEntry("203", undefined)), "creator", { expectedPostIds: ["203"] });
  assert.equal(absent.unresolvedMedia[0].postId, "203");
});

test("X partial target posts remain pending while partial foreign authors cannot create target gaps", () => {
  const own = tweet("204", "creator", []);
  delete own.legacy;
  const other = tweet("205", "other", []);
  delete other.legacy;
  const unknown = { __typename: "Tweet", rest_id: "206" };
  const parsed = extractXTimeline({ entries: [own, other, unknown] }, "creator");
  assert.deepEqual(parsed.unresolvedMedia.map((item) => item.postId), ["204"]);
  assert.deepEqual(parsed.posts, []);
  const known = extractXTimeline(unknown, "creator", { expectedPostIds: ["206"] });
  assert.equal(known.unresolvedMedia[0].postId, "206");
  const missingScreenName = { __typename: "Tweet", rest_id: "210", legacy: { user_id_str: "target-user-id" } };
  const scoped = extractXTimeline({ data: { user: { result: { rest_id: "target-user-id", core: { screen_name: "creator" },
    timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [missingScreenName] }] } } } } } }, "creator");
  assert.equal(scoped.unresolvedMedia[0].postId, "210");
});

test("X a nested tombstone or unknown quote wrapper never inherits its outer target post identity", () => {
  const own = tweet("207", "creator", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/own.jpg" }]);
  own.unknownQuoteWrapper = { __typename: "TweetTombstone", reason: "Deleted" };
  own.anotherQuoteWrapper = { result: { __typename: "Tweet", rest_id: "208" } };
  const parsed = extractXTimeline({ instructions: [{ type: "TimelineAddEntries", entries: [unavailableEntry("207", own)] }] }, "creator");
  assert.equal(parsed.posts[0].mediaComplete, true);
  assert.deepEqual(parsed.unresolvedMedia, []);
  assert.deepEqual(parsed.unavailablePosts, []);
  assert.deepEqual(parsed.posts.map((post) => post.postId), ["207"]);
});

test("X requested detail unavailable identity is applied only to the root result and access restrictions remain pending", () => {
  const deleted = extractXTimeline({ data: { tweetResult: { result: { __typename: "TweetUnavailable", reason: "NotFound" } } } }, "creator", { requestedPostId: "209" });
  assert.equal(deleted.unavailablePosts[0].postId, "209");
  const restricted = extractXTimeline({ data: { tweetResult: { result: { __typename: "TweetTombstone",
    tombstone: { text: { text: "You are not authorized to view this Tweet." } } } } } }, "creator", { requestedPostId: "209" });
  assert.deepEqual(restricted.unavailablePosts, []);
  assert.equal(restricted.unresolvedMedia[0].postId, "209");
});

test("X scoped bottom termination survives retained cursor instructions in either order", () => {
  const termination = { type: "TimelineTerminateTimeline", direction: "Bottom" };
  const cursor = { type: "TimelineAddEntries", entries: [{ content: { cursorType: "Bottom", value: "retained-ui-cursor" } }] };
  for (const instructions of [[termination, cursor], [cursor, termination]]) {
    const parsed = extractXTimeline({ data: { user: { result: { rest_id: "creator-user", core: { screen_name: "creator" },
      timeline_v2: { timeline: { instructions } } } } } }, "creator");
    assert.equal(parsed.timelineScope.pagination.endConfirmed, true);
    assert.equal(parsed.timelineScope.pagination.bottomCursor, "retained-ui-cursor");
  }
});

test("X empty root tweet_results are metadata hints only and quoted empty objects never borrow an outer post ID", () => {
  const empty = unavailableEntry("211", undefined);
  empty.content.itemContent.tweet_results = {};
  const parsed = extractXTimeline({ instructions: [{ type: "TimelineAddEntries", entries: [empty] }] }, "creator", { requestedPostId: "211" });
  assert.deepEqual(parsed.emptyRootPostIds, ["211"]);
  assert.deepEqual(parsed.unavailablePosts, []);
  assert.equal(parsed.unresolvedMedia[0].postId, "211");
  const valid = tweet("212", "creator", []);
  valid.unfamiliarQuote = { itemType: "TimelineTweet", tweet_results: {} };
  const nested = extractXTimeline({ instructions: [{ type: "TimelineAddEntries", entries: [unavailableEntry("212", valid)] }] }, "creator");
  assert.deepEqual(nested.emptyRootPostIds, []);
  assert.deepEqual(nested.unavailablePosts, []);
  assert.deepEqual(nested.unresolvedMedia, []);
});

test("X embedded state uses JSON parsing, supports normalized entities, and never executes trailing scripts", () => {
  const state = { entities: { tweets: { entities: {
    "108": { id_str: "108", user_id_str: "author", created_at: "Sun Aug 30 09:01:29 +0000 2026",
      extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/braces.jpg" }] }, text: 'escaped " quote } ; [' },
  } }, users: { entities: { author: { screen_name: "creator" } } } } };
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};globalThis.__xParserExecuted = true;</script>
    <script type="application/json">${JSON.stringify({ data: { marker: true } })}</script>`;
  const payloads = parseXInitialState(html);
  assert.equal(payloads.length, 2);
  assert.equal(extractXTimeline(payloads[0], "creator").media[0].postId, "108");
  assert.equal(globalThis.__xParserExecuted, undefined);
  assert.deepEqual(parseXInitialState('<script>window.__INITIAL_STATE__ = (() => { throw new Error("must not execute"); })();</script>'), []);
  const issues = [];
  parseXInitialState('<script>window.__INITIAL_STATE__ = {"entities":</script>', { onIssue: (issue) => issues.push(issue) });
  assert.match(issues[0], /不完整/);
  const nested = extractXTimeline({ props: { pageProps: { state } } }, "creator");
  assert.equal(nested.media[0].postId, "108");
});

