import test from "node:test";
import assert from "node:assert/strict";
import { inspectRunningTracker, findRunningTracker } from "../lib/running-tracker.mjs";

const OWN_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const current = (overrides = {}) => ({ id: "builtin-chromium", windowLifecycleVersion: 1, instanceKey: OWN_KEY,
  shuttingDown: false, windowOpen: true, ...overrides });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

test("status inspection reads the current runtime in one local request and supplies a bounded AbortSignal", async () => {
  const calls = [];
  const runtime = current();
  const result = await inspectRunningTracker(4178, { timeoutMs: 321, fetch: async (url, options) => {
    calls.push({ url, options });
    return json(runtime);
  } });
  assert.deepEqual(result, runtime);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), "http://127.0.0.1:4178/api/runtime/status");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.signal.aborted, false);
});

test("only non-OK, malformed or non-tracker status responses fall back to the legacy state endpoint", async (t) => {
  for (const [description, statusResponse] of [
    ["not found", () => json({ error: "Unsupported status route" }, 404)],
    ["HTTP failure", () => json({ error: "Fixture failure" }, 500)],
    ["invalid JSON", () => new Response("not JSON", { status: 200 })],
    ["non tracker", () => json({ id: "unrelated-app" })],
    ["missing runtime id", () => json({ windowOpen: true })],
  ]) {
    await t.test(description, async () => {
      const calls = [];
      const legacy = { id: "builtin-chromium", label: "Legacy fixture" };
      const result = await inspectRunningTracker(43178, { fetch: async (url, options) => {
        calls.push(String(url));
        assert.ok(options.signal instanceof AbortSignal);
        return calls.length === 1 ? statusResponse() : json({ runtime: legacy, persons: [] });
      } });
      assert.deepEqual(result, legacy);
      assert.deepEqual(calls, ["http://127.0.0.1:43178/api/runtime/status", "http://127.0.0.1:43178/api/state"]);
    });
  }
});

test("connection, timeout and cancellation exceptions never initiate a second potentially timed-out probe", async () => {
  for (const error of [new Error("ECONNREFUSED"), new DOMException("Fixture timeout", "TimeoutError"),
    new DOMException("Fixture aborted", "AbortError")]) {
    let requests = 0;
    const result = await inspectRunningTracker(43179, { timeoutMs: 25, fetch: async (_url, options) => {
      requests++;
      assert.ok(options.signal instanceof AbortSignal);
      throw error;
    } });
    assert.equal(result, false);
    assert.equal(requests, 1);
  }
});

test("a non-OK streaming status response is cancelled before compatibility fallback returns", async () => {
  let cancelled = false;
  let requests = 0;
  const runtime = { id: "builtin-chromium", label: "Legacy response fixture" };
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("Fixture response not yet ended")); },
    cancel() { cancelled = true; },
  });
  const result = await inspectRunningTracker(43181, { fetch: async () => {
    if (++requests === 1) return new Response(body, { status: 404 });
    assert.equal(cancelled, true, "a finished probe cannot leave an earlier HTTP body stream behind");
    return json({ runtime });
  } });
  assert.equal(cancelled, true);
  assert.deepEqual(result, runtime);
});

test("failed, malformed and unrelated legacy responses are safely ignored after exactly one fallback", async () => {
  for (const response of [() => json({ runtime: { id: "other-app" } }), () => json({}),
    () => json({ error: "Unavailable" }, 503), () => new Response("bad JSON"),
    () => { throw new Error("Fallback connection reset"); }]) {
    let requests = 0;
    const result = await inspectRunningTracker(43180, { fetch: async () => {
      requests++;
      return requests === 1 ? json({}, 404) : response();
    } });
    assert.equal(result, false);
    assert.equal(requests, 2);
  }
});

test("host and runtime ID options remain respected without contacting external services", async () => {
  const calls = [];
  const runtime = { id: "fixture-runtime", instanceKey: OWN_KEY };
  const result = await inspectRunningTracker(12345, { host: "localhost", runtimeId: "fixture-runtime", fetch: async (url) => {
    calls.push(String(url)); return json(runtime);
  } });
  assert.deepEqual(result, runtime);
  assert.deepEqual(calls, ["http://localhost:12345/api/runtime/status"]);
});

test("candidate ports start in parallel, preserve configured preference and wait for every probe before returning", async () => {
  const ports = [4178, 43178, 43179];
  const requests = new Map(ports.map((port) => [port, deferred()]));
  const calls = [];
  let settled = false;
  const searching = findRunningTracker(ports, { instanceKey: OWN_KEY, fetch: async (input, options) => {
    const url = new URL(input);
    const port = Number(url.port);
    calls.push({ port, pathname: url.pathname });
    assert.ok(options.signal instanceof AbortSignal);
    return requests.get(port).promise;
  } }).then((result) => { settled = true; return result; });
  await tick();
  assert.deepEqual(calls, ports.map((port) => ({ port, pathname: "/api/runtime/status" })), "all initial requests must start before any resolves");
  requests.get(43178).resolve(json(current({ windowOpen: false })));
  await tick();
  assert.equal(settled, false, "a later candidate cannot return early");
  const preferred = current({ windowOpen: true });
  requests.get(4178).resolve(json(preferred));
  await tick();
  assert.equal(settled, false, "even an earlier matching owner cannot leave the last probe pending");
  requests.get(43179).reject(new Error("Fixture port unavailable"));
  assert.deepEqual(await searching, { port: 4178, runtime: preferred });
});

test("a fallback request is included in the all-settled barrier even when another port already matches", async () => {
  const legacyState = deferred();
  const calls = [];
  const own = current();
  let settled = false;
  const searching = findRunningTracker([4178, 43178], { instanceKey: OWN_KEY, fetch: async (input) => {
    const url = new URL(input);
    calls.push({ port: Number(url.port), pathname: url.pathname });
    if (Number(url.port) === 4178) return json(own);
    return url.pathname === "/api/runtime/status" ? json({}, 404) : legacyState.promise;
  } }).then((result) => { settled = true; return result; });
  await tick();
  assert.ok(calls.some((call) => call.port === 43178 && call.pathname === "/api/state"));
  assert.equal(settled, false);
  legacyState.resolve(json({ runtime: { id: "builtin-chromium", label: "Legacy owner" } }));
  assert.deepEqual(await searching, { port: 4178, runtime: own });
});

test("foreign data-directory owners are skipped, but a matching closing owner is returned for explicit refusal", async () => {
  const closing = current({ shuttingDown: true, windowOpen: false });
  const result = await findRunningTracker([4178, 43178], { instanceKey: OWN_KEY, fetch: async (input) => {
    return json(Number(new URL(input).port) === 4178 ? current({ instanceKey: OTHER_KEY }) : closing);
  } });
  assert.deepEqual(result, { port: 43178, runtime: closing });
});

test("legacy owners without a directory key retain candidate order and one port failure does not hide them", async () => {
  const legacy = { id: "builtin-chromium", label: "Old service needing manual exit" };
  const result = await findRunningTracker([4178, 43178, 43179], { instanceKey: OWN_KEY, fetch: async (input) => {
    const url = new URL(input);
    if (Number(url.port) === 4178) throw new Error("First fixture port refused");
    if (Number(url.port) === 43179) return json(current());
    return url.pathname === "/api/runtime/status" ? json({}, 404) : json({ runtime: legacy });
  } });
  assert.deepEqual(result, { port: 43178, runtime: legacy });
});

test("no matching owner and an empty candidate list return false without unhandled probe rejections", async () => {
  assert.equal(await findRunningTracker([], { instanceKey: OWN_KEY, fetch: async () => { throw new Error("Empty list cannot request"); } }), false);
  const result = await findRunningTracker([4178, 43178], { instanceKey: OWN_KEY, fetch: async (input) => {
    if (Number(new URL(input).port) === 4178) return json(current({ instanceKey: OTHER_KEY }));
    throw new Error("Fixture unavailable");
  } });
  assert.equal(result, false);
});
