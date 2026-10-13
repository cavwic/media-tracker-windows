import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import http from "node:http";

const windows = process.platform === "win32";
const templates = fileURLToPath(new URL("../packaging/local-compile/", import.meta.url));
const launcherName = "采集工具.exe";
const owned = ["build.ps1", "Launcher.cs", "launcher.manifest"];
const preparationFixtureScript = `import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const data=path.join(root,'data');
await mkdir(data,{recursive:true});const config=JSON.parse(await readFile(path.join(data,'runtime-fixture.json'),'utf8'));
const browser=path.join(root,'runtime/browsers/fixture-browser.exe');
const status=()=>({schemaVersion:1,ready:existsSync(browser),requiresDownload:!existsSync(browser),totalDownloadBytes:5,components:[{id:'chromium',displayName:'Fixture browser',ready:existsSync(browser),state:existsSync(browser)?'ready':'missing',downloadBytes:5,message:'isolated offline fixture'}]});
if(process.argv.includes('--status')||process.argv.includes('--verify')){console.log(JSON.stringify(status()));process.exit(process.argv.includes('--verify')&&!status().ready?1:0);}
if(!process.argv.includes('--install')||!process.argv.includes('--confirmed'))process.exit(1);
await writeFile(path.join(data,'fixture-install-called.txt'),'confirmed offline fixture');console.log(JSON.stringify({type:'progress',componentId:'chromium',phase:'download',bytes:0,totalBytes:5}));
let cancelled=false;process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{if(value.trim()==='cancel'){cancelled=true;console.log(JSON.stringify({type:'error',code:'cancelled',message:'fixture cancelled'}));process.exit(2);}});
await new Promise(resolve=>setTimeout(resolve,150));if(cancelled)process.exit(2);
if(config.behavior==='failure'){await writeFile(path.join(data,'fixture-completed-component.txt'),'retained');console.log(JSON.stringify({type:'error',message:'fixture download failed'}));process.exit(1);}
await writeFile(browser,'fixture component');console.log(JSON.stringify({type:'result',...status()}));process.exit(0);
`;

async function fixture(t, { browser = true, service = "ready" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "collector 编译 空格 "));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const folder of ["compile", "app/scripts", "app/node_modules/playwright", "runtime/node", "runtime/browsers"])
    await mkdir(path.join(root, folder), { recursive: true });
  for (const name of owned) await copyFile(path.join(templates, name), path.join(root, "compile", name));
  await copyFile(path.join(templates, "首次编译.cmd"), path.join(root, "首次编译.cmd"));
  await copyFile(process.execPath, path.join(root, "runtime/node/node.exe"));
  await writeFile(path.join(root, "app/server.mjs"), "// isolated fixture, never imports the actual application\n");
  await writeFile(path.join(root, "app/node_modules/playwright/package.json"),
    JSON.stringify({ name: "playwright", type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(root, "app/node_modules/playwright/index.mjs"),
    "import path from 'node:path';export const chromium={executablePath:()=>path.join(process.env.PLAYWRIGHT_BROWSERS_PATH,'fixture-browser.exe')};");
  if (browser) await writeFile(path.join(root, "runtime/browsers/fixture-browser.exe"), "self-test fixture only");
  let body = "import {writeFile} from 'node:fs/promises';";
  body += "await writeFile(process.env.MEDIA_TRACKER_DATA_DIR+'/fixture-environment.json',JSON.stringify({portableRoot:process.env.MEDIA_TRACKER_PORTABLE_ROOT,pythonHome:process.env.PYTHONHOME||null,pythonPath:process.env.PYTHONPATH||null}));";
  if (service === "changed-source") body +=
    "await writeFile(new URL('../../compile/Launcher.cs',import.meta.url),'// deliberately changed fixture');";
  if (service !== "no-ready") body +=
    "if(process.env.MEDIA_TRACKER_READY_FILE)await writeFile(process.env.MEDIA_TRACKER_READY_FILE,JSON.stringify({schemaVersion:1,token:process.env.MEDIA_TRACKER_READY_TOKEN,ready:true}),{flag:'wx'});";
  body += "setTimeout(()=>process.exit(0),200);";
  await writeFile(path.join(root, "app/scripts/start-service.mjs"), body);
  return root;
}

async function compile(root, { launch = false, runtimeDecision } = {}) {
  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", path.join(root, "compile/build.ps1")];
  if (!launch) args.push("-NoLaunch");
  if (runtimeDecision) args.push("-RuntimeFixtureDecision", runtimeDecision);
  return await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, { cwd: root, windowsHide: true,
      env: { ...process.env, PYTHONHOME: "fixture-external-python", PYTHONPATH: "fixture-external-pythonpath" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated compilation fixture timed out. " + output)); }, 60000);
    child.on("error", reject);
    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const logDir = path.join(root, "data/startup-logs");
        for (const name of await readdir(logDir).catch(() => [])) {
          if (name.startsWith(".self-test-") || name.startsWith("build-")) output += "\n" + await readFile(path.join(logDir, name), "utf8");
        }
      }
      resolve({ code, output });
    });
  });
}

async function assertSourcesRemain(root) {
  for (const name of owned) assert.ok(existsSync(path.join(root, "compile", name)), name + " should survive");
  assert.ok(existsSync(path.join(root, "首次编译.cmd")));
}

async function waitForCleanup(root) {
  const first = path.join(root, "首次编译.cmd");
  const receipt = path.join(root, "data/startup-logs/local-compile-state.json");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (existsSync(first) || existsSync(receipt))) await delay(50);
  if (existsSync(first) || existsSync(receipt)) {
    const logs = path.join(root, "data/startup-logs");
    let message = "Deferred compiler cleanup did not finish.";
    for (const name of await readdir(logs)) if (name.startsWith("cleanup-")) message += "\n" + await readFile(path.join(logs, name), "utf8");
    assert.fail(message);
  }
}

async function runFirstEntry(root) {
  return await new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `""${path.join(root, "首次编译.cmd")}""`],
      { cwd: root, windowsHide: true, windowsVerbatimArguments: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => { child.kill(); reject(new Error("Real CMD fixture timed out.")); }, 60000);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output: new TextDecoder("gbk").decode(Buffer.concat(chunks)) }); });
  });
}

test("local compiler creates an x64 GUI executable with asInvoker, without opening the app", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  const result = await compile(root);
  assert.equal(result.code, 0, result.output);
  await assertSourcesRemain(root);
  const bytes = await readFile(path.join(root, launcherName));
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0");
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, "x64 machine type");
  assert.equal(bytes.readUInt16LE(pe + 24 + 68), 2, "Windows GUI subsystem");
  assert.match(bytes.toString("utf8"), /requestedExecutionLevel level="asInvoker"/);
  const logs = await readdir(path.join(root, "data/startup-logs"));
  assert.equal(logs.filter((name) => name.endsWith(".out.log")).length, 0, "no service started during self-test");
  assert.equal(logs.filter((name) => name.startsWith(".self-test-")).length, 1);
});

async function runtimeFixture(root, { behavior = "success" } = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "components"), { recursive: true });
  await writeFile(path.join(root, "components/runtime-manifest.json"), '{"isolatedOfflineFixture":true}');
  await writeFile(path.join(root, "app/scripts/prepare-portable-runtime.mjs"), preparationFixtureScript);
  await writeFile(path.join(root, "data/runtime-fixture.json"), JSON.stringify({ behavior }));
}

async function runGenerated(root, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, launcherName), args, { cwd: root, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Generated fixture launcher failed to exit.")); }, 15000);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

const nodeDescriptor = {
  schemaVersion: 1, id: "node", version: "24.14.1", platform: "win32-x64",
  archiveURL: "https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip",
  archiveSha256: "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70",
  archiveBytes: 36358527, maxArchiveBytes: 37358527,
};
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

async function nativeProbe(root, body) {
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;
    Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $assembly=[Reflection.Assembly]::LoadFrom(${psQuote(path.join(root, launcherName))});
    $launcher=$assembly.GetType('Launcher');$flags=[Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic;
    function Invoke-Core([string]$name,[object[]]$arguments) {
      for($index=0;$index -lt $arguments.Length;$index++){if($null -ne $arguments[$index]){$arguments[$index]=$arguments[$index].PSObject.BaseObject}}
      $launcher.GetMethod($name,$flags).Invoke($null,$arguments) }
    function Node-Spec([string]$json) { $type=$assembly.GetType('Launcher+NodeBootstrapSpec');
      $launcher.GetMethod('ParseJson',$flags).MakeGenericMethod($type).Invoke($null,[object[]]@($json)) }
    ${body}`;
  return await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native bootstrap probe timed out. " + output)); }, 30000);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

function zipArchive(entries) {
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const bodies = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || ""), compressed = deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes || 0, 38); central.writeUInt32LE(offset, 42);
    bodies.push(header, name, compressed); directory.push(central, name); offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, central, end]);
}

async function nodeArchiveStage(root, bytes) {
  const stage = path.join(root, "runtime", `.collector-node-stage-${createHash("md5").update(bytes).digest("hex")}`);
  await mkdir(path.join(stage, "payload"), { recursive: true });
  await writeFile(path.join(stage, "archive.zip"), bytes);
  return { stage, archive: path.join(stage, "archive.zip"), payload: path.join(stage, "payload"), spec: {
    ...nodeDescriptor, archiveBytes: bytes.length, maxArchiveBytes: bytes.length,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  } };
}

test("minimal missing Node remains offline in self-test and cannot use fixture consent to authorize network", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  await runtimeFixture(root);
  await rm(path.join(root, "runtime/node"), { recursive: true });
  await writeFile(path.join(root, "components/bootstrap-node.json"), JSON.stringify(nodeDescriptor));
  assert.equal(await runGenerated(root, ["--self-test", "--report", path.join(root, "data/node-offline.json")]), 1);
  assert.equal(await runGenerated(root, ["--prepare-runtime", "--fixture-runtime-decision", "reject"]), 2);
  assert.equal(await runGenerated(root, ["--prepare-runtime", "--fixture-runtime-decision", "accept"]), 1);
  await assertSourcesRemain(root);
  assert.equal(existsSync(path.join(root, "runtime/node")), false);
  assert.equal(existsSync(path.join(root, "data/fixture-install-called.txt")), false);
  assert.equal(existsSync(path.join(root, "runtime/.collector-node-install.lock.json")), false);
});

test("Node bootstrap descriptor allows only the pinned HTTPS URL, full SHA and bounded sizes", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  await mkdir(path.join(root, "components"));
  for (const invalid of [
    { archiveURL: "http://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip" },
    { archiveURL: "https://untrusted.invalid/node.zip" }, { archiveSha256: "0".repeat(64) },
    { version: "24.14.2" }, { archiveBytes: 0 }, { maxArchiveBytes: 129 * 1024 * 1024 },
  ]) {
    await writeFile(path.join(root, "components/bootstrap-node.json"), JSON.stringify({ ...nodeDescriptor, ...invalid }));
    const result = await nativeProbe(root, "Invoke-Core 'ReadNodeBootstrapSpec' @() | Out-Null");
    assert.notEqual(result.code, 0, JSON.stringify(invalid));
  }
  await writeFile(path.join(root, "components/bootstrap-node.json"), JSON.stringify(nodeDescriptor));
  assert.equal((await nativeProbe(root, "Invoke-Core 'ReadNodeBootstrapSpec' @() | Out-Null")).code, 0);
});

test("Node streaming copy rejects corrupt, truncated, excessive or cancelled bytes before installation", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  const data = Buffer.from("isolated fixture download stream"), sha = createHash("sha256").update(data).digest("hex");
  for (const [name, overrides, cancelled, ok] of [
    ["valid", {}, false, true], ["sha", { archiveSha256: "0".repeat(64) }, false, false],
    ["truncated", { archiveBytes: data.length + 1, maxArchiveBytes: data.length + 1 }, false, false],
    ["excessive", { archiveBytes: data.length - 1 }, false, false], ["cancel", {}, true, false],
  ]) {
    const spec = { ...nodeDescriptor, archiveBytes: data.length, maxArchiveBytes: data.length, archiveSha256: sha, ...overrides };
    const result = await nativeProbe(root, `$spec=Node-Spec ${psQuote(JSON.stringify(spec))};
      Add-Type -TypeDefinition 'public static class FixtureCancellation { public static bool Cancelled() { return true; } }';
      $cancel=if(${cancelled ? "$true" : "$false"}){[Delegate]::CreateDelegate([Func[bool]],[FixtureCancellation].GetMethod('Cancelled'))}else{$null};
      $stream=New-Object IO.MemoryStream(,[Convert]::FromBase64String('${data.toString("base64")}'));
      try { Invoke-Core 'CopyVerifiedNodeArchive' ([object[]]@($stream,${psQuote(path.join(root, `${name}.zip`))},$spec,$null,$cancel)) } finally {$stream.Dispose()}`);
    assert.equal(result.code === 0, ok, result.output);
  }
  assert.equal(existsSync(path.join(root, "data/fixture-environment.json")), false);
});

test("Node ZIP extraction rejects traversal, links, duplicate entries and missing required files", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  const prefix = "node-v24.14.1-win-x64/";
  const base = [{ name: prefix + "node.exe", data: "not executed by extraction-only test" }, { name: prefix + "LICENSE", data: "fixture license" }];
  for (const entries of [
    [...base, { name: prefix + "../../escape.txt", data: "refuse" }],
    [...base, { name: prefix + "folder\\escape.txt", data: "refuse" }],
    [...base, { name: prefix + "link", data: "refuse", attributes: 0xa1ff0000 }],
    [...base, base[0]], [base[0]], [{ name: "outside/node.exe", data: "refuse" }],
  ]) {
    const item = await nodeArchiveStage(root, zipArchive(entries));
    const result = await nativeProbe(root, `$spec=Node-Spec ${psQuote(JSON.stringify(item.spec))};
      Invoke-Core 'ExtractNodeArchive' ([object[]]@(${psQuote(item.archive)},${psQuote(item.payload)},$spec,$null))`);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(existsSync(path.join(root, "escape.txt")), false);
  }
});

test("Node atomic commit accepts only verified x64/version files, keeps LICENSE and refuses existing targets", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  const existing = await readFile(path.join(root, "runtime/node/node.exe"));
  await rm(path.join(root, "runtime/node"), { recursive: true });
  const prefix = `node-v${process.versions.node}-win-x64/`;
  const item = await nodeArchiveStage(root, zipArchive([
    { name: prefix + "node.exe", data: existing }, { name: prefix + "LICENSE", data: "fixture license" },
    { name: prefix + "npm.cmd", data: "must never install" }, { name: prefix + "node_modules/npm/unused.txt", data: "must never install" },
  ]));
  item.spec.version = process.versions.node;
  const invoke = `$spec=Node-Spec ${psQuote(JSON.stringify(item.spec))};Invoke-Core 'CommitVerifiedNodeArchive' ([object[]]@(${psQuote(item.archive)},${psQuote(item.payload)},$spec,$null));
    if(!(Invoke-Core 'NodeBootstrapReady' ([object[]]@($spec)))){throw 'receipt not ready'}`;
  const result = await nativeProbe(root, invoke);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await readdir(path.join(root, "runtime/node"))).sort(), [".collector-node-ready.json", "LICENSE", "node.exe"]);
  await mkdir(item.payload);
  const second = await nativeProbe(root, invoke);
  assert.notEqual(second.code, 0, "an existing installed target must never be replaced");
  assert.deepEqual(await readFile(path.join(root, "runtime/node/node.exe")), existing);
  await writeFile(path.join(root, "runtime/node/LICENSE"), "modified fixture");
  const altered = await nativeProbe(root, `$spec=Node-Spec ${psQuote(JSON.stringify(item.spec))};Invoke-Core 'NodeBootstrapReady' ([object[]]@($spec))`);
  assert.notEqual(altered.code, 0, "receipt identifies modified component without contacting a server");
});

test("cancelled Node preparation releases only its own lock and stage without making an HTTP request", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  await rm(path.join(root, "runtime/node"), { recursive: true });
  await writeFile(path.join(root, "data/keep-login.json"), "isolated untouched fixture");
  await writeFile(path.join(root, "runtime/keep-existing-component.txt"), "already prepared");
  let requests = 0;
  const server = http.createServer((request, response) => { requests++; response.writeHead(500); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const spec = { ...nodeDescriptor, archiveURL: `http://127.0.0.1:${server.address().port}/never-requested` };
  const body = `$spec=Node-Spec ${psQuote(JSON.stringify(spec))};
    $parse=$launcher.GetMethod('ParseJson',$flags).MakeGenericMethod($assembly.GetType('Launcher+PreparationStatus'));
    $status=$parse.Invoke($null,[object[]]@('{"schemaVersion":1,"components":[]}'));
    $formType=$assembly.GetType('Launcher+RuntimeProgressForm');
    $form=$formType.GetConstructors([Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public)[0].Invoke([object[]]@($status,$false));
    try {$formType.GetProperty('CancellationRequested').SetValue($form,$true,$null);
      Invoke-Core 'InstallNodeBootstrap' ([object[]]@($spec,$form))
    } finally {$form.Dispose()}`;
  const cancelled = await nativeProbe(root, body);
  assert.notEqual(cancelled.code, 0);
  assert.equal(requests, 0, "cancelled native preparation must not issue even a local fixture request");
  assert.equal(existsSync(path.join(root, "runtime/.collector-node-install.lock.json")), false);
  assert.equal((await readdir(path.join(root, "runtime"))).some((name) => name.startsWith(".collector-node-stage-")), false);
  assert.equal(await readFile(path.join(root, "data/keep-login.json"), "utf8"), "isolated untouched fixture");
  assert.equal(await readFile(path.join(root, "runtime/keep-existing-component.txt"), "utf8"), "already prepared");
  const lockFile = path.join(root, "runtime/.collector-node-install.lock.json");
  await writeFile(lockFile, "unknown preparation lock must stay");
  assert.notEqual((await nativeProbe(root, body)).code, 0);
  assert.equal(await readFile(lockFile, "utf8"), "unknown preparation lock must stay");
  assert.equal(requests, 0);
});

test("Node commit rejects corrupted archives and reparse payloads without touching foreign content", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  await rm(path.join(root, "runtime/node"), { recursive: true });
  const item = await nodeArchiveStage(root, zipArchive([{ name: "node-v24.14.1-win-x64/LICENSE", data: "fixture" }]));
  const bad = { ...item.spec, archiveSha256: "0".repeat(64) };
  let result = await nativeProbe(root, `$spec=Node-Spec ${psQuote(JSON.stringify(bad))};
    Invoke-Core 'CommitVerifiedNodeArchive' ([object[]]@(${psQuote(item.archive)},${psQuote(item.payload)},$spec,$null))`);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(item.payload), [], "hash validation must precede extraction");
  const foreign = path.join(root, "data/foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "retain.txt"), "must remain");
  await rm(item.payload, { recursive: true });
  await symlink(foreign, item.payload, "junction");
  result = await nativeProbe(root, `$spec=Node-Spec ${psQuote(JSON.stringify(item.spec))};
    Invoke-Core 'CommitVerifiedNodeArchive' ([object[]]@(${psQuote(item.archive)},${psQuote(item.payload)},$spec,$null))`);
  assert.notEqual(result.code, 0);
  await rm(item.payload, { recursive: true }); // Remove the owned junction, never its target.
  assert.deepEqual(await readdir(foreign), ["retain.txt"]);
  assert.equal(await readFile(path.join(foreign, "retain.txt"), "utf8"), "must remain");
});

test("Node version validation rejects x86 and another version and ignores inherited NODE_OPTIONS", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  assert.equal((await compile(root)).code, 0);
  const x86 = Buffer.alloc(512);
  x86.writeUInt16LE(0x5a4d); x86.writeUInt32LE(128, 0x3c); x86.writeUInt32LE(0x4550, 128); x86.writeUInt16LE(0x14c, 132);
  await writeFile(path.join(root, "x86.exe"), x86);
  assert.notEqual((await nativeProbe(root, `Invoke-Core 'ValidateExtractedNode' ([object[]]@(${psQuote(path.join(root, "x86.exe"))},'24.14.1'))`)).code, 0);
  assert.notEqual((await nativeProbe(root, `Invoke-Core 'ValidateExtractedNode' ([object[]]@(${psQuote(path.join(root, "runtime/node/node.exe"))},'0.0.0'))`)).code, 0);
  const script = path.join(root, "options-must-not-run.cjs"), marker = path.join(root, "options-ran.txt");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected preload');`);
  const result = await nativeProbe(root, `$env:NODE_OPTIONS='--require '+${psQuote(script)};
    Invoke-Core 'ValidateExtractedNode' ([object[]]@(${psQuote(path.join(root, "runtime/node/node.exe"))},${psQuote(process.versions.node)}))`);
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(marker), false);
});

test("fixture-only automated decisions are tied to the exact offline script, never a real manifest or environment", async () => {
  const launcher = await readFile(path.join(templates, "Launcher.cs"), "utf8");
  assert.ok(launcher.includes(createHash("sha256").update(preparationFixtureScript).digest("hex").toUpperCase()));
  assert.match(launcher, /Path\.GetTempPath\(\)/);
  assert.match(launcher, /FileSha256\(PreparationScript\)/);
});

test("missing runtime refusal keeps compiler sources and performs no preparation or service start", { skip: !windows }, async (t) => {
  const root = await fixture(t, { browser: false });
  await runtimeFixture(root);
  const result = await compile(root, { launch: true, runtimeDecision: "reject" });
  assert.equal(result.code, 2, result.output);
  await assertSourcesRemain(root);
  assert.equal(existsSync(path.join(root, launcherName)), false);
  assert.equal(existsSync(path.join(root, "data/fixture-install-called.txt")), false);
  assert.equal(existsSync(path.join(root, "data/fixture-environment.json")), false);
});

test("confirmed fixture runtime preparation completes before offline validation and EXE commit", { skip: !windows }, async (t) => {
  const root = await fixture(t, { browser: false });
  await runtimeFixture(root);
  const result = await compile(root, { launch: true, runtimeDecision: "accept" });
  assert.equal(result.code, 0, result.output);
  await waitForCleanup(root);
  assert.ok(existsSync(path.join(root, "data/fixture-install-called.txt")));
  assert.ok(existsSync(path.join(root, launcherName)));
});

test("cooperative runtime cancellation or download failure preserves source materials and completed components", { skip: !windows }, async (t) => {
  for (const options of [{ decision: "cancel", behavior: "success", code: 2 }, { decision: "accept", behavior: "failure", code: 1 }]) {
    const root = await fixture(t, { browser: false });
    await runtimeFixture(root, options);
    const result = await compile(root, { launch: true, runtimeDecision: options.decision });
    assert.equal(result.code, options.code, result.output);
    await assertSourcesRemain(root);
    assert.equal(existsSync(path.join(root, launcherName)), false);
    assert.ok(existsSync(path.join(root, "data/fixture-install-called.txt")));
    if (options.behavior === "failure") assert.ok(existsSync(path.join(root, "data/fixture-completed-component.txt")));
  }
});

test("NoLaunch remains offline and cannot auto-approve missing components even with fixture decision", { skip: !windows }, async (t) => {
  const root = await fixture(t, { browser: false });
  await runtimeFixture(root);
  const result = await compile(root, { runtimeDecision: "accept" });
  assert.equal(result.code, 1, result.output);
  await assertSourcesRemain(root);
  assert.equal(existsSync(path.join(root, "data/fixture-install-called.txt")), false);
  assert.equal(existsSync(path.join(root, launcherName)), false);
});

test("generated EXE can explicitly repair missing runtime after compiler materials were removed", { skip: !windows }, async (t) => {
  const root = await fixture(t, { browser: false });
  await runtimeFixture(root);
  const first = await compile(root, { launch: true, runtimeDecision: "accept" });
  assert.equal(first.code, 0, first.output);
  await waitForCleanup(root);
  assert.equal(existsSync(path.join(root, "compile")), false);
  await rm(path.join(root, "runtime/browsers/fixture-browser.exe"));
  await rm(path.join(root, "data/fixture-install-called.txt"));
  await writeFile(path.join(root, "data/keep-login.json"), '{"fixture":"must remain"}');
  assert.equal(await runGenerated(root, ["--fixture-runtime-decision", "reject"]), 2);
  assert.equal(existsSync(path.join(root, "data/fixture-install-called.txt")), false);
  assert.equal(await runGenerated(root, ["--fixture-runtime-decision", "accept"]), 0);
  assert.ok(existsSync(path.join(root, "runtime/browsers/fixture-browser.exe")));
  assert.ok(existsSync(path.join(root, "data/fixture-install-called.txt")));
  assert.equal(await readFile(path.join(root, "data/keep-login.json"), "utf8"), '{"fixture":"must remain"}');
  assert.equal(existsSync(path.join(root, "compile")), false);
});

test("native consent and progress forms render dark/light offline without opening a desktop window", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  const result = await compile(root);
  assert.equal(result.code, 0, result.output);
  const status = { schemaVersion: 1, ready: false, requiresDownload: true, components: [
    { id: "chromium", displayName: "独立 Chromium 浏览器", ready: false, state: "missing", downloadBytes: 190000000 },
    { id: "python", displayName: "通用采集 Python 引擎", ready: false, state: "missing", downloadBytes: 27000000 },
  ] };
  const nodeStatus = { ...status, components: [{ id: "node", displayName: "独立 Node.js 运行引擎", ready: false, state: "missing", downloadBytes: nodeDescriptor.archiveBytes }] };
  const single = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;
    $assembly=[Reflection.Assembly]::LoadFrom(${single(path.join(root, launcherName))});
    $launcher=$assembly.GetType('Launcher');$statusType=$assembly.GetType('Launcher+PreparationStatus');
    $flags=[Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic;
    $parse=$launcher.GetMethod('ParseJson',$flags).MakeGenericMethod($statusType);
    $statusText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(status)).toString("base64")}'));
    $nodeStatusText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(nodeStatus)).toString("base64")}'));
    foreach($nodeBootstrap in @($false,$true)) {
      $status=$parse.Invoke($null,[object[]]@( $(if($nodeBootstrap){$nodeStatusText}else{$statusText}) ));
      $statusType.GetField('NodeBootstrap').SetValue($status,$nodeBootstrap);
    foreach($dark in @($false,$true)) { foreach($kind in @('Consent','Progress')) {
      if($nodeBootstrap -and $kind -eq 'Progress'){continue}
      $type=$assembly.GetType('Launcher+Runtime'+$kind+'Form');
      $constructor=$type.GetConstructors([Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public)[0];
      $form=$constructor.Invoke([object[]]@($status,$dark));
      try { [void]$form.Handle;$form.PerformLayout();
        if($form.UseWaitCursor -or $form.Cursor -ne [Windows.Forms.Cursors]::Default){throw 'Missing-component native form uses a busy pointer.'}
        foreach($control in $form.Controls){if($control.UseWaitCursor){throw 'A native choice control inherited a busy pointer.'}}
        $bitmap=New-Object Drawing.Bitmap($form.ClientSize.Width,$form.ClientSize.Height);
        try { $graphics=[Drawing.Graphics]::FromImage($bitmap);
          try { $graphics.Clear($form.BackColor);
            foreach($control in $form.Controls) { [void]$control.Handle;
              $part=New-Object Drawing.Bitmap($control.Width,$control.Height);
              try { $control.DrawToBitmap($part,(New-Object Drawing.Rectangle(0,0,$control.Width,$control.Height)));
                $graphics.DrawImageUnscaled($part,$control.Left,$control.Top);
              } finally { $part.Dispose() }
            }
          } finally { $graphics.Dispose() }
          $colorCount=New-Object 'Collections.Generic.HashSet[int]';
          for($x=0;$x -lt $bitmap.Width;$x+=4){ for($y=0;$y -lt $bitmap.Height;$y+=4){ [void]$colorCount.Add($bitmap.GetPixel($x,$y).ToArgb()) } }
          if($colorCount.Count -lt 15){ throw 'Offscreen native rendering contains no readable controls.' }
          $theme=if($dark){'dark'}else{'light'};
          $prefix=if($nodeBootstrap){'native-node-'}else{'native-'};
          $bitmap.Save((${single(root)}+'\\'+$prefix+$kind.ToLower()+'-'+$theme+'.png'),[Drawing.Imaging.ImageFormat]::Png);
        } finally {$bitmap.Dispose()}
      } finally {$form.Dispose()}
    } } }`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output)));
  });
  for (const name of ["native-consent-light.png", "native-consent-dark.png", "native-progress-light.png", "native-progress-dark.png", "native-node-consent-light.png", "native-node-consent-dark.png"]) {
    const bytes = await readFile(path.join(root, name));
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
    if (process.env.COLLECTOR_SAVE_NATIVE_PREVIEWS === "1") {
      await mkdir(path.join(templates, "previews"), { recursive: true });
      await copyFile(path.join(root, name), path.join(templates, "previews", name));
    }
  }
  assert.equal(existsSync(path.join(root, "data/fixture-environment.json")), false);
});

test("successful first application handshake removes only unchanged owned compiler material", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "compile/user-notes.txt"), "must remain");
  await mkdir(path.join(root, "licenses"));
  await writeFile(path.join(root, "licenses/keep.txt"), "license fixture");
  const result = await compile(root, { launch: true });
  assert.equal(result.code, 0, result.output);
  await waitForCleanup(root);
  for (const name of owned) assert.equal(existsSync(path.join(root, "compile", name)), false);
  assert.equal(existsSync(path.join(root, "首次编译.cmd")), false);
  assert.equal(await readFile(path.join(root, "compile/user-notes.txt"), "utf8"), "must remain");
  assert.ok(existsSync(path.join(root, "app/scripts/start-service.mjs")));
  assert.ok(existsSync(path.join(root, "runtime/node/node.exe")));
  assert.ok(existsSync(path.join(root, "licenses/keep.txt")));
  assert.ok(existsSync(path.join(root, launcherName)));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "data/fixture-environment.json"), "utf8")),
    { portableRoot: root, pythonHome: null, pythonPath: null });
});

test("compilation error leaves every source file and does not commit an executable", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "compile/Launcher.cs"), "invalid C# deliberate fixture");
  const result = await compile(root);
  assert.notEqual(result.code, 0);
  await assertSourcesRemain(root);
  assert.equal(existsSync(path.join(root, launcherName)), false);
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".collector-build-")).length, 0);
});

test("missing packaged browser fails offline validation and preserves build sources", { skip: !windows }, async (t) => {
  const root = await fixture(t, { browser: false });
  const result = await compile(root);
  assert.notEqual(result.code, 0);
  await assertSourcesRemain(root);
  assert.equal(existsSync(path.join(root, launcherName)), false);
});

test("an existing executable is never silently replaced", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, launcherName), "user owned executable fixture");
  const result = await compile(root);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path.join(root, launcherName), "utf8"), "user owned executable fixture");
  await assertSourcesRemain(root);
});

test("a service without a ready acknowledgement leaves all compiler files", { skip: !windows }, async (t) => {
  const root = await fixture(t, { service: "no-ready" });
  const result = await compile(root, { launch: true });
  assert.notEqual(result.code, 0);
  await assertSourcesRemain(root);
  assert.ok(existsSync(path.join(root, launcherName)), "validated EXE is not removed on unconfirmed startup");
});

test("a compiler file modified while starting cancels cleanup without deleting the rest", { skip: !windows }, async (t) => {
  const root = await fixture(t, { service: "changed-source" });
  const result = await compile(root, { launch: true });
  assert.notEqual(result.code, 0);
  await assertSourcesRemain(root);
  assert.equal(await readFile(path.join(root, "compile/Launcher.cs"), "utf8"), "// deliberately changed fixture");
});

test("a receipt-verified prior build can retry startup and complete cleanup without replacing the EXE", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  const first = await compile(root);
  assert.equal(first.code, 0, first.output);
  const original = await readFile(path.join(root, launcherName));
  const result = await compile(root, { launch: true });
  assert.equal(result.code, 0, result.output);
  await waitForCleanup(root);
  assert.deepEqual(await readFile(path.join(root, launcherName)), original);
  assert.equal(existsSync(path.join(root, "compile/build.ps1")), false);
  assert.equal(existsSync(path.join(root, "data/startup-logs/local-compile-state.json")), false);
});

test("real CMD first-run exits successfully before its own entry is deleted", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  const result = await runFirstEntry(root);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /找不到指定的批处理文件|batch file cannot be found/i);
  await waitForCleanup(root);
  assert.equal(existsSync(path.join(root, "compile")), false);
  assert.ok(existsSync(path.join(root, launcherName)));
});

test("receipt mismatch cannot authorize replacing or running a modified EXE", { skip: !windows }, async (t) => {
  const root = await fixture(t);
  const first = await compile(root);
  assert.equal(first.code, 0, first.output);
  await writeFile(path.join(root, launcherName), "changed user owned executable fixture");
  const result = await compile(root, { launch: true });
  assert.notEqual(result.code, 0);
  await assertSourcesRemain(root);
  assert.equal(await readFile(path.join(root, launcherName), "utf8"), "changed user owned executable fixture");
  assert.equal(existsSync(path.join(root, "data/fixture-environment.json")), false);
});

test("normal startup has no shell invocation, security policy edits or automatic installs", async () => {
  const launcher = await readFile(path.join(templates, "Launcher.cs"), "utf8");
  assert.match(launcher, /new ProcessStartInfo\(NodePath, arguments\)/);
  assert.match(launcher, /CreateNoWindow = true/);
  assert.match(launcher, /EnvironmentVariables\["MEDIA_TRACKER_PORTABLE_ROOT"\] = Root/);
  assert.doesNotMatch(launcher, /new ProcessStartInfo\([^\n]*(?:cmd\.exe|powershell|wscript)/i);
  const build = await readFile(path.join(templates, "build.ps1"), "utf8");
  assert.doesNotMatch(build, /Unblock-File|Set-ExecutionPolicy|ExecutionPolicy\s+Bypass|certutil|reg\.exe|Invoke-WebRequest|https?:\/\//i);
  assert.doesNotMatch(build, /Remove-Item[^\n]*-Recurse/i);
  assert.match(build, /File\]::Move\(\$collectorTempExe, \$collectorExe\)/);
  assert.match(build, /if \(-not \$collectorCleanupApproved\)/);
});
