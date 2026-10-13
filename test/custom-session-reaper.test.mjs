import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupStaleCustomSessions, exportCustomSession } from "../lib/custom-sync.mjs";

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "owned-session-reaper-test-"));
  t.after(async () => {
    assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("owned-session-reaper-test-"));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const platform = { id: "custom-fixture", homepageUrl: "https://fixture.example/" };
  const profileDirectory = path.join(dataRoot, "browser-profiles", platform.id, "fixture-profile");
  await mkdir(profileDirectory, { recursive: true });
  const loginSentinel = path.join(profileDirectory, "login-sentinel");
  await writeFile(loginSentinel, "preserve-bound-login");
  const session = await exportCustomSession({ dataRoot, platform,
    linkedAccount: { platformId: platform.id, profileDirectory, loginStatus: "verified" },
    launchContext: async () => ({ close: async () => {}, cookies: async () => [
      { name: "session", value: "synthetic-cookie", domain: ".fixture.example", path: "/", secure: true, expires: -1 },
    ] }),
  });
  t.after(() => session.dispose().catch(() => {}));
  const directory = path.dirname(session.cookieFile);
  if (process.platform === "win32") {
    // Elevated Windows CI can assign Administrators as the default owner and
    // include extra explicit allow rules in a new directory's default DACL.
    // Model a fully private session without relaxing the production reaper.
    const encoded = Buffer.from(directory, "utf8").toString("base64");
    const command = "$ErrorActionPreference='Stop'; "
      + `$taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); `
      + "$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User; "
      + "$taskAcl=[Security.AccessControl.DirectorySecurity]::new(); $taskAcl.SetOwner($taskSid); "
      + "$taskAcl.SetAccessRuleProtection($true,$false); "
      + "$taskRule=[Security.AccessControl.FileSystemAccessRule]::new($taskSid, "
      + "[Security.AccessControl.FileSystemRights]::FullControl, "
      + "[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', "
      + "[Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); "
      + "$taskAcl.AddAccessRule($taskRule); "
      + "[IO.Directory]::SetAccessControl($taskPath,$taskAcl); $taskAcl=[IO.Directory]::GetAccessControl($taskPath); "
      + "$taskAllowed=@($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | "
      + "Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } | "
      + "ForEach-Object { $_.IdentityReference.Value }); "
      + "@{owner=$taskAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value; expectedOwner=$taskSid.Value; "
      + "protected=$taskAcl.AreAccessRulesProtected; allowed=$taskAllowed} | ConvertTo-Json -Compress";
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 10000 });
    const acl = JSON.parse(stdout);
    assert.equal(acl.owner, acl.expectedOwner, "fixture directory must be owned by the current user");
    assert.equal(acl.protected, true, "fixture directory must not inherit wider permissions");
    assert.ok(Array.isArray(acl.allowed) && acl.allowed.length > 0, "fixture must have explicit allow rules");
    assert.ok(acl.allowed.every((sid) => sid === acl.expectedOwner), `fixture allow rules must remain current-user-only: ${JSON.stringify(acl)}`);
  }
  const markerFile = path.join(directory, "owned-session.json");
  return { dataRoot, session, directory, markerFile, loginSentinel };
}

// A fresh module models the next application startup without a live-session
// set. Its installation ROOT is identical. Tests never use real credentials.
async function restartedReaper() {
  const module = await import(`../lib/custom-sync.mjs?reaper-fixture=${randomUUID()}`);
  return module.cleanupStaleCustomSessions;
}

test("normal session disposal removes cookies and marker without touching its login profile", async (t) => {
  const setup = await fixture(t);
  const marker = JSON.parse(await readFile(setup.markerFile, "utf8"));
  assert.equal(marker.kind, "media-tracker-custom-session");
  assert.equal(marker.pid, process.pid);
  assert.equal(JSON.stringify(marker).includes("synthetic-cookie"), false);
  await setup.session.dispose();
  await assert.rejects(access(setup.directory), { code: "ENOENT" });
  assert.equal(await readFile(setup.loginSentinel, "utf8"), "preserve-bound-login");
});

test("live and concurrently active session directories are never reaped", async (t) => {
  const setup = await fixture(t);
  assert.equal((await cleanupStaleCustomSessions({ dataRoot: setup.dataRoot, processAlive: () => false })).removed, 0);
  const reap = await restartedReaper();
  assert.equal((await reap({ dataRoot: setup.dataRoot })).removed, 0, "a PID that still exists is retained after restart");
  assert.match(await readFile(setup.session.cookieFile, "utf8"), /synthetic-cookie/);
});

test("dead-owner marked private sessions are removed, unknown and legacy contents are preserved", async (t) => {
  const setup = await fixture(t);
  const parent = path.join(setup.dataRoot, "source-sessions");
  const legacy = path.join(parent, "session-legacy");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "cookies.txt"), "unmanaged-legacy-sentinel");
  const reap = await restartedReaper();
  const summary = await reap({ dataRoot: setup.dataRoot, processAlive: () => false });
  assert.equal(summary.removed, 1, JSON.stringify(summary));
  assert.equal(summary.unmanaged, 1);
  await assert.rejects(access(setup.directory), { code: "ENOENT" });
  assert.equal(await readFile(path.join(legacy, "cookies.txt"), "utf8"), "unmanaged-legacy-sentinel");
  assert.equal(await readFile(setup.loginSentinel, "utf8"), "preserve-bound-login");
});

test("foreign installation marker or unknown files prevent any credential deletion", async (t) => {
  const setup = await fixture(t);
  const reap = await restartedReaper();
  const marker = JSON.parse(await readFile(setup.markerFile, "utf8"));
  await writeFile(setup.markerFile, JSON.stringify({ ...marker, installationRoot: "foreign-installation" }));
  assert.equal((await reap({ dataRoot: setup.dataRoot, processAlive: () => false })).removed, 0);
  await writeFile(setup.markerFile, JSON.stringify(marker));
  await writeFile(path.join(setup.directory, "not-owned.txt"), "preserve-this-file");
  assert.equal((await reap({ dataRoot: setup.dataRoot, processAlive: () => false })).removed, 0);
  assert.match(await readFile(setup.session.cookieFile, "utf8"), /synthetic-cookie/);
  assert.equal(await readFile(path.join(setup.directory, "not-owned.txt"), "utf8"), "preserve-this-file");
});

test("reaper never follows cookie symlinks", async (t) => {
  const setup = await fixture(t);
  const outside = path.join(setup.dataRoot, "outside-sentinel.txt");
  await writeFile(outside, "preserve-outside");
  await rm(setup.session.cookieFile);
  try { await symlink(outside, setup.session.cookieFile, "file"); }
  catch (error) { if (error.code === "EPERM") { t.skip("File symlink permission unavailable"); return; } throw error; }
  const reap = await restartedReaper();
  assert.equal((await reap({ dataRoot: setup.dataRoot, processAlive: () => false })).removed, 0);
  assert.equal(await readFile(outside, "utf8"), "preserve-outside");
});

test("reaper rejects a source-sessions directory junction without touching its target", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "owned-session-reaper-junction-"));
  t.after(async () => {
    assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("owned-session-reaper-junction-"));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const outside = path.join(dataRoot, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "cookies.txt"), "preserve-junction-target");
  await symlink(outside, path.join(dataRoot, "source-sessions"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(cleanupStaleCustomSessions({ dataRoot, processAlive: () => false }), { code: "profile-invalid" });
  assert.equal(await readFile(path.join(outside, "cookies.txt"), "utf8"), "preserve-junction-target");
});

test("reaper does not delete a credential directory with widened Windows permissions", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t);
  assert.equal(path.dirname(setup.directory), path.join(setup.dataRoot, "source-sessions"));
  await promisify(execFile)("icacls.exe", [setup.directory, "/grant", "*S-1-1-0:(OI)(CI)F"], { windowsHide: true, timeout: 10000 });
  const reap = await restartedReaper();
  const summary = await reap({ dataRoot: setup.dataRoot, processAlive: () => false });
  assert.equal(summary.removed, 0);
  assert.deepEqual(summary.retainedReasons, ["not-private-directory"]);
  assert.match(await readFile(setup.session.cookieFile, "utf8"), /synthetic-cookie/);
});
