import path from "node:path";

export function resolveReceiptFile(person, receiptFile, mediaIndex) {
  const asset = mediaIndex ? mediaIndex.get(receiptFile?.mediaId, { includeFingerprint: false }) : receiptFile;
  if (!person?.folderPath || !asset) throw new Error("媒体资产记录已不存在，请重新查看来源索引。");
  const raw = String(asset.relativePath || "");
  const parts = raw.replaceAll("\\", "/").split("/");
  const mediaPath = parts.length === 2 && ["Image", "Video"].includes(parts[0]);
  // A durable merge may have moved an original before its commit succeeded.
  // Only the authoritative index can expose that exact pending archive path;
  // receipt/client-provided Index paths are never accepted.
  const pendingArchive = Boolean(mediaIndex && asset.mergePending && /^[a-f0-9]{64}$/.test(asset.mediaId || "")
    && parts.length === 4 && parts[0] === "Index" && parts[1] === "DedupArchive"
    && /^[a-f0-9-]{36}$/.test(parts[2]));
  if ((!mediaPath && !pendingArchive) || parts.some((part) => !part || part === "." || part === "..")
    || /[:\u0000]/.test(raw) || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("媒体文件路径不在人物的 Image 或 Video 目录内。");
  }
  const personRoot = path.resolve(person.folderPath);
  const filePath = path.resolve(personRoot, ...parts);
  const relative = path.relative(personRoot, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("媒体文件路径不在人物目录内。");
  }
  return filePath;
}
