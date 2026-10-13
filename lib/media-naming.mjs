import path from "node:path";

export const NAMING_VERSION = 1;
export const HASH_LENGTHS = [16, 24, 32, 64];
const DATE = /^\d{8}$/;
const LABEL_INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
const UNSAFE_LABEL = /[<>:"/\\|?*\u0000-\u001f]/;
const COLLECTION_DATE_BASES = new Set(["first-collected-utc", "first-collected-beijing"]);

export function validPublicationDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function personLabel(value) {
  return String(value || "未命名").normalize("NFC").replace(LABEL_INVALID, "_").replace(/[. ]+$/g, "").trim() || "未命名";
}

function time(source) {
  const value = typeof source.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(source.createdAt) ? Date.parse(source.createdAt) : NaN;
  return Number.isFinite(value) ? value : null;
}

function postKey(source) {
  // Attachment order is decided only AFTER the post, never by its content hash.
  return JSON.stringify([source.platformId || "", source.accountId || "", source.postId || source.logicalKey || ""]);
}

function attachmentIndex(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

export function compareSources(a, b) {
  const aDate = validPublicationDate(a.publicationDate) ? a.publicationDate : null;
  const bDate = validPublicationDate(b.publicationDate) ? b.publicationDate : null;
  const aEvidence = aDate === null ? 2 : COLLECTION_DATE_BASES.has(a.dateBasis) ? 1 : 0;
  const bEvidence = bDate === null ? 2 : COLLECTION_DATE_BASES.has(b.dateBasis) ? 1 : 0;
  // First collection is only the legacy fallback filename date, never evidence
  // that the media was published before a genuinely dated occurrence.
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;
  if (aDate !== bDate) return aDate === null ? 1 : bDate === null ? -1 : aDate.localeCompare(bDate);
  const aTime = time(a), bTime = time(b);
  if (aTime !== bTime) return aTime === null ? 1 : bTime === null ? -1 : aTime - bTime;
  const posts = postKey(a).localeCompare(postKey(b));
  if (posts) return posts;
  const attachment = attachmentIndex(a.mediaIndex) - attachmentIndex(b.mediaIndex);
  return attachment || String(a.logicalKey || "").localeCompare(String(b.logicalKey || ""));
}

export function namingSource(asset) {
  const sources = Object.values(asset.sources || {});
  return sources.length ? sources.sort(compareSources)[0] : null;
}

export function assetDate(asset) {
  const value = namingSource(asset)?.publicationDate;
  return validPublicationDate(value) ? value : null;
}

export function compareAssets(a, b) {
  const aSource = namingSource(a), bSource = namingSource(b);
  if (aSource && bSource) return compareSources(aSource, bSource) || a.mediaId.localeCompare(b.mediaId);
  return aSource ? -1 : bSource ? 1 : a.mediaId.localeCompare(b.mediaId);
}

export function namingGroups(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const key = `${asset.kind}\0${assetDate(asset) || "日期未知"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  }
  for (const group of groups.values()) group.sort(compareAssets);
  return groups;
}

export function readableRelativePath(root, { kind, extension, mediaId, personLabel: label, publicationDate, daySequence, sequenceWidth = 2 }, hashLength = 16) {
  const folder = kind === "video" ? "Video" : "Image";
  const date = validPublicationDate(publicationDate) ? publicationDate : "日期未知";
  const prefix = `${date}_`;
  const suffix = `_${String(daySequence).padStart(sequenceWidth, "0")}_${mediaId.slice(0, hashLength)}${extension}`;
  // A conservative complete-path budget also keeps Windows Explorer/system players usable.
  // Only the human label is truncated. Dates, sequence numbers, hash and extension remain exact.
  const budget = Math.min(240, 240 - path.join(root, folder).length - 1) - prefix.length - suffix.length;
  if (budget < 1) throw Object.assign(new Error("人物根路径过长，无法安全保存带日期的文件名；请缩短人物目录路径。"), { code: "media-filename-too-long" });
  let shortened = "";
  for (const character of personLabel(label)) {
    if (shortened.length + character.length > budget || Buffer.byteLength(`${prefix}${shortened}${character}${suffix}`, "utf8") > 240) break;
    shortened += character;
  }
  shortened = shortened.replace(/[. ]+$/g, "") || "_";
  return path.join(folder, `${prefix}${shortened}${suffix}`);
}

export function parseMediaFilename(filename) {
  const legacy = /^([a-f0-9]{64})(\.[a-z0-9]{1,12})$/.exec(filename);
  if (legacy) return { hashPrefix: legacy[1], extension: legacy[2], namingVersion: 0 };
  const match = /^(\d{8}|日期未知)_(.+)_(\d{2,})_([a-f0-9]{16}|[a-f0-9]{24}|[a-f0-9]{32}|[a-f0-9]{64})(\.[a-z0-9]{1,12})$/.exec(filename);
  if (!match || (match[1] !== "日期未知" && !validPublicationDate(match[1])) || UNSAFE_LABEL.test(match[2])) return null;
  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { publicationDate: match[1] === "日期未知" ? null : match[1], personLabel: match[2], daySequence: sequence,
    sequenceWidth: match[3].length, hashPrefix: match[4], extension: match[5], namingVersion: NAMING_VERSION };
}
