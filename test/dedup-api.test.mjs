import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";

test("one-click dedup API accepts confirmation only, preserves bindings, and stores offline receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-dedup-api-"));
  const data = path.join(root, "data");
  const person = { id: "person", name: "Person", folderPath: path.join(root, "Person"), platforms: [] };
  const other = { id: "other", name: "Other", folderPath: path.join(root, "Other"), platforms: [] };
  await mkdir(data);
  const stateFile = path.join(data, "state.json");
  await writeFile(stateFile, JSON.stringify({ version: 4, settings: { theme: "dark", publicReleaseUse: { version: 1, acceptedAt: "2026-10-12T00:00:00Z" } },
    persons: [other, person], linkedAccounts: [], customPlatforms: [], recentPaths: [] }));
  const stateBefore = await readFile(stateFile);
  const index = await openPersonMediaIndex(person, { create: true });
  await index.compact();
  const otherIndex = await openPersonMediaIndex(other, { create: true });
  await otherIndex.compact();
  clearPersonMediaIndexCache();
  const socket = http.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true,
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    clearPersonMediaIndexCache();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Service startup timeout: ${output}`)), 12_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("已启动")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Service exited ${code}`)); });
  });
  const request = (suffix, body, requestOrigin = origin) => fetch(`${origin}/api/${suffix}`, {
    method: body ? "POST" : "GET", headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await request("dedup-status")).json()).status, "idle");
  assert.equal((await request("dedup-all", {})).status, 400);
  assert.equal((await request("dedup-all", { confirm: true, path: "C:\\arbitrary" })).status, 400);
  assert.equal((await request("dedup-all", { confirm: true }, "https://untrusted.example")).status, 403);
  const idle = await (await request("dedup-status")).json();
  const absentJobId = "00000000-0000-4000-8000-000000000000";
  assert.equal(idle.dismissed, false);
  for (const body of [{}, { confirm: true }, { confirm: false, jobId: "missing" },
    { confirm: true, jobId: null }, { confirm: true, jobId: "" },
    { confirm: true, jobId: "missing", path: "C:\\arbitrary" },
    { confirm: true, jobId: "missing", closeResults: true }]) {
    assert.equal((await request("dedup-close", body)).status, 400);
  }
  assert.equal((await request("dedup-close", { confirm: true, jobId: absentJobId }, "https://untrusted.example")).status, 403);
  assert.equal((await request("dedup-close", { confirm: true, jobId: absentJobId })).status, 409);
  for (const body of [{}, { confirm: true }, { confirm: false, personId: person.id },
    { confirm: true, personId: null }, { confirm: true, personId: "" },
    { confirm: true, personId: "../person" }, { confirm: true, personId: person.id, path: "C:\\arbitrary" },
    { confirm: true, personId: person.id, evidence: { decision: "merge" } }]) {
    assert.equal((await request("dedup-person", body)).status, 400);
  }
  assert.equal((await request("dedup-person", { confirm: true, personId: person.id }, "https://untrusted.example")).status, 403);
  assert.equal((await request("dedup-person", { confirm: true, personId: "unknown" })).status, 404);
  assert.deepEqual(await (await request("dedup-status")).json(), idle, "invalid scoped requests cannot replace an existing receipt");
  assert.deepEqual(await readFile(stateFile), stateBefore, "invalid scoped requests cannot rewrite bindings or persons");
  const scopedLaunch = await request("dedup-person", { confirm: true, personId: person.id });
  assert.equal(scopedLaunch.status, 202);
  const scopedStarted = await scopedLaunch.json();
  assert.equal(scopedStarted.scope, "person");
  assert.equal(scopedStarted.personId, person.id);
  assert.equal(scopedStarted.dismissed, false);
  let scopedReport;
  for (let i = 0; i < 100; i++) {
    scopedReport = await (await request("dedup-status")).json();
    if (scopedReport.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(scopedReport.status, "completed");
  assert.equal(scopedReport.personName, person.name);
  assert.equal(scopedReport.currentPersonId, person.id);
  assert.deepEqual(scopedReport.results.map((item) => item.personId), [person.id]);
  const receiptPath = path.join(data, "dedup-last-run.json");
  for (let i = 0; i < 100; i++) {
    try { await readFile(receiptPath); break; }
    catch (error) { if (error.code !== "ENOENT" || i === 99) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).scope, "person");
  const scopedClose = await request("dedup-close", { confirm: true, jobId: scopedStarted.id });
  assert.equal(scopedClose.status, 200);
  const hiddenScoped = await scopedClose.json();
  assert.equal(hiddenScoped.dismissed, true);
  assert.equal(hiddenScoped.status, "completed");
  assert.deepEqual(hiddenScoped.results, scopedReport.results, "closing only hides the receipt, never deletes its source/merge evidence");
  assert.equal(JSON.parse(await readFile(path.join(data, "dedup-last-run.json"), "utf8")).dismissed, true);
  const launch = await request("dedup-all", { confirm: true });
  assert.equal(launch.status, 202);
  const started = await launch.json();
  assert.ok(started.id);
  assert.equal(started.dismissed, false, "another run is usable immediately after closing the previous result");
  assert.notEqual(started.id, scopedStarted.id);
  assert.equal((await request("dedup-close", { confirm: true, jobId: scopedStarted.id })).status, 409);
  let report;
  for (let i = 0; i < 100; i++) {
    report = await (await request("dedup-status")).json();
    if (report.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(report.status, "completed");
  assert.equal(report.merged, 0);
  assert.equal(report.scope, "all");
  assert.equal(report.personId, null);
  assert.equal(report.results.length, 2);
  assert.equal((await (await request("state")).json()).dedupStatus.id, started.id);
  assert.equal((await request("dedup-cancel", { path: "C:\\arbitrary" })).status, 400);
  for (const closeResults of [null, "true", 1, {}]) {
    assert.equal((await request("dedup-cancel", { confirm: true, closeResults })).status, 400);
  }
  assert.equal((await request("dedup-cancel", { confirm: true })).status, 202);
  assert.equal((await (await request("dedup-status")).json()).dismissed, false, "a plain cancel preserves its terminal receipt");
  const finishedStopClose = await request("dedup-cancel", { confirm: true, closeResults: true });
  assert.equal(finishedStopClose.status, 202);
  assert.equal((await finishedStopClose.json()).dismissed, true, "stop click arriving just after completion still closes its result");
  assert.equal((await (await request("dedup-status")).json()).dismissed, true);
  assert.equal(JSON.parse(await readFile(path.join(data, "dedup-last-run.json"), "utf8")).dismissed, true);
  for (const body of [{}, { confirm: false }, { confirm: true, path: "C:\\arbitrary" },
    { confirm: true, personId: other.id }, { confirm: true, forceHistory: true },
    { confirm: true, beforePostId: "client-selected-boundary" }]) {
    assert.equal((await request(`persons/${person.id}/recheck`, body)).status, 400);
  }
  assert.equal((await request(`persons/${person.id}/recheck`, { confirm: true }, "https://untrusted.example")).status, 403);
  assert.equal((await request("persons/unknown/recheck", { confirm: true })).status, 404);
  assert.deepEqual(await readFile(stateFile), stateBefore, "invalid recheck requests cannot rewrite bindings or persons");
  const rechecks = await Promise.all([
    request(`persons/${person.id}/recheck`, { confirm: true }),
    request(`persons/${person.id}/recheck`, { confirm: true }),
  ]);
  assert.deepEqual(rechecks.map((response) => response.status).sort(), [200, 202]);
  const recheckJobs = await Promise.all(rechecks.map((response) => response.json()));
  assert.equal(recheckJobs[0].id, recheckJobs[1].id, "simultaneous recheck clicks return the existing job instead of duplicating it");
  assert.equal(recheckJobs[0].personId, person.id);
  assert.equal(recheckJobs[0].forceHistory, true);
  let recheckReport;
  for (let i = 0; i < 100; i++) {
    recheckReport = await (await request(`sync-jobs/${recheckJobs[0].id}`)).json();
    if (!["queued", "running"].includes(recheckReport.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(recheckReport.status, "completed");
  assert.equal(recheckReport.counters.accounts, 0);
  assert.equal(recheckReport.counters.failed, 0);
  assert.deepEqual(await readFile(stateFile), stateBefore, "dedup must not rewrite bindings or state");
  assert.equal(JSON.parse(await readFile(path.join(data, "dedup-last-run.json"), "utf8")).status, "completed");
});
