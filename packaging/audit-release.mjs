import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInflateRaw } from "node:zlib";
import { fileURLToPath } from "node:url";

const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const topLevel = new Set(["首次编译.cmd", "使用说明.txt", "THIRD-PARTY-NOTICES.txt", "LICENSE", "README.md", "README.en.md", "release-manifest.json",
  "PUBLISHING.md", "PRIVACY.md", "PUBLIC-EDITION.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const fail = (message) => { throw new Error("Release audit failed: " + message); };

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || /[\\:<>"|?*\0-\x1f]/.test(value) || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("unsafe " + label + " path");
  return value;
}

function privatePath(value) {
  return value.split("/").some((part) => /^(?:data|browser-profiles|builtin-app-profile[^/]*|startup-logs|cookies|login data|history)$/i.test(part));
}

function permittedFile(value) {
  return !privatePath(value) && (topLevel.has(value) || /^(?:app|compile|runtime|components|licenses|docs)\//.test(value));
}

function recordList(value, { sources = false } = {}) {
  if (!Array.isArray(value) || !value.length) fail("missing " + (sources ? "source" : "file") + " records");
  const seen = new Set();
  const sourceSeen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || entry.bytes > MAX_FILE_BYTES || !HEX.test(entry.sha256 || "")) fail("invalid file record");
    const file = safeRelative(entry.file, "manifest");
    if (file === "release-manifest.json" || !permittedFile(file)) fail("nonwhitelisted file record");
    if (seen.has(file.toLowerCase())) fail("duplicate file record");
    seen.add(file.toLowerCase());
    if (!sources) return { file, bytes: entry.bytes, sha256: entry.sha256 };
    const source = safeRelative(entry.source, "source");
    if (privatePath(source)) fail("private source record");
    if (sourceSeen.has(source.toLowerCase())) fail("duplicate source record");
    sourceSeen.add(source.toLowerCase());
    return { source, file, bytes: entry.bytes, sha256: entry.sha256 };
  });
}

export function sourceFingerprint(records) {
  const canonical = records.map(({ source, file, bytes, sha256 }) => ({ source, file, bytes, sha256 }))
    .sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function digest(filename) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

async function regularRoot(directory, label) {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(label + " must be a regular directory");
  return { resolved, actual: await realpath(resolved) };
}

async function containedFile(root, relative, label) {
  let current = root.resolved;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) fail(label + " is not regular");
    const actual = await realpath(current);
    const offset = path.relative(root.actual, actual);
    if (!offset || offset === ".." || offset.startsWith(".." + path.sep) || path.isAbsolute(offset)) fail(label + " escaped its root");
  }
  return current;
}

function expectedDirectories(files) {
  const result = new Set([""]);
  for (const { file } of files) {
    const parts = file.split("/");
    parts.pop();
    while (parts.length) { result.add(parts.join("/")); parts.pop(); }
  }
  return result;
}

async function directoryFiles(root, expectedDirs) {
  const files = [];
  const seen = new Set();
  async function visit(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const relative = prefix + name;
      safeRelative(relative, "directory");
      if (privatePath(relative) || seen.has(relative.toLowerCase())) fail("private or duplicate directory entry");
      seen.add(relative.toLowerCase());
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) fail("directory links are forbidden");
      if (info.isDirectory()) {
        if (!expectedDirs.has(relative)) fail("unexpected directory");
        const actual = await realpath(filename);
        const offset = path.relative(root.actual, actual);
        if (!offset || offset === ".." || offset.startsWith(".." + path.sep) || path.isAbsolute(offset)) fail("directory escaped its root");
        await visit(filename, relative + "/");
      } else if (info.isFile()) {
        if (!permittedFile(relative)) fail("nonwhitelisted directory file");
        files.push(relative);
      } else fail("nonregular directory entry");
    }
  }
  await visit(root.resolved);
  return files;
}

async function readAt(handle, length, position) {
  const result = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const { bytesRead } = await handle.read(result, count, length - count, position + count);
    if (!bytesRead) fail("truncated ZIP");
    count += bytesRead;
  }
  return result;
}

function zipName(bytes, flags) {
  if (!(flags & 0x800) && bytes.some((byte) => byte > 127)) fail("ambiguous ZIP filename encoding");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\\", "/"); }
  catch { fail("invalid ZIP filename encoding"); }
}

async function zipEntries(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) fail("ZIP must be a regular file");
  const handle = await open(filename, "r");
  try {
    const length = Math.min(info.size, 65_557);
    if (length < 22) fail("truncated ZIP");
    const tail = await readAt(handle, length, info.size - length);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { end = at; break; }
    }
    if (end < 0) fail("ZIP end record missing");
    const endOffset = info.size - length + end;
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) fail("split ZIP is unsupported");
    const count = tail.readUInt16LE(end + 10);
    if (!count || count === 0xffff || count !== tail.readUInt16LE(end + 8)) fail("ZIP64 or invalid ZIP count");
    const centralBytes = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (centralBytes === 0xffffffff || centralOffset === 0xffffffff || centralBytes > MAX_CENTRAL_BYTES
      || centralOffset + centralBytes !== endOffset) fail("invalid ZIP central directory");
    const central = await readAt(handle, centralBytes, centralOffset);
    const entries = [];
    const seen = new Set();
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) fail("invalid ZIP central entry");
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedBytes = central.readUInt32LE(cursor + 20);
      const bytes = central.readUInt32LE(cursor + 24);
      const nameBytes = central.readUInt16LE(cursor + 28);
      const extraBytes = central.readUInt16LE(cursor + 30);
      const commentBytes = central.readUInt16LE(cursor + 32);
      const attrs = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      if (central.readUInt16LE(cursor + 34) || (flags & ~0x808) || ![0, 8].includes(method)
        || [compressedBytes, bytes, localOffset].includes(0xffffffff) || bytes > MAX_FILE_BYTES
        || cursor + 46 + nameBytes + extraBytes + commentBytes > central.length) fail("unsupported ZIP entry");
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameBytes);
      const name = zipName(rawName, flags);
      const directory = name.endsWith("/");
      safeRelative(directory ? name.slice(0, -1) : name, "ZIP");
      const mode = (attrs >>> 16) & 0xf000;
      if ((attrs & 0x400) || ![0, 0x8000, 0x4000].includes(mode) || (mode === 0x4000) !== directory && mode !== 0) fail("ZIP links or special files are forbidden");
      if (directory && (bytes || compressedBytes || method)) fail("invalid ZIP directory");
      const key = (directory ? name.slice(0, -1) : name).toLowerCase();
      if (seen.has(key)) fail("duplicate ZIP entry");
      seen.add(key);
      if (localOffset + 30 > centralOffset) fail("invalid ZIP local offset");
      const local = await readAt(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method
        || local.readUInt16LE(26) !== nameBytes) fail("ZIP local/central mismatch");
      const localName = await readAt(handle, nameBytes, localOffset + 30);
      if (!localName.equals(rawName)) fail("ZIP local filename mismatch");
      const dataOffset = localOffset + 30 + nameBytes + local.readUInt16LE(28);
      if (dataOffset + compressedBytes > centralOffset) fail("ZIP data overlaps central directory");
      const crc = central.readUInt32LE(cursor + 16);
      let regionEnd = dataOffset + compressedBytes;
      if (flags & 8) {
        const descriptor = await readAt(handle, 16, regionEnd);
        const delta = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        if (descriptor.readUInt32LE(delta) !== crc || descriptor.readUInt32LE(delta + 4) !== compressedBytes
          || descriptor.readUInt32LE(delta + 8) !== bytes) fail("invalid ZIP data descriptor");
        regionEnd += 12 + delta;
      } else if (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressedBytes || local.readUInt32LE(22) !== bytes) fail("ZIP local size/CRC mismatch");
      if (regionEnd > centralOffset) fail("ZIP data overlaps central directory");
      entries.push({ name, directory, flags, method, compressedBytes, bytes, crc, localOffset, dataOffset, regionEnd });
      cursor += 46 + nameBytes + extraBytes + commentBytes;
    }
    if (cursor !== central.length) fail("extra ZIP central bytes");
    const regions = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    let previous = 0;
    for (const entry of regions) {
      if (entry.localOffset !== previous) fail("ZIP has overlapping or unlisted local data");
      previous = entry.regionEnd;
    }
    if (previous !== centralOffset) fail("ZIP has unlisted local data");
    return entries;
  } finally { await handle.close(); }
}

async function zipDigest(filename, entry) {
  const hash = createHash("sha256");
  let bytes = 0;
  let crc = 0xffffffff;
  if (!entry.compressedBytes) {
    if (entry.bytes) fail("empty ZIP media data");
    return { bytes: 0, sha256: hash.digest("hex"), crc: 0 };
  }
  const input = createReadStream(filename, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedBytes - 1 });
  const inflater = entry.method === 8 ? createInflateRaw() : null;
  if (inflater) input.on("error", (error) => inflater.destroy(error));
  const stream = inflater ? input.pipe(inflater) : input;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > entry.bytes) fail("ZIP inflated size exceeded declared limit");
      hash.update(chunk);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    if (inflater && inflater.bytesWritten !== entry.compressedBytes) fail("ZIP contains trailing compressed data");
  } catch { fail("ZIP payload integrity failure"); }
  finally { input.destroy(); inflater?.destroy(); }
  return { bytes, sha256: hash.digest("hex"), crc: (crc ^ 0xffffffff) >>> 0 };
}

export async function auditRelease({ directory, zip, sourceRoot } = {}) {
  if (typeof directory !== "string" || !directory) fail("release directory is required");
  const releaseRoot = await regularRoot(directory, "release");
  const manifestPath = await containedFile(releaseRoot, "release-manifest.json", "manifest");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 16 * 1024 * 1024) fail("manifest exceeded its limit");
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail("invalid manifest JSON"); }
  if (manifest.schemaVersion !== 1 || manifest.sourceDataIncluded !== false || !["standard", "minimal"].includes(manifest.edition)) fail("unsupported manifest");
  if (typeof manifest.buildId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(manifest.buildId)
    || !new RegExp("(?:^|[._-])" + manifest.edition + "(?:[._-]|$)").test(manifest.buildId)) fail("invalid build identity");
  const isIso = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (!isIso(manifest.builtAt) || !isIso(manifest.source?.latestModifiedAt)) fail("invalid build/source timestamp");
  const files = recordList(manifest.files);
  const records = recordList(manifest.source?.files, { sources: true });
  if (manifest.source.fileCount !== records.length || !HEX.test(manifest.source.fingerprint || "")
    || sourceFingerprint(records) !== manifest.source.fingerprint) fail("source fingerprint mismatch");
  const byFile = new Map(files.map((entry) => [entry.file, entry]));
  const sourcedFiles = new Set(records.map((entry) => entry.file));
  for (const entry of files) {
    if ((entry.file.startsWith("app/") || entry.file.startsWith("compile/") || entry.file === "首次编译.cmd")
      && !sourcedFiles.has(entry.file)) fail("application/compile source mapping missing");
  }
  for (const record of records) {
    const packaged = byFile.get(record.file);
    if (!packaged || packaged.bytes !== record.bytes || packaged.sha256 !== record.sha256) fail("source/package record mismatch");
  }
  const expected = new Map([...files.map((entry) => [entry.file, entry]), ["release-manifest.json", {
    file: "release-manifest.json", bytes: manifestBytes.length, sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }]]);
  const expectedDirs = expectedDirectories([...expected.values()]);
  const actual = await directoryFiles(releaseRoot, expectedDirs);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) fail("directory contains extra or missing files");
  for (const [file, entry] of expected) {
    const filename = await containedFile(releaseRoot, file, "package file");
    const checked = await digest(filename);
    if (checked.bytes !== entry.bytes || checked.sha256 !== entry.sha256) fail("directory file integrity mismatch: " + file);
  }
  let appPackage, edition;
  try {
    appPackage = JSON.parse(await readFile(await containedFile(releaseRoot, "app/package.json", "package version"), "utf8"));
    edition = JSON.parse(await readFile(await containedFile(releaseRoot, "components/edition.json", "edition marker"), "utf8"));
  } catch { fail("package version or edition marker missing/invalid"); }
  if (typeof manifest.version !== "string" || !manifest.version || manifest.version !== appPackage.version) fail("manifest/application version mismatch");
  if (edition.schemaVersion !== 1 || edition.edition !== manifest.edition
    || edition.dedup !== (manifest.edition === "minimal" ? "on-demand" : "included")) fail("manifest/edition marker mismatch");
  let sourceVerified = false;
  if (sourceRoot !== undefined) {
    if (typeof sourceRoot !== "string" || !sourceRoot) fail("invalid source root");
    const root = await regularRoot(sourceRoot, "source");
    for (const record of records) {
      const filename = await containedFile(root, record.source, "source file");
      const checked = await digest(filename);
      if (checked.bytes !== record.bytes || checked.sha256 !== record.sha256) fail("current source integrity mismatch: " + record.source);
    }
    sourceVerified = true;
  }
  let zipVerified = false;
  let zipSha256 = null;
  if (zip !== undefined) {
    if (typeof zip !== "string" || !zip) fail("invalid ZIP path");
    const zipPath = path.resolve(zip);
    const entries = await zipEntries(zipPath);
    const prefix = path.basename(releaseRoot.resolved) + "/";
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) fail("ZIP root does not match release directory");
      const file = entry.name.slice(prefix.length);
      if (entry.directory) {
        if (!expectedDirs.has(file.replace(/\/$/, ""))) fail("unexpected ZIP directory");
        continue;
      }
      if (!file || !expected.has(file) || seen.has(file)) fail("extra or duplicate ZIP file");
      const record = expected.get(file);
      if (entry.bytes !== record.bytes) fail("ZIP declared size mismatch");
      const checked = await zipDigest(zipPath, entry);
      if (checked.bytes !== record.bytes || checked.sha256 !== record.sha256 || checked.crc !== entry.crc) fail("ZIP file integrity mismatch: " + file);
      seen.add(file);
    }
    if (seen.size !== expected.size) fail("ZIP has missing files");
    zipSha256 = (await digest(zipPath)).sha256;
    zipVerified = true;
  }
  return { schemaVersion: 1, ok: true, edition: manifest.edition, directoryName: path.basename(releaseRoot.resolved),
    zipName: zip ? path.basename(zip) : null, buildId: manifest.buildId ?? null, builtAt: manifest.builtAt ?? null,
    sourceTreeSha256: manifest.source.fingerprint, zipSha256,
    checks: { manifest: true, source: sourceVerified, zip: zipVerified }, fileCount: expected.size, sourceFileCount: records.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const sourceAt = args.indexOf("--source-root");
    let sourceRoot;
    if (sourceAt >= 0) {
      sourceRoot = args[sourceAt + 1];
      if (!sourceRoot) fail("--source-root requires a directory");
      args.splice(sourceAt, 2);
    }
    if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("--"))) fail("usage: audit-release.mjs directory [zip] [--source-root root]");
    console.log(JSON.stringify(await auditRelease({ directory: args[0], zip: args[1], sourceRoot }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
