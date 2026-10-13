import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { SyncStore } from "../lib/sync-store.mjs";
import { inspectClearedPerson, parseRebuildArgs, runReadableNamingRebuild } from "../scripts/rebuild-readable-names.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-readable-rebuild-"));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  const persons = ["p1", "p2"].map((id) => ({ id, name: id, folderPath: path.join(root, "people", id) }));
  for (const person of persons) await mkdir(person.folderPath, { recursive: true });
  const stateRaw = Buffer.from(JSON.stringify({ version: 4, persons, settings: { theme: "dark" }, customPlatforms: [{ id: "custom" }], linkedAccounts: [{ id: "login", loginStatus: "verified" }] }) + "\r\n");
  const index = { version: 3, layout: "person-v1", scopes: { "p1:x:a": { media: { old: { mediaId: "a".repeat(64) } }, initialComplete: true }, "p2:x:a": { media: {}, initialComplete: true }, "untouched:x:a": { initialComplete: true } }, summaries: { p1: { id: "old-job" }, p2: {} }, receipts: { p1: { files: [] }, p2: {} }, storageInitialized: { p1: "old", p2: "old", untouched: "old" }, migration: { fromVersion: 2, backupFile: "legacy.json" } };
  const syncRaw = Buffer.from(JSON.stringify(index, null, 3) + "\r\n");
  await writeFile(path.join(dataDir, "state.json"), stateRaw);
  await writeFile(path.join(dataDir, "sync-index.json"), syncRaw);
  await mkdir(path.join(dataDir, "browser-profiles"));
  await writeFile(path.join(dataDir, "browser-profiles", "login-cookie"), "preserve-session");
  return { root, dataDir, persons, stateRaw, syncRaw };
}

const quiet = { write: () => {}, assertStopped: async () => {} };

test("readable rebuild arguments default to read-only preview and reject unrecognized switches", () => {
  assert.equal(parseRebuildArgs([]).apply, false);
  const options = parseRebuildArgs(["--data-dir", "./testing", "--state-file", "./settings.json", "--apply", "--person-id", "p1"]);
  assert.equal(options.apply, true);
  assert.equal(path.isAbsolute(options.stateFile), true);
  assert.deepEqual(options.personIds, ["p1"]);
  assert.throws(() => parseRebuildArgs(["--force"]));
  assert.throws(() => parseRebuildArgs(["--state-file"]));
  assert.equal(parseRebuildArgs([]).rebuildId, "readable-names-v1");
  assert.equal(parseRebuildArgs(["--rebuild-id", "legacy-date-v1"]).rebuildId, "legacy-date-v1");
  assert.equal(parseRebuildArgs(["--rebuild-id", "beijing-date-v1"]).rebuildId, "beijing-date-v1");
  assert.throws(() => parseRebuildArgs(["--rebuild-id", "anything-new"]), /受控重建轮次/);
});

test("preview does not write backups, locks, configuration, or checkpoints", async () => {
  const f = await fixture();
  try {
    const before = await readdir(f.dataDir);
    const report = await runReadableNamingRebuild({ dataDir: f.dataDir, ...quiet });
    assert.equal(report.reports.filter((item) => item.eligible).length, 2);
    assert.deepEqual(report.applied, []);
    assert.deepEqual(await readdir(f.dataDir), before);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    assert.deepEqual(await readFile(path.join(f.dataDir, "state.json")), f.stateRaw);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit rebuild backs up exact original bytes, preserves configuration/profiles and skips completed persons forever", async () => {
  const f = await fixture();
  try {
    const report = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet });
    assert.deepEqual(report.applied, ["p1", "p2"]);
    assert.deepEqual(await readFile(path.join(f.dataDir, report.backupFile)), f.syncRaw);
    assert.deepEqual(await readFile(path.join(f.dataDir, "state.json")), f.stateRaw);
    assert.equal(await readFile(path.join(f.dataDir, "browser-profiles", "login-cookie"), "utf8"), "preserve-session");
    let parsed = JSON.parse(await readFile(path.join(f.dataDir, "sync-index.json"), "utf8"));
    assert.deepEqual(Object.keys(parsed.scopes), ["untouched:x:a"]);
    assert.deepEqual(parsed.summaries, {});
    assert.deepEqual(parsed.receipts, {});
    assert.deepEqual(parsed.storageInitialized, { untouched: "old" });
    assert.equal(parsed.version, 3);
    assert.equal(parsed.readableNamingRebuild.version, 1);
    assert.equal(parsed.migration.backupFile, "legacy.json");
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json"));
    await store.markPosts("p1:x:a", [{ postKey: "new" }]);
    await store.markPersonStorageInitialized("p1");
    const saved = await readFile(path.join(f.dataDir, "sync-index.json"));
    const second = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), saved);
    assert.equal((await readdir(f.dataDir)).filter((name) => name.includes("readable-names-backup")).length, 1);
    const reloaded = new SyncStore(path.join(f.dataDir, "sync-index.json"));
    await reloaded.ready;
    assert.equal(await reloaded.personStorageInitialized("p1"), true);
    assert.equal((await reloaded.scope("p1:x:a")).knownPosts.new, true);
    assert.equal(reloaded.index.readableNamingRebuild.persons.p1.backupFile, report.backupFile);
    assert.deepEqual(await readdir(f.persons[0].folderPath), []);
    assert.equal((await readdir(f.dataDir)).includes(".readable-names-maintenance.lock"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("nonempty media and unknown files are retained while only independently eligible persons reset", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.persons[0].folderPath, "Image"));
    await writeFile(path.join(f.persons[0].folderPath, "Image", "a.jpg"), "media");
    const report = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet });
    assert.deepEqual(report.applied, ["p2"]);
    assert.equal(report.exitCode, 2);
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json"));
    assert.equal((await store.scope("p1:x:a")).initialComplete, true);
    assert.equal(await readFile(path.join(f.persons[0].folderPath, "Image", "a.jpg"), "utf8"), "media");
    await writeFile(path.join(f.persons[0].folderPath, "unrecognized.txt"), "keep");
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unavailable NAS or unreadable metadata never resets history and never creates folders", async () => {
  const f = await fixture();
  try {
    const inspect = async (person) => ({ personId: person.id, eligible: false, reason: "共享不可访问" });
    const before = await readdir(f.dataDir);
    const report = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, inspect, ...quiet });
    assert.equal(report.exitCode, 2);
    assert.deepEqual(report.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    assert.deepEqual(await readdir(f.dataDir), before);
    const info = await inspectClearedPerson({ ...f.persons[0], folderPath: path.parse(f.root).root });
    assert.equal(info.eligible, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("empty Index metadata is backed up and preserved; historical or broken metadata is rejected", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.persons[0].folderPath, "Index");
    await mkdir(directory);
    const snapshot = JSON.stringify({ version: 1, layout: "person-v1", personId: "p1", appliedSeq: 0, assets: {} }) + "\n";
    await writeFile(path.join(directory, "media-index.json"), snapshot);
    await writeFile(path.join(directory, "events.jsonl"), "");
    const report = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, personIds: ["p1"], ...quiet });
    const backups = (await readdir(f.dataDir)).filter((name) => name.startsWith("readable-names-p1-"));
    assert.equal(backups.length, 2);
    assert.equal(await readFile(path.join(directory, "media-index.json"), "utf8"), snapshot);
    assert.deepEqual(report.applied, ["p1"]);
    await writeFile(path.join(directory, "events.jsonl"), '{"type":"upsert"}\n');
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, false);
    await writeFile(path.join(directory, "events.jsonl"), "");
    await writeFile(path.join(directory, "media-index.json"), "{broken");
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a running tool, existing maintenance lock, or changed configuration prevents reset", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, write: () => {}, assertStopped: async () => { throw new Error("仍在运行"); } }), /仍在运行/);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    const lockPath = path.join(f.dataDir, ".readable-names-maintenance.lock");
    await writeFile(lockPath, "another-owner");
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet }), { code: "EEXIST" });
    assert.equal(await readFile(lockPath, "utf8"), "another-owner");
    await rm(lockPath);
    let checks = 0;
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, write: () => {}, assertStopped: async () => {
      if (++checks === 2) await writeFile(path.join(f.dataDir, "state.json"), "changed externally");
    } }), /发生变化/);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    assert.equal((await readdir(f.dataDir)).includes(".readable-names-maintenance.lock"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("empty v2 person snapshots are eligible and preserved while pending rename state is rejected", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.persons[0].folderPath, "Index");
    await mkdir(directory);
    const snapshotFile = path.join(directory, "media-index.json");
    const empty = { version: 2, layout: "person-v1", personId: "p1", appliedSeq: 0, assets: {}, pendingRenames: {} };
    const original = JSON.stringify(empty) + "\r\n";
    await writeFile(snapshotFile, original);
    await writeFile(path.join(directory, "events.jsonl"), "");
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, true);
    for (const invalid of [{ ...empty, pendingRenames: { batch: { entries: [] } } }, { ...empty, pendingRenames: [] }, { ...empty, appliedSeq: 1 }, { ...empty, version: 3 }]) {
      await writeFile(snapshotFile, JSON.stringify(invalid));
      assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, false);
    }
    await writeFile(snapshotFile, original);
    const report = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, personIds: ["p1"], ...quiet });
    assert.deepEqual(report.applied, ["p1"]);
    assert.equal(await readFile(snapshotFile, "utf8"), original);
    const backup = (await readdir(f.dataDir)).find((name) => name.startsWith("readable-names-p1-media-index.json-"));
    assert.equal(await readFile(path.join(f.dataDir, backup), "utf8"), original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("linked/junction folders, overlapping roots, and unsafe identifiers are never eligible", async () => {
  const f = await fixture();
  try {
    const destination = path.join(f.root, "linked");
    await mkdir(destination);
    await symlink(destination, path.join(f.persons[0].folderPath, "Image"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir })).eligible, false);
    const overlapping = { ...f.persons[1], folderPath: path.join(f.persons[0].folderPath, "nested") };
    assert.equal((await inspectClearedPerson(f.persons[0], { dataDir: f.dataDir, persons: [f.persons[0], overlapping] })).eligible, false);
    assert.equal((await inspectClearedPerson({ ...f.persons[1], id: "../unsafe" }, { dataDir: f.dataDir })).eligible, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("publication metadata survives global-index reloads without inventing a timezone", async () => {
  const f = await fixture();
  try {
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json"));
    await store.markMedia("p1:x:a", { logicalKey: "new:1", postId: "new", kind: "image", publicationDate: "20260101", dateBasis: "platform", displayTimeZone: null }, { mediaId: "b".repeat(64), kind: "image" });
    const second = new SyncStore(path.join(f.dataDir, "sync-index.json"));
    const media = (await second.scope("p1:x:a")).media["new:1"];
    assert.equal(media.publicationDate, "20260101");
    assert.equal(media.dateBasis, "platform");
    assert.equal(media.displayTimeZone, null);
    assert.equal(media.mediaId, "b".repeat(64));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("store refuses missing or mismatched maintenance backups and concurrent index changes", async () => {
  const f = await fixture();
  try {
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json")); await store.ready;
    await assert.rejects(store.rebuildClearedPersons(["p1"], { backupFile: "missing.json", expectedContents: f.syncRaw }));
    await writeFile(path.join(f.dataDir, "wrong.json"), "not the index");
    await assert.rejects(store.rebuildClearedPersons(["p1"], { backupFile: "wrong.json", expectedContents: f.syncRaw }), /备份/);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    assert.equal(store.index.scopes["p1:x:a"].initialComplete, true);
    await writeFile(path.join(f.dataDir, "right.json"), f.syncRaw);
    await writeFile(path.join(f.dataDir, "sync-index.json"), Buffer.concat([f.syncRaw, Buffer.from(" ")]));
    await assert.rejects(store.rebuildClearedPersons(["p1"], { backupFile: "right.json", expectedContents: f.syncRaw }), /发生变化/);
    assert.equal(store.index.scopes["p1:x:a"].initialComplete, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit legacy-date round is independent of the original one and persists idempotence across reloads", async () => {
  const f = await fixture();
  try {
    const old = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet });
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json")); await store.ready;
    const originalMarkers = structuredClone(store.index.readableNamingRebuild.persons);
    await store.markPosts("p1:x:a", [{ postKey: "since-original-rebuild" }]);
    await store.markPosts("p2:x:a", [{ postKey: "retain-p2" }]);
    await store.markPersonStorageInitialized("p1");
    await store.saveSummary("p1", { id: "after-original", status: "completed" }, []);
    const before = await readFile(path.join(f.dataDir, "sync-index.json"));
    const originalPreview = await runReadableNamingRebuild({ dataDir: f.dataDir, ...quiet });
    assert.equal(originalPreview.reports.every((item) => item.completed), true);
    const preview = await runReadableNamingRebuild({ dataDir: f.dataDir, rebuildId: "legacy-date-v1", personIds: ["p1"], ...quiet });
    assert.equal(preview.reports[0].eligible, true);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), before);
    const legacy = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(legacy.applied, ["p1"]);
    assert.notEqual(legacy.backupFile, old.backupFile);
    assert.deepEqual(await readFile(path.join(f.dataDir, legacy.backupFile)), before);
    const reloaded = new SyncStore(path.join(f.dataDir, "sync-index.json")); await reloaded.ready;
    assert.deepEqual(reloaded.index.readableNamingRebuild.persons, originalMarkers);
    assert.equal(reloaded.index.readableNamingRebuild.runs["legacy-date-v1"].persons.p1.backupFile, legacy.backupFile);
    assert.equal(Object.hasOwn(reloaded.index.scopes, "p1:x:a"), false);
    assert.equal(reloaded.index.scopes["p2:x:a"].knownPosts["retain-p2"], true);
    assert.equal(await reloaded.personStorageInitialized("p1"), false);
    assert.equal(await reloaded.summary("p1"), null);
    await reloaded.markPosts("p1:x:a", [{ postKey: "since-date-rebuild" }]);
    const latest = await readFile(path.join(f.dataDir, "sync-index.json"));
    const second = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), latest);
    assert.deepEqual(await readFile(path.join(f.dataDir, "state.json")), f.stateRaw);
    assert.equal(await readFile(path.join(f.dataDir, "browser-profiles", "login-cookie"), "utf8"), "preserve-session");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("legacy-date round does not clear nonempty historical Index, media, or unavailable shares", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.persons[0].folderPath, "Index"); await mkdir(directory);
    const snapshot = JSON.stringify({ version: 2, layout: "person-v1", personId: "p1", appliedSeq: 1, assets: { old: {} }, pendingRenames: {} });
    await writeFile(path.join(directory, "media-index.json"), snapshot);
    await writeFile(path.join(directory, "events.jsonl"), "historical log\n");
    const result = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(result.applied, []);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    assert.equal(await readFile(path.join(directory, "media-index.json"), "utf8"), snapshot);
    await mkdir(path.join(f.persons[1].folderPath, "Video"));
    await writeFile(path.join(f.persons[1].folderPath, "Video", "keep.mp4"), "keep");
    const media = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", personIds: ["p2"], ...quiet });
    assert.deepEqual(media.applied, []);
    const unavailable = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", inspect: async (person) => ({ personId: person.id, eligible: false, reason: "NAS不可达" }), ...quiet });
    assert.deepEqual(unavailable.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("malformed legacy round markers and unapproved round identifiers never mutate state", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "unapproved", ...quiet }), /受控重建轮次/);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    const parsed = JSON.parse(f.syncRaw.toString("utf8"));
    parsed.readableNamingRebuild = { version: 1, persons: {}, runs: { "legacy-date-v1": { version: 99, persons: {} } } };
    const invalid = JSON.stringify(parsed); await writeFile(path.join(f.dataDir, "sync-index.json"), invalid);
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", ...quiet }), /标记无效/);
    assert.equal(await readFile(path.join(f.dataDir, "sync-index.json"), "utf8"), invalid);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit Beijing date round preserves both previous rounds and is independently idempotent", async () => {
  const f = await fixture();
  try {
    await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, ...quiet });
    await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "legacy-date-v1", ...quiet });
    const store = new SyncStore(path.join(f.dataDir, "sync-index.json")); await store.ready;
    const previousMarkers = structuredClone(store.index.readableNamingRebuild);
    await store.markPosts("p1:x:a", [{ postKey: "after-legacy" }]);
    await store.markPosts("p2:x:a", [{ postKey: "keep-p2" }]);
    await store.markPersonStorageInitialized("p1");
    await store.saveSummary("p1", { id: "legacy-job", status: "completed" }, []);
    const before = await readFile(path.join(f.dataDir, "sync-index.json"));
    const preview = await runReadableNamingRebuild({ dataDir: f.dataDir, rebuildId: "beijing-date-v1", personIds: ["p1"], ...quiet });
    assert.equal(preview.reports[0].eligible, true);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), before);
    const result = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(result.applied, ["p1"]);
    assert.deepEqual(await readFile(path.join(f.dataDir, result.backupFile)), before);
    const reloaded = new SyncStore(path.join(f.dataDir, "sync-index.json")); await reloaded.ready;
    assert.deepEqual(reloaded.index.readableNamingRebuild.persons, previousMarkers.persons);
    assert.deepEqual(reloaded.index.readableNamingRebuild.runs["legacy-date-v1"], previousMarkers.runs["legacy-date-v1"]);
    assert.equal(reloaded.index.readableNamingRebuild.runs["beijing-date-v1"].persons.p1.backupFile, result.backupFile);
    assert.equal(Object.hasOwn(reloaded.index.scopes, "p1:x:a"), false);
    assert.equal(reloaded.index.scopes["p2:x:a"].knownPosts["keep-p2"], true);
    assert.equal(await reloaded.personStorageInitialized("p1"), false);
    assert.equal(await reloaded.summary("p1"), null);
    await reloaded.markPosts("p1:x:a", [{ postKey: "after-beijing" }]);
    const latest = await readFile(path.join(f.dataDir, "sync-index.json"));
    const repeated = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), latest);
    assert.deepEqual(await readFile(path.join(f.dataDir, "state.json")), f.stateRaw);
    assert.equal(await readFile(path.join(f.dataDir, "browser-profiles", "login-cookie"), "utf8"), "preserve-session");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Beijing round refuses historical Index, media, malformed markers and unavailable storage", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.persons[0].folderPath, "Index"); await mkdir(directory);
    await writeFile(path.join(directory, "media-index.json"), JSON.stringify({ version: 2, layout: "person-v1", personId: "p1", appliedSeq: 1, assets: {}, pendingRenames: {} }));
    await writeFile(path.join(directory, "events.jsonl"), "retained history\n");
    const history = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", personIds: ["p1"], ...quiet });
    assert.deepEqual(history.applied, []);
    assert.equal(history.exitCode, 2);
    await mkdir(path.join(f.persons[1].folderPath, "Image"));
    await writeFile(path.join(f.persons[1].folderPath, "Image", "keep.jpg"), "keep");
    const media = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", personIds: ["p2"], ...quiet });
    assert.deepEqual(media.applied, []);
    const unavailable = await runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", inspect: async (person) => ({ personId: person.id, eligible: false, reason: "NAS不可达" }), ...quiet });
    assert.deepEqual(unavailable.applied, []);
    assert.deepEqual(await readFile(path.join(f.dataDir, "sync-index.json")), f.syncRaw);
    const parsed = JSON.parse(f.syncRaw.toString("utf8"));
    parsed.readableNamingRebuild = { version: 1, persons: {}, runs: { "beijing-date-v1": { version: 99, persons: {} } } };
    const invalid = JSON.stringify(parsed); await writeFile(path.join(f.dataDir, "sync-index.json"), invalid);
    await assert.rejects(runReadableNamingRebuild({ apply: true, dataDir: f.dataDir, rebuildId: "beijing-date-v1", ...quiet }), /标记无效/);
    assert.equal(await readFile(path.join(f.dataDir, "sync-index.json"), "utf8"), invalid);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
