import test from "node:test";
import assert from "node:assert/strict";
import { discoverInstagramMedia } from "../lib/instagram-sync.mjs";
import { blockingDiscoveryFailure } from "../lib/sync-verification.mjs";

const post = (code, changes = {}) => ({ code, pk: `${code}ID`, taken_at: 1_700_000_000,
  user: { username: "creator", pk: "42" },
  image_versions2: { candidates: [{ url: `https://cdn.example/${code}.jpg` }] }, ...changes });
const feed = (items, next, changes = {}) => ({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
  edges: items.map((node) => ({ node })), ...(next === undefined ? {} : { page_info: { has_next_page: next } }), ...changes,
} } });
const api = (payload, changes = {}) => ({ payload, url: "https://www.instagram.com/graphql/query", scoped: true,
  operation: "PolarisProfilePostsQuery", status: 200, ...changes });
const image = (id, hasUrl = true) => ({ pk: id, image_versions2: { candidates: hasUrl ? [{ url: `https://cdn.example/${id}.jpg` }] : [] } });
const album = (items, count = items.length) => post("ALBUM", { media_type: 8, carousel_media_count: count, carousel_media: items });

// No Chromium, sockets, platform accounts, or filesystem fixtures: exercise
// the real discovery function using its existing browser DI. Only lifecycle
// tests use tiny local timers to model requests and response bodies in flight.
function fixture({ visits = [[]], scrolls = [], details = {}, detailHtml = {}, detailStatus = {}, failures = {} } = {}) {
  const listeners = new Map();
  const timers = new Set();
  const delayedUntilDetail = [];
  let currentUrl = "about:blank";
  let visitCount = 0;
  let scrollCount = 0;
  let contextClosed = false;
  let browserClosed = false;
  const request = (entry) => ({ url: () => entry.url,
    postData: () => new URLSearchParams({ ...(entry.operation ? { fb_api_req_friendly_name: entry.operation } : {}),
      ...(entry.variables || entry.scoped ? { variables: JSON.stringify(entry.variables || { username: "creator" }) } : {}) }).toString() });
  const delay = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
  };
  const emit = (entries = []) => {
    for (const entry of entries) {
      const currentRequest = request(entry);
      listeners.get("request")?.(currentRequest);
      const respond = () => {
        if (entry.failed) { listeners.get("requestfailed")?.(currentRequest); return; }
        if (entry.unfinished) return;
        listeners.get("response")?.({ url: () => entry.url, status: () => entry.status, request: () => currentRequest,
          json: async () => {
            try {
              if (entry.jsonHangs) await new Promise(() => {});
              if (entry.jsonDelayMs) await new Promise((resolve) => delay(resolve, entry.jsonDelayMs));
              if (entry.jsonError) throw new SyntaxError("Secret malformed payload");
              return entry.payload;
            } finally { listeners.get("requestfinished")?.(currentRequest); }
          } });
        // A rejected HTTP response need not have its body read by the adapter.
        if (entry.status >= 400) listeners.get("requestfinished")?.(currentRequest);
      };
      if (entry.respondOnDetail) delayedUntilDetail.push(respond);
      else if (entry.responseDelayMs) delay(respond, entry.responseDelayMs);
      else respond();
    }
  };
  const page = {
    on(name, handler) { listeners.set(name, handler); },
    off(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    url: () => currentUrl,
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    evaluate: async (_function, platform) => platform ? { timeZone: "UTC", records: [] } : {},
    async goto(url) {
      currentUrl = url;
      if (failures[url]) throw new Error("Fixture navigation denied");
      if (/\/creator\/$/.test(url)) { emit(visits[Math.min(visitCount, visits.length - 1)]); visitCount += 1; }
      else {
        for (const respond of delayedUntilDetail.splice(0)) respond();
        emit(details[url] || []);
      }
      return { status: () => detailStatus[url] || 200,
        ...(Object.hasOwn(detailHtml, url) ? { text: async () => detailHtml[url] } : {}) };
    },
    waitForTimeout: async () => {},
    mouse: { wheel: async () => { emit(scrolls[scrollCount] || []); scrollCount += 1; } },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {
    contextClosed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  } };
  const browserType = { launch: async () => ({ newContext: async () => context, close: async () => { browserClosed = true; } }) };
  return { browserType, get visitCount() { return visitCount; }, get scrollCount() { return scrollCount; },
    get closed() { return contextClosed && browserClosed; } };
}

async function discover(session, changes = {}) {
  try {
    return await discoverInstagramMedia({ handle: "creator", browserType: session.browserType,
      timelineWaitMs: 0, retryTimelineWaitMs: 0, scrollWaitMs: 0, maxScrolls: 8, ...changes });
  } finally { assert.equal(session.closed, true, "Only the exact fixture browser/context must close"); }
}

test("Instagram completion requires an explicit, successfully parsed target terminal page", async () => {
  const session = fixture({ visits: [[api(feed([post("FIRST")], true))]], scrolls: [[api(feed([post("LAST")], false))]] });
  const result = await discover(session);
  assert.equal(result.complete, true);
  assert.equal(result.completionReason, "terminal-page");
  assert.equal(result.incompleteReason, null);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.timelineResponses, 2);
  assert.equal(result.posts.every((item) => item.mediaComplete === true), true);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.headCaptured, true);
});

test("Instagram a recovered retry of the same requested page clears only its own transient failure", async (t) => {
  for (const [name, failure] of [
    ["HTTP", api(null, { status: 403 })], ["JSON", api(null, { jsonError: true })],
    ["GraphQL", api({ errors: [{ message: "PRIVATE_ERROR_DETAIL" }] })],
    ["API", api({ status: "fail", error_type: "PRIVATE_ERROR_DETAIL" })],
    ["empty structure", api({ data: {} })], ["network", api(null, { failed: true })],
    ["malformed node", api(feed([null], false))],
  ]) {
    await t.test(name, async () => {
      const variables = { username: "creator", after: "SAME_CURSOR" };
      const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], true))]],
        scrolls: [[{ ...failure, variables }, api(feed([post("LAST")], false), { variables })]] }));
      assert.equal(result.complete, true);
      assert.equal(result.rangeComplete, true);
      assert.deepEqual(result.parseIssues, []);
      assert.equal(JSON.stringify(result).includes("PRIVATE_ERROR_DETAIL"), false);
    });
  }
});

test("Instagram hydration retry recovers the same first-page failure without masking history gaps", async () => {
  const session = fixture({ visits: [[api(null, { status: 403 })], [api(feed([post("RETRIED")], false))]] });
  const result = await discover(session);
  assert.equal(session.visitCount, 2);
  assert.equal(result.complete, true);
  assert.equal(result.headCaptured, true);
  assert.deepEqual(result.parseIssues, []);
});

test("Instagram target IDs on component and recommendation operations never prove or invalidate a feed", async () => {
  const component = { operation: "PolarisProfilePageContentQuery", variables: { id: "42" } };
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(null, { ...component, status: 403 }), api({ errors: [{ message: "component denied" }] }, component),
    api({ data: {} }, component), api(feed([post("SHOULD_NOT_COLLECT")], true), component),
    api(null, { ...component, unfinished: true })]] }), { responseWaitMs: 20 });
  assert.equal(result.complete, true);
  assert.equal(result.timelineResponses, 1);
  assert.deepEqual(result.posts.map((item) => item.postKey), ["FIRST"]);
  assert.deepEqual(result.parseIssues, []);
  await assert.rejects(discover(fixture({ visits: [[api(feed([post("OTHER_COMPONENT")], false), component)]] })),
    { code: "timeline-unavailable" });
});

test("Instagram accepted collaborators from two actual posts operations preserve paging completion", async () => {
  const collab = (code, items) => post(code, { user: { username: "primary_owner", pk: "OTHER" },
    coauthor_producers: [{ username: "creator", pk: "42" }], carousel_media_count: items.length, carousel_media: items });
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST"), collab("DZ1ZiT_Ey-O", [image("A"), image("B")])], true))]],
    scrolls: [[api(feed([post("LAST"), collab("DZUFx3jE3Ep", [image("C")])], false), {
      operation: "PolarisProfilePostsTabContentQuery_connection", variables: { id: "42", after: "PAGE2" },
    })]] }));
  assert.equal(result.complete, true);
  assert.equal(result.timelineResponses, 2);
  assert.equal(result.posts.length, 4);
  assert.equal(result.media.length, 5);
  assert.equal(result.posts.every((item) => item.handle === "creator"), true);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.deepEqual(result.parseIssues, []);
});

test("Instagram first-page evidence is not inferred from arbitrary posts or a paginated terminal page", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("LAST")], false),
    { variables: { username: "creator", data: { after: "OLD_CURSOR" } } })]] }));
  assert.equal(result.complete, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.headCaptured, false);
  assert.equal(result.headTraversalCaptured, false);
  assert.equal(result.incompleteReason, "timeline-head-unconfirmed");
});

test("Instagram clean unnamed target feed structures prove traversal without trusting arbitrary component IDs", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false), { operation: "", scoped: false })]] }));
  assert.equal(result.complete, true);
  assert.equal(result.headTraversalCaptured, true);
  assert.equal(result.headCaptured, false, "The stricter baseline still requires explicit request target identity");
  const unrelated = fixture({ visits: [[api(feed([], false), { operation: "", scoped: false, variables: { id: "42" } })]] });
  await assert.rejects(discover(unrelated), { code: "timeline-unavailable" });
});

test("Instagram another profile's collaborative post cannot prove our target feed even with accepted coauthors", async () => {
  const collaborative = post("ON_OTHER_PROFILE", { user: { username: "other", pk: "OTHER" },
    coauthor_producers: [{ username: "creator", pk: "42" }] });
  await assert.rejects(discover(fixture({ visits: [[api(feed([collaborative], false),
    { variables: { username: "other" } })]] })), { code: "timeline-unavailable" });
  await assert.rejects(discover(fixture({ visits: [[api(feed([collaborative], false),
    { variables: { id: "OTHER" } })]] })), { code: "timeline-unavailable" });
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], true)),
    api(feed([collaborative], false), { variables: { id: "OTHER" } })]] }), { maxScrolls: 0 });
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.posts.map((item) => item.postKey), ["FIRST"]);
});

test("Instagram a clean numeric-ID first page may prove its target from actual owner records", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false), { variables: { id: "42" } })]] }));
  assert.equal(result.complete, true);
  assert.equal(result.headCaptured, true);
  assert.equal(result.headTraversalCaptured, true);
});

test("Instagram a continuing or unknown cursor never becomes complete through idle scrolls", async (t) => {
  for (const next of [true, undefined]) {
    await t.test(String(next), async () => {
      const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], next))]] }));
      assert.equal(result.complete, false);
      assert.equal(result.reachedEnd, false);
      assert.equal(result.completionReason, null);
      assert.equal(result.incompleteReason, next ? "pagination-stalled" : "pagination-unknown");
    });
  }
});

test("Instagram reaching the scroll budget is incomplete even with readable first-page media", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], true))]] }), { maxScrolls: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "scroll-limit");
  assert.equal(result.media.length, 1);
});

test("Instagram an unresolved failed page cannot be hidden by a different terminal request", async (t) => {
  for (const [name, failed] of [
    ["HTTP 403", api(null, { status: 403 })],
    ["invalid JSON", api(null, { jsonError: true })],
    ["GraphQL failure", api({ ...feed([], false), errors: [{ message: "SECRET_PLATFORM_ERROR" }] })],
    ["API error JSON", api({ ...feed([], false), status: "fail", error_type: "SECRET_PLATFORM_ERROR" })],
    ["empty response", api({ data: {} })],
    ["network failure", api(null, { failed: true })],
  ]) {
    await t.test(name, async () => {
      const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], true))]],
        scrolls: [[{ ...failed, variables: { username: "creator", after: "FAILED_PAGE" } },
          api(feed([], false), { variables: { username: "creator", after: "DIFFERENT_PAGE" } })]] }));
      assert.equal(result.complete, false);
      assert.equal(result.completionReason, null);
      assert.equal(result.incompleteReason, "timeline-unresolved");
      assert.ok(result.parseIssues.length > 0);
      assert.equal(JSON.stringify(result).includes("SECRET_PLATFORM_ERROR"), false);
      if (name === "GraphQL failure") assert.equal(blockingDiscoveryFailure(result), "timeline-graphql-error");
      if (name === "API error JSON") assert.equal(blockingDiscoveryFailure(result), "timeline-api-error");
    });
  }
});

test("Instagram unrelated component failures do not poison an identified target terminal feed", async () => {
  const result = await discover(fixture({ visits: [[api(null, { status: 403, scoped: false }),
    api({ errors: [{ message: "Unrelated denied component" }] }, { scoped: false }), api(feed([post("FIRST")], false))]] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.parseIssues, []);
});

test("Instagram missing attachments and video URLs remain explicit retry candidates", async () => {
  const carousel = post("CAROUSEL", { carousel_media_count: 3, carousel_media: [
    { pk: "A", image_versions2: { candidates: [{ url: "https://cdn.example/a.jpg" }] } },
    { pk: "B", media_type: 2, image_versions2: { candidates: [{ url: "https://cdn.example/video-preview.jpg" }] } },
  ] });
  const result = await discover(fixture({ visits: [[api(feed([carousel], false))]] }));
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "media-unresolved");
  assert.equal(result.rangeComplete, true, "Attachment retries remain distinct from verified feed traversal");
  assert.equal(result.headTraversalCaptured, true);
  assert.equal(result.headCaptured, false, "A first-page attachment gap must not create a complete incremental baseline");
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 3);
  assert.deepEqual(result.media.map((item) => item.logicalKey), ["CAROUSEL:A"]);
  assert.deepEqual(result.unresolvedMedia.map((item) => [item.logicalKey, item.kind, item.reason]),
    [["CAROUSEL:B", "video", "media-url-missing"], ["CAROUSEL:3", "image", "attachment-missing"]]);
});

test("Instagram malformed feed nodes cannot masquerade as an empty completed account", async () => {
  const result = await discover(fixture({ visits: [[api(feed([null], false))]] }));
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "timeline-unresolved");
  assert.deepEqual(result.media, []);
  assert.ok(result.parseIssues.some((item) => item.reason === "timeline-post-invalid"));
});

test("Instagram post-detail responses alone are not a hydrated timeline and retain the bounded retry", async () => {
  const session = fixture({ visits: [[api({ data: { media: post("DETAIL") } })]] });
  await assert.rejects(discover(session), { code: "timeline-unavailable" });
  assert.equal(session.visitCount, 2);
});

test("Instagram missing first-page feed structure cannot be inferred from a false cursor", async () => {
  const session = fixture({ visits: [[api({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
    page_info: { has_next_page: false },
  } } })]] });
  await assert.rejects(discover(session), { code: "timeline-unavailable" });
  assert.equal(session.visitCount, 2);
});

test("Instagram initial timeline network failures preserve sanitized failure diagnostics and bounded retry", async () => {
  const session = fixture({ visits: [[api(null, { failed: true })]] });
  await assert.rejects(discover(session), (error) => error.code === "timeline-unavailable"
    && error.message.includes("目标账号 API：网络请求失败 ×2"));
  assert.equal(session.visitCount, 2);
});

test("Instagram explicitly scoped empty terminal feeds remain a successful empty account", async () => {
  const result = await discover(fixture({ visits: [[api(feed([], false))]] }));
  assert.equal(result.complete, true);
  assert.equal(result.timelineResponses, 1);
  assert.deepEqual(result.posts, []);
});

test("Instagram waits for an already issued target request and revokes a provisional terminal page", async () => {
  const session = fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(feed([post("LATE")], true), { responseDelayMs: 25 })]] });
  const result = await discover(session, { responseWaitMs: 150 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.completionReason, null);
  assert.equal(result.timelineResponses, 2);
  assert.ok(result.media.some((item) => item.postKey === "LATE"));
});

test("Instagram an older request's late terminal response cannot replace a newer continuing cursor", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], true)),
    api(feed([post("OLDER")], false), { responseDelayMs: 45 }),
    api(feed([post("NEWER")], true), { responseDelayMs: 20 })]] }), { responseWaitMs: 150 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.timelineResponses, 3);
});

test("Instagram promotes an in-flight numeric target request when hydration identifies its owner", async () => {
  const session = fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(feed([post("LATE")], true), { variables: { user_id: "42" }, scoped: false, responseDelayMs: 25 })]] });
  const result = await discover(session, { responseWaitMs: 150 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.timelineResponses, 2);
});

test("Instagram requests issued on a feed remain timeline evidence when received during detail refresh", async () => {
  const url = "https://www.instagram.com/p/OLD/";
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(feed([post("LATE")], true), { respondOnDetail: true })]],
    details: { [url]: [api({ data: { media: post("OLD") } })] } }), { responseWaitMs: 10, retryPosts: [url] });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.timelineResponses, 2);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.ok(result.media.some((item) => item.postKey === "OLD"));
});

test("Instagram unresolved target requests and body reads produce bounded incomplete results", async (t) => {
  for (const [name, changes] of [["request without response", { unfinished: true }], ["unread response body", { jsonHangs: true }]]) {
    await t.test(name, async () => {
      const started = Date.now();
      const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)), api(feed([], false), changes)]] }),
        { responseWaitMs: 20 });
      assert.equal(result.complete, false);
      assert.equal(result.completionReason, null);
      assert.equal(result.incompleteReason, "timeline-in-flight");
      assert.ok(Date.now() - started < 1_000, "A missing response/body must not hang discovery");
    });
  }
});

test("Instagram a slow body cannot leave a stale terminal result after a later continuing page", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(feed([post("LATE")], true), { jsonDelayMs: 25 })]] }), { responseWaitMs: 150 });
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
  assert.ok(result.media.some((item) => item.postKey === "LATE"));
});

test("Instagram an explicitly unrelated unfinished request does not block a target terminal page", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(null, { variables: { username: "other" }, scoped: false, unfinished: true })]] }), { responseWaitMs: 20 });
  assert.equal(result.complete, true);
});

test("Instagram a delayed failed target request releases its lease but still invalidates completion", async () => {
  const result = await discover(fixture({ visits: [[api(feed([post("FIRST")], false)),
    api(null, { failed: true, responseDelayMs: 25 })]] }), { responseWaitMs: 150 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "timeline-unresolved");
  assert.ok(result.parseIssues.some((entry) => entry.reason === "timeline-request-failed"));
});

test("Instagram cancellation during an in-flight request wait closes its exact fixture context", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15);
  try {
    await assert.rejects(discover(fixture({ visits: [[api(feed([post("FIRST")], false)), api(null, { unfinished: true })]] }),
      { responseWaitMs: 500, signal: controller.signal }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});

test("Instagram detail retries can resolve an incomplete attachment without becoming a paging boundary", async () => {
  const url = "https://www.instagram.com/p/REPAIR/";
  const incomplete = post("REPAIR", { media_type: 2 });
  const repaired = post("REPAIR", { media_type: 2, video_versions: [{ url: "https://cdn.example/repair.mp4" }] });
  const result = await discover(fixture({ visits: [[api(feed([incomplete], false))]],
    details: { [url]: [api({ data: { media: repaired } })] } }), { retryPosts: [url] });
  assert.equal(result.complete, true);
  assert.equal(result.timelineResponses, 1);
  assert.equal(result.posts[0].mediaComplete, true);
  assert.deepEqual(result.unresolvedMedia, []);
  assert.equal(result.media[0].kind, "video");
});

test("Instagram smaller detail responses cannot erase a same-run album's missing attachment", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  for (const [name, missing] of [["unknown omitted attachment", [image("A"), image("B")]],
    ["known attachment without URL", [image("A"), image("B"), image("C", false)]]]) {
    await t.test(name, async () => {
      const result = await discover(fixture({ visits: [[api(feed([album(missing, 3)], false))]],
        details: { [url]: [api({ data: { media: album([image("A"), image("B")], 2) } })] } }), { retryPosts: [url] });
      assert.equal(result.complete, false);
      assert.equal(result.posts[0].mediaComplete, false);
      assert.equal(result.posts[0].mediaExpectedCount, 3);
      assert.ok(result.unresolvedMedia.length > 0);
      assert.equal(result.media.length, 2);
      assert.equal(result.posts[0].mediaExpectedKeys.includes("ALBUM:3"), false, "Unknown position placeholders are not stable IDs");
    });
  }
});

test("Instagram album coverage accumulates through successive pages and resolves only with the actual missing key", async () => {
  const result = await discover(fixture({ visits: [[api(feed([album([image("A"), image("B"), image("C", false)])], true))]],
    scrolls: [[api(feed([album([image("A"), image("B"), image("D")])], false))]] }));
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 3);
  assert.equal(result.media.length, 3, "Even enough other URLs cannot substitute for the identified missing attachment");
  assert.ok(result.unresolvedMedia.some((entry) => entry.logicalKey === "ALBUM:C"));
  assert.deepEqual(new Set(result.posts[0].mediaExpectedKeys), new Set(["ALBUM:A", "ALBUM:B", "ALBUM:C", "ALBUM:D"]));
});

test("Instagram a full detail response clears cumulative coverage only after all original attachments resolve", async () => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const result = await discover(fixture({ visits: [[api(feed([album([image("A"), image("B"), image("C", false)])], false))]],
    details: { [url]: [api({ data: { media: album([image("A"), image("B"), image("C")]) } })] } }), { retryPosts: [url] });
  assert.equal(result.complete, true);
  assert.equal(result.posts[0].mediaExpectedCount, 3);
  assert.equal(result.posts[0].mediaComplete, true);
  assert.equal(result.media.length, 3);
  assert.deepEqual(result.unresolvedMedia, []);
});

test("Instagram previous-run expected coverage forces a smaller complete-looking album's detail refresh", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const knownPostCoverage = { ALBUM: { postId: "ALBUM", postUrl: url, mediaExpectedCount: 3,
    mediaExpectedKeys: ["ALBUM:A", "ALBUM:B", "ALBUM:C"] } };
  for (const repaired of [false, true]) {
    await t.test(repaired ? "true repair resolves the pending album" : "another smaller representation keeps it pending", async () => {
      const session = fixture({ visits: [[api(feed([album([image("A"), image("B")], 2)], false))]],
        details: { [url]: [api({ data: { media: album(repaired ? [image("A"), image("B"), image("C")] : [image("A"), image("B")]) } })] } });
      const result = await discover(session, { retryPosts: [url], knownPostCoverage, knownMediaKeys: ["ALBUM:A", "ALBUM:B"] });
      assert.equal(result.complete, repaired);
      assert.equal(result.posts[0].mediaComplete, repaired);
      assert.equal(result.posts[0].mediaExpectedCount, 3);
      assert.equal(result.media.some((item) => item.logicalKey === "ALBUM:C"), repaired, "A smaller feed must not skip the required detail refresh");
    });
  }
});

test("Instagram cross-run missing stable IDs cannot be replaced by enough different media IDs", async () => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const result = await discover(fixture({ visits: [[api(feed([album([image("A"), image("B"), image("D")])], false))]] }),
    { knownPostCoverage: { ALBUM: { postUrl: url, mediaExpectedCount: 3, mediaExpectedKeys: ["ALBUM:A", "ALBUM:B", "ALBUM:C"] } },
      knownMediaKeys: ["ALBUM:A", "ALBUM:B"] });
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.posts[0].mediaExpectedKeys.includes("ALBUM:C"), true);
});

test("Instagram already indexed attachments count toward coverage without requiring their URL to be downloaded again", async () => {
  const result = await discover(fixture({ visits: [[api(feed([album([image("A"), image("B")], 2)], false))]] }),
    { knownPostCoverage: { ALBUM: { mediaExpectedCount: 3, mediaExpectedKeys: ["ALBUM:A", "ALBUM:B", "ALBUM:C"] } },
      knownMediaKeys: ["ALBUM:A", "ALBUM:B", "ALBUM:C"] });
  assert.equal(result.complete, true);
  assert.equal(result.posts[0].mediaExpectedCount, 3);
  assert.equal(result.media.length, 2, "The preserved third file is not downloaded just to prove its existence");
});

test("Instagram omitted prior pending albums do not vanish from discovery coverage", async () => {
  const result = await discover(fixture({ visits: [[api(feed([], false))]] }),
    { knownPostCoverage: { ALBUM: { postUrl: "https://www.instagram.com/p/ALBUM/", mediaExpectedCount: 3 } } });
  assert.equal(result.complete, false);
  assert.equal(result.unresolvedMedia[0].postKey, "ALBUM");
  assert.equal(result.unresolvedMedia[0].mediaExpectedCount, 3);
});

test("Instagram unavailable pending detail refresh remains pending and cannot be declared success", async () => {
  const url = "https://www.instagram.com/p/OLD/";
  const result = await discover(fixture({ visits: [[api(feed([], false))]], failures: { [url]: true } }), { retryPosts: [url] });
  assert.equal(result.complete, false);
  assert.equal(result.unresolvedMedia[0].postKey, "OLD");
  assert.equal(result.unresolvedMedia[0].postUrl, url);
  assert.equal(result.unresolvedMedia[0].reason, "retry-post-unavailable");
});

test("Instagram known boundaries require two distinct reliable batches, not details or malformed media", async (t) => {
  const first = [post("A"), post("B"), post("C")];
  const second = [post("D"), post("E"), post("F")];
  const knownPosts = Object.fromEntries([...first, ...second].map((item) => [item.code, { mediaComplete: true }]));
  await t.test("distinct target feed batches", async () => {
    const result = await discover(fixture({ visits: [[api(feed(first, true))]], scrolls: [[api(feed(second, true))]] }),
      { initialComplete: true, knownPosts });
    assert.equal(result.complete, true);
    assert.equal(result.completionReason, "known-boundary");
  });
  await t.test("post detail is not a second batch", async () => {
    const result = await discover(fixture({ visits: [[api(feed(first, true))]], scrolls: [[api({ data: { media: second } })]] }),
      { initialComplete: true, knownPosts });
    assert.equal(result.complete, false);
    assert.equal(result.reachedKnownBoundary, false);
  });
  await t.test("incomplete attachments cannot establish the second batch", async () => {
    const unsafe = second.map((item) => ({ ...item, image_versions2: { candidates: [] } }));
    const result = await discover(fixture({ visits: [[api(feed(first, true))]], scrolls: [[api(feed(unsafe, true))]] }),
      { initialComplete: true, knownPosts });
    assert.equal(result.complete, false);
    assert.equal(result.reachedKnownBoundary, false);
    assert.equal(result.unresolvedMedia.length, 3);
  });
  await t.test("a new batch arriving after a provisional boundary revokes it", async () => {
    const result = await discover(fixture({ visits: [[api(feed(first, true))]],
      scrolls: [[api(feed(second, true)), api(feed([post("NEW")], true))]] }), { initialComplete: true, knownPosts });
    assert.equal(result.complete, false);
    assert.equal(result.reachedKnownBoundary, false);
    assert.ok(result.media.some((item) => item.postKey === "NEW"));
  });
  await t.test("a target request failure revokes a provisional known boundary", async () => {
    const result = await discover(fixture({ visits: [[api(feed(first, true))]],
      scrolls: [[api(feed(second, true)), api(null, { status: 403 })]] }), { initialComplete: true, knownPosts });
    assert.equal(result.complete, false);
    assert.equal(result.reachedKnownBoundary, false);
  });
});

test("Instagram observed optional location avatar errors preserve terminal and known-boundary completion", async (t) => {
  const first = [post("A"), post("B"), post("C")], second = [post("D"), post("E"), post("F")];
  const decorate = (payload) => ({ ...payload, errors: [{ severity: "ERROR", message: "PRIVATE_DEBUG",
    path: ["xdt_api__v1__feed__user_timeline_graphql_connection", "edges", 1, "node", "location", "profile_pic_url"] }] });
  await t.test("actual first-page optional error", async () => {
    const r = await discover(fixture({ visits: [[api(decorate(feed(first, false)))]] }));
    assert.equal(r.complete, true); assert.equal(r.rangeComplete, true); assert.equal(r.headCaptured, true);
    assert.deepEqual(r.parseIssues, []);
  });
  await t.test("partial GraphQL errors on an actual profile pagination request", async () => {
    const knownPosts = Object.fromEntries([...first, ...second].map(p => [p.code, { mediaComplete: true }]));
    const r = await discover(fixture({ visits: [[api(feed(first, true))]], scrolls: [[api(decorate(feed(second, true)),
      { operation: "PolarisProfilePostsTabContentQuery_connection", variables: { id: "42", after: "PAGE2" } })]] }),
    { knownPosts, initialComplete: true });
    assert.equal(r.complete, true); assert.equal(r.rangeComplete, true); assert.equal(r.reachedKnownBoundary, true);
    assert.deepEqual(r.parseIssues, []);
  });
  await t.test("genuine missing attachments are not erased alongside harmless errors", async () => {
    const missing = album([image("A"), image("B")], 3);
    const r = await discover(fixture({ visits: [[api(decorate(feed([post("VALID"), missing], false)))]] }));
    assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
    assert.ok(r.unresolvedMedia.some(i => i.postKey === "ALBUM"));
    assert.equal(r.parseIssues.some(i => i.reason === "timeline-graphql-error"), false);
  });
});

test("Instagram real GraphQL media, identity and pagination failures remain blocking with sanitized context", async (t) => {
  for (const path of [
    ["xdt_api__v1__feed__user_timeline_graphql_connection", "page_info"],
    ["xdt_api__v1__feed__user_timeline_graphql_connection", "edges", 0, "node", "user", "username"],
    ["xdt_api__v1__feed__user_timeline_graphql_connection", "edges", 0, "node", "image_versions2"],
    ["xdt_api__v1__feed__user_timeline_graphql_connection", "edges", 0, "node", "unknown_field"],
  ]) await t.test(path.join("."), async () => {
    const r = await discover(fixture({ visits: [[api({ ...feed([post("VALID")], false), errors: [{
      message: "SECRET_BODY", debug_link: "https://private.example/?token=SECRET", path, code: 123,
    }] })]] }));
    assert.equal(r.complete, false); assert.equal(r.rangeComplete, false);
    const issue = r.parseIssues.find(i => i.fieldPath);
    assert.deepEqual(issue.fieldPath, path); assert.equal(issue.operation, "PolarisProfilePostsQuery");
    assert.equal(issue.scope, "timeline"); assert.equal(issue.graphqlCode, 123);
    assert.equal(blockingDiscoveryFailure(r), "timeline-graphql-error");
    assert.equal(JSON.stringify(r.parseIssues).includes("SECRET"), false);
  });
});

test("Instagram SSR-only detail retry repairs its requested album without importing recommended posts", async () => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const target = album([image("A"), image("B"), image("C")]);
  const recommended = post("RECOMMENDED", { media_type: 2 });
  const html = `<script type="application/json" data-sjs>${JSON.stringify({ data: { media: target, recommended } })}</script>`;
  const r = await discover(fixture({ visits: [[api(feed([album([image("A"), image("B")], 3)], false))]],
    detailHtml: { [url]: html } }), { retryPosts: [url] });
  assert.equal(r.complete, true); assert.equal(r.rangeComplete, true);
  assert.deepEqual(r.posts.map(p => p.postKey), ["ALBUM"]);
  assert.deepEqual(r.media.map(m => m.logicalKey), ["ALBUM:A", "ALBUM:B", "ALBUM:C"]);
  assert.deepEqual(r.unresolvedMedia, []);
});

test("Instagram album attachment shortcodes do not exempt genuine child media errors", async () => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const target = album([{ ...image("A"), code: "CHILD_A" }, image("B"), image("C")]);
  const fieldPath = ["xdt_shortcode_media", "carousel_media", 0, "image_versions2"];
  const payload = { data: { xdt_shortcode_media: target }, errors: [{ path: fieldPath, code: "FORBIDDEN" }] };
  const r = await discover(fixture({ visits: [[api(feed([], false))]],
    detailHtml: { [url]: `<script type="application/json">${JSON.stringify(payload)}</script>` } }), { retryPosts: [url] });
  assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
  const issue = r.parseIssues.find(i => i.reason === "timeline-graphql-error");
  assert.deepEqual(issue.fieldPath, fieldPath); assert.equal(issue.postKey, "ALBUM");
  assert.ok(r.unresolvedMedia.some(i => i.reason === "detail-refresh-unresolved"));
});

test("Instagram API detail retries do not collect recommendations and cannot corrupt the feed range", async () => {
  const url = "https://www.instagram.com/p/OLD/";
  const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [
    api({ data: { media: post("OLD"), recommended: post("RECOMMENDED", { media_type: 2 }) } }),
  ] } }), { retryPosts: [url] });
  assert.equal(r.complete, true); assert.equal(r.rangeComplete, true);
  assert.deepEqual(r.posts.map(p => p.postKey), ["OLD"]);
  assert.deepEqual(r.unresolvedMedia, []);
});

test("Instagram incomplete/unknown SSR details and HTTP failures preserve retries but not a fake feed failure", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const knownPostCoverage = { ALBUM: { postUrl: url, mediaExpectedCount: 3 } };
  for (const [name, changes] of [
    ["shorter actual carousel", { detailHtml: { [url]: `<script type="application/json">${JSON.stringify({ data: { media: album([image("A"), image("B")], 3) } })}</script>` } }],
    ["unknown page data", { detailHtml: { [url]: "<p>No readable data</p>" } }],
    ["HTTP denial", { detailStatus: { [url]: 403 } }],
  ]) await t.test(name, async () => {
    const r = await discover(fixture({ visits: [[api(feed([], false))]], ...changes }), { retryPosts: [url], knownPostCoverage });
    assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
    assert.ok(r.unresolvedMedia.some(i => i.postKey === "ALBUM"));
    assert.equal(r.parseIssues.some(i => i.reason === "timeline-graphql-error" && i.scope === "timeline"), false);
    if (name === "HTTP denial") {
      const failure = r.parseIssues.find(i => i.reason === "detail-refresh-failure");
      assert.equal(failure.scope, "detail"); assert.equal(failure.httpStatus, 403); assert.equal(failure.postKey, "ALBUM");
    }
  });
});

test("Instagram unresolved detail bodies do not invalidate an already proven recent range", async () => {
  const url = "https://www.instagram.com/p/OLD/";
  const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [
    api({ data: { media: post("OLD") } }, { jsonHangs: true }),
  ] } }), { retryPosts: [url], responseWaitMs: 20 });
  assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
  assert.ok(r.unresolvedMedia.some(i => i.postKey === "OLD"));
});

test("Instagram genuine detail API failures keep sanitized post-scoped diagnostics without blocking the feed range", async (t) => {
  const url = "https://www.instagram.com/p/OLD/";
  for (const [name, failure] of [
    ["HTTP 403", api(null, { status: 403, operation: "PolarisPostRootQuery" })],
    ["invalid body", api(null, { jsonError: true, operation: "PolarisPostRootQuery" })],
    ["network", api(null, { failed: true, operation: "PolarisPostRootQuery" })],
    ["API denial", api({ status: "fail", message: "PRIVATE_DETAILS" }, { operation: "PolarisPostRootQuery" })],
    ["GraphQL denial", api({ errors: [{ code: "ACCESS_DENIED", path: ["xdt_shortcode_media"], message: "PRIVATE_DETAILS" }] },
      { operation: "PolarisPostRootQuery" })],
  ]) await t.test(name, async () => {
    const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [failure] } }), { retryPosts: [url] });
    assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
    const issue = r.parseIssues.find(i => i.reason === "detail-refresh-failure" || i.reason === "timeline-graphql-error");
    assert.equal(issue.scope, "detail"); assert.equal(issue.postKey, "OLD"); assert.equal(issue.operation, "PolarisPostRootQuery");
    if (name === "HTTP 403") assert.equal(issue.httpStatus, 403);
    if (name === "GraphQL denial") { assert.equal(issue.graphqlCode, "ACCESS_DENIED"); assert.deepEqual(issue.fieldPath, ["xdt_shortcode_media"]); }
    assert.equal(JSON.stringify(r.parseIssues).includes("PRIVATE_DETAILS"), false);
    assert.ok(r.unresolvedMedia.some(i => i.postKey === "OLD"));
  });
});

test("Instagram complete-looking SSR and API media never hide genuine post query errors", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const target = album([image("A"), image("B"), image("C")]);
  for (const source of ["SSR", "API"]) for (const fieldPath of [
    ["xdt_shortcode_media", "image_versions2"],
    ["xdt_shortcode_media", "user", "username"],
    ["xdt_shortcode_media", "unknown_field"],
  ]) await t.test(`${source} ${fieldPath.join(".")}`, async () => {
    const payload = { data: { xdt_shortcode_media: target }, errors: [{ path: fieldPath, code: "FORBIDDEN", message: "PRIVATE_DETAIL" }] };
    const changes = source === "SSR"
      ? { detailHtml: { [url]: `<script type="application/json">${JSON.stringify(payload)}</script>` } }
      : { details: { [url]: [api(payload, { operation: "PolarisPostRootQuery", variables: { shortcode: "ALBUM" } })] } };
    const r = await discover(fixture({ visits: [[api(feed([], false))]], ...changes }), { retryPosts: [url] });
    assert.equal(r.rangeComplete, true); assert.equal(r.complete, false);
    assert.equal(r.posts[0].mediaComplete, false);
    assert.deepEqual(r.media.map(m => m.logicalKey), ["ALBUM:A", "ALBUM:B", "ALBUM:C"]);
    assert.ok(r.unresolvedMedia.some(i => i.postKey === "ALBUM" && i.reason === "detail-refresh-unresolved"));
    const issue = r.parseIssues.find(i => i.reason === "timeline-graphql-error");
    assert.equal(issue.scope, "detail"); assert.equal(issue.postKey, "ALBUM");
    assert.equal(issue.operation, "PolarisPostRootQuery"); assert.equal(issue.graphqlCode, "FORBIDDEN");
    assert.deepEqual(issue.fieldPath, fieldPath);
    assert.equal(JSON.stringify(r.parseIssues).includes("PRIVATE_DETAIL"), false);
  });
});

test("Instagram SSR detail errors are scoped to actual requested post roots", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const target = album([image("A"), image("B"), image("C")]);
  for (const [name, payloads] of [
    ["optional target location avatar", [{ data: { xdt_shortcode_media: target }, errors: [{ path: ["xdt_shortcode_media", "location", "profile_pic_url"] }] }]],
    ["independent foreign post query", [{ data: { xdt_shortcode_media: target } }, {
      data: { xdt_shortcode_media: post("OTHER") }, errors: [{ path: ["xdt_shortcode_media", "image_versions2"] }],
    }]],
    ["declared unrelated viewer module", [{ data: { xdt_shortcode_media: target, viewer: { id: "VIEWER" } },
      errors: [{ path: ["viewer", "unknown_field"] }] }]],
    ["recommended post in another declared root", [{ data: { xdt_shortcode_media: target, recommended: post("RECOMMENDED") },
      errors: [{ path: ["recommended", "image_versions2"] }] }]],
    ["foreign post under the same media container", [{ data: { media: [target, post("OTHER")] },
      errors: [{ path: ["media", 1, "image_versions2"] }] }]],
  ]) await t.test(name, async () => {
    const html = payloads.map(p => `<script type="application/json">${JSON.stringify(p)}</script>`).join("");
    const r = await discover(fixture({ visits: [[api(feed([], false))]], detailHtml: { [url]: html } }), { retryPosts: [url] });
    assert.equal(r.complete, true); assert.equal(r.rangeComplete, true);
    assert.deepEqual(r.posts.map(p => p.postKey), ["ALBUM"]);
    assert.equal(r.media.length, 3); assert.deepEqual(r.parseIssues, []);
  });
});

test("Instagram post-scoped true errors resolve only through a newer clean complete target detail response", async (t) => {
  const url = "https://www.instagram.com/p/ALBUM/";
  const target = album([image("A"), image("B"), image("C")]);
  const options = { operation: "PolarisPostRootQuery", variables: { shortcode: "ALBUM" } };
  const denied = api({ data: { xdt_shortcode_media: target }, errors: [{ path: ["xdt_shortcode_media", "carousel_media"], code: "FORBIDDEN" }] }, options);
  for (const [name, success, cleared] of [
    ["clean complete target", api({ data: { xdt_shortcode_media: target } }, options), true],
    ["complete-looking smaller album", api({ data: { xdt_shortcode_media: album([image("A")]) } }, options), false],
    ["recommended target cannot repair the query", api({ data: { recommended: target } }, options), false],
    ["foreign post cannot repair the query", api({ data: { xdt_shortcode_media: post("OTHER") } }, options), false],
  ]) await t.test(name, async () => {
    const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [denied, success] } }), { retryPosts: [url] });
    assert.equal(r.rangeComplete, true); assert.equal(r.complete, cleared);
    assert.equal(r.parseIssues.some(i => i.reason === "timeline-graphql-error"), !cleared);
    assert.equal(r.posts.find(p => p.postKey === "ALBUM").mediaComplete, cleared);
    assert.equal(r.unresolvedMedia.some(i => i.postKey === "ALBUM"), !cleared);
  });
  await t.test("older failed body cannot overturn newer success", async () => {
    const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [
      { ...denied, jsonDelayMs: 25 }, api({ data: { xdt_shortcode_media: target } }, options),
    ] } }), { retryPosts: [url], responseWaitMs: 100 });
    assert.equal(r.complete, true); assert.equal(r.rangeComplete, true);
    assert.deepEqual(r.parseIssues, []); assert.deepEqual(r.unresolvedMedia, []);
  });
});

test("Instagram explicitly requested null detail roots retain genuine errors beside unrelated data", async () => {
  const url = "https://www.instagram.com/p/OLD/";
  const r = await discover(fixture({ visits: [[api(feed([], false))]], details: { [url]: [
    api({ data: { xdt_shortcode_media: null, viewer: { id: "VIEWER" } }, errors: [
      { path: ["xdt_shortcode_media"], code: "ACCESS_DENIED" }, { path: ["viewer", "unknown_field"] },
    ] }, { operation: "PolarisPostRootQuery", variables: { shortcode: "OLD" } }),
  ] } }), { retryPosts: [url] });
  assert.equal(r.complete, false); assert.equal(r.rangeComplete, true);
  const issues = r.parseIssues.filter(i => i.reason === "timeline-graphql-error");
  assert.equal(issues.length, 1); assert.deepEqual(issues[0].fieldPath, ["xdt_shortcode_media"]);
  assert.equal(issues[0].postKey, "OLD"); assert.equal(issues[0].scope, "detail");
});
