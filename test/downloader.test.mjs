import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { downloadMediaItem, indexExistingMedia } from "../lib/downloader.mjs";

test("downloader writes atomically and removes same-account content duplicates", async () => {
  const payload = Buffer.from("same-image-content");
  let receivedReferer = "";
  const server = http.createServer((request, response) => {
    receivedReferer = request.headers.referer || "";
    response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": payload.length });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-download-"));
  const scope = { hashes: {} };

  try {
    const base = {
      kind: "image",
      sourceUrl: `http://127.0.0.1:${address.port}/media.jpg`,
      extension: ".jpg",
      createdAt: "2026-08-30T09:01:29.000Z",
      postId: "123",
      mediaIndex: 1,
      referer: "https://www.instagram.com/",
    };
    const first = await downloadMediaItem(base, root, scope);
    assert.equal(first.status, "downloaded");
    assert.equal(receivedReferer, "https://www.instagram.com/");
    assert.equal(await readFile(path.join(root, first.relativePath), "utf8"), payload.toString());
    assert.equal((await stat(path.join(root, "Image"))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, "Video")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(root, "gif")), { code: "ENOENT" });
    scope.hashes[first.sha256] = first.relativePath;

    const second = await downloadMediaItem({ ...base, postId: "124" }, root, scope);
    assert.equal(second.status, "content-duplicate");
    assert.equal(second.relativePath, first.relativePath);

    const indexed = await indexExistingMedia(root);
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].sha256, first.sha256);
    await assert.rejects(stat(path.join(root, "Video")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(root, "gif")), { code: "ENOENT" });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("downloader falls back from a gone high-bitrate video without retrying it", async () => {
  const calls = [];
  const payload = Buffer.from("working-lower-bitrate-video");
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    if (request.url === "/high.mp4") {
      response.writeHead(404);
      response.end();
    } else if (request.url === "/medium.mp4") {
      response.writeHead(410);
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": payload.length });
      response.end(payload);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-fallback-"));
  try {
    const result = await downloadMediaItem({
      kind: "video", postId: "1663139622820667392", mediaIndex: 1, extension: ".mp4",
      sourceUrl: `${baseUrl}/high.mp4`, bitrate: 2176000,
      variants: [
        { sourceUrl: `${baseUrl}/high.mp4`, bitrate: 2176000 },
        { sourceUrl: `${baseUrl}/medium.mp4`, bitrate: 950000 },
        { sourceUrl: `${baseUrl}/low.mp4`, bitrate: 632000 },
      ],
    }, root, { hashes: {} });
    assert.deepEqual(calls, ["/high.mp4", "/medium.mp4", "/low.mp4"]);
    assert.equal(result.sourceUrl, `${baseUrl}/low.mp4`);
    assert.equal(result.bitrate, 632000);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.attemptedSources, 3);
    assert.equal(result.fallbackFrom, `${baseUrl}/high.mp4`);
    assert.equal(await readFile(path.join(root, result.relativePath), "utf8"), payload.toString());
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("downloader retries transient failures then discards partial bytes when switching variants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-partial-fallback-"));
  const calls = [];
  let streamFailed = false;
  const fetchMedia = async (url, options) => {
    calls.push({ url, range: options.headers.Range || null, mediaKind: options.mediaKind });
    if (url.endsWith("/high.mp4")) {
      if (calls.length > 1) return new Response(null, { status: 404 });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("old-encoding-prefix"));
          setTimeout(() => { streamFailed = true; controller.error(new Error("connection lost")); }, 40);
        },
      }), { headers: { "Content-Type": "video/mp4" } });
    }
    assert.equal(streamFailed, true);
    return new Response("complete-new-encoding", { headers: { "Content-Type": "video/mp4" } });
  };
  try {
    const result = await downloadMediaItem({
      kind: "video", postId: "partial", mediaIndex: 1, extension: ".mp4",
      sourceUrl: "https://media.example/high.mp4",
      variants: [{ sourceUrl: "https://media.example/low.mp4", bitrate: 950000 }],
    }, root, { hashes: {} }, { fetchMedia });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].range, "bytes=19-");
    assert.equal(calls[2].range, null);
    assert.equal(calls.every((call) => call.mediaKind === "video"), true);
    assert.equal(await readFile(path.join(root, result.relativePath), "utf8"), "complete-new-encoding");
    assert.equal((await readdir(root)).some((file) => file.endsWith(".part")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloader retries transient HTTP failures and reports post identity when all variants are gone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-errors-"));
  let attempts = 0;
  try {
    const item = {
      kind: "video", postId: "123", postUrl: "https://x.com/creator/status/123", mediaIndex: 1,
      sourceUrl: "https://media.example/high.mp4", extension: ".mp4",
    };
    const result = await downloadMediaItem(item, root, { hashes: {} }, { fetchMedia: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : new Response("video-content", { headers: { "Content-Type": "video/mp4" } });
    } });
    assert.equal(attempts, 2);
    assert.equal(result.fallbackUsed, false);
    await assert.rejects(downloadMediaItem({ ...item, sourceUrls: ["https://media.example/low.mp4"] }, root, { hashes: {} }, {
      fetchMedia: async () => new Response(null, { status: 404 }),
    }), (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /https:\/\/x\.com\/creator\/status\/123/);
      assert.match(error.message, /2 个媒体地址，HTTP 404/);
      return true;
    });
    assert.equal((await readdir(root)).some((file) => file.endsWith(".part")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloader rejects HTML and JSON success responses without saving a media file", async () => {
  const requests = [];
  const types = ["text/html; charset=utf-8", "application/xhtml+xml", "application/json", "application/problem+json"];
  const server = http.createServer((request, response) => {
    const index = Number(request.url.slice(1));
    requests.push(index);
    response.writeHead(200, { "Content-Type": types[index] });
    response.end(index < 2 ? "<html>Please sign in</html>" : '{"message":"verification required"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-content-type-"));
  try {
    for (const [index] of types.entries()) {
      await assert.rejects(downloadMediaItem({
        kind: "video", postId: `html-${index}`, mediaIndex: 1, extension: ".mp4",
        sourceUrl: `http://127.0.0.1:${server.address().port}/${index}`,
      }, root, { hashes: {} }), (error) => {
        assert.equal(error.code, "unexpected-media-content");
        assert.match(error.message, /网页或 JSON，而非媒体文件/);
        return true;
      });
    }
    assert.deepEqual(requests, [0, 1, 2, 3]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("download errors expose safe nested network codes, retain HTTP failures, and omit transport secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-network-error-"));
  try {
    await Promise.all([false, true].map(async (aggregate) => {
      const transport = Object.assign(new Error("https://cdn.example/file?signature=SECRET Cookie: SECRET"), { code: "ECONNRESET", headers: { Cookie: "SECRET" } });
      const cause = aggregate ? new AggregateError([
        transport, new Error("SECRET", { cause: Object.assign(new Error("SECRET"), { code: "ETIMEDOUT" }) }),
      ], "SECRET") : transport;
      const networkFailure = new TypeError("fetch failed https://cdn.example/?signature=SECRET", { cause });
      const item = {
        kind: "image", postId: aggregate ? "aggregate" : "direct", mediaIndex: 1, extension: ".jpg",
        sourceUrl: "https://cdn.example/gone?signature=SECRET", sourceUrls: ["https://cdn.example/reset?signature=SECRET"],
      };
      let attempts = 0;
      await assert.rejects(downloadMediaItem(item, root, { hashes: {} }, { fetchMedia: async (url) => {
        if (url.includes("/gone")) return new Response(null, { status: 404 });
        attempts += 1;
        throw networkFailure;
      } }), (error) => {
        assert.match(error.message, /连接被重置（ECONNRESET）/);
        assert.match(error.message, /HTTP 404/);
        assert.equal(error.cause.code, "ECONNRESET");
        assert.equal(error.code, "ECONNRESET");
        if (aggregate) assert.match(error.message, /连接超时（ETIMEDOUT）/);
        assert.doesNotMatch(inspect(error, { depth: 10 }), /SECRET|signature|Cookie|cdn\.example/);
        return true;
      });
      assert.equal(attempts, 3);
    }));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("image requests carry mediaKind and Range; a 200 retry replaces partial bytes while 206 resumes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-range-retry-"));
  try {
    for (const status of [200, 206]) {
      const requests = [];
      const item = { kind: "image", postId: `resume-${status}`, mediaIndex: 1, extension: ".jpg",
        sourceUrl: "https://cdn.example/image.jpg", referer: "https://www.tiktok.com/" };
      const result = await downloadMediaItem(item, root, { hashes: {} }, { fetchMedia: async (url, options) => {
        requests.push(options);
        assert.equal(options.mediaKind, "image");
        assert.equal(options.headers.Referer, item.referer);
        assert.ok(options.signal instanceof AbortSignal);
        if (requests.length === 1) return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("old-"));
            // Disconnect after the fixture's partial bytes reach disk, not
            // after a wall-clock guess. Parallel browser tests can delay file
            // opening beyond 40 ms and legitimately leave nothing to resume.
            void (async () => {
              const deadline = Date.now() + 5_000;
              while (Date.now() < deadline) {
                for (const name of await readdir(root)) {
                  if (!name.startsWith(".media-tracker-") || !name.endsWith(".part")) continue;
                  if ((await stat(path.join(root, name))).size === 4) {
                    controller.error(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
                    return;
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              throw new Error("Fixture partial bytes were not written before disconnect");
            })().catch((error) => controller.error(error));
          },
        }), { headers: { "Content-Type": "image/jpeg" } });
        return status === 200
          ? new Response("new-complete-image", { headers: { "Content-Type": "image/jpeg" } })
          : new Response("complete-image", { status: 206, headers: { "Content-Type": "image/jpeg", "Content-Range": "bytes 4-17/18" } });
      } });
      assert.equal(requests.length, 2);
      assert.equal(requests[0].headers.Range, undefined);
      assert.equal(requests[1].headers.Range, "bytes=4-");
      const expected = status === 200 ? "new-complete-image" : "old-complete-image";
      assert.equal(await readFile(path.join(root, result.relativePath), "utf8"), expected);
      assert.equal(result.bytes, Buffer.byteLength(expected));
    }
    assert.equal((await readdir(root)).some((name) => name.endsWith(".part")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download cancellation keeps AbortError without retrying or wrapping it as a network failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-download-cancel-"));
  try {
    const cancellation = new DOMException("cancelled", "AbortError");
    let attempts = 0;
    await assert.rejects(downloadMediaItem({
      kind: "image", postId: "cancel", mediaIndex: 1, sourceUrl: "https://cdn.example/image.jpg", extension: ".jpg",
    }, root, { hashes: {} }, { fetchMedia: async () => { attempts += 1; throw cancellation; } }), (error) => {
      assert.equal(error, cancellation);
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("blocked image destinations and oversized images fail once with a safe useful explanation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-image-policy-"));
  try {
    for (const [code, text] of [["tiktok-image-redirect-blocked", /允许的媒体域名/], ["tiktok-image-too-large", /64 MiB/]]) {
      let calls = 0;
      await assert.rejects(downloadMediaItem({ kind: "image", postId: "policy", mediaIndex: 1,
        sourceUrl: "https://p16.tiktokcdn-us.com/image?sig=SECRET", sourceUrls: ["https://p19.tiktokcdn-us.com/image?sig=SECRET"] },
      root, { hashes: {} }, { fetchMedia: async () => {
        calls += 1;
        throw Object.assign(new Error("Raw diagnostic SECRET"), { code });
      } }), (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, text);
        assert.doesNotMatch(inspect(error, { depth: 10 }), /SECRET|sig=/);
        return true;
      });
      assert.equal(calls, 1, "A policy refusal must not cause repeated network attempts");
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("aborting after fetch returns interrupts a body that ignores signals and removes its partial file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-pipeline-cancel-"));
  const controller = new AbortController();
  let cancelledBody = false;
  let receivedBytes = false;
  let finishReceived;
  const received = new Promise((resolve) => { finishReceived = resolve; });
  let attempts = 0;
  let request;
  let bodyController;
  let watchdog;
  try {
    request = downloadMediaItem({
      kind: "image", postId: "body-cancel", mediaIndex: 1,
      sourceUrl: "https://cdn.example/buffered-image.jpg", extension: ".jpg",
    }, root, { hashes: {} }, {
      signal: controller.signal,
      onProgress(bytes) { receivedBytes = bytes > 0; finishReceived(); },
      fetchMedia: async () => {
        attempts += 1;
        // Like a browser-buffered response, this stream never subscribes to the request signal.
        return new Response(new ReadableStream({
          start(stream) { bodyController = stream; stream.enqueue(new Uint8Array(128 * 1024)); },
          cancel() { cancelledBody = true; },
        }), { headers: { "Content-Type": "image/jpeg" } });
      },
    });
    const rejected = assert.rejects(request, { name: "AbortError" });
    await received;
    controller.abort();
    await Promise.race([rejected, new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error("Pipeline did not stop after cancellation")), 2_000);
    })]);
    assert.equal(receivedBytes, true);
    assert.equal(cancelledBody, true);
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    try { bodyController?.error(new DOMException("fixture cleanup", "AbortError")); } catch {}
    await request?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the actual response format selects the shared folder and extension, including GIF and non-MP4 video", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-format-routing-"));
  try {
    const formats = [
      ["image/gif", "Image", ".gif", "image"],
      ["video/mp4", "Video", ".mp4", "video"],
      ["video/webm", "Video", ".webm", "video"],
      ["video/quicktime", "Video", ".mov", "video"],
      ["image/jpeg", "Image", ".jpg", "image"],
    ];
    for (const [contentType, folder, extension, kind] of formats) {
      const result = await downloadMediaItem({ kind: "gif", postId: contentType, mediaIndex: 1,
        extension: ".mp4", sourceUrl: "https://unused.example/fixture" }, root, { hashes: {} }, {
        fetchMedia: async () => new Response(`distinct-fixture-${contentType}`, { headers: { "Content-Type": contentType } }),
      });
      assert.equal(result.kind, kind);
      assert.equal(path.dirname(result.relativePath), folder);
      assert.equal(path.extname(result.relativePath), extension);
      assert.match(path.basename(result.relativePath), /^\d{8}_.+_\d{2,}_[a-f0-9]{16,64}\.[a-z0-9]+$/);
    }
    await assert.rejects(stat(path.join(root, "gif")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
