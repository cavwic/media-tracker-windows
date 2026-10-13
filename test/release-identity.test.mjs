import test from "node:test";
import { publicApiFetch as fetch, copyPublicApplicationFixture } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readReleaseIdentity, ReleaseIdentityError } from "../lib/release-identity.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const sourceEntry = { source: "public/app.js", file: "app/public/app.js", bytes: 12, sha256: "a".repeat(64) };
const manifest = () => ({ schemaVersion: 1, version: "0.1.2", buildId: "media-tracker-0.1.2-standard-20261009T090000000Z-abcdef012345",
  builtAt: "2026-10-09T09:00:00.000Z", edition: "standard", distribution: "online-slim",
  source: { fingerprint: "b".repeat(64), fileCount: 1, latestModifiedAt: "2026-10-09T08:59:00.000Z", files: [{ ...sourceEntry }] } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "collector-release-identity-test-"));
  const application = path.join(directory, "app");
  await mkdir(application);
  await writeFile(path.join(application, "package.json"), JSON.stringify({ version: "0.1.2" }));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("collector-release-identity-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, application, filename: path.join(directory, "release-manifest.json") };
}

test("current release identity includes only safe public build metadata, never source or install paths", async (t) => {
  const setup = await fixture(t);
  const value = manifest();
  await writeFile(setup.filename, JSON.stringify(value));
  const identity = await readReleaseIdentity({ root: setup.application, portableRoot: setup.directory });
  assert.deepEqual(identity, { version: value.version, buildId: value.buildId, builtAt: value.builtAt,
    sourceFingerprint: value.source.fingerprint, edition: value.edition, distribution: value.distribution });
  assert.equal(Object.isFrozen(identity), true);
  assert.ok(!JSON.stringify(identity).includes(setup.directory));
  assert.ok(!Object.hasOwn(identity, "source"));
  value.edition = "minimal"; value.distribution = "online-minimal";
  await writeFile(setup.filename, JSON.stringify(value));
  assert.equal((await readReleaseIdentity({ root: setup.application, portableRoot: setup.directory })).edition, "minimal");
});

test("development mode and old or missing release manifests remain usable without claiming current provenance", async (t) => {
  const setup = await fixture(t);
  const development = await readReleaseIdentity({ root: setup.application });
  assert.equal(development.version, "0.1.2");
  assert.equal(development.edition, "development");
  assert.equal(development.buildId, null);
  const missing = await readReleaseIdentity({ root: setup.application, portableRoot: setup.directory });
  assert.equal(missing.version, "0.1.2");
  assert.equal(missing.legacy, true);
  await writeFile(setup.filename, JSON.stringify({ schemaVersion: 1, version: "0.1.1", edition: "minimal", distribution: "online-minimal" }));
  const legacy = await readReleaseIdentity({ root: setup.application, portableRoot: setup.directory });
  assert.equal(legacy.version, "0.1.1");
  assert.equal(legacy.edition, "minimal");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.sourceFingerprint, null);
  await writeFile(path.join(setup.application, "package.json"), "broken");
  assert.equal((await readReleaseIdentity({ root: setup.application })).version, "unknown");
});

test("incomplete new release metadata, unsafe headers and invalid dates fail explicitly", async (t) => {
  const setup = await fixture(t);
  const mutations = [
    (value) => { delete value.builtAt; },
    (value) => { value.buildId = "invalid\r\nX-Unsafe: yes"; },
    (value) => { value.buildId = "D:\\private\\user"; },
    (value) => { value.version = "C:\\private"; },
    (value) => { value.builtAt = "2026-02-30T09:00:00.000Z"; },
    (value) => { value.source.latestModifiedAt = "not-a-date"; },
    (value) => { value.source.fingerprint = "old"; },
    (value) => { value.source.fileCount = 2; },
    (value) => { value.edition = "C:\\Fixture\\private"; },
    (value) => { value.distribution = "private-route"; },
  ];
  for (const mutate of mutations) {
    const value = manifest(); mutate(value);
    await writeFile(setup.filename, JSON.stringify(value));
    await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: setup.directory }),
      (error) => error instanceof ReleaseIdentityError && error.code === "RELEASE_IDENTITY_INVALID" && !error.message.includes(setup.directory));
  }
});

test("source mappings reject traversal, private state, duplicates and invalid hashes without reading target paths", async (t) => {
  const setup = await fixture(t);
  for (const field of ["source", "file"]) {
    for (const unsafe of ["../secret", "/secret", "D:/private", "app\\public\\app.js", "app/./x", "app//x", "app/data/state.json", "data/state.json", "app/browser-profiles/Cookies", "app/x\0y"]) {
      const value = manifest(); value.source.files[0][field] = unsafe;
      await writeFile(setup.filename, JSON.stringify(value));
      await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: setup.directory }), ReleaseIdentityError);
    }
  }
  for (const mutate of [
    (value) => { value.source.files[0].sha256 = "bad"; },
    (value) => { value.source.files[0].bytes = -1; },
    (value) => { value.source.fileCount = 2; value.source.files.push({ ...sourceEntry }); },
  ]) {
    const value = manifest(); mutate(value);
    await writeFile(setup.filename, JSON.stringify(value));
    await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: setup.directory }), ReleaseIdentityError);
  }
  // Only release-manifest.json is read. This valid mapping need not exist.
  const value = manifest(); value.source.files[0].source = "public/absent.js";
  await writeFile(setup.filename, JSON.stringify(value));
  assert.equal((await readReleaseIdentity({ root: setup.application, portableRoot: setup.directory })).buildId, value.buildId);
});

test("malformed and oversized release files are not silently reported as legacy", async (t) => {
  const setup = await fixture(t);
  await writeFile(setup.filename, "{");
  await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: setup.directory }), ReleaseIdentityError);
  await writeFile(setup.filename, " ".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: setup.directory }), ReleaseIdentityError);
  await assert.rejects(readReleaseIdentity({ root: "relative" }), ReleaseIdentityError);
  await assert.rejects(readReleaseIdentity({ root: setup.application, portableRoot: "relative" }), ReleaseIdentityError);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("runtime APIs and actual static responses expose one startup-cached release identity without altering HTML", { timeout: 20_000 }, async (t) => {
  const setup = await fixture(t);
  const value = manifest();
  await writeFile(setup.filename, JSON.stringify(value));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const appRoot = await copyPublicApplicationFixture(setup.directory);
  const child = spawn(process.execPath, [path.join(appRoot, "server.mjs")], { cwd: appRoot,
    env: { ...process.env, MEDIA_TRACKER_PORTABLE_ROOT: setup.directory, MEDIA_TRACKER_PORT: String(port),
      MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  exited.catch(() => {});
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited.catch(() => {}); } });
  const deadline = Date.now() + 10_000;
  while (!stdout.includes("Media Tracker 已启动：")) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Identity fixture startup failed: " + stderr);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const runtime = await (await fetch(origin + "/api/runtime/status")).json();
  assert.equal(runtime.release.buildId, value.buildId);
  assert.equal(runtime.release.sourceFingerprint, value.source.fingerprint);
  const state = await (await fetch(origin + "/api/state")).json();
  assert.deepEqual(state.runtime.release, runtime.release);
  for (const [route, filename] of [["/", "index.html"], ["/app.js", "app.js"], ["/i18n.js", "i18n.js"], ["/styles.css", "styles.css"]]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Media-Tracker-Build"), value.buildId);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(ROOT, "public", filename)));
  }
  const illegal = await fetch(origin + "/%2e%2e%2fserver.mjs");
  assert.equal(illegal.status, 404);
  assert.ok(!(await illegal.text()).includes(ROOT));
  await writeFile(setup.filename, "invalid after startup");
  assert.deepEqual((await (await fetch(origin + "/api/runtime/status")).json()).release, runtime.release);
  const exit = await fetch(origin + "/api/runtime/exit", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  assert.equal(exit.status, 202);
  assert.equal(await exited, 0, stderr);
});
