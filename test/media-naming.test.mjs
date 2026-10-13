import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { clearPersonMediaIndexCache, openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { compareSources, parseMediaFilename, personLabel, readableRelativePath, validPublicationDate } from "../lib/media-naming.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-media-"));
  const person = { id: path.basename(root), name: "人物A", folderPath: root };
  t.after(async () => { clearPersonMediaIndexCache(person.id); await rm(root, { recursive: true, force: true }); });
  return { root, person, index: await openPersonMediaIndex(person, { create: true }) };
}

function source(postId, overrides = {}) {
  return { platformId: "x", platformLabel: "X", accountId: "A", accountLabel: "@A", logicalKey: `${postId}:${overrides.mediaIndex ?? 0}`,
    postId: String(postId), mediaIndex: 0, postUrl: `https://x.com/A/status/${postId}`, publicationDate: "20260101", dateBasis: "platform",
    displayTimeZone: null, createdAt: "2026-01-01T01:00:00.000Z", ...overrides };
}

async function download(index, root, payload, provenance, extension = ".jpg") {
  const bytes = Buffer.from(payload), mediaId = createHash("sha256").update(bytes).digest("hex");
  const partialPath = path.join(root, `.sample-${Math.random().toString(36).slice(2)}.part`);
  await writeFile(partialPath, bytes);
  return index.commitDownloaded({ partialPath, sha256: mediaId, bytes: bytes.length, extension, source: provenance });
}

function filename(index, result) { return path.basename(index.get(result.mediaId).relativePath); }

test("readable filename sanitizes @ correctly, keeps complete identity suffix, and bounds Unicode names", () => {
  const mediaId = "a".repeat(64);
  const record = { mediaId, kind: "image", extension: ".jpg", personLabel: "@人物<>:" + "长名😀".repeat(300), publicationDate: "20260101", daySequence: 1, sequenceWidth: 2 };
  const name = readableRelativePath("C:\\Media", record);
  assert.ok(name.includes("@人物___"));
  assert.ok(Buffer.byteLength(path.basename(name), "utf8") <= 240);
  assert.ok(path.join("C:\\Media", name).length <= 240);
  assert.match(name, /_01_aaaaaaaaaaaaaaaa\.jpg$/);
  assert.equal(parseMediaFilename(path.basename(name)).publicationDate, "20260101");
  assert.equal(personLabel("a/b\\c<>:\"|?*\u0000. "), "a_b_c________");
  assert.equal(validPublicationDate("20260229"), false);
  assert.equal(validPublicationDate("20240229"), true);
  assert.equal(parseMediaFilename("20260229_A_01_aaaaaaaaaaaaaaaa.jpg"), null);
  assert.throws(() => readableRelativePath("C:\\" + "x".repeat(230), record), { code: "media-filename-too-long" });
});

test("chronological post grouping precedes attachments; missing attachment order is never attachment zero", () => {
  const a = source("1", { mediaIndex: 2 }), b = source("2", { mediaIndex: 0 });
  assert.ok(compareSources(a, b) < 0);
  assert.ok(compareSources(source("1", { mediaIndex: 0 }), source("1", { mediaIndex: null })) < 0);
  assert.ok(compareSources(source("1", { mediaIndex: 0 }), source("1", { mediaIndex: "" })) < 0);
  assert.ok(compareSources(source("9"), source("1", { createdAt: null })) < 0);
  assert.ok(compareSources(source("9"), source("1", { createdAt: "2026-01-01" })) < 0);
  assert.ok(compareSources(source("9"), source("1", { createdAt: "2026-01-01T00:00:00" })) < 0);
});

test("A two-picture post then B picture/video number independently and preserve attachment order", async (t) => {
  const { root, index } = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("naming/dedup must be local"); });
  const bImage = await download(index, root, "B image", source("B", { createdAt: "2026-01-01T02:00:00.000Z" }));
  const aSecond = await download(index, root, "A second image", source("A", { mediaIndex: 1 }));
  const aFirst = await download(index, root, "A first image", source("A"));
  const bVideo = await download(index, root, "B video", source("B", { createdAt: "2026-01-01T02:00:00.000Z", mediaIndex: 1 }), ".mp4");
  const outcome = await index.finalizeNaming();
  assert.equal(outcome.renamed, 2);
  assert.match(filename(index, aFirst), /^20260101_人物A_01_/);
  assert.match(filename(index, aSecond), /^20260101_人物A_02_/);
  assert.match(filename(index, bImage), /^20260101_人物A_03_/);
  assert.match(filename(index, bVideo), /^20260101_人物A_01_/);
  assert.equal((await readdir(path.join(root, "Image"))).length, 3);
  assert.equal((await readdir(path.join(root, "Video"))).length, 1);
  for (const result of [aFirst, aSecond, bImage, bVideo]) assert.equal(await index.has(result.mediaId), true);
  const again = await index.finalizeNaming();
  assert.equal(again.renamed, 0);
});

test("earliest duplicate date moves one asset and closes the old day's numbering without re-download", async (t) => {
  const { root, person, index } = await fixture(t);
  const a = await download(index, root, "shared", source("1"));
  const b = await download(index, root, "second", source("2", { createdAt: "2026-01-01T02:00:00Z" }));
  const oldId = a.mediaId;
  await index.addSource(a.mediaId, source("older", { platformId: "instagram", accountId: "other", publicationDate: "20251231", createdAt: "2025-12-31T12:00:00Z" }));
  await index.finalizeNaming();
  assert.match(filename(index, a), /^20251231_人物A_01_/);
  assert.match(filename(index, b), /^20260101_人物A_01_/);
  assert.equal(index.sources(a.mediaId).length, 2);
  assert.equal(index.get(a.mediaId).mediaId, oldId);
  assert.equal((await readdir(path.join(root, "Image"))).length, 2);
  await index.compact();
  clearPersonMediaIndexCache(person.id);
  const reloaded = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal((await reloaded.finalizeNaming()).renamed, 0);
  assert.equal(await reloaded.has(oldId), true);
});

test("missing publication dates use stable collection fallback, calendar dates follow timed posts, and evidence survives resync", async (t) => {
  const { root, person, index } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-03T00:00:00Z") });
  const unknown = await download(index, root, "unknown-date", source("unknown", { publicationDate: null, dateBasis: "unknown", createdAt: null }));
  assert.match(filename(index, unknown), /^20260103_/);
  assert.equal(index.sources(unknown.mediaId)[0].dateBasis, "first-collected-beijing");
  const dateOnly = await download(index, root, "date-only", source("date-only", { createdAt: null }));
  const timed = await download(index, root, "timed", source("timed"));
  await index.addSource(unknown.mediaId, source("unknown", { publicationDate: "20260101", createdAt: "2026-01-01T00:00:00Z", displayTimeZone: "Asia/Shanghai" }));
  await index.finalizeNaming();
  assert.match(filename(index, unknown), /^20260101_人物A_01_/);
  assert.match(filename(index, timed), /^20260101_人物A_02_/);
  assert.match(filename(index, dateOnly), /^20260101_人物A_03_/);
  const firstSeenAt = index.sources(unknown.mediaId)[0].firstSeenAt;
  await index.addSource(unknown.mediaId, source("unknown", { publicationDate: null, dateBasis: "unknown", createdAt: null }));
  assert.equal(index.sources(unknown.mediaId)[0].publicationDate, "20260101");
  assert.equal(index.sources(unknown.mediaId)[0].displayTimeZone, "Asia/Shanghai");
  assert.equal(index.sources(unknown.mediaId)[0].dateBasis, "created-at-beijing");
  assert.equal(index.sources(unknown.mediaId)[0].createdAt, "2026-01-01T00:00:00Z");
  assert.equal(index.sources(unknown.mediaId)[0].firstSeenAt, firstSeenAt);
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const again = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(again.sources(unknown.mediaId)[0].publicationDate, "20260101");
});

test("100 same-day assets use three digits, GIF shares image numbering and MP4 uses video", async (t) => {
  const { root, index } = await fixture(t);
  const first = await download(index, root, "image-0", source("0"), ".gif");
  for (let offset = 1; offset < 100; offset++) await download(index, root, `image-${offset}`, source(String(offset), { createdAt: new Date(Date.UTC(2026, 0, 1, 0, offset)).toISOString() }));
  const video = await download(index, root, "animated-mp4", source("mp4"), ".mp4");
  await index.finalizeNaming();
  const imageNames = await readdir(path.join(root, "Image"));
  assert.equal(imageNames.length, 100);
  assert.ok(imageNames.every((name) => /^20260101_人物A_\d{3}_/.test(name)));
  assert.ok(imageNames.some((name) => /_100_/.test(name)));
  assert.equal(index.get(first.mediaId).kind, "image");
  assert.match(filename(index, video), /^20260101_人物A_01_/);
});

test("first-save person label remains stable after display-name edits; new assets use new label", async (t) => {
  const { root, person, index } = await fixture(t);
  const old = await download(index, root, "old-label", source("old"));
  const edited = await openPersonMediaIndex({ ...person, name: "新名字" }, { requireExisting: true, writable: true });
  const newer = await download(edited, root, "new-label", source("new", { createdAt: "2026-01-01T02:00:00Z" }));
  await edited.finalizeNaming();
  assert.match(filename(edited, old), /^20260101_人物A_/);
  assert.match(filename(edited, newer), /^20260101_新名字_/);
  await edited.compact(); clearPersonMediaIndexCache(person.id);
  const again = await openPersonMediaIndex({ ...person, name: "再次修改" });
  assert.equal((await again.finalizeNaming()).renamed, 0);
  assert.match(filename(again, old), /^20260101_人物A_/);
});

test("occupied short name extends hash; all occupied suffixes fail without overwriting", async (t) => {
  const { root, index, person } = await fixture(t);
  const payload = "collision", mediaId = createHash("sha256").update(payload).digest("hex");
  const naming = { mediaId, kind: "image", extension: ".jpg", personLabel: person.name, publicationDate: "20260101", daySequence: 1, sequenceWidth: 2 };
  await mkdir(path.join(root, "Image"));
  const occupied = readableRelativePath(root, naming, 16);
  await writeFile(path.join(root, occupied), "user-owned file");
  const result = await download(index, root, payload, source("1"));
  assert.match(filename(index, result), new RegExp(`_${mediaId.slice(0, 24)}\\.jpg$`));
  assert.equal(await readFile(path.join(root, occupied), "utf8"), "user-owned file");
  const allPayload = "all-collisions", allId = createHash("sha256").update(allPayload).digest("hex");
  for (const size of [16, 24, 32, 64]) await writeFile(path.join(root, readableRelativePath(root, { ...naming, mediaId: allId, daySequence: 2 }, size)), "reserved");
  await assert.rejects(download(index, root, allPayload, source("2")), { code: "media-file-collision" });
  assert.equal(index.list().total, 1);
});

for (const phase of ["intent", "stage-1", "stage-2", "final-1", "final-2", "commit"]) {
  test(`interrupted rename recovers from ${phase}, preserves journal through compact, and resolves physical paths`, async (t) => {
    const { root, person, index } = await fixture(t);
    const later = await download(index, root, "later", source("later", { createdAt: "2026-01-01T02:00:00Z" }));
    const earlier = await download(index, root, "earlier", source("earlier"));
    const originalMove = index.moveRenameFile.bind(index), originalAppend = index.appendEvent.bind(index);
    let moves = 0;
    const target = { "stage-1": 1, "stage-2": 2, "final-1": 3, "final-2": 4 }[phase];
    index.moveRenameFile = async (...args) => {
      if (phase === "intent") throw Object.assign(new Error("player keeps file open"), { code: "EPERM" });
      await originalMove(...args); moves++;
      if (moves === target) throw Object.assign(new Error("interrupted after move"), { code: "EIO" });
    };
    index.appendEvent = async (event, signal) => {
      if (phase === "commit" && event.operation === "rename-commit") throw Object.assign(new Error("commit unavailable"), { code: "EIO" });
      return originalAppend(event, signal);
    };
    await assert.rejects(index.finalizeNaming(), { code: "media-naming-incomplete" });
    const journalPath = path.join(root, "Index", "events.jsonl");
    const journal = await readFile(journalPath, "utf8");
    assert.match(journal, /rename-intent/);
    const compactResult = await index.compact();
    assert.equal(compactResult.pending, true);
    assert.equal(await readFile(journalPath, "utf8"), journal);
    clearPersonMediaIndexCache(person.id);
    // Read-only API open discovers a true current path but does not move files.
    const readOnly = await openPersonMediaIndex(person, { requireExisting: true });
    const before = await readdir(path.join(root, "Image"));
    for (const result of [later, earlier]) {
      const resolved = await readOnly.resolve(result.mediaId);
      assert.equal(await readFile(resolved, "utf8"), result === later ? "later" : "earlier");
      assert.equal(readOnly.get(result.mediaId).relativePath, path.relative(root, resolved));
      assert.equal(await readOnly.has(result.mediaId), true);
    }
    assert.deepEqual(await readdir(path.join(root, "Image")), before);
    const recovered = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
    assert.match(filename(recovered, earlier), /^20260101_人物A_01_/);
    assert.match(filename(recovered, later), /^20260101_人物A_02_/);
    assert.equal((await recovered.finalizeNaming()).renamed, 0);
    assert.equal((await readdir(path.join(root, "Image"))).length, 2);
    await recovered.compact();
    assert.equal(await readFile(journalPath, "utf8"), "");
  });
}

test("cancellation after intent is resumable and opening dispatch is ordered against renaming", async (t) => {
  const { root, person, index } = await fixture(t);
  const later = await download(index, root, "later", source("later", { createdAt: "2026-01-01T02:00:00Z" }));
  await download(index, root, "earlier", source("earlier"));
  const controller = new AbortController(), originalAppend = index.appendEvent.bind(index);
  index.appendEvent = async (event, signal) => {
    await originalAppend(event, signal);
    if (event.operation === "rename-intent") controller.abort();
  };
  await assert.rejects(index.finalizeNaming({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(Object.keys(index.data.pendingRenames).length, 1);
  index.appendEvent = originalAppend;
  const order = [];
  let release;
  const opening = index.withAssetPath(later.mediaId, async (filePath) => {
    order.push("open");
    assert.equal(await readFile(filePath, "utf8"), "later");
    await new Promise((resolve) => { release = resolve; });
    assert.equal(await readFile(filePath, "utf8"), "later");
    order.push("opened");
  });
  const renaming = index.finalizeNaming().then(() => order.push("renamed"));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(order, ["open"]);
  release(); await Promise.all([opening, renaming]);
  assert.deepEqual(order, ["open", "opened", "renamed"]);
  clearPersonMediaIndexCache(person.id);
});

test("legacy version-1 indexes open safely and readable orphans recover only by full local hash", async (t) => {
  const { root, person, index } = await fixture(t);
  const result = await download(index, root, "legacy", source("1"));
  const oldPath = index.get(result.mediaId).relativePath;
  const oldFile = `${result.mediaId}.jpg`;
  await writeFile(path.join(root, "Image", oldFile), "legacy");
  await rm(path.join(root, oldPath));
  const fileInfo = await stat(path.join(root, "Image", oldFile));
  const asset = { mediaId: result.mediaId, sha256: result.mediaId, bytes: 6, kind: "image", extension: ".jpg", relativePath: path.join("Image", oldFile),
    savedAt: fileInfo.mtime.toISOString(), mtimeMs: fileInfo.mtimeMs, ctimeMs: fileInfo.ctimeMs, sources: {} };
  await writeFile(path.join(root, "Index", "media-index.json"), JSON.stringify({ version: 1, layout: "person-v1", personId: person.id, appliedSeq: 0, assets: { [result.mediaId]: asset } }));
  await writeFile(path.join(root, "Index", "events.jsonl"), "");
  clearPersonMediaIndexCache(person.id);
  const legacy = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(await legacy.has(result.mediaId), true);
  await legacy.addSource(result.mediaId, source("1"));
  await legacy.finalizeNaming();
  assert.match(filename(legacy, result), /^20260101_人物A_01_/);
  await legacy.compact();
  const orphanBytes = "unindexed readable", orphanHash = createHash("sha256").update(orphanBytes).digest("hex");
  const orphan = readableRelativePath(root, { mediaId: orphanHash, kind: "image", extension: ".jpg", personLabel: "人物A", publicationDate: "20260101", daySequence: 2 });
  await writeFile(path.join(root, orphan), orphanBytes);
  clearPersonMediaIndexCache(person.id);
  const recovered = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(recovered.get(orphanHash).recovered, true);
  assert.equal(recovered.get(orphanHash).relativePath, orphan);
  assert.equal(recovered.sources(orphanHash).length, 0);
  assert.equal(await recovered.has(orphanHash), true);
});

test("missing or corrupted rename source never becomes an empty successful index", async (t) => {
  const { root, person, index } = await fixture(t);
  const later = await download(index, root, "later", source("later", { createdAt: "2026-01-01T02:00:00Z" }));
  await download(index, root, "earlier", source("earlier"));
  index.moveRenameFile = async () => { throw Object.assign(new Error("network disconnected"), { code: "EIO" }); };
  await assert.rejects(index.finalizeNaming(), { code: "media-naming-incomplete" });
  const journal = await readFile(path.join(root, "Index", "events.jsonl"), "utf8");
  await rm(path.join(root, index.get(later.mediaId).relativePath));
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true, writable: true }), { code: "media-rename-conflict" });
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), journal);
  assert.equal((await readdir(path.join(root, "Image"))).length, 1);
});

test("clean incremental runs never probe old media; normal dirty-day renames do not rehash unchanged bytes", async (t) => {
  const { root, index } = await fixture(t);
  const oldDay = await download(index, root, "old-day", source("old", { publicationDate: "20251231", createdAt: "2025-12-31T01:00:00Z" }));
  const later = await download(index, root, "today-later", source("later", { createdAt: "2026-01-01T02:00:00Z" }));
  await index.finalizeNaming();
  const probes = [], originalInfo = index.safeFileInfo.bind(index);
  index.safeFileInfo = async (relativePath) => { probes.push(relativePath); return originalInfo(relativePath); };
  const reading = t.mock.method(fs, "createReadStream", () => { throw new Error("normal naming must not reread NAS media bytes"); });
  syncBuiltinESMExports();
  try {
    assert.equal((await index.finalizeNaming()).renamed, 0);
    assert.deepEqual(probes, []);
    await download(index, root, "today-earlier", source("earlier"));
    probes.length = 0;
    await index.finalizeNaming();
    assert.ok(probes.length > 0);
    assert.ok(probes.every((relativePath) => relativePath !== index.get(oldDay.mediaId).relativePath));
    assert.match(filename(index, later), /^20260101_人物A_02_/);
    probes.length = 0;
    assert.equal((await index.finalizeNaming()).renamed, 0);
    assert.deepEqual(probes, []);
    assert.equal(reading.mock.callCount(), 0);
  } finally { reading.mock.restore(); syncBuiltinESMExports(); }
});

test("dirty groups survive restart before any rename intent and clear only after successful completion", async (t) => {
  const { root, person, index } = await fixture(t);
  const later = await download(index, root, "later", source("later", { createdAt: "2026-01-01T02:00:00Z" }));
  await index.finalizeNaming();
  await download(index, root, "earlier", source("earlier"));
  await index.compact();
  const snapshot = JSON.parse(await readFile(path.join(root, "Index", "media-index.json"), "utf8"));
  assert.deepEqual(snapshot.dirtyNamingGroups, [["image", "20260101"].join("\0")]);
  clearPersonMediaIndexCache(person.id);
  const reloaded = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal((await reloaded.finalizeNaming()).renamed, 2);
  assert.match(filename(reloaded, later), /^20260101_人物A_02_/);
  await reloaded.compact();
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "Index", "media-index.json"), "utf8")).dirtyNamingGroups, []);
});

test("Beijing publication date is fixed across UTC boundaries, original offsets and machine timezone", async (t) => {
  const { root, index } = await fixture(t);
  const media = await download(index, root, "utc-day", source("utc", { createdAt: "2026-01-02T00:30:00+08:00", publicationDate: "20260102",
    dateBasis: "platform", displayTimeZone: "Asia/Shanghai" }));
  assert.match(filename(index, media), /^20260102_/);
  const saved = index.sources(media.mediaId)[0];
  assert.equal(saved.createdAt, "2026-01-02T00:30:00+08:00");
  assert.equal(saved.publicationDate, "20260102");
  assert.equal(saved.dateBasis, "created-at-beijing");
  assert.equal(saved.displayTimeZone, "Asia/Shanghai");
  await index.addSource(media.mediaId, source("utc", { createdAt: null, publicationDate: "20261231", dateBasis: "platform" }));
  assert.equal(index.sources(media.mediaId)[0].createdAt, saved.createdAt);
  assert.equal(index.sources(media.mediaId)[0].publicationDate, "20260102");
});

test("first collection fallback never rolls forward on resync or precedes a genuinely published source", async (t) => {
  const { root, person, index } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T23:50:00Z") });
  const missing = source("missing", { createdAt: null, publicationDate: null, dateBasis: "unknown" });
  const media = await download(index, root, "stable-fallback", missing);
  const firstSeenAt = index.sources(media.mediaId)[0].firstSeenAt;
  assert.match(filename(index, media), /^20260102_/);
  assert.equal(index.sources(media.mediaId)[0].dateBasis, "first-collected-beijing");
  await index.finalizeNaming();
  await index.compact(); clearPersonMediaIndexCache(person.id);
  t.mock.timers.setTime(new Date("2026-01-09T02:00:00Z").getTime());
  const reloaded = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  await reloaded.addSource(media.mediaId, missing);
  assert.equal(reloaded.sources(media.mediaId)[0].firstSeenAt, firstSeenAt);
  assert.equal(reloaded.sources(media.mediaId)[0].publicationDate, "20260102");
  assert.equal((await reloaded.finalizeNaming()).renamed, 0);
  await reloaded.addSource(media.mediaId, source("actually-published", { accountId: "B", createdAt: "2026-01-05T12:00:00Z" }));
  await reloaded.finalizeNaming();
  assert.match(filename(reloaded, media), /^20260105_/);
  assert.equal(reloaded.sources(media.mediaId).length, 2);
  assert.equal((await readdir(path.join(root, "Image"))).length, 1);
  for (const basis of ["first-collected-utc", "first-collected-beijing"]) {
    assert.ok(compareSources(source("published", { publicationDate: "20260105", dateBasis: "created-at-beijing" }),
      source("fallback", { publicationDate: "20260101", dateBasis: basis, createdAt: null })) < 0);
  }
});

test("older UTC dates do not trigger bulk startup rename; only a touched source marks corresponding Beijing day groups", async (t) => {
  const { root, person, index } = await fixture(t);
  const provenance = source("legacy-date", { createdAt: "2026-01-01T23:30:00Z", publicationDate: "20260101", dateBasis: "created-at-utc", displayTimeZone: "UTC" });
  const media = await download(index, root, "legacy-date", provenance);
  await index.finalizeNaming(); await index.compact();
  const snapshotPath = path.join(root, "Index", "media-index.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const oldAsset = snapshot.assets[media.mediaId];
  const currentPath = oldAsset.relativePath;
  oldAsset.publicationDate = "20260101";
  oldAsset.relativePath = readableRelativePath(root, oldAsset);
  await writeFile(path.join(root, oldAsset.relativePath), "legacy-date");
  await rm(path.join(root, currentPath));
  const info = await stat(path.join(root, oldAsset.relativePath));
  oldAsset.mtimeMs = info.mtimeMs; oldAsset.ctimeMs = info.ctimeMs;
  for (const stored of Object.values(oldAsset.sources)) Object.assign(stored, { publicationDate: "20260101", dateBasis: "created-at-utc", displayTimeZone: "UTC" });
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const savedSnapshot = await readFile(snapshotPath, "utf8");
  clearPersonMediaIndexCache(person.id);
  const reloaded = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(reloaded.sources(media.mediaId)[0].publicationDate, "20260102");
  assert.match(filename(reloaded, media), /^20260101_/);
  assert.deepEqual(reloaded.data.dirtyNamingGroups, []);
  assert.equal((await reloaded.finalizeNaming()).renamed, 0);
  assert.equal(await readFile(snapshotPath, "utf8"), savedSnapshot, "Opening old UTC sources must not rewrite the snapshot or rename history");
  await reloaded.addSource(media.mediaId, { ...provenance, createdAt: null, publicationDate: null, dateBasis: "unknown", displayTimeZone: null });
  assert.equal(reloaded.sources(media.mediaId)[0].createdAt, provenance.createdAt, "UTC-era publication instant survives a timestamp-omitting rescan");
  assert.equal(reloaded.sources(media.mediaId)[0].dateBasis, "created-at-beijing");
  assert.ok(reloaded.data.dirtyNamingGroups.includes(["image", "20260101"].join("\0")));
  assert.ok(reloaded.data.dirtyNamingGroups.includes(["image", "20260102"].join("\0")));
  assert.equal((await reloaded.finalizeNaming()).renamed, 1);
  assert.match(filename(reloaded, media), /^20260102_/);
  assert.equal(await reloaded.has(media.mediaId), true);
});

test("legacy sources lacking firstSeenAt fall back to asset's stable historical savedAt, never the load clock", async (t) => {
  const { root, person, index } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T16:30:00Z") });
  const media = await download(index, root, "legacy-no-seen", source("legacy-no-seen", { createdAt: null, publicationDate: null, dateBasis: "unknown" }));
  await index.finalizeNaming(); await index.compact();
  const snapshotPath = path.join(root, "Index", "media-index.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  for (const stored of Object.values(snapshot.assets[media.mediaId].sources)) {
    delete stored.firstSeenAt; delete stored.publicationDate; delete stored.dateBasis; delete stored.displayTimeZone;
  }
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  clearPersonMediaIndexCache(person.id);
  t.mock.timers.setTime(new Date("2026-02-20T00:00:00Z").getTime());
  const reloaded = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(reloaded.sources(media.mediaId)[0].firstSeenAt, "2026-01-01T16:30:00.000Z");
  assert.equal(reloaded.sources(media.mediaId)[0].publicationDate, "20260102");
  assert.equal(reloaded.sources(media.mediaId)[0].dateBasis, "first-collected-beijing");
  assert.equal((await reloaded.finalizeNaming()).renamed, 0);
});
