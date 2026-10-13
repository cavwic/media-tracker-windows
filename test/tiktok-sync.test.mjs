import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { classifyTikTokFailure, discoverTikTokMedia } from "../lib/tiktok-sync.mjs";

test("TikTok failures distinguish rate limits, user verification, login, and private content", () => {
  assert.equal(classifyTikTokFailure({ status: 429 }).code, "rate-limited");
  assert.equal(classifyTikTokFailure({ hasCaptcha: true }).code, "verification-required");
  assert.equal(classifyTikTokFailure({ url: "https://www.tiktok.com/login?redirect=profile" }).code, "login-required");
  assert.equal(classifyTikTokFailure({ bodyText: "This account is private" }).code, "private-account");
  assert.equal(classifyTikTokFailure({ status: 404 }).code, "content-unavailable");
  assert.equal(classifyTikTokFailure({ statusCode: 10001 }).code, "timeline-unavailable");
  assert.equal(classifyTikTokFailure({ bodyText: "Videos Likes Followers Log in" }), null);
});

test("TikTok cancellation and invalid handles stop before opening a browser profile", async () => {
  await assert.rejects(discoverTikTokMedia({ handle: "wrong/name" }), { code: "invalid-handle" });
  await assert.rejects(discoverTikTokMedia({ handle: "fixture_creator", signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("TikTok discovery consumes a browser profile feed and refreshes a pending post without live TikTok traffic", async () => {
  const post = (id, sourceUrl) => ({ id, createTime: 1_780_000_000, author: { uniqueId: "creator" }, video: { playAddr: sourceUrl } });
  const urls = [];
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return {
      async newContext(contextOptions) {
        const context = await browser.newContext(contextOptions);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          urls.push(url.pathname);
          if (url.pathname === "/api/post/item_list/") {
            await route.fulfill({ json: { statusCode: 0, itemList: [post("123456789", "https://v.tiktokcdn.com/current.mp4")], hasMore: false } });
          } else if (url.pathname === "/@creator/video/987654321") {
            const payload = { __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: post("987654321", "https://v.tiktokcdn.com/refreshed.mp4") } } } };
            await route.fulfill({ contentType: "text/html", body: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script><p>Creator video</p>` });
          } else if (url.pathname === "/@creator") {
            await route.fulfill({ contentType: "text/html", body: '<p>Creator profile</p><script>fetch("/api/post/item_list/")</script>' });
          } else await route.abort();
        });
        return context;
      },
      close: () => browser.close(),
    };
  } };
  const result = await discoverTikTokMedia({ handle: "creator", maxScrolls: 0, browserType,
    retryPosts: ["https://www.tiktok.com/@creator/video/987654321", "https://evil.test/@creator/video/987654321"] });
  assert.equal(result.complete, true);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.media.map((item) => item.sourceUrl), ["https://v.tiktokcdn.com/current.mp4", "https://v.tiktokcdn.com/refreshed.mp4"]);
  assert.equal(typeof result.fetchMedia, "function");
  assert.deepEqual(urls.filter((url) => url.includes("/video/")), ["/@creator/video/987654321"]);
});

const samplePost = { id: "123456789", createTime: 1_780_000_000, author: { uniqueId: "creator" }, video: { playAddr: "https://v.tiktokcdn.com/current.mp4" } };

test("TikTok image transport handles discovered and pending images while videos retain their Range request", async (t) => {
  const photoUrl = "https://p16-common-sign.tiktokcdn-us.com/image.jpg?signature=fixture";
  const photo = { ...samplePost, id: "123456790", imagePost: { images: [{ imageURL: { urlList: [photoUrl] } }] } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") {
      await route.fulfill({ contentType: "text/html", body: '<p>Profile</p><script>fetch("/api/post/item_list/")</script>' });
    } else if (url.pathname === "/api/post/item_list/") {
      await route.fulfill({ json: { statusCode: 0, itemList: [samplePost, photo], hasMore: false } });
    } else await route.abort();
  });
  const imageCalls = [], videoCalls = [];
  let disposed = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    videoCalls.push({ url, options });
    return new Response("video", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 4-8/9" } });
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage,
    linkedAccount: { profileDirectory: "fixture-only-profile" }, maxScrolls: 0, initialWaitMs: 1_000,
    imageFetchFactory(options) {
      assert.equal(options.profileDirectory, "fixture-only-profile");
      assert.equal(options.acquirePage, session.acquirePage);
      return {
        async fetchImage(url, fetchOptions) {
          assert.equal(session.releases, 1, "Discovery must release its worker before download acquires one");
          imageCalls.push({ url, options: fetchOptions });
          return new Response("image", { headers: { "content-type": "image/jpeg" } });
        },
        async dispose() { disposed += 1; },
      };
    },
  });
  assert.equal(imageCalls.length, 0, "No image request during discovery");
  await (await result.fetchMedia(photoUrl)).text();
  const pendingUrl = "https://p19-common-sign.tiktokcdn-us.com/old-image.jpg";
  await (await result.fetchMedia(pendingUrl, { mediaKind: "image" })).text();
  await (await result.fetchMedia(samplePost.video.playAddr, { mediaKind: "video", headers: { Range: "bytes=4-" } })).text();
  await result.dispose();
  assert.deepEqual(imageCalls.map((call) => call.url), [photoUrl, pendingUrl]);
  assert.equal(videoCalls.length, 1);
  assert.equal(videoCalls[0].options.headers.get("Range"), "bytes=4-");
  assert.equal(disposed, 1);
});

async function offlineSession(t, handler) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const userPage = await context.newPage();
  const worker = await context.newPage();
  const calls = [];
  let releases = 0;
  await context.route("**/*", async (route) => {
    calls.push(new URL(route.request().url()).pathname);
    await handler(route, new URL(route.request().url()));
  });
  return {
    worker, userPage, calls,
    get releases() { return releases; },
    acquirePage: async (options) => {
      assert.equal(options.purpose, "sync");
      return { context, page: worker, release: async () => { releases += 1; await worker.close(); } };
    },
  };
}

test("TikTok cold background session visits the homepage once before requesting works", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: '<script>sessionStorage.setItem("homepage-ready", "yes")</script>' });
    } else if (url.pathname === "/@creator") {
      await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/post/item_list/?ready=" + sessionStorage.getItem("homepage-ready"))</script>' });
    } else if (url.pathname === "/api/post/item_list/") {
      assert.equal(url.searchParams.get("ready"), "yes");
      await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: false } });
    } else await route.abort();
  });
  const wait = session.worker.waitForTimeout.bind(session.worker);
  let homeWaits = 0;
  let readyMarks = 0;
  t.mock.method(session.worker, "waitForTimeout", (milliseconds) => {
    if (milliseconds === 5_000) { homeWaits += 1; return wait(5); }
    return wait(milliseconds);
  });
  const result = await discoverTikTokMedia({ handle: "creator", maxScrolls: 0, initialWaitMs: 1_000,
    acquirePage: async (options) => ({ ...await session.acquirePage(options), needsHomeWarmup: true,
      markHomeWarmupComplete: () => { readyMarks += 1; } }) });
  assert.equal(result.posts.length, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(session.calls.slice(0, 2), ["/", "/@creator"]);
  assert.equal(session.calls.filter((url) => url === "/").length, 1);
  assert.equal(homeWaits, 1);
  assert.equal(readyMarks, 1);
  assert.equal(session.releases, 1);
});

test("TikTok cold homepage denial releases its worker and does not request works", async (t) => {
  const session = await offlineSession(t, async (route) => {
    await route.fulfill({ status: 403, body: "Forbidden" });
  });
  await assert.rejects(discoverTikTokMedia({ handle: "creator",
    acquirePage: async (options) => ({ ...await session.acquirePage(options), needsHomeWarmup: true,
      markHomeWarmupComplete: () => assert.fail("A failed homepage must be retried next time") }) }), { code: "homepage-http-error" });
  assert.deepEqual(session.calls, ["/"]);
  assert.equal(session.releases, 1);
  assert.equal(session.userPage.isClosed(), false);
});

test("Cancelling TikTok homepage initialization releases only the worker without marking it ready", async (t) => {
  const session = await offlineSession(t, async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<p>Homepage</p>" });
  });
  const controller = new AbortController();
  const wait = session.worker.waitForTimeout.bind(session.worker);
  t.mock.method(session.worker, "waitForTimeout", (milliseconds) => {
    const waiting = wait(milliseconds);
    if (milliseconds === 5_000) controller.abort();
    return waiting;
  });
  await assert.rejects(discoverTikTokMedia({ handle: "creator", signal: controller.signal,
    acquirePage: async (options) => ({ ...await session.acquirePage(options), needsHomeWarmup: true,
      markHomeWarmupComplete: () => assert.fail("Cancelled initialization is not ready") }) }), { name: "AbortError" });
  assert.deepEqual(session.calls, ["/"]);
  assert.equal(session.releases, 1);
  assert.equal(session.worker.isClosed(), true);
  assert.equal(session.userPage.isClosed(), false);
});

test("TikTok ordinary-session sync recovers after a list 403 and ignores a failed user-detail request", async (t) => {
  let lists = 0;
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") {
      await route.fulfill({ contentType: "text/html", body: '<p>Creator profile</p><script>fetch("/api/user/detail/"); fetch("/api/post/item_list/").then(() => setTimeout(() => fetch("/api/post/item_list/?retry=1"), 150));</script>' });
    } else if (url.pathname === "/api/user/detail/") {
      await route.fulfill({ status: 403, body: "" });
    } else if (url.pathname === "/api/post/item_list/") {
      lists += 1;
      await route.fulfill(lists === 1 ? { status: 403, body: "Forbidden" } : { json: { itemList: [samplePost], hasMore: false, statusCode: 0 } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 2_000 });
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 1);
  assert.equal(result.timelineResponses, 1);
  assert.equal(session.releases, 1);
  assert.equal(session.userPage.isClosed(), false);
  assert.equal(session.worker.isClosed(), true);
});

test("TikTok sync distinguishes homepage denial, list denial, empty HTTP 200, and invalid JSON", async (t) => {
  for (const scenario of [
    { name: "homepage denial", homepageStatus: 403, code: "homepage-http-error" },
    { name: "list denial", apiStatus: 403, body: "Forbidden", code: "timeline-http-error" },
    { name: "empty response", apiStatus: 200, body: "", code: "timeline-empty-response" },
    { name: "invalid response", apiStatus: 200, body: "<html>blocked</html>", code: "timeline-invalid-json" },
    { name: "unconfirmed empty list", apiStatus: 200, body: JSON.stringify({ statusCode: 0, itemList: [], hasMore: false }), code: "timeline-empty-unconfirmed" },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const session = await offlineSession(subtest, async (route, url) => {
        if (url.pathname === "/@creator") {
          await route.fulfill({ status: scenario.homepageStatus || 200, contentType: "text/html", body: scenario.homepageStatus ? "Forbidden" : '<p>Creator profile</p><script>fetch("/api/post/item_list/")</script>' });
        } else if (url.pathname === "/api/post/item_list/") {
          await route.fulfill({ status: scenario.apiStatus, headers: { "content-length": String(Buffer.byteLength(scenario.body)) }, body: scenario.body });
        } else await route.abort();
      });
      await assert.rejects(discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 100 }), { code: scenario.code });
      assert.equal(session.releases, 1);
      assert.equal(session.userPage.isClosed(), false);
    });
  }
});

test("TikTok displayed video count does not imply pagination has finished", async (t) => {
  const bootstrap = { __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 0, userInfo: { user: { uniqueId: "creator", secUid: "target-id" }, stats: { videoCount: 1 } } } } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") {
      await route.fulfill({ contentType: "text/html", body: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(bootstrap)}</script><script>fetch("/api/post/item_list/")</script>` });
    } else if (url.pathname === "/api/post/item_list/") {
      await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: true } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
});

test("TikTok cannot confirm a mixed terminal list with silently unrecognized items", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/post/item_list/")</script>' });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: {
      statusCode: 0, itemList: [samplePost, { id: "123456790" }], hasMore: false,
    } });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.completionReason, null);
  assert.ok(result.parseIssues.length);
  assert.match(result.incompleteReason, /条目|完整/);
});

test("TikTok a smaller detail album cannot erase a missing slot learned from the timeline", async (t) => {
  const album = { ...samplePost, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }, {}] } };
  const partial = { ...samplePost, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }] } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/post/item_list/")</script>' });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [album], hasMore: false } });
    else if (url.pathname === `/@creator/photo/${samplePost.id}`) await route.fulfill({ contentType: "text/html", body:
      `<script id="SIGI_STATE" type="application/json">${JSON.stringify({ ItemModule: { one: partial } })}</script>` });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.equal(result.unresolvedMedia[0].logicalKey, `${samplePost.id}:image:2`);
  assert.equal(result.unresolvedMedia[0].mediaIndex, 2);
});

test("TikTok a later sync cannot shrink the historical album expected count or missing slot IDs", async (t) => {
  const partial = { ...samplePost, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }] } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/post/item_list/")</script>' });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [partial], hasMore: false } });
    else if (url.pathname === `/@creator/photo/${samplePost.id}`) await route.fulfill({ contentType: "text/html", body:
      `<script id="SIGI_STATE" type="application/json">${JSON.stringify({ ItemModule: { one: partial } })}</script>` });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000,
    knownPostCoverage: { [samplePost.id]: { postId: samplePost.id, postUrl: `https://www.tiktok.com/@creator/photo/${samplePost.id}`,
      mediaExpectedCount: 2, mediaExpectedKeys: [`${samplePost.id}:image:1`, `${samplePost.id}:image:2`] } } });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.deepEqual(result.posts[0].mediaExpectedKeys, [`${samplePost.id}:image:1`, `${samplePost.id}:image:2`]);
  assert.equal(result.unresolvedMedia[0].logicalKey, `${samplePost.id}:image:2`);
});

test("TikTok SSR tiles plus an empty initial API list cannot certify full history", async (t) => {
  const bootstrap = { ItemModule: { one: samplePost } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      `<script id="SIGI_STATE" type="application/json">${JSON.stringify(bootstrap)}</script><script>fetch("/api/post/item_list/?cursor=0")</script>` });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [], hasMore: false } });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 150 });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.incompleteReason, /空作品列表/);
  assert.equal(result.headCaptured, false);
  assert.equal(result.rangeComplete, false);
});

test("TikTok verifies genuinely empty profiles using explicit target zero count and a terminal API page", async (t) => {
  const bootstrap = { __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 0,
    userInfo: { user: { uniqueId: "creator", secUid: "creator-sec-id", privateAccount: false }, stats: { videoCount: 0 } },
  } } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(bootstrap)}</script><script>fetch("/api/post/item_list/?secUid=creator-sec-id")</script>` });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [], hasMore: false } });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 0);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.completionReason, "terminal-page");
});

test("TikTok complete media in two old known batches may stop at the reliable incremental boundary", async (t) => {
  const batches = [0, 1].map((page) => [0, 1, 2].map((index) => ({ ...samplePost, id: String(123456780 + page * 3 + index) })));
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<main style="height:3000px">Works</main><script>fetch("/api/post/item_list/?cursor=0"); let loaded=false; window.addEventListener("wheel",()=>{if(!loaded){loaded=true;fetch("/api/post/item_list/?cursor=1")}});</script>' });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: {
      statusCode: 0, itemList: batches[Number(url.searchParams.get("cursor"))], hasMore: true,
    } });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 1, initialWaitMs: 1_000,
    initialComplete: true, since: "2026-09-01T00:00:00Z", knownPosts: Object.fromEntries(batches.flat().map((post) => [post.id, true])) });
  assert.equal(result.posts.length, 6);
  assert.equal(result.complete, true);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.completionReason, "known-boundary");
});

test("TikTok follows the newest hasMore evidence and waits for already-issued pagination requests", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<script>fetch("/api/post/item_list/?cursor=0"); fetch("/api/post/item_list/?cursor=1");</script>' });
    else if (url.pathname === "/api/post/item_list/") {
      if (url.searchParams.get("cursor") === "1") await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: url.searchParams.get("cursor") === "1" } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.timelineResponses, 2);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
});

test("TikTok a late old terminal response cannot overwrite a newer issued page with hasMore", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<script>fetch("/api/post/item_list/?cursor=0"); fetch("/api/post/item_list/?cursor=1");</script>' });
    else if (url.pathname === "/api/post/item_list/") {
      if (url.searchParams.get("cursor") === "0") await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: url.searchParams.get("cursor") === "1" } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.timelineResponses, 2);
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
});

test("TikTok zero-count hydration cannot revive an old empty terminal page after newer hasMore evidence", async (t) => {
  const bootstrap = { __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 0,
    userInfo: { user: { uniqueId: "creator", privateAccount: false }, stats: { videoCount: 0 } },
  } } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(bootstrap)}</script><script>fetch("/api/post/item_list/?cursor=0"); fetch("/api/post/item_list/?cursor=1");</script><script src="/fixture-delay.js"></script>` });
    else if (url.pathname === "/fixture-delay.js") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ contentType: "application/javascript", body: "" });
    } else if (url.pathname === "/api/post/item_list/") {
      const second = url.searchParams.get("cursor") === "1";
      if (second) await new Promise((resolve) => setTimeout(resolve, 30));
      await route.fulfill({ json: { statusCode: 0, itemList: second ? [samplePost] : [], hasMore: second } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.reachedEnd, false);
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
});

test("TikTok an unreadable subsequent page keeps parsed media but cannot advance the boundary", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<script>fetch("/api/post/item_list/?cursor=0"); fetch("/api/post/item_list/?cursor=1");</script>' });
    else if (url.pathname === "/api/post/item_list/") {
      if (url.searchParams.get("cursor") === "1") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await route.fulfill({ status: 403, body: "Forbidden" });
      } else await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: false } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 200 });
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 1);
  assert.equal(result.posts[0].mediaComplete, true);
  assert.match(result.incompleteReason, /403/);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.parseIssues[0].reason, "timeline-http-failure");
});

test("TikTok already-loaded worker tab is read without navigating or closing the user's other tab", async (t) => {
  const bootstrap = { ItemModule: { "123456789": samplePost } };
  const session = await offlineSession(t, async (route) => {
    await route.fulfill({ contentType: "text/html", body: `<script id="SIGI_STATE" type="application/json">${JSON.stringify(bootstrap)}</script>` });
  });
  await session.worker.goto("https://www.tiktok.com/@creator");
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 10 });
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.headCaptured, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(session.calls.filter((pathname) => pathname === "/@creator").length, 1);
  assert.equal(session.userPage.isClosed(), false);
});

test("Cancelling TikTok shared-session sync releases only its worker tab", async (t) => {
  const session = await offlineSession(t, async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<p>Creator profile loading</p>" });
  });
  const controller = new AbortController();
  const work = discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, signal: controller.signal, initialWaitMs: 2_000 });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(work, { name: "AbortError" }); } finally { clearTimeout(timer); }
  assert.equal(session.releases, 1);
  assert.equal(session.worker.isClosed(), true);
  assert.equal(session.userPage.isClosed(), false);
});

test("TikTok pagination reaches the end inside a nested works scroller beside a fixed sidebar", async (t) => {
  const batches = [
    Array.from({ length: 8 }, (_, i) => ({ ...samplePost, id: String(123456780 + i) })),
    Array.from({ length: 8 }, (_, i) => ({ ...samplePost, id: String(123456790 + i) })),
    Array.from({ length: 3 }, (_, i) => ({ ...samplePost, id: String(123456800 + i) })),
  ];
  const cursors = [];
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") {
      await route.fulfill({ contentType: "text/html", body: `
        <style>
          html, body { margin: 0; height: 100%; overflow: hidden; }
          aside { position: fixed; left: 0; top: 0; bottom: 0; width: 250px; overflow: auto; }
          main { position: fixed; left: 280px; right: 20px; top: 20px; bottom: 20px; overflow: hidden; }
          #works { height: 100%; overflow-y: auto; }
          [data-e2e="user-post-item"] { height: 230px; margin-bottom: 10px; }
        </style>
        <aside>Fixed navigation</aside><main><div id="works"></div></main>
        <script>
          const works = document.querySelector('#works');
          let cursor = 0, busy = false, more = true;
          async function load() {
            if (busy || !more) return;
            busy = true;
            const data = await fetch('/api/post/item_list/?cursor=' + cursor).then(r => r.json());
            for (const post of data.itemList) {
              const tile = document.createElement('div');
              tile.dataset.e2e = 'user-post-item';
              tile.innerHTML = '<a href="/@creator/video/' + post.id + '">Video ' + post.id + '</a>';
              works.append(tile);
            }
            cursor += 1;
            more = data.hasMore;
            busy = false;
          }
          works.addEventListener('scroll', () => {
            if (works.scrollTop + works.clientHeight >= works.scrollHeight - 40) load();
          });
          load();
        </script>` });
    } else if (url.pathname === "/api/post/item_list/") {
      const cursor = Number(url.searchParams.get("cursor"));
      cursors.push(cursor);
      await route.fulfill({ json: { statusCode: 0, itemList: batches[cursor] || [], hasMore: cursor < batches.length - 1 } });
    } else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 4, initialWaitMs: 1_000 });
  assert.deepEqual(cursors, [0, 1, 2]);
  assert.equal(result.posts.length, 19);
  assert.equal(result.timelineResponses, 3);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.complete, true);
  assert.equal(session.userPage.isClosed(), false);
});

async function oldGapFixture(t, { detailStatus = 200 } = {}) {
  const batches = [0, 1, 2, 3].map((page) => [0, 1, 2].map((index) => ({ ...samplePost,
    id: String(123456700 + page * 3 + index) })));
  const oldId = "123450000";
  const partial = { ...samplePost, id: oldId, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/old-one.jpg" }] } };
  const cursors = [];
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<main style="height:3000px">Works</main><script>fetch("/api/post/item_list/?cursor=0");let cursor=1;window.addEventListener("wheel",()=>fetch("/api/post/item_list/?cursor="+cursor++));</script>' });
    else if (url.pathname === "/api/post/item_list/") {
      const cursor = Number(url.searchParams.get("cursor")); cursors.push(cursor);
      await route.fulfill({ json: { statusCode: 0, itemList: batches[cursor], hasMore: true } });
    } else if (url.pathname === `/@creator/photo/${oldId}`) await route.fulfill({ status: detailStatus,
      contentType: "text/html", body: detailStatus === 200
        ? `<script id="SIGI_STATE" type="application/json">${JSON.stringify({ ItemModule: { old: partial } })}</script>` : "Unavailable" });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 3, initialWaitMs: 1_000,
    scanMode: "incremental", initialComplete: true, since: "2026-09-01T00:00:00Z",
    knownPosts: Object.fromEntries(batches.flat().map((post) => [post.id, true])),
    knownPostCoverage: { [oldId]: { postId: oldId, postUrl: `https://www.tiktok.com/@creator/photo/${oldId}`,
      mediaExpectedCount: 2, mediaExpectedKeys: [`${oldId}:image:1`, `${oldId}:image:2`] } } });
  return { result, cursors, oldId, session };
}

test("TikTok old pending attachments do not force a daily scan past two clean known feed batches", async (t) => {
  const { result, cursors, oldId, session } = await oldGapFixture(t);
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(result.headCaptured, true);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.rangeCompletionReason, "known-boundary");
  assert.equal(result.reachedKnownBoundary, true);
  assert.equal(result.complete, false);
  assert.equal(result.completionReason, null);
  const old = result.posts.find((post) => post.postId === oldId);
  assert.equal(old.mediaExpectedCount, 2);
  assert.equal(old.mediaComplete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.logicalKey === `${oldId}:image:2`));
  assert.equal(session.calls.filter((url) => url === `/@creator/photo/${oldId}`).length, 1);
});

test("TikTok an old missing detail retains its gap without retracting a separately verified recent range", async (t) => {
  const { result, cursors, oldId } = await oldGapFixture(t, { detailStatus: 404 });
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(result.rangeComplete, true);
  assert.equal(result.complete, false);
  assert.equal(result.parseIssues[0].reason, "detail-refresh-failure");
  assert.equal(result.parseIssues[0].postKey, oldId);
  assert.ok(result.unresolvedMedia.some((item) => item.logicalKey === `${oldId}:image:2`));
});

test("TikTok incomplete first-page attachment coverage cannot advance the recent baseline", async (t) => {
  const album = { ...samplePost, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }, {}] } };
  const partial = { ...samplePost, imagePost: { images: [{ imageURL: "https://p.tiktokcdn.com/one.jpg" }] } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      '<main style="height:3000px">Works</main><script>fetch("/api/post/item_list/?cursor=0");window.addEventListener("wheel",()=>fetch("/api/post/item_list/?cursor=1"),{once:true});</script>' });
    else if (url.pathname === "/api/post/item_list/") {
      const first = url.searchParams.get("cursor") === "0";
      await route.fulfill({ json: { statusCode: 0, itemList: first ? [album] : [{ ...samplePost, id: "123456799" }], hasMore: first } });
    } else if (url.pathname === `/@creator/photo/${samplePost.id}`) await route.fulfill({ contentType: "text/html", body:
      `<script id="SIGI_STATE" type="application/json">${JSON.stringify({ ItemModule: { one: partial } })}</script>` });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, scanMode: "incremental",
    maxScrolls: 1, initialWaitMs: 1_000 });
  assert.equal(result.reachedEnd, true);
  assert.equal(result.headCaptured, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.complete, false);
  assert.ok(result.unresolvedMedia.some((item) => item.logicalKey === `${samplePost.id}:image:2`));
});

test("TikTok a later terminal page without a captured target first page cannot prove complete history", async (t) => {
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/post/item_list/?cursor=3")</script>' });
    else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [samplePost], hasMore: false } });
    else await route.abort();
  });
  const result = await discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 1_000 });
  assert.equal(result.reachedEnd, true);
  assert.equal(result.headCaptured, false);
  assert.equal(result.rangeComplete, false);
  assert.equal(result.complete, false);
});

test("TikTok delayed target-zero hydration cannot certify another secUid's empty terminal page", async (t) => {
  const bootstrap = { __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 0,
    userInfo: { user: { uniqueId: "creator", secUid: "target-sec", privateAccount: false }, stats: { videoCount: 0 } },
  } } };
  const session = await offlineSession(t, async (route, url) => {
    if (url.pathname === "/@creator") await route.fulfill({ contentType: "text/html", body:
      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(bootstrap)}</script><script>fetch("/api/post/item_list/?cursor=0&secUid=foreign-sec")</script><script src="/delay.js"></script>` });
    else if (url.pathname === "/delay.js") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({ contentType: "application/javascript", body: "" });
    } else if (url.pathname === "/api/post/item_list/") await route.fulfill({ json: { statusCode: 0, itemList: [], hasMore: false } });
    else await route.abort();
  });
  await assert.rejects(discoverTikTokMedia({ handle: "creator", acquirePage: session.acquirePage, maxScrolls: 0, initialWaitMs: 150 }),
    { code: "timeline-empty-unconfirmed" });
});
