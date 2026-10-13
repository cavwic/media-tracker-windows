import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deadline(promise, message, ms = 10_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function put(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
  return filename;
}

async function port() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unlinked-profile-api-"));
  const data = path.join(root, "data");
  const profilesRoot = path.join(data, "browser-profiles");
  const profilePaths = {
    linked: path.join(profilesRoot, "x", "linked-current"),
    old: path.join(profilesRoot, "instagram", "old-history"),
    sameX: path.join(profilesRoot, "x", "same-id"),
    sameInstagram: path.join(profilesRoot, "instagram", "same-id"),
  };
  const protectedFiles = new Map();
  const historyFiles = new Map();
  for (const [label, profile] of Object.entries(profilePaths)) {
    for (const [relative, content] of [["Default/Cache/cache", `cache-${label}`], ["Default/Network/Cookies", `synthetic-cookies-${label}`],
      ["Default/Local Storage/leveldb/login", `synthetic-site-data-${label}`], ["Preferences", `synthetic-preferences-${label}`]]) {
      const filename = await put(path.join(profile, ...relative.split("/")), content);
      (label === "linked" ? protectedFiles : historyFiles).set(filename, content);
    }
  }
  const stateFile = path.join(data, "state.json");
  const state = { version: 4, settings: { theme: "dark" }, persons: [], customPlatforms: [], recentPaths: [],
    linkedAccounts: [{ id: "current-login", platformId: "x", label: "Current synthetic account", profileDirectory: profilePaths.linked,
      loginStatus: "verified", createdAt: "2026-01-01T00:00:00Z" }] };
  const stateBytes = JSON.stringify(state);
  await put(stateFile, stateBytes);
  const indexFile = path.join(data, "sync-index.json");
  const indexBytes = '{"version":3,"layout":"person-v1","scopes":{},"summaries":{},"receipts":{},"storageInitialized":{}}';
  await put(indexFile, indexBytes);
  const mediaFile = await put(path.join(root, "People", "Person", "Image", "sentinel.jpg"), "Downloaded media must remain.");
  const archiveIndex = await put(path.join(root, "People", "Person", "Index", "assets.json"), "Person provenance must remain.");
  const appProfile = await put(path.join(data, "builtin-app-profile-v1", "Default", "Cookies"), "Private app profile must remain.");
  for (const [filename, bytes] of [[indexFile, indexBytes], [mediaFile, "Downloaded media must remain."],
    [archiveIndex, "Person provenance must remain."], [appProfile, "Private app profile must remain."]]) protectedFiles.set(filename, bytes);
  const available = await port();
  const origin = `http://127.0.0.1:${available}`;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(import.meta.dirname, "helpers", "unlinked-profile-process-fixture.mjs")).href,
    path.join(ROOT, "server.mjs")], { cwd: ROOT,
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(available), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await fetch(`${origin}/api/runtime/exit`, { method: "POST", headers, body: '{"confirm":true}', signal: AbortSignal.timeout(2_000) });
        await deadline(exited, "Fixture service did not exit", 5_000);
      } catch {
        // This exact child belongs only to a temporary fixture, never production.
        child.kill();
        await deadline(exited.catch(() => {}), "Fixture child cleanup failed", 5_000);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  await deadline((async () => {
    while (!output.includes("Media Tracker 已启动：")) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture stopped: ${errors}`);
      await pause(10);
    }
  })(), "Fixture service startup timed out");
  const preview = async () => {
    const response = await fetch(`${origin}/api/cache/preview`, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const remove = (body, originHeader = origin) => fetch(`${origin}/api/cache/remove-unlinked-profiles`, {
    method: "POST", headers: { ...headers, Origin: originHeader }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const preserved = async ({ keepState = true } = {}) => {
    if (keepState) assert.equal(await readFile(stateFile, "utf8"), stateBytes);
    for (const [filename, bytes] of protectedFiles) assert.equal(await readFile(filename, "utf8"), bytes);
  };
  return { root, data, profilesRoot, profilePaths, state, stateFile, stateBytes, historyFiles, protectedFiles,
    origin, headers, preview, remove, preserved, diagnostics: () => errors };
}

const find = (report, platformId, profileId) => report.profiles.find((profile) => profile.platformId === platformId && profile.profileId === profileId);

test("selected unlinked profile removal deletes its entire old session without touching current bindings, other platforms, media or indexes", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Full profile deletion fails closed without Windows process inspection"); return; }
  const setup = await fixture(t);
  const preview = await setup.preview();
  const linked = find(preview, "x", "linked-current");
  const old = find(preview, "instagram", "old-history");
  const sameX = find(preview, "x", "same-id");
  const sameInstagram = find(preview, "instagram", "same-id");
  assert.equal(linked.removable, false);
  assert.equal(linked.removalId, null);
  assert.equal(old.removable, true, `${JSON.stringify(old)}\n${setup.diagnostics()}`);
  assert.match(old.removalId, /^[0-9a-f-]{36}$/i);
  assert.equal(old.profileFiles, 4);
  assert.ok(old.profileBytes > old.bytes, "confirmation must distinguish whole profile size from cache-only size");
  assert.notEqual(sameX.removalId, sameInstagram.removalId, "same basename on two platforms cannot share a removal target");
  assert.ok(!JSON.stringify(preview).includes(setup.root), "preview does not expose server-owned profile paths");
  await setup.preserved();
  const response = await setup.remove({ confirm: true, profileIds: [old.removalId, sameX.removalId] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.removedProfiles, 2, `${JSON.stringify(result)}\n${setup.diagnostics()}`);
  assert.equal(result.status, "removed");
  await assert.rejects(stat(setup.profilePaths.old), { code: "ENOENT" });
  await assert.rejects(stat(setup.profilePaths.sameX), { code: "ENOENT" });
  assert.equal(await readFile(path.join(setup.profilePaths.sameInstagram, "Default", "Network", "Cookies"), "utf8"), "synthetic-cookies-sameInstagram");
  await setup.preserved();
});

test("whole-profile removal rejects malformed confirmation, foreign origin, caller paths and unknown identifiers without deleting any profile", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows-only process inspection"); return; }
  const setup = await fixture(t);
  const preview = await setup.preview();
  const id = find(preview, "instagram", "old-history").removalId;
  assert.ok(id);
  for (const body of [null, [], {}, { confirm: false, profileIds: [id] }, { confirm: "true", profileIds: [id] },
    { confirm: true, profileIds: [] }, { confirm: true, profileIds: id }, { confirm: true, profileIds: [setup.profilePaths.old] },
    { confirm: true, profileIds: [id, id.toUpperCase()] }, { confirm: true, profileIds: [id], platformId: "instagram" },
    { confirm: true, profileIds: [id], path: setup.root }, { confirm: true, profileIds: [id], profilesRoot: setup.profilesRoot }]) {
    assert.equal((await setup.remove(body)).status, 400, JSON.stringify(body));
  }
  const unknown = await setup.remove({ confirm: true, profileIds: [id, "00000000-0000-4000-8000-000000000000"] });
  assert.ok([400, 409].includes(unknown.status));
  const queryPath = await fetch(`${setup.origin}/api/cache/remove-unlinked-profiles?path=${encodeURIComponent(setup.profilePaths.old)}`, {
    method: "POST", headers: setup.headers, body: JSON.stringify({ confirm: true, profileIds: [id] }),
  });
  assert.equal(queryPath.status, 400);
  assert.equal((await setup.remove({ confirm: true, profileIds: [id] }, "https://unrelated.invalid")).status, 403);
  for (const [filename, bytes] of setup.historyFiles) assert.equal(await readFile(filename, "utf8"), bytes);
  await setup.preserved();
});

test("a stale preview identifier cannot delete a profile that is now referenced by a current binding alias", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows-only process inspection"); return; }
  const setup = await fixture(t);
  const preview = await setup.preview();
  const id = find(preview, "instagram", "old-history").removalId;
  const updated = structuredClone(setup.state);
  updated.linkedAccounts.push({ id: "new-alias-reference", platformId: "instagram", label: "Synthetic reattached account",
    profileDirectory: `${setup.profilePaths.old}${path.sep}.${path.sep}`, loginStatus: "verified" });
  // Simulate a configuration imported after preview. It is written only inside
  // this fixture; the API must re-read ownership, not trust prior eligibility.
  await writeFile(setup.stateFile, JSON.stringify(updated));
  const response = await setup.remove({ confirm: true, profileIds: [id] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.removedProfiles, 0);
  assert.equal(result.skippedProfiles, 1);
  assert.equal(result.profiles[0].reason, "linked-profile");
  assert.equal(await readFile(path.join(setup.profilePaths.old, "Default", "Network", "Cookies"), "utf8"), "synthetic-cookies-old");
  assert.deepEqual(JSON.parse(await readFile(setup.stateFile, "utf8")), updated);
  await setup.preserved({ keepState: false });
});

test("profile removal waits behind an unfinished new-binding state mutation, rather than racing configuration writes", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows-only process inspection"); return; }
  const setup = await fixture(t);
  const preview = await setup.preview();
  const id = find(preview, "instagram", "old-history").removalId;
  const session = await (await fetch(`${setup.origin}/api/session`)).json();
  const pending = http.request(`${setup.origin}/api/linked-accounts`, { method: "POST", headers: {
    ...setup.headers, "X-Media-Tracker-Token": session.token, Expect: "100-continue" } });
  t.after(() => pending.destroy());
  const accepted = new Promise((resolve, reject) => { pending.once("continue", resolve); pending.once("error", reject); });
  const bindingResponse = new Promise((resolve, reject) => {
    pending.once("error", reject);
    pending.once("response", (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, body }));
    });
  });
  bindingResponse.catch(() => {});
  pending.flushHeaders();
  await deadline(accepted, "Fixture binding request was not accepted");
  pending.write('{"platformId":"x","label":"');
  let deletionSettled = false;
  const deletion = setup.remove({ confirm: true, profileIds: [id] }).then((response) => { deletionSettled = true; return response; });
  await pause(150);
  assert.equal(deletionSettled, false, "the destructive route must use the shared stateMutationQueue");
  assert.equal((await stat(setup.profilePaths.old)).isDirectory(), true);
  pending.end('new synthetic binding"}');
  const binding = await deadline(bindingResponse, "Fixture binding did not finish");
  assert.equal(binding.status, 201);
  const response = await deletion;
  assert.equal(response.status, 200);
  const removalReport = await response.json();
  assert.equal(removalReport.removedProfiles, 1, `${JSON.stringify(removalReport)}\n${setup.diagnostics()}`);
  await assert.rejects(stat(setup.profilePaths.old), { code: "ENOENT" });
  const finalState = JSON.parse(await readFile(setup.stateFile, "utf8"));
  assert.equal(finalState.linkedAccounts.length, 2);
  assert.ok(finalState.linkedAccounts.some((account) => account.id === "current-login"));
  assert.ok(finalState.linkedAccounts.some((account) => account.label === "new synthetic binding"));
  await setup.preserved({ keepState: false });
});

test("whole-profile preview and deletion refuse a nested junction without modifying its outside target", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows-only process inspection"); return; }
  const setup = await fixture(t);
  const outside = path.join(setup.root, "outside-profile-root");
  const sentinel = await put(path.join(outside, "never-delete.txt"), "Outside junction data must remain.");
  const unsafe = path.join(setup.profilesRoot, "x", "unsafe-history");
  await put(path.join(unsafe, "Default", "Network", "Cookies"), "Unsafe history credentials must remain.");
  await symlink(outside, path.join(unsafe, "Default", "outside-link"), "junction");
  const preview = await setup.preview();
  const entry = find(preview, "x", "unsafe-history");
  assert.equal(entry.removable, false);
  if (entry.removalId) {
    const response = await setup.remove({ confirm: true, profileIds: [entry.removalId] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).removedProfiles, 0);
  }
  assert.equal(await readFile(sentinel, "utf8"), "Outside junction data must remain.");
  assert.equal(await readFile(path.join(unsafe, "Default", "Network", "Cookies"), "utf8"), "Unsafe history credentials must remain.");
  await setup.preserved();
});
