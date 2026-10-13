import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBackupImport } from "../lib/backup-import.mjs";

export function parseBackupImportArgs(args) {
  const options = { apply: false, personIds: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--apply") options.apply = true;
    else if (key === "--preview") options.apply = false;
    else if (key === "--help") options.help = true;
    else if (key === "--json") options.json = true;
    else if (["--backup-root", "--manifest", "--data-dir", "--state-file", "--sync-file", "--person-id", "--concurrency", "--reviewed-variants"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数。`);
      if (key === "--person-id") options.personIds.push(value);
      else if (key === "--concurrency") {
        if (!/^[1-8]$/.test(value)) throw new Error("--concurrency 必须是 1 至 8。");
        options.concurrency = Number(value);
      } else options[{ "--backup-root": "backupRoot", "--manifest": "manifestFile", "--data-dir": "dataDir", "--state-file": "stateFile", "--sync-file": "syncFile", "--reviewed-variants": "reviewedVariantsFile" }[key]] = path.resolve(value);
    } else throw new Error(`不支持的参数：${key}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseBackupImportArgs(process.argv.slice(2));
    if (options.help) console.log("用法：node scripts/import-backup.mjs --backup-root 绝对路径 [--preview | --apply] [--manifest 旧v2清单] [--person-id 标识] [--concurrency 1-8] [--data-dir 路径] [--reviewed-variants 核验JSON]\n默认只预览，不创建文件。--apply 需工具完全退出，使用启动维护锁；先校验并备份原配置/同步索引/人物Index，再导入当前配置人物的媒体及全部旧来源。不改增量边界、不删除备份、不导入 Index/Thumbs.db，不创建未配置人物。SHA不符默认拒绝，只有精确核验清单授权的本地修改图片可作为独立 backup-variant 资产导入。全程只访问本地文件系统。");
    else {
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort(new Error("导入已取消；已提交文件及来源保留，再次运行可继续。")));
      const report = await runBackupImport({ ...options, signal: controller.signal, onProgress: (p) => console.log(`${p.name} · ${p.phase === "hash" ? "本地校验" : "导入"} ${p.completed}/${p.total}`) });
      // The complete per-file report is already saved beside the exact backups.
      // Keep the terminal usable during imports involving thousands of files.
      const output = options.json ? report : { ...report, persons: report.persons.map(({ files, ...person }) => ({ ...person, reportedFiles: files?.length || 0 })) };
      console.log(JSON.stringify(output, null, 2));
      if (report.persons.some((p) => p.errors.length) || report.cancelled) process.exitCode = 2;
    }
  } catch (error) { console.error(`备份导入未完成：${error.message}`); process.exitCode = 1; }
}
