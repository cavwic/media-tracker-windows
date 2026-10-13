import test from "node:test";
import { publicApiFetch as fetch, copyPublicApplicationFixture } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";

const applicationRoot = path.resolve(import.meta.dirname, "..");
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launch(packageRoot, staleData) {
  const port = await availablePort();
  const actualAppRoot = path.join(packageRoot, "app");
  const child = spawn(process.execPath, [path.join(actualAppRoot, "server.mjs")], {
    cwd: actualAppRoot, env: { ...process.env, MEDIA_TRACKER_PORTABLE_ROOT: packageRoot,
      MEDIA_TRACKER_DATA_DIR: staleData, MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1",
      MEDIA_TRACKER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const ready = new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`Portable fixture startup timed out: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("Media Tracker 已启动：")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Portable fixture exited: ${code}, ${stderr}`)); });
  });
  try { await ready; }
  catch (error) { child.kill(); await exited; throw error; }
  const origin = `http://127.0.0.1:${port}`;
  return { origin, close: async () => {
    if (child.exitCode === null) {
      const response = await fetch(`${origin}/api/runtime/exit`, { method: "POST", headers: { Origin: origin,
        "Content-Type": "application/json" }, body: '{"confirm":true}' });
      await response.body?.cancel();
    }
    await exited;
  } };
}

test("portable server saves relative bound profiles and retains cookies and verified login after a package move", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "media-tracker-portable-api-"));
  let service;
  t.after(async () => { await service?.close(); await rm(temporary, { recursive: true, force: true }); });
  const original = path.join(temporary, "original-package");
  const moved = path.join(temporary, "moved-package");
  const staleData = path.join(temporary, "stale-data");
  await mkdir(original);
  await copyPublicApplicationFixture(original);
  await mkdir(staleData);
  await writeFile(path.join(staleData, "state.json"), "Do not read, overwrite or delete this old private state.");
  service = await launch(original, staleData);
  const headers = { "Content-Type": "application/json", Origin: service.origin };
  const created = await fetch(`${service.origin}/api/linked-accounts`, { method: "POST", headers,
    body: JSON.stringify({ platformId: "instagram", label: "Portable fixture" }) });
  assert.equal(created.status, 201);
  const account = await created.json();
  const stateFile = path.join(original, "data", "state.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.match(saved.linkedAccounts[0].profileDirectory, /^browser-profiles\/instagram\/[a-f0-9-]+$/);
  assert.equal(path.isAbsolute(account.profileDirectory), true);
  assert.equal(account.profileDirectory.startsWith(path.join(original, "data")), true);
  const cookieFile = path.join(account.profileDirectory, "Default", "Cookies");
  await mkdir(path.dirname(cookieFile), { recursive: true });
  await writeFile(cookieFile, "Offline cookie sentinel, not credentials.");
  await service.close(); service = null;
  saved.linkedAccounts[0].loginStatus = "verified";
  saved.linkedAccounts[0].loginCheckedAt = "2026-10-08T00:00:00Z";
  await writeFile(stateFile, JSON.stringify(saved));
  await rename(original, moved);
  service = await launch(moved, staleData);
  const response = await fetch(`${service.origin}/api/state`);
  assert.equal(response.status, 200);
  const loaded = await response.json();
  assert.equal(loaded.linkedAccounts[0].id, account.id);
  assert.equal(loaded.linkedAccounts[0].loginStatus, "verified");
  assert.equal(loaded.linkedAccounts[0].loginCheckedAt, "2026-10-08T00:00:00Z");
  assert.equal(loaded.linkedAccounts[0].profileDirectory,
    path.join(moved, "data", ...saved.linkedAccounts[0].profileDirectory.split("/")));
  assert.equal(await readFile(path.join(loaded.linkedAccounts[0].profileDirectory, "Default", "Cookies"), "utf8"),
    "Offline cookie sentinel, not credentials.");
  const updated = await fetch(`${service.origin}/api/linked-accounts/${account.id}`, { method: "PUT",
    headers: { "Content-Type": "application/json", Origin: service.origin }, body: JSON.stringify({ label: "Moved fixture" }) });
  assert.equal(updated.status, 200);
  const movedSaved = JSON.parse(await readFile(path.join(moved, "data", "state.json"), "utf8"));
  assert.equal(movedSaved.linkedAccounts[0].profileDirectory, saved.linkedAccounts[0].profileDirectory);
  assert.equal(movedSaved.linkedAccounts[0].loginStatus, "verified");
  assert.equal(await readFile(path.join(staleData, "state.json"), "utf8"), "Do not read, overwrite or delete this old private state.");
});
