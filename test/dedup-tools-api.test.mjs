import test from "node:test";
import { publicApiFetch as fetch, copyPublicApplicationFixture } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";

test("API prechecks dependencies before creating manual jobs and retains settings and private data", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-dedup-api-tools-")), probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const project = await copyPublicApplicationFixture(root), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(project, "server.mjs")], { cwd: project,
    env: { ...process.env, PATH: "", MEDIA_TRACKER_FFMPEG: "", MEDIA_TRACKER_FFPROBE: "",
      MEDIA_TRACKER_PORTABLE_ROOT: root, MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1", MEDIA_TRACKER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${errors}`)), 10_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("Media Tracker 已启动：")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited: ${code}, ${errors}`)); });
  });
  const headers = { "Content-Type": "application/json", Origin: origin };
  const status = await fetch(`${origin}/api/tools/dedup`, { headers });
  assert.equal(status.status, 200); assert.equal((await status.json()).ready, false);
  for (const [route, body] of [["dedup-all", { confirm: true }], ["dedup-person", { confirm: true, personId: "fixture" }]]) {
    const response = await fetch(`${origin}/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409); assert.match((await response.json()).error, /FFmpeg/);
  }
  const unchanged = await fetch(`${origin}/api/dedup-status`, { headers });
  const report = await unchanged.json();
  assert.ok(!report.id);
  const invalid = await fetch(`${origin}/api/tools/dedup`, { method: "PUT", headers, body: JSON.stringify({ directory: "../outside" }) });
  assert.equal(invalid.status, 400);
  const notConfirmed = await fetch(`${origin}/api/tools/dedup/install`, { method: "POST", headers, body: JSON.stringify({ confirmed: false }) });
  assert.equal(notConfirmed.status, 400);
  const noComponent = await fetch(`${origin}/api/tools/dedup/install`, { method: "POST", headers, body: JSON.stringify({ confirmed: true }) });
  assert.equal(noComponent.status, 422);
  const theme = await fetch(`${origin}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ theme: "dark" }) });
  assert.equal(theme.status, 200);
  const state = JSON.parse(await readFile(path.join(root, "data", "state.json"), "utf8"));
  assert.equal(state.settings.theme, "dark"); assert.deepEqual(state.linkedAccounts, []);
});
