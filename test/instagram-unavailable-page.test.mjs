import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { discoverInstagramMedia } from "../lib/instagram-sync.mjs";

const title = "很抱歉，无法访问此页面";
const explanation = "你点击的链接可能已损坏，或页面已被移除。返回 Instagram。";
const feed = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
  edges: [{ node: { code: "NORMAL", pk: "1", user: { username: "creator", pk: "42" },
    image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg" }] } } }], page_info: { has_next_page: false },
} } };

// All requests, including Instagram URLs, are fulfilled from local strings.
function offlineBrowser(body, { withFeed = false } = {}) {
  const paths = [];
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return { async newContext(settings) {
      const context = await browser.newContext(settings);
      await context.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        paths.push(path);
        if (path === "/creator/") await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8">${body}${withFeed
          ? '<script>fetch("/graphql/query")</script>' : ""}` });
        else if (path === "/graphql/query") await route.fulfill({ json: feed });
        else await route.abort();
      });
      return context;
    }, close: () => browser.close() };
  } };
  return { browserType, paths };
}

test("Instagram unavailable pages recognize the actual Chinese word order and English variants without waiting/retrying", async t => {
  for (const [name, body] of [
    ["actual Chinese leaf span", `<section><main role="main"><div><div><span>${title}</span></div><div><span>${explanation}</span></div></div></main></section>`],
    ["actual explanation with inline return anchor", `<section><main role="main"><div><div><span>${title}</span></div><div><span>你点击的链接可能已损坏，或页面已被移除。<a href="/">返回 Instagram。</a></span></div></div></main></section>`],
    ["previous Chinese order", "<main><h2>抱歉，此页面无法访问。</h2></main>"],
    ["English span explanation", "<main><span>Sorry, this page isn't available.</span><p>The link you followed may be broken, or the page may have been removed.</p></main>"],
    ["text-only English page", "Sorry, this page isn't available"],
  ]) await t.test(name, async () => {
    const session = offlineBrowser(body);
    await assert.rejects(discoverInstagramMedia({ handle: "creator", browserType: session.browserType,
      timelineWaitMs: 100, retryTimelineWaitMs: 100, maxScrolls: 0 }), error => error.code === "content-unavailable"
      && error.message.includes("核对账号名称及当前访问权限"));
    assert.deepEqual(session.paths, ["/creator/"], "An explicit removed/unavailable page is not retried as an API hydration timeout");
  });
});

test("Instagram unavailable wording inside posts, footer, dialogs and ordinary prose does not reject a readable profile", async t => {
  for (const [name, body] of [
    ["post caption", `<main><article><span>${title}</span><span>${explanation}</span></article></main>`],
    ["footer", `<main><h1>creator</h1><footer><span>${title}</span><span>${explanation}</span></footer></main>`],
    ["navigation", `<main><h1>creator</h1><nav><span>${title}</span><span>${explanation}</span></nav></main>`],
    ["dialog", `<main><h1>creator</h1><div role="dialog"><span>${title}</span><span>${explanation}</span></div></main>`],
    ["profile with post links", `<main><span>${title}</span><span>${explanation}</span><a href="/p/NORMAL/">Post</a></main>`],
    ["ordinary quotation", `<main><p>以前我看到“${title}”，后来修复了。</p><p>${explanation}</p></main>`],
  ]) await t.test(name, async () => {
    const session = offlineBrowser(body, { withFeed: true });
    const result = await discoverInstagramMedia({ handle: "creator", browserType: session.browserType,
      timelineWaitMs: 2_000, retryTimelineWaitMs: 0, maxScrolls: 0 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.posts.map(post => post.postKey), ["NORMAL"]);
    assert.equal(session.paths.some(path => path.endsWith(".jpg")), false);
  });
});

