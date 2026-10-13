const CANONICAL_VERSION = /^(?:V(0|[1-9]\d*)\.(0|[1-9]\d*)|(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.0)?)$/;

function versionRecord(major, minor) {
  if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError("版本数字必须为安全范围内的非负整数。");
  }
  return Object.freeze({ major, minor, semver: `${major}.${minor}.0`, label: `V${major}.${minor}` });
}

export function parseReleaseVersion(input) {
  if (typeof input !== "string") throw new TypeError("版本必须为规范的 major.minor、major.minor.0 或 Vmajor.minor 字符串。");
  const match = CANONICAL_VERSION.exec(input);
  if (!match) throw new TypeError("版本必须为规范的 major.minor、major.minor.0 或 Vmajor.minor 字符串。");
  return versionRecord(Number(match[1] ?? match[3]), Number(match[2] ?? match[4]));
}

function normalizedVersion(input) {
  if (typeof input === "string") return parseReleaseVersion(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return parseReleaseVersion(input);
  const parsed = parseReleaseVersion(input.semver);
  if (input.major !== parsed.major || input.minor !== parsed.minor || input.semver !== parsed.semver || input.label !== parsed.label) {
    throw new TypeError("版本记录中的数字、内部版本及外部标签不一致。");
  }
  return parsed;
}

export function nextReleaseVersion(current, { majorChange = false } = {}) {
  if (typeof majorChange !== "boolean") throw new TypeError("大版本升级必须由明确的布尔标记指定。");
  const version = normalizedVersion(current);
  return majorChange ? versionRecord(version.major + 1, 0) : versionRecord(version.major, version.minor + 1);
}

export function releaseNames(version, { minimal = false, includeRuntime = false } = {}) {
  if (typeof minimal !== "boolean" || typeof includeRuntime !== "boolean") throw new TypeError("发布版型标记必须是布尔值。");
  if (minimal && includeRuntime) throw new TypeError("最小版与完整离线运行环境不能同时指定。");
  const parsed = normalizedVersion(version);
  const edition = minimal ? "最小版" : includeRuntime ? "离线版" : "标准版";
  const directoryName = `采集工具-${edition}-${parsed.label}`;
  return Object.freeze({ directoryName, zipName: `${directoryName}.zip` });
}
