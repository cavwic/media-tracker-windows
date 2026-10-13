import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, rm } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { DedupFeature } from "../lib/dedup-feature.mjs";
import { configureSimilarityTools, dedupToolsStatus, checkDedupTools, installBundledDedupTools } from "../lib/dedup-tools.mjs";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content), compressed = deflateRawSync(content), crc = crc32(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(8, 10); item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(compressed.length, 20); item.writeUInt32LE(content.length, 24); item.writeUInt16LE(name.length, 28); item.writeUInt32LE(position, 42);
    local.push(header, name, compressed); central.push(item, name); position += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t, { wrongHash = false, cancelDownload = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-joined-feature-install-"));
  t.after(async () => {
    // Tests own only this unique fixture; source app, published builds and the
    // user's actual data/NAS directories are never involved.
    configureSimilarityTools({}, { root: path.resolve(import.meta.dirname, ".."), allowSystemTools: true });
    await rm(root, { recursive: true, force: true });
  });
  const archiveRoot = "ffmpeg-fixture-essentials_build", archive = zip([
    { name: `${archiveRoot}/bin/ffmpeg.exe`, content: "offline fixture ffmpeg, never executed" },
    { name: `${archiveRoot}/bin/ffprobe.exe`, content: "offline fixture ffprobe, never executed" },
    { name: `${archiveRoot}/LICENSE`, content: "fixture license" },
  ]);
  const remoteURL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-fixture-essentials_build.zip";
  await mkdir(path.join(root, "components")); await mkdir(path.join(root, "data", "browser-profiles"), { recursive: true });
  await writeFile(path.join(root, "components", "edition.json"), '{"schemaVersion":1,"edition":"minimal","dedup":"on-demand"}');
  await writeFile(path.join(root, "components", "ffmpeg-package.json"), JSON.stringify({ version: "fixture", archiveRoot, remoteURL,
    sha256: wrongHash ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex") }));
  const stateFile = path.join(root, "data", "state.json"), cookieFile = path.join(root, "data", "browser-profiles", "Cookies.fixture");
  const originalState = { settings: { theme: "dark", language: "system", dedupTools: { directory: "" } },
    persons: [{ id: "fixture-person", name: "Fixture person" }], linkedAccounts: [{ id: "fixture-account", loginStatus: "verified" }] };
  await writeFile(stateFile, JSON.stringify(originalState)); await writeFile(cookieFile, "fixture-session-kept");
  let fetches = 0, maintenance = 0;
  const executions = [];
  const execute = async (executable, args) => {
    executions.push({ executable, args });
    assert.ok(path.resolve(executable).toLowerCase().startsWith(path.join(root, "tools").toLowerCase() + path.sep));
    assert.ok(!args.includes("-i"));
    // The real checker still checks paths, versions and capabilities. Only the
    // binary execution itself is simulated; no media or real tools are invoked.
    if (args[0] === "-version") return `${path.basename(executable, ".exe")} version joined-fixture`;
    assert.deepEqual(args, ["-hide_banner", "-filters"]);
    return " .. scale V->V\n .. select V->V";
  };
  const env = { PATH: "", MEDIA_TRACKER_FFMPEG: "", MEDIA_TRACKER_FFPROBE: "" };
  const fetcher = async (url, options) => {
    fetches++; assert.equal(url, remoteURL); assert.equal(options.redirect, "error"); options.signal.throwIfAborted();
    if (cancelDownload) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(archive.subarray(0, 10))); },
      // Remainder intentionally waits until cancellation. Fetch signal abort
      // must stop the real installer before any final directory is enabled.
      pull(controller) {
        return new Promise((resolve) => options.signal.addEventListener("abort", () => { controller.error(options.signal.reason); resolve(); }, { once: true }));
      },
    }));
    return new Response(archive);
  };
  const options = {
    root, loadState: async () => JSON.parse(await readFile(stateFile, "utf8")),
    saveState: async (state) => { await writeFile(stateFile + ".tmp", JSON.stringify(state)); await rename(stateFile + ".tmp", stateFile); },
    configureTools: configureSimilarityTools,
    statusTools: (settings) => dedupToolsStatus({ ...settings, env, execute }),
    checkTools: (settings) => checkDedupTools({ ...settings, env, execute }),
    installTools: (settings) => installBundledDedupTools({ ...settings, fetcher }),
    acquireMaintenance: () => { assert.equal(maintenance, 0); maintenance++; return "owned-fixture-maintenance"; },
    releaseMaintenance: (token) => { assert.equal(token, "owned-fixture-maintenance"); maintenance--; },
  };
  return { root, stateFile, cookieFile, originalState, options, executions, fetches: () => fetches, maintenance: () => maintenance };
}

test("joined actual installer enables minimal feature, persists relative path and remains enabled on reconstruction", async (t) => {
  const item = await fixture(t), feature = new DedupFeature(item.options);
  assert.equal((await feature.status()).available, false); assert.equal(item.fetches(), 0); assert.equal(item.executions.length, 0);
  await assert.rejects(feature.startInstall({ confirmed: false }), { code: "dedup-feature-confirm-required" });
  assert.equal(item.fetches(), 0);
  await feature.startInstall({ confirmed: true }); await feature.running;
  const status = await feature.status();
  assert.equal(status.available, true); assert.equal(status.ready, true); assert.equal(status.progress.status, "completed");
  assert.equal(item.fetches(), 1); assert.equal(item.maintenance(), 0); assert.ok(item.executions.length >= 9);
  const state = JSON.parse(await readFile(item.stateFile, "utf8"));
  assert.equal(state.settings.dedupTools.directory, path.join("tools", "ffmpeg-fixture", "bin"));
  assert.deepEqual(state.persons, item.originalState.persons); assert.deepEqual(state.linkedAccounts, item.originalState.linkedAccounts);
  assert.equal(state.settings.theme, "dark"); assert.equal(await readFile(item.cookieFile, "utf8"), "fixture-session-kept");
  assert.deepEqual(await readdir(path.join(item.root, "tools")), ["ffmpeg-fixture"]);
  assert.equal(await readFile(path.join(item.root, "tools", "ffmpeg-fixture", "LICENSE"), "utf8"), "fixture license");
  const restarted = new DedupFeature(item.options);
  assert.equal((await restarted.status()).available, true); await restarted.checkTools();
  await restarted.startInstall({ confirmed: true }); assert.equal(item.fetches(), 1);
});

test("joined actual installer rejects bad archive SHA and leaves feature, settings and login fixtures unchanged", async (t) => {
  const item = await fixture(t, { wrongHash: true }), feature = new DedupFeature(item.options);
  await feature.startInstall({ confirmed: true }); await feature.running;
  const status = await feature.status();
  assert.equal(status.available, false); assert.equal(status.progress.status, "failed"); assert.match(status.progress.message, /校验失败/);
  assert.equal(item.fetches(), 1); assert.equal(item.executions.length, 0); assert.equal(item.maintenance(), 0);
  assert.deepEqual(JSON.parse(await readFile(item.stateFile, "utf8")), item.originalState);
  assert.equal(await readFile(item.cookieFile, "utf8"), "fixture-session-kept");
  await assert.rejects(readdir(path.join(item.root, "tools")), { code: "ENOENT" });
});

test("joined actual installer streaming cancellation never enables partial tools or changes saved settings", async (t) => {
  const item = await fixture(t, { cancelDownload: true }), feature = new DedupFeature(item.options);
  const status = await feature.startInstall({ confirmed: true }); assert.equal(status.installing, true);
  while (!item.fetches()) await new Promise((resolve) => setTimeout(resolve, 1));
  await feature.cancel({ confirmed: true }); await feature.running;
  const cancelled = await feature.status();
  assert.equal(cancelled.available, false); assert.equal(cancelled.installing, false); assert.equal(cancelled.progress.status, "cancelled");
  assert.equal(item.maintenance(), 0); assert.equal(item.executions.length, 0);
  assert.deepEqual(JSON.parse(await readFile(item.stateFile, "utf8")), item.originalState);
  assert.equal(await readFile(item.cookieFile, "utf8"), "fixture-session-kept");
  await assert.rejects(readdir(path.join(item.root, "tools")), { code: "ENOENT" });
});
