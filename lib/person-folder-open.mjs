import path from "node:path";
import { lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const defaultScript = path.resolve(import.meta.dirname, "../scripts/windows-folder-open.ps1");

export class PersonFolderOpenError extends Error {
  constructor(status, message) { super(message); this.name = "PersonFolderOpenError"; this.status = status; }
}

// Only a stored person record can choose the path. This is intentionally not a
// general client-supplied open-path API, and it never creates/reindexes a folder.
export async function openPersonFolder(person, { execute = executeFile, inspect = lstat,
  platform = process.platform, scriptPath = defaultScript, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error("Operation cancelled");
  const raw = person?.folderPath;
  const absolute = typeof raw === "string" && (platform === "win32"
    ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(raw) && !/^\\\\[?.][\\/]/.test(raw)
    : path.isAbsolute(raw));
  if (!absolute || /[\u0000-\u001f]/.test(raw)) {
    throw new PersonFolderOpenError(400, "人物文件夹路径无效，未打开其他位置。");
  }
  const target = platform === "win32" ? path.win32.resolve(raw) : path.resolve(raw);
  let info;
  try { info = await inspect(target); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new PersonFolderOpenError(503, "人物文件夹当前不可访问，请检查网络共享、磁盘连接或目录是否存在。");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PersonFolderOpenError(400, "人物路径不是普通文件夹，未打开文件或目录链接。");
  }
  if (platform !== "win32") throw new PersonFolderOpenError(501, "此功能需要 Windows 文件资源管理器。");
  if (signal?.aborted) throw signal.reason || new Error("Operation cancelled");
  try {
    const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
      "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-TargetPath", target],
    { windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 16_384, signal });
    const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim());
    const field = (name) => { const values = lines.filter((line) => line.startsWith(`${name}=`)); return values.length === 1 ? values[0].slice(name.length + 1) : null; };
    if (field("launched") !== "true") throw new Error("Folder launch not confirmed");
    return { ok: true, launched: true, foreground: field("foreground") === "true" };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PersonFolderOpenError(500, "Windows 未能打开人物文件夹，请检查文件资源管理器后重试。");
  }
}
