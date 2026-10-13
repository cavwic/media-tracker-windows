import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { sourceFingerprint, captureReleaseSource, assertUnchangedSource } from "../packaging/release-source.mjs";

const record = (source, hash = "a".repeat(64)) => ({ source, file: "app/" + source, bytes: 1, sha256: hash });
test("release source fingerprint is deterministic and rejects aliases or unsafe mappings", () => {
  assert.equal(sourceFingerprint([record("z"), record("a")]), sourceFingerprint([record("a"), record("z")]));
  assert.notEqual(sourceFingerprint([record("a")]), sourceFingerprint([record("a", "b".repeat(64))]));
  for (const source of ["../data", "public/../data", "C:/data", "/data", "public\\data", "public//data"]) {
    assert.throws(() => sourceFingerprint([record(source)]), /Invalid/);
  }
  assert.throws(() => sourceFingerprint([record("a"), record("a")]), /Duplicate/);
});

test("source snapshots fail on stale packaged bytes and changes during a build", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "collector-source-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public")); await writeFile(path.join(root, "public", "ui.js"), "latest interface");
  const mappings = [{ source: "public", file: "app/public" }];
  const before = await captureReleaseSource({ root, mappings });
  assert.equal(before.fileCount, 1); assert.match(before.latestModifiedAt, /^20/);
  const files = before.files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }));
  assertUnchangedSource(before, await captureReleaseSource({ root, mappings }), files);
  assert.throws(() => assertUnchangedSource(before, before, []), /does not match/);
  assert.throws(() => assertUnchangedSource(before, before, [{ ...files[0], sha256: "b".repeat(64) }]), /does not match/);
  await writeFile(path.join(root, "public", "ui.js"), "newer interface");
  const after = await captureReleaseSource({ root, mappings });
  assert.throws(() => assertUnchangedSource(before, after, files), /changed during packaging/);
});

test("source snapshots reject non-relative roots and mappings instead of reading arbitrary paths", async () => {
  await assert.rejects(captureReleaseSource({ root: ".", mappings: [] }), /absolute/);
  await assert.rejects(captureReleaseSource({ root: path.resolve("."), mappings: [{ source: "../data", file: "app/public" }] }), /Unsafe/);
});
