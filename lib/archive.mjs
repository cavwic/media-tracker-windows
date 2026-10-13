import path from "node:path";
import { mkdir, stat } from "node:fs/promises";

export const PLATFORMS = Object.freeze({
  x: { label: "X", loginUrl: "https://x.com/login" },
  instagram: { label: "Instagram", loginUrl: "https://www.instagram.com/" },
  threads: { label: "Threads", loginUrl: "https://www.threads.com/login" },
  facebook: { label: "Facebook", loginUrl: "https://www.facebook.com/" },
  tiktok: { label: "TikTok", loginUrl: "https://www.tiktok.com/" },
});

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeSegment(value, fieldName = "名称") {
  const source = String(value ?? "").normalize("NFKC");
  const meaningful = source.replace(INVALID_WINDOWS_CHARS, "").replace(/[. ]+$/g, "").trim();
  if (!meaningful) {
    throw new Error(`${fieldName}不能为空，也不能只包含 Windows 不允许的字符。`);
  }

  const normalized = source
    .replace(INVALID_WINDOWS_CHARS, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  const safe = WINDOWS_RESERVED.test(normalized) ? `${normalized}_` : normalized;
  return safe.slice(0, 100);
}

export function normalizePlatforms(platforms = [], registry = PLATFORMS) {
  if (!Array.isArray(platforms)) {
    throw new Error("社交媒体平台格式无效。");
  }

  const seenPlatforms = new Set();

  return platforms.map((platform) => {
    const platformId = String(platform?.id ?? "").toLowerCase();
    const platformInfo = Object.hasOwn(registry, platformId) ? registry[platformId] : null;
    if (!platformInfo) throw new Error(`不支持的平台：${platformId || "未填写"}`);
    if (seenPlatforms.has(platformId)) throw new Error(`${platformInfo.label} 只能添加一次，账号应放在同一个平台下。`);
    seenPlatforms.add(platformId);

    if (!Array.isArray(platform.accounts) || platform.accounts.length === 0) {
      throw new Error(`${platformInfo.label} 至少需要添加一个账号。`);
    }

    const seenAccounts = new Set();
    const seenIds = new Set();
    const accounts = platform.accounts.map((account) => {
      const label = String(account?.label ?? "").trim();
      if (!label) throw new Error(`${platformInfo.label} 的账号名称不能为空。`);
      const folderName = sanitizeSegment(account?.folderName || label, "账号文件夹名称");
      const profileUrl = String(account?.profileUrl ?? "").trim();
      const accountKey = profileUrl || label.toLocaleLowerCase("zh-CN");
      const id = String(account?.id || crypto.randomUUID());
      if (seenAccounts.has(accountKey) || seenIds.has(id)) {
        throw new Error(`${platformInfo.label} 下存在重复的账号：${label}`);
      }
      seenAccounts.add(accountKey);
      seenIds.add(id);

      return {
        id,
        label,
        folderName,
        profileUrl,
        linkedAccountId: String(account?.linkedAccountId ?? "").trim(),
        // Pausing is scheduling policy only. Keep the account identity and all
        // source/binding metadata so a later resume reuses its own boundary.
        syncEnabled: account?.syncEnabled !== false,
        followRequested: Boolean(account?.followRequested),
        downloadMedia: {
          image: account?.downloadMedia?.image !== false,
          video: account?.downloadMedia?.video !== false,
          gif: account?.downloadMedia?.gif !== false,
        },
        discoveredFrom: String(account?.discoveredFrom ?? "").trim(),
        discoveryEvidence: String(account?.discoveryEvidence ?? "").trim(),
      };
    });

    return { id: platformId, label: platformInfo.label,
      ...(platformInfo.custom ? { folderName: platformInfo.folderName } : {}), accounts };
  });
}

export function resolvePersonFolder({ name, folderMode, selectedPath }) {
  const chosen = String(selectedPath ?? "").trim();
  if (!chosen) throw new Error("请先选择本地文件夹。 ");

  const resolvedSelection = path.resolve(chosen);
  if (path.parse(resolvedSelection).root === resolvedSelection) {
    throw new Error("不能直接使用磁盘根目录，请选择一个具体文件夹。 ");
  }

  if (folderMode === "new") {
    return path.join(resolvedSelection, sanitizeSegment(name, "人物名称"));
  }
  if (folderMode === "existing") return resolvedSelection;
  throw new Error("文件夹创建方式无效。 ");
}

export function requiredDirectories(personFolder) {
  return [path.join(personFolder, "Index")];
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function createArchiveDirectories(personFolder) {
  // Never interpret an offline NAS as an empty archive. Check the share/volume
  // anchor before recreating an explicitly configured person folder.
  const resolved = path.resolve(personFolder);
  const anchor = path.parse(resolved).root;
  const anchorInfo = await stat(anchor).catch(() => {
    const error = new Error("存储位置不可访问，请先连接网络共享或磁盘后重试。");
    error.status = 503;
    throw error;
  });
  if (!anchorInfo.isDirectory()) throw new Error("存储位置不是可用的目录。");
  await mkdir(resolved, { recursive: true });
  const directories = requiredDirectories(resolved);
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
  return directories;
}
