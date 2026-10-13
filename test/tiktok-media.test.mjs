import test from "node:test";
import assert from "node:assert/strict";
import { createTikTokMediaFetch, extractTikTokTimeline, resolveTikTokHandle } from "../lib/tiktok-media.mjs";

const videoPost = (overrides = {}) => ({
  id: "7567800123456789012", author: { uniqueId: "fixture_creator" }, createTime: 1_780_000_000,
  video: { width: 720, height: 1280, playAddr: "https://v.tiktokcdn.com/play.mp4?sig=1",
    cover: "https://p.tiktokcdn.com/cover.jpg", downloadAddr: "https://v.tiktokcdn.com/download.mp4" }, ...overrides,
});

test("TikTok profile handles resolve from profile URLs and account labels", () => {
  assert.equal(resolveTikTokHandle({ profileUrl: "https://www.tiktok.com/@fixture_creator?lang=en" }), "fixture_creator");
  assert.equal(resolveTikTokHandle({ label: "@creator.name" }), "creator.name");
  assert.equal(resolveTikTokHandle({ profileUrl: "https://www.tiktok.com.evil.test/@wrong" }), "");
});

test("TikTok profile response selects only target posts, excludes covers, and retains playable fallback renditions", () => {
  const item = videoPost();
  item.isPinnedItem = true;
  item.video.bitrateInfo = [
    { Bitrate: 9999, CodecType: "bytevc2", PlayAddr: { UrlList: ["https://v.tiktokcdn.com/unplayable.mp4"] } },
    { Bitrate: 6000, CodecType: "bytevc1", PlayAddr: { UrlList: ["https://v.tiktokcdn.com/media-video-hvc1/"] } },
    { Bitrate: 2000, CodecType: "h264", PlayAddr: { UrlList: ["https://v.tiktokcdn.com/720.mp4", "https://v2.tiktokcdn.com/720.mp4"] } },
    { Bitrate: 1000, CodecType: "h264", PlayAddr: { UrlList: ["https://v.tiktokcdn.com/480.mp4"] } },
  ];
  const result = extractTikTokTimeline({ itemList: [item, videoPost({ id: "7567800123456789013", author: { uniqueId: "other" } })], hasMore: true, cursor: "20" }, "FIXTURE_CREATOR");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].pinned, true);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].sourceUrl, "https://v.tiktokcdn.com/720.mp4");
  assert.deepEqual(result.media[0].variants.map((variant) => variant.bitrate), [2000, 2000, 1000, 0, 0]);
  assert.equal(result.media[0].logicalKey, "7567800123456789012:video:1");
  assert.equal(result.hasMore, true);
});

test("TikTok photo carousel preserves order and stable keys across signed URL refreshes", () => {
  const item = videoPost({ imagePost: { images: [
    { imageURL: { urlList: ["https://p.tiktokcdn.com/one.webp?signature=old"] } },
    { imageURL: { urlList: ["https://p.tiktokcdn.com/two.jpg", "https://p2.tiktokcdn.com/two.jpg"] } },
  ] } });
  const result = extractTikTokTimeline({ itemInfo: { itemStruct: item } }, "fixture_creator");
  assert.deepEqual(result.media.map((media) => media.kind), ["image", "image"]);
  assert.deepEqual(result.media.map((media) => media.mediaIndex), [1, 2]);
  assert.equal(result.media[0].extension, ".webp");
  assert.equal(result.media[1].variants.length, 2);
  item.imagePost.images[0].imageURL.urlList[0] = "https://p.tiktokcdn.com/one.webp?signature=new";
  const refreshed = extractTikTokTimeline({ __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } } }, "fixture_creator");
  assert.deepEqual(refreshed.media.map((media) => media.logicalKey), result.media.map((media) => media.logicalKey));
  assert.match(result.media[0].postUrl, /\/photo\//);
});

test("TikTok SIGI state and empty terminal pages are recognized without treating avatar or music as media", () => {
  const result = extractTikTokTimeline({ ItemModule: { one: videoPost({ author: "fixture_creator" }) }, UserModule: { avatar: "https://p.tiktokcdn.com/avatar.jpg" } }, "fixture_creator");
  assert.equal(result.posts.length, 1);
  assert.equal(result.media.length, 1);
  assert.equal(result.hasMore, null);
  const empty = extractTikTokTimeline({ statusCode: 0, itemList: [], hasMore: false }, "fixture_creator");
  assert.equal(empty.recognized, true);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.media.length, 0);
});

test("TikTok entries with absent media URLs remain unresolved instead of silently completing", () => {
  const result = extractTikTokTimeline({ itemList: [videoPost({ video: { cover: "https://p.tiktokcdn.com/cover.jpg" } })], hasMore: false }, "fixture_creator");
  assert.equal(result.posts.length, 1);
  assert.equal(result.media.length, 0);
  assert.equal(result.unresolvedPosts.length, 1);
});

test("TikTok target posts without media structure and unrecognized list entries are not silently covered", () => {
  const noStructure = videoPost({ id: "7567800123456789013", video: undefined });
  const result = extractTikTokTimeline({ itemList: [videoPost(), noStructure, { id: "7567800123456789014" }], hasMore: false }, "fixture_creator");
  assert.equal(result.posts.length, 3);
  assert.equal(result.media.length, 1);
  assert.equal(result.unresolvedPosts.length, 2);
  assert.equal(result.posts.find((post) => post.postId === noStructure.id).mediaComplete, false);
  assert.equal(result.unparsedItems, 1);
});

test("TikTok album coverage preserves advertised slots and cannot shrink after a partial detail payload", () => {
  const first = videoPost({ imagePost: { imageCount: 3, images: [
    { imageURL: "https://p.tiktokcdn.com/one.jpg" }, {},
  ] } });
  const partial = videoPost({ imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }] } });
  const result = extractTikTokTimeline({ itemList: [first, partial], hasMore: false }, "fixture_creator");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.deepEqual(result.postCoverage[0].expectedMediaKeys, [
    `${first.id}:image:1`, `${first.id}:image:2`, `${first.id}:image:3`,
  ]);
  assert.equal(result.unresolvedPosts.length, 1);
});

test("TikTok media transport keeps authentication scoped to cookie domain and path across redirects", async () => {
  const calls = [];
  const fetchMedia = createTikTokMediaFetch({ userAgent: "current-browser", mediaUrls: ["https://www.tiktok.com/media/file"], cookies: [
    { name: "session", value: "secret", domain: ".tiktok.com", path: "/", expires: -1, secure: true },
    { name: "notForMedia", value: "hidden", domain: ".tiktok.com", path: "/account", expires: -1 },
    { name: "expired", value: "old", domain: ".tiktok.com", path: "/", expires: 1 },
    { name: "cdn", value: "cdn-cookie", domain: ".tiktokcdn.com", path: "/media", expires: -1 },
  ], fetchImpl: async (url, options) => {
    calls.push({ url, headers: options.headers });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://v.tiktokcdn.com/media/file.mp4" } }) : new Response("bytes");
  } });
  const response = await fetchMedia("https://www.tiktok.com/media/file", { headers: { Range: "bytes=50-", Cookie: "unexpected=bad" } });
  assert.equal(await response.text(), "bytes");
  assert.equal(calls[0].headers.get("cookie"), "session=secret");
  assert.equal(calls[1].headers.get("cookie"), "cdn=cdn-cookie");
  assert.equal(calls[1].headers.get("range"), "bytes=50-");
  assert.equal(calls[1].headers.get("user-agent"), "current-browser");
});

test("TikTok media transport rejects redirects outside the observed media or platform domains", async () => {
  let calls = 0;
  const fetchMedia = createTikTokMediaFetch({ mediaUrls: ["https://v.tiktokcdn.com/video.mp4"], fetchImpl: async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://tiktokcdn.com.evil.test/steal" } });
  } });
  await assert.rejects(fetchMedia("https://v.tiktokcdn.com/video.mp4"), /不支持的地址/);
  assert.equal(calls, 1);
});
