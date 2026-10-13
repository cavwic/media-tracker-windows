import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { detectBackupFormat, previewBackupImport, importBackupMedia } from "../lib/backup-import.mjs";
import { clearPersonMediaIndexCache, openPersonMediaIndex } from "../lib/person-media-index.mjs";
import { normalizePublicationDate } from "../lib/publication-date.mjs";
import { parseBackupImportArgs } from "../scripts/import-backup.mjs";

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (text) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(text)]);
const postSource = (key, overrides = {}) => ({ platformId: "x", platformLabel: "X", accountId: "a", accountLabel: "@accountA",
  logicalKey: key, postId: key.split(":")[0], postUrl: `https://x.com/accountA/status/${key.split(":")[0]}`,
  mediaIndex: 1, createdAt: "2026-01-01T18:00:00Z", ...overrides });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-media-import-"));
  const dataDir = path.join(root, "data"), backupRoot = path.join(root, "backup"), current = path.join(root, "current");
  await Promise.all([mkdir(dataDir), mkdir(backupRoot), mkdir(current)]);
  const person = { id: "person-a", name: "人物 A", folderPath: path.join(current, "人物 A"), platforms: [
    { id: "x", label: "X", accounts: [{ id: "a", label: "@accountA", folderName: "@accountA" }, { id: "b", label: "@accountB", folderName: "@accountB" }] },
    { id: "instagram", label: "Instagram", accounts: [{ id: "c", label: "accountC", folderName: "accountC" }] },
  ] };
  await mkdir(person.folderPath);
  const index = await openPersonMediaIndex(person, { create: true });
  const state = { persons: [person], linkedAccounts: [{ id: "private-account", doNotChange: "fixture" }], settings: { theme: "system" } };
  const global = { version: 3, layout: "person-v1", storageInitialized: { [person.id]: true },
    scopes: { "person-a:x:a": { initialComplete: true, knownPosts: { future: "2026-02-03T00:00:00Z" },
      lastSuccessfulSyncAt: "2026-10-02T00:00:00Z", pendingMedia: { retry: { postId: "retry" } }, media: {} } }, summaries: { [person.id]: { untouched: true } }, receipts: { [person.id]: { downloaded: 7 } } };
  const manifest = { version: 2, scopes: {}, summaries: {}, receipts: {} }, manifestFile = path.join(dataDir, "legacy.json");
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state, null, 2));
  await writeFile(path.join(dataDir, "sync-index.json"), JSON.stringify(global, null, 3));
  const options = { dataDir, backupRoot, manifestFile, importedAt: "2026-10-02T08:00:00Z", assertStopped: async () => {} };
  const flush = () => writeFile(manifestFile, JSON.stringify(manifest));
  const addLegacy = async ({ platformId = "x", accountId = "a", name = "20260101_1_01.jpg", folder = "Image", bytes = jpeg("old"), rows }) => {
    const platform = person.platforms.find((p) => p.id === platformId), account = platform.accounts.find((a) => a.id === accountId);
    const directory = path.join(backupRoot, person.name, platform.label, account.folderName, folder);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name); await writeFile(file, bytes);
    const scopeKey = `${person.id}:${platformId}:${accountId}`;
    const scope = manifest.scopes[scopeKey] ||= { media: {}, knownPosts: {} };
    for (const row of rows || [{ logicalKey: "1:1", postId: "1", createdAt: "2026-01-01T18:00:00Z" }]) {
      scope.media[row.logicalKey] = { postId: row.postId, kind: row.kind || "image", sha256: checksum(bytes), relativePath: `${folder}\\${name}`,
        savedAt: row.savedAt || "2026-01-03T09:00:00Z", ...(row.extra || {}) };
      scope.knownPosts[row.postId] = row.createdAt || true;
    }
    return file;
  };
  const currentDownload = async (bytes, source) => {
    const partialPath = path.join(person.folderPath, `.fixture-${Math.random().toString(36).slice(2)}.part`);
    await writeFile(partialPath, bytes);
    const result = await index.commitDownloaded({ partialPath, sha256: checksum(bytes), bytes: bytes.length, extension: ".jpg", mediaKind: "image", source });
    await index.finalizeNaming(); await index.compact(); return result;
  };
  const immutable = async () => Promise.all([readFile(path.join(dataDir, "state.json")), readFile(path.join(dataDir, "sync-index.json"))]);
  t.after(async () => { clearPersonMediaIndexCache(person.id); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, backupRoot, person, index, manifest, options, flush, addLegacy, currentDownload, immutable };
}

test("local preview is read-only; import deduplicates all sources, classifies real formats and is reentrant", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Import must never use a network API"); });
  const bytes = jpeg("same-image"), mediaId = checksum(bytes);
  await f.currentDownload(bytes, postSource("1:1", { firstSeenAt: "2026-10-01T00:00:00Z" }));
  const commonFile = await f.addLegacy({ bytes, rows: [{ logicalKey: "1:1", postId: "1", createdAt: "2026-01-01T18:00:00Z" },
    { logicalKey: "2:1", postId: "2", createdAt: "2025-12-31T08:00:00Z", extra: { duplicateOf: "Image\\20260101_1_01.jpg" } }] });
  await f.addLegacy({ accountId: "b", name: "20260102_3_01.jpg", bytes, rows: [{ logicalKey: "3:1", postId: "3", createdAt: "2026-01-02T00:00:00Z" }] });
  await f.addLegacy({ platformId: "instagram", accountId: "c", name: "20260102_Code4_01.jpg", bytes,
    rows: [{ logicalKey: "Code4:987654", postId: "Code4", createdAt: "2026-01-02T00:00:00Z" }] });
  const gif = Buffer.from("GIF89aactual-gif");
  await f.addLegacy({ name: "20260101_5_01.gif", folder: "gif", bytes: gif, rows: [{ logicalKey: "5:1", postId: "5", createdAt: "2026-01-01T01:00:00Z" }] });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom0000actual-mp4")]);
  await f.addLegacy({ name: "20260101_6_01.gif", folder: "gif", bytes: mp4, rows: [{ logicalKey: "6:1", postId: "6", createdAt: "2026-01-01T01:00:01Z", kind: "gif" }] });
  await writeFile(path.join(path.dirname(commonFile), "Thumbs.db"), "do not import");
  await mkdir(path.join(f.backupRoot, "Bing")); await writeFile(path.join(f.backupRoot, "Bing", "unconfigured.jpg"), bytes);
  await f.flush(); const immutable = await f.immutable();
  const before = await readFile(path.join(f.person.folderPath, "Index", "media-index.json"));
  const beforeFiles = await readdir(f.dataDir);
  const preview = await previewBackupImport(f.options);
  assert.equal(preview.totals.mediaFiles, 5); assert.equal(preview.totals.sources, 6);
  assert.equal(preview.totals.missingAssets, 2); assert.equal(preview.totals.existingAssets, 1);
  assert.deepEqual(await readFile(path.join(f.person.folderPath, "Index", "media-index.json")), before);
  assert.deepEqual(await readdir(f.dataDir), beforeFiles);
  const result = await importBackupMedia(f.options);
  assert.equal(result.completed, true); assert.equal(result.persons[0].copiedAssets, 2);
  assert.deepEqual(await f.immutable(), immutable);
  assert.deepEqual(await readFile(path.join(result.backupDirectory, "state.json")), immutable[0]);
  assert.deepEqual(await readFile(path.join(result.backupDirectory, "sync-index.json")), immutable[1]);
  assert.deepEqual(await readFile(path.join(result.backupDirectory, f.person.id, "media-index.json")), before);
  clearPersonMediaIndexCache(f.person.id);
  let index = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.equal(index.list().total, 3); assert.equal(index.sources(mediaId).length, 4);
  assert.match(index.get(mediaId).relativePath, /20251231_.+_01_/);
  const oldSource = index.sources(mediaId).find((s) => s.logicalKey === "1:1");
  assert.equal(oldSource.firstSeenAt, "2026-01-03T09:00:00Z");
  assert.equal(oldSource.backupImports[0].backupPath, commonFile);
  assert.equal(oldSource.backupImports[0].legacyPublicationDate, "20260101");
  assert.equal(oldSource.backupImports[0].importedAt, f.options.importedAt);
  assert.equal(index.get(checksum(gif)).kind, "image"); assert.equal(index.get(checksum(gif)).extension, ".gif");
  assert.equal(index.get(checksum(mp4)).kind, "video"); assert.equal(index.get(checksum(mp4)).extension, ".mp4");
  assert.equal((await readdir(path.join(f.person.folderPath, "Image"))).length, 2);
  assert.equal((await readdir(path.join(f.person.folderPath, "Video"))).length, 1);
  await assert.rejects(stat(path.join(f.person.folderPath, "gif")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(path.dirname(f.person.folderPath), "Bing")), { code: "ENOENT" });
  const allSources = index.list().items.map((a) => [a.mediaId, index.sources(a.mediaId)]);
  const second = await importBackupMedia({ ...f.options, importedAt: "2026-10-03T08:00:00Z" });
  assert.equal(second.completed, true); assert.equal(second.persons[0].copiedAssets, 0); assert.equal(second.persons[0].sourceUpdates, 0);
  clearPersonMediaIndexCache(f.person.id); index = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.deepEqual(index.list().items.map((a) => [a.mediaId, index.sources(a.mediaId)]), allSources);
  assert.deepEqual(await f.immutable(), immutable); assert.deepEqual(await readFile(commonFile), bytes);
});

test("the same logical source may retain distinct byte variants without altering current scope records", async (t) => {
  const f = await fixture(t), newer = jpeg("new transcoded version"), older = jpeg("old original version");
  const accurateUrl = "https://x.com/accountA/status/100?ref=original-source";
  const existing = await f.currentDownload(newer, postSource("100:1", { postUrl: accurateUrl }));
  await f.addLegacy({ name: "20260101_100_01.jpg", bytes: older, rows: [{ logicalKey: "100:1", postId: "100", createdAt: "2026-01-01T18:00:00Z" }] });
  await f.flush(); const immutable = await f.immutable();
  const result = await importBackupMedia(f.options); assert.equal(result.completed, true);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.equal(index.list().total, 2); assert.equal(index.sources(checksum(older))[0].logicalKey, "100:1");
  assert.equal(index.sources(existing.mediaId)[0].logicalKey, "100:1");
  assert.equal(index.sources(existing.mediaId)[0].postUrl, accurateUrl);
  assert.equal(index.sources(checksum(older))[0].postUrl, accurateUrl, "Different-byte variant inherits the precise current post URL, not a guess");
  assert.deepEqual(await readFile(await index.resolve(existing.mediaId)), newer);
  assert.deepEqual(await f.immutable(), immutable);
});

test("legacy filename evidence stays UTC; undated backup sources never use import time as publication", async (t) => {
  const f = await fixture(t);
  await f.addLegacy({ name: "20260101_1_01.jpg", bytes: jpeg("calendar-only"), rows: [{ logicalKey: "1:1", postId: "1" }] });
  await f.addLegacy({ name: "undated_2_01.jpg", bytes: jpeg("unknown date"), rows: [{ logicalKey: "2:1", postId: "2" }] });
  await f.flush(); const result = await importBackupMedia(f.options); assert.equal(result.completed, true);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true });
  const known = index.sources(checksum(jpeg("calendar-only")))[0], unknown = index.sources(checksum(jpeg("unknown date")))[0];
  assert.equal(known.publicationDate, "20260101"); assert.equal(known.dateBasis, "legacy-filename"); assert.equal(known.displayTimeZone, "UTC");
  assert.equal(unknown.publicationDate, null); assert.equal(unknown.dateBasis, "unknown");
  assert.match(index.get(checksum(jpeg("unknown date"))).relativePath, /^Image[\\/]日期未知_/);
  assert.deepEqual(normalizePublicationDate(unknown), { publicationDate: null, dateBasis: "unknown", displayTimeZone: null });
});

test("normal synchronization retains import provenance and only moves firstSeenAt earlier", async (t) => {
  const f = await fixture(t), bytes = jpeg("keep-provenance");
  await f.addLegacy({ bytes }); await f.flush(); await importBackupMedia(f.options);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true, writable: true });
  const hash = checksum(bytes), initial = index.sources(hash)[0];
  await index.addSource(hash, postSource("1:1", { firstSeenAt: "2026-10-04T00:00:00Z" }));
  assert.equal(index.sources(hash)[0].firstSeenAt, initial.firstSeenAt); assert.deepEqual(index.sources(hash)[0].backupImports, initial.backupImports);
  await index.addSource(hash, postSource("1:1", { firstSeenAt: "2025-12-30T00:00:00Z" }));
  assert.equal(index.sources(hash)[0].firstSeenAt, "2025-12-30T00:00:00Z"); assert.deepEqual(index.sources(hash)[0].backupImports, initial.backupImports);
  await index.addSource(hash, postSource("1:1", { postUrl: null }));
  assert.equal(index.sources(hash)[0].postUrl, initial.postUrl, "A rescan or import without a URL cannot erase the original link");
});

test("shared physical filenames do not replace attachment order or an unknown duplicate post's date", async (t) => {
  const f = await fixture(t), bytes = jpeg("same-post identical attachments");
  await f.addLegacy({ bytes, rows: [
    { logicalKey: "1:1", postId: "1" },
    { logicalKey: "1:2", postId: "1", extra: { duplicateOf: "Image\\20260101_1_01.jpg" } },
    { logicalKey: "2:1", postId: "2", extra: { duplicateOf: "Image\\20260101_1_01.jpg" } },
  ] });
  await f.flush(); const result = await importBackupMedia(f.options); assert.equal(result.completed, true);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true }), sources = index.sources(checksum(bytes));
  assert.equal(sources.find((s) => s.logicalKey === "1:2").mediaIndex, 2);
  assert.equal(sources.find((s) => s.logicalKey === "2:1").publicationDate, null);
  assert.equal(sources.find((s) => s.logicalKey === "2:1").dateBasis, "unknown");
  assert.equal(sources.find((s) => s.logicalKey === "2:1").backupImports[0].legacyPublicationDate, "20260101");
});

test("guard and shared maintenance lock prevent writes; mismatched source hashes are never attributed", async (t) => {
  const f = await fixture(t), bytes = jpeg("hash mismatch");
  await f.addLegacy({ bytes }); await f.flush(); const immutable = await f.immutable();
  await assert.rejects(importBackupMedia({ ...f.options, assertStopped: async () => { throw new Error("active service"); } }), /active service/);
  const lock = path.join(f.dataDir, ".readable-names-maintenance.lock"); await writeFile(lock, '{"token":"other-owner"}');
  await assert.rejects(importBackupMedia(f.options), { code: "backup-maintenance-busy" }); assert.equal(await readFile(lock, "utf8"), '{"token":"other-owner"}');
  await rm(lock);
  f.manifest.scopes[`${f.person.id}:x:a`].media["1:1"].sha256 = "a".repeat(64); await f.flush();
  const result = await importBackupMedia(f.options); assert.equal(result.completed, false); assert.equal(result.backupDirectory, null);
  assert.match(result.persons[0].errors.join(" "), /SHA-256/); assert.equal(result.totals.mediaFiles, 0);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true }); assert.equal(index.list().total, 0);
  assert.deepEqual(await f.immutable(), immutable); await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("initialized missing metadata and unsafe backup links cannot become an empty writable index", async (t) => {
  const f = await fixture(t); await f.addLegacy({}); await f.flush();
  const snapshot = path.join(f.person.folderPath, "Index", "media-index.json"); await rm(snapshot);
  await assert.rejects(importBackupMedia(f.options), { code: "ENOENT" });
  await assert.rejects(stat(snapshot), { code: "ENOENT" });
  clearPersonMediaIndexCache(f.person.id); await rm(path.join(f.person.folderPath, "Index"), { recursive: true });
  await openPersonMediaIndex(f.person, { create: true });
  const oldDirectory = path.join(f.backupRoot, f.person.name, "X", "@accountA", "Image");
  const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "20260101_1_01.jpg"), jpeg("old"));
  await rm(oldDirectory, { recursive: true });
  try { await symlink(outside, oldDirectory, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  const result = await importBackupMedia(f.options); assert.equal(result.completed, false); assert.equal(result.backupDirectory, null);
  assert.match(result.persons[0].errors.join(" "), /链接/);
});

test("cancellation after durable copy keeps media and pending naming; next import resumes without another copy", async (t) => {
  const f = await fixture(t), bytes = jpeg("cancelled after commit"); await f.addLegacy({ bytes }); await f.flush();
  const controller = new AbortController();
  const result = await importBackupMedia({ ...f.options, signal: controller.signal, onProgress: (p) => { if (p.phase === "import") controller.abort(); } });
  assert.equal(result.completed, false); assert.equal(result.cancelled, true); assert.equal(result.persons[0].copiedAssets, 1);
  assert.equal((await readdir(f.person.folderPath)).filter((x) => x.endsWith(".part")).length, 0);
  const second = await importBackupMedia(f.options); assert.equal(second.completed, true); assert.equal(second.persons[0].copiedAssets, 0);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true }); assert.equal(index.list().total, 1);
  assert.equal(index.sources(checksum(bytes)).length, 1); assert.deepEqual(await readFile(await index.resolve(checksum(bytes))), bytes);
});

test("failed journal write leaves an orphan safe to recover and reimport without losing its source", async (t) => {
  const f = await fixture(t), bytes = jpeg("journal failure"); await f.addLegacy({ bytes }); await f.flush();
  const probe = await open(path.join(f.root, "prototype-probe"), "w"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.write; let injected = false;
  const mock = t.mock.method(prototype, "write", async function (...args) {
    if (!injected && Buffer.isBuffer(args[0]) && args[0].toString("utf8").startsWith('{"operation":"upsert"')) {
      injected = true; throw Object.assign(new Error("injected journal failure"), { code: "EIO" });
    }
    return original.apply(this, args);
  });
  const result = await importBackupMedia(f.options); mock.mock.restore();
  assert.equal(injected, true); assert.equal(result.completed, false); assert.match(result.persons[0].errors.join(" "), /journal failure/);
  assert.equal((await readdir(path.join(f.person.folderPath, "Image"))).length, 1);
  const second = await importBackupMedia(f.options); assert.equal(second.completed, true); assert.equal(second.persons[0].copiedAssets, 0);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true }); assert.equal(index.list().total, 1);
  assert.equal(index.sources(checksum(bytes)).length, 1); assert.equal(index.sources(checksum(bytes))[0].backupImports.length, 1);
});

async function reviewedFixture(t) {
  const f = await fixture(t), original = jpeg("platform-original"), modified = jpeg("reviewed-rotated-reencoded");
  const originalResult = await f.currentDownload(original, postSource("100:1", { firstSeenAt: "2026-09-30T00:00:00Z" }));
  const file = await f.addLegacy({ name: "20260101_100_01.jpg", bytes: modified, rows: [{ logicalKey: "100:1", postId: "100", createdAt: "2026-01-01T18:00:00Z", savedAt: "2026-01-02T00:00:00Z" }] });
  f.manifest.scopes[`${f.person.id}:x:a`].media["100:1"].sha256 = checksum(original);
  await f.flush();
  const reviewedVariantsFile = path.join(f.dataDir, "reviewed-variants.json");
  const reviewed = { version: 1, variants: [{ backupPath: file, expectedSha256: checksum(original), observedSha256: checksum(modified), derivedFromMediaId: originalResult.mediaId,
    originalSource: { platformId: "x", accountId: "a", logicalKey: "100:1" }, evidence: { method: "local-rotation-reencode", details: "Reviewed local fixture: EXIF software, swapped dimensions and inverse-rotation pixel comparison." } }] };
  const saveReview = () => writeFile(reviewedVariantsFile, JSON.stringify(reviewed)); await saveReview();
  return { ...f, original, modified, originalResult, file, reviewedVariantsFile, reviewed, saveReview };
}

test("only an exact reviewed local variant may bypass SHA mismatch; it uses a distinct source and retains normal imports", async (t) => {
  const f = await reviewedFixture(t), immutable = await f.immutable();
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom0000missing-video")]);
  await f.addLegacy({ name: "20260102_101_01.mp4", folder: "Video", bytes: video, rows: [{ logicalKey: "101:1", postId: "101", createdAt: "2026-01-02T03:00:00Z", kind: "video" }] });
  await f.flush();
  const denied = await importBackupMedia(f.options); assert.equal(denied.completed, false); assert.equal(denied.backupDirectory, null);
  const result = await importBackupMedia({ ...f.options, reviewedVariantsFile: f.reviewedVariantsFile });
  assert.equal(result.completed, true); assert.equal(result.totals.localModified, 1); assert.equal(result.persons[0].localModifiedCopied, 1);
  assert.equal(result.persons[0].copiedAssets, 2); assert.deepEqual(await f.immutable(), immutable);
  assert.deepEqual(await readFile(path.join(result.backupDirectory, "reviewed-variants.json")), await readFile(f.reviewedVariantsFile));
  clearPersonMediaIndexCache(f.person.id); const index = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.equal(index.list().total, 3);
  const variant = index.sources(checksum(f.modified))[0];
  assert.equal(variant.logicalKey, `backup-variant:${checksum(f.modified)}:100:1`);
  assert.equal(variant.firstSeenAt, f.options.importedAt, "The expected old bytes' savedAt is not borrowed for modified bytes");
  assert.equal(variant.createdAt, "2026-01-01T18:00:00Z"); assert.equal(variant.publicationDate, "20260102");
  assert.equal(variant.backupImports[0].attributionEvidence, "local-modified");
  assert.equal(variant.backupImports[0].derivedFromMediaId, checksum(f.original));
  assert.equal(variant.backupImports[0].manifestExpectedSha256, checksum(f.original));
  assert.equal(variant.backupImports[0].observedSha256, checksum(f.modified));
  assert.deepEqual(variant.backupImports[0].originalSource, f.reviewed.variants[0].originalSource);
  assert.deepEqual(variant.backupImports[0].reviewEvidence, f.reviewed.variants[0].evidence);
  assert.equal(index.sources(checksum(f.original))[0].logicalKey, "100:1", "Original platform source remains a different asset and source key");
  assert.equal(index.sources(checksum(f.modified)).some((s) => s.logicalKey === "100:1"), false);
  assert.deepEqual(await readFile(await index.resolve(checksum(f.original))), f.original);
  assert.deepEqual(await readFile(f.file), f.modified);
  const second = await importBackupMedia({ ...f.options, reviewedVariantsFile: f.reviewedVariantsFile, importedAt: "2026-10-03T08:00:00Z" });
  assert.equal(second.completed, true); assert.equal(second.persons[0].copiedAssets, 0); assert.equal(second.persons[0].localModifiedCopied, 0);
  assert.equal(second.persons[0].localModifiedReused, 1); assert.equal(second.persons[0].sourceUpdates, 0);
  const reloaded = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.equal(reloaded.sources(checksum(f.modified))[0].firstSeenAt, f.options.importedAt);
});

test("reviewed variants require exact path/hash/source and locally complete original bytes before any mutation", async (t) => {
  const f = await reviewedFixture(t), initial = await readFile(path.join(f.person.folderPath, "Index", "media-index.json"));
  const mutate = [
    (r) => { r.variants[0].observedSha256 = "b".repeat(64); },
    (r) => { r.variants[0].originalSource.logicalKey = "100:2"; },
    (r) => { r.variants[0].derivedFromMediaId = "c".repeat(64); },
    (r) => { r.variants[0].evidence.method = "ignore-all-hash-errors"; },
    (r) => { r.variants[0].backupPath = path.join(f.root, "not-inside-backup.jpg"); },
    (r) => { r.variants.push({ ...r.variants[0] }); },
  ];
  const valid = structuredClone(f.reviewed);
  for (const change of mutate) {
    f.reviewed = structuredClone(valid); change(f.reviewed); await writeFile(f.reviewedVariantsFile, JSON.stringify(f.reviewed));
    await assert.rejects(importBackupMedia({ ...f.options, reviewedVariantsFile: f.reviewedVariantsFile }), { code: "backup-review-invalid" });
    assert.deepEqual(await readFile(path.join(f.person.folderPath, "Index", "media-index.json")), initial);
    await assert.rejects(stat(path.join(f.dataDir, "backups")), { code: "ENOENT" });
  }
  await writeFile(f.reviewedVariantsFile, JSON.stringify(valid));
  const index = await openPersonMediaIndex(f.person, { requireExisting: true });
  await writeFile(await index.resolve(checksum(f.original)), jpeg("tampered-original"));
  await assert.rejects(importBackupMedia({ ...f.options, reviewedVariantsFile: f.reviewedVariantsFile }), { code: "backup-review-invalid" });
  assert.deepEqual(await readFile(path.join(f.person.folderPath, "Index", "media-index.json")), initial);
});

test("already-existing actual variant bytes are reused, but original attribution is never borrowed as platform media", async (t) => {
  const f = await reviewedFixture(t);
  await f.currentDownload(f.modified, postSource("unrelated:1", { postId: "unrelated" }));
  const result = await importBackupMedia({ ...f.options, reviewedVariantsFile: f.reviewedVariantsFile });
  assert.equal(result.completed, true); assert.equal(result.persons[0].copiedAssets, 0);
  assert.equal(result.persons[0].localModifiedReused, 1);
  const index = await openPersonMediaIndex(f.person, { requireExisting: true });
  assert.equal(index.list().total, 2);
  const sources = index.sources(checksum(f.modified)); assert.equal(sources.length, 2);
  assert.equal(sources.some((s) => s.logicalKey === `backup-variant:${checksum(f.modified)}:100:1`), true);
  assert.equal(sources.some((s) => s.logicalKey === "100:1"), false);
});

test("format detection and CLI stay explicit and local", () => {
  assert.deepEqual(detectBackupFormat(Buffer.from("GIF89areal-gif"), "anything.mp4"), { extension: ".gif", kind: "image", formatEvidence: "magic" });
  assert.deepEqual(detectBackupFormat(Buffer.from("unknown signature"), "image.jpg"), { extension: ".jpg", kind: "image", formatEvidence: "extension-fallback" });
  assert.equal(detectBackupFormat(Buffer.from("unknown"), "Thumbs.db"), null);
  assert.equal(parseBackupImportArgs([]).apply, false); assert.equal(parseBackupImportArgs(["--apply"]).apply, true);
  assert.throws(() => parseBackupImportArgs(["--concurrency", "9"]), /1 至 8/);
  assert.equal(parseBackupImportArgs(["--reviewed-variants", "reviewed.json"]).reviewedVariantsFile, path.resolve("reviewed.json"));
});
