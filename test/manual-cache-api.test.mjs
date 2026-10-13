import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServerReady(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.includes("Media Tracker 已启动：")) { cleanup(); resolve(stdout); }
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code, signal) => {
      cleanup(); reject(new Error(`Test server stopped before ready: ${code ?? signal}\n${stdout}\n${stderr}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => { cleanup(); reject(new Error(`Test server readiness timed out:\n${stdout}\n${stderr}`)); }, timeoutMs);
  });
}

test("cache APIs preview read-only server-owned profiles, require confirmation and reject cross-origin/path requests", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-cache-api-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const outside = path.join(temporaryRoot, "not-a-cache.txt");
  await mkdir(dataDirectory);
  await writeFile(outside, "must be preserved");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: dataDirectory, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    const started = await waitForServerReady(child);
    assert.match(started, /已启动/);
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const preview = await fetch(`${origin}/api/cache/preview`, { headers: { Origin: origin } });
    assert.equal(preview.status, 200);
    const result = await preview.json();
    assert.equal(result.status, "empty");
    assert.equal(result.totalBytes, 0);
    assert.equal(result.totalFiles, 0);
    assert.deepEqual(result.profiles, []);
    assert.equal((await fetch(`${origin}/api/cache/preview?path=${encodeURIComponent(outside)}`)).status, 400);
    assert.equal((await fetch(`${origin}/api/cache/preview`, { headers: { Origin: "https://unrelated.example" } })).status, 403);
    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, path: outside }, { confirm: true, profilePath: outside }]) {
      assert.equal((await fetch(`${origin}/api/cache/clean`, { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
    }
    const foreign = await fetch(`${origin}/api/cache/clean`, {
      method: "POST", headers: { ...headers, Origin: "https://unrelated.example" }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(foreign.status, 403);
    const cleaned = await fetch(`${origin}/api/cache/clean`, { method: "POST", headers, body: JSON.stringify({ confirm: true }) });
    assert.equal(cleaned.status, 200);
    const report = await cleaned.json();
    assert.equal(report.status, "empty");
    assert.equal(report.removedFiles, 0);
    assert.equal(report.removedBytes, 0);
    assert.equal(report.cleanedProfiles, 0);
    assert.equal(report.skippedProfiles, 0);
    assert.equal(await readFile(outside, "utf8"), "must be preserved");
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    // Only this exact temporary test directory is removed, never real data.
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
