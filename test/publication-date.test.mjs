import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublicationDateCollector, normalizePublicationDate, parseDisplayedPublicationDate,
  validDisplayTimeZone, validPublicationDate } from "../lib/publication-date.mjs";
import { discoverCustomMedia } from "../lib/custom-sync.mjs";
import { extractXTimeline } from "../lib/x-media.mjs";
import { extractInstagramTimeline } from "../lib/instagram-media.mjs";
import { extractFacebookTimeline, materializeFacebookMedia } from "../lib/facebook-media.mjs";
import { extractTikTokTimeline } from "../lib/tiktok-media.mjs";

test("Publication dates require a real full calendar date, including leap years", () => {
  assert.equal(validPublicationDate("20260101"), "20260101");
  assert.equal(validPublicationDate("2026-1-1"), "20260101");
  assert.equal(validPublicationDate("2024年2月29日"), "20240229");
  for (const value of ["2026-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026111", "00000101", "01/02/2026", "yesterday", null]) assert.equal(validPublicationDate(value), null);
});

test("Displayed dates accept unambiguous year-bearing platform labels only", () => {
  assert.equal(parseDisplayedPublicationDate("12:18 PM · Sep 28, 2026 · 32 Views"), "20260928");
  assert.equal(parseDisplayedPublicationDate("28 September 2026 at 12:18"), "20260928");
  assert.equal(parseDisplayedPublicationDate("2026年1月1日 上午8:30"), "20260101");
  assert.equal(parseDisplayedPublicationDate("2026-1-1"), "20260101");
  for (const value of ["Jan 1", "2 days ago", "01/02/2026", "2026-02-29", "2026-01-011"]) assert.equal(parseDisplayedPublicationDate(value), null);
});

test("Filename dates always use Beijing publication day regardless of viewer or machine timezone", () => {
  const instant = "2026-01-01T00:30:00.000Z";
  const unknown = { publicationDate: null, dateBasis: "unknown", displayTimeZone: null };
  const expected = { publicationDate: "20260101", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai" };
  assert.deepEqual(normalizePublicationDate({ createdAt: instant }), expected);
  assert.deepEqual(normalizePublicationDate({ createdAt: instant, displayTimeZone: "Asia/Shanghai" }), expected);
  assert.deepEqual(normalizePublicationDate({ publicationDate: "20260101" }), unknown);
  assert.deepEqual(normalizePublicationDate({ createdAt: "2026-01-01T00:30:00", dateBasis: "session-timezone", displayTimeZone: "Asia/Shanghai" }), unknown);
  assert.deepEqual(normalizePublicationDate({ createdAt: instant, dateBasis: "session-timezone", displayTimeZone: "America/New_York" }), expected);
  assert.equal(normalizePublicationDate({ createdAt: instant, dateBasis: "session-timezone", displayTimeZone: "Asia/Tokyo" }).publicationDate, "20260101");
  assert.deepEqual(normalizePublicationDate({ publicationDate: "20251231", dateBasis: "session-timezone", displayTimeZone: "America/New_York", createdAt: instant }), expected);
  assert.equal(normalizePublicationDate({ createdAt: "2026-01-01T00:30:00+09:00" }).publicationDate, "20251231");
  assert.equal(normalizePublicationDate({ createdAt: "2025-12-31T23:30:00-08:00" }).publicationDate, "20260101");
  assert.equal(normalizePublicationDate({ createdAt: "2026-01-01T15:59:59Z" }).publicationDate, "20260101");
  assert.equal(normalizePublicationDate({ createdAt: "2026-01-01T16:00:00Z" }).publicationDate, "20260102");
  assert.equal(normalizePublicationDate({ createdAt: "2026-01-02T00:30:00+08:00" }).publicationDate, "20260102");
});

test("Publication timestamps override old platform-display metadata and calendar-only values remain supported", () => {
  assert.deepEqual(normalizePublicationDate({ createdAt: "2026-01-01T00:30:00.000Z", publicationDate: "20251231", dateBasis: "platform", displayTimeZone: "America/New_York" }),
    { publicationDate: "20260101", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai" });
  assert.deepEqual(normalizePublicationDate({ publicationDate: "20251231", dateBasis: "platform", firstSeenAt: "2026-01-02T00:30:00Z" }),
    { publicationDate: "20251231", dateBasis: "platform", displayTimeZone: null });
  assert.equal(validDisplayTimeZone("Etc/GMT+8"), "Etc/GMT+8");
  assert.equal(validDisplayTimeZone("not/a/timezone"), null);
  assert.equal(validDisplayTimeZone("+08:00"), null);
});

test("Old displayed-date evidence cannot change Beijing dates of valid publication timestamps", () => {
  const collector = createPublicationDateCollector("x");
  collector.observe({ timeZone: "America/New_York", records: [{ createdAt: "2026-01-01T00:30:00.000Z", text: "7:30 PM · Dec 31, 2025", postUrl: "https://x.com/a/status/1" }] });
  const [explicit, inferred] = collector.apply([
    { createdAt: "2026-01-01T00:30:00.000Z", postUrl: "https://x.com/a/status/1", mediaIndex: 2 },
    { createdAt: "2026-01-02T01:00:00.000Z", postUrl: "https://x.com/a/status/2" },
  ]);
  assert.equal(explicit.publicationDate, "20260101");
  assert.equal(explicit.dateBasis, "created-at-beijing");
  assert.equal(explicit.mediaIndex, 2);
  assert.equal(inferred.publicationDate, "20260102");
  assert.equal(inferred.dateBasis, "created-at-beijing");
  assert.equal(inferred.displayTimeZone, "Asia/Shanghai");
});

test("Publication timestamps do not require date evidence in a platform profile grid", () => {
  const collector = createPublicationDateCollector("instagram");
  collector.observe({ timeZone: "Asia/Shanghai", records: [{ createdAt: "2026-01-01T00:30:00.000Z", text: "January 1, 2026" }] });
  const [known, unknown] = collector.apply([{ createdAt: "2026-01-01T00:30:00.000Z" }, { createdAt: "2026-01-02T00:30:00.000Z" }]);
  assert.equal(known.publicationDate, "20260101");
  assert.equal(known.displayTimeZone, "Asia/Shanghai");
  assert.equal(unknown.publicationDate, "20260102");
});

test("Conflicting browser clock evidence never suppresses publication timestamp dates", () => {
  const collector = createPublicationDateCollector("facebook");
  collector.observe({ timeZone: "Asia/Tokyo", records: [
    { createdAt: "2026-01-01T00:00:00.000Z", text: "2026-01-01 09:00" },
    { createdAt: "2026-01-02T00:00:00.000Z", text: "2026-01-02 00:00" },
  ] });
  const [known, unknown] = collector.apply([{ createdAt: "2026-01-01T00:00:00.000Z" }, { createdAt: "2026-01-03T00:00:00.000Z" }]);
  assert.equal(known.publicationDate, "20260101");
  assert.equal(known.displayTimeZone, "Asia/Shanghai");
  assert.equal(unknown.publicationDate, "20260103");
});

test("A comment's timestamp cannot overwrite its parent post's date", () => {
  const collector = createPublicationDateCollector("instagram");
  collector.observe({ records: [{ createdAt: "2026-02-01T00:30:00.000Z", text: "February 1, 2026", postUrl: "https://www.instagram.com/p/original/" }] });
  const [item] = collector.apply([{ createdAt: "2026-01-01T00:30:00.000Z", postUrl: "https://www.instagram.com/p/original/" }]);
  assert.equal(item.publicationDate, "20260101");
});

test("Browser evidence is captured from an existing page without another network request or tab", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  const requests = [];
  await context.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: "text/html", body: '<a href="/fixture/status/1" title="2026年1月1日 09:30"><time datetime="2026-01-01T00:30:00.000Z">Jan 1</time></a>' });
  });
  const page = await context.newPage();
  await page.goto("https://x.com/fixture");
  const collector = createPublicationDateCollector("x");
  await collector.capture(page);
  const [item] = collector.apply([{ postUrl: "https://x.com/fixture/status/2", createdAt: "2026-01-02T20:30:00.000Z" }]);
  assert.deepEqual(requests, ["https://x.com/fixture"]);
  assert.equal(context.pages().length, 1);
  assert.equal(item.publicationDate, "20260103");
  assert.equal(item.displayTimeZone, "Asia/Shanghai");
});

test("Custom worker dates preserve explicit platform dates and do not turn a calendar-only date into midnight", async () => {
  const platform = { id: "custom-dates", custom: true, engine: "auto", homepageUrl: "https://fixture.example/" };
  const rows = [
    { key: "a", postId: "1", createdAt: "2026-01-01" },
    { key: "b", postId: "2", createdAt: "2026-01-01T00:30:00Z" },
    { key: "c", postId: "3", createdAt: "2026-01-01T00:30:00Z", publicationDate: "20251231", dateBasis: "platform" },
  ];
  const result = await discoverCustomMedia({ platform, account: { profileUrl: "https://fixture.example/creator" },
    sessionExporter: async () => ({ cookies: [], cookieFile: null, dispose: async () => {} }),
    runWorker: async () => ({ records: rows.map((row) => ({ ...row, kind: "image", extension: ".jpg", url: `https://cdn.fixture.example/${row.key}.jpg` })), result: { engine: "yt-dlp", scope: "account", complete: true } }),
    fetchFactory: () => () => assert.fail("Date normalization must not download media") });
  assert.equal(result.media[0].publicationDate, "20260101");
  assert.equal(result.media[0].dateBasis, "platform");
  assert.equal(result.media[0].createdAt, null);
  assert.equal(result.media[1].publicationDate, "20260101");
  assert.equal(result.media[1].dateBasis, "created-at-beijing");
  assert.equal(result.media[1].createdAt, "2026-01-01T00:30:00Z");
  assert.equal(result.media[2].publicationDate, "20260101");
  assert.equal(result.media[2].dateBasis, "created-at-beijing");
});

test("Missing publication dates use only a persisted first-collected Beijing day, never the current clock", (t) => {
  const stable = { publicationDate: "20261001", dateBasis: "first-collected-beijing", displayTimeZone: "Asia/Shanghai" };
  const source = { createdAt: null, firstSeenAt: "2026-10-01T01:30:00+09:00" };
  assert.deepEqual(normalizePublicationDate(source), stable);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-03-01T00:00:00Z") });
  assert.deepEqual(normalizePublicationDate(source), stable);
  assert.deepEqual(normalizePublicationDate({ createdAt: "invalid", firstSeenAt: "invalid" }),
    { publicationDate: null, dateBasis: "unknown", displayTimeZone: null });
  assert.deepEqual(normalizePublicationDate({ createdAt: "2026-01-01T03:00:00Z", firstSeenAt: "2026-10-01T01:30:00+09:00" }),
    { publicationDate: "20260101", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai" });
});

test("Adapters leave absent dates unset until the index assigns firstSeenAt", () => {
  const collector = createPublicationDateCollector("instagram");
  const [item] = collector.apply([{ postUrl: "https://www.instagram.com/p/unknown/", createdAt: null }]);
  assert.equal(item.publicationDate, null);
  assert.equal(Object.hasOwn(item, "firstSeenAt"), false);
});

test("Every native platform adapter applies fixed Beijing filename day to its existing timestamps", () => {
  const instant = "2026-09-28T23:30:00.000Z", seconds = Date.parse(instant) / 1000;
  const x = extractXTimeline({ __typename: "Tweet", rest_id: "123",
    core: { user_results: { result: { core: { screen_name: "creator" } } } },
    legacy: { created_at: "Mon Sep 28 23:30:00 +0000 2026", extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/test.jpg" }] } } }, "creator");
  const instagram = extractInstagramTimeline({ code: "POST1", pk: "123", taken_at: seconds, user: { username: "creator" },
    image_versions2: { candidates: [{ url: "https://cdn.example/test.jpg", width: 100, height: 100 }] } }, "creator");
  const facebook = extractFacebookTimeline({ __typename: "Story", post_id: "123", creation_time: seconds,
    permalink_url: "https://www.facebook.com/creator/posts/123", actors: [{ id: "creator" }],
    attachments: [{ media: { __typename: "Photo", id: "photo123", image: { uri: "https://scontent.xx.fbcdn.net/test.jpg", width: 100, height: 100 } } }] }, "creator");
  const facebookMedia = facebook.refs.map((ref) => materializeFacebookMedia(ref, facebook.catalog.find((entry) => entry.mediaId === ref.mediaId)));
  const tiktok = extractTikTokTimeline({ itemList: [{ id: "123456789", createTime: seconds, author: { uniqueId: "creator" },
    video: { playAddr: "https://v.tiktokcdn.com/test.mp4" } }], statusCode: 0, hasMore: false }, "creator");
  const items = [{ platform: "x", batch: x.media }, { platform: "instagram", batch: instagram.media },
    { platform: "facebook", batch: facebookMedia }, { platform: "tiktok", batch: tiktok.media }];
  // These adapters all retain their parser's original createdAt in ISO form;
  // the collector must require neither visible grid dates nor login changes.
  for (const { platform, batch } of items) {
    assert.equal(batch.length, 1, `${platform} fixture must produce real parsed media`);
    const [normalized] = createPublicationDateCollector(platform).apply(batch);
    assert.equal(normalized.publicationDate, "20260929");
    assert.equal(normalized.dateBasis, "created-at-beijing");
    assert.equal(normalized.displayTimeZone, "Asia/Shanghai");
    assert.equal(normalized.createdAt, instant);
  }
});

test("Legacy UTC basis is normalized from its instant and collection fallback never masquerades as a publication date", () => {
  assert.deepEqual(normalizePublicationDate({ createdAt: "2026-01-01T23:30:00Z", publicationDate: "20260101", dateBasis: "created-at-utc", displayTimeZone: "UTC" }),
    { publicationDate: "20260102", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai" });
  assert.deepEqual(normalizePublicationDate({ createdAt: null, firstSeenAt: "2026-01-01T23:30:00Z", publicationDate: "20260101", dateBasis: "first-collected-utc", displayTimeZone: "UTC" }),
    { publicationDate: "20260102", dateBasis: "first-collected-beijing", displayTimeZone: "Asia/Shanghai" });
  assert.deepEqual(normalizePublicationDate({ createdAt: null, firstSeenAt: "2026-01-01T23:30:00Z", publicationDate: "20251231", dateBasis: "platform", displayTimeZone: null }),
    { publicationDate: "20251231", dateBasis: "platform", displayTimeZone: null });
});
