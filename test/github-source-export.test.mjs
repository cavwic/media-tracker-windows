import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { permittedSourcePath, inspectSourceText, auditGitHubSource, exportGitHubSource } from "../packaging/export-github-source.mjs";

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-public-source-"));
  t.after(async () => { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await rm(temporary, { recursive: true, force: true }); });
  const root = path.join(temporary, "source");
  await mkdir(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "media-tracker-public", version: "1.2.0", license: "MIT" }));
  await mkdir(path.join(root, "lib"));
  await writeFile(path.join(root, "lib", "example.mjs"), 'export const valid = true;\n');
  await mkdir(path.join(root, "test"));
  const output = path.join(temporary, "publication");
  return { root, output, temporary };
}

test("source whitelist rejects credentials, runtime, logs, history and live probes", () => {
  for (const file of ["data/state.json", "node_modules/a.js", "runtime/node/node.exe", "packaging/.cache/cache.zip",
    "packaging/verification/receipt.json", "release/history/old.zip", "scripts/probe-meta.mjs", "scripts/verify-ui.mjs",
    "test/fixture.log", "test/../data/state.json", "lib/link.exe", "lib/data/state.json"]) assert.equal(permittedSourcePath(file), false, file);
  for (const file of ["LICENSE", "README.md", "lib/example.mjs", "test/example.test.mjs", "public/styles.css",
    "packaging/local-compile/Launcher.cs", ".github/workflows/windows.yml", "scripts/publish-github.mjs"]) assert.equal(permittedSourcePath(file), true, file);
});

test("publication scanner catches real key/token/path formats without rejecting synthetic checks", () => {
  assert.deepEqual(inspectSourceText("-----BEGIN PRIVATE KEY-----"), ["private-key"]);
  assert.deepEqual(inspectSourceText("ghp_" + "x".repeat(35)), ["credential-token"]);
  assert.deepEqual(inspectSourceText("C:" + "\\Users\\PrivateOwner\\data"), ["private-workspace-path"]);
  assert.deepEqual(inspectSourceText("const token = 'a'.repeat(64);"), []);
});

test("export sanitizes private test samples and never copies excluded state", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "data"));
  await writeFile(path.join(f.root, "data", "state.json"), "private account state");
  await writeFile(path.join(f.root, "test", "sample.test.mjs"), 'const account = "private_creator"; const upper = "PRIVATE_CREATOR";\n');
  const redactions = [{ original: "private_creator", replacement: "example_creator" }];
  const result = await exportGitHubSource({ ...f, redactions });
  assert.equal(result.ok, true);
  assert.equal(result.sourceDataIncluded, false);
  assert.equal(result.anonymizedFixtureFiles, 1);
  assert.equal(result.files.some((file) => file.file.startsWith("data/")), false);
  assert.match(await readFile(path.join(f.output, "test", "sample.test.mjs"), "utf8"), /example_creator/);
  assert.equal((await auditGitHubSource({ directory: f.output, redactions })).fingerprint, result.fingerprint);
  await assert.rejects(exportGitHubSource({ ...f, redactions }), { code: "EEXIST" });
});

test("export rejects private identifiers outside tests before creating output", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "lib", "example.mjs"), 'const account = "private_creator";');
  await assert.rejects(exportGitHubSource({ ...f, redactions: [{ original: "private_creator", replacement: "example_creator" }] }), /privacy scan failed before writing/);
  await assert.rejects(readFile(path.join(f.output, "package.json")), { code: "ENOENT" });
});

test("exported audit rejects extras even if ignored by Git", async (t) => {
  const f = await fixture(t);
  await exportGitHubSource(f);
  await mkdir(path.join(f.output, "data"));
  await writeFile(path.join(f.output, "data", "state.json"), "must never publish");
  await assert.rejects(auditGitHubSource({ directory: f.output }), /unallowlisted/);
});

test("output cannot overwrite the source tree or recursively copy itself", async (t) => {
  const f = await fixture(t);
  await assert.rejects(exportGitHubSource({ root: f.root, output: f.root }), /fresh absolute/);
  await assert.rejects(exportGitHubSource({ root: f.root, output: path.join(f.root, "lib", "export") }), /mapped source/);
});

test("private original project cannot be exported as public even with an empty fixture", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "media-tracker", license: "MIT" }));
  await assert.rejects(exportGitHubSource(f), /independent MIT public source/);
  await assert.rejects(readFile(path.join(f.output, "package.json")), { code: "ENOENT" });
});
