import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { clearPersonMediaIndexCache, openPersonMediaIndex } from "../lib/person-media-index.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "person-media-index-"));
  const person = { id: path.basename(root), folderPath: root };
  t.after(async () => { clearPersonMediaIndexCache(person.id); await rm(root, { recursive: true, force: true }); });
  return { root, person };
}

const source = (logicalKey, overrides = {}) => ({ platformId: "x", platformLabel: "X", accountId: "account-a", accountLabel: "A",
  logicalKey, postId: logicalKey.split(":")[0], postUrl: `https://x.com/A/status/${logicalKey.split(":")[0]}`,
  createdAt: "2026-10-02T01:02:03.000Z", mediaIndex: 1, ...overrides });

async function download(index, root, bytes, extension, provenance, mediaKind = "image") {
  const payload = Buffer.from(bytes);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const partialPath = path.join(root, `.media-tracker-${Math.random().toString(36).slice(2)}.part`);
  await writeFile(partialPath, payload);
  return index.commitDownloaded({ partialPath, sha256, bytes: payload.length, extension, mediaKind, source: provenance });
}

test("person index is entirely local, deduplicates across accounts/platforms, and retains each occurrence", async (t) => {
  const { root, person } = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Deduplication must not access any network API"); });
  const index = await openPersonMediaIndex(person, { create: true });
  assert.deepEqual(await readdir(root), ["Index"]);
  const first = await download(index, root, "identical-image", ".jpg", source("1:1"));
  const again = await download(index, root, "identical-image", ".jpg", source("2:1"));
  const accountB = await download(index, root, "identical-image", ".jpeg", source("3:1", { accountId: "account-b", accountLabel: "B" }));
  const platformB = await download(index, root, "identical-image", ".jpg", source("4:1", { platformId: "instagram", platformLabel: "Instagram" }));
  const repeat = await download(index, root, "identical-image", ".jpg", source("1:1"));
  assert.equal(first.status, "downloaded");
  for (const result of [again, accountB, platformB, repeat]) {
    assert.equal(result.status, "content-duplicate");
    assert.equal(result.mediaId, first.mediaId);
  }
  assert.equal(index.sources(first.mediaId).length, 4);
  assert.equal(index.list().items[0].sourceCount, 4);
  assert.deepEqual(await readdir(path.join(root, "Image")), [path.basename(first.relativePath)]);
  assert.match(path.basename(first.relativePath), new RegExp(`^20261002_.+_01_${first.mediaId.slice(0, 16)}\\.jpg$`));
  await assert.rejects(stat(path.join(root, "Video")), { code: "ENOENT" });
  const firstSeenAt = index.sources(first.mediaId)[0].firstSeenAt;
  await index.addSource(first.mediaId, source("1:1", { accountLabel: "Renamed" }));
  assert.equal(index.sources(first.mediaId)[0].firstSeenAt, firstSeenAt);
  assert.equal(index.sources(first.mediaId)[0].accountLabel, "Renamed");
  assert.equal(index.sources(first.mediaId).length, 4);
  assert.equal(await index.has(first.mediaId), true);
  assert.equal(await index.resolve(first.mediaId), path.join(root, first.relativePath));
  assert.equal(await readFile(path.join(root, first.relativePath), "utf8"), "identical-image");
});

test("Beijing midnight groups remain separate and preserve chronological numbering through restart", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  const beforeMidnight = await download(index, root, "before-Beijing-midnight", ".jpg", source("1:1", { createdAt: "2026-01-01T15:59:59Z" }));
  const nextDaySecond = await download(index, root, "second-next-day", ".jpg", source("3:1", { createdAt: "2026-01-02T00:01:00+08:00" }));
  const nextDayFirst = await download(index, root, "first-next-day", ".jpg", source("2:1", { createdAt: "2026-01-01T16:00:00Z", publicationDate: "20260101", dateBasis: "created-at-utc", displayTimeZone: "UTC" }));
  await index.finalizeNaming();
  assert.match(path.basename(index.get(beforeMidnight.mediaId).relativePath), /^20260101_.+_01_/);
  assert.match(path.basename(index.get(nextDayFirst.mediaId).relativePath), /^20260102_.+_01_/);
  assert.match(path.basename(index.get(nextDaySecond.mediaId).relativePath), /^20260102_.+_02_/);
  assert.equal(index.sources(nextDayFirst.mediaId)[0].dateBasis, "created-at-beijing");
  assert.equal(index.sources(nextDayFirst.mediaId)[0].displayTimeZone, "Asia/Shanghai");
  await index.compact(); clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  await index.addSource(nextDayFirst.mediaId, source("2:1", { createdAt: null, publicationDate: null, dateBasis: "unknown" }));
  assert.equal(index.sources(nextDayFirst.mediaId)[0].createdAt, "2026-01-01T16:00:00Z");
  assert.equal((await index.finalizeNaming()).renamed, 0);
  assert.equal(index.list().total, 3);
  for (const result of [beforeMidnight, nextDayFirst, nextDaySecond]) assert.equal(await index.has(result.mediaId), true);
});

test("distinct bytes and distinct persons are never merged; GIF and animated MP4 use actual extension", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const image = await download(index, root, "image-one", ".jpg", source("1:1"));
  const distinct = await download(index, root, "image-two", ".jpg", source("2:1"));
  const gif = await download(index, root, "gif-bytes", ".gif", source("3:1"), "gif");
  const mp4 = await download(index, root, "video-bytes", ".mp4", source("4:1"), "gif");
  assert.notEqual(distinct.mediaId, image.mediaId);
  assert.equal(gif.kind, "image");
  assert.match(gif.relativePath, /^Image[\\/]/);
  assert.equal(mp4.kind, "video");
  assert.match(mp4.relativePath, /^Video[\\/]/);
  await assert.rejects(stat(path.join(root, "gif")), { code: "ENOENT" });
  const secondPerson = { id: `${person.id}-other`, folderPath: path.join(root, "other") };
  t.after(() => clearPersonMediaIndexCache(secondPerson.id));
  const secondIndex = await openPersonMediaIndex(secondPerson, { create: true });
  const copied = await download(secondIndex, secondPerson.folderPath, "image-one", ".jpg", source("1:1"));
  assert.equal(copied.status, "downloaded");
  assert.equal(index.list().total, 4);
  assert.equal(secondIndex.list().total, 1);
});

test("journal replays and compacts atomically; pagination and source clones survive reload", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "first", ".png", source("1:1"));
  await download(index, root, "second", ".webm", source("2:1"), "video");
  assert.equal(index.list({ offset: 1, limit: 1 }).items.length, 1);
  assert.equal(index.list({ query: first.mediaId }).total, 1);
  const cloned = index.sources(first.mediaId); cloned[0].accountId = "tampered";
  assert.equal(index.sources(first.mediaId)[0].accountId, "account-a");
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person);
  assert.equal(index.list().total, 2);
  assert.equal(index.sources(first.mediaId)[0].postUrl, "https://x.com/A/status/1");
  await index.compact();
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), "");
  const snapshot = JSON.parse(await readFile(path.join(root, "Index", "media-index.json"), "utf8"));
  assert.equal(snapshot.appliedSeq, 2);
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person);
  assert.equal(index.list().total, 2);
  await index.addSource(first.mediaId, source("3:1"));
  const event = JSON.parse((await readFile(path.join(root, "Index", "events.jsonl"), "utf8")).trim());
  assert.equal(event.seq, 3);
});

test("only a truncated final journal line is recoverable, while middle corruption and gaps fail", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "durable", ".jpg", source("1:1"));
  const journalPath = path.join(root, "Index", "events.jsonl");
  const valid = await readFile(journalPath, "utf8");
  await appendFile(journalPath, '{"seq":2,"operation":"ups');
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person); // A read does not mutate the tail.
  assert.equal(index.list().total, 1);
  assert.match(await readFile(journalPath, "utf8"), /"ups$/);
  await index.addSource(first.mediaId, source("2:1"));
  assert.equal(index.sources(first.mediaId).length, 2);
  assert.equal((await readFile(journalPath, "utf8")).trim().split("\n").length, 2);
  await writeFile(journalPath, `${valid}{BROKEN}\n${valid}`);
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person), { code: "media-journal-corrupt" });
  const event = JSON.parse(valid); event.seq = 5;
  await writeFile(journalPath, `${JSON.stringify(event)}\n`);
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person), { code: "media-journal-corrupt" });
});

test("deterministic orphan recovery retains completed bytes after a journal write failure", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const journalPath = path.join(root, "Index", "events.jsonl");
  const handle = await open(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(handle); await handle.close();
  const originalWrite = prototype.write;
  const writeMock = t.mock.method(prototype, "write", async function (buffer, offset, length, position) {
    if (buffer.subarray(offset, offset + length).toString("utf8").startsWith('{"operation":')) {
      await originalWrite.call(this, buffer, offset, 5, position);
      throw Object.assign(new Error("fixture torn journal write"), { code: "EIO" });
    }
    return originalWrite.call(this, buffer, offset, length, position);
  });
  await assert.rejects(download(index, root, "orphan-video", ".mp4", source("1:1"), "video"), { code: "EIO" });
  writeMock.mock.restore();
  const saved = await readdir(path.join(root, "Video"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].endsWith(".mp4"), true);
  clearPersonMediaIndexCache(person.id);
  const recovered = await openPersonMediaIndex(person, { create: true });
  assert.equal(recovered.list().total, 1);
  const mediaId = recovered.list().items[0].mediaId;
  assert.equal(recovered.sources(mediaId).length, 0);
  const repeated = await download(recovered, root, "orphan-video", ".mp4", source("1:1"), "video");
  assert.equal(repeated.status, "content-duplicate");
  assert.equal(recovered.sources(mediaId).length, 1);
  assert.deepEqual(await readdir(path.join(root, "Video")), saved);
});

test("short writes and failed journal fsync do not acknowledge success, and the queue recovers", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const handle = await open(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const originalWrite = prototype.write;
  const writeMock = t.mock.method(prototype, "write", function (buffer, offset, length, position) {
    return originalWrite.call(this, buffer, offset, Math.min(7, length), position);
  });
  const first = await download(index, root, "short-write-image", ".jpg", source("1:1"));
  assert.ok(writeMock.mock.callCount() > 1);
  const originalSync = prototype.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(prototype, "sync", function () {
    syncCalls += 1;
    if (syncCalls === 2) throw Object.assign(new Error("fixture journal fsync failure"), { code: "EIO" });
    return originalSync.call(this);
  });
  await assert.rejects(download(index, root, "fsync-failed-image", ".jpg", source("2:1")), { code: "EIO" });
  syncMock.mock.restore();
  const retried = await download(index, root, "fsync-failed-image", ".jpg", source("2:1"));
  assert.equal(retried.status, "content-duplicate");
  assert.equal(index.sources(retried.mediaId).length, 1);
  assert.equal(await index.has(first.mediaId), true);
});

test("read-only opens never create directories, ownership conflicts and missing initialized paths fail", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person);
  assert.equal(index.list().total, 0);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true }), { code: "media-index-missing" });
  index = await openPersonMediaIndex(person, { create: true });
  await download(index, root, "owned-image", ".jpg", source("1:1"));
  await index.compact();
  await assert.rejects(openPersonMediaIndex({ ...person, id: "different-person" }, { create: true }), { code: "media-index-owner-conflict" });
  await rm(path.join(root, "Index"), { recursive: true });
  await assert.rejects(openPersonMediaIndex(person, { create: true }), { code: "ENOENT" });
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true }), { code: "media-index-missing" });
  await rm(root, { recursive: true });
  await assert.rejects(openPersonMediaIndex(person), { code: "ENOENT" });
});

test("a media link cannot escape the person folder, and cancellation does not commit", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "safe-image", ".jpg", source("1:1"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "person-media-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, path.basename(first.relativePath)), "safe-image");
  await rm(path.join(root, "Image"), { recursive: true });
  try { await symlink(outside, path.join(root, "Image"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  await assert.rejects(index.resolve(first.mediaId), { code: "media-path-unsafe" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(index.commitDownloaded({}, { signal: abort.signal }), { name: "AbortError" });
  assert.equal(index.list().total, 1);
});

test("parallel same-person commits serialize one physical file and all sources", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const results = await Promise.all(Array.from({ length: 8 }, (_, offset) => download(index, root, "parallel-identical", ".jpg", source(`${offset + 1}:1`))));
  assert.equal(results.filter((result) => result.status === "downloaded").length, 1);
  assert.equal(index.list().total, 1);
  assert.equal(index.sources(results[0].mediaId).length, 8);
  assert.equal((await readdir(path.join(root, "Image"))).length, 1);
});

test("same-size modifications never cause a newly downloaded good file to be discarded as duplicate", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "original", ".jpg", source("1:1"));
  const filePath = path.join(root, first.relativePath);
  await writeFile(filePath, "tampered");
  await utimes(filePath, new Date(), new Date(Date.now() + 10_000));
  assert.equal(await index.has(first.mediaId), false);
  await assert.rejects(download(index, root, "original", ".jpg", source("2:1")), { code: "media-file-collision" });
  assert.equal(await readFile(filePath, "utf8"), "tampered", "Unexpected user file is never overwritten");
  const partials = (await readdir(root)).filter((name) => name.endsWith(".part"));
  assert.equal(partials.length, 1, "Downloaded original bytes stay available after a collision");
  assert.equal(await readFile(path.join(root, partials[0]), "utf8"), "original");
  assert.equal(index.sources(first.mediaId).length, 1);
});

test("missing initialized snapshot never becomes an empty writable index, with or without cache", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "metadata-protected", ".jpg", source("1:1"));
  await index.compact();
  await rm(path.join(root, "Index", "media-index.json"));
  await assert.rejects(openPersonMediaIndex(person, { create: true, requireExisting: true }), { code: "ENOENT" });
  await assert.rejects(index.addSource(first.mediaId, source("2:1")), { code: "ENOENT" });
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person, { create: true, requireExisting: true }), { code: "media-index-missing" });
  await assert.rejects(stat(path.join(root, "Index", "media-index.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), "");
  assert.equal(await readFile(path.join(root, first.relativePath), "utf8"), "metadata-protected");
});

test("snapshot failure leaves the durable journal intact; old covered events are safe to replay", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "journal-survives", ".jpg", source("1:1"));
  const journalPath = path.join(root, "Index", "events.jsonl");
  const events = await readFile(journalPath, "utf8");
  const handle = await open(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(handle); await handle.close();
  const syncMock = t.mock.method(prototype, "sync", () => { throw Object.assign(new Error("snapshot storage unavailable"), { code: "EIO" }); });
  await assert.rejects(index.compact(), { code: "EIO" });
  syncMock.mock.restore();
  assert.equal(await readFile(journalPath, "utf8"), events);
  assert.equal(JSON.parse(await readFile(path.join(root, "Index", "media-index.json"), "utf8")).appliedSeq, 0);
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person);
  assert.equal(await index.has(first.mediaId), true);
  await index.compact();
  await writeFile(journalPath, events); // Simulates crash after snapshot rename and before clearing old events.
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person);
  assert.equal(index.list().total, 1);
  assert.equal(index.sources(first.mediaId).length, 1);
  await index.addSource(first.mediaId, source("2:1"));
  assert.equal(index.sources(first.mediaId).length, 2);
});

test("Windows path case aliases reuse one cached writer and cannot create conflicting sequence numbers", { skip: process.platform !== "win32" }, async (t) => {
  const { root, person } = await fixture(t);
  const first = await openPersonMediaIndex(person, { create: true });
  const alias = await openPersonMediaIndex({ ...person, folderPath: root.toUpperCase() }, { writable: true, requireExisting: true });
  assert.equal(alias, first);
  const results = await Promise.all([
    download(first, root, "same-casealias-image", ".jpg", source("1:1")),
    download(alias, root.toUpperCase(), "same-casealias-image", ".jpg", source("2:1")),
  ]);
  assert.equal(results.filter((result) => result.status === "downloaded").length, 1);
  assert.equal(first.sources(results[0].mediaId).length, 2);
  const events = (await readFile(path.join(root, "Index", "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
});

test("writable sync opens recover durable orphan files; read-only queries leave the index unchanged", async (t) => {
  const { root, person } = await fixture(t);
  let index = await openPersonMediaIndex(person, { create: true });
  await index.compact();
  const payload = Buffer.from("rename-before-journal-crash");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  await mkdir(path.join(root, "Image"));
  await writeFile(path.join(root, "Image", `${sha256}.jpg`), payload);
  clearPersonMediaIndexCache(person.id);
  index = await openPersonMediaIndex(person, { requireExisting: true });
  assert.equal(index.list().total, 0);
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), "");
  const writable = await openPersonMediaIndex(person, { requireExisting: true, writable: true });
  assert.equal(writable, index);
  assert.equal(index.list().total, 1);
  assert.equal(index.sources(sha256).length, 0);
  assert.equal(await index.has(sha256), true);
  await index.addSource(sha256, source("1:1"));
  assert.equal(index.sources(sha256).length, 1);
});

test("cached failed-append reload cannot recreate a removed snapshot or alter its old authority", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  const first = await download(index, root, "cached-authority", ".jpg", source("1:1"));
  await index.compact();
  const handle = await open(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(handle); await handle.close();
  const originalSync = prototype.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(prototype, "sync", function () {
    syncCalls += 1;
    if (syncCalls === 2) throw Object.assign(new Error("fixture journal failure"), { code: "EIO" });
    return originalSync.call(this);
  });
  await assert.rejects(download(index, root, "failed-append", ".jpg", source("2:1")), { code: "EIO" });
  syncMock.mock.restore();
  await rm(path.join(root, "Index", "media-index.json"));
  const priorJournal = await readFile(path.join(root, "Index", "events.jsonl"), "utf8");
  await assert.rejects(index.addSource(first.mediaId, source("3:1")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), priorJournal);
  await assert.rejects(stat(path.join(root, "Index", "media-index.json")), { code: "ENOENT" });
  assert.equal(index.sources(first.mediaId).length, 1);
});

test("a missing initialized journal is rejected after restart instead of losing unsnapshotted sources", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  await download(index, root, "journal-only-asset", ".jpg", source("1:1"));
  await rm(path.join(root, "Index", "events.jsonl"));
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true, writable: true }), { code: "ENOENT" });
  clearPersonMediaIndexCache(person.id);
  await assert.rejects(openPersonMediaIndex(person, { requireExisting: true, writable: true }), { code: "media-index-missing" });
  await assert.rejects(stat(path.join(root, "Index", "events.jsonl")), { code: "ENOENT" });
});

test("cached snapshot ownership replacement never gets overwritten by the old instance", async (t) => {
  const { root, person } = await fixture(t);
  const index = await openPersonMediaIndex(person, { create: true });
  await download(index, root, "owned-by-original", ".jpg", source("1:1"));
  await index.compact();
  const snapshotPath = path.join(root, "Index", "media-index.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.personId = "replacement-person-with-different-owner";
  const foreign = `${JSON.stringify(snapshot)}\n`;
  await writeFile(snapshotPath, foreign);
  await assert.rejects(openPersonMediaIndex(person, { writable: true, requireExisting: true }), { code: "media-index-owner-conflict" });
  await assert.rejects(index.compact(), { code: "media-index-owner-conflict" });
  assert.equal(await readFile(snapshotPath, "utf8"), foreign);
  assert.equal(await readFile(path.join(root, "Index", "events.jsonl"), "utf8"), "");
});
