import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("state API invalidates old TikTok verification without changing bindings or persisted state", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-tiktok-login-api-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const stateFile = path.join(dataDirectory, "state.json");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  try {
    await mkdir(dataDirectory);
    const linkedAccounts = [
      { id: "tiktok-old", platformId: "tiktok", label: "old_viewer", loginStatus: "verified", loginMessage: "Cached cookie accepted" },
      { id: "tiktok-current", platformId: "tiktok", label: "current_viewer", loginStatus: "verified", loginVerificationVersion: 2, loginMessage: "Online viewer confirmed" },
      { id: "x-current", platformId: "x", label: "x_viewer", loginStatus: "verified", loginMessage: "Existing X result" },
      { id: "instagram-failed", platformId: "instagram", label: "instagram_viewer", loginStatus: "failed", loginMessage: "Existing Instagram result" },
    ].map((account) => ({
      ...account,
      profileDirectory: path.join(dataDirectory, "browser-profiles", account.platformId, account.id),
      loginCheckedAt: "2026-09-28T12:00:00.000Z",
    }));
    const originalState = `${JSON.stringify({
      version: 4,
      settings: { theme: "dark" },
      linkedAccounts,
      recentPaths: [],
      persons: [{
        id: "fixture-person",
        name: "Local API fixture",
        folderPath: path.join(temporaryRoot, "archive"),
        platforms: [{
          id: "tiktok",
          accounts: [
            { id: "target-old", label: "creator_old", linkedAccountId: "tiktok-old" },
            { id: "target-current", label: "creator_current", linkedAccountId: "tiktok-current" },
          ],
        }],
      }],
    }, null, 2)}\n`;
    await writeFile(stateFile, originalState, "utf8");
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        MEDIA_TRACKER_DATA_DIR: dataDirectory,
        MEDIA_TRACKER_PORT: String(port),
        MEDIA_TRACKER_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let launchError;
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => { launchError = error; });
    let response;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${output}`);
      try {
        response = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
        await response.body?.cancel();
        response = null;
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    assert.ok(response, `Fixture server failed to start: ${output}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    const accounts = new Map(state.linkedAccounts.map((account) => [account.id, account]));
    assert.equal(accounts.get("tiktok-old").loginStatus, "unverified");
    assert.match(accounts.get("tiktok-old").loginMessage, /旧版.*在线身份检查/);
    assert.match(accounts.get("tiktok-old").loginMessage, /无需重新绑定/);
    assert.equal(accounts.get("tiktok-current").loginStatus, "verified");
    assert.equal(accounts.get("tiktok-current").loginVerificationVersion, 2);
    for (const account of linkedAccounts.slice(1)) {
      assert.equal(accounts.get(account.id).loginStatus, account.loginStatus);
      assert.equal(accounts.get(account.id).loginMessage, account.loginMessage);
    }
    for (const account of linkedAccounts) {
      assert.equal(accounts.get(account.id).loginCheckedAt, account.loginCheckedAt);
      assert.equal(accounts.get(account.id).profileDirectory, account.profileDirectory);
    }
    assert.deepEqual(state.persons[0].platforms[0].accounts.map((account) => account.linkedAccountId), ["tiktok-old", "tiktok-current"]);
    assert.equal(await readFile(stateFile, "utf8"), originalState, "GET must not rewrite the saved account state");
  } finally {
    if (child?.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith("media-tracker-tiktok-login-api-"));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
