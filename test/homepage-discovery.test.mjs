import test from "node:test";
import assert from "node:assert/strict";
import {
  HomepageDiscoveryError,
  analyzeHomepage,
  classifySocialProfile,
  extractSocialCandidates,
  isBlockedAddress,
  normalizeHomepageUrl,
} from "../lib/homepage-discovery.mjs";

test("social profile links are normalized and non-profile routes are ignored", () => {
  assert.equal(classifySocialProfile("https://twitter.com/OpenAI")?.profileUrl, "https://x.com/OpenAI");
  assert.equal(classifySocialProfile("https://www.threads.net/@openai")?.profileUrl, "https://www.threads.com/@openai");
  assert.equal(classifySocialProfile("https://www.tiktok.com/@openai")?.profileUrl, "https://www.tiktok.com/@openai");
  assert.equal(classifySocialProfile("https://instagram.com/p/ABC"), null);
  assert.equal(classifySocialProfile("https://x.com/i/status/123"), null);
});

test("homepage HTML yields direct, deduplicated account candidates", () => {
  const html = `
    <title>Creator links</title>
    <a href="https://x.com/creator_one">X</a>
    <a href="https://twitter.com/creator_one">duplicate</a>
    <a href="https://www.instagram.com/creator.one/">Instagram</a>
    <a href="https://www.threads.net/@creator.one">Threads</a>
    <a href="https://www.facebook.com/profile.php?id=123456">Facebook</a>
    <a href="https://www.tiktok.com/@creator.one">TikTok</a>
    <a href="https://www.instagram.com/reel/ABC">not a profile</a>`;
  const candidates = extractSocialCandidates(html, "https://creator.example/");
  assert.deepEqual(candidates.map((item) => item.platformId), ["x", "instagram", "threads", "facebook", "tiktok"]);
  assert.equal(candidates[0].evidence, "个人主页直接链接");
  assert.equal(candidates[0].confidence, "high");
});

test("homepage URLs accept a missing scheme but reject credentials", () => {
  assert.equal(normalizeHomepageUrl("creator.example"), "https://creator.example/");
  assert.throws(() => normalizeHomepageUrl("https://user:pass@example.com"), HomepageDiscoveryError);
});

test("local and private network addresses are blocked", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("192.168.1.10"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("::ffff:7f00:1"), true);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("homepage analysis reads a bounded public HTML response", async () => {
  const result = await analyzeHomepage("https://creator.example", {
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async () => new Response(
      '<html><title>Creator</title><a href="https://x.com/creator_one">X</a></html>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
  });
  assert.equal(result.title, "Creator");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].label, "@creator_one");
});

test("network failures retain a useful diagnostic code", async () => {
  const networkError = new TypeError("fetch failed", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
  await assert.rejects(
    analyzeHomepage("https://creator.example", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      fetchImpl: async () => { throw networkError; },
      browserFallback: false,
    }),
    /ECONNRESET/,
  );
});

const publicLookup = async () => [{ address: "1.1.1.1", family: 4 }];
function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("homepage cancellation before analysis does not resolve, fetch, or launch", async () => {
  const controller = new AbortController();
  const reason = new Error("Tool exiting");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(analyzeHomepage("https://creator.example", {
    signal: controller.signal,
    lookup: async () => { calls++; return publicLookup(); },
    fetchImpl: async () => { calls++; },
    browserType: { launch: async () => { calls++; } },
  }), (error) => error === reason);
  assert.equal(calls, 0);
});

test("homepage cancellation interrupts pending DNS and never starts fetching", async () => {
  const controller = new AbortController(), entered = deferred();
  let fetches = 0;
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal,
    lookup: async () => { entered.resolve(); return new Promise(() => {}); },
    fetchImpl: async () => { fetches++; },
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(fetches, 0);
});

test("homepage cancellation aborts fetch and cannot launch a fallback browser", async () => {
  const controller = new AbortController(), entered = deferred();
  let launches = 0, requestSignal;
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal, lookup: publicLookup,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      entered.resolve();
      return new Promise(() => {});
    },
    browserType: { launch: async () => { launches++; } },
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(launches, 0);
});

test("homepage cancellation cancels a pending response-body read and removes its listeners", async () => {
  const controller = new AbortController(), entered = deferred();
  const listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    return add(type, listener, options);
  };
  controller.signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    return remove(type, listener, options);
  };
  let cancelReason;
  const body = new ReadableStream({
    pull() { entered.resolve(); },
    cancel(reason) { cancelReason = reason; },
  }, { highWaterMark: 0 });
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal, lookup: publicLookup,
    fetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }),
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(cancelReason, controller.signal.reason);
  assert.equal(listeners.size, 0);
});

function fallbackFixture({ goto, evaluate } = {}) {
  let closes = 0;
  const page = {
    goto: goto || (async () => ({ status: () => 200 })),
    waitForTimeout: async () => {},
    evaluate: evaluate || (async () => ({ title: "Local fixture", links: ["https://x.com/creator_one"] })),
    url: () => "https://creator.example/",
  };
  const context = { route: async () => {}, newPage: async () => page };
  const browser = { newContext: async () => context, close: async () => { closes++; } };
  return { browser, browserType: { launch: async () => browser }, closes: () => closes };
}

test("homepage cancellation closes its exact fallback browser during navigation", async () => {
  const controller = new AbortController(), entered = deferred();
  const fixture = fallbackFixture({ goto: async () => { entered.resolve(); return new Promise(() => {}); } });
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal, lookup: publicLookup,
    fetchImpl: async () => { throw new TypeError("Offline transport failure"); },
    browserType: fixture.browserType,
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(fixture.closes(), 1);
});

test("homepage cancellation while browser launch is pending closes it when ready", async () => {
  const controller = new AbortController(), entered = deferred(), launched = deferred();
  const fixture = fallbackFixture();
  let contexts = 0;
  fixture.browser.newContext = async () => { contexts++; };
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal, lookup: publicLookup,
    fetchImpl: async () => { throw new TypeError("Offline transport failure"); },
    browserType: { launch: async () => { entered.resolve(); return launched.promise; } },
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  launched.resolve(fixture.browser);
  await rejected;
  assert.equal(fixture.closes(), 1);
  assert.equal(contexts, 0);
});

test("homepage cancellation never returns a stale result after zero-candidate fallback", async () => {
  const controller = new AbortController(), entered = deferred();
  const fixture = fallbackFixture({ evaluate: async () => { entered.resolve(); return new Promise(() => {}); } });
  const result = analyzeHomepage("https://creator.example", {
    signal: controller.signal, lookup: publicLookup,
    fetchImpl: async () => new Response("<title>Static result must not escape</title>", { headers: { "content-type": "text/html" } }),
    browserType: fixture.browserType,
  });
  const rejected = assert.rejects(result, (error) => error === controller.signal.reason);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(fixture.closes(), 1);
});
