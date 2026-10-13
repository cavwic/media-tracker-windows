import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
const quotePs = (value) => "'" + value.replaceAll("'", "''") + "'";
const fakeNodeSource = String.raw`
using System;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
public static class FakeCollectorNode {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  static void Emit(string key, string value) {
    Console.Out.WriteLine(key + "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")));
  }
  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length > 0 && args[0] == "-e") {
      Emit("PROBE", args.Length > 1 ? args[1] : "");
      int probeExit;
      return int.TryParse(Environment.GetEnvironmentVariable("COLLECTOR_TEST_PROBE_EXIT"), out probeExit) ? probeExit : 0;
    }
    if (args.Length > 0 && args[0] == "-echo") {
      for (int i = 1; i < args.Length; i++) Emit("ARG", args[i]);
      return 0;
    }
    string entry = args.Length > 0 ? args[0] : "";
    string mode = Environment.GetEnvironmentVariable("COLLECTOR_TEST_BOOTSTRAP_FAILURE");
    string readyFile = Environment.GetEnvironmentVariable("COLLECTOR_TEST_READY_FILE");
    if (args.Length > 2 && args[1] == "install") {
      Emit("INSTALL", Path.GetFileName(entry) == "npm-cli.js" ? "npm" : args[2]);
      if (!string.IsNullOrEmpty(readyFile)) File.WriteAllText(readyFile, "installed fixture only");
      return 0;
    }
    if (entry.EndsWith("start-service.mjs") && !string.IsNullOrEmpty(mode) && !File.Exists(readyFile)) {
      string token = Environment.GetEnvironmentVariable("MEDIA_TRACKER_BOOTSTRAP_TOKEN");
      if (Environment.GetEnvironmentVariable("COLLECTOR_TEST_BAD_STATUS_TOKEN") == "1") token = new string('b', 32);
      int failureCode = mode == "missing-chromium" ? 22 : 21;
      string status = "{\"schemaVersion\":1,\"token\":\"" + token + "\",\"reason\":\"" + mode + "\",\"exitCode\":" + failureCode + "}";
      File.WriteAllText(Environment.GetEnvironmentVariable("MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE"), status, new UTF8Encoding(false));
      return failureCode;
    }
    Console.Out.WriteLine("CONSOLE_HANDLE=" + GetConsoleWindow().ToInt64());
    Emit("BOOTSTRAP", entry);
    Emit("SERVER", entry.EndsWith("start-service.mjs") ? Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(entry)), "server.mjs") : entry);
    Emit("CWD", Environment.CurrentDirectory);
    foreach (string key in new string[] { "MEDIA_TRACKER_BACKGROUND_START", "MEDIA_TRACKER_DATA_DIR", "MEDIA_TRACKER_PORT", "MEDIA_TRACKER_NO_OPEN", "MEDIA_TRACKER_LAUNCH_STARTED_AT_MS", "COLLECTOR_TEST_INHERITED" })
      Emit(key, Environment.GetEnvironmentVariable(key));
    Console.Out.WriteLine("stdout-\u4e2d\u6587");
    Console.Error.WriteLine("stderr-\u4e2d\u6587");
    if (Environment.GetEnvironmentVariable("COLLECTOR_TEST_NOISY") == "1") {
      Console.Out.WriteLine(new string('x', 256 * 1024));
      Console.Error.WriteLine(new string('y', 256 * 1024));
    }
    int exitCode;
    return int.TryParse(Environment.GetEnvironmentVariable("COLLECTOR_TEST_EXIT"), out exitCode) ? exitCode : 0;
  }
}
`;

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "media-tracker-hidden-start-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith("media-tracker-hidden-start-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

async function compileFakeNode(directory) {
  const bin = path.join(directory, "fixture node bin");
  await mkdir(bin);
  const executable = path.join(bin, "node.exe");
  const command = `Add-Type -TypeDefinition @'\n${fakeNodeSource}\n'@ -OutputAssembly ${quotePs(executable)} -OutputType ConsoleApplication`;
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 20_000 });
  return executable;
}

async function fixture(directory, name, executable, overrides = {}) {
  const project = path.join(directory, `${name} 中文项目 Person's & (space)`);
  const data = path.join(project, "自定义 数据 & (files)");
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await mkdir(path.join(project, "node_modules", "playwright"), { recursive: true });
  await mkdir(data);
  await copyFile(path.join(root, "scripts", "start-hidden.ps1"), path.join(project, "scripts", "start-hidden.ps1"));
  await copyFile(path.join(root, "scripts", "start-service.mjs"), path.join(project, "scripts", "start-service.mjs"));
  let vbs = await readFile(path.join(root, "start.vbs"), "utf8");
  // This is the exact WScript entry flow, with only the documented fixture
  // switch appended. A failed regression must never leave a modal user window.
  vbs = vbs.replace('\\scripts\\start-hidden.ps1"""', '\\scripts\\start-hidden.ps1"" -NoErrorDialog"');
  assert.match(vbs, /start-hidden\.ps1"" -NoErrorDialog"/);
  await writeFile(path.join(project, "start.vbs"), vbs);
  await copyFile(path.join(root, "start.cmd"), path.join(project, "start.cmd"));
  await writeFile(path.join(project, "node_modules", "playwright", "package.json"), "{}");
  await writeFile(path.join(project, "server.mjs"), "// Fixture node.exe reports this path; never starts a server.\n");
  const sentinels = new Map([
    [path.join(data, "state.json"), '{"persons":[{"name":"fixture"}],"linkedAccounts":[{"id":"keep"}]}'],
    [path.join(data, "sync-index.json"), '{"fixture":"incremental-boundaries-unchanged"}'],
    [path.join(data, "media-fixture.jpg"), "Not real media: preservation sentinel"],
  ]);
  for (const [filename, content] of sentinels) await writeFile(filename, content);
  return { project, data, sentinels, env: {
    ...process.env,
    PATH: path.dirname(executable) + path.delimiter + process.env.PATH,
    MEDIA_TRACKER_DATA_DIR: data,
    MEDIA_TRACKER_PORT: "49123",
    MEDIA_TRACKER_NO_OPEN: "1",
    COLLECTOR_TEST_INHERITED: "原值 ' & \\保持",
    ...overrides,
  } };
}

async function logs(item) {
  const files = await readdir(path.join(item.data, "startup-logs"));
  assert.equal(files.length, 2);
  const stdout = await readFile(path.join(item.data, "startup-logs", files.find((name) => name.endsWith(".out.log"))), "utf8");
  const stderr = await readFile(path.join(item.data, "startup-logs", files.find((name) => name.endsWith(".err.log"))), "utf8");
  return { stdout, stderr };
}

function field(stdout, key) {
  const value = stdout.split(/\r?\n/).find((line) => line.startsWith(key + "="));
  assert.ok(value, `Missing fixture field ${key}`);
  return Buffer.from(value.slice(key.length + 1), "base64").toString("utf8");
}

async function assertPreserved(item) {
  for (const [filename, content] of item.sentinels) assert.equal(await readFile(filename, "utf8"), content);
}

test("daily Windows entry is WScript with hidden PowerShell; CMD only hands off", async () => {
  const vbs = await readFile(path.join(root, "start.vbs"), "utf8");
  const cmd = await readFile(path.join(root, "start.cmd"), "utf8");
  const launcher = await readFile(path.join(root, "scripts", "start-hidden.ps1"), "utf8");
  assert.match(vbs, /WScript\.ScriptFullName/);
  assert.match(vbs, /-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File/);
  assert.match(vbs, /launcherShell\.Run launcherCommand, 0, False/);
  assert.match(cmd, /"%SystemRoot%\\System32\\wscript\.exe" "%~dp0start\.vbs"/);
  assert.match(cmd, /exit \/b %errorlevel%/);
  assert.doesNotMatch(cmd, /(?:^|\n)\s*(?:call\s+)?(?:node|npm|npx|pause)\b/i);
  assert.match(launcher, /UseShellExecute = \$false/);
  assert.match(launcher, /CreateNoWindow = \$true/);
  assert.match(launcher, /CopyToAsync\(\$collectorOutStream\)/);
  assert.match(launcher, /CopyToAsync\(\$collectorErrStream\)/);
  assert.doesNotMatch(launcher, /cmd\.exe|\/c\b|Start-Process|Stop-Process|Remove-Item|taskkill/i);
  assert.equal([...launcher].every((character) => character.codePointAt(0) < 128), true, "PowerShell 5.1 source requires no UTF-8 BOM assumptions");
});

test("hidden launcher parses in Windows PowerShell 5.1", { skip: process.platform !== "win32" }, async () => {
  const script = path.join(root, "scripts", "start-hidden.ps1");
  const command = `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile(${quotePs(script)},[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String;exit 1};$PSVersionTable.PSVersion.Major`;
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000 });
  assert.equal(result.stdout.trim(), "5");
});

test("offline hidden entry preserves Unicode paths, environment and files without an attached console", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const directory = await temporary(t);
  const executable = await compileFakeNode(directory);

  await t.test("launcher redirects both UTF-8 streams, preserves environment and uses CreateNoWindow", async () => {
    const item = await fixture(directory, "success", executable, { COLLECTOR_TEST_NOISY: "1" });
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"], { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const output = await logs(item);
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    assert.equal(field(output.stdout, "SERVER"), path.join(item.project, "server.mjs"));
    assert.equal(field(output.stdout, "BOOTSTRAP"), path.join(item.project, "scripts", "start-service.mjs"));
    assert.doesNotMatch(output.stdout, /PROBE=/, "Installed-runtime launch must use one bootstrap/service process, not separate probes");
    assert.ok(Number(field(output.stdout, "MEDIA_TRACKER_LAUNCH_STARTED_AT_MS")) > 0);
    assert.equal(field(output.stdout, "CWD"), item.project);
    for (const key of ["MEDIA_TRACKER_DATA_DIR", "MEDIA_TRACKER_PORT", "MEDIA_TRACKER_NO_OPEN", "COLLECTOR_TEST_INHERITED"]) assert.equal(field(output.stdout, key), item.env[key]);
    assert.equal(field(output.stdout, "MEDIA_TRACKER_BACKGROUND_START"), "1");
    assert.match(output.stdout, /stdout-中文/);
    assert.match(output.stderr, /stderr-中文/);
    assert.match(output.stdout, /x{262144}/);
    assert.match(output.stderr, /y{262144}/);
    assert.doesNotMatch(output.stdout + output.stderr, /�/);
    await assertPreserved(item);
  });

  await t.test("nonzero service exit is visible in logs, without an interactive error dialog", async () => {
    const item = await fixture(directory, "failure", executable, { COLLECTOR_TEST_EXIT: "23" });
    await assert.rejects(run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"], { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 }), (error) => error.code === 1);
    const output = await logs(item);
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    assert.match(output.stderr, /stderr-中文/);
    assert.match(output.stderr, /local service exited with code 23/);
    await assertPreserved(item);
  });

  await t.test("service exits with preparation-like numeric codes never install missing dependencies without a typed marker", async () => {
    for (const code of [20, 21, 22]) {
      const item = await fixture(directory, "service-exit-" + code, executable, { COLLECTOR_TEST_EXIT: String(code) });
      await assert.rejects(run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
        "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
      { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 }), (error) => error.code === 1);
      const output = await logs(item);
      assert.match(output.stderr, new RegExp("local service exited with code " + code));
      assert.doesNotMatch(output.stdout, /Installing|INSTALL=/);
      await assertPreserved(item);
    }
  });

  await t.test("authenticated missing-Chromium status installs only that fixture component and retries without probes", async () => {
    const readyFile = path.join(directory, "chromium-fixture-ready");
    const item = await fixture(directory, "missing-chromium", executable, {
      COLLECTOR_TEST_BOOTSTRAP_FAILURE: "missing-chromium", COLLECTOR_TEST_READY_FILE: readyFile,
    });
    await writeFile(path.join(item.project, "node_modules", "playwright", "cli.js"), "// Offline fake installer marker");
    await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
    { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 });
    const output = await logs(item);
    assert.match(output.stdout, /Installing the missing private Chromium runtime/);
    assert.equal(field(output.stdout, "INSTALL"), "chromium");
    assert.doesNotMatch(output.stdout, /PROBE=|Installing the missing local runtime dependencies/);
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    await assertPreserved(item);
  });

  await t.test("missing dependencies are never installed when the version probe rejects Node", async () => {
    const item = await fixture(directory, "missing-dependencies-old-node", executable, { COLLECTOR_TEST_PROBE_EXIT: "20" });
    await rm(path.join(item.project, "node_modules", "playwright", "package.json"));
    await assert.rejects(run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
    { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 }), (error) => error.code === 1);
    const output = await logs(item);
    assert.match(output.stderr, /Node\.js 20 or newer is required/);
    assert.doesNotMatch(output.stdout, /Installing|INSTALL=/);
    await assertPreserved(item);
  });

  await t.test("authenticated missing-dependencies status repairs only the offline fake npm component", async () => {
    const npmCli = path.join(path.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, "// Offline fake npm installer marker");
    const readyFile = path.join(directory, "dependencies-fixture-ready");
    const item = await fixture(directory, "typed-missing-dependencies", executable, {
      COLLECTOR_TEST_BOOTSTRAP_FAILURE: "missing-dependencies", COLLECTOR_TEST_READY_FILE: readyFile,
    });
    await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
    { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 });
    const output = await logs(item);
    assert.equal(field(output.stdout, "INSTALL"), "npm");
    assert.match(output.stdout, /Installing the missing local runtime dependencies/);
    assert.doesNotMatch(output.stdout, /PROBE=|Installing the missing private Chromium/);
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    await assertPreserved(item);
  });

  await t.test("missing-package bootstrap validates Node before its offline npm preparation", async () => {
    const item = await fixture(directory, "missing-package-new-node", executable, {
      COLLECTOR_TEST_READY_FILE: path.join(directory, "new-node-dependencies-ready"),
    });
    await rm(path.join(item.project, "node_modules", "playwright", "package.json"));
    await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
    { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 });
    const output = await logs(item);
    assert.equal(field(output.stdout, "INSTALL"), "npm");
    assert.ok(output.stdout.indexOf("PROBE=") < output.stdout.indexOf("INSTALL="));
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    await assertPreserved(item);
  });

  await t.test("a marker for another attempt cannot trigger repair and is cleaned without touching user data", async () => {
    const item = await fixture(directory, "foreign-marker", executable, {
      COLLECTOR_TEST_BOOTSTRAP_FAILURE: "missing-chromium", COLLECTOR_TEST_BAD_STATUS_TOKEN: "1",
    });
    await assert.rejects(run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", path.join(item.project, "scripts", "start-hidden.ps1"), "-NoErrorDialog"],
    { cwd: directory, env: item.env, windowsHide: true, timeout: 15_000 }), (error) => error.code === 1);
    const output = await logs(item);
    assert.match(output.stderr, /startup status did not match this launch/);
    assert.doesNotMatch(output.stdout, /Installing|INSTALL=/);
    await assertPreserved(item);
  });

  await t.test("actual WScript entry launches the hidden offline fixture from a Unicode and spaced directory", async () => {
    const item = await fixture(directory, "wscript", executable);
    const result = await run(wscript, [path.join(item.project, "start.vbs")], { cwd: directory, env: item.env, windowsHide: true, timeout: 10_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    let output;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      output = await logs(item).catch(() => null);
      if (output?.stdout.includes("stdout-中文") && output?.stderr.includes("stderr-中文")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(output, "Hidden WScript fixture generated startup logs");
    assert.match(output.stdout, /CONSOLE_HANDLE=0/);
    assert.equal(field(output.stdout, "CWD"), item.project);
    assert.equal(field(output.stdout, "MEDIA_TRACKER_BACKGROUND_START"), "1");
    await assertPreserved(item);
  });

  await t.test("CommandLineToArgvW escaping round-trips quotes, spaces and trailing backslashes", async () => {
    const launcher = await readFile(path.join(root, "scripts", "start-hidden.ps1"), "utf8");
    const convertFunction = launcher.match(/function ConvertTo-CollectorArgument\([\s\S]*?\n\}/)?.[0];
    assert.ok(convertFunction);
    const values = ["C:\\中文 空格\\文件", "apostrophe's & (text)", 'quote"value', "C:\\trailing\\", 'backslash\\\\"quoted'];
    const command = `${convertFunction}\n$values=@(${values.map(quotePs).join(",")});$info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=${quotePs(executable)};$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.Arguments='-echo '+(($values|ForEach-Object {ConvertTo-CollectorArgument $_}) -join ' ');$child=New-Object Diagnostics.Process;$child.StartInfo=$info;[void]$child.Start();$child.StandardOutput.ReadToEnd();$child.WaitForExit();exit $child.ExitCode`;
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000 });
    const actual = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("ARG=")).map((line) => Buffer.from(line.slice(4), "base64").toString("utf8"));
    assert.deepEqual(actual, values);
  });
});
