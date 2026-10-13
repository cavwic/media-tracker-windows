import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, symlink, stat, utimes } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { portableRuntimeStatus, preparePortableRuntime, readRuntimeManifest, inspectRuntimeZip } from "../lib/portable-runtime.mjs";

const run = promisify(execFile);
const modules = ["yt_dlp", "requests", "certifi", "charset_normalizer", "idna", "urllib3"];
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0; });
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.content ?? "fixture"), raw = deflateRawSync(data), crc = entry.crc ?? crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(entry.flags || 0, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(raw.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(entry.flags || 0, 8); item.writeUInt16LE(8, 10);
    item.writeUInt32LE(crc, 16); item.writeUInt32LE(raw.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(name.length, 28);
    item.writeUInt32LE((entry.mode || 0) * 65536, 38); item.writeUInt32LE(offset, 42);
    local.push(header, name, raw); central.push(item, name); offset += header.length + name.length + raw.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-portable-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archives = new Map();
  function archive(url, entries) {
    const data = zip(entries); archives.set(url, data);
    return { archiveURL: url, sha256: createHash("sha256").update(data).digest("hex"), downloadBytes: data.length,
      maxDownloadBytes: 1024 * 1024, maxExtractBytes: 4 * 1024 * 1024 };
  }
  const chromium = { id: "chromium", kind: "zip", version: "151.0.7922.34", installDirectory: "browsers/chromium-1234", archiveRoot: "chrome-win64",
    requiredFiles: ["chrome-win64/chrome.exe", "chrome-win64/chrome.dll"],
    ...archive("https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/win64/chrome-win64.zip", overrides.chromium || [
      { name: "chrome-win64/chrome.exe" }, { name: "chrome-win64/chrome.dll" }, { name: "chrome-win64/LICENSE" }]) };
  const python = { id: "python", kind: "python-embed", version: "3.13.16", installDirectory: "python", pthFile: "python313._pth",
    requiredFiles: ["python.exe", "python313.dll", "python313.zip"],
    ...archive("https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip", [
      { name: "python.exe" }, { name: "python313.dll" }, { name: "python313.zip" }, { name: "python313._pth", content: "python313.zip\n.\n# import site\n" }, { name: "LICENSE.txt" }]),
    wheels: modules.map((name) => ({ name, version: "1.0", ...archive(`https://files.pythonhosted.org/packages/aa/bb/${name}-1.0-py3-none-any.whl`, [
      { name: `${name}/__init__.py`, content: "# offline module fixture" }, { name: `${name}-1.0.dist-info/LICENSE`, content: "fixture license" },
      ...(name === "yt_dlp" ? [{ name: "yt_dlp-1.0.data/data/share/man/man1/yt-dlp.1", content: "manual" }] : [])]) })) };
  const manifest = { schemaVersion: 1, platform: "windows-x64", components: [chromium, python] };
  await mkdir(path.join(root, "components"));
  const save = () => writeFile(path.join(root, "components", "runtime-manifest.json"), JSON.stringify(manifest));
  await save();
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(options.redirect, "manual"); assert.equal(options.signal.aborted, false); assert.ok(archives.has(url)); return new Response(archives.get(url)); };
  const validate = async (directory, component) => {
    for (const filename of component.requiredFiles) await readFile(path.join(directory, ...filename.split("/")));
    if (component.id === "python") assert.equal(await readFile(path.join(directory, component.pthFile), "utf8"), "python313.zip\n.\nLib/site-packages\nimport site\n");
  };
  return { root, manifest, save, archives, fetcher, validate, calls: () => calls };
}

test("runtime status is read-only and explicit confirmation is mandatory before networking", async (t) => {
  const fixtureValue = await fixture(t), { root, fetcher, validate } = fixtureValue;
  const status = await portableRuntimeStatus({ root });
  assert.equal(status.ready, false); assert.equal(status.requiresDownload, true); assert.equal(status.blocked, false);
  assert.equal(status.components.length, 2); assert.ok(status.totalDownloadBytes > 0);
  await assert.rejects(preparePortableRuntime({ root, fetcher, validate }), { code: "runtime-confirmation-required" });
  assert.equal(fixtureValue.calls(), 0); assert.deepEqual(await readdir(root), ["components"]);
});

test("components install into independent runtime with pinned hashes, portable receipts and all sources retained", async (t) => {
  const item = await fixture(t), progress = [];
  const result = await preparePortableRuntime({ ...item, confirmed: true, progress: (value) => progress.push(value) });
  assert.equal(result.ready, true); assert.equal(result.requiresDownload, false); assert.equal(item.calls(), 8);
  assert.ok(progress.some((entry) => entry.phase === "ready"));
  assert.equal(await readFile(path.join(item.root, "runtime", "python", "LICENSE.txt"), "utf8"), "fixture");
  assert.equal(await readFile(path.join(item.root, "runtime", "python", "Lib", "site-packages", "yt_dlp-1.0.data", "data", "share", "man", "man1", "yt-dlp.1"), "utf8"), "manual");
  const repeated = await preparePortableRuntime({ ...item, confirmed: true });
  assert.equal(repeated.ready, true); assert.equal(item.calls(), 8);
  assert.ok(!JSON.stringify(await readFile(path.join(item.root, "runtime", "python", ".collector-runtime-ready.json"), "utf8")).includes(item.root.replaceAll("\\", "\\\\")));
  assert.deepEqual(await readdir(path.join(item.root, "runtime", "browsers")), ["chromium-1234"]);
  assert.deepEqual(await readdir(item.root), ["components", "runtime"]);
});

test("public runtime records source licensing and detects missing required notices", async (t) => {
  const item = await fixture(t);
  item.manifest.components[1].license = "PSF-2.0";
  item.manifest.components[1].licenseSummary = "Fixture Python and package licenses";
  for (const wheel of item.manifest.components[1].wheels) {
    wheel.license = "Fixture-License";
    wheel.licenseFiles = [`${wheel.name}-1.0.dist-info/LICENSE`];
  }
  await item.save();
  assert.equal((await preparePortableRuntime({ ...item, confirmed: true })).ready, true);
  const receipt = JSON.parse(await readFile(path.join(item.root, "runtime", "python", ".collector-runtime-ready.json"), "utf8"));
  assert.equal(receipt.downloadSource.archiveURL, item.manifest.components[1].archiveURL);
  assert.equal(receipt.downloadSource.license, "PSF-2.0");
  assert.equal(receipt.downloadSource.wheels.length, 6);
  assert.equal(receipt.downloadSource.wheels.some((wheel) => /gallery/.test(wheel.name)), false);
  assert.equal((await portableRuntimeStatus({ root: item.root })).components[1].licenseSummary, "Fixture Python and package licenses");
  const notice = item.manifest.components[1].wheels[0].licenseFiles[0];
  await rm(path.join(item.root, "runtime", "python", "Lib", "site-packages", notice));
  assert.equal((await portableRuntimeStatus({ root: item.root })).components[1].state, "invalid");
  const calls = item.calls();
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-existing-invalid" });
  assert.equal(item.calls(), calls);
});

test("SHA mismatch does not extract or execute any component", async (t) => {
  const item = await fixture(t); item.manifest.components[0].sha256 = "0".repeat(64); await item.save();
  let ran = false;
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, validate: () => { ran = true; } }), { code: "runtime-hash-mismatch" });
  assert.equal(ran, false); assert.deepEqual(await readdir(path.join(item.root, "runtime", "browsers")), []);
});

test("failed second component and cancellation retain completed browser for retry", async (t) => {
  const item = await fixture(t); let cancelled = false;
  const controller = new AbortController();
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, signal: controller.signal,
    validate: async (directory, component) => { await item.validate(directory, component); if (component.id === "python") { controller.abort(); cancelled = true; } } }), { name: "AbortError" });
  assert.equal(cancelled, true);
  const status = await portableRuntimeStatus({ root: item.root });
  assert.equal(status.components[0].ready, true); assert.equal(status.components[1].state, "missing");
  assert.deepEqual(await readdir(path.join(item.root, "runtime")), ["browsers"]);
  const calls = item.calls(); await preparePortableRuntime({ ...item, confirmed: true });
  assert.equal(item.calls() - calls, 7); assert.equal((await portableRuntimeStatus({ root: item.root })).ready, true);
});

test("unowned existing directory is never overwritten or adopted", async (t) => {
  const item = await fixture(t), existing = path.join(item.root, "runtime", "browsers", "chromium-1234");
  await mkdir(existing, { recursive: true }); await writeFile(path.join(existing, "user-file.txt"), "keep");
  const status = await portableRuntimeStatus({ root: item.root }); assert.equal(status.blocked, true);
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-existing-invalid" });
  assert.equal(item.calls(), 0); assert.equal(await readFile(path.join(existing, "user-file.txt"), "utf8"), "keep");
});

test("changed key files and corrupted receipt are detected without overwriting", async (t) => {
  const item = await fixture(t); await preparePortableRuntime({ ...item, confirmed: true });
  const browser = path.join(item.root, "runtime", "browsers", "chromium-1234", "chrome-win64", "chrome.exe"), info = await stat(browser);
  await writeFile(browser, "changed"); await utimes(browser, info.atime, info.mtime);
  assert.equal((await portableRuntimeStatus({ root: item.root })).components[0].state, "invalid");
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-existing-invalid" });
  const receipt = path.join(item.root, "runtime", "python", ".collector-runtime-ready.json");
  await writeFile(receipt, "{}"); assert.equal((await portableRuntimeStatus({ root: item.root })).components[1].state, "invalid");
});

test("manifest cannot choose external destinations, arbitrary URLs, scripts or nonuniversal wheels", async (t) => {
  const item = await fixture(t), original = structuredClone(item.manifest);
  for (const mutate of [
    (value) => { value.components[0].installDirectory = "../external"; },
    (value) => { value.components[0].archiveURL = "https://example.com/runtime.zip"; },
    (value) => { value.components[0].selectedURLs = [value.components[0].archiveURL, "https://example.com/runtime.zip"]; },
    (value) => { value.components[0].sha256 = "short"; },
    (value) => { value.components[1].wheels[0].archiveURL = "https://files.pythonhosted.org/packages/aa/bb/gallery_dl-1.0-cp313-win_amd64.whl"; },
    (value) => { value.components[1].pthFile = "../user"; },
    (value) => { value.components[1].wheels[0].licenseFiles = ["../private-file"]; },
  ]) {
    Object.assign(item.manifest, structuredClone(original)); mutate(item.manifest); await item.save();
    await assert.rejects(readRuntimeManifest(item.root), { code: "runtime-manifest-invalid" });
  }
  assert.equal(item.calls(), 0);
});

test("ZIP rejects traversal, device names, aliases, links and encrypted entries before writing", async (t) => {
  const item = await fixture(t), zipFile = path.join(item.root, "fixture.zip"), limits = { maxDownloadBytes: 1024 * 1024, maxExtractBytes: 1024 * 1024 };
  for (const name of ["../outside", "/outside", "a/../../outside", "a\\file", "file:stream", "CON.txt", "a./file", "a /file", "a//file", "a\u0001file"]) {
    await writeFile(zipFile, zip([{ name }])); await assert.rejects(inspectRuntimeZip(zipFile, limits), { code: "runtime-zip-invalid" });
  }
  for (const entries of [[{ name: "A.txt" }, { name: "a.txt" }], [{ name: "link", mode: 0xa000 }], [{ name: "encrypted", flags: 1 }], [{ name: "a" }, { name: "a/file" }]]) {
    await writeFile(zipFile, zip(entries)); await assert.rejects(inspectRuntimeZip(zipFile, limits), { code: "runtime-zip-invalid" });
  }
});

test("CRC errors, inflated limits and wheel executable scripts are refused and leave no final component", async (t) => {
  for (const bad of [{ name: "chrome-win64/chrome.exe", crc: 1 }, { name: "chrome-win64/chrome.exe", content: "big".repeat(2_000_000) }]) {
    const item = await fixture(t, { chromium: [bad, { name: "chrome-win64/chrome.dll" }] });
    await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-zip-invalid" });
    assert.deepEqual(await readdir(path.join(item.root, "runtime", "browsers")), []);
  }
  const item = await fixture(t), wheel = item.manifest.components[1].wheels[0];
  const malicious = zip([{ name: "gallery_dl/__init__.py" }, { name: "gallery_dl-1.0.data/scripts/execute.cmd" }]);
  item.archives.set(wheel.archiveURL, malicious); wheel.downloadBytes = malicious.length; wheel.sha256 = createHash("sha256").update(malicious).digest("hex"); await item.save();
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-wheel-invalid" });
  assert.equal((await portableRuntimeStatus({ root: item.root })).components[0].ready, true);
});

test("download refuses off-list redirects, oversized bodies and TLS failures without fallback", async (t) => {
  for (const fetcher of [async () => new Response("", { status: 307, headers: { location: "https://example.com/unsafe.zip" } }),
    async () => new Response("", { headers: { "content-length": 2 * 1024 * 1024 } }),
    async () => { throw Object.assign(new Error("TLS validation failed"), { code: "CERT_HAS_EXPIRED" }); }]) {
    const item = await fixture(t); await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, fetcher }));
    assert.deepEqual(await readdir(path.join(item.root, "runtime", "browsers")), []);
  }
});

test("abort during streaming download cooperatively cancels and removes only owned staging", async (t) => {
  const item = await fixture(t), controller = new AbortController(); let cancelled = false;
  const fetcher = async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([0x50, 0x4b])); setTimeout(() => controller.abort(), 20); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, signal: controller.signal, fetcher }), { name: "AbortError" });
  assert.equal(cancelled, true); assert.deepEqual(await readdir(path.join(item.root, "runtime", "browsers")), []);
  assert.deepEqual(await readdir(item.root), ["components", "runtime"]);
});

test("parallel confirmed preparations are locked before download and lock releases on failure", async (t) => {
  const item = await fixture(t); let unblock, requests = 0;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const fetcher = async (...args) => { requests++; if (requests === 1) await gate; return item.fetcher(...args); };
  const first = preparePortableRuntime({ ...item, confirmed: true, fetcher });
  while (requests !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const status = await portableRuntimeStatus({ root: item.root }); assert.equal(status.installInProgress, true); assert.equal(status.requiresDownload, false);
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, fetcher }), { code: "runtime-install-busy" });
  assert.equal(requests, 1); unblock(); assert.equal((await first).ready, true);
  assert.ok(!(await readdir(path.join(item.root, "runtime"))).includes(".collector-runtime-install.lock.json"));
});

test("changed lock is preserved and a stale lock never silently removes arbitrary files", async (t) => {
  const item = await fixture(t), filename = path.join(item.root, "runtime", ".collector-runtime-install.lock.json");
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true, fetcher: async () => {
    await writeFile(filename, '{"unknown":"keep"}'); throw new Error("fixture failure");
  } }));
  assert.equal(await readFile(filename, "utf8"), '{"unknown":"keep"}');
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-existing-invalid" });
  assert.equal(item.calls(), 0);
});

test("linked parent directory cannot redirect installation outside package", async (t) => {
  const item = await fixture(t), outside = await mkdtemp(path.join(os.tmpdir(), "tracker-runtime-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(item.root, "runtime"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await portableRuntimeStatus({ root: item.root })).blocked, true);
  await assert.rejects(preparePortableRuntime({ ...item, confirmed: true }), { code: "runtime-existing-invalid" });
  assert.equal(item.calls(), 0); assert.deepEqual(await readdir(outside), []);
});

test("CLI defaults to isolated status, ignores developer paths and never installs without consent", async (t) => {
  const item = await fixture(t), scripts = path.join(item.root, "app", "scripts"), library = path.join(item.root, "app", "lib");
  await mkdir(scripts, { recursive: true }); await mkdir(library);
  await writeFile(path.join(item.root, "app", "package.json"), '{"type":"module"}');
  await copyFile(new URL("../scripts/prepare-portable-runtime.mjs", import.meta.url), path.join(scripts, "prepare-portable-runtime.mjs"));
  await copyFile(new URL("../lib/portable-runtime.mjs", import.meta.url), path.join(library, "portable-runtime.mjs"));
  const cli = path.join(scripts, "prepare-portable-runtime.mjs"), env = { ...process.env, MEDIA_TRACKER_PORTABLE_ROOT: path.dirname(item.root), MEDIA_TRACKER_DATA_DIR: path.join(item.root, "bad-data"), PLAYWRIGHT_BROWSERS_PATH: "stale" };
  const output = await run(process.execPath, [cli, "--status", "--json"], { env, windowsHide: true });
  const status = JSON.parse(output.stdout); assert.equal(status.ready, false); assert.ok(status.components.every((component) => component.directory.startsWith(item.root)));
  await assert.rejects(run(process.execPath, [cli, "--install"], { env, windowsHide: true }), (error) => JSON.parse(error.stdout).code === "runtime-confirmation-required");
  await assert.rejects(run(process.execPath, [cli, "--root", path.dirname(item.root)], { env, windowsHide: true }));
  assert.deepEqual(await readdir(item.root), ["app", "components"]);
});

test("GUI CLI cancels on parent-pipe EOF before download, while standalone callers keep default EOF behavior", async (t) => {
  const item = await fixture(t), scripts = path.join(item.root, "app", "scripts"), library = path.join(item.root, "app", "lib");
  await mkdir(scripts, { recursive: true }); await mkdir(library);
  await writeFile(path.join(item.root, "app", "package.json"), '{"type":"module"}');
  await copyFile(new URL("../scripts/prepare-portable-runtime.mjs", import.meta.url), path.join(scripts, "prepare-portable-runtime.mjs"));
  const original = await readFile(new URL("../lib/portable-runtime.mjs", import.meta.url), "utf8");
  // This isolated fixture refuses networking even if a regression reaches fetch.
  // It never imports the real service or touches the user's portable folder.
  await writeFile(path.join(library, "portable-runtime.mjs"), original + "\nglobalThis.fetch=()=>{process.stdout.write('UNEXPECTED_NETWORK\\n');throw new Error('fixture network refused')};\n");
  const cli = path.join(scripts, "prepare-portable-runtime.mjs");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--install", "--confirmed", "--cancel-on-eof"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("GUI EOF cancellation timed out")); }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
  assert.equal(result.code, 2); assert.ok(!result.stdout.includes("UNEXPECTED_NETWORK")); assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.at(-1).type, "error"); assert.match(lines.at(-1).message, /已取消/);
  const status = await portableRuntimeStatus({ root: item.root }); assert.equal(status.ready, false); assert.equal(status.installInProgress, false);
  // No EOF flag: explicit standalone install continues up to the mocked fetch;
  // the fixture rejects it instead of making any real external request.
  await assert.rejects(run(process.execPath, [cli, "--install", "--confirmed"], { windowsHide: true }), (error) => {
    assert.equal(error.code, 1); assert.match(error.stdout, /UNEXPECTED_NETWORK/); return true;
  });
});
