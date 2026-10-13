import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { checkDedupTools, dedupToolsStatus, configureSimilarityTools, portableToolDirectory,
  normalizeDedupToolsSettings, decodeDedupPackageZip, installBundledDedupTools } from "../lib/dedup-tools.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-dedup-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function zip(entries) {
  const locals = [], central = []; let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content || "fixture"), raw = deflateRawSync(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(entry.flags || 0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(46); descriptor.writeUInt32LE(0x02014b50); descriptor.writeUInt16LE(entry.flags || 0, 8); descriptor.writeUInt16LE(8, 10);
    descriptor.writeUInt32LE(raw.length, 20); descriptor.writeUInt32LE(content.length, 24); descriptor.writeUInt16LE(name.length, 28);
    descriptor.writeUInt32LE((entry.mode || 0) * 65536, 38); descriptor.writeUInt32LE(position, 42);
    locals.push(local, name, raw); central.push(descriptor, name); position += local.length + name.length + raw.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}

const entries = () => [{ name: "bin/ffmpeg.exe" }, { name: "bin/ffprobe.exe" }, { name: "LICENSE" }, { name: "README.txt" }];

async function component(root, entriesValue = entries(), hashOverride) {
  const folder = path.join(root, "components"), archive = zip(entriesValue);
  await mkdir(folder);
  await writeFile(path.join(folder, "ffmpeg.zip"), archive);
  await writeFile(path.join(folder, "ffmpeg-package.json"), JSON.stringify({ file: "ffmpeg.zip", version: "fixture-1", sha256: hashOverride || createHash("sha256").update(archive).digest("hex") }));
  return folder;
}

test("missing tools are detected before decoding and status never downloads", async (t) => {
  const root = await fixture(t);
  await assert.rejects(checkDedupTools({ root, env: { PATH: "" } }), { code: "similarity-tools-unavailable" });
  await component(root);
  let executed = false;
  const result = await dedupToolsStatus({ root, env: { PATH: "" }, execute: () => { executed = true; } });
  assert.equal(result.ready, false); assert.equal(result.installAvailable, true); assert.equal(executed, false);
  assert.equal(result.defaultInstallDirectory, path.join(root, "tools"));
});

test("manual check verifies both programs and required filters without a media path", async (t) => {
  const root = await fixture(t), bin = path.join(root, "tools", "ffmpeg", "bin"), suffix = process.platform === "win32" ? ".exe" : "";
  await mkdir(bin, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) await writeFile(path.join(bin, name + suffix), "fixture");
  const calls = [];
  const execute = async (executable, args) => { calls.push({ executable, args }); return args[0] === "-version" ? `${path.basename(executable, suffix)} version fixture` : " .. scale V->V\n .. select V->V"; };
  const result = await checkDedupTools({ root, directory: "tools/ffmpeg", execute });
  assert.equal(result.ready, true); assert.equal(result.directory, bin); assert.equal(calls.length, 3);
  assert.ok(calls.every(({ args }) => !args.includes("-i")));
  await assert.rejects(checkDedupTools({ root, directory: bin, execute: async () => "wrong program" }), { code: "similarity-tools-check-failed" });
  await assert.rejects(checkDedupTools({ root, directory: bin, execute: async (exe, args) => args[0] === "-version" ? `${path.basename(exe, suffix)} version fixture` : "scale only" }), { code: "similarity-tools-check-failed" });
});

test("relative tool settings are portable and reject escaping the application root", async (t) => {
  const root = await fixture(t);
  assert.equal(portableToolDirectory(path.join(root, "tools", "ffmpeg", "bin"), root), path.join("tools", "ffmpeg", "bin"));
  assert.equal(portableToolDirectory(path.dirname(root), root), path.dirname(root));
  assert.deepEqual(normalizeDedupToolsSettings({ directory: "bad\0path", token: "ignored" }), { directory: "" });
  configureSimilarityTools({ directory: "../external" }, { root });
  await assert.rejects(checkDedupTools(), { code: "similarity-tools-path-invalid" });
  configureSimilarityTools({}, { root });
});

test("ZIP extraction only returns required tools/notices and rejects traversal, aliases, links and encrypted data", () => {
  assert.equal(decodeDedupPackageZip(zip([...entries(), { name: "bin/ffplay.exe" }, { name: "doc/readme.html" }])).length, 4);
  for (const name of ["../outside.exe", "/outside", "bin/ffmpeg.exe:stream", "bin/../other", "bin/CON.txt", "bin/ffmpeg.exe ", "bin\\ffmpeg.exe"]) {
    assert.throws(() => decodeDedupPackageZip(zip([...entries(), { name }])), { code: "similarity-package-invalid" });
  }
  assert.throws(() => decodeDedupPackageZip(zip([...entries(), { name: "BIN/FFMPEG.EXE" }])), { code: "similarity-package-invalid" });
  assert.throws(() => decodeDedupPackageZip(zip([{ name: "bin/ffmpeg.exe", mode: 0xa000 }, ...entries().slice(1)])), { code: "similarity-package-invalid" });
  assert.throws(() => decodeDedupPackageZip(zip([{ name: "bin/ffmpeg.exe", flags: 1 }, ...entries().slice(1)])), { code: "similarity-package-invalid" });
  const archiveRoot = "ffmpeg-fixture-essentials_build";
  assert.equal(decodeDedupPackageZip(zip(entries().map((entry) => ({ ...entry, name: `${archiveRoot}/${entry.name}` }))), { archiveRoot }).length, 4);
});

test("component install verifies SHA before execution and does not overwrite existing tools", async (t) => {
  const root = await fixture(t); await component(root);
  let checked = 0;
  const check = async ({ directory }) => { checked++; assert.equal(await readFile(path.join(directory, "ffmpeg.exe"), "utf8"), "fixture"); return { ready: true }; };
  const result = await installBundledDedupTools({ root, check });
  assert.equal(checked, 1); assert.equal(result.directory, path.join(root, "tools", "ffmpeg-fixture-1", "bin"));
  await assert.rejects(installBundledDedupTools({ root, check }), { code: "similarity-tools-install-conflict" });
  assert.equal(checked, 1); assert.equal((await readdir(path.join(root, "tools"))).length, 1);
});

test("bad checksum and cancelled install do not enable or leave partially installed components", async (t) => {
  const root = await fixture(t); await component(root, entries(), "0".repeat(64));
  let checked = false;
  await assert.rejects(installBundledDedupTools({ root, check: () => { checked = true; } }), { code: "similarity-package-hash-mismatch" });
  assert.equal(checked, false);
  const archive = await readFile(path.join(root, "components", "ffmpeg.zip"));
  await writeFile(path.join(root, "components", "ffmpeg-package.json"), JSON.stringify({ file: "ffmpeg.zip", version: "fixture-1", sha256: createHash("sha256").update(archive).digest("hex") }));
  const controller = new AbortController();
  await assert.rejects(installBundledDedupTools({ root, signal: controller.signal, check: async () => { controller.abort(); } }), { name: "AbortError" });
  assert.deepEqual(await readdir(path.join(root, "tools")), []);
});

test("remote package request is pinned and occurs only in explicit install", async (t) => {
  const root = await fixture(t), components = path.join(root, "components"), archive = zip(entries());
  await mkdir(components);
  const remoteURL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-fixture-essentials_build.zip";
  await writeFile(path.join(components, "ffmpeg-package.json"), JSON.stringify({ remoteURL, version: "fixture", sha256: createHash("sha256").update(archive).digest("hex") }));
  const status = await dedupToolsStatus({ root, env: { PATH: "" } });
  assert.equal(status.installAvailable, true); assert.equal(status.downloadRequired, true);
  let fetched = 0;
  await installBundledDedupTools({ root, check: async () => {}, fetcher: async (url, options) => { fetched++; assert.equal(url, remoteURL); assert.equal(options.redirect, "error"); return new Response(archive); } });
  assert.equal(fetched, 1);
  await writeFile(path.join(components, "ffmpeg-package.json"), JSON.stringify({ remoteURL: "https://example.com/unsafe.zip", version: "fixture", sha256: "a".repeat(64) }));
  assert.equal((await dedupToolsStatus({ root, env: { PATH: "" } })).installAvailable, false);
});
