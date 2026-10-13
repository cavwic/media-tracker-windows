import path from "node:path";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";

// Deliberately exclude Cookies, site storage, Service Worker and profile settings.
export const CACHE_DIRECTORY_PARTS = Object.freeze([
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  ["GPUPersistentCache"],
  ["GrShaderCache"],
  ["ShaderCache"],
].map((parts) => Object.freeze(parts)));

const PLATFORMS = new Set(["x", "instagram", "facebook", "threads", "tiktok"]);
const isPlatform = (id) => PLATFORMS.has(id) || /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function unsafe(message) {
  return Object.assign(new Error(message), { code: "UNSAFE_CACHE_PATH" });
}

function key(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || !value.trim()
    || (process.platform === "win32" && (/^\\\\[?.]\\/.test(value) || value.slice(2).includes(":")))) {
    throw unsafe("缓存路径必须是普通的绝对文件系统路径。");
  }
  return path.resolve(value);
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function inspect(target, expectedType) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
    || (expectedType === "directory" && !info.isDirectory())) {
    throw unsafe("缓存路径包含链接、目录联接或非预期文件类型，已保留。");
  }
  const resolved = await realpath(target);
  if (key(resolved) !== key(target)) throw unsafe("缓存路径的真实位置发生变化，已保留。");
  return { target, resolved, info };
}

async function inspectParents(target) {
  const parents = [];
  let current = target;
  while (true) {
    parents.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const checked = [];
  for (const parent of parents) checked.push(await inspect(parent, "directory"));
  return checked;
}

function normalizeRoot(profilesRoot) {
  const root = absolutePath(profilesRoot);
  if (key(root) === key(path.parse(root).root) || path.basename(root).toLowerCase() !== "browser-profiles") {
    throw unsafe("仅允许清理 browser-profiles 下指定账号的白名单缓存。");
  }
  return root;
}

async function validateProfile(profilesRoot, profilePath) {
  const root = normalizeRoot(profilesRoot);
  const target = absolutePath(profilePath);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  if (!within(root, target) || parts.length !== 2 || !isPlatform(parts[0]) || !PROFILE_ID.test(parts[1])) {
    throw unsafe("账号缓存必须位于 browser-profiles/平台/账号 ID 下。");
  }
  return { root, target, parents: await inspectParents(target) };
}

async function revalidate(snapshot) {
  const current = await inspect(snapshot.target, snapshot.info.isDirectory() ? "directory" : undefined);
  if (current.info.isDirectory() !== snapshot.info.isDirectory()
    || current.info.dev !== snapshot.info.dev || current.info.ino !== snapshot.info.ino
    || key(current.resolved) !== key(snapshot.resolved)
    || (snapshot.info.isFile() && (current.info.size !== snapshot.info.size || current.info.mtimeMs !== snapshot.info.mtimeMs))) {
    throw unsafe("缓存文件或目录在检查后发生变化，已保留。");
  }
  return current;
}

async function inventory(target, boundary, ancestors, files, directories) {
  if (!within(boundary, target)) throw unsafe("缓存目录超出白名单范围，已保留。");
  const current = await inspect(target);
  if (current.info.isFile()) {
    files.push({ ...current, ancestors });
    return;
  }
  const nextAncestors = [...ancestors, current];
  for (const name of await readdir(target)) {
    await inventory(path.join(target, name), boundary, nextAncestors, files, directories);
  }
  // Children precede their parent; no recursive deletion is used.
  directories.push({ ...current, ancestors });
}

function recordError(result, target, error) {
  if (error.code === "ENOENT") return;
  const entry = { path: target, code: error.code || "CACHE_CLEANUP_FAILED", message: error.message };
  result.errors.push(entry);
  result.skipped.push({ path: target, reason: error.message });
}

/**
 * Read-only preview of the same cache allowlist used by clearProfileCache.
 * Only directory entries and file metadata are inspected; no file contents,
 * profile state or login data are read or changed. Each candidate contributes
 * counts only after its complete tree has passed validation. A later clear
 * always performs its own checks again instead of trusting this snapshot.
 */
export async function inspectProfileCache({ profilesRoot, profilePath } = {}) {
  const result = { status: "empty", bytes: 0, files: 0, directories: 0, errors: [], skipped: [] };
  let profile;
  try {
    profile = await validateProfile(profilesRoot, profilePath);
  } catch (error) {
    recordError(result, typeof profilePath === "string" ? profilePath : "", error);
    result.status = result.errors.length ? "skipped" : "empty";
    return result;
  }
  for (const parts of CACHE_DIRECTORY_PARTS) {
    const candidate = path.join(profile.target, ...parts);
    const files = [];
    const directories = [];
    try {
      const parents = [...profile.parents];
      if (parts.length > 1) parents.push(await inspect(path.dirname(candidate), "directory"));
      await inspect(candidate, "directory");
      await inventory(candidate, candidate, parents, files, directories);
      result.bytes += files.reduce((total, file) => total + file.info.size, 0);
      result.files += files.length;
      result.directories += directories.length;
    } catch (error) {
      recordError(result, candidate, error);
    }
  }
  result.status = result.directories > 0 ? "ready" : result.errors.length ? "skipped" : "empty";
  return result;
}

/**
 * Clear only recreatable Chromium caches. Callers must first release every browser
 * using this profile and prevent new users until this operation has completed.
 * Missing caches and locked files never cause a sync operation to throw.
 */
export async function clearProfileCache({ profilesRoot, profilePath } = {}) {
  const result = { status: "empty", removedBytes: 0, removedFiles: 0, removedDirectories: 0, skipped: [], errors: [] };
  let profile;
  try {
    profile = await validateProfile(profilesRoot, profilePath);
  } catch (error) {
    recordError(result, typeof profilePath === "string" ? profilePath : "", error);
    result.status = result.errors.length ? "skipped" : "empty";
    return result;
  }

  for (const parts of CACHE_DIRECTORY_PARTS) {
    const candidate = path.join(profile.target, ...parts);
    const files = [];
    const directories = [];
    try {
      // Inspect the complete candidate before deleting any of its contents. A
      // nested junction causes this whole cache directory to be left untouched.
      const parents = [...profile.parents];
      if (parts.length > 1) parents.push(await inspect(path.dirname(candidate), "directory"));
      await inspect(candidate, "directory");
      await inventory(candidate, candidate, parents, files, directories);
      for (const item of [...files, ...directories]) {
        try {
          for (const ancestor of item.ancestors) await revalidate(ancestor);
          const current = await revalidate(item);
          if (current.info.isFile()) {
            await unlink(item.target);
            result.removedBytes += current.info.size;
            result.removedFiles += 1;
          } else {
            await rmdir(item.target);
            result.removedDirectories += 1;
          }
        } catch (error) {
          recordError(result, item.target, error);
        }
      }
    } catch (error) {
      recordError(result, candidate, error);
    }
  }
  const removed = result.removedFiles > 0 || result.removedDirectories > 0;
  result.status = result.errors.length ? (removed ? "partial" : "skipped") : (removed ? "cleaned" : "empty");
  return result;
}

/** List only ordinary, validated platform/profile directories; never follow links. */
export async function listProfileDirectories(profilesRoot, { onError = () => {} } = {}) {
  const report = (target, error) => {
    if (error.code !== "ENOENT") onError({ path: target, code: error.code || "CACHE_INSPECTION_FAILED", message: error.message });
  };
  let root;
  try {
    root = normalizeRoot(profilesRoot);
    await inspectParents(root);
  } catch (error) {
    report(typeof profilesRoot === "string" ? profilesRoot : "", error);
    return [];
  }
  const found = [];
  const platformNames = await readdir(root).catch((error) => { report(root, error); return []; });
  for (const platform of platformNames) {
    if (!isPlatform(platform)) continue;
    const directory = path.join(root, platform);
    try {
      await inspect(directory, "directory");
      for (const id of await readdir(directory)) {
        if (!PROFILE_ID.test(id)) continue;
        const candidate = path.join(directory, id);
        try {
          await validateProfile(root, candidate);
          found.push(candidate);
        } catch (error) { report(candidate, error); /* Never follow invalid, missing or linked profiles. */ }
      }
    } catch (error) { report(directory, error); /* Never follow unavailable or linked platforms. */ }
  }
  return found.sort();
}
