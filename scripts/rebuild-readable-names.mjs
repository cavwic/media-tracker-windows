// Explicit offline maintenance only. Running without --apply never writes files.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { lstat, realpath, readFile, readdir, open, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SyncStore, DEFAULT_READABLE_REBUILD_ID, readableRebuildRecords } from "../lib/sync-store.mjs";
import { assertToolStopped } from "./clean-browser-cache.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const signature = (contents) => createHash("sha256").update(contents).digest("hex");
const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a, b) => normalized(path.resolve(a)) === normalized(path.resolve(b));
function includesPath(parent, child) {
  const relative = path.relative(normalized(path.resolve(parent)), normalized(path.resolve(child)));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseRebuildArgs(args) {
  const result = { apply: false, dataDir: path.join(PROJECT_ROOT, "data"), personIds: [], rebuildId: DEFAULT_READABLE_REBUILD_ID };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--apply") result.apply = true;
    else if (key === "--preview") result.apply = false;
    else if (key === "--help") result.help = true;
    else if (["--data-dir", "--state-file", "--person-id", "--rebuild-id"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数。`);
      if (key === "--data-dir") result.dataDir = path.resolve(value);
      else if (key === "--state-file") result.stateFile = path.resolve(value);
      else if (key === "--rebuild-id") result.rebuildId = value;
      else result.personIds.push(value);
    } else throw new Error(`不支持的参数：${key}`);
  }
  readableRebuildRecords({}, result.rebuildId);
  return result;
}

export async function assertReadableRebuildStopped() {
  await assertToolStopped();
  // Only this project's absolute service entrypoints, including the single-
  // process bootstrap before it begins listening; never unrelated servers.
  const serverPath = path.join(PROJECT_ROOT, "server.mjs").replaceAll("'", "''");
  const bootstrapPath = path.join(PROJECT_ROOT, "scripts", "start-service.mjs").replaceAll("'", "''");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.Name -match '^node(?:\\.exe)?$' -and $_.CommandLine -and ($_.CommandLine.IndexOf('${serverPath}',[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf('${bootstrapPath}',[StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const processes = JSON.parse(stdout.trim() || "[]");
  if ((Array.isArray(processes) ? processes : [processes]).length) {
    throw new Error("本项目服务进程仍在运行，请完全退出工具后重试。脚本不会终止进程。");
  }
}

async function assertOrdinaryDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
    throw new Error("目录包含链接、重解析目标或不是普通目录，暂不重建。");
  }
}

async function inspectAncestors(target) {
  const anchor = path.parse(target).root;
  await assertOrdinaryDirectory(anchor);
  const segments = path.relative(anchor, target).split(path.sep).filter(Boolean);
  let current = anchor, missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (missing) continue;
    try { await assertOrdinaryDirectory(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; missing = true; }
  }
  return !missing;
}

export async function inspectClearedPerson(person, { dataDir, persons = [] } = {}) {
  try {
    if (!person || typeof person.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(person.id)
      || typeof person.folderPath !== "string" || !path.isAbsolute(person.folderPath)) throw new Error("人物路径或标识无效。");
    const root = path.resolve(person.folderPath);
    if (samePath(root, path.parse(root).root) || (dataDir && (includesPath(root, dataDir) || includesPath(dataDir, root)))) {
      throw new Error("人物目录不能是磁盘/共享根目录或工具数据目录。");
    }
    for (const other of persons) {
      if (other !== person && other.id !== person.id && typeof other.folderPath === "string"
        && (includesPath(root, other.folderPath) || includesPath(other.folderPath, root))) throw new Error("人物目录与其他人物重叠，暂不重建。");
    }
    if (!await inspectAncestors(root)) return { personId: person.id, name: person.name, eligible: true, root, metadata: [] };
    const entries = await readdir(root, { withFileTypes: true });
    const metadata = [];
    for (const entry of entries) {
      if (!["Image", "Video", "Index"].includes(entry.name)) throw new Error(`目录含未识别的内容 ${entry.name}，保留全部同步记录。`);
      const directory = path.join(root, entry.name);
      await assertOrdinaryDirectory(directory);
      const children = await readdir(directory, { withFileTypes: true });
      if (entry.name !== "Index") {
        if (children.length) throw new Error(`${entry.name} 非空，保留全部同步记录。`);
        continue;
      }
      for (const child of children) {
        if (!["media-index.json", "events.jsonl"].includes(child.name)) throw new Error("Index 含未识别内容，保留全部同步记录。");
        const filePath = path.join(directory, child.name);
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) throw new Error("Index 元数据不是普通文件。");
        const contents = await readFile(filePath);
        if (child.name === "events.jsonl") {
          if (contents.toString("utf8").trim()) throw new Error("人物索引日志非空，保留全部同步记录。");
        } else {
          const snapshot = JSON.parse(contents.toString("utf8"));
          const pendingRenames = snapshot.pendingRenames || {};
          if (![1, 2].includes(snapshot.version) || snapshot.layout !== "person-v1" || snapshot.personId !== person.id
            || !snapshot.assets || typeof snapshot.assets !== "object" || Array.isArray(snapshot.assets)
            || Object.keys(snapshot.assets).length || snapshot.appliedSeq !== 0
            || typeof pendingRenames !== "object" || Array.isArray(pendingRenames)
            || Object.keys(pendingRenames).length || Object.keys(snapshot.pendingNaming || {}).length) {
            throw new Error("人物快照不为空、损坏或所有者不匹配，保留全部同步记录。");
          }
        }
        metadata.push({ filePath, filename: child.name, contents, signature: signature(contents) });
      }
    }
    return { personId: person.id, name: person.name, eligible: true, root, metadata };
  } catch (error) {
    return { personId: person?.id || "", name: person?.name || "", eligible: false,
      reason: ["ENOENT", "EACCES", "EPERM", "ENOTCONN", "EIO", "ENETUNREACH"].includes(error.code)
        ? "共享、目录或索引不可访问，未重置历史。" : error.message };
  }
}

async function backupExact(filePath, contents) {
  const handle = await open(filePath, "wx");
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  if (!Buffer.from(await readFile(filePath)).equals(Buffer.from(contents))) throw new Error("备份校验失败，原索引未重置。");
}

export async function runReadableNamingRebuild({ apply = false, dataDir = path.join(PROJECT_ROOT, "data"),
  stateFile, personIds = [], rebuildId = DEFAULT_READABLE_REBUILD_ID, write = console.log, assertStopped = assertReadableRebuildStopped,
  inspect = inspectClearedPerson } = {}) {
  dataDir = path.resolve(dataDir);
  stateFile = path.resolve(stateFile || path.join(dataDir, "state.json"));
  const syncFile = path.join(dataDir, "sync-index.json");
  await assertOrdinaryDirectory(dataDir);
  for (const file of [stateFile, syncFile]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(file), file)) throw new Error("配置或同步索引不是普通文件，未进行重建。");
  }
  const [stateRaw, syncRaw] = await Promise.all([readFile(stateFile), readFile(syncFile)]);
  const state = JSON.parse(stateRaw.toString("utf8"));
  const current = JSON.parse(syncRaw.toString("utf8"));
  if (!Array.isArray(state.persons) || current.version !== 3 || current.layout !== "person-v1") {
    throw new Error("配置或同步索引版本异常，未进行重建。");
  }
  for (const key of ["scopes", "summaries", "receipts", "storageInitialized"]) {
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) throw new Error("同步索引记录损坏，未进行重建。");
  }
  const completed = readableRebuildRecords(current, rebuildId);
  const knownIds = new Set(state.persons.map((person) => person.id));
  if (knownIds.size !== state.persons.length || personIds.some((id) => !knownIds.has(id))) throw new Error("人物配置重复或选中了不存在的人物。");
  const selected = state.persons.filter((person) => !personIds.length || personIds.includes(person.id));
  const reports = [];
  for (const person of selected) {
    if (Object.hasOwn(completed, person.id)) {
      reports.push({ personId: person.id, name: person.name, eligible: false, completed: true, reason: "已完成过本次重建，不会再次重置。" });
    } else reports.push(await inspect(person, { dataDir, persons: state.persons }));
  }
  for (const report of reports) write(`${report.name || report.personId}：${report.eligible ? "目录已清空，可重建首次同步记录" : report.reason}`);
  const eligible = reports.filter((report) => report.eligible);
  if (!apply || !eligible.length) {
    write(apply ? "无可处理人物，未写入任何文件。" : "仅预览，未写入任何文件；执行需要 --apply 并完全退出工具。");
    return { applied: [], reports, exitCode: reports.some((report) => !report.eligible && !report.completed) ? 2 : 0 };
  }
  await assertStopped();
  const lockPath = path.join(dataDir, ".readable-names-maintenance.lock");
  const token = randomUUID();
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
    await assertStopped();
    if (!Buffer.from(await readFile(stateFile)).equals(stateRaw) || !Buffer.from(await readFile(syncFile)).equals(syncRaw)) {
      throw new Error("维护期间配置或索引发生变化；未重建。");
    }
    for (const previous of eligible) {
      const person = selected.find((candidate) => candidate.id === previous.personId);
      const again = await inspect(person, { dataDir, persons: state.persons });
      if (!again.eligible || JSON.stringify(again.metadata.map((item) => [item.filePath, item.signature]))
        !== JSON.stringify(previous.metadata.map((item) => [item.filePath, item.signature]))) {
        throw new Error("人物目录或索引在维护期间发生变化；未重建。");
      }
    }
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const backupFile = `sync-index.json.readable-names-backup-${rebuildId}-${stamp}.json`;
    await backupExact(path.join(dataDir, backupFile), syncRaw);
    // Empty person metadata stays in place; extra exact backups make recovery independently possible.
    for (const report of eligible) {
      for (const metadata of report.metadata) {
        await backupExact(path.join(dataDir, `readable-names-${report.personId}-${metadata.filename}-${stamp}.bak`), metadata.contents);
      }
    }
    await assertStopped();
    if (!Buffer.from(await readFile(stateFile)).equals(stateRaw)) throw new Error("人物配置发生变化；原索引未重置。");
    for (const previous of eligible) {
      const again = await inspect(selected.find((person) => person.id === previous.personId), { dataDir, persons: state.persons });
      if (!again.eligible || JSON.stringify(again.metadata.map((item) => [item.filePath, item.signature]))
        !== JSON.stringify(previous.metadata.map((item) => [item.filePath, item.signature]))) {
        throw new Error("人物目录或索引不再为空或已变化；原索引未重置。");
      }
    }
    const store = new SyncStore(syncFile); await store.ready;
    const applied = await store.rebuildClearedPersons(eligible.map((report) => report.personId), { backupFile, expectedContents: syncRaw, rebuildId });
    write(`已重建 ${applied.length} 个人物的首次同步记录；人物配置、登录资料和媒体目录均未改动。备份：${backupFile}`);
    return { applied, backupFile, reports, exitCode: reports.some((report) => !report.eligible && !report.completed) ? 2 : 0 };
  } finally {
    await lock.close();
    const owned = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
    if (owned.token === token) await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRebuildArgs(process.argv.slice(2));
    if (options.help) console.log("用法：node scripts/rebuild-readable-names.mjs [--preview | --apply] [--data-dir 路径] [--state-file 路径] [--person-id 标识] [--rebuild-id readable-names-v1 | legacy-date-v1 | beijing-date-v1]\n默认只预览。每轮仅为已清空、该轮未重建过的人物重置首次同步记录；不会删除媒体、修改配置、清空非空Index或关闭其他进程。");
    else process.exitCode = (await runReadableNamingRebuild(options)).exitCode;
  } catch (error) { console.error(`重建未完成：${error.message}`); process.exitCode = 1; }
}
