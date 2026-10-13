import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFacebookTimeline,
  assembleFacebookResponse,
  materializeFacebookMedia,
  parseFacebookResponseText,
  parseFacebookHtml,
  resolveFacebookProfile,
} from "../lib/facebook-media.mjs";

test("Facebook profile URLs retain a numeric target id", () => {
  const profile = resolveFacebookProfile({ profileUrl: "https://web.facebook.com/profile.php?id=61590000000001" });
  assert.equal(profile.profileId, "61590000000001");
  assert.equal(profile.profileUrl, "https://www.facebook.com/profile.php?id=61590000000001");
});

test("Facebook JSON streams cannot silently discard corrupt pagination lines", () => {
  assert.throws(() => parseFacebookResponseText('{"data":{}}\n{broken\n'), SyntaxError);
});

test("Facebook SSR decodes Relay prefetched JSON but never executable script or JSON-looking captions", () => {
  const data = { data: { node: { __typename: "User", id: "target", timeline_list_feed_units: { edges: [] } } } };
  const wrapper = { require: [["RelayPrefetchedStreamCache", "add", null, ["key", JSON.stringify(data)]]],
    message: { text: JSON.stringify({ data: { forged: true } }) } };
  const parsed = parseFacebookHtml(`<script>throw Error('must not execute')</script><script type="application/json" data-sjs>${JSON.stringify(wrapper)}</script>`);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], data);
  assert.equal(parsed.some((item) => item.data?.forged), false);
  assert.throws(() => parseFacebookHtml('<script type="application/json">{broken</script>'), SyntaxError);
});

test("Facebook unresolved attachment URLs and truncated albums remain explicit", () => {
  const payload = { data: { node: { __typename: "User", id: "target", timeline_list_feed_units: { page_info: { has_next_page: false },
    edges: [{ node: { __typename: "Story", post_id: "album", actors: [{ id: "target" }],
      attachments: [{ subattachments: { count: 2, nodes: [{ media: { __typename: "Photo", id: "photo" } }] } }] } }] } } } };
  const parsed = extractFacebookTimeline(payload, "target");
  assert.equal(parsed.posts[0].mediaComplete, false);
  assert.equal(parsed.posts[0].mediaExpectedCount, 2);
  assert.equal(parsed.refs.length, 1);
  assert.deepEqual(parsed.unresolvedMedia.map((item) => item.reason), ["media-url-missing", "attachment-coverage-incomplete"]);
});

test("Facebook unknown media types cannot masquerade as text-only completed posts", () => {
  const parsed = extractFacebookTimeline({ data: { node: { __typename: "User", id: "target", timeline_list_feed_units: { edges: [{
    node: { __typename: "Story", post_id: "p", actors: [{ id: "target" }], attachments: [{ media: { __typename: "UnifiedMedia", id: "opaque" } }] },
  }] } } } });
  assert.equal(parsed.posts[0].mediaComplete, false);
  assert.equal(parsed.unresolvedMedia[0].reason, "attachment-coverage-incomplete");
});

test("Facebook ignores other profile pagination and rejects lookalike CDN hosts", () => {
  const payload = { data: { node: { __typename: "User", id: "other", timeline_list_feed_units: { page_info: { has_next_page: false },
    edges: [{ node: { __typename: "Story", post_id: "p", actors: [{ id: "target" }],
      attachments: [{ media: { __typename: "Photo", id: "photo", image: { uri: "https://notfbcdn.net/forged.jpg" } } }] } }] } } } };
  const parsed = extractFacebookTimeline(payload, "target");
  assert.equal(parsed.recognized, false);
  assert.deepEqual(parsed.pagination, []);
  assert.deepEqual(parsed.catalog, []);
  assert.deepEqual(parsed.posts, []);
});

test("Facebook Page owners cannot lend terminal pagination to another target", () => {
  const payload = { data: { node: { __typename: "Page", id: "other", timeline_list_feed_units: {
    edges: [], page_info: { has_next_page: false },
  } } } };
  const parsed = extractFacebookTimeline(payload, "target");
  assert.equal(parsed.recognized, false);
  assert.deepEqual(parsed.pagination, []);
  const target = extractFacebookTimeline(payload, "other");
  assert.equal(target.recognized, true);
  assert.equal(target.pagination[0].hasNextPage, false);
});

test("Facebook Relay stream edges and deferred page_info assemble into one target document", () => {
  const story = { __typename: "Story", post_id: "streamed", actors: [{ id: "target" }], attachments: [] };
  const first = { data: { node: { __typename: "User", id: "target", timeline_list_feed_units: { edges: [] } } } };
  const assembled = assembleFacebookResponse([first,
    { path: ["node", "timeline_list_feed_units", "edges", 0], label: "ProfileCometTimelineFeed_user$stream$ProfileCometTimelineFeed_user_timeline_list_feed_units", data: { node: story } },
    { path: ["node", "timeline_list_feed_units"], label: "ProfileCometTimelineFeed_user$defer$page_info", data: { page_info: { has_next_page: false, end_cursor: "end" } } },
  ]);
  assert.deepEqual(assembled.patchIssues, []);
  assert.equal(first.data.node.timeline_list_feed_units.edges.length, 0, "Assembler does not mutate captured payloads");
  const parsed = extractFacebookTimeline(assembled.payloads[0], "target");
  assert.equal(parsed.posts[0].postId, "streamed");
  assert.deepEqual(parsed.pagination, [{ hasNextPage: false, endCursor: "end" }]);
});

test("Facebook Relay orphan and prototype patches cannot create a fake target or terminal", () => {
  const root = { data: { node: { id: "target", timeline_list_feed_units: { edges: [] } } } };
  for (const payloads of [
    [{ path: ["node", "timeline_list_feed_units"], data: { page_info: { has_next_page: false } } }],
    [root, { path: ["node", "timeline_list_feed_units", "__proto__", "polluted"], data: true }],
    [root, { path: ["node", "timeline_list_feed_units", "edges", 100_001], data: { node: {} } }],
    [root, { path: ["node", "timeline_list_feed_units", "missing", "page_info"], data: { has_next_page: false } }],
  ]) {
    const assembled = assembleFacebookResponse(payloads);
    assert.ok(assembled.patchIssues.length);
    assert.equal({}.polluted, undefined);
    assert.ok(assembled.payloads.every((item) => !extractFacebookTimeline(item, "target").pagination.length));
  }
});

test("Facebook GraphQL incremental items and relative error paths retain feed ownership", () => {
  const root = { data: { node: { __typename: "Page", id: "target", timeline_list_feed_units: { edges: [] } } } };
  const assembled = assembleFacebookResponse([root, { incremental: [
    { path: ["node", "timeline_list_feed_units", "edges", 0], items: [
      { node: { __typename: "Story", post_id: "one", actors: [{ id: "target" }], attachments: [] } },
      { node: { __typename: "Story", post_id: "two", actors: [{ id: "target" }], attachments: [] } },
    ] },
    { path: ["node", "timeline_list_feed_units"], data: { page_info: { has_next_page: false } },
      errors: [{ path: ["page_info"], message: "PRIVATE_RELATIVE_FEED_ERROR" }] },
  ] }]);
  assert.deepEqual(assembled.patchIssues, []);
  const parsed = extractFacebookTimeline(assembled.payloads[0], "target");
  assert.deepEqual(parsed.posts.map((item) => item.postId), ["one", "two"]);
  assert.equal(parsed.hasErrors, true);
});

test("Facebook explicit open Relay streams require a final closing marker", () => {
  const root = { data: { node: { id: "target", timeline_list_feed_units: { edges: [], page_info: { has_next_page: false } } } } };
  for (const [open, closed] of [[{ extensions: { is_final: false } }, { extensions: { is_final: true } }],
    [{ hasNext: true }, { hasNext: false }]]) {
    const partial = assembleFacebookResponse([{ ...root, ...open }]);
    assert.ok(partial.patchIssues.includes("timeline-relay-stream-incomplete"));
    const final = assembleFacebookResponse([{ ...root, ...open }, closed]);
    assert.deepEqual(final.patchIssues, []);
    assert.equal(extractFacebookTimeline(final.payloads[0], "target").pagination[0].hasNextPage, false);
  }
});

test("Facebook Relay patches cannot mutate existing owner or story identity", () => {
  const root = { data: { node: { __typename: "Page", id: "other", timeline_list_feed_units: { edges: [
    { node: { __typename: "Story", id: "story", post_id: "post", actors: [{ id: "other" }], attachments: [] } },
  ], page_info: { has_next_page: false } } } } };
  for (const patch of [
    { path: ["node", "id"], data: "target" },
    { path: ["node", "__typename"], data: "User" },
    { path: ["node"], data: { id: "target" } },
    { path: ["node", "timeline_list_feed_units", "edges", 0], data: { node: { id: "forged-story" } } },
    { path: ["node", "timeline_list_feed_units", "edges", 0, "node", "post_id"], data: "forged-post" },
  ]) {
    const assembled = assembleFacebookResponse([root, patch]);
    assert.ok(assembled.patchIssues.length);
    assert.equal(assembled.payloads[0].data.node.id, "other");
    assert.equal(assembled.payloads[0].data.node.__typename, "Page");
    assert.equal(extractFacebookTimeline(assembled.payloads[0], "target").recognized, false);
  }
});

test("Facebook GraphQL errors are scoped to feed fields, not unrelated nested components", () => {
  const data = { node: { id: "target", timeline_list_feed_units: { edges: [], page_info: { has_next_page: false } },
    badges: { errors: [{ message: "badge not supported" }] } } };
  assert.equal(extractFacebookTimeline({ data, errors: [{ path: ["node", "profile_header_renderer"], message: "optional component" }] }, "target").hasErrors, false);
  assert.equal(extractFacebookTimeline({ data, errors: [{ path: ["node", "timeline_list_feed_units", "page_info"], message: "paging unavailable" }] }, "target").hasErrors, true);
  assert.equal(extractFacebookTimeline({ data, errors: [{ message: "unscoped failure" }] }, "target").hasErrors, true);
  assert.equal(extractFacebookTimeline({ data, errors: [{ path: [], message: "root failure" }] }, "target").hasErrors, true);
  assert.equal(extractFacebookTimeline({ data, errors: [{ path: ["node", "timeline_list_feed_units", "edges", 0, "node", "feedback", "comments"], message: "optional comments" }] }, "target").hasErrors, false);
  data.node.timeline_list_feed_units.errors = [{ message: "feed incomplete" }];
  assert.equal(extractFacebookTimeline({ data }, "target").hasErrors, true);
});

test("Facebook streamed GraphQL lines are parsed independently", () => {
  const payloads = parseFacebookResponseText('{"data":{"a":1}}\n{"data":{"b":2}}\n');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].data.b, 2);
});

test("Facebook timeline parser selects large photos and HD progressive video", () => {
  const photo = {
    __typename: "Photo",
    id: "photo-1",
    image: { uri: "https://scontent.xx.fbcdn.net/small.jpg", width: 500, height: 400 },
    viewer_image: { uri: "https://scontent.xx.fbcdn.net/large.jpg", width: 2000, height: 1600 },
  };
  const video = {
    __typename: "Video",
    id: "video-1",
    original_width: 1080,
    original_height: 1920,
    videoDeliveryResponseFragment: { videoDeliveryResponseResult: { progressive_urls: [
      { progressive_url: "https://video.xx.fbcdn.net/sd.mp4", metadata: { quality: "SD" } },
      { progressive_url: "https://video.xx.fbcdn.net/hd.mp4", metadata: { quality: "HD" } },
    ] } },
  };
  const payload = { data: { node: {
    __typename: "User",
    id: "target-1",
    timeline_list_feed_units: { edges: [{ node: {
      __typename: "Story",
      id: "story-1",
      post_id: "post-1",
      creation_time: 1_788_000_000,
      permalink_url: "https://www.facebook.com/permalink.php?story_fbid=post-1",
      actors: [{ id: "target-1" }],
      attachments: [{ styles: { attachment: { media: [photo, video] } } }],
    } }] },
  } } };

  const parsed = extractFacebookTimeline(payload);
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.profileId, "target-1");
  assert.equal(parsed.posts.length, 1);
  assert.equal(parsed.refs.length, 2);
  const catalog = new Map(parsed.catalog.map((item) => [item.mediaId, item]));
  const media = parsed.refs.map((ref) => materializeFacebookMedia(ref, catalog.get(ref.mediaId)));
  assert.equal(media[0].sourceUrl, "https://scontent.xx.fbcdn.net/large.jpg");
  assert.equal(media[1].sourceUrl, "https://video.xx.fbcdn.net/hd.mp4");
  assert.deepEqual(media.map((item) => item.kind), ["image", "video"]);
});

