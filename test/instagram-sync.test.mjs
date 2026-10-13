import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { discoverInstagramMedia } from "../lib/instagram-sync.mjs";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "../lib/background-chromium.mjs";

const post = { code: "POST123", pk: "100", taken_at: 1_788_000_000, user: { username: "creator", pk: "42" },
  image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg", width: 1080, height: 1080 }] } };
const feed = (items = [post], hasNextPage = false) => ({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
  edges: items.map((node) => ({ node })), page_info: { has_next_page: hasNextPage },
} } });

function offlineBrowser(handler, { extraPages = 0 } = {}) {
  const requests = [];
  const contexts = [];
  const optionsSeen = [];
  const prepare = async (context) => {
    contexts.push(context);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      await handler(route, url);
    });
    for (let index = 0; index < extraPages; index += 1) await context.newPage();
    return context;
  };
  return { requests, contexts, optionsSeen, browserType: {
    async launch(options) {
      optionsSeen.push(options);
      const browser = await chromium.launch(options);
      return { newContext: async (settings) => prepare(await browser.newContext(settings)), close: () => browser.close() };
    },
  } };
}

test("Instagram invalid handles and cancellation stop before a browser is opened", async () => {
  const browserType = { launch: () => assert.fail("Browser must not start") };
  await assert.rejects(discoverInstagramMedia({ handle: "wrong/name", browserType }), { code: "invalid-handle" });
  await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("Instagram waits for a delayed target feed instead of counting empty pre-hydration scrolls", async () => {
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") {
      await route.fulfill({ contentType: "text/html", body: '<p>Profile loading</p><script>fetch("/api/graphql"); setTimeout(() => fetch("/graphql/query"), 300)</script>' });
    } else if (url.pathname === "/api/graphql") {
      await route.fulfill({ json: { data: { unrelated_profile_component: {} } } });
    } else if (url.pathname === "/graphql/query") {
      await route.fulfill({ json: feed() });
    } else await route.abort();
  });
  const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 2_000, maxScrolls: 0 });
  assert.equal(result.complete, true);
  assert.equal(result.timelineResponses, 1);
  assert.deepEqual(result.posts.map((item) => item.postKey), ["POST123"]);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].publicationDate, "20260829");
  assert.equal(session.optionsSeen[0].headless, true);
  assert.equal(session.optionsSeen[0].executablePath, BACKGROUND_CHROMIUM_EXECUTABLE);
  assert.equal(session.requests.some((path) => path.endsWith(".jpg")), false, "Discovery must not download media");
});

test("Instagram retries a stalled profile load once in the same background worker", async () => {
  let visits = 0;
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") {
      visits += 1;
      await route.fulfill({ contentType: "text/html", body: visits === 1 ? '<p>Loading</p><script>fetch("/api/graphql")</script>' : '<p>Profile ready</p><script>fetch("/graphql/query")</script>' });
    } else if (url.pathname === "/api/graphql") {
      await route.fulfill({ json: { data: { user: { username: "creator", pk: "42" } } } });
    } else if (url.pathname === "/graphql/query") {
      await route.fulfill({ json: feed() });
    } else await route.abort();
  }, { extraPages: 3 });
  const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100, retryTimelineWaitMs: 1_000, maxScrolls: 0 });
  assert.equal(visits, 2);
  assert.equal(result.media.length, 1);
  assert.equal(result.complete, true);
  assert.equal(session.contexts.length, 1);
  assert.equal(session.contexts[0].pages().length, 0, "The context and redundant empty pages must close");
});

test("Instagram known-only feeds are successful, but a continuing feed is not a complete history", async () => {
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/graphql/query")</script>' });
    else if (url.pathname === "/graphql/query") await route.fulfill({ json: feed([post], true) });
    else await route.abort();
  });
  const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType, knownPosts: { POST123: {} }, initialComplete: true,
    timelineWaitMs: 1_000, maxScrolls: 6, scrollWaitMs: 5 });
  assert.equal(result.timelineResponses, 1);
  assert.equal(result.posts.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.reachedEnd, false);
});

test("Instagram explicitly scoped empty feeds are valid and unrelated empty responses are not", async () => {
  for (const scoped of [true, false]) {
    let visits = 0;
    const session = offlineBrowser(async (route, url) => {
      if (url.pathname === "/creator/") {
        visits += 1;
        await route.fulfill({ contentType: "text/html", body: `<script>fetch('/graphql/query', {method:'POST',body:new URLSearchParams({variables:JSON.stringify({username:'${scoped ? "creator" : "other"}'})})})</script>` });
      } else if (url.pathname === "/graphql/query") await route.fulfill({ json: feed([]) });
      else await route.abort();
    });
    const work = discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100, retryTimelineWaitMs: 100, maxScrolls: 0 });
    if (scoped) {
      const result = await work;
      assert.equal(result.complete, true);
      assert.deepEqual(result.posts, []);
      assert.equal(visits, 1);
    } else {
      await assert.rejects(work, { code: "timeline-unavailable" });
      assert.equal(visits, 2);
    }
  }
});

test("Instagram reports access and login failures without silently treating them as empty timelines", async (t) => {
  for (const scenario of [
    { name: "login", body: '<input type="password">', code: "login-required" },
    { name: "private", body: "This account is private", code: "private-account" },
    { name: "unavailable", body: "Sorry, this page isn't available", code: "content-unavailable" },
    { name: "HTTP denial", status: 403, body: "Denied", code: "profile-http-error" },
    { name: "rate limit", status: 429, body: "Denied", code: "rate-limited" },
  ]) {
    await t.test(scenario.name, async () => {
      const session = offlineBrowser(async (route) => route.fulfill({ status: scenario.status || 200, contentType: "text/html", body: scenario.body }));
      await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100 }), { code: scenario.code });
      assert.equal(session.requests.length, 1);
    });
  }
});

test("Instagram cancellation during initial hydration closes the background context", async () => {
  const controller = new AbortController();
  const session = offlineBrowser(async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<p>Loading</p>" });
    controller.abort();
  });
  await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType, signal: controller.signal, timelineWaitMs: 5_000 }), { name: "AbortError" });
  assert.equal(session.contexts[0].pages().length, 0);
});

test("Instagram pending-post refresh preserves safe target ownership and ignores external retry URLs", async () => {
  const retriedPost = { ...post, code: "RETRY123", pk: "101", image_versions2: { candidates: [{ url: "https://cdn.example/refreshed.jpg" }] } };
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/graphql/query")</script>' });
    else if (url.pathname === "/graphql/query") await route.fulfill({ json: feed() });
    else if (url.pathname === "/p/RETRY123/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/graphql")</script>' });
    else if (url.pathname === "/api/graphql") await route.fulfill({ json: { data: { media: retriedPost } } });
    else await route.abort();
  });
  const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 1_000, maxScrolls: 0,
    retryPosts: ["https://www.instagram.com/p/RETRY123/", "https://evil.test/p/OTHER/"] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.media.map((item) => item.logicalKey), ["POST123:100", "RETRY123:101"]);
  assert.equal(result.media[1].sourceUrl, "https://cdn.example/refreshed.jpg");
  assert.equal(session.requests.includes("/p/OTHER/"), false);
});

test("Instagram API denials are diagnostic only when the target feed never loads", async (t) => {
  for (const status of [403, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const session = offlineBrowser(async (route, url) => {
        if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/graphql/query?variables=" + encodeURIComponent(JSON.stringify({username:"creator"})))</script>' });
        else if (url.pathname === "/graphql/query") await route.fulfill({ status, body: "Denied" });
        else await route.abort();
      });
      await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100, retryTimelineWaitMs: 100 }),
        (error) => error.code === "timeline-unavailable" && error.message.includes(`目标账号 API：HTTP ${status}`));
    });
  }
});

test("Instagram unrelated HTTP and GraphQL errors do not prevent a healthy timeline", async () => {
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>Promise.all([fetch("/api/graphql?fixture=inbox"), fetch("/api/graphql?fixture=error")]).then(() => fetch("/graphql/query"))</script>' });
    else if (url.pathname === "/api/graphql" && url.searchParams.get("fixture") === "inbox") await route.fulfill({ status: 403, body: "Denied" });
    else if (url.pathname === "/api/graphql") await route.fulfill({ json: { errors: [{ message: "secret fixture error text must never be included in diagnostics" }] } });
    else if (url.pathname === "/graphql/query") await route.fulfill({ json: feed() });
    else await route.abort();
  });
  const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 1_000, maxScrolls: 0 });
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 1);
});

test("Instagram failed hydration reports sanitized GraphQL and error-JSON categories", async () => {
  const secret = "SECRET_BODY_VALUE";
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/api/graphql?fixture=graphql"); fetch("/api/graphql?fixture=errorjson"); fetch("/api/graphql?fixture=invalid")</script>' });
    else if (url.searchParams.get("fixture") === "graphql") await route.fulfill({ json: { errors: [{ message: secret }] } });
    else if (url.searchParams.get("fixture") === "errorjson") await route.fulfill({ json: { status: "fail", message: secret, error_type: secret } });
    else await route.fulfill({ body: secret });
  });
  await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100, retryTimelineWaitMs: 100 }),
    (error) => error.code === "timeline-unavailable" && error.message.includes("候选 API：") && error.message.includes("GraphQL 错误")
      && error.message.includes("API 错误 JSON") && error.message.includes("无效 JSON/解析失败") && !error.message.includes(secret));
});

test("Instagram an error-JSON payload with an empty feed is not a successful empty profile", async () => {
  const session = offlineBrowser(async (route, url) => {
    if (url.pathname === "/creator/") await route.fulfill({ contentType: "text/html", body: '<script>fetch("/graphql/query?variables=" + encodeURIComponent(JSON.stringify({username:"creator"})))</script>' });
    else await route.fulfill({ json: { ...feed([]), status: "fail", error_type: "fixture-denial" } });
  });
  await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType, timelineWaitMs: 100, retryTimelineWaitMs: 100 }),
    (error) => error.code === "timeline-unavailable" && error.message.includes("目标账号 API：API 错误 JSON"));
});
