import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";

async function availablePort() {
  const probe = createServer();
  try {
    const listening = once(probe, "listening");
    probe.listen(0, "127.0.0.1");
    await listening;
    return probe.address().port;
  } finally {
    if (probe.listening) await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
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

test("sync APIs queue every person, report progress, and persist receipts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "media-tracker-api-"));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      MEDIA_TRACKER_DATA_DIR: path.join(temporaryRoot, "data"),
      MEDIA_TRACKER_PORT: String(port),
      MEDIA_TRACKER_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const started = await waitForServerReady(child);
    assert.match(started, /已启动/);
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const emptyBatchResponse = await fetch(`${origin}/api/sync-all`, { method: "POST", headers: { Origin: origin } });
    assert.equal(emptyBatchResponse.status, 409);

    const people = [];
    for (const [name, label] of [["API Test A", "test_account_a"], ["API Test B", "test_account_b"]]) {
      const createResponse = await fetch(`${origin}/api/persons`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          folderMode: "new",
          selectedPath: path.join(temporaryRoot, "archive"),
          platforms: [{ id: "threads", accounts: [{ label }] }],
        }),
      });
      assert.equal(createResponse.status, 201);
      const person = await createResponse.json();
      people.push(person);
      assert.equal((await stat(path.join(person.folderPath, "Index"))).isDirectory(), true);
      for (const mediaFolder of ["Threads", "Image", "Video", "gif"]) {
        await assert.rejects(stat(path.join(person.folderPath, mediaFolder)), { code: "ENOENT" });
      }
    }

    const startResponse = await fetch(`${origin}/api/sync-all`, { method: "POST", headers: { Origin: origin } });
    assert.equal(startResponse.status, 202);
    const batch = await startResponse.json();
    assert.equal(batch.personCount, 2);
    assert.equal(batch.startedCount, 2);
    assert.equal(batch.existingCount, 0);
    assert.equal(batch.concurrency, "all");
    assert.equal(batch.jobs.length, 2);

    const finishedJobs = [];
    for (const queuedJob of batch.jobs) {
      let job = queuedJob;
      for (let attempt = 0; attempt < 50 && ["queued", "running"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        job = await fetch(`${origin}/api/sync-jobs/${job.id}`).then((response) => response.json());
      }
      finishedJobs.push(job);
    }
    assert.deepEqual(finishedJobs.map((job) => job.status), ["completed", "completed"]);
    assert.deepEqual(finishedJobs.map((job) => job.counters.unsupportedAccounts), [1, 1]);
    assert.deepEqual(finishedJobs.map((job) => job.counters.accountsFinished), [1, 1]);
    assert.deepEqual(finishedJobs.map((job) => job.newFileCount), [0, 0]);

    for (const person of people) {
      for (const mediaFolder of ["Threads", "Image", "Video", "gif"]) {
        await assert.rejects(stat(path.join(person.folderPath, mediaFolder)), { code: "ENOENT" });
      }
    }

    const state = await fetch(`${origin}/api/state`).then((response) => response.json());
    assert.equal(state.syncConcurrency, "all");
    for (const person of people) {
      assert.equal(state.syncSummaries[person.id].status, "completed");
      const receiptResponse = await fetch(`${origin}/api/persons/${person.id}/new-files`);
      assert.equal(receiptResponse.status, 200);
      const receipt = await receiptResponse.json();
      assert.equal(receipt.available, true);
      assert.deepEqual(receipt.files, []);

      const fileActionResponse = await fetch(`${origin}/api/persons/${person.id}/reveal-new-file`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fileId: "not-a-real-file" }),
      });
      assert.equal(fileActionResponse.status, 404);
      const openFileResponse = await fetch(`${origin}/api/persons/${person.id}/open-new-file`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fileId: "not-a-real-file" }),
      });
      assert.equal(openFileResponse.status, 404);
    }

    // Exercise actual HTTP persistence with an unsupported offline platform:
    // a regression cannot accidentally navigate an external social site.
    const pausedResponse = await fetch(`${origin}/api/persons`, { method: "POST", headers,
      body: JSON.stringify({ name: "Paused API", folderMode: "new", selectedPath: path.join(temporaryRoot, "archive"),
        platforms: [{ id: "threads", accounts: [{ id: "paused-target", label: "paused", syncEnabled: false }] }] }) });
    assert.equal(pausedResponse.status, 201);
    let pausedPerson = await pausedResponse.json();
    assert.equal(pausedPerson.platforms[0].accounts[0].syncEnabled, false);
    const pausedStart = await fetch(`${origin}/api/persons/${pausedPerson.id}/sync`, { method: "POST", headers });
    assert.equal(pausedStart.status, 202);
    let pausedJob = await pausedStart.json();
    for (let i = 0; i < 50 && ["queued", "running"].includes(pausedJob.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      pausedJob = await fetch(`${origin}/api/sync-jobs/${pausedJob.id}`).then(response => response.json());
    }
    assert.equal(pausedJob.status, "completed");
    assert.equal(pausedJob.counters.accounts, 0);
    assert.equal(pausedJob.counters.pausedAccounts, 1);
    assert.equal(pausedJob.counters.unsupportedAccounts, 0);
    assert.deepEqual(pausedJob.accountProgress, []);
    assert.match(pausedJob.message, /全部账号已暂停/);
    const pausedIndex = JSON.parse(await readFile(path.join(temporaryRoot, "data", "sync-index.json"), "utf8"));
    assert.equal(Object.keys(pausedIndex.scopes).some(key => key.includes(pausedPerson.id)), false);
    const persistedState = JSON.parse(await readFile(path.join(temporaryRoot, "data", "state.json"), "utf8"));
    assert.equal(persistedState.persons.find(person => person.id === pausedPerson.id).platforms[0].accounts[0].syncEnabled, false);
    const resumeResponse = await fetch(`${origin}/api/persons/${pausedPerson.id}`, { method: "PUT", headers,
      body: JSON.stringify({ name: pausedPerson.name, platforms: [{ ...pausedPerson.platforms[0],
        accounts: [{ ...pausedPerson.platforms[0].accounts[0], syncEnabled: true }] }] }) });
    assert.equal(resumeResponse.status, 200);
    pausedPerson = await resumeResponse.json();
    assert.equal(pausedPerson.platforms[0].accounts[0].syncEnabled, true);
    assert.equal(pausedPerson.platforms[0].accounts[0].id, "paused-target");
    const resumedState = await fetch(`${origin}/api/state`).then(response => response.json());
    assert.equal(resumedState.persons.find(person => person.id === pausedPerson.id).platforms[0].accounts[0].syncEnabled, true);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit").catch(() => {});
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
