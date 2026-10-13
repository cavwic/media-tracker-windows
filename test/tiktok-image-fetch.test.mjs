import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { chromium } from "playwright";
import { createTikTokImageFetch, validateTikTokImageUrl } from "../lib/tiktok-image-fetch.mjs";

const SOURCE = "https://p16-sign-va.tiktokcdn.com/photo.jpeg?signature=private";

function mockSession(scenarios = [{}]) {
  const calls = [];
  const cdp = new EventEmitter();
  let scenarioIndex = 0, current, navigationReject, nextId = 0, releases = 0, acquires = 0, closed = false;
  const streams = new Map();
  const request = (url) => {
    current.url = url;
    current.requestId = `request-${++nextId}`;
    queueMicrotask(() => cdp.emit("Fetch.requestPaused", { requestId: current.requestId,
      networkId: `network-${current.requestId}`, request: { url, method: "GET" }, resourceType: "Document" }));
  };
  cdp.send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "Fetch.continueRequest") {
      if (current.holdResponse) return {};
      queueMicrotask(() => cdp.emit("Fetch.requestPaused", {
        requestId: current.requestId, networkId: `network-${current.requestId}`, request: { url: current.url, method: "GET" }, resourceType: "Document",
        responseStatusCode: current.redirect ? 302 : current.status || 200,
        responseHeaders: current.redirect ? [{ name: "location", value: current.redirect }] : [
          { name: "content-type", value: current.mime || "image/jpeg" },
          ...(current.length == null ? [] : [{ name: "content-length", value: String(current.length) }]),
          ...(current.encoding ? [{ name: "content-encoding", value: current.encoding }] : []),
        ],
      }));
    } else if (method === "Fetch.continueResponse") {
      const destination = new URL(current.redirect, current.url).href;
      current.redirect = null;
      request(destination);
    } else if (method === "Fetch.takeResponseBodyAsStream") {
      const handle = `stream-${nextId}`;
      streams.set(handle, { chunks: [...(current.chunks || [Buffer.from([255, 216, 255, 217])])], hangRead: current.hangRead, readErrorAfter: current.readErrorAfter, reads: 0 });
      return { stream: handle };
    } else if (method === "IO.read") {
      const stream = streams.get(params.handle);
      if (stream.hangRead) return new Promise(() => {});
      if (stream.readErrorAfter != null && stream.reads++ >= stream.readErrorAfter) throw new Error(`IO.read: net::ERR_CONNECTION_RESET at ${SOURCE}`);
      const chunk = stream.chunks.shift();
      return { base64Encoded: true, data: chunk?.toString("base64") || "", eof: stream.chunks.length === 0 };
    } else if (method === "IO.close") {
      streams.delete(params.handle);
    } else if (method === "Fetch.failRequest") {
      if (params.requestId === current.requestId) navigationReject?.(new Error(`page.goto: net::ERR_ABORTED at ${SOURCE}`));
    }
    return {};
  };
  cdp.detach = async () => { calls.push({ method: "detach" }); };
  return {
    calls, streams, cdp,
    closeWorkTab: () => { closed = true; },
    get currentRequest() { return { id: current.requestId, url: current.url }; },
    get releases() { return releases; }, get acquires() { return acquires; },
    acquirePage: async (options) => {
      assert.equal(options.purpose, "download");
      acquires += 1;
      closed = false;
      return { context: { newCDPSession: async () => cdp }, page: {
        isClosed: () => closed,
        goto: async (url) => {
          current = { ...(scenarios[scenarioIndex++] || {}) };
          if (current.networkError) throw new Error(`page.goto: net::${current.networkError} at ${SOURCE}`);
          const navigation = new Promise((resolve, reject) => { navigationReject = reject; });
          request(url);
          return navigation;
        },
      }, release: async () => { releases += 1; closed = true; streams.clear(); } };
    },
  };
}

test("TikTok image URL guard accepts only HTTPS official media hosts on port 443", () => {
  for (const url of [SOURCE, "https://p.tiktokcdn-us.com/a", "https://p.tiktokcdn-eu.com/a", "https://www.tiktok.com:443/a"]) assert.equal(validateTikTokImageUrl(url), true);
  for (const url of ["http://p.tiktokcdn.com/a", "https://p.tiktokcdn.com:8443/a", "https://user:pass@p.tiktokcdn.com/a",
    "https://127.0.0.1/a", "https://localhost/a", "https://[::1]/a", "https://192.168.1.2/a",
    "https://tiktokcdn.com.evil.test/a", "https://tiktokcdn.com./a", "file:///C:/private.jpg", "not a url"]) assert.equal(validateTikTokImageUrl(url), false, url);
});

test("TikTok images stream chunks as whole 200 responses, ignore Range/credentials, and reuse one lease", async () => {
  const fixture = mockSession([{ chunks: [Buffer.from([255, 216]), Buffer.from([255, 217])] }, {}]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    assert.equal(fixture.acquires, 0);
    const first = await fetcher.fetchImage(SOURCE, { headers: { Range: "bytes=80-", Cookie: "never-forward", "User-Agent": "never-forward" }, mediaKind: "image" });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-range"), null);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.from([255, 216, 255, 217]));
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
    assert.equal(fixture.acquires, 1);
    assert.equal(fixture.streams.size, 0);
    assert.equal(fixture.calls.filter(({ method }) => method === "IO.close").length, 2);
    assert.deepEqual(fixture.calls.find(({ method }) => method === "Network.setCacheDisabled").params, { cacheDisabled: false });
    for (const call of fixture.calls.filter(({ method }) => method === "Fetch.continueRequest")) assert.deepEqual(Object.keys(call.params), ["requestId"]);
  } finally { await Promise.all([fetcher.dispose(), fetcher.dispose()]); }
  assert.equal(fixture.releases, 1);
});

test("TikTok image transport rejects video and unsafe URLs before creating a browser lease", async () => {
  const fixture = mockSession();
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  await assert.rejects(fetcher.fetchImage("https://127.0.0.1/private"), { code: "tiktok-image-redirect-blocked" });
  await assert.rejects(fetcher.fetchImage(SOURCE, { mediaKind: "video" }), { code: "unexpected-media-content" });
  await fetcher.dispose();
  assert.equal(fixture.acquires, 0);
});

test("TikTok image 403 and non-image responses never become success and can be retried", async () => {
  const fixture = mockSession([{ status: 403 }, { mime: "text/html" }, { mime: "application/json" }, { mime: "video/mp4" }, {}]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    await assert.rejects(fetcher.fetchImage(SOURCE), { status: 403 });
    for (let i = 0; i < 3; i += 1) await assert.rejects(fetcher.fetchImage(SOURCE), { code: "unexpected-media-content" });
    assert.equal(fixture.calls.some(({ method }) => method === "Fetch.takeResponseBodyAsStream"), false);
    assert.equal((await (await fetcher.fetchImage(SOURCE)).arrayBuffer()).byteLength, 4);
    assert.equal(fixture.acquires, 5);
  } finally { await fetcher.dispose(); }
});

test("TikTok image redirect checks block unknown/private destinations before continuing the response", async () => {
  const fixture = mockSession([{ redirect: "https://127.0.0.1/private" }, { redirect: "https://evil.test/steal" }, { redirect: "https://p2.tiktokcdn.com/image.jpeg" }]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    for (let i = 0; i < 2; i += 1) await assert.rejects(fetcher.fetchImage(SOURCE), { code: "tiktok-image-redirect-blocked" });
    assert.equal(fixture.calls.filter(({ method }) => method === "Fetch.continueResponse").length, 0);
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
    assert.equal(fixture.calls.filter(({ method }) => method === "Fetch.continueResponse").length, 1);
  } finally { await fetcher.dispose(); }
});

test("TikTok image size limits cover Content-Length and streamed bytes without leaking handles", async () => {
  const fixture = mockSession([{ length: 100 }, { chunks: [Buffer.from("123"), Buffer.from("456")] }]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage, maxImageBytes: 5 });
  try {
    await assert.rejects(fetcher.fetchImage(SOURCE), { code: "tiktok-image-too-large" });
    const response = await fetcher.fetchImage(SOURCE);
    await assert.rejects(response.arrayBuffer(), { code: "tiktok-image-too-large" });
  } finally { await fetcher.dispose(); }
  assert.equal(fixture.streams.size, 0);
  assert.equal(fixture.releases, 2);
});

test("TikTok image body cancel, AbortSignal, timeout, and dispose close their streams", async () => {
  for (const action of ["cancel", "abort", "timeout", "dispose"]) {
    const fixture = mockSession([{ hangRead: true }]);
    const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage, requestTimeoutMs: action === "timeout" ? 30 : 1_000 });
    const controller = new AbortController();
    const response = await fetcher.fetchImage(SOURCE, { signal: controller.signal });
    if (action === "cancel") await response.body.cancel();
    else {
      const reading = response.arrayBuffer();
      if (action === "abort") controller.abort();
      if (action === "dispose") await fetcher.dispose();
      await assert.rejects(reading, { name: action === "timeout" ? "TimeoutError" : "AbortError" });
    }
    await fetcher.dispose();
    assert.equal(fixture.streams.size, 0, action);
    assert.equal(fixture.releases, 1, action);
  }
});

test("TikTok image network errors preserve bounded error names without signed URLs", async () => {
  const fixture = mockSession([{ networkError: "ERR_CONNECTION_RESET" }, {}]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    await assert.rejects(fetcher.fetchImage(SOURCE), (error) => error.code === "ERR_CONNECTION_RESET" && !error.message.includes("signature") && !error.message.includes("tiktokcdn.com"));
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
  } finally { await fetcher.dispose(); }
});

test("TikTok image streams reject empty, truncated, or disconnected bodies and close stream handles", async () => {
  const fixture = mockSession([
    { chunks: [] },
    { length: 10, chunks: [Buffer.from("four")] },
    { chunks: [Buffer.from("123"), Buffer.from("456")], readErrorAfter: 1 },
    { length: 2, encoding: "gzip", chunks: [Buffer.from("decoded")] },
  ]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    for (const code of ["unexpected-media-content", "ERR_CONTENT_LENGTH_MISMATCH", "ERR_CONNECTION_RESET"]) {
      const response = await fetcher.fetchImage(SOURCE);
      await assert.rejects(response.arrayBuffer(), { code });
    }
    // IO.read yields decoded bytes, so compressed Content-Length is not used
    // as an uncompressed byte count.
    assert.equal(await (await fetcher.fetchImage(SOURCE)).text(), "decoded");
  } finally { await fetcher.dispose(); }
  assert.equal(fixture.streams.size, 0);
  assert.equal(fixture.acquires, 4);
  assert.equal(fixture.releases, 4);
});

test("Aborting after acquiring a TikTok image stream closes it before any body read", async () => {
  const fixture = mockSession();
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  const controller = new AbortController();
  const response = await fetcher.fetchImage(SOURCE, { signal: controller.signal });
  controller.abort();
  await assert.rejects(response.arrayBuffer(), { name: "AbortError" });
  await fetcher.dispose();
  assert.equal(fixture.calls.some(({ method }) => method === "IO.read"), false);
  assert.equal(fixture.streams.size, 0);
  assert.equal(fixture.releases, 1);
});

test("Cancelled image responses cannot pollute the next image's new session or request", async () => {
  const fixture = mockSession([{}, { holdResponse: true, chunks: [Buffer.from("new-image")] }]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  const controller = new AbortController();
  const first = await fetcher.fetchImage(SOURCE, { signal: controller.signal });
  const oldRequest = fixture.currentRequest;
  const oldListener = fixture.cdp.listeners("Fetch.requestPaused")[0];
  controller.abort();
  await assert.rejects(first.arrayBuffer(), { name: "AbortError" });
  const nextPromise = fetcher.fetchImage("https://p.tiktokcdn.com/new-image.jpeg");
  await new Promise((resolve) => setImmediate(resolve));
  const next = fixture.currentRequest;
  const staleEvent = { requestId: oldRequest.id, networkId: `network-${oldRequest.id}`,
    request: { url: oldRequest.url, method: "GET" }, resourceType: "Document", responseStatusCode: 200,
    responseHeaders: [{ name: "content-type", value: "image/jpeg" }] };
  // Simulate a late callback already queued on the retired owner, and an old
  // request ID mistakenly delivered to the new listener; both must be ignored.
  oldListener(staleEvent);
  fixture.cdp.emit("Fetch.requestPaused", staleEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.filter(({ method }) => method === "Fetch.takeResponseBodyAsStream").length, 1);
  fixture.cdp.emit("Fetch.requestPaused", { ...staleEvent, requestId: next.id, networkId: `network-${next.id}`, request: { url: next.url, method: "GET" } });
  assert.equal(await (await nextPromise).text(), "new-image");
  await fetcher.dispose();
  assert.equal(fixture.acquires, 2);
  assert.equal(fixture.releases, 2);
});

test("A closed image work tab is retired and URL fragments never enter network request identity", async () => {
  const fixture = mockSession([{}, {}]);
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    await (await fetcher.fetchImage(`${SOURCE}#ignored`)).arrayBuffer();
    assert.equal(new URL(fixture.currentRequest.url).hash, "");
    fixture.closeWorkTab();
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
    assert.equal(fixture.acquires, 2);
  } finally { await fetcher.dispose(); }
  assert.equal(fixture.releases, 2);
});

test("An unconfirmed successful-image cleanup retires the tab before the next image", async () => {
  const fixture = mockSession([{}, {}]);
  const originalSend = fixture.cdp.send;
  let failClose = true;
  fixture.cdp.send = async (method, params) => {
    if (method === "IO.close" && failClose) { failClose = false; throw new Error("fixture cleanup failure"); }
    return originalSend(method, params);
  };
  const fetcher = createTikTokImageFetch({ acquirePage: fixture.acquirePage });
  try {
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
    await (await fetcher.fetchImage(SOURCE)).arrayBuffer();
    assert.equal(fixture.acquires, 2);
  } finally { await fetcher.dispose(); }
  assert.equal(fixture.streams.size, 0);
});

test("TikTok image ordinary-browser stream fixture blocks a private redirect before the local destination is reached", async (t) => {
  const hits = [];
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]);
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/private` });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" });
      response.end(jpeg);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const userTab = await context.newPage();
  const worker = await context.newPage();
  const realCdp = await context.newCDPSession(worker);
  const proxyCdp = new EventEmitter();
  proxyCdp.send = (method, params) => realCdp.send(method, params);
  proxyCdp.detach = () => realCdp.detach();
  const base = `http://127.0.0.1:${server.address().port}`;
  // Only these two initial fixture URLs are mapped to the local server. Actual
  // redirect destinations are left untouched so the production guard sees them.
  realCdp.on("Fetch.requestPaused", (event) => {
    if ([`${base}/image`, `${base}/redirect`].includes(event.request.url)) {
      event = { ...event, request: { ...event.request, url: `https://p.tiktokcdn.com${new URL(event.request.url).pathname}` } };
    }
    proxyCdp.emit("Fetch.requestPaused", event);
  });
  let releases = 0;
  const fetcher = createTikTokImageFetch({ acquirePage: async () => ({
    context: { newCDPSession: async () => proxyCdp },
    page: { goto: (url, options) => worker.goto(`${base}${new URL(url).pathname}`, options) },
    release: async () => { releases += 1; await worker.close(); },
  }) });
  try {
    const result = await fetcher.fetchImage("https://p.tiktokcdn.com/image", { mediaKind: "image" });
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), jpeg);
    await assert.rejects(fetcher.fetchImage("https://p.tiktokcdn.com/redirect"), { code: "tiktok-image-redirect-blocked" });
    assert.deepEqual(hits, ["/image", "/redirect"]);
  } finally { await fetcher.dispose(); }
  assert.equal(releases, 1);
  assert.equal(userTab.isClosed(), false);
  assert.equal(worker.isClosed(), true);
});
