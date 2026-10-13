import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { deduplicatePerson, DedupManager } from "../lib/similarity-dedup.mjs";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";
import { SyncManager } from "../lib/sync-engine.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-local-similarity-"));
  t.after(async () => { clearPersonMediaIndexCache(); await rm(root, { recursive: true, force: true }); });
  const person = { id: "person-a", name: "A", folderPath: path.join(root, "A"), platforms: [] };
  const index = await openPersonMediaIndex(person, { create: true });
  async function add(content, accountId = "x-a") {
    const buffer = Buffer.from(content), sha256 = createHash("sha256").update(buffer).digest("hex");
    const partialPath = path.join(person.folderPath, `.${sha256}.part`);
    await writeFile(partialPath, buffer);
    await index.commitDownloaded({ partialPath, sha256, bytes: buffer.length, extension: ".jpg", mediaKind: "image",
      source: { platformId: "fixture", accountId, logicalKey: `${accountId}:${sha256}`, postId: accountId, createdAt: "2026-10-01T10:00:00Z" } });
    return sha256;
  }
  // These deterministic injected fingerprints are only logic fixtures, not a
  // claim about the real visual decoder's acceptance thresholds.
  const inspect = async (filePath) => ({ version: 1, kind: "image", complete: true,
    fixtureBytes: (await readFile(filePath)).length, width: 100, height: 100 });
  const candidate = () => true;
  const compare = () => ({ decision: "merge", reason: "fixture" });
  const prefer = (a, b) => ({ preferred: a.fixtureBytes >= b.fixtureBytes ? "left" : "right", reason: "fixture dominance" });
  const verify = async () => ({ decision: "merge", reason: "fixture full-content proof" });
  return { root, person, index, add, inspect, candidate, compare, prefer, verify };
}

test("manual local dedup preserves all sources, old ids, archives and cached fingerprints without network", async (t) => {
  const env = await setup(t);
  const low = await env.add("fixture-low", "one"), high = await env.add("fixture-high-quality", "two");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("No external requests allowed in local dedup"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  let inspected = 0;
  const inspect = async (...args) => { inspected++; return env.inspect(...args); };
  const report = await deduplicatePerson(env.person, env.index, { ...env, inspect });
  assert.equal(report.merged, 1);
  assert.equal(report.archivedBytes, Buffer.byteLength("fixture-low"));
  assert.equal(env.index.list().total, 1);
  assert.equal(env.index.get(low).mediaId, high);
  assert.equal(await env.index.has(low), true);
  assert.deepEqual(env.index.sources(high).map((s) => s.accountId).sort(), ["one", "two"]);
  assert.equal((await readdir(path.join(env.person.folderPath, "Image"))).length, 1);
  assert.equal(inspected, 2);
  await deduplicatePerson(env.person, env.index, { ...env, inspect });
  assert.equal(inspected, 2, "unchanged canonical file should reuse its locally saved fingerprint");
});

test("uncertain visual or quality decisions are kept, not archived", async (t) => {
  const env = await setup(t);
  await env.add("first"); await env.add("second");
  const report = await deduplicatePerson(env.person, env.index, { ...env, prefer: () => ({ preferred: null }) });
  assert.equal(report.merged, 0);
  assert.equal(report.review, 1);
  assert.equal(env.index.list().total, 2);
  const report2 = await deduplicatePerson(env.person, env.index, { ...env, compare: () => ({ decision: "review", reason: "different soundtrack" }) });
  assert.equal(report2.merged, 0);
  assert.equal(report2.review, 1);
});

test("a bounded fingerprint cache is reported as retained, not a damaged media or missing download", async (t) => {
  const env = await setup(t);
  const id = await env.add("valid-media-fixture");
  const report = await deduplicatePerson(env.person, env.index, { ...env,
    inspect: async (...args) => ({ ...await env.inspect(...args), complete: false, reason: "fingerprint-size-limit" }) });
  assert.equal(report.merged, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.review, 1);
  assert.match(report.reviewItems[0].reason, /已完整解码.*指纹缓存上限.*并非下载缺失/);
  assert.doesNotMatch(report.reviewItems[0].reason, /无法完整解码|文件损坏/);
  assert.equal(await env.index.has(id), true);
});

test("equivalent-quality new variant retains the established canonical rather than newest-first ordering", async (t) => {
  const env = await setup(t);
  const old = await env.add("old-file");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await env.add("fresh-file");
  const report = await deduplicatePerson(env.person, env.index, { ...env, mediaIds: [fresh],
    prefer: () => ({ preferred: "left", reason: "indistinguishable-quality-preserve-canonical" }) });
  assert.equal(report.merged, 1);
  assert.equal(env.index.get(fresh).mediaId, old);
});

test("incremental pass does not merge old-old pairs and empty new ids does not decode", async (t) => {
  const env = await setup(t);
  await env.add("old-one"); await env.add("old-two");
  const empty = await deduplicatePerson(env.person, env.index, { ...env, mediaIds: [], inspect: () => { throw new Error("unexpected decode"); } });
  assert.equal(empty.scanned, 0);
  const current = await env.add("new-file-longer");
  const report = await deduplicatePerson(env.person, env.index, { ...env, mediaIds: [current] });
  assert.equal(report.merged, 2);
  assert.equal(env.index.list().total, 1);
  assert.equal(env.index.get(current).sources && Object.keys(env.index.get(current).sources).length, 3);
});

test("file mutation during decode refuses fingerprint commit and keeps files", async (t) => {
  const env = await setup(t);
  await env.add("first"); await env.add("second");
  const report = await deduplicatePerson(env.person, env.index, { ...env, inspect: async (filePath) => {
    const result = await env.inspect(filePath);
    await writeFile(filePath, "externally-modified");
    return result;
  } });
  assert.equal(report.merged, 0);
  assert.equal(report.errors.length, 2);
  assert.equal(env.index.list().total, 2);
});

test("candidate similarity alone never archives without full-resolution verification", async (t) => {
  const env = await setup(t);
  await env.add("first"); await env.add("second");
  const report = await deduplicatePerson(env.person, env.index, { ...env,
    verify: async () => ({ decision: "review", reason: "local-detail-differs" }) });
  assert.equal(report.merged, 0);
  assert.equal(report.review, 1);
  assert.equal(env.index.list().total, 2);
});

test("manual manager reserves scheduling before asynchronous state load and persists result", async (t) => {
  const env = await setup(t);
  let releaseState;
  const delayed = new Promise((resolve) => { releaseState = resolve; });
  const state = { persons: [env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  const manager = new DedupManager({ loadState: () => delayed, reportFile: path.join(env.root, "dedup.json"),
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    deduplicate: async () => ({ scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [] }) });
  await manager.ready;
  const pending = manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(sync.start(env.person.id), { code: "media-maintenance-busy" });
  await assert.rejects(sync.withPersonDeletion(env.person.id, () => {}), /正在同步或删除/);
  releaseState(state);
  assert.equal((await pending).status, "running");
  await manager.running;
  assert.equal(manager.status().status, "completed");
  assert.equal(manager.status().scope, "all");
  assert.equal(manager.status().personId, null);
  assert.equal(sync.mediaMaintenanceToken, null);
  assert.equal(JSON.parse(await readFile(path.join(env.root, "dedup.json"), "utf8")).status, "completed");
  const restored = new DedupManager({ reportFile: path.join(env.root, "dedup.json") });
  await restored.ready;
  assert.equal(restored.status().id, manager.status().id);
});

test("single-person manual manager inspects only selected person and reports scoped progress", async (t) => {
  const env = await setup(t);
  const other = { id: "person-b", name: "B", folderPath: path.join(env.root, "B"), platforms: [] };
  const state = { persons: [other, env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  const opened = [], inspected = [];
  const manager = new DedupManager({ loadState: sync.loadState, reportFile: path.join(env.root, "scoped-dedup.json"),
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    openMediaIndex: async (person, options) => {
      opened.push(person.id);
      assert.equal(options.requireExisting, true);
      return env.index;
    },
    deduplicate: async (person, _index, { onProgress }) => {
      inspected.push(person.id);
      assert.equal(manager.status().scope, "person");
      assert.equal(manager.status().personId, env.person.id);
      assert.equal(manager.status().currentPersonId, env.person.id);
      assert.equal(manager.status().personName, env.person.name);
      const report = { personId: person.id, personName: person.name, scanned: 2, total: 2,
        merged: 0, review: 1, archivedBytes: 0, errors: [] };
      onProgress(report);
      return report;
    } });
  const started = await manager.start({ personId: env.person.id });
  assert.equal(started.scope, "person");
  assert.equal(started.personId, env.person.id);
  await manager.running;
  const completed = manager.status();
  assert.deepEqual(opened, [env.person.id]);
  assert.deepEqual(inspected, [env.person.id]);
  assert.equal(completed.results.length, 1);
  assert.equal(completed.review, 1);
  assert.match(completed.message, /差异版本已按保守规则自动保留/);
  assert.doesNotMatch(completed.message, /待确认/);
  assert.equal(sync.mediaMaintenanceToken, null);
  const saved = JSON.parse(await readFile(path.join(env.root, "scoped-dedup.json"), "utf8"));
  assert.equal(saved.scope, "person");
  assert.equal(saved.personId, env.person.id);
});

test("single-person unknown or invalid id does not change receipt or indexes and releases reservation", async (t) => {
  const env = await setup(t);
  const state = { persons: [env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  let opened = 0;
  const reportFile = path.join(env.root, "unchanged-dedup.json");
  const manager = new DedupManager({ loadState: sync.loadState, reportFile,
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    openMediaIndex: async () => { opened++; throw new Error("must not open any person index"); } });
  await manager.ready;
  const before = manager.status();
  await assert.rejects(manager.start({ personId: "absent" }), { code: "dedup-person-not-found", status: 404 });
  for (const personId of [null, "", " ", "../person-a", "person/a", 1, "x".repeat(201)]) {
    await assert.rejects(manager.start({ personId }), { code: "dedup-person-invalid", status: 400 });
  }
  assert.equal(opened, 0);
  assert.deepEqual(manager.status(), before);
  assert.equal(sync.mediaMaintenanceToken, null);
  await assert.rejects(readFile(reportFile), { code: "ENOENT" });
});

test("single-person reservation prevents concurrent all-person job before state load and cancellation releases it", async (t) => {
  const env = await setup(t);
  let releaseState, enteredDecode;
  const delayed = new Promise((resolve) => { releaseState = resolve; });
  const entered = new Promise((resolve) => { enteredDecode = resolve; });
  const state = { persons: [env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  const manager = new DedupManager({ loadState: () => delayed,
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    openMediaIndex: async () => env.index,
    deduplicate: (_person, _index, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true });
      enteredDecode();
    }) });
  await manager.ready;
  const pending = manager.start({ personId: env.person.id });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.start(), { code: "media-maintenance-busy" });
  await assert.rejects(sync.start(env.person.id), { code: "media-maintenance-busy" });
  releaseState(state);
  await pending;
  await entered;
  const cancellation = manager.cancel();
  assert.equal(cancellation.cancelRequested, true);
  assert.equal(cancellation.personId, env.person.id);
  await manager.running;
  assert.equal(manager.status().status, "cancelled");
  assert.equal(sync.mediaMaintenanceToken, null);
});

test("cancel and shutdown release lock without dropping archived source commits", async (t) => {
  const env = await setup(t);
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => ({ persons: [env.person], linkedAccounts: [] }) });
  const manager = new DedupManager({ loadState: sync.loadState,
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    deduplicate: (_person, _index, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true });
    }) });
  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.shutdown();
  assert.equal(manager.status().status, "cancelled");
  assert.equal(sync.mediaMaintenanceToken, null);
  await assert.rejects(manager.start(), { code: "dedup-closing" });
});

test("stop-and-close hides only after cancellation settles and keeps committed sources and archives", async (t) => {
  const env = await setup(t);
  const low = await env.add("low-version", "first"), high = await env.add("high-quality-version", "second");
  const state = { persons: [env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  const reportFile = path.join(env.root, "stop-close.json");
  let entered, settle, runs = 0;
  const readyToStop = new Promise((resolve) => { entered = resolve; });
  const afterDurableWork = new Promise((resolve) => { settle = resolve; });
  const manager = new DedupManager({ loadState: sync.loadState, reportFile,
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    openMediaIndex: async () => env.index,
    deduplicate: async (_person, index, { signal, onProgress }) => {
      if (++runs > 1) return { scanned: 0, total: 1, merged: 0, review: 0, archivedBytes: 0, errors: [] };
      await index.mergeVariants(high, [low], { evidence: { fixture: "durable-before-cancel" }, signal });
      onProgress({ scanned: 2, total: 2, merged: 1, review: 0, archivedBytes: Buffer.byteLength("low-version") });
      const cancellation = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      entered();
      await cancellation;
      await afterDurableWork;
      signal.throwIfAborted();
    } });
  const started = await manager.start({ personId: env.person.id });
  await readyToStop;
  const stopping = manager.cancel({ closeResults: true });
  assert.equal(stopping.status, "running");
  assert.equal(stopping.cancelRequested, true);
  assert.equal(stopping.dismissed, false, "a stop cannot hide running writes/decoders");
  await assert.rejects(manager.dismiss({ jobId: started.id }), { code: "dedup-busy" });
  await assert.rejects(manager.start(), { code: "dedup-busy" });
  assert.ok(sync.mediaMaintenanceToken, "the scheduling reservation stays held until work settles");
  settle();
  await manager.running;
  assert.equal(manager.status().status, "cancelled");
  assert.equal(manager.status().dismissed, true);
  assert.equal(manager.status().merged, 1);
  assert.equal(sync.mediaMaintenanceToken, null);
  assert.equal(env.index.get(low).mediaId, high);
  assert.deepEqual(env.index.sources(high).map((source) => source.accountId).sort(), ["first", "second"]);
  assert.equal(await env.index.has(low), true);
  assert.equal((await readdir(path.join(env.person.folderPath, "Index", "DedupArchive"))).length, 1);
  const saved = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.dismissed, true);
  assert.equal(saved.merged, 1);
  const restored = new DedupManager({ reportFile });
  await restored.ready;
  assert.equal(restored.status().dismissed, true, "closed results stay closed after a tool restart");
  assert.equal(restored.status().id, started.id);
  for (const options of [{ personId: env.person.id }, {}]) {
    const resumed = await manager.start(options);
    assert.notEqual(resumed.id, started.id);
    assert.equal(resumed.dismissed, false);
    assert.equal(resumed.cancelRequested, false);
    await manager.running;
    assert.equal(manager.status().status, "completed");
    assert.equal(manager.status().dismissed, false);
    assert.equal(env.index.list().total, 1, "retry uses the existing index without re-downloading/resetting media");
  }
});

test("terminal results can close independently, stale close cannot affect a fresh scoped or all-person job", async (t) => {
  const env = await setup(t);
  const state = { persons: [env.person], linkedAccounts: [] };
  const sync = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"), loadState: async () => state });
  const reportFile = path.join(env.root, "dismiss-result.json");
  let holdRun;
  let continueRun;
  const manager = new DedupManager({ loadState: sync.loadState, reportFile,
    acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
    openMediaIndex: async () => env.index,
    deduplicate: async () => {
      if (holdRun) await holdRun;
      return { scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [] };
    } });
  const first = await manager.start();
  await manager.running;
  assert.equal(manager.status().dismissed, false);
  await assert.rejects(manager.dismiss(), { code: "dedup-job-invalid", status: 400 });
  await assert.rejects(manager.dismiss({ jobId: "stale" }), { code: "dedup-result-stale", status: 409 });
  const completed = manager.status();
  const hidden = await manager.dismiss({ jobId: first.id });
  assert.equal(hidden.dismissed, true);
  assert.equal(hidden.status, "completed");
  assert.deepEqual(hidden.results, completed.results, "closing hides a receipt, it never deletes its evidence");
  assert.equal((await manager.dismiss({ jobId: first.id })).dismissed, true, "same-job close is idempotent");
  assert.equal(JSON.parse(await readFile(reportFile, "utf8")).dismissed, true);
  const restored = new DedupManager({ reportFile });
  await restored.ready;
  assert.equal(restored.status().dismissed, true);
  for (const options of [{ personId: env.person.id }, {}]) {
    holdRun = new Promise((resolve) => { continueRun = resolve; });
    const fresh = await manager.start(options);
    assert.notEqual(fresh.id, first.id);
    assert.equal(fresh.dismissed, false);
    assert.equal(fresh.cancelRequested, false);
    assert.equal(fresh.scope, options.personId ? "person" : "all");
    await assert.rejects(manager.dismiss({ jobId: first.id }), { code: "dedup-result-stale", status: 409 });
    assert.equal(manager.status().dismissed, false);
    continueRun();
    await manager.running;
    assert.equal(manager.status().status, "completed");
    assert.equal(manager.status().dismissed, false);
  }
});

test("shutdown preserves requested stop-and-close, but plain shutdown does not dismiss a receipt", async (t) => {
  const env = await setup(t);
  for (const closeResults of [false, true]) {
    const state = { persons: [env.person], linkedAccounts: [] };
    const sync = new SyncManager({ indexFile: path.join(env.root, `sync-${closeResults}.json`), loadState: async () => state });
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const manager = new DedupManager({ loadState: sync.loadState,
      reportFile: path.join(env.root, `shutdown-${closeResults}.json`),
      acquireMaintenance: () => sync.beginMediaMaintenance(), releaseMaintenance: (token) => sync.endMediaMaintenance(token),
      openMediaIndex: async () => env.index,
      deduplicate: (_person, _index, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered();
      }) });
    await manager.start();
    await ready;
    if (closeResults) manager.cancel({ closeResults: true });
    await manager.shutdown();
    assert.equal(manager.status().status, "cancelled");
    assert.equal(manager.status().dismissed, closeResults);
    assert.equal(sync.mediaMaintenanceToken, null);
    assert.equal(JSON.parse(await readFile(manager.reportFile, "utf8")).dismissed, closeResults);
  }
});

test("old terminal report defaults to visible and invalid close option does not cancel work", async (t) => {
  const env = await setup(t);
  const reportFile = path.join(env.root, "legacy-report.json");
  await writeFile(reportFile, JSON.stringify({ id: "legacy", status: "cancelled", results: [], errors: [] }));
  const restored = new DedupManager({ reportFile });
  await restored.ready;
  assert.equal(restored.status().dismissed, false);
  assert.throws(() => restored.cancel({ closeResults: "true" }), { code: "dedup-close-invalid", status: 400 });
  assert.equal(restored.status().dismissed, false);
  assert.equal((await restored.dismiss({ jobId: "legacy" })).dismissed, true);
});

test("sync invokes incremental local dedup hook before naming and keeps ids for receipt resolution", async (t) => {
  const env = await setup(t);
  env.person.platforms = [{ id: "x", label: "X", accounts: [{ id: "target", label: "@fixture" }] }];
  const media = { postId: "post", postKey: "post", logicalKey: "post:1", mediaIndex: 1, kind: "image", extension: ".jpg",
    payload: "local fixture", createdAt: "2026-10-01T10:00:00Z", sourceUrl: "https://unused.example/file.jpg" };
  let ids;
  const manager = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"),
    loadState: async () => ({ persons: [env.person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ posts: [{ postId: "post", postKey: "post" }], media: [media], complete: true }) },
    download: (item, ...args) => fixtureDownload(item, ...args, item.payload),
    deduplicate: async (_person, _index, options) => {
      ids = options.mediaIds;
      options.onProgress({ scanned: 1, total: 1, merged: 0, review: 0, archivedBytes: 0 });
      return { scanned: 1, total: 1, merged: 0, review: 0, archivedBytes: 0, errors: [] };
    } });
  const { job } = await manager.start(env.person.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.activeRunPromises.get(job.id);
  const done = manager.get(job.id);
  assert.equal(done.counters.failed, 0, JSON.stringify(done.errors));
  assert.equal(done.deduplication.scanned, 1);
  assert.equal(ids.length, 1);
  assert.equal(done.namingStatus, "complete");
  const receipt = await manager.receipt(env.person.id);
  assert.equal(receipt.files.length, 1);
  assert.match(receipt.files[0].filename, /20261001_A_01_/);
});

test("automatic sync skips unavailable similarity tools once without failing collection or decoding media", async (t) => {
  const env = await setup(t);
  env.person.platforms = [{ id: "x", label: "X", accounts: [{ id: "target", label: "@fixture" }] }];
  const media = { postId: "post", postKey: "post", logicalKey: "post:1", mediaIndex: 1, kind: "image", extension: ".jpg",
    payload: "local fixture", createdAt: "2026-10-01T10:00:00Z", sourceUrl: "https://unused.example/file.jpg" };
  let checks = 0, decodes = 0;
  const manager = new SyncManager({ indexFile: path.join(env.root, "sync-index.json"),
    loadState: async () => ({ persons: [env.person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ posts: [{ postId: "post", postKey: "post" }], media: [media], complete: true }) },
    download: (item, ...args) => fixtureDownload(item, ...args, item.payload),
    checkDedupTools: async () => { checks++; throw Object.assign(new Error("fixture tool missing"), { code: "similarity-tools-unavailable" }); },
    deduplicate: async () => { decodes++; } });
  const { job } = await manager.start(env.person.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.activeRunPromises.get(job.id);
  const done = manager.get(job.id);
  assert.equal(checks, 1); assert.equal(decodes, 0);
  assert.equal(done.counters.failed, 0); assert.equal(done.operationStatus, "synced");
  assert.equal(done.deduplication.skipped, true); assert.equal(done.deduplication.reason, "tools-unavailable");
  assert.equal((await manager.receipt(env.person.id)).files.length, 1);
});
