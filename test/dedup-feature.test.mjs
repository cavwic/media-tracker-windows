import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { DedupFeature, readDedupEdition } from "../lib/dedup-feature.mjs";
import { checkDedupTools } from "../lib/dedup-tools.mjs";
import { SyncManager } from "../lib/sync-engine.mjs";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";
import { fixtureDownload } from "./helpers/fixture-download.mjs";

async function fixture(t, edition = "minimal") {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-dedup-feature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (edition) { await mkdir(path.join(root, "components")); await writeFile(path.join(root, "components", "edition.json"), JSON.stringify({ schemaVersion: 1, edition, dedup: "on-demand" })); }
  let ready = false, installed = 0, saves = 0, tokens = 0;
  const configurations = [], state = { settings: { theme: "dark" }, persons: [{ id: "existing-person" }], linkedAccounts: [{ id: "existing-login" }] };
  const statusTools = async () => ({ ready, installAvailable: true, componentVersion: "fixture-version", directory: ready ? path.join(root, "tools", "ffmpeg-fixture", "bin") : "" });
  const checkTools = async () => { if (!ready) throw Object.assign(new Error("fixture missing tools"), { code: "similarity-tools-unavailable" }); return { ready: true }; };
  const installTools = async ({ root: actualRoot, parentDirectory, signal }) => {
    assert.equal(actualRoot, root); assert.equal(parentDirectory, path.join(root, "tools")); signal.throwIfAborted(); installed++; ready = true;
    return { directory: path.join(root, "tools", "ffmpeg-fixture", "bin") };
  };
  const options = { root, loadState: async () => structuredClone(state), saveState: async (value) => { saves++; Object.assign(state, value); },
    statusTools, checkTools, installTools, configureTools: (settings, options) => configurations.push({ settings, options }),
    acquireMaintenance: () => { tokens++; return "fixture-token"; }, releaseMaintenance: (token) => { assert.equal(token, "fixture-token"); tokens--; } };
  return { root, state, options, configurations, stats: () => ({ installed, saves, tokens }), setReady: () => { ready = true; } };
}

test("minimal edition remains gray without verified tools and never downloads during status or automatic checks", async (t) => {
  const item = await fixture(t), feature = new DedupFeature(item.options);
  const status = await feature.status();
  assert.equal(status.edition, "minimal"); assert.equal(status.available, false); assert.equal(status.included, false); assert.equal(status.installAvailable, true);
  assert.equal(item.configurations[0].options.allowSystemTools, false);
  await assert.rejects(feature.checkTools(), { code: "dedup-feature-unavailable" });
  await assert.rejects(feature.startInstall(), { code: "dedup-feature-confirm-required" });
  assert.deepEqual(item.stats(), { installed: 0, saves: 0, tokens: 0 });
});

test("standard/developer retains available entry and prior system-tool discovery behavior", async (t) => {
  const item = await fixture(t, null), feature = new DedupFeature(item.options);
  assert.equal(await readDedupEdition(item.root), "standard");
  assert.equal((await feature.status()).available, true); assert.equal(item.configurations[0].options.allowSystemTools, true);
  await assert.rejects(feature.checkTools(), { code: "similarity-tools-unavailable" });
});

test("standard state/runtime capability polling never searches or executes tools", async (t) => {
  const item = await fixture(t, null); let inspected = 0;
  const feature = new DedupFeature({ ...item.options, statusTools: async () => { inspected++; return { ready: false, installAvailable: true }; } });
  for (let count = 0; count < 4; count++) assert.equal((await feature.status()).available, true);
  assert.equal(inspected, 0); assert.equal((await feature.status()).ready, null);
  await feature.status({ inspectTools: true }); assert.equal(inspected, 1);
});

test("confirmed minimal install uses own tools directory, persists relative setting and does not start media work", async (t) => {
  const item = await fixture(t), feature = new DedupFeature(item.options);
  await feature.startInstall({ confirmed: true }); await feature.running;
  const status = await feature.status();
  assert.equal(status.available, true); assert.equal(status.progress.status, "completed"); assert.equal(status.installing, false);
  assert.deepEqual(item.state.persons, [{ id: "existing-person" }]); assert.deepEqual(item.state.linkedAccounts, [{ id: "existing-login" }]);
  assert.equal(item.state.settings.theme, "dark"); assert.equal(item.state.settings.dedupTools.directory, path.join("tools", "ffmpeg-fixture", "bin"));
  assert.deepEqual(item.stats(), { installed: 1, saves: 1, tokens: 0 });
  await feature.startInstall({ confirmed: true }); assert.equal(item.stats().installed, 1);
});

test("missing package descriptor is explicit, cannot start downloads and leaves state untouched", async (t) => {
  const item = await fixture(t), feature = new DedupFeature({ ...item.options, statusTools: async () => ({ ready: false, installAvailable: false }) });
  await assert.rejects(feature.startInstall({ confirmed: true }), { code: "dedup-feature-package-unavailable" });
  assert.deepEqual(item.stats(), { installed: 0, saves: 0, tokens: 0 });
});

test("feature cancellation and shutdown abort pending installs and release maintenance without touching media state", async (t) => {
  for (const stop of ["cancel", "shutdown"]) {
    const item = await fixture(t), feature = new DedupFeature({ ...item.options,
      installTools: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    const status = await feature.startInstall({ confirmed: true }); assert.equal(status.installing, true);
    await assert.rejects(feature.startInstall({ confirmed: true }), { code: "dedup-feature-install-busy" });
    if (stop === "cancel") await feature.cancel({ confirmed: true }); else await feature.shutdown();
    await feature.running;
    assert.equal((await feature.status()).progress.status, "cancelled"); assert.equal(item.stats().tokens, 0); assert.equal(item.stats().saves, 0);
    assert.deepEqual(item.state.persons, [{ id: "existing-person" }]); assert.deepEqual(item.state.linkedAccounts, [{ id: "existing-login" }]);
  }
});

test("installation failure preserves disabled state and allows later confirmed retry", async (t) => {
  const item = await fixture(t); let first = true;
  const feature = new DedupFeature({ ...item.options, installTools: async (options) => {
    if (first) { first = false; throw Object.assign(new Error("fixture checksum failed"), { code: "similarity-package-hash-mismatch" }); }
    return item.options.installTools(options);
  } });
  await feature.startInstall({ confirmed: true }); await feature.running;
  assert.equal((await feature.status()).available, false); assert.equal((await feature.status()).progress.status, "failed"); assert.equal(item.stats().tokens, 0);
  await feature.startInstall({ confirmed: true }); await feature.running; assert.equal((await feature.status()).available, true);
});

test("parallel confirmations cannot both pass the asynchronous dependency precheck", async (t) => {
  const item = await fixture(t); let release, probes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const feature = new DedupFeature({ ...item.options, statusTools: async () => { probes++; await gate; return item.options.statusTools(); } });
  const first = feature.startInstall({ confirmed: true });
  while (!probes) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(feature.startInstall({ confirmed: true }), { code: "dedup-feature-install-busy" });
  assert.equal(probes, 1); release(); await first; await feature.running;
  assert.equal(item.stats().installed, 1); assert.equal(item.stats().tokens, 0);
});

test("minimal tool detection excludes inherited PATH/environment but accepts explicit trusted selected directory", async (t) => {
  const item = await fixture(t), external = path.join(item.root, "external-tools"); await mkdir(external);
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["ffmpeg", "ffprobe"]) await writeFile(path.join(external, name + suffix), "fixture");
  const env = { PATH: external, MEDIA_TRACKER_FFMPEG: path.join(external, "ffmpeg" + suffix), MEDIA_TRACKER_FFPROBE: path.join(external, "ffprobe" + suffix) };
  let calls = 0;
  const execute = async (executable, args) => { calls++; return args[0] === "-version" ? `${path.basename(executable, suffix)} version fixture` : " .. scale V->V\n .. select V->V"; };
  await assert.rejects(checkDedupTools({ root: item.root, env, allowSystemTools: false, execute }), { code: "similarity-tools-unavailable" });
  assert.equal(calls, 0);
  const selected = await checkDedupTools({ root: item.root, directory: external, env, allowSystemTools: false, execute });
  assert.equal(selected.ready, true); assert.equal(calls, 3);
  assert.equal((await checkDedupTools({ root: item.root, env, allowSystemTools: true, execute })).ready, true);
});

test("malformed/unsupported edition is rejected rather than enabling optional tools implicitly", async (t) => {
  const item = await fixture(t); await writeFile(path.join(item.root, "components", "edition.json"), '{"schemaVersion":1,"edition":"minimal","dedup":"always"}');
  await assert.rejects(readDedupEdition(item.root), { code: "dedup-edition-invalid" });
  await writeFile(path.join(item.root, "components", "edition.json"), "invalid");
  await assert.rejects(readDedupEdition(item.root), { code: "dedup-edition-invalid" });
});

test("minimal synchronization keeps local exact SHA/source indexing and skips unavailable similarity without failure", async (t) => {
  const item = await fixture(t), feature = new DedupFeature(item.options);
  t.after(clearPersonMediaIndexCache);
  const person = { id: "person-minimal", name: "Minimal", folderPath: path.join(item.root, "Person"), platforms: [
    { id: "x", label: "X", accounts: [{ id: "one", label: "@one" }, { id: "two", label: "@two" }] },
  ] };
  const media = { postId: "post", postKey: "post", logicalKey: "post:1", mediaIndex: 1, kind: "image", extension: ".jpg",
    createdAt: "2026-10-01T10:00:00.000Z", sourceUrl: "https://unused.example/photo.jpg", postUrl: "https://unused.example/post" };
  let dedupRuns = 0;
  const manager = new SyncManager({ indexFile: path.join(item.root, "sync-index.json"), loadState: async () => ({ persons: [person], linkedAccounts: [] }),
    discoverers: { x: async () => ({ media: [media], posts: [{ postId: "post", postKey: "post", createdAt: media.createdAt }], complete: true }) },
    download: (value, ...args) => fixtureDownload(value, ...args, "exactly-shared-bytes"),
    deduplicate: () => { dedupRuns++; }, checkDedupTools: (options) => feature.checkTools(options) });
  const run = async () => {
    const { job } = await manager.start(person.id), deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const report = manager.get(job.id);
      if (!manager.activeJobIds.has(job.id) && !["queued", "running"].includes(report.status)) return report;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("minimal sync fixture timeout");
  };
  const first = await run();
  assert.equal(first.counters.failed, 0); assert.equal(first.counters.downloaded, 1); assert.equal(first.counters.contentDuplicates, 1);
  assert.equal(first.deduplication.skipped, true); assert.equal(first.deduplication.reason, "feature-unavailable"); assert.equal(dedupRuns, 0);
  const index = await openPersonMediaIndex(person), page = index.list({ offset: 0, limit: 20 });
  assert.equal(page.total, 1); assert.equal(index.sources(page.items[0].mediaId).length, 2);
  const repeated = await run(); assert.equal(repeated.counters.failed, 0); assert.equal(repeated.counters.downloaded, 0); assert.equal(repeated.counters.logicalDuplicates, 2);
  assert.deepEqual(item.stats(), { installed: 0, saves: 0, tokens: 0 });
  await manager.shutdown({ timeoutMs: 0 });
});
