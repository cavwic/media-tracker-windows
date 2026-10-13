import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openPersonFolder } from "../lib/person-folder-open.mjs";

const directory = { isDirectory: () => true, isSymbolicLink: () => false };

test("stored local and UNC folders use literal hidden native arguments without touching indexes", async () => {
  for (const folderPath of ["D:\\Media Library\\人物 A & B [1]", "\\\\EXAMPLE-NAS\\FileShare\\Material\\人物'A"]) {
    const inspected = [], invoked = [];
    const result = await openPersonFolder({ id: "a", folderPath }, { platform: "win32", inspect: async (target) => { inspected.push(target); return directory; },
      execute: async (...args) => { invoked.push(args); return { stdout: "launched=true\r\nforeground=true\r\n" }; } });
    assert.deepEqual(result, { ok: true, launched: true, foreground: true });
    assert.deepEqual(inspected, [folderPath]);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0][0], "powershell.exe");
    assert.deepEqual(invoked[0][1].slice(-2), ["-TargetPath", folderPath]);
    assert.ok(invoked[0][1].includes("-File"));
    assert.ok(!invoked[0][1].includes("-Command"));
    assert.equal(invoked[0][2].windowsHide, true);
    assert.equal(invoked[0][2].timeout, 15_000);
  }
});

test("relative, provider, executable-like and malformed paths fail before filesystem or native launch", async () => {
  for (const folderPath of [undefined, "", "D:relative", "\\relative", "..\\other", "file:///C:/People", "Registry::HKEY_CURRENT_USER", "D:\\A\0B", "\\\\?\\C:\\People"]) {
    let touched = false;
    await assert.rejects(openPersonFolder({ folderPath }, { platform: "win32", inspect: async () => { touched = true; return directory; },
      execute: async () => { touched = true; } }), (error) => error.status === 400);
    assert.equal(touched, false);
  }
});

test("missing network folders, files and directory links never launch or create another location", async () => {
  for (const [inspect, expected] of [
    [async () => { throw Object.assign(new Error("unreachable"), { code: "ENOENT" }); }, 503],
    [async () => ({ isDirectory: () => false, isSymbolicLink: () => false }), 400],
    [async () => ({ isDirectory: () => true, isSymbolicLink: () => true }), 400],
  ]) {
    let launched = false;
    await assert.rejects(openPersonFolder({ folderPath: "D:\\Person" }, { platform: "win32", inspect,
      execute: async () => { launched = true; } }), (error) => error.status === expected);
    assert.equal(launched, false);
  }
});

test("default-app acceptance is distinguished from actual foreground and failures cannot fake success", async () => {
  const options = { platform: "win32", inspect: async () => directory };
  assert.deepEqual(await openPersonFolder({ folderPath: "D:\\Person" }, { ...options, execute: async () => ({ stdout: "launched=true\nforeground=false" }) }),
    { ok: true, launched: true, foreground: false });
  for (const stdout of ["", "foreground=true", "launched=false", "launched=true\nlaunched=false", "launched=true\nlaunched=true"]) {
    await assert.rejects(openPersonFolder({ folderPath: "D:\\Person" }, { ...options, execute: async () => ({ stdout }) }), (error) => error.status === 500);
  }
  await assert.rejects(openPersonFolder({ folderPath: "D:\\Person" }, { ...options, execute: async () => { throw new Error("private path and diagnostic"); } }),
    (error) => error.status === 500 && !error.message.includes("private"));
});

test("shutdown cancels folder requests before touching storage or launching a process", async () => {
  const cancellation = new AbortController(); cancellation.abort(new Error("fixture cancelled"));
  await assert.rejects(openPersonFolder({ folderPath: "D:\\Person" }, { platform: "win32", signal: cancellation.signal,
    inspect: async () => assert.fail("must not touch storage"), execute: async () => assert.fail("must not launch") }), /fixture cancelled/);
});

test("native folder helper opens exact COM directory and never invokes CMD, custom associations or deletes data", async () => {
  const source = await readFile(new URL("../scripts/windows-folder-open.ps1", import.meta.url), "utf8");
  assert.match(source, /Get-Item -LiteralPath \$TargetPath/);
  assert.match(source, /\$collectorShell\.Open\(\$collectorFolder\.FullName\)/);
  assert.match(source, /OrdinalIgnoreCase/);
  assert.doesNotMatch(source, /cmd\.exe|Invoke-Expression|Remove-Item|Stop-Process|Set-ItemProperty|AppActivate|Topmost/i);
});
