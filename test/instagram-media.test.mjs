import test from "node:test";
import assert from "node:assert/strict";
import { extractInstagramTimeline, instagramGraphQLIssues, parseInstagramHtml, resolveInstagramHandle } from "../lib/instagram-media.mjs";

test("Instagram handle is resolved from its profile URL", () => {
  assert.equal(resolveInstagramHandle({ profileUrl: "https://www.instagram.com/Creator.Name/", label: "显示名" }), "Creator.Name");
  assert.equal(resolveInstagramHandle({ label: "@fallback_name" }), "fallback_name");
});

test("Instagram timeline parser expands carousel items and chooses largest variants", () => {
  const payload = {
    data: {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
        edges: [{ node: {
          __typename: "XDTMediaDict",
          code: "POST123",
          pk: "100",
          id: "100_9",
          taken_at: 1_788_000_000,
          user: { username: "creator.name" },
          carousel_media: [
            { id: "101", pk: "101", image_versions2: { candidates: [
              { url: "https://cdn.example/small.jpg", width: 320, height: 320 },
              { url: "https://cdn.example/large.jpg", width: 1600, height: 1200 },
            ] } },
            { id: "102", pk: "102", video_versions: [
              { url: "https://cdn.example/low.mp4", width: 480, height: 854 },
              { url: "https://cdn.example/high.mp4", width: 1080, height: 1920 },
            ] },
          ],
        } }],
      },
    },
  };
  const result = extractInstagramTimeline(payload, "Creator.Name");
  assert.equal(result.recognized, true);
  assert.deepEqual(result.posts.map((post) => post.postKey), ["POST123"]);
  assert.deepEqual(result.media.map((item) => item.kind), ["image", "video"]);
  assert.equal(result.media[0].sourceUrl, "https://cdn.example/large.jpg");
  assert.equal(result.media[1].sourceUrl, "https://cdn.example/high.mp4");
  assert.deepEqual(result.media.map((item) => item.logicalKey), ["POST123:101", "POST123:102"]);
});

test("Instagram timeline recognition excludes unrelated profiles and requires scope for an empty feed", () => {
  const connection = (edges) => ({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges, page_info: { has_next_page: false } } } });
  const unrelated = connection([{ node: { code: "OTHER", pk: "1", user: { username: "someone.else" }, image_versions2: { candidates: [{ url: "https://cdn.example/other.jpg" }] } } }]);
  assert.equal(extractInstagramTimeline(unrelated, "creator").recognized, false);
  assert.equal(extractInstagramTimeline(unrelated, "creator", { requestedHandle: "creator" }).recognized, false);
  assert.equal(extractInstagramTimeline(connection([]), "creator").recognized, false);
  const empty = extractInstagramTimeline(connection([]), "creator", { requestedHandle: "creator" });
  assert.equal(empty.recognized, true);
  assert.equal(empty.hasNextPage, false);
  assert.deepEqual(empty.posts, []);
  const denied = { ...connection([]), errors: [{ message: "Fixture denial" }] };
  assert.equal(extractInstagramTimeline(denied, "creator", { requestedHandle: "creator" }).recognized, false);
});

test("Instagram parser preserves target identity, pagination, and stable keys without rejecting bad timestamps", () => {
  const payload = { data: { user: { username: "creator", pk: "42" }, xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [{ node: { code: "POST", pk: "1", taken_at: "invalid", user: { username: "creator", pk: "42" }, image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg" }] } } }],
    page_info: { has_next_page: true },
  } } };
  const result = extractInstagramTimeline(payload, "creator");
  assert.equal(result.recognized, true);
  assert.equal(result.hasNextPage, true);
  assert.deepEqual(result.targetUserIds, ["42"]);
  assert.equal(result.posts[0].createdAt, null);
  assert.equal(result.media[0].createdAt, null);
  assert.equal(result.media[0].logicalKey, "POST:1");
});

test("Instagram missing feed edges, unparsed nodes, and multiple cursor states are not terminal evidence", () => {
  const scoped = { requestedHandle: "creator" };
  const absentEdges = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    page_info: { has_next_page: false },
  } } }, "creator", scoped);
  assert.equal(absentEdges.recognized, false);
  assert.equal(absentEdges.hasNextPage, null);
  assert.equal(absentEdges.parseIssues[0].reason, "timeline-edges-invalid");
  const malformed = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [{ node: null }], page_info: { has_next_page: false },
  } } }, "creator", scoped);
  assert.equal(malformed.timelineBatches[0].reliable, false);
  assert.equal(malformed.parseIssues[0].reason, "timeline-post-invalid");
  const connection = (next) => ({ xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [], ...(next === undefined ? {} : { page_info: { has_next_page: next } }),
  } });
  assert.equal(extractInstagramTimeline({ data: [connection(false), connection(true)] }, "creator", scoped).hasNextPage, true);
  assert.equal(extractInstagramTimeline({ data: [connection(false), connection(undefined)] }, "creator", scoped).hasNextPage, null);
});

test("Instagram legacy feeds retain explicit target identity, video media, and actual pagination", () => {
  const media = { shortcode: "OLD", id: "123", owner: { username: "creator" }, taken_at_timestamp: 1_700_000_000,
    is_video: true, video_url: "https://cdn.example/old.mp4", display_url: "https://cdn.example/poster.jpg" };
  const oldProfile = { data: { user: { username: "creator", id: "42", edge_owner_to_timeline_media: {
    edges: [{ node: media }], page_info: { has_next_page: false },
  } } } };
  const result = extractInstagramTimeline(oldProfile, "creator");
  assert.equal(result.recognized, true);
  assert.equal(result.hasNextPage, false);
  assert.equal(result.posts[0].mediaComplete, true);
  assert.equal(result.media[0].kind, "video");
  assert.equal(result.media[0].sourceUrl, media.video_url);
  const apiFeed = { items: [{ ...media, code: media.shortcode, pk: media.id }], more_available: true, next_max_id: "456" };
  assert.equal(extractInstagramTimeline(apiFeed, "creator").recognized, false);
  const scopedFeed = extractInstagramTimeline(apiFeed, "creator", { requestedHandle: "creator" });
  assert.equal(scopedFeed.recognized, true);
  assert.equal(scopedFeed.hasNextPage, true);
  assert.equal(scopedFeed.timelineBatches[0].endCursor, "456");
});

test("Instagram a missing carousel or video URL does not turn a cover image into completed media", () => {
  const values = [
    { code: "CAROUSEL", pk: "1", media_type: 8, carousel_media_count: 2 },
    { code: "CLIP", pk: "2", media_type: 2, image_versions2: { candidates: [{ url: "https://cdn.example/cover.jpg" }] } },
    { code: "INVALIDURL", pk: "3", image_versions2: { candidates: [{ url: "data:image/png;base64,secret" }] } },
  ].map((value) => ({ ...value, user: { username: "creator" } }));
  const result = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: values.map((node) => ({ node })), page_info: { has_next_page: false },
  } } }, "creator");
  assert.equal(result.posts.every((post) => post.mediaComplete === false), true);
  assert.equal(result.timelineBatches[0].reliable, false);
  assert.equal(result.unresolvedMedia.length, 4);
  assert.deepEqual(result.media, []);
});

test("Instagram representations within one payload retain the album's maximum count and missing stable IDs", () => {
  const item = (id, hasUrl = true) => ({ pk: id, image_versions2: { candidates: hasUrl ? [{ url: `https://cdn.example/${id}.jpg` }] : [] } });
  const album = (children) => ({ code: "ALBUM", pk: "100", user: { username: "creator" }, media_type: 8,
    carousel_media_count: children.length, carousel_media: children });
  const first = album([item("A"), item("B"), item("C", false)]);
  for (const repaired of [false, true]) {
    const latest = album(repaired ? [item("A"), item("B"), item("C")] : [item("A"), item("B")]);
    const result = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: [{ node: first }], page_info: { has_next_page: false },
    }, detail: latest } }, "creator");
    assert.equal(result.posts[0].mediaExpectedCount, 3);
    assert.equal(result.posts[0].mediaComplete, repaired);
    assert.equal(result.timelineBatches[0].reliable, repaired);
    assert.equal(result.posts[0].mediaExpectedKeys.includes("ALBUM:C"), true);
    assert.equal(result.unresolvedMedia.some((entry) => entry.logicalKey === "ALBUM:C"), !repaired);
  }
});

test("Instagram accepted collaborative posts retain the requested source account and media identity", () => {
  const collaboration = (code, children) => ({ code, pk: `${code}ID`, media_type: 8, carousel_media_count: children.length,
    user: { username: "a.se.ase", pk: "OWNER" }, coauthor_producers: [{ username: "asease.se", pk: "TARGET" }],
    carousel_media: children.map((id) => ({ pk: id, image_versions2: { candidates: [{ url: `https://cdn.example/${id}.jpg` }] } })) });
  const payload = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [collaboration("DZ1ZiT_Ey-O", ["IMAGE1", "IMAGE2"]), collaboration("DZUFx3jE3Ep", ["IMAGE3"])].map((node) => ({ node })),
    page_info: { has_next_page: false },
  } } };
  const result = extractInstagramTimeline(payload, "asease.se", { requestedHandle: "asease.se" });
  assert.equal(result.recognized, true);
  assert.equal(result.timelineBatches[0].reliable, true);
  assert.equal(result.hasNextPage, false);
  assert.deepEqual(result.parseIssues, []);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.deepEqual(result.media.map((item) => item.handle), ["asease.se", "asease.se", "asease.se"]);
  assert.deepEqual(result.media.map((item) => item.logicalKey), ["DZ1ZiT_Ey-O:IMAGE1", "DZ1ZiT_Ey-O:IMAGE2", "DZUFx3jE3Ep:IMAGE3"]);
  assert.deepEqual(result.targetUserIds, ["TARGET"]);
  const primary = extractInstagramTimeline(payload, "a.se.ase", { requestedHandle: "a.se.ase" });
  assert.deepEqual(primary.media.map((item) => item.logicalKey), result.media.map((item) => item.logicalKey));
  assert.deepEqual(primary.media.map((item) => item.sourceUrl), result.media.map((item) => item.sourceUrl));
});

test("Instagram invitations and unrelated collaborator recommendations do not establish target ownership", () => {
  const foreign = { code: "FOREIGN", pk: "1", user: { username: "other" },
    invited_coauthor_producers: [{ username: "creator" }], coauthor_producers: [{ username: "another" }],
    image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg" }] } };
  const result = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [{ node: foreign }], page_info: { has_next_page: false },
  } } }, "creator", { requestedHandle: "creator" });
  assert.equal(result.recognized, false);
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.media, []);
  const malformed = extractInstagramTimeline({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [{ node: { ...foreign, coauthor_producers: [{ username: "creator" }], pk: null } }], page_info: { has_next_page: false },
  } } }, "creator", { requestedHandle: "creator" });
  assert.equal(malformed.timelineBatches[0].reliable, false);
  assert.ok(malformed.parseIssues.some((entry) => entry.reason === "timeline-post-invalid"));
});

test("Instagram decorative location-avatar GraphQL errors do not invalidate parsed target media", () => {
  const node = { code: "TARGET", pk: "1", user: { username: "creator" },
    image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg" }] } };
  const payload = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: [{ node }], page_info: { has_next_page: false },
  } }, errors: [{ message: "SECRET_DEBUG_DETAIL", severity: "ERROR", path: [
    "xdt_api__v1__feed__user_timeline_graphql_connection", "edges", 0, "node", "location", "profile_pic_url",
  ] }] };
  const parsed = extractInstagramTimeline(payload, "creator", { requestedHandle: "creator" });
  assert.deepEqual(instagramGraphQLIssues(payload, parsed), []);
  const critical = ["user", "username"];
  for (const path of [critical, ["image_versions2", "candidates"], ["carousel_media"], ["video_versions"], ["unknown_field"]]) {
    const broken = { ...payload, errors: [{ message: "SECRET_DEBUG_DETAIL", code: "ACCESS_DENIED",
      path: [...payload.errors[0].path.slice(0, 4), ...path] }] };
    const issues = instagramGraphQLIssues(broken, parsed, { operation: "PolarisProfilePostsQuery", scope: "timeline" });
    assert.equal(issues[0].reason, "timeline-graphql-error");
    assert.equal(issues[0].graphqlCode, "ACCESS_DENIED");
    assert.equal(issues[0].operation, "PolarisProfilePostsQuery");
    assert.deepEqual(issues[0].fieldPath, broken.errors[0].path);
    assert.equal(JSON.stringify(issues).includes("SECRET_DEBUG_DETAIL"), false);
  }
  assert.equal(instagramGraphQLIssues({ ...payload, errors: [{ path: payload.errors[0].path.map(p => p === 0 ? 99 : p) }] }, parsed).length, 1);
  assert.equal(instagramGraphQLIssues({ ...payload, errors: [{}] }, parsed).length, 1);
});

test("Instagram SSR data parses only JSON data scripts and Relay cache strings, never executable captions", () => {
  const node = { code: "SSR", pk: "1", user: { username: "creator" },
    image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg" }] } };
  const html = `<script>globalThis.__instagramUnsafeExecuted = true;</script>
    <script type="application/json">${JSON.stringify({ caption: JSON.stringify(node) })}</script>
    <script type="application/json" data-sjs>${JSON.stringify({ require: [["RelayPrefetchedStreamCache", "add", null,
      ["cache", JSON.stringify({ data: { media: node } })]]] })}</script>`;
  const parsed = extractInstagramTimeline(parseInstagramHtml(html), "creator");
  assert.deepEqual(parsed.posts.map(p => p.postKey), ["SSR"]);
  assert.equal(globalThis.__instagramUnsafeExecuted, undefined);
  assert.deepEqual(extractInstagramTimeline(parseInstagramHtml(`<script type="application/json">${JSON.stringify({ caption: JSON.stringify(node) })}</script>`), "creator").posts, []);
  assert.throws(() => parseInstagramHtml('<script type="application/json">invalid</script>'), SyntaxError);
});

