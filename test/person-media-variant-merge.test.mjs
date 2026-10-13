import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { clearPersonMediaIndexCache, openPersonMediaIndex } from "../lib/person-media-index.mjs";

const evidence = { algorithmVersion: "fixture-local-v1", preferredReason: "higher-source-resolution", comparisons: [{ score: 0.999 }] };
const source = (id, overrides = {}) => ({ platformId: "x", accountId: "a", logicalKey: `${id}:1`, postId: id,
  createdAt: "2026-10-05T00:00:00Z", mediaIndex: 1, ...overrides });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "person-variant-merge-"));
  const person = { id: path.basename(root), name: "本地人物", folderPath: root };
  t.after(async () => { clearPersonMediaIndexCache(person.id); await rm(root, { recursive: true, force: true }); });
  return { root, person, index: await openPersonMediaIndex(person, { create: true }) };
}

async function download(index, root, payload, provenance, extension = ".jpg") {
  const bytes = Buffer.from(payload), sha256 = createHash("sha256").update(bytes).digest("hex");
  const partialPath = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.part`);
  await writeFile(partialPath, bytes);
  return index.commitDownloaded({ partialPath, sha256, bytes: bytes.length, extension, source: provenance });
}

test("variant merge is local, keeps canonical SHA truthful, archives original bytes, and preserves every source", async (t) => {
  const { root, person, index } = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("variant merge must stay offline"); });
  const winner = await download(index, root, "higher-resolution-image", source("w", { platformId: "instagram" }));
  const loser = await download(index, root, "compressed-image", source("l", { createdAt: "2026-10-02T00:00:00Z" }));
  await index.addSource(loser.mediaId, source("l2", { accountId: "b" }));
  const result = await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  assert.deepEqual(result.merged, [loser.mediaId]);
  assert.equal(index.list().total, 1);
  assert.equal(index.list({ query: loser.mediaId }).total, 1);
  assert.equal(index.canonicalMediaId(loser.mediaId), winner.mediaId);
  assert.equal(index.get(loser.mediaId).mediaId, winner.mediaId);
  assert.equal(index.get(loser.mediaId).sha256, winner.mediaId);
  assert.equal(index.get(loser.mediaId).variant.sha256, loser.mediaId);
  assert.equal(Object.values(index.get(loser.mediaId).variant.originalSources).length, 2);
  assert.equal(index.sources(loser.mediaId).length, 3);
  assert.equal(await index.has(loser.mediaId), true);
  assert.equal(await index.resolve(loser.mediaId), await index.resolve(winner.mediaId));
  assert.equal(await readFile(path.join(root, result.archived[0].relativePath), "utf8"), "compressed-image");
  await assert.rejects(stat(path.join(root, loser.relativePath)), { code: "ENOENT" });
  await index.finalizeNaming();
  assert.match(path.basename(index.get(winner.mediaId).relativePath), /^20261002_本地人物_01_/);
  assert.equal(index.get(winner.mediaId).variantCount, 1);
  for (const occurrence of index.sources(winner.mediaId)) {
    assert.equal(occurrence.originMediaIds.length, 1);
    assert.equal(occurrence.originMediaIds[0], occurrence.postId === "w" ? winner.mediaId : loser.mediaId);
  }
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const reopened = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(reopened.list().total, 1);
  assert.equal(reopened.sources(loser.mediaId).length, 3);
  assert.equal(await reopened.withAssetPath(loser.mediaId, async (filePath, asset) => [path.basename(filePath), asset.mediaId]).then((v) => v[1]), winner.mediaId);
});

test("known exact variant commits keep one canonical file and original-hash attribution, rejecting forged hash/size", async (t) => {
  const { root, index } = await fixture(t);
  const winner = await download(index, root, "winner-longer", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  const repeated = await download(index, root, "loser", source("another", { platformId: "facebook" }));
  assert.equal(repeated.status, "content-duplicate");
  assert.equal(repeated.mediaId, winner.mediaId);
  assert.equal(repeated.sha256, winner.mediaId);
  assert.equal(repeated.originMediaId, loser.mediaId);
  assert.equal(repeated.bytes, "winner-longer".length);
  assert.deepEqual(index.sources(loser.mediaId).find((s) => s.postId === "another").originMediaIds, [loser.mediaId]);
  assert.equal(index.list().total, 1);
  assert.equal((await readdir(path.join(root, "Image"))).length, 1);
  const partialPath = path.join(root, "forged.part"); await writeFile(partialPath, "WRONG");
  await assert.rejects(index.commitDownloaded({ partialPath, sha256: loser.mediaId, bytes: 5, extension: ".jpg", source: source("forged") }), { code: "media-index-collision" });
  assert.equal(await readFile(partialPath, "utf8"), "WRONG");
});

test("alias addSource and same-key versions retain both observed hashes without duplicate source records", async (t) => {
  const { root, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("same"));
  const loser = await download(index, root, "loser", source("same"));
  await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  assert.equal(index.sources(loser.mediaId).length, 1);
  assert.deepEqual(new Set(index.sources(loser.mediaId)[0].originMediaIds), new Set([winner.mediaId, loser.mediaId]));
  await index.addSource(loser.mediaId, source("other", { accountId: "b" }));
  await index.addSource(loser.mediaId, source("other", { accountId: "b", accountLabel: "updated" }));
  assert.equal(index.sources(winner.mediaId).length, 2);
  assert.deepEqual(index.sources(winner.mediaId).find((s) => s.postId === "other").originMediaIds, [loser.mediaId]);
});

test("local-modified backup provenance remains valid against original variant ID after merge and reload", async (t) => {
  const { root, person, index } = await fixture(t);
  const original = "a".repeat(64), payload = "locally-modified-backup", observed = createHash("sha256").update(payload).digest("hex");
  const winner = await download(index, root, "quality-master", source("w"));
  const localSource = source("backup", { logicalKey: `backup-variant:${observed}:old:1`, backupImports: [{ backupPath: path.join(root, "old.jpg"), originalFileName: "old.jpg",
    importedAt: "2026-10-06T00:00:00Z", formatEvidence: "magic", attributionEvidence: "local-modified", derivedFromMediaId: original,
    manifestExpectedSha256: original, observedSha256: observed, originalSource: { platformId: "x", accountId: "a", logicalKey: "old:1" },
    reviewEvidence: { method: "local-rotation-reencode", details: "local review confirmed rotation" } }] });
  const loser = await download(index, root, payload, localSource);
  await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const reopened = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(reopened.sources(winner.mediaId).find((s) => s.postId === "backup").backupImports[0].observedSha256, observed);
  await reopened.addSource(loser.mediaId, localSource);
  assert.equal(reopened.sources(winner.mediaId).length, 2);
});

test("cancel after one archive move retains intent, read-only opens work, compact retains log, writable reopen completes", async (t) => {
  const { root, person, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const first = await download(index, root, "first-loser", source("f"));
  const second = await download(index, root, "second-loser", source("s"));
  const abort = new AbortController(), original = index.moveRenameFile.bind(index);
  let calls = 0;
  const mock = t.mock.method(index, "moveRenameFile", async (...args) => { await original(...args); if (++calls === 1) abort.abort(); });
  await assert.rejects(index.mergeVariants(winner.mediaId, [first.mediaId, second.mediaId], { evidence, signal: abort.signal }), { name: "AbortError" });
  mock.mock.restore();
  assert.equal(Object.keys(index.data.pendingMerges).length, 1);
  assert.equal(index.sources(first.mediaId).length, 1);
  assert.equal(await readFile(await index.resolve(first.mediaId), "utf8"), "first-loser");
  assert.deepEqual(await index.compact(), { pending: true });
  assert.match(await readFile(index.journalPath, "utf8"), /merge-intent/);
  clearPersonMediaIndexCache(person.id);
  const readOnly = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(readOnly.list().total, 3);
  assert.equal(await readFile(await readOnly.resolve(first.mediaId), "utf8"), "first-loser");
  const writable = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(writable.list().total, 1);
  assert.equal(writable.sources(winner.mediaId).length, 3);
  assert.equal(await writable.has(second.mediaId), true);
  await writable.compact();
  assert.equal(await readFile(writable.journalPath, "utf8"), "");
});

test("failed merge commit preserves archived file and recovery unions sources exactly once", async (t) => {
  const { root, person, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  const original = index.appendEvent.bind(index);
  const mock = t.mock.method(index, "appendEvent", async (details, signal) => {
    if (details.operation === "merge-commit") throw Object.assign(new Error("fixture NAS commit unavailable"), { code: "EIO" });
    return original(details, signal);
  });
  await assert.rejects(index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence }), { code: "media-dedup-incomplete" });
  mock.mock.restore();
  assert.equal(index.list().total, 2);
  assert.equal(await readFile(await index.resolve(loser.mediaId), "utf8"), "loser");
  clearPersonMediaIndexCache(person.id);
  const recovered = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(recovered.list().total, 1);
  assert.equal(recovered.sources(loser.mediaId).length, 2);
  assert.deepEqual((await recovered.mergeVariants(winner.mediaId, [loser.mediaId], { evidence })).merged, []);
});

test("intent write failure occurs before any media move", async (t) => {
  const { root, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  const original = index.appendEvent.bind(index);
  t.mock.method(index, "appendEvent", async (details, signal) => {
    if (details.operation === "merge-intent") throw Object.assign(new Error("fixture intent write failure"), { code: "EIO" });
    return original(details, signal);
  });
  await assert.rejects(index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence }), { code: "EIO" });
  assert.equal(await readFile(path.join(root, loser.relativePath), "utf8"), "loser");
  assert.equal(index.list().total, 2);
  assert.equal(Object.keys(index.data.pendingMerges).length, 0);
});

test("occupied archive path is not replaced and remains a recoverable incomplete merge", async (t) => {
  const { root, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  const original = index.moveRenameFile.bind(index);
  t.mock.method(index, "moveRenameFile", async (fromPath, toPath) => {
    await writeFile(path.join(root, toPath), "unrelated-existing-file");
    return original(fromPath, toPath);
  });
  await assert.rejects(index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence }), { code: "media-dedup-incomplete" });
  const batch = Object.values(index.data.pendingMerges)[0];
  assert.equal(await readFile(path.join(root, batch.entries[0].archivePath), "utf8"), "unrelated-existing-file");
  assert.equal(await readFile(path.join(root, loser.relativePath), "utf8"), "loser");
  assert.equal(index.list().total, 2);
});

test("nested aliases flatten when preferred version changes and old IDs remain usable", async (t) => {
  const { root, person, index } = await fixture(t);
  const a = await download(index, root, "version-a", source("a"));
  const b = await download(index, root, "version-b", source("b"));
  const c = await download(index, root, "version-c-best", source("c"));
  await index.mergeVariants(b.mediaId, [a.mediaId], { evidence });
  await index.mergeVariants(c.mediaId, [b.mediaId], { evidence });
  for (const id of [a.mediaId, b.mediaId, c.mediaId]) assert.equal(index.canonicalMediaId(id), c.mediaId);
  assert.equal(index.sources(a.mediaId).length, 3);
  assert.equal(index.list().total, 1);
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const reopened = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(await reopened.has(a.mediaId), true);
  assert.equal(reopened.get(c.mediaId).variantCount, 2);
});

test("fingerprints persist with a truthful file stamp and reject stale computation or modified files", async (t) => {
  const { root, person, index } = await fixture(t);
  const media = await download(index, root, "sample-file", source("w"));
  const asset = index.get(media.mediaId), info = await stat(await index.resolve(media.mediaId));
  const fileStamp = { sha256: media.mediaId, bytes: asset.bytes, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  await index.setSimilarityFingerprint(media.mediaId, { algorithmVersion: "v1", pHash: "0123456789abcdef", fileStamp });
  await index.withAssetPath(media.mediaId, async (filePath, metadata) => {
    assert.equal(metadata.mediaId, media.mediaId);
    assert.equal(metadata.similarityFingerprint, undefined);
    assert.equal(await readFile(filePath, "utf8"), "sample-file");
  });
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const reopened = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(reopened.get(media.mediaId).similarityFingerprint.fileStamp.sha256, media.mediaId);
  assert.equal(index.list().items[0].similarityFingerprint, undefined);
  await assert.rejects(reopened.setSimilarityFingerprint(media.mediaId, { fileStamp: { ...fileStamp, mtimeMs: fileStamp.mtimeMs - 1 } }), { code: "media-fingerprint-stale" });
  await writeFile(await reopened.resolve(media.mediaId), "other-bytes");
  await assert.rejects(reopened.setSimilarityFingerprint(media.mediaId, { pHash: "new" }), { code: "media-not-found" });
});

test("torn merge commit is repaired on restart without losing original bytes or source associations", async (t) => {
  const { root, person, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  const probe = await open(path.join(root, "probe"), "w"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.write;
  const mock = t.mock.method(prototype, "write", async function (buffer, offset, length, position) {
    if (buffer.subarray(offset, offset + length).toString("utf8").startsWith('{"operation":"merge-commit"')) {
      await original.call(this, buffer, offset, 11, position);
      throw Object.assign(new Error("fixture torn commit"), { code: "EIO" });
    }
    return original.call(this, buffer, offset, length, position);
  });
  await assert.rejects(index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence }), { code: "media-dedup-incomplete" });
  mock.mock.restore();
  assert.equal(index.list().total, 2);
  assert.equal(await readFile(await index.resolve(loser.mediaId), "utf8"), "loser");
  clearPersonMediaIndexCache(person.id);
  const recovered = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(recovered.list().total, 1);
  assert.equal(recovered.sources(winner.mediaId).length, 2);
  assert.equal(recovered.get(loser.mediaId).variant.sha256, loser.mediaId);
  assert.equal(await readFile(path.join(root, recovered.get(loser.mediaId).variant.archivePath), "utf8"), "loser");
});

test("same source variants retain each original timestamp and metadata in recoverable version records", async (t) => {
  const { root, person, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("same", { createdAt: "2026-10-05T00:00:00Z", postUrl: "https://x.com/a/status/same" }));
  const loser = await download(index, root, "loser", source("same", { createdAt: "2026-10-02T00:00:00Z", postUrl: "https://x.com/a/status/old" }));
  await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  assert.equal(index.sources(winner.mediaId).length, 1);
  const originalSource = Object.values(index.get(loser.mediaId).variant.originalSources)[0];
  assert.equal(originalSource.createdAt, "2026-10-02T00:00:00Z");
  assert.equal(originalSource.postUrl, "https://x.com/a/status/old");
  await index.compact(); clearPersonMediaIndexCache(person.id);
  const reopened = await openPersonMediaIndex(person, { requireExisting: true });
  assert.deepEqual(Object.values(reopened.get(loser.mediaId).variant.originalSources)[0], originalSource);
});

test("invalid target types and cross-person unknown hashes fail without a merge intent", async (t) => {
  const { root, index } = await fixture(t);
  const image = await download(index, root, "image", source("i"));
  const video = await download(index, root, "video", source("v"), ".mp4");
  await assert.rejects(index.mergeVariants(image.mediaId, [video.mediaId], { evidence }), { code: "media-dedup-invalid" });
  await assert.rejects(index.mergeVariants(image.mediaId, ["f".repeat(64)], { evidence }), { code: "media-not-found" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(index.mergeVariants(image.mediaId, [video.mediaId], { evidence, signal: abort.signal }), { name: "AbortError" });
  assert.equal(index.list().total, 2);
  assert.equal(Object.keys(index.data.pendingMerges).length, 0);
});

test("archive links outside person root are refused without moving original files", async (t) => {
  const { root, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "variant-archive-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try { await symlink(outside, path.join(root, "Index", "DedupArchive"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  await assert.rejects(index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence }), { code: "media-path-unsafe" });
  assert.equal(await readFile(path.join(root, loser.relativePath), "utf8"), "loser");
  assert.deepEqual(await readdir(outside), []);
});

test("malformed merge journal and cyclic snapshot aliases are errors, never an empty reset", async (t) => {
  const { root, person, index } = await fixture(t);
  const winner = await download(index, root, "winner", source("w"));
  const loser = await download(index, root, "loser", source("l"));
  await index.mergeVariants(winner.mediaId, [loser.mediaId], { evidence });
  await index.compact();
  const snapshotPath = index.snapshotPath, snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.aliases[loser.mediaId].canonicalMediaId = loser.mediaId;
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true, writable: true }), { code: "media-index-corrupt" });
  snapshot.aliases[loser.mediaId].canonicalMediaId = winner.mediaId;
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  await appendFile(index.journalPath, `${JSON.stringify({ personId: person.id, seq: snapshot.appliedSeq + 1, operation: "merge-commit", batchId: "00000000-0000-0000-0000-000000000000" })}\n`);
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person), { code: "media-journal-corrupt" });
  assert.equal(await readFile(path.join(root, winner.relativePath), "utf8"), "winner");
});
