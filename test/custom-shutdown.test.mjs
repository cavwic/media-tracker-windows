import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { exportCustomSession, runCustomSourceWorker } from "../lib/custom-sync.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "custom-shutdown-test-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const platform = { id: "custom-fixture", custom: true, homepageUrl: "https://fixture.invalid/" };
  const profileDirectory = path.join(dataRoot, "browser-profiles", platform.id, "fixture-login");
  await mkdir(profileDirectory, { recursive: true });
  const sentinel = path.join(profileDirectory, "synthetic-login-sentinel.txt");
  await writeFile(sentinel, "Keep this login profile untouched.");
  return { dataRoot, platform, profileDirectory, sentinel,
    linkedAccount: { platformId: platform.id, profileDirectory, loginStatus: "verified" } };
}

test("abort during session launch closes only its newly owned context before reading cookies", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const controller = new AbortController();
  const launched = deferred();
  const releaseLaunch = deferred();
  let closed = 0;
  let cookieReads = 0;
  const context = { close: async () => { closed++; }, cookies: async () => { cookieReads++; return []; } };
  const exporting = exportCustomSession({ ...setup, signal: controller.signal,
    launchContext: async () => { launched.resolve(); return releaseLaunch.promise; } });
  const rejected = assert.rejects(exporting, { name: "AbortError" });
  await launched.promise;
  controller.abort();
  releaseLaunch.resolve(context);
  await rejected;
  assert.equal(closed, 1);
  assert.equal(cookieReads, 0, "a shutdown-aborted context cannot export session credentials");
  assert.equal(await readFile(setup.sentinel, "utf8"), "Keep this login profile untouched.");
  assert.deepEqual(await readdir(setup.dataRoot), ["browser-profiles"]);
});

test("abort while registering session listener still closes the context without reading cookies or writing credentials", { timeout: 5_000 }, async (t) => {
  const setup = await fixture(t);
  const controller = new AbortController();
  let closed = 0;
  let cookieReads = 0;
  let removed = 0;
  // Model an abort delivered exactly while ownership/listener registration is
  // transferring. The event was missed, but the post-registration state check
  // must still stop before context.cookies(). No real browser is launched.
  const signal = { get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener() { controller.abort(); }, removeEventListener() { removed++; } };
  await assert.rejects(exportCustomSession({ ...setup, signal,
    launchContext: async () => ({ close: async () => { closed++; }, cookies: async () => { cookieReads++; return []; } }),
  }), { name: "AbortError" });
  assert.equal(closed, 1);
  assert.equal(cookieReads, 0);
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(setup.dataRoot), ["browser-profiles"]);
});

test("abort during executable access prevents spawning a custom source worker", { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  // access() yields before spawning. Abort in that gap; process.execPath is a
  // known local file, not the user's Python runtime or any platform resource.
  // Without the post-await guard Node would launch with Python-only flags and
  // produce engine-request-failed instead of the cancellation result.
  const worker = runCustomSourceWorker({}, { signal: controller.signal, pythonPath: process.execPath,
    workerPath: path.join(import.meta.dirname, "fixtures", "never-run-source-worker.py"), timeoutMs: 2_000 });
  queueMicrotask(() => controller.abort());
  await assert.rejects(worker, { name: "AbortError" });
});

test("abort during worker listener registration stops its exact owned child without waiting for metadata timeout", { timeout: 10_000 }, async (t) => {
  const pythonPath = path.resolve(import.meta.dirname, "..", ".runtime", "sources-python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  try { await access(pythonPath); }
  catch { t.skip("Project source engines are not installed"); return; }
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = { get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener() { added++; controller.abort(); }, removeEventListener() { removed++; } };
  const start = Date.now();
  await assert.rejects(runCustomSourceWorker({}, { signal, pythonPath,
    workerPath: path.join(import.meta.dirname, "fixtures", "custom-source-worker-stall.py"), timeoutMs: 6_000,
  }), { name: "AbortError" });
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.ok(Date.now() - start < 5_000, "post-listener cancellation must not wait for metadata timeout");
});
