import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm, rmdir, rename, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { auditRelease, sourceFingerprint } from "../packaging/audit-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Local test-only ZIP writer. Nothing is downloaded or extracted; mutations
// exercise the read-only parser without a system Python/.NET dependency.
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data || "");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const packed = entry.packedTail ? Buffer.concat([compressed, Buffer.from(entry.packedTail)]) : compressed;
    const flags = 0x800 | (entry.descriptor ? 8 : 0);
    const crc = entry.crc ?? crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(packed.length, 18);
      header.writeUInt32LE(data.length, 22);
    }
    header.writeUInt16LE(filename.length, 26);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const listing = Buffer.alloc(46);
    listing.writeUInt32LE(0x02014b50);
    listing.writeUInt16LE(0x314, 4);
    listing.writeUInt16LE(20, 6);
    listing.writeUInt16LE(flags, 8);
    listing.writeUInt16LE(method, 10);
    listing.writeUInt32LE(crc, 16);
    listing.writeUInt32LE(packed.length, 20);
    listing.writeUInt32LE(data.length, 24);
    listing.writeUInt16LE(filename.length, 28);
    listing.writeUInt32LE(entry.attributes ?? 0, 38);
    listing.writeUInt32LE(offset, 42);
    local.push(header, filename, packed, descriptor);
    central.push(listing, filename);
    offset += header.length + filename.length + packed.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-release-audit-"));
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^collector-release-audit-/);
    await rm(temporary, { recursive: true, force: true });
  });
  const directory = path.join(temporary, "发布目录 中文");
  const sourceRoot = path.join(temporary, "source");
  const sourceData = Buffer.from("最新语言和界面\n");
  await mkdir(path.join(directory, "app", "public"), { recursive: true });
  await mkdir(path.join(sourceRoot, "public"), { recursive: true });
  await writeFile(path.join(sourceRoot, "public", "index.html"), sourceData);
  await writeFile(path.join(directory, "app", "public", "index.html"), sourceData);
  const file = { file: "app/public/index.html", bytes: sourceData.length, sha256: hash(sourceData) };
  const record = { source: "public/index.html", ...file };
  const packageData = Buffer.from(JSON.stringify({ name: "media-tracker", version: "0.1.2" }));
  const editionData = Buffer.from(JSON.stringify({ schemaVersion: 1, edition: "minimal", dedup: "on-demand" }));
  await mkdir(path.join(directory, "components"));
  await writeFile(path.join(directory, "app", "package.json"), packageData);
  await writeFile(path.join(sourceRoot, "package.json"), packageData);
  await writeFile(path.join(directory, "components", "edition.json"), editionData);
  const packageFile = { file: "app/package.json", bytes: packageData.length, sha256: hash(packageData) };
  const editionFile = { file: "components/edition.json", bytes: editionData.length, sha256: hash(editionData) };
  const records = [record, { source: "package.json", ...packageFile }];
  const manifest = { schemaVersion: 1, version: "0.1.2", edition: "minimal", sourceDataIncluded: false, buildId: "local-minimal-current-001",
    builtAt: "2026-10-09T10:00:00.000Z", files: [file, packageFile, editionFile], source: { fingerprint: sourceFingerprint(records),
      fileCount: records.length, latestModifiedAt: "2026-10-09T09:00:00.000Z", files: records } };
  const zip = path.join(temporary, "renamed-package.zip");
  const save = async ({ entries, windows = false, descriptor = false } = {}) => {
    const manifestData = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(directory, "release-manifest.json"), manifestData);
    const prefix = path.basename(directory) + "/";
    const normal = [{ name: prefix + file.file, data: sourceData, descriptor },
      { name: prefix + "release-manifest.json", data: manifestData, method: 0 },
      { name: prefix + packageFile.file, data: packageData }, { name: prefix + editionFile.file, data: editionData }];
    const requested = entries || normal;
    await writeFile(zip, makeZip(windows ? requested.map((entry) => ({ ...entry, name: entry.name.replaceAll("/", "\\") })) : requested));
    return requested;
  };
  await save();
  return { directory, sourceRoot, sourceData, file, record, manifest, zip, save, temporary };
}

test("audit verifies every package/source/ZIP file and accepts a renamed ZIP", async (t) => {
  const f = await fixture(t);
  const result = await auditRelease(f);
  assert.deepEqual(result.checks, { manifest: true, source: true, zip: true });
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 4);
  assert.equal(result.sourceFileCount, 2);
  assert.equal(result.sourceTreeSha256, f.manifest.source.fingerprint);
  assert.equal(result.zipName, "renamed-package.zip");
  assert.equal(result.zipSha256, hash(await readFile(f.zip)));
  assert.equal(result.buildId, "local-minimal-current-001");
});

test("source fingerprint uses deterministic field/order without locale sorting", () => {
  const a = { source: "public/中.js", file: "app/public/中.js", bytes: 1, sha256: "a".repeat(64) };
  const b = { source: "public/Z.js", file: "app/public/Z.js", bytes: 2, sha256: "b".repeat(64) };
  assert.equal(sourceFingerprint([a, b]), hash(JSON.stringify([b, a])));
  assert.equal(sourceFingerprint([a, b]), sourceFingerprint([b, a]));
});

test("bilingual documentation and its reviewed media remain bound to source and ZIP audits", async (t) => {
  const f = await fixture(t);
  const extras = [];
  for (const [file, content] of [["README.en.md", "# Media Tracker\n"], ["docs/images/setup-en.png", "isolated documentation image fixture"]]) {
    const data = Buffer.from(content);
    for (const root of [f.sourceRoot, f.directory]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), data);
    }
    const saved = { file, bytes: data.length, sha256: hash(data) };
    f.manifest.files.push(saved);
    f.manifest.source.files.push({ source: file, ...saved });
    extras.push({ name: path.basename(f.directory) + "/" + file, data });
  }
  f.manifest.source.fileCount = f.manifest.source.files.length;
  f.manifest.source.fingerprint = sourceFingerprint(f.manifest.source.files);
  const normal = await f.save();
  await f.save({ entries: [...normal, ...extras] });
  assert.deepEqual((await auditRelease(f)).checks, { manifest: true, source: true, zip: true });
  await writeFile(path.join(f.directory, "README.en.md"), "changed guide");
  await assert.rejects(auditRelease(f), /integrity/);
});

test("audit accepts .NET Windows separators and deflate data descriptors", async (t) => {
  const f = await fixture(t);
  await f.save({ windows: true, descriptor: true });
  assert.equal((await auditRelease(f)).checks.zip, true);
});

test("offline package-only auditing never claims current source was checked", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await auditRelease({ directory: f.directory })).checks, { manifest: true, source: false, zip: false });
  assert.equal((await auditRelease({ directory: f.directory, zip: f.zip })).checks.source, false);
});

test("current source drift cannot be hidden by a matching packaged fingerprint", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "public", "index.html"), "后来更新的 UI");
  await assert.rejects(auditRelease(f), /current source integrity mismatch/);
});

test("directory file tampering, extras and missing files are rejected", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.directory, "app", "public", "index.html");
  await writeFile(filename, "tampered");
  await assert.rejects(auditRelease(f), /directory file integrity mismatch/);
  await writeFile(filename, f.sourceData);
  await writeFile(path.join(f.directory, "app", "extra.txt"), "extra");
  await assert.rejects(auditRelease(f), /extra or missing files/);
  await rm(path.join(f.directory, "app", "extra.txt"));
  await rm(filename);
  await assert.rejects(auditRelease(f), /extra or missing files/);
});

test("malformed, duplicate and unsafe manifest/source records are rejected", async (t) => {
  const f = await fixture(t);
  f.manifest.files.push({ ...f.file });
  await f.save();
  await assert.rejects(auditRelease(f), /duplicate file record/);
  f.manifest.files.pop();
  f.record.source = "../public/index.html";
  f.manifest.source.fingerprint = sourceFingerprint(f.manifest.source.files);
  await f.save();
  await assert.rejects(auditRelease(f), /unsafe source path/);
});

test("source fingerprint and source/package record mismatch are rejected", async (t) => {
  const f = await fixture(t);
  f.manifest.source.fingerprint = "0".repeat(64);
  await f.save();
  await assert.rejects(auditRelease(f), /source fingerprint mismatch/);
  f.record.bytes++;
  f.manifest.source.fingerprint = sourceFingerprint(f.manifest.source.files);
  await f.save();
  await assert.rejects(auditRelease(f), /source\/package record mismatch/);
});

test("source proof must cover every app/compiler file rather than a matching subset", async (t) => {
  const f = await fixture(t);
  f.manifest.source.files.shift();
  f.manifest.source.fileCount = f.manifest.source.files.length;
  f.manifest.source.fingerprint = sourceFingerprint(f.manifest.source.files);
  await f.save();
  await assert.rejects(auditRelease(f), /application\/compile source mapping missing/);
});

test("manifest version and edition must match the application and edition marker", async (t) => {
  const f = await fixture(t);
  f.manifest.version = "old-version";
  await f.save();
  await assert.rejects(auditRelease(f), /manifest\/application version mismatch/);
  f.manifest.version = "0.1.2";
  f.manifest.edition = "standard";
  f.manifest.buildId = "local-standard-current-001";
  await f.save();
  await assert.rejects(auditRelease(f), /manifest\/edition marker mismatch/);
});

test("build identity and UTC timestamp fields are validated", async (t) => {
  const f = await fixture(t);
  f.manifest.buildId = "../old-minimal";
  await f.save();
  await assert.rejects(auditRelease(f), /invalid build identity/);
  f.manifest.buildId = "local-minimal-current-001";
  f.manifest.builtAt = "not-a-date";
  await f.save();
  await assert.rejects(auditRelease(f), /invalid build\/source timestamp/);
});

test("ZIP extras, missing files, duplicate case-insensitive names and traversal are rejected", async (t) => {
  const f = await fixture(t);
  const normal = await f.save();
  for (const [entries, pattern] of [
    [[...normal, { name: path.basename(f.directory) + "/app/extra.txt", data: "extra" }], /extra or duplicate ZIP/],
    [[normal[0]], /missing files/],
    [[...normal, { ...normal[0], name: normal[0].name.toUpperCase() }], /duplicate ZIP entry/],
    [[...normal, { name: path.basename(f.directory) + "/../data/Cookies", data: "bad" }], /unsafe ZIP path/],
  ]) {
    await f.save({ entries });
    await assert.rejects(auditRelease(f), pattern);
  }
});

test("ZIP wrong internal root and forged payload/CRC are rejected", async (t) => {
  const f = await fixture(t);
  const normal = await f.save();
  await f.save({ entries: normal.map((entry) => ({ ...entry, name: "old-release/" + entry.name.split("/").slice(1).join("/") })) });
  await assert.rejects(auditRelease(f), /ZIP root/);
  await f.save({ entries: [{ ...normal[0], data: Buffer.alloc(f.sourceData.length, 65) }, normal[1]] });
  await assert.rejects(auditRelease(f), /ZIP file integrity mismatch/);
  await f.save({ entries: [{ ...normal[0], crc: 123 }, normal[1]] });
  await assert.rejects(auditRelease(f), /ZIP file integrity mismatch/);
});

test("ZIP Unix symlinks and Windows reparse attributes are rejected", async (t) => {
  const f = await fixture(t);
  const normal = await f.save();
  for (const attributes of [0xa000 << 16 >>> 0, 0x400]) {
    await f.save({ entries: [{ ...normal[0], attributes }, normal[1]] });
    await assert.rejects(auditRelease(f), /links or special files/);
  }
});

test("private root/nested data and extra directories are rejected before content reads", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, "app", "data"));
  await assert.rejects(auditRelease(f), /private or duplicate directory/);
  await rmdir(path.join(f.directory, "app", "data"));
  await mkdir(path.join(f.directory, "unexpected"));
  await assert.rejects(auditRelease(f), /unexpected directory/);
});

test("filesystem directory links are rejected without following them", async (t) => {
  const f = await fixture(t);
  await rename(path.join(f.directory, "app", "public"), path.join(f.temporary, "outside"));
  try { await symlink(path.join(f.temporary, "outside"), path.join(f.directory, "app", "public"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") return t.skip("directory-link creation is unavailable"); throw error; }
  await assert.rejects(auditRelease(f), /directory links/);
});

test("ZIP central truncation and unlisted local bytes are rejected", async (t) => {
  const f = await fixture(t);
  const normal = await f.save();
  const bytes = await readFile(f.zip);
  await writeFile(f.zip, bytes.subarray(0, -5));
  await assert.rejects(auditRelease(f), /ZIP end record missing/);
  const valid = makeZip(normal);
  const centralOffset = valid.readUInt32LE(valid.length - 6);
  const changed = Buffer.concat([valid.subarray(0, centralOffset), Buffer.from([0]), valid.subarray(centralOffset)]);
  changed.writeUInt32LE(centralOffset + 1, changed.length - 6);
  await writeFile(f.zip, changed);
  await assert.rejects(auditRelease(f), /unlisted local data/);
});

test("ZIP compressed trailing data cannot carry unindexed bytes after a valid deflate stream", async (t) => {
  const f = await fixture(t);
  const normal = await f.save();
  await f.save({ entries: [{ ...normal[0], packedTail: "unindexed bytes" }, ...normal.slice(1)] });
  await assert.rejects(auditRelease(f), /ZIP payload integrity failure/);
});
