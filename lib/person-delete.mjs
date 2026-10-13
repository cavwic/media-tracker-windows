import path from "node:path";
import os from "node:os";
import { lstat, readdir, realpath, rm } from "node:fs/promises";

export class PersonDeletionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function overlaps(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

function normalizeTarget(value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new PersonDeletionError(400, "人物文件夹必须是明确的绝对路径；未删除任何人物记录。");
  }
  // Namespace/device paths and alternate streams must never enter a recursive deletion.
  if (process.platform === "win32" && (/^\\\\[?.]\\/.test(value) || /:/.test(value.slice(2)))) {
    throw new PersonDeletionError(400, "该人物文件夹路径不支持自动删除。请选择保留已同步内容。");
  }
  return path.resolve(value);
}

async function inspectPath(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertProtectedPaths(target, { projectRoot, dataRoot }) {
  const root = path.parse(target).root;
  if (!path.relative(root, target)) {
    throw new PersonDeletionError(400, "不能删除磁盘根目录或网络共享根目录。请选择保留已同步内容。");
  }
  const userRoots = [os.homedir(), process.env.USERPROFILE, process.env.PUBLIC].filter(Boolean);
  const protectedTrees = [
    projectRoot, dataRoot, process.env.SystemRoot, process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"], process.env.ProgramData, process.env.APPDATA,
    process.env.LOCALAPPDATA,
  ].filter(Boolean).map((value) => path.resolve(value));
  if (userRoots.some((value) => isWithin(target, path.resolve(value)))
    || protectedTrees.some((value) => overlaps(target, value))) {
    throw new PersonDeletionError(400, "该路径涉及用户根目录、系统或工具文件，不能自动删除。请选择保留已同步内容。");
  }
}

async function assertNoLinksInParents(target) {
  let current = target;
  while (current !== path.parse(current).root) {
    const info = await inspectPath(current);
    if (info?.isSymbolicLink()) {
      throw new PersonDeletionError(400, "人物路径经过链接或目录联接，不能自动删除。请选择保留已同步内容。");
    }
    current = path.dirname(current);
  }
}

async function assertNoLinksInTree(target) {
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      throw new PersonDeletionError(400, "人物文件夹内包含链接或目录联接，不能自动删除。请选择保留已同步内容。");
    }
    if (info.isDirectory()) await assertNoLinksInTree(child);
  }
}

/** Resolve a configured person only; never accept a deletion path from the client. */
export async function resolvePersonDeletionTarget({ personId, persons, projectRoot, dataRoot }) {
  const person = persons.find((item) => item.id === personId);
  if (!person) throw new PersonDeletionError(404, "人物不存在。");
  const target = normalizeTarget(person.folderPath);
  assertProtectedPaths(target, { projectRoot, dataRoot });
  await assertNoLinksInParents(target);
  const info = await inspectPath(target);
  if (info && !info.isDirectory()) throw new PersonDeletionError(400, "人物路径不是文件夹，不能自动删除。");
  const resolved = info ? await realpath(target) : target;
  assertProtectedPaths(resolved, { projectRoot, dataRoot });
  for (const other of persons) {
    if (other.id === personId) continue;
    const otherTarget = normalizeTarget(other.folderPath);
    const otherResolved = await realpath(otherTarget).catch((error) => {
      if (error.code === "ENOENT") return otherTarget;
      throw error;
    });
    if (overlaps(target, otherTarget) || overlaps(resolved, otherResolved)) {
      throw new PersonDeletionError(409, `人物文件夹与“${other.name}”的目录重叠，不能删除文件。请选择保留已同步内容。`);
    }
  }
  if (info) await assertNoLinksInTree(resolved);
  return { target, resolved, info };
}

export async function deletePersonDirectory(options) {
  const checked = await resolvePersonDeletionTarget(options);
  if (!checked.info) return { filesDeleted: false, folderMissing: true };
  // Revalidate the exact target immediately before the destructive operation.
  const current = await lstat(checked.target);
  const resolved = await realpath(checked.target);
  if (current.isSymbolicLink() || !current.isDirectory() || resolved !== checked.resolved
    || current.dev !== checked.info.dev || current.ino !== checked.info.ino) {
    throw new PersonDeletionError(409, "人物文件夹在确认后发生变化，本次未删除。请重新检查路径。");
  }
  await rm(checked.resolved, { recursive: true, force: false });
  return { filesDeleted: true, folderMissing: false };
}
