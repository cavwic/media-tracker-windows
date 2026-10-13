import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

function relativeFile(value) {
  return typeof value === "string" && value.length > 0 && !/[\\:\0]/.test(value)
    && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function sourceFingerprint(files) {
  const sorted = files.map(({ source, file, bytes, sha256 }) => {
    if (!relativeFile(source) || !relativeFile(file) || !Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("Invalid release source record.");
    }
    return { source, file, bytes, sha256 };
  }).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  if (new Set(sorted.map((item) => item.source)).size !== sorted.length || new Set(sorted.map((item) => item.file)).size !== sorted.length) {
    throw new Error("Duplicate release source mapping.");
  }
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export async function captureReleaseSource({ root, mappings }) {
  if (!path.isAbsolute(root)) throw new Error("Release source root must be absolute.");
  const files = [];
  let newest = 0;
  async function visit(source, file) {
    if (!relativeFile(source) || !relativeFile(file)) throw new Error("Unsafe release source mapping.");
    const filename = path.join(root, ...source.split("/"));
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error("Release source symlinks are not allowed.");
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(`${source}/${name}`, `${file}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error("Release source must contain only ordinary files.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const after = await lstat(filename);
    if (after.isSymbolicLink() || !after.isFile() || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
      throw new Error("Release source changed while being read; build was not accepted.");
    }
    newest = Math.max(newest, after.mtimeMs);
    files.push({ source, file, bytes: after.size, sha256: hash.digest("hex") });
  }
  for (const mapping of mappings) await visit(mapping.source, mapping.file);
  files.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { fingerprint: sourceFingerprint(files), fileCount: files.length, latestModifiedAt: new Date(newest).toISOString(), files };
}

export function assertUnchangedSource(before, after, packagedFiles) {
  if (before.fingerprint !== after.fingerprint) throw new Error("Release source changed during packaging; rebuild from the latest source.");
  const packaged = new Map(packagedFiles.map((file) => [file.file, file]));
  for (const record of after.files) {
    const saved = packaged.get(record.file);
    if (!saved || record.bytes !== saved.bytes || record.sha256 !== saved.sha256) {
      throw new Error("Packaged file does not match current source: " + record.source);
    }
  }
}
