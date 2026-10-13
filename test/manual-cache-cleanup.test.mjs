import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { parseCleanupArgs, runCacheCleanup } from "../scripts/clean-browser-cache.mjs";

async function fixture(t) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "media-tracker-manual-cache-"));
  t.after(async () => {
    assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith("media-tracker-manual-cache-"));
    await rm(sandbox, { recursive: true, force: true });
  });
  const profilesRoot = path.join(sandbox, "browser-profiles");
  const profile = path.join(profilesRoot, "x", "fixture");
  const cache = path.join(profile, "Default", "Cache", "fixture");
  const cookie = path.join(profile, "Default", "Network", "Cookies");
  await mkdir(path.dirname(cache), { recursive: true });
  await mkdir(path.dirname(cookie), { recursive: true });
  await writeFile(cache, "cache"); await writeFile(cookie, "login-fixture");
  const logs = [];
  return { profilesRoot, cache, cookie, logs, write: (line) => logs.push(line),
    assertStopped: async () => {}, isRunning: async () => false };
}

test("manual CLI defaults to preview and rejects force flags, paths, and combined modes", () => {
  assert.equal(parseCleanupArgs([]), "preview");
  for (const mode of ["preview", "interactive", "apply", "help"]) assert.equal(parseCleanupArgs([`--${mode}`]), mode);
  for (const args of [["--force"], ["C:\\"], ["--apply", "--preview"], ["--apply", "--root", "/"]]) assert.throws(() => parseCleanupArgs(args));
});

test("manual preview is read-only and never invokes process checks or deletion", async (t) => {
  const setup = await fixture(t);
  const forbidden = async () => { assert.fail("Preview cannot invoke mutable or unnecessary operations"); };
  const result = await runCacheCleanup({ ...setup, clean: forbidden, isRunning: forbidden, assertStopped: forbidden });
  assert.equal(result.previewBytes, 5);
  assert.equal(result.removedBytes, 0);
  assert.equal(await readFile(setup.cache, "utf8"), "cache");
  assert.equal(await readFile(setup.cookie, "utf8"), "login-fixture");
});

test("interactive cancellation leaves every file intact", async (t) => {
  const setup = await fixture(t);
  const result = await runCacheCleanup({ ...setup, mode: "interactive", confirm: async () => false,
    clean: async () => { assert.fail("Cancelled deletion"); } });
  assert.equal(result.cancelled, true);
  assert.equal(await readFile(setup.cache, "utf8"), "cache");
});

test("explicit cleanup removes only synthetic cache and keeps synthetic login data", async (t) => {
  const setup = await fixture(t);
  const result = await runCacheCleanup({ ...setup, mode: "interactive", confirm: async () => true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.removedBytes, 5);
  assert.equal(result.removedFiles, 1);
  await assert.rejects(readFile(setup.cache), { code: "ENOENT" });
  assert.equal(await readFile(setup.cookie, "utf8"), "login-fixture");
});

test("active or uninspectable browsers are skipped without deletion", async (t) => {
  const setup = await fixture(t);
  for (const isRunning of [async () => true, async () => { throw new Error("query failed"); }]) {
    const result = await runCacheCleanup({ ...setup, mode: "apply", isRunning,
      clean: async () => { assert.fail("Active profile must not be deleted"); } });
    assert.equal(result.exitCode, 2);
    assert.equal(result.removedBytes, 0);
    assert.equal(await readFile(setup.cache, "utf8"), "cache");
  }
});

test("a running tool service or failed service check prevents all deletion", async (t) => {
  const setup = await fixture(t);
  const result = await runCacheCleanup({ ...setup, mode: "apply",
    assertStopped: async () => { throw new Error("fixture service is running"); },
    clean: async () => { assert.fail("Service still running"); } });
  assert.equal(result.stopped, true);
  assert.equal(result.exitCode, 2);
  assert.equal(await readFile(setup.cache, "utf8"), "cache");
});
