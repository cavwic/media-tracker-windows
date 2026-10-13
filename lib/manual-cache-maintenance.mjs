import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, realpath, readdir, mkdir, rename, writeFile, unlink, rmdir } from "node:fs/promises";
import { inspectProfileCache, listProfileDirectories } from "./profile-cache.mjs";
import { getPlatformRegistry } from "./platform-registry.mjs";

const keyFor = (profile) => path.resolve(profile).toLowerCase();
const maintenanceKey = (profile) => process.platform === "win32" ? keyFor(profile) : path.resolve(profile);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const REASONS = Object.freeze({
  "profile-busy": "该登录资料正在同步、验证或清理，请结束后重试。",
  "browser-busy": "检测到浏览器占用，或无法确认资料夹是否空闲；请稍后或关闭对应登录窗口后重新扫描。",
  "profile-missing": "尚未创建浏览器登录资料，无需清理。",
  "unsafe-profile": "登录资料路径不在工具的安全缓存范围内，已保留。",
  "cleanup-unavailable": "无法确认浏览器是否关闭或无法安全清理，已跳过。",
  "inspection-unavailable": "无法安全读取缓存，相关文件已保留。",
  "linked-profile": "该资料现在仍被账号绑定使用，禁止删除。",
  "removal-incomplete": "历史资料删除未完成，剩余文件已保留在隔离目录，请查看所示位置。",
  "profile-changed": "历史资料目录已变化，请重新扫描后再选择；未删除该资料。",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOVAL_WARNING = "删除整个历史浏览器资料夹，包括其中遗留的 Cookies、登录信息与站点数据；成功删除后不可恢复。不会删除当前绑定、人物媒体或索引。";

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function assertCacheCleanupRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.confirm !== true || Object.keys(body).some((key) => key !== "confirm")) {
    throw requestError(400, "清理需明确确认；不接受自定义文件或目录路径。");
  }
}

export function assertProfileRemovalRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true
    || Object.keys(body).some((key) => !["confirm", "profileIds"].includes(key))
    || !Array.isArray(body.profileIds) || body.profileIds.length === 0 || body.profileIds.length > 256
    || body.profileIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || new Set(body.profileIds.map((id) => id.toLowerCase())).size !== body.profileIds.length) {
    throw requestError(400, "删除需明确确认并选择有效的历史资料 ID；不接受文件或目录路径。");
  }
}

function unsafeProfile(message) {
  return Object.assign(new Error(message), { code: "UNSAFE_CACHE_PATH" });
}

async function checkedNode(target, directory = false) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (directory && !info.isDirectory())) {
    throw unsafeProfile("历史资料包含链接、目录联接或异常文件类型，已保留。");
  }
  const resolved = await realpath(target);
  if (maintenanceKey(resolved) !== maintenanceKey(target)) throw unsafeProfile("历史资料的真实路径不一致，已保留。");
  return { target, info, resolved };
}

async function checkedParents(target) {
  const paths = [];
  for (let current = target;;) {
    paths.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const parents = [];
  for (const target of paths) parents.push(await checkedNode(target, true));
  return parents;
}

async function revalidateNode(snapshot) {
  const current = await checkedNode(snapshot.target, snapshot.info.isDirectory());
  if (current.info.dev !== snapshot.info.dev || current.info.ino !== snapshot.info.ino
    || current.info.isDirectory() !== snapshot.info.isDirectory()
    || maintenanceKey(current.resolved) !== maintenanceKey(snapshot.resolved)
    || (snapshot.info.isFile() && (current.info.size !== snapshot.info.size || current.info.mtimeMs !== snapshot.info.mtimeMs))) {
    throw unsafeProfile("历史资料在检查后发生变化，已保留。");
  }
  return current;
}

async function inspectTree(target, ancestors = [], result = { bytes: 0, files: 0, tree: [] }) {
  const current = await checkedNode(target);
  if (current.info.isFile()) {
    result.bytes += current.info.size;
    result.files++;
  } else {
    for (const name of await readdir(target)) await inspectTree(path.join(target, name), [...ancestors, current], result);
  }
  // Postorder supports nonrecursive unlink/rmdir with no traversal through links.
  result.tree.push({ ...current, ancestors });
  return result;
}

async function inspectHistoricalProfile(profilesRoot, profilePath) {
  if (!path.isAbsolute(profilesRoot) || !path.isAbsolute(profilePath)
    || path.basename(profilesRoot).toLowerCase() !== "browser-profiles"
    || maintenanceKey(profilesRoot) === maintenanceKey(path.parse(profilesRoot).root)
    || (process.platform === "win32" && [profilesRoot, profilePath].some((value) => /^\\\\[?.]\\/.test(value) || value.slice(2).includes(":")))) {
    throw unsafeProfile("历史资料删除只允许工具 browser-profiles 下的普通目录。");
  }
  const parts = path.relative(profilesRoot, profilePath).split(path.sep);
  if (parts.length !== 2 || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(parts[1])
    || !(["x", "instagram", "facebook", "threads", "tiktok"].includes(parts[0])
      || /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[0]))) {
    throw unsafeProfile("历史资料路径超出平台/账号目录范围，已保留。");
  }
  const parents = await checkedParents(profilePath);
  return { ...(await inspectTree(profilePath, parents.slice(0, -1))), parents };
}

async function revalidateTree(snapshot) {
  for (const item of snapshot.parents || []) await revalidateNode(item);
  for (const item of snapshot.tree) await revalidateNode(item);
}

function assertSameMovedTree(original, moved, source, target) {
  const byRelative = new Map(original.tree.map((item) => [path.relative(source, item.target), item.info]));
  if (byRelative.size !== moved.tree.length) throw unsafeProfile("隔离后的资料内容已变化，未继续删除。");
  for (const item of moved.tree) {
    const before = byRelative.get(path.relative(target, item.target));
    if (!before || before.dev !== item.info.dev || before.ino !== item.info.ino
      || before.isDirectory() !== item.info.isDirectory()
      || (before.isFile() && (before.size !== item.info.size || before.mtimeMs !== item.info.mtimeMs))) {
      throw unsafeProfile("隔离后的资料身份或内容已变化，未继续删除。");
    }
  }
}

async function removeHistoricalProfile({ profilesRoot, profilePath, snapshot, beforeMove, now }) {
  // Keep the move on the same volume. Never remove this shared parent directory.
  const quarantineRoot = path.join(path.dirname(profilesRoot), "browser-profile-removals");
  const removalId = randomUUID();
  const container = path.join(quarantineRoot, removalId);
  const target = path.join(container, "profile");
  const metadata = path.join(container, "removal.json");
  let moved = false;
  let createdContainer = false;
  let metadataSnapshot;
  const report = { status: "skipped", removedBytes: 0, removedFiles: 0, errors: [] };
  try {
    await checkedParents(path.dirname(profilesRoot));
    await mkdir(quarantineRoot).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await checkedParents(quarantineRoot);
    await mkdir(container);
    createdContainer = true;
    await writeFile(metadata, JSON.stringify({ schemaVersion: 1, startedAt: now(), originalProfileDirectory: profilePath,
      profileBytes: snapshot.bytes, profileFiles: snapshot.files, operation: "permanent-delete" }), { flag: "wx", mode: 0o600 });
    metadataSnapshot = await checkedNode(metadata);
    await revalidateTree(snapshot);
    for (const parent of await checkedParents(container)) await revalidateNode(parent);
    await beforeMove();
    // The final process/state checks await I/O. Revalidate again afterward so
    // a replaced profile/ancestor cannot inherit an earlier deletion decision.
    await revalidateTree(snapshot);
    await checkedParents(container);
    try { await lstat(target); throw unsafeProfile("隔离目标已存在，禁止覆盖。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    // Unique, newly created container plus absent target: no overwrite or merge.
    await rename(profilePath, target);
    moved = true;
    const quarantined = { ...(await inspectTree(target)), parents: await checkedParents(target) };
    assertSameMovedTree(snapshot, quarantined, profilePath, target);
    await revalidateTree(quarantined);
    for (const item of quarantined.tree) {
      try {
        for (const ancestor of item.ancestors) await revalidateNode(ancestor);
        for (const ancestor of quarantined.parents.slice(0, -1)) await revalidateNode(ancestor);
        const current = await revalidateNode(item);
        if (current.info.isFile()) {
          await unlink(item.target);
          report.removedBytes += current.info.size;
          report.removedFiles++;
        } else await rmdir(item.target);
      } catch (error) {
        report.errors.push({ code: error.code || "PROFILE_REMOVAL_FAILED", message: error.message });
        // A changed tree is not permission to continue destructive traversal.
        break;
      }
    }
    if (!report.errors.length) {
      report.status = "removed";
      // Remove only this operation's regular metadata and exact empty container.
      const record = await checkedNode(metadata);
      if (!record.info.isFile()) throw unsafeProfile("删除记录类型异常，已保留。");
      await unlink(metadata);
      await checkedNode(container, true);
      await rmdir(container);
    } else report.status = "partial";
  } catch (error) {
    report.status = moved ? "partial" : "skipped";
    report.reason = error.reason || (error.code === "UNSAFE_CACHE_PATH" ? "unsafe-profile" : "cleanup-unavailable");
    if (!error.reason) report.errors.push({ code: error.code || "PROFILE_REMOVAL_FAILED", message: error.message });
  }
  if (!moved && createdContainer) {
    try {
      await checkedParents(container);
      if (metadataSnapshot) { await revalidateNode(metadataSnapshot); await unlink(metadata); }
      await rmdir(container);
    } catch {
      // Only our empty operation container/metadata may be removed here. Never
      // attempt a broad recursive cleanup if their identity has changed.
      report.remainingPath = container;
    }
  }
  if (moved && report.status !== "removed") {
    report.reason = "removal-incomplete";
    report.remainingPath = container;
    report.message = REASONS["removal-incomplete"];
  }
  return report;
}

function publicErrors(errors = []) {
  return errors.map((error) => ({
    code: error.code || "CACHE_MAINTENANCE_FAILED",
    message: error.code === "UNSAFE_CACHE_PATH"
      ? "发现链接、异常路径或文件类型，已保留。"
      : "部分缓存无法安全读取或删除，已保留；可能被占用或权限不足。",
  }));
}

function skipped(entry, reason, errors = []) {
  return { ...entry, status: "skipped", reason, message: REASONS[reason] || REASONS["inspection-unavailable"], errors };
}

/** Manual maintenance accepts no caller paths and shares both scheduler and profile locks. */
export class ManualCacheMaintenance {
  constructor({ profilesRoot, loadState, syncManager, profileMaintenance,
    listProfiles = listProfileDirectories, inspect = inspectProfileCache, now = () => new Date().toISOString() }) {
    this.profilesRoot = path.resolve(profilesRoot);
    this.loadState = loadState;
    this.syncManager = syncManager;
    this.profileMaintenance = profileMaintenance;
    this.listProfiles = listProfiles;
    this.inspect = inspect;
    this.now = now;
    this.cleaning = false;
    this.profileRemovalIds = new Map();
    this.profileRemovalIdentities = new Map();
  }

  assertAvailable() {
    if (this.cleaning) throw requestError(409, "缓存清理正在进行，请等待完成；无需重复点击。");
  }

  async inventory() {
    const state = await this.loadState();
    const registry = getPlatformRegistry(state.customPlatforms || []);
    const errors = [];
    const listed = await this.listProfiles(this.profilesRoot, { onError: (error) => errors.push(error) });
    const safe = new Set(listed.map(keyFor));
    const accounts = (state.linkedAccounts || []).filter((account) => typeof account.profileDirectory === "string" && account.profileDirectory);
    const candidates = new Map(listed.map((profile) => [keyFor(profile), profile]));
    for (const account of accounts) if (!candidates.has(keyFor(account.profileDirectory))) {
      candidates.set(keyFor(account.profileDirectory), account.profileDirectory);
    }
    const profiles = [...candidates.entries()].map(([key, profilePath]) => {
      const linked = accounts.filter((account) => keyFor(account.profileDirectory) === key);
      if (!this.profileRemovalIds.has(key)) this.profileRemovalIds.set(key, randomUUID());
      const platformId = linked[0]?.platformId || path.basename(path.dirname(profilePath));
      const entry = {
        platformId, profileId: path.basename(profilePath),
        platformLabel: registry[platformId]?.label || linked[0]?.platformLabel || platformId,
        accountLabel: linked.length ? linked.map((account) => account.label || "关联账号").join(" / ") : "历史浏览器资料（当前未绑定）",
        linked: linked.length > 0,
        removalId: linked.length ? null : this.profileRemovalIds.get(key),
        removable: false,
        ...(!linked.length ? { removalWarning: REMOVAL_WARNING } : {}),
      };
      const matchingError = errors.find((error) => {
        if (!error.path) return false;
        const relative = path.relative(path.resolve(error.path), path.resolve(profilePath));
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      });
      const relativeParts = path.relative(this.profilesRoot, path.resolve(profilePath)).split(path.sep);
      const allowedLocation = relativeParts.length === 2 && relativeParts[0] === platformId
        && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(relativeParts[1])
        && (["x", "instagram", "facebook", "threads", "tiktok"].includes(platformId)
          || /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(platformId));
      return { entry, profilePath, safe: safe.has(key) && allowedLocation,
        unavailableReason: !allowedLocation ? "unsafe-profile" : matchingError
          ? matchingError.code === "UNSAFE_CACHE_PATH" ? "unsafe-profile" : "inspection-unavailable" : "profile-missing", keys: [
        `profile:${key}`, ...linked.map((account) => `login:${account.id}`),
      ] };
    }).sort((left, right) => left.entry.platformId.localeCompare(right.entry.platformId)
      || left.entry.profileId.localeCompare(right.entry.profileId));
    return { profiles, errors: publicErrors(errors) };
  }

  reserve(profile) {
    const { entry, keys, profilePath, safe } = profile;
    if (!safe) return skipped(entry, profile.unavailableReason || "profile-missing");
    if (keys.some((key) => this.syncManager.activeResourceKeys.has(key))
      || this.profileMaintenance.busy.has(maintenanceKey(profilePath))) return skipped(entry, "profile-busy");
    // No await between conflict detection and reservation: a newly started sync
    // queues on these same keys, including unlinked profiles' physical path.
    for (const key of keys) this.syncManager.activeResourceKeys.add(key);
    return null;
  }

  release(profile) {
    for (const key of profile.keys) this.syncManager.activeResourceKeys.delete(key);
  }

  async preview() {
    this.assertAvailable();
    const inventory = await this.inventory();
    this.assertAvailable();
    const profiles = [];
    for (const profile of inventory.profiles) {
      const unavailable = this.reserve(profile);
      if (unavailable) { profiles.push({ ...unavailable, bytes: 0, files: 0 }); continue; }
      try {
        const result = await this.profileMaintenance.withProfileUse(profile.profilePath, async () => {
          if (await this.profileMaintenance.isRunning(profile.profilePath)) {
            return { ...skipped(profile.entry, "browser-busy"), bytes: 0, files: 0 };
          }
          const report = await this.inspect({ profilesRoot: this.profilesRoot, profilePath: profile.profilePath });
          const errors = publicErrors(report.errors);
          let wholeProfile = {};
          if (!profile.entry.linked) {
            try {
              const whole = await inspectHistoricalProfile(this.profilesRoot, profile.profilePath);
              const identity = whole.parents.at(-1).info;
              const profileKey = keyFor(profile.profilePath);
              const issued = this.profileRemovalIdentities.get(profileKey);
              if (issued && (issued.dev !== identity.dev || issued.ino !== identity.ino)) {
                this.profileRemovalIds.set(profileKey, randomUUID());
              }
              this.profileRemovalIdentities.set(profileKey, { dev: identity.dev, ino: identity.ino });
              wholeProfile = { removable: true, removalId: this.profileRemovalIds.get(profileKey),
                profileBytes: count(whole.bytes), profileFiles: count(whole.files) };
            } catch {
              wholeProfile = { removable: false, removalReason: "历史资料包含异常路径或无法完整检查，已禁止删除。"};
            }
          }
          return { ...profile.entry, bytes: count(report.bytes), files: count(report.files),
            ...wholeProfile,
            status: errors.length ? (report.bytes > 0 || report.directories > 0 ? "partial" : "skipped") : report.status,
            ...(errors.length ? { reason: "inspection-unavailable", message: REASONS["inspection-unavailable"] } : {}), errors };
        });
        profiles.push(result);
      } catch (error) {
        profiles.push({ ...skipped(profile.entry, error.status === 409 ? "profile-busy" : "cleanup-unavailable"), bytes: 0, files: 0 });
      } finally { this.release(profile); this.syncManager.drain(); }
    }
    const skippedProfiles = profiles.filter((entry) => entry.status === "skipped").length;
    const totalBytes = profiles.reduce((total, entry) => total + entry.bytes, 0);
    const totalFiles = profiles.reduce((total, entry) => total + entry.files, 0);
    return { scannedAt: this.now(), status: skippedProfiles || inventory.errors.length || profiles.some((entry) => entry.status === "partial")
      ? "partial" : totalBytes || totalFiles ? "ready" : "empty", totalBytes, totalFiles, skippedProfiles, profiles, errors: inventory.errors };
  }

  async clean(body) {
    assertCacheCleanupRequest(body);
    this.assertAvailable();
    this.cleaning = true;
    const held = [];
    try {
      const inventory = await this.inventory();
      // Reserve every idle candidate up front; the async cleaning of one profile
      // cannot allow a new job/login to enter another reserved profile meanwhile.
      const candidates = inventory.profiles.map((profile) => {
        const unavailable = this.reserve(profile);
        if (!unavailable) held.push(profile);
        return { profile, unavailable };
      });
      const profiles = [];
      for (const { profile, unavailable } of candidates) {
        if (unavailable) { profiles.push({ ...unavailable, removedBytes: 0, removedFiles: 0 }); continue; }
        let report;
        try {
          report = await this.profileMaintenance.cleanupAccount({
            platformId: profile.entry.platformId, linkedAccount: { profileDirectory: profile.profilePath },
          });
        } catch { report = { status: "skipped", reason: "cleanup-unavailable" }; }
        const errors = publicErrors(report.errors);
        profiles.push({ ...profile.entry, status: report.status || "skipped",
          removedBytes: count(report.removedBytes), removedFiles: count(report.removedFiles),
          ...(report.reason ? { reason: report.reason, message: REASONS[report.reason] || REASONS["cleanup-unavailable"] } : {}),
          ...(errors.length ? { message: "部分缓存清理未完成，相关文件已保留。" } : {}), errors });
      }
      const removedBytes = profiles.reduce((total, entry) => total + entry.removedBytes, 0);
      const removedFiles = profiles.reduce((total, entry) => total + entry.removedFiles, 0);
      const cleanedProfiles = profiles.filter((entry) => entry.status === "cleaned").length;
      const skippedProfiles = profiles.filter((entry) => entry.status === "skipped").length;
      return { completedAt: this.now(), status: skippedProfiles || inventory.errors.length || profiles.some((entry) => entry.status === "partial")
        ? "partial" : removedBytes || removedFiles ? "cleaned" : "empty",
      removedBytes, removedFiles, cleanedProfiles, skippedProfiles, profiles, errors: inventory.errors };
    } finally {
      for (const profile of held) this.release(profile);
      this.cleaning = false;
      this.syncManager.drain();
    }
  }

  async removeUnlinkedProfiles(body) {
    assertProfileRemovalRequest(body);
    this.assertAvailable();
    this.cleaning = true;
    const held = [];
    try {
      const inventory = await this.inventory();
      const selected = body.profileIds.map((id) => inventory.profiles.find((profile) =>
        this.profileRemovalIds.get(keyFor(profile.profilePath))?.toLowerCase() === id.toLowerCase()));
      if (selected.some((profile) => !profile)) {
        throw requestError(409, "所选历史资料已变化或不属于当前扫描结果，请重新扫描后选择；未删除任何资料。");
      }
      // Reserve every selected unlinked profile before yielding to any I/O.
      const candidates = selected.map((profile, index) => {
        const unavailable = profile.entry.linked ? skipped(profile.entry, "linked-profile") : this.reserve(profile);
        if (!unavailable) held.push(profile);
        return { profile, unavailable, issuedId: body.profileIds[index] };
      });
      const profiles = [];
      for (const { profile, unavailable, issuedId } of candidates) {
        if (unavailable) {
          profiles.push({ ...unavailable, removalId: issuedId, removedBytes: 0, removedFiles: 0 });
          continue;
        }
        let report;
        try {
          report = await this.profileMaintenance.withProfileUse(profile.profilePath, async () => {
            const boundNow = async () => {
              const state = await this.loadState();
              return (state.linkedAccounts || []).some((account) => typeof account.profileDirectory === "string"
                && account.profileDirectory && keyFor(account.profileDirectory) === keyFor(profile.profilePath));
            };
            if (await boundNow()) return skipped(profile.entry, "linked-profile");
            if (await this.profileMaintenance.isRunning(profile.profilePath)) return skipped(profile.entry, "browser-busy");
            const removeIdleProfile = async () => {
              const snapshot = await inspectHistoricalProfile(this.profilesRoot, profile.profilePath);
              const identity = snapshot.parents.at(-1).info;
              const profileKey = keyFor(profile.profilePath);
              const issued = this.profileRemovalIdentities.get(profileKey);
              if (!issued || issued.dev !== identity.dev || issued.ino !== identity.ino) {
                this.profileRemovalIds.set(profileKey, randomUUID());
                this.profileRemovalIdentities.delete(profileKey);
                return skipped(profile.entry, "profile-changed");
              }
              return removeHistoricalProfile({
                profilesRoot: this.profilesRoot, profilePath: profile.profilePath, snapshot, now: this.now,
                beforeMove: async () => {
                  if (await this.profileMaintenance.isRunning(profile.profilePath)) {
                    throw Object.assign(new Error(REASONS["browser-busy"]), { reason: "browser-busy" });
                  }
                  if (await boundNow()) throw Object.assign(new Error(REASONS["linked-profile"]), { reason: "linked-profile" });
                },
              });
            };
            // A pending TikTok launch can own a lease before CIM sees Chromium.
            // Share that same lease while inspecting/moving the idle profile.
            return profile.entry.platformId === "tiktok"
              ? this.profileMaintenance.idleTikTok(profile.profilePath, removeIdleProfile)
              : removeIdleProfile();
          });
        } catch (error) {
          report = { status: "skipped", reason: error.status === 409 ? "profile-busy"
            : error.code === "UNSAFE_CACHE_PATH" ? "unsafe-profile" : "cleanup-unavailable",
          errors: [{ code: error.code || "PROFILE_REMOVAL_FAILED", message: error.message }] };
        }
        profiles.push({ ...profile.entry, removalId: issuedId, status: report.status || "skipped",
          ...(report.reason === "linked-profile" ? { linked: true, removable: false } : {}),
          removedBytes: count(report.removedBytes), removedFiles: count(report.removedFiles),
          ...(report.reason ? { reason: report.reason, message: REASONS[report.reason] || REASONS["cleanup-unavailable"] } : {}),
          ...(report.remainingPath ? { remainingPath: report.remainingPath } : {}),
          errors: publicErrors(report.errors) });
      }
      const removedProfiles = profiles.filter((entry) => entry.status === "removed").length;
      const skippedProfiles = profiles.filter((entry) => entry.status === "skipped").length;
      return { completedAt: this.now(), status: skippedProfiles || inventory.errors.length
        || profiles.some((entry) => entry.status === "partial") ? "partial" : removedProfiles ? "removed" : "empty",
      removedBytes: profiles.reduce((total, entry) => total + entry.removedBytes, 0),
      removedFiles: profiles.reduce((total, entry) => total + entry.removedFiles, 0),
      removedProfiles, skippedProfiles, profiles, errors: inventory.errors };
    } finally {
      for (const profile of held) this.release(profile);
      this.cleaning = false;
      this.syncManager.drain();
    }
  }
}
