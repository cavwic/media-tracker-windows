import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ProfileMaintenance } from "../lib/profile-maintenance.mjs";

const profilesRoot = path.resolve("fixture-browser-profiles");
const profile = path.join(profilesRoot, "x", "fixture-account");
const options = { linkedAccount: { profileDirectory: profile }, platformId: "x" };
function fixture(overrides = {}) {
  const calls = [];
  const maintenance = new ProfileMaintenance({ profilesRoot,
    listProfiles: async () => [profile], isRunning: async () => false,
    clean: async (input) => { calls.push(input); return { status: "cleaned", removedBytes: 123 }; },
    ...overrides });
  return { maintenance, calls };
}

test("an idle owned profile is cleaned; no account uses no profile", async () => {
  const { maintenance, calls } = fixture();
  assert.equal((await maintenance.cleanupAccount(options)).status, "cleaned");
  assert.deepEqual(calls, [{ profilesRoot, profilePath: profile }]);
  assert.equal((await maintenance.cleanupAccount({})).reason, "no-profile");
});

test("active browser or failed process inspection cannot delete cache", async () => {
  for (const isRunning of [async () => true, async () => { throw new Error("query failed"); }]) {
    const { maintenance, calls } = fixture({ isRunning });
    assert.equal((await maintenance.cleanupAccount(options)).status, "skipped");
    assert.equal(calls.length, 0);
  }
});

test("unknown profile or mismatched platform is rejected before browser retirement", async () => {
  let retired = false;
  const { maintenance, calls } = fixture({ idleTikTok: async () => { retired = true; } });
  assert.equal((await maintenance.cleanupAccount({ ...options, platformId: "tiktok" })).reason, "unsafe-profile");
  assert.equal((await maintenance.cleanupAccount({ ...options, linkedAccount: { profileDirectory: path.resolve("outside") } })).reason, "unsafe-profile");
  assert.equal(retired, false);
  assert.equal(calls.length, 0);
});

test("login and maintenance are mutually exclusive until their promises settle", async () => {
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const { maintenance, calls } = fixture({ clean: async () => { entered(); await wait; return { status: "empty" }; } });
  const cleaning = maintenance.cleanupAccount(options);
  await ready;
  await assert.rejects(maintenance.withProfileUse(profile, async () => {}), (error) => error.status === 409);
  assert.equal((await maintenance.cleanupAccount(options)).reason, "profile-busy");
  release(); await cleaning;
  await maintenance.withProfileUse(profile, async () => {
    assert.equal((await maintenance.cleanupAccount(options)).reason, "profile-busy");
  });
  assert.equal(calls.length, 0);
  await assert.rejects(maintenance.withProfileUse(profile, async () => { throw new Error("login failed"); }));
  assert.equal(maintenance.busy.size, 0);
});

test("TikTok closes only an idle dedicated worker before the final occupancy check", async () => {
  const tiktokProfile = path.join(profilesRoot, "tiktok", "fixture-account");
  const sequence = [];
  const { maintenance } = fixture({
    listProfiles: async () => [tiktokProfile],
    idleTikTok: async (received, callback) => { assert.equal(received, tiktokProfile); sequence.push("retire"); return callback(); },
    isRunning: async () => { sequence.push("inspect"); return false; },
    clean: async () => { sequence.push("delete"); return { status: "empty" }; },
  });
  await maintenance.cleanupAccount({ linkedAccount: { profileDirectory: tiktokProfile }, platformId: "tiktok" });
  assert.deepEqual(sequence, ["retire", "inspect", "delete"]);
});
