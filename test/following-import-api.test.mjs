import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function bounded(promise, description, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function optionalRead(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

test("following import HTTP endpoints validate IDs, origins and verified bindings without changing saved data", { timeout: 20_000 }, async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-following-api-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: dataDirectory, MEDIA_TRACKER_PORT: String(port),
      MEDIA_TRACKER_NO_OPEN: "1", MEDIA_TRACKER_BACKGROUND_START: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await bounded(exited.catch(() => {}), "Following API fixture cleanup timed out", 5_000);
    }
    // Only this exact fixture directory, never the user's tool or NAS media.
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await bounded((async () => {
    while (!stdout.includes("Media Tracker 已启动：")) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture startup failed: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })(), "Following API fixture startup timed out");

  const headers = { Origin: origin, "Content-Type": "application/json" };
  // Confirm the new network route is gated before any binding lookup or
  // browser startup. All later test operations use explicit fixture consent.
  const session = await globalThis.fetch(`${origin}/api/session`, { headers: { Origin: origin } }).then(response => response.json());
  const withoutConsent = await globalThis.fetch(`${origin}/api/following-imports`, {
    method: "POST", headers: { ...headers, "X-Media-Tracker-Token": session.token },
    body: JSON.stringify({ linkedAccountId: "missing-binding" }) });
  assert.equal(withoutConsent.status, 428);
  assert.equal((await withoutConsent.json()).code, "PUBLIC_USE_ACK_REQUIRED");
  const acceptedConsent = await globalThis.fetch(`${origin}/api/release-policy`, { method: "POST",
    headers: { ...headers, "X-Media-Tracker-Token": session.token }, body: JSON.stringify({ acknowledged: true, version: 1 }) });
  assert.equal(acceptedConsent.status, 200);
  const created = await fetch(`${origin}/api/linked-accounts`, { method: "POST", headers,
    body: JSON.stringify({ platformId: "x", label: "Offline unverified fixture" }) });
  assert.equal(created.status, 201);
  const account = await created.json();
  assert.equal(account.loginStatus, "unverified");
  const stateFile = path.join(dataDirectory, "state.json");
  const indexFile = path.join(dataDirectory, "sync-index.json");
  const stateBefore = await readFile(stateFile, "utf8");
  const indexBefore = await optionalRead(indexFile);
  const post = (body, extraHeaders = {}) => fetch(`${origin}/api/following-imports`, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });

  for (const body of [null, [], {}, { linkedAccountId: "" }, { linkedAccountId: 3 },
    { linkedAccountId: account.id, profileDirectory: path.join(temporaryRoot, "caller-path") },
    { linkedAccountId: account.id, url: "https://unrelated.invalid/" }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ linkedAccountId: "missing-binding" })).status, 404);
  const unverified = await post({ linkedAccountId: account.id });
  assert.equal(unverified.status, 409);
  const failure = await unverified.json();
  assert.match(failure.error, /验证|登录/);
  assert.equal(JSON.stringify(failure).includes(account.profileDirectory), false);
  assert.equal((await post({ linkedAccountId: account.id }, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await fetch(`${origin}/api/following-imports?url=https://foreign.example`, {
    method: "POST", headers, body: JSON.stringify({ linkedAccountId: account.id }) })).status, 400);

  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job`)).status, 404);
  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job`, {
    headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job?profileDirectory=C:/caller`)).status, 400);
  assert.equal((await fetch(`${origin}/api/following-imports/%2Foutside`)).status, 400);
  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job`, { method: "DELETE", headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job`, {
    method: "DELETE", headers, body: JSON.stringify({ linkedAccountId: account.id }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/following-imports/unknown-job`, {
    method: "DELETE", headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
  assert.equal(await readFile(stateFile, "utf8"), stateBefore);
  assert.equal(await optionalRead(indexFile), indexBefore);

  // Seed only this fixture's cached verification. The exact profile path has
  // never been created, so server preflight must fail before browser launch,
  // process inspection, navigation or any real platform network operation.
  const fixtureState = JSON.parse(stateBefore);
  const seededAccount = fixtureState.linkedAccounts.find(item => item.id === account.id);
  seededAccount.loginStatus = "verified";
  // Keep this public edition's profile inside its own protected data root.
  await rm(account.profileDirectory, { recursive: true, force: true });
  const seededStateBytes = JSON.stringify(fixtureState);
  await writeFile(stateFile, seededStateBytes);
  const accepted = await post({ linkedAccountId: account.id });
  assert.equal(accepted.status, 202, `${await accepted.clone().text()}\n${stderr}`);
  let { job } = await accepted.json();
  assert.equal(job.linkedAccountId, account.id);
  assert.equal(job.platformId, "x");
  for (let attempt = 0; attempt < 50 && ["queued", "running"].includes(job.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const progress = await fetch(`${origin}/api/following-imports/${job.id}`, { headers });
    assert.equal(progress.status, 200);
    ({ job } = await progress.json());
  }
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "profile-missing");
  assert.deepEqual(job.accounts, []);
  assert.equal(JSON.stringify(job).includes(seededAccount.profileDirectory), false);
  const stopped = await fetch(`${origin}/api/following-imports/${job.id}`, { method: "DELETE", headers });
  assert.equal(stopped.status, 200);
  const stoppedResult = await stopped.json();
  assert.equal(stoppedResult.job.id, job.id);
  assert.equal(stoppedResult.job.status, "failed");
  assert.equal(await readFile(stateFile, "utf8"), seededStateBytes);
  assert.equal(await optionalRead(indexFile), indexBefore);

  const close = await fetch(`${origin}/api/runtime/exit`, { method: "POST", headers,
    body: JSON.stringify({ confirm: true }) });
  assert.equal(close.status, 202);
  const outcome = await bounded(exited, `Following API fixture shutdown timed out: ${stderr}`);
  assert.equal(outcome.code, 0, stderr);
  assert.equal(outcome.signal, null);
  assert.equal(await readFile(stateFile, "utf8"), seededStateBytes);
  assert.equal(await optionalRead(indexFile), indexBefore);
});

