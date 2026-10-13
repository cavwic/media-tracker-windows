import path from "node:path";
import { readFile, stat } from "node:fs/promises";

const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[a-zA-Z0-9._-]{1,160}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const EDITIONS = new Set(["standard", "minimal"]);
const DISTRIBUTIONS = new Set(["online-slim", "online-minimal", "offline-full"]);

export class ReleaseIdentityError extends Error {
  constructor() {
    super("发布来源标识无效，请重新解压已验证的完整工具包；账号和媒体未被修改。");
    this.name = "ReleaseIdentityError";
    this.code = "RELEASE_IDENTITY_INVALID";
  }
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\\:\0\r\n]/.test(value) && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..")
    && !/(?:^|\/)(?:data|browser-profiles)(?:\/|$)/i.test(value);
}

function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
}

async function readJson(filename, limit) {
  const info = await stat(filename);
  if (!info.isFile() || info.size > limit) throw new ReleaseIdentityError();
  return JSON.parse(await readFile(filename, "utf8"));
}

async function developmentVersion(root) {
  try {
    const value = await readJson(path.join(root, "package.json"), 1024 * 1024);
    return typeof value?.version === "string" && VERSION.test(value.version) ? value.version : "unknown";
  } catch { return "unknown"; }
}

function currentIdentity(manifest) {
  if (typeof manifest?.version !== "string" || !VERSION.test(manifest.version)
    || typeof manifest.buildId !== "string" || !BUILD_ID.test(manifest.buildId)
    || !isoDate(manifest.builtAt) || !EDITIONS.has(manifest.edition)
    || !DISTRIBUTIONS.has(manifest.distribution) || !manifest.source || Array.isArray(manifest.source)
    || !SHA256.test(manifest.source.fingerprint) || !isoDate(manifest.source.latestModifiedAt)
    || !Number.isSafeInteger(manifest.source.fileCount) || manifest.source.fileCount < 1
    || !Array.isArray(manifest.source.files) || manifest.source.files.length !== manifest.source.fileCount) {
    throw new ReleaseIdentityError();
  }
  const sourcePaths = new Set();
  const packagePaths = new Set();
  for (const entry of manifest.source.files) {
    if (!entry || !safeRelative(entry.source) || !safeRelative(entry.file)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(entry.sha256)
      || sourcePaths.has(entry.source) || packagePaths.has(entry.file)) throw new ReleaseIdentityError();
    sourcePaths.add(entry.source);
    packagePaths.add(entry.file);
  }
  return Object.freeze({ version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt,
    sourceFingerprint: manifest.source.fingerprint, edition: manifest.edition, distribution: manifest.distribution });
}

// Read once at startup. The public result deliberately omits file mappings and
// absolute installation paths; validation never follows manifest source paths.
export async function readReleaseIdentity({ root, portableRoot = null }) {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")
    || (portableRoot !== null && (typeof portableRoot !== "string" || !path.isAbsolute(portableRoot) || portableRoot.includes("\0")))) {
    throw new ReleaseIdentityError();
  }
  if (portableRoot === null) {
    return Object.freeze({ version: await developmentVersion(root), buildId: null, builtAt: null,
      sourceFingerprint: null, edition: "development", distribution: "source" });
  }
  let manifest;
  try { manifest = await readJson(path.join(portableRoot, "release-manifest.json"), 2 * 1024 * 1024); }
  catch (error) {
    if (error.code !== "ENOENT") throw new ReleaseIdentityError();
  }
  if (manifest && (Object.hasOwn(manifest, "buildId") || Object.hasOwn(manifest, "builtAt") || Object.hasOwn(manifest, "source"))) {
    return currentIdentity(manifest);
  }
  // Older portable packages did not carry source provenance. Keep them usable,
  // but never claim that their version alone proves a current verified build.
  return Object.freeze({ version: typeof manifest?.version === "string" && VERSION.test(manifest.version)
    ? manifest.version : await developmentVersion(root), buildId: null, builtAt: null, sourceFingerprint: null,
    edition: EDITIONS.has(manifest?.edition) ? manifest.edition : "standard",
    distribution: DISTRIBUTIONS.has(manifest?.distribution) ? manifest.distribution : "legacy", legacy: true });
}
