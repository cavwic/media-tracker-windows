import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { access, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCustomMediaFetch, CustomDiscoveryError, discoverCustomMedia, probeCustomMedia,
  exportCustomSession, publicSourceAddress, runCustomSourceWorker, sourceUrl } from "../lib/custom-sync.mjs";

const platform = { id: "custom-fixture", custom: true, engine: "auto", homepageUrl: "https://site.example/" };
const account = { profileUrl: "https://site.example/creator" };
const record = { type: "media", key: "yt-dlp:test:123_1", postId: "123", index: 1, kind: "image", extension: ".jpg",
  url: "https://cdn.example/image.jpg?signature=secret", postUrl: "https://site.example/posts/123", createdAt: "2026-01-01T00:00:00Z" };
const coverageResult = (overrides = {}) => ({ engine: "yt-dlp", scope: "account", complete: true, unsupported: 0,
  coverageVersion: 1, coverageComplete: true, coverageReasons: [], unresolvedPosts: [], mediaCount: 1, knownSkipped: 0,
  postCount: 1, coveredPosts: [{ postId: "123", postUrl: record.postUrl, createdAt: record.createdAt, mediaComplete: true, expectedAttachmentCount: 1, observedCount: 1 }], ...overrides });

function fixture(overrides = {}) {
  const calls = { exports: 0, workers: 0, disposed: 0 };
  return { calls, options: { platform, account,
    sessionExporter: async () => { calls.exports++; return { cookies: [], cookieFile: null, dispose: async () => { calls.disposed++; } }; },
    runWorker: async () => { calls.workers++; return { records: [record], result: coverageResult() }; },
    fetchFactory: () => () => {}, ...overrides } };
}

test("disabled/custom target mismatch is rejected before any browser or worker access", async () => {
  for (const overrides of [{ platform: { ...platform, engine: "none" } }, { account: { profileUrl: "https://another.example/user" } }]) {
    const { options, calls } = fixture(overrides);
    await assert.rejects(discoverCustomMedia(options), CustomDiscoveryError);
    assert.deepEqual(calls, { exports: 0, workers: 0, disposed: 0 });
  }
});

test("normalized custom media has stable IDs across signed URL changes and no credential metadata", async () => {
  const first = fixture();
  const result = await discoverCustomMedia(first.options);
  assert.equal(result.complete, true);
  assert.equal(result.media[0].logicalKey.startsWith("custom:"), true);
  assert.equal(result.media[0].postId, "123");
  assert.equal(result.media[0].postUrl, "https://site.example/posts/123");
  assert.equal(result.capability.incremental, "media-id");
  assert.equal(first.calls.disposed, 1);
  const second = fixture({ runWorker: async () => ({ records: [{ ...record, url: "https://cdn.example/image.jpg?signature=changed", cookies: "must not persist" }],
    result: coverageResult() }) });
  const updated = await discoverCustomMedia(second.options);
  assert.equal(result.media[0].logicalKey, updated.media[0].logicalKey);
  assert.equal(JSON.stringify(updated).includes("must not persist"), false);
});

test("probe is bounded metadata only and never declares full history complete", async () => {
  let input;
  const { options } = fixture({ runWorker: async (payload) => { input = payload; return { records: [record], result: { scope: "account", engine: "yt-dlp", complete: true } }; } });
  const result = await probeCustomMedia(options);
  assert.equal(input.maxItems, 5);
  assert.equal(result.ok, true);
  assert.equal(result.capability.images, true);
  assert.equal(result.capability.historyComplete, false);
  assert.equal(result.mediaCount, 1);
});

test("generic single-page and budget-truncated sources never count as account completion", async () => {
  for (const detail of [{ scope: "single", complete: true }, { scope: "unknown", complete: true }, { scope: "account", complete: false }]) {
    const { options } = fixture({ runWorker: async () => ({ records: [record], result: { engine: "yt-dlp", ...detail } }) });
    assert.equal((await discoverCustomMedia(options)).complete, false);
  }
});

test("unsupported/empty/failed metadata does not fake a successful empty sync and always disposes session", async () => {
  for (const runWorker of [async () => ({ records: [], result: {} }), async () => { throw new CustomDiscoveryError("engine-request-failed"); }]) {
    const { options, calls } = fixture({ runWorker });
    await assert.rejects(discoverCustomMedia(options), CustomDiscoveryError);
    assert.equal(calls.disposed, 1);
  }
});

test("successful media keys reach worker; verified old-only account scan can finish with zero new media", async () => {
  let input;
  const knownMediaKey = "custom:" + "1".repeat(64);
  const { options } = fixture({ knownPosts: { "yt-dlp:123": true }, knownMediaKeys: [knownMediaKey],
    runWorker: async (payload) => { input = payload; return { records: [], result: coverageResult({ mediaCount: 0, knownSkipped: 1 }) }; } });
  const result = await discoverCustomMedia(options);
  assert.deepEqual(input.knownMediaKeys, [knownMediaKey]);
  assert.equal(input.knownPosts, undefined);
  assert.equal(result.complete, true);
  assert.equal(result.media.length, 0);
  assert.equal(result.posts[0].mediaComplete, true, "Known-only scans must clear previously unresolved post metadata");
});

test("custom known-only but incomplete album metadata is retained without pretending the account is empty", async () => {
  const knownMediaKey = "custom:" + "1".repeat(64);
  const { options } = fixture({ knownMediaKeys: [knownMediaKey], runWorker: async () => ({ records: [], result: coverageResult({
    mediaCount: 0, knownSkipped: 1, complete: false, coverageComplete: false, coverageReasons: ["attachment-count-mismatch"],
    coveredPosts: [{ postId: "123", postUrl: record.postUrl, mediaComplete: false, expectedAttachmentCount: 2, observedCount: 1 }],
    unresolvedPosts: [{ postId: "123", postUrl: record.postUrl }],
  }) }) });
  const result = await discoverCustomMedia(options);
  assert.equal(result.complete, false);
  assert.equal(result.media.length, 0);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.unresolvedMedia[0].postId, "123");
});

test("custom completion requires coverage proof and zero unparsed/truncated metadata, but retains valid media", async () => {
  for (const evidence of [
    { coverageVersion: undefined }, { coverageComplete: false }, { mediaCount: 2 },
    { unsupported: 1 }, { coverageReasons: ["next-page-unconfirmed"] }, { unresolvedPosts: undefined },
  ]) {
    const { options } = fixture({ runWorker: async () => ({ records: [record], result: coverageResult(evidence) }) });
    const result = await discoverCustomMedia(options);
    assert.equal(result.complete, false);
    assert.equal(result.completionReason, null);
    assert.equal(result.media.length, 1);
    assert.ok(result.incompleteReason);
  }
});

test("custom missing album slots remain unresolved with a safe post URL even when the worker claims completion", async () => {
  const { options } = fixture({ runWorker: async () => ({ records: [record], result: coverageResult({
    unresolvedPosts: [{ postId: "123", postUrl: "https://site.example/posts/123", expectedCount: 2, observedCount: 1 }],
  }) }) });
  const result = await discoverCustomMedia(options);
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.unresolvedMedia[0].postKey, "yt-dlp:123");
  assert.equal(result.unresolvedMedia[0].postUrl, "https://site.example/posts/123");
  assert.equal(result.media.length, 1);
});

test("custom cannot accept claimed full album coverage without matching emitted and known-skipped counts", async () => {
  for (const coveredPosts of [
    [{ postId: "123", mediaComplete: true, expectedAttachmentCount: 3, observedCount: 1 }],
    [{ postId: "123", mediaComplete: true, expectedAttachmentCount: 3, observedCount: 3 }],
    [{ postId: "123", mediaComplete: true, expectedAttachmentCount: 1, observedCount: 1 },
      { postId: "456", mediaComplete: true, expectedAttachmentCount: 1, observedCount: 1 }],
  ]) {
    const { options } = fixture({ runWorker: async () => ({ records: [record], result: coverageResult({ coveredPosts, postCount: coveredPosts.length }) }) });
    const result = await discoverCustomMedia(options);
    assert.equal(result.complete, false);
    assert.equal(result.posts.find((post) => post.postId === "123").mediaComplete, false);
    assert.equal(result.media.length, 1);
    assert.ok(result.unresolvedMedia.length);
  }
});

test("custom cannot shrink a previously unresolved album's historical expected count", async () => {
  const { options } = fixture({ knownPostCoverage: { "yt-dlp:123": { postId: "123", postUrl: record.postUrl, mediaExpectedCount: 2 } } });
  const result = await discoverCustomMedia(options);
  assert.equal(result.complete, false);
  assert.equal(result.posts[0].mediaComplete, false);
  assert.equal(result.posts[0].mediaExpectedCount, 2);
  assert.equal(result.unresolvedMedia[0].postKey, "yt-dlp:123");
  assert.equal(result.media.length, 1);
});

test("session export uses only tool profile cookies for its own site and removes temporary credentials", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "custom-session-test-"));
  const profileDirectory = path.join(dataRoot, "browser-profiles", platform.id, "fixture-account");
  await mkdir(profileDirectory, { recursive: true });
  let closed = 0;
  try {
    const session = await exportCustomSession({ platform, dataRoot, linkedAccount: { platformId: platform.id, profileDirectory, loginStatus: "verified" },
      launchContext: async (_profile, options) => {
        assert.equal(options.headless, true);
        return { close: async () => { closed++; }, cookies: async () => [
          { name: "session", value: "private-fixture", domain: ".site.example", path: "/", secure: true, expires: -1 },
          { name: "oauth", value: "do-not-export", domain: ".accounts.example", path: "/", expires: -1 },
        ] };
      } });
    assert.equal(closed, 1);
    assert.equal(session.cookies.length, 1);
    const data = await readFile(session.cookieFile, "utf8");
    assert.match(data, /private-fixture/);
    assert.equal(data.includes("do-not-export"), false);
    await session.dispose();
    await assert.rejects(access(session.cookieFile), { code: "ENOENT" });
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("session export refuses a linked source-sessions parent without writing credentials outside dataRoot", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "custom-session-link-test-"));
  const dataRoot = path.join(sandbox, "data");
  const outside = path.join(sandbox, "outside");
  const profileDirectory = path.join(dataRoot, "browser-profiles", platform.id, "fixture-account");
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(dataRoot, "source-sessions"), process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(exportCustomSession({ platform, dataRoot,
      linkedAccount: { platformId: platform.id, profileDirectory, loginStatus: "verified" },
      launchContext: async () => ({ close: async () => {}, cookies: async () => [] }),
    }), (error) => error.code === "profile-invalid");
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test("public HTTPS validator excludes local, reserved, transition and credential-bearing URLs", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.168.1.1", "198.18.1.1", "203.0.113.10", "224.0.0.1", "::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:0000::1", "2002:7f00:1::1"]) assert.equal(publicSourceAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(publicSourceAddress(address), true, address);
  for (const value of ["http://site.example/a", "file:///tmp/a", "https://127.0.0.1/a", "https://u:password@site.example/a", "https://site.example:8443/a", "https://localhost/a"]) assert.throws(() => sourceUrl(value), CustomDiscoveryError);
});

function requestsFixture(responses) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url: url.href, options });
    const emitter = new EventEmitter();
    emitter.setTimeout = () => emitter;
    emitter.destroy = (error) => emitter.emit("error", error);
    emitter.end = () => {
      const next = responses.shift();
      const response = Readable.from([Buffer.from(next.body || "image")]);
      response.statusCode = next.status || 200;
      response.headers = next.headers || { "content-type": "image/jpeg" };
      queueMicrotask(() => callback(response));
    };
    return emitter;
  };
  return { calls, request };
}

test("custom media transport strips credentials on CDN redirect, pins DNS, and preserves Range", async () => {
  const { calls, request } = requestsFixture([
    { status: 302, headers: { location: "https://cdn.example/a.jpg" } },
    { status: 206, headers: { "content-type": "image/jpeg", "content-range": "bytes 10-14/15" } },
  ]);
  const transport = createCustomMediaFetch({ homepageUrl: platform.homepageUrl, request,
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }], cookies: [
      { name: "session", value: "private", domain: ".site.example", path: "/", secure: true, expires: -1 },
      { name: "wrong-path", value: "must-not-send", domain: ".site.example", path: "/private", expires: -1 },
    ] });
  const response = await transport("https://site.example/a.jpg", { headers: { Range: "bytes=10-", Authorization: "must-not-send", Cookie: "must-not-send" }, mediaKind: "image" });
  assert.equal(await response.text(), "image");
  assert.equal(calls[0].options.headers.Cookie, "session=private");
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Range, "bytes=10-");
  let resolved;
  calls[1].options.lookup("cdn.example", {}, (_error, address) => { resolved = address; });
  assert.equal(resolved, "8.8.8.8");
});

test("custom media transport blocks private DNS answers and private redirect without issuing unsafe request", async () => {
  for (const responses of [[], [{ status: 302, headers: { location: "https://127.0.0.1/a" } }]]) {
    const { calls, request } = requestsFixture(responses);
    const privateDns = responses.length === 0;
    const transport = createCustomMediaFetch({ homepageUrl: platform.homepageUrl, request,
      dnsLookup: async () => [{ address: privateDns ? "10.1.2.3" : "8.8.8.8", family: 4 }] });
    await assert.rejects(transport("https://site.example/a.jpg"), (error) => error.code === "unsafe-url");
    assert.equal(calls.length, privateDns ? 0 : 1);
  }
});

test("custom media transport rejects HTML and video thumbnails instead of treating them as MP4", async () => {
  for (const mime of ["text/html", "image/jpeg"]) {
    const { request } = requestsFixture([{ headers: { "content-type": mime } }]);
    const transport = createCustomMediaFetch({ homepageUrl: platform.homepageUrl, request,
      dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    await assert.rejects(transport("https://site.example/a.mp4", { mediaKind: "video" }), (error) => error.code === "unexpected-media-content");
  }
});

test("installed public source worker reports yt-dlp without requiring gallery-dl", async (context) => {
  const python = path.resolve(".runtime/sources-python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  try { await access(python); } catch { context.skip("Project source engines are not installed"); return; }
  const { result } = await runCustomSourceWorker({ command: "versions" }, { timeoutMs: 10000 });
  assert.equal(result["gallery-dl"], undefined);
  assert.equal(result["yt-dlp"], "2026.8.19");
  await assert.rejects(runCustomSourceWorker({ engine: "gallery-dl" }, { pythonPath: "never-launch-this.exe" }),
    (error) => error.code === "public-engine-not-integrated");
});

test("source worker error, invalid output and abort stop only their own child before settling", async (context) => {
  const pythonPath = path.resolve(".runtime/sources-python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  try { await access(pythonPath); } catch { context.skip("Project source engines are not installed"); return; }
  const workerPath = path.resolve("test/fixtures/custom-source-worker-stall.py");
  for (const mode of ["error-hang", "invalid-output"]) {
    const started = Date.now();
    await assert.rejects(runCustomSourceWorker({ mode }, { pythonPath, workerPath, timeoutMs: 10000 }), (error) => {
      assert.equal(error.message.includes("private-fixture"), false);
      return error.code === (mode === "error-hang" ? "unsupported-url" : "engine-request-failed");
    });
    assert.ok(Date.now() - started < 5000, "An error line must stop the worker immediately, not wait for timeout");
  }
  const controller = new AbortController();
  const running = runCustomSourceWorker({}, { pythonPath, workerPath, signal: controller.signal, timeoutMs: 10000 });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { name: "AbortError" });
});

test("oversized worker input is explicitly rejected before spawn or executable lookup", async () => {
  await assert.rejects(runCustomSourceWorker({ padding: "x".repeat(12 * 1024 * 1024) }, {
    pythonPath: path.resolve("never-launch-this-missing-python.exe"),
  }), (error) => error.code === "metadata-too-large");
});
