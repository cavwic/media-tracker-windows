import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { acknowledgeLauncherReady } from "../lib/launcher-ready.mjs";

test("compiler acknowledgment is nonce bound and only writes its exact control file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "collector-ready-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "a".repeat(32);
  const filename = path.join(root, "startup-logs", `.ready-${token}.json`);
  const env = { MEDIA_TRACKER_READY_TOKEN: token, MEDIA_TRACKER_READY_FILE: filename, PRIVATE_COOKIE: "sentinel" };
  assert.equal(await acknowledgeLauncherReady(root, {}), false);
  assert.equal(await acknowledgeLauncherReady(root, env), true);
  assert.deepEqual(JSON.parse(await readFile(filename)), { schemaVersion: 1, token, ready: true });
  assert.equal(env.MEDIA_TRACKER_READY_FILE, undefined);
  assert.equal(env.MEDIA_TRACKER_READY_TOKEN, undefined);
  assert.equal(await acknowledgeLauncherReady(root, env), false);
  const controls = { MEDIA_TRACKER_READY_TOKEN: token, MEDIA_TRACKER_READY_FILE: filename };
  assert.equal(await acknowledgeLauncherReady(root, controls), true);
  await assert.rejects(acknowledgeLauncherReady(root, { ...controls, MEDIA_TRACKER_READY_TOKEN: "wrong", MEDIA_TRACKER_READY_FILE: filename }));
  await assert.rejects(acknowledgeLauncherReady(root, { ...controls, MEDIA_TRACKER_READY_TOKEN: token, MEDIA_TRACKER_READY_FILE: path.join(root, "state.json") }));
  await writeFile(filename, "{}");
  await assert.rejects(acknowledgeLauncherReady(root, { MEDIA_TRACKER_READY_TOKEN: token, MEDIA_TRACKER_READY_FILE: filename }), /does not match/);
});
