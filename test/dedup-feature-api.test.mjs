import test from "node:test";
import { publicApiFetch as fetch, copyPublicApplicationFixture } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";

test("minimal feature API starts disabled, requires explicit consent, never starts dedup and preserves profiles", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-minimal-feature-api-"));
  await mkdir(path.join(root, "components")); await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "components", "edition.json"), '{"schemaVersion":1,"edition":"minimal","dedup":"on-demand"}');
  const stored = { version: 4, settings: { theme: "dark", language: "system", dedupTools: { directory: "" } }, persons: [], linkedAccounts: [], customPlatforms: [], recentPaths: [] };
  await writeFile(path.join(root, "data", "state.json"), JSON.stringify(stored));
  const project = await copyPublicApplicationFixture(root), probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, headers = { Origin: origin, "Content-Type": "application/json" };
  const child = spawn(process.execPath, [path.join(project, "server.mjs")], { cwd: project, windowsHide: true,
    env: { ...process.env, PATH: "", MEDIA_TRACKER_FFMPEG: "", MEDIA_TRACKER_FFPROBE: "", MEDIA_TRACKER_PORTABLE_ROOT: root,
      MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const ended = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await ended; await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`isolated API startup timeout: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("Media Tracker 已启动：")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`isolated API exited ${code}: ${stderr}`)); });
  });
  const get = async (route) => { const response = await fetch(origin + route, { headers }); assert.equal(response.status, 200); return response.json(); };
  const capability = await get("/api/features/dedup");
  assert.equal(capability.edition, "minimal"); assert.equal(capability.available, false); assert.equal(capability.installing, false); assert.equal(capability.importAvailable, false);
  const state = await get("/api/state"); assert.equal(state.runtime.dedupAvailable, false); assert.equal(state.features.dedup.available, false);
  assert.equal(Object.hasOwn(await get("/api/runtime/status"), "dedupAvailable"), false);
  for (const body of [{ confirmed: false }, { confirmed: true, archivePath: "C:\\anything.zip" }, { confirmed: true, remoteURL: "https://example.com/tools.zip" }]) {
    const response = await fetch(origin + "/api/features/dedup/install", { method: "POST", headers, body: JSON.stringify(body) }); assert.equal(response.status, 400);
  }
  const missing = await fetch(origin + "/api/features/dedup/install", { method: "POST", headers, body: '{"confirmed":true}' });
  assert.equal(missing.status, 422); assert.match((await missing.json()).error, /未连接网络/);
  const manual = await fetch(origin + "/api/dedup-all", { method: "POST", headers, body: '{"confirm":true}' }); assert.equal(manual.status, 409);
  const report = await get("/api/dedup-status"); assert.ok(!report.id);
  const cancel = await fetch(origin + "/api/features/dedup/cancel", { method: "POST", headers, body: '{"confirmed":true}' }); assert.equal(cancel.status, 202);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "data", "state.json"), "utf8")), stored);
  const foreignOrigin = await fetch(origin + "/api/features/dedup", { headers: { Origin: "https://example.com" } }); assert.equal(foreignOrigin.status, 403);
});
