import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const psValue = (value) => `'${value.replaceAll("'", "''")}'`;
test("shortcut icon update only changes an exact owned launcher, preserving arguments and unrelated links", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-shortcut-icon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts"), assets = path.join(root, "public");
  await Promise.all([mkdir(scripts), mkdir(assets)]);
  await copyFile(path.join(workspace, "scripts/update-shortcut-icon.ps1"), path.join(scripts, "update-shortcut-icon.ps1"));
  await copyFile(path.join(workspace, "public/media-tracker-v2.ico"), path.join(assets, "media-tracker-v2.ico"));
  await writeFile(path.join(scripts, "start.vbs"), "' inert test fixture");
  await writeFile(path.join(root, "start.cmd"), "@rem inert test fixture");
  const create = `$root=${psValue(root)}; $shell=New-Object -ComObject WScript.Shell; $wscript=Join-Path $env:SystemRoot 'System32\\wscript.exe'; foreach($kind in @('owned','legacy','cmd','foreign','injected')) { $link=$shell.CreateShortcut((Join-Path $root ($kind+'.lnk'))); $link.TargetPath=$wscript; $link.Arguments='"'+(Join-Path $root 'scripts\\start.vbs')+'"'; if($kind -eq 'legacy'){ $link.Arguments='"'+(Join-Path $root 'start.vbs')+'"' }; if($kind -eq 'cmd'){ $link.TargetPath=Join-Path $root 'start.cmd'; $link.Arguments='' }; if($kind -eq 'foreign'){ $link.Arguments='"'+(Join-Path $root 'other-tool\\scripts\\start.vbs')+'"' }; if($kind -eq 'injected'){ $link.Arguments+=' extra-argument' }; $link.WorkingDirectory=$root; $link.Description='fixture retained'; $link.IconLocation=$wscript+',0'; $link.Save() }`;
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", create], { windowsHide: true });
  const inspect = `$root=${psValue(root)}; $shell=New-Object -ComObject WScript.Shell; @('owned','legacy','cmd','foreign','injected') | ForEach-Object { $link=$shell.CreateShortcut((Join-Path $root ($_+'.lnk'))); [pscustomobject]@{ Name=$_; Target=$link.TargetPath; Arguments=$link.Arguments; Icon=$link.IconLocation; WorkingDirectory=$link.WorkingDirectory; Description=$link.Description } } | ConvertTo-Json -Compress`;
  const read = async () => JSON.parse((await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", inspect], { windowsHide: true })).stdout);
  const before = await read();
  const argumentsFor = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "update-shortcut-icon.ps1"), "-ProjectOnly"];
  await execute(powershell, argumentsFor, { windowsHide: true });
  assert.deepEqual(await read(), before, "preview does not modify shortcuts");
  const result = await execute(powershell, [...argumentsFor, "-Apply"], { windowsHide: true });
  assert.match(result.stdout, /Updated owned shortcuts: 3/);
  const after = await read();
  assert.deepEqual(after.slice(3), before.slice(3));
  for (let index = 0; index < 3; index++) {
    assert.deepEqual({ ...after[index], Icon: before[index].Icon }, before[index]);
    assert.equal(after[index].Icon, path.join(assets, "media-tracker-v2.ico") + ",0");
  }
});
