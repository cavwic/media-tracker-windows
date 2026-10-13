import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link } from "node:fs/promises";
import { HISTORICAL_RELEASE_NAMES, previewHistoricalReleaseCleanup, applyHistoricalReleaseCleanup } from "../packaging/clean-historical-releases.mjs";

const SOURCE_HASH = "a".repeat(64);
const OLD_DIRECTORY = HISTORICAL_RELEASE_NAMES[0];
const OLD_ZIP = "采集工具-标准版-0.1.1-20261009.zip";
const sha = (text) => createHash("sha256").update(text).digest("hex");

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "collector-cleanup-test-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const releaseRoot = path.join(projectRoot, "release");
  const verification = path.join(projectRoot, "packaging", "verification");
  await mkdir(releaseRoot); await mkdir(verification, { recursive: true });
  const verifiedReleases = [];
  const audits = [];
  for (const edition of ["standard", "minimal"]) {
    const directoryName = `MediaTracker-local-build-${edition}-0.1.2-1791539999000`;
    const zipName = `采集工具-${edition}-0.1.2.zip`;
    await mkdir(path.join(releaseRoot, directoryName));
    await writeFile(path.join(releaseRoot, directoryName, "fixture.txt"), edition);
    await writeFile(path.join(releaseRoot, zipName), "verified-" + edition);
    const auditReportPath = path.join(verification, `release-audit-${edition}.json`);
    const audit = { schemaVersion: 1, ok: true, edition, directoryName, zipName, sourceTreeSha256: SOURCE_HASH,
      zipSha256: sha("verified-" + edition), checks: { manifest: true, source: true, zip: true } };
    await writeFile(auditReportPath, JSON.stringify(audit));
    verifiedReleases.push({ edition, directoryName, zipName, auditReportPath }); audits.push(audit);
  }
  await mkdir(path.join(releaseRoot, OLD_DIRECTORY));
  await writeFile(path.join(releaseRoot, OLD_DIRECTORY, "old.txt"), "old release");
  await writeFile(path.join(releaseRoot, OLD_ZIP), "old ZIP");
  await mkdir(path.join(projectRoot, "data"));
  await writeFile(path.join(projectRoot, "data", "state.json"), '{"people":["do not touch"]}');
  await writeFile(path.join(releaseRoot, "unreviewed.zip"), "keep unknown item");
  const options = { projectRoot, historicalNames: [OLD_DIRECTORY, OLD_ZIP],
    preserveNames: verifiedReleases.flatMap((release) => [release.directoryName, release.zipName]), verifiedReleases };
  let calls = 0;
  const dependencies = { auditReleaseImpl: async ({ directory }) => { calls++; return structuredClone(audits.find((audit) => audit.directoryName === path.basename(directory))); },
    inspectProcessesImpl: async () => [], inspectReparsePointsImpl: async () => [] };
  return { projectRoot, releaseRoot, verification, options, dependencies, audits, auditCalls: () => calls };
}

test("cleanup preview re-audits both new releases and leaves every old artifact intact", async (t) => {
  const f = await fixture(t);
  const report = await previewHistoricalReleaseCleanup(f.options, f.dependencies);
  assert.equal(report.mode, "preview"); assert.equal(report.status, "ready"); assert.equal(f.auditCalls(), 2);
  assert.equal(report.totalBytes, Buffer.byteLength("old releaseold ZIP")); assert.equal(report.deletedCount, 0);
  assert.ok(report.targets.every((target) => /^[a-f0-9]{64}$/.test(target.sha256)));
  assert.equal(JSON.parse(await readFile(report.reportPath, "utf8")).releaseRoot, f.releaseRoot);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY)); assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

test("confirmed cleanup removes only reviewed direct children and writes a durable result", async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.projectRoot, "data", "state.json"), "utf8");
  const report = await applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies);
  assert.equal(report.status, "completed"); assert.equal(report.deletedCount, 2); assert.equal(report.deletedBytes, report.totalBytes);
  const remaining = await readdir(f.releaseRoot);
  assert.ok(f.options.preserveNames.every((name) => remaining.includes(name))); assert.ok(remaining.includes("unreviewed.zip"));
  assert.ok(!remaining.includes(OLD_DIRECTORY) && !remaining.includes(OLD_ZIP));
  assert.equal(await readFile(path.join(f.projectRoot, "data", "state.json"), "utf8"), before);
  assert.equal(JSON.parse(await readFile(report.reportPath, "utf8")).deletedCount, 2);
});

test("cleanup never deletes without explicit confirmation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(applyHistoricalReleaseCleanup(f.options, f.dependencies), /confirmed:true/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY)); assert.equal(f.auditCalls(), 0);
});

test("only the four specifically reviewed failed 0.1.2 candidate names are added to history", async (t) => {
  const f = await fixture(t);
  const candidateNames = ["MediaTracker-local-build-slim-0.1.2-1791540656322", "MediaTracker-local-build-minimal-0.1.2-1791540666443",
    "采集工具-标准版-0.1.2-未验收候选-20261009.zip", "采集工具-最小版-0.1.2-未验收候选-20261009.zip"];
  assert.ok(candidateNames.every((name) => HISTORICAL_RELEASE_NAMES.includes(name)));
  for (const name of candidateNames) {
    if (name.endsWith(".zip")) await writeFile(path.join(f.releaseRoot, name), "failed ZIP fixture");
    else { await mkdir(path.join(f.releaseRoot, name)); await writeFile(path.join(f.releaseRoot, name, "fixture.txt"), "failed candidate fixture"); }
  }
  const preview = await previewHistoricalReleaseCleanup({ ...f.options, historicalNames: candidateNames }, f.dependencies);
  assert.equal(preview.targets.length, 4); assert.equal(preview.deletedCount, 0);
  assert.ok(candidateNames.every((name) => preview.targets.some((target) => target.name === name && target.exists)));
  assert.ok(!HISTORICAL_RELEASE_NAMES.includes("采集工具-标准版-0.1.2-20261009.zip"));
  assert.ok(!HISTORICAL_RELEASE_NAMES.includes("采集工具-最小版-0.1.2-20261009.zip"));
});

for (const invalid of ["../data", "data", "MediaTracker-local-build-0.1.2-1791539999000", "D:\\private", OLD_DIRECTORY + "\\data", OLD_ZIP + " "]) {
  test("cleanup rejects unreviewed/traversal names: " + invalid, async (t) => {
    const f = await fixture(t);
    await assert.rejects(previewHistoricalReleaseCleanup({ ...f.options, historicalNames: [invalid] }, f.dependencies), /refused/);
    assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
  });
}

test("cleanup rejects overlapping preserve/delete lists", async (t) => {
  const f = await fixture(t);
  await assert.rejects(previewHistoricalReleaseCleanup({ ...f.options, preserveNames: [...f.options.preserveNames, OLD_ZIP] }, f.dependencies), /also preserved/);
});

test("reviewed ZIP names cannot be substituted with directories", async (t) => {
  const f = await fixture(t); await rm(path.join(f.releaseRoot, OLD_ZIP)); await mkdir(path.join(f.releaseRoot, OLD_ZIP));
  await assert.rejects(previewHistoricalReleaseCleanup(f.options, f.dependencies), /incorrect target type/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

test("cleanup requires both new editions and explicitly preserved directory/ZIP pairs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(previewHistoricalReleaseCleanup({ ...f.options, verifiedReleases: f.options.verifiedReleases.slice(0, 1) }, f.dependencies), /exactly one/);
  await assert.rejects(previewHistoricalReleaseCleanup({ ...f.options, preserveNames: f.options.preserveNames.slice(1) }, f.dependencies), /explicitly preserved/);
});

test("a saved partial audit is not enough to authorize cleanup", async (t) => {
  const f = await fixture(t);
  await writeFile(f.options.verifiedReleases[0].auditReportPath, JSON.stringify({ ...f.audits[0], checks: { manifest: true, source: true, zip: false } }));
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies), /complete successful/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
});

test("cleanup rechecks current source/ZIPs instead of trusting a saved successful audit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, { ...f.dependencies,
    auditReleaseImpl: async () => { throw new Error("current source integrity mismatch"); } }), /current source integrity/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
});

test("cleanup refuses changed ZIP bytes even when a mocked audit claims success", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.releaseRoot, f.options.verifiedReleases[0].zipName), "tampered");
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies), /changed after/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

test("both editions must come from the same current source snapshot", async (t) => {
  const f = await fixture(t);
  f.audits[1].sourceTreeSha256 = "b".repeat(64);
  await writeFile(f.options.verifiedReleases[1].auditReportPath, JSON.stringify(f.audits[1]));
  await assert.rejects(previewHistoricalReleaseCleanup(f.options, f.dependencies), /same source snapshot/);
});

test("audit reports cannot be read from arbitrary or public package locations", async (t) => {
  const f = await fixture(t);
  const options = structuredClone(f.options); options.verifiedReleases[0].auditReportPath = path.join(f.projectRoot, "data", "state.json");
  await assert.rejects(previewHistoricalReleaseCleanup(options, f.dependencies), /direct local verification/);
});

test("running process references block every deletion; no process is terminated", async (t) => {
  const f = await fixture(t);
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, { ...f.dependencies,
    inspectProcessesImpl: async () => [{ ProcessId: 12, Name: "node.exe", ExecutablePath: "C:\\node.exe", CommandLine: '"' + path.join(f.releaseRoot, OLD_DIRECTORY, "server.mjs") + '"' }] }), /running processes/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY)); assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

test("process inspection failures fail closed before deletion", async (t) => {
  const f = await fixture(t);
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, { ...f.dependencies,
    inspectProcessesImpl: async () => { throw new Error("CIM unavailable"); } }), /CIM unavailable/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

for (const privateName of ["state.json", "sync-index.json", "browser-profiles", "other-personal-file.json"]) {
  test("old release account/unknown data is protected: " + privateName, async (t) => {
    const f = await fixture(t);
    const directory = path.join(f.releaseRoot, OLD_DIRECTORY, "data"); await mkdir(directory);
    if (privateName === "browser-profiles") await mkdir(path.join(directory, privateName)); else await writeFile(path.join(directory, privateName), "private");
    await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies), /user data|account bindings/);
    assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
  });
}

test("only explicitly permitted app-shell profile and startup logs may accompany an old release", async (t) => {
  const f = await fixture(t);
  const data = path.join(f.releaseRoot, OLD_DIRECTORY, "data");
  await mkdir(path.join(data, "builtin-app-profile-v1"), { recursive: true }); await mkdir(path.join(data, "startup-logs"));
  await writeFile(path.join(data, "builtin-app-profile-v1", "Preferences"), "UI cache");
  await writeFile(path.join(data, "startup-logs", "fixture.err.log"), "test startup");
  const result = await applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies);
  assert.equal(result.deletedCount, 2);
});

test("linked historical release directory is rejected without traversing or deleting its destination", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.projectRoot, "outside"); await mkdir(outside); await writeFile(path.join(outside, "original.txt"), "preserve");
  await rm(path.join(f.releaseRoot, OLD_DIRECTORY), { recursive: true });
  await symlink(outside, path.join(f.releaseRoot, OLD_DIRECTORY), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies), /linked target/);
  assert.equal(await readFile(path.join(outside, "original.txt"), "utf8"), "preserve");
});

test("nested junctions/symlinks and hard-linked files are rejected", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.projectRoot, "outside"); await mkdir(outside); await writeFile(path.join(outside, "original.txt"), "preserve");
  const nested = path.join(f.releaseRoot, OLD_DIRECTORY, "nested");
  await symlink(outside, nested, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(previewHistoricalReleaseCleanup(f.options, f.dependencies), /linked inventory/);
  await rm(nested, { recursive: true });
  await link(path.join(outside, "original.txt"), path.join(f.releaseRoot, OLD_DIRECTORY, "linked.txt"));
  await assert.rejects(previewHistoricalReleaseCleanup(f.options, f.dependencies), /linked inventory/);
  assert.equal(await readFile(path.join(outside, "original.txt"), "utf8"), "preserve");
});

test("native Windows reparse inspection is mandatory and fail-closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(previewHistoricalReleaseCleanup(f.options, { ...f.dependencies,
    inspectReparsePointsImpl: async () => [path.join(f.releaseRoot, OLD_DIRECTORY)] }), /reparse points/);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
});

test("a process starting after initial inventory stops cleanup before deleting any target", async (t) => {
  const f = await fixture(t); let checks = 0;
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, { ...f.dependencies,
    inspectProcessesImpl: async () => ++checks === 1 ? [] : [{ ProcessId: 13, Name: "collector.exe", ExecutablePath: path.join(f.releaseRoot, OLD_DIRECTORY, "采集工具.exe") }] }), (error) => {
    assert.match(error.message, /process started/); assert.equal(error.cleanupReport.status, "stopped"); assert.equal(error.cleanupReport.deletedCount, 0); return true;
  });
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
});

test("missing reviewed historical artifacts are reported without deleting unrelated files", async (t) => {
  const f = await fixture(t); await rm(path.join(f.releaseRoot, OLD_ZIP));
  const result = await applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, f.dependencies);
  assert.equal(result.deletedCount, 1); assert.equal(result.targets.find((target) => target.name === OLD_ZIP).exists, false);
  assert.ok((await readdir(f.releaseRoot)).includes("unreviewed.zip"));
});

test("old release content changing after inventory stops deletion and records the failure", async (t) => {
  const f = await fixture(t); let inspections = 0;
  await assert.rejects(applyHistoricalReleaseCleanup({ ...f.options, confirmed: true }, { ...f.dependencies,
    inspectProcessesImpl: async () => {
      if (++inspections === 1) await writeFile(path.join(f.releaseRoot, OLD_DIRECTORY, "old.txt"), "changed while planning");
      return [];
    } }), (error) => {
    assert.match(error.message, /changed after inventory/); assert.equal(error.cleanupReport.deletedCount, 0);
    assert.equal(error.cleanupReport.status, "stopped"); return true;
  });
  assert.equal(await readFile(path.join(f.releaseRoot, OLD_DIRECTORY, "old.txt"), "utf8"), "changed while planning");
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_ZIP));
});

test("Windows native CIM and reparse scans work in an isolated non-mutating preview", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const report = await previewHistoricalReleaseCleanup(f.options, { auditReleaseImpl: f.dependencies.auditReleaseImpl });
  assert.equal(report.status, "ready"); assert.equal(report.deletedCount, 0);
  assert.ok((await readdir(f.releaseRoot)).includes(OLD_DIRECTORY));
});
