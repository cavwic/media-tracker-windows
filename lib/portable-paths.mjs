import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

export class PortablePathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PortablePathError";
    this.code = "PORTABLE_PATH_INVALID";
  }
}

function absoluteSetting(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) {
    throw new PortablePathError(`${label}必须是绝对路径，未读取或重建原登录资料。`);
  }
  return path.resolve(value);
}

export function resolvePortableDataDirectory(root, env = process.env) {
  if (env.MEDIA_TRACKER_PORTABLE_ROOT) {
    const portableRoot = absoluteSetting(env.MEDIA_TRACKER_PORTABLE_ROOT, "便携工具目录");
    return { portable: true, portableRoot, dataDirectory: path.join(portableRoot, "data") };
  }
  return { portable: false, portableRoot: null,
    dataDirectory: env.MEDIA_TRACKER_DATA_DIR ? path.resolve(env.MEDIA_TRACKER_DATA_DIR) : path.join(root, "data") };
}

function failProfile() {
  throw new PortablePathError("便携版登录资料路径无效或位于本工具 data/browser-profiles 之外；未清除、移动或重建登录信息。");
}

function relativeProfile(account, dataDirectory) {
  const value = account?.profileDirectory;
  const platform = account?.platformId;
  if (typeof value !== "string" || !value || value.includes("\0")
    || typeof platform !== "string" || !/^[a-z0-9-]{1,128}$/i.test(platform)) failProfile();

  // Backslash and slash must be treated as separators even on a non-Windows
  // test host. Reject drive-relative paths and ADS before resolving anything.
  let relative;
  if (path.isAbsolute(value)) {
    relative = path.relative(path.resolve(dataDirectory), path.resolve(value));
  } else {
    if (path.win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes(":")) failProfile();
    relative = value;
  }
  const segments = relative.split(/[\\/]/);
  if (segments.length !== 3 || segments[0] !== "browser-profiles"
    || segments[1].toLowerCase() !== platform.toLowerCase()
    || !/^[a-z0-9-]{1,128}$/i.test(segments[2])
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segments[2])
    || segments.some((segment) => segment === "." || segment === ".." || !segment)) failProfile();
  return segments.join("/");
}

export function hydrateProfilePaths(state, { dataDirectory, portable = false }) {
  if (!portable) return state;
  return { ...state, linkedAccounts: (state.linkedAccounts || []).map((account) => ({ ...account,
    profileDirectory: path.join(dataDirectory, ...relativeProfile(account, dataDirectory).split("/")),
  })) };
}

export function serializeProfilePaths(state, { dataDirectory, portable = false }) {
  if (!portable) return state;
  return { ...state, linkedAccounts: (state.linkedAccounts || []).map((account) => ({ ...account,
    profileDirectory: relativeProfile(account, dataDirectory),
  })) };
}

// Lexical containment alone cannot prevent an existing profile junction from
// redirecting Chromium outside the portable data directory. Missing profiles
// are valid for a newly bound account; existing path components are checked.
export async function assertPortableProfilePaths(state, { dataDirectory, portable = false }) {
  if (!portable || !state.linkedAccounts?.length) return;
  const root = path.resolve(dataDirectory);
  const realRoot = await realpath(root);
  for (const account of state.linkedAccounts) {
    const segments = relativeProfile(account, root).split("/");
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let info;
      try { info = await lstat(current); }
      catch (error) { if (error.code === "ENOENT") break; throw error; }
      const actual = await realpath(current);
      const relative = path.relative(realRoot, actual);
      if (!info.isDirectory() || info.isSymbolicLink() || !relative
        || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) failProfile();
    }
  }
}

export function resolveSourcePython(root, env = process.env) {
  if (env.MEDIA_TRACKER_SOURCE_PYTHON) return absoluteSetting(env.MEDIA_TRACKER_SOURCE_PYTHON, "通用采集 Python");
  return path.join(root, ".runtime", "sources-python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
