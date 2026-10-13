import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, link, unlink, symlink, rename } from "node:fs/promises";
import { parseReleaseZipName, previewHistoricalReleaseArchive, applyHistoricalReleaseArchive } from "../packaging/archive-historical-releases.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const SOURCE = "a".repeat(64);
const exclusiveMove = async (source, destination) => { await link(source, destination); await unlink(source); };

async function fixture(t, { namedNew = false, namedOld = false, offlineNew = false, offlineOld = false, publicMinimal = false } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "collector-history-test-")); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const releaseRoot = path.join(projectRoot, "release"); const verification = path.join(projectRoot, "packaging", "verification");
  await mkdir(releaseRoot); await mkdir(verification, { recursive: true });
  const verifiedReleases = []; const historicalReleases = []; const audits = new Map();
  if (publicMinimal) await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "media-tracker-public", license: "MIT" }));
  for (const edition of publicMinimal ? ["minimal"] : ["standard", "minimal"]) {
    for (const old of [false, true]) {
      const label = edition === "minimal" ? "最小版" : (old ? offlineOld : offlineNew) ? "离线版" : "标准版";
      const version = old ? namedOld ? "0.1.0" : "0.1.2" : "1.0.0";
      const named = old ? namedOld : namedNew;
      const versionLabel = "V" + version.split(".").slice(0, 2).join(".");
      const directoryName = named ? `采集工具-${publicMinimal ? "公开版-" : ""}${label}-${versionLabel}`
        : `MediaTracker-local-build-${edition === "standard" ? "slim" : "minimal"}-${version}-1791549999000`;
      const zipName = `采集工具-${publicMinimal ? "公开版-" : ""}${label}-${old && !namedOld ? "0.1.2-20261009" : versionLabel}.zip`;
      const directory = path.join(releaseRoot, directoryName); await mkdir(directory);
      await writeFile(path.join(directory, "release-manifest.json"), JSON.stringify({ version, edition,
        distribution: label === "离线版" ? "offline-full" : label === "最小版" ? "online-minimal" : "online-slim" }));
      await writeFile(path.join(directory, "original.txt"), "never move build directories");
      await writeFile(path.join(releaseRoot, zipName), zipName);
      const audit = { schemaVersion: 1, ok: true, edition, directoryName, zipName, buildId: directoryName,
        sourceTreeSha256: old ? "b".repeat(64) : SOURCE, zipSha256: hash(zipName), checks: { manifest: true, source: !old, zip: true } };
      audits.set(zipName, audit);
      if (old) historicalReleases.push({ zipName, directoryName });
      else {
        const auditReportPath = path.join(verification, edition + "-audit.json"); const smokeReportPath = path.join(verification, edition + "-smoke.json");
        await writeFile(auditReportPath, JSON.stringify(audit));
        await writeFile(smokeReportPath, JSON.stringify({ source: directoryName, edition, buildId: audit.buildId, sourceFingerprint: SOURCE,
          zipSha256: audit.zipSha256, compiled: true, cleaned: true, standaloneEnvironment: true, runtimePrepared: true,
          windowStarted: true, repeatLaunch: true, fullExit: true, sourceVerified: true, privateDataIncluded: false, nodeBootstrapVerified: edition === "minimal" }));
        verifiedReleases.push({ edition, directoryName, zipName, auditReportPath, smokeReportPath });
      }
    }
  }
  await mkdir(path.join(projectRoot, "data")); await writeFile(path.join(projectRoot, "data", "state.json"), "do not touch bindings");
  const options = { projectRoot, historicalNames: historicalReleases.map((entry) => entry.zipName), historicalReleases,
    preserveNames: verifiedReleases.flatMap((entry) => [entry.directoryName, entry.zipName]), verifiedReleases, ...(publicMinimal ? { publicMinimalOnly: true } : {}) };
  const calls = [];
  const dependencies = { auditReleaseImpl: async (arguments_) => { calls.push(arguments_); return structuredClone(audits.get(path.basename(arguments_.zip))); },
    inspectProcessesImpl: async () => [], inspectReparsePointsImpl: async () => [], moveFileImpl: exclusiveMove };
  return { projectRoot, releaseRoot, verification, options, dependencies, audits, calls, history: path.join(releaseRoot, "history") };
}

test("preview verifies old and new ZIPs and creates no history directory", async (t) => {
  const f = await fixture(t); const report = await previewHistoricalReleaseArchive(f.options, f.dependencies);
  assert.equal(report.status, "ready"); assert.equal(report.archivedCount, 0); assert.equal(f.calls.length, 4);
  assert.equal(f.calls.filter((entry) => entry.sourceRoot === f.projectRoot).length, 2);
  await assert.rejects(lstat(f.history), { code: "ENOENT" });
  assert.ok(f.options.historicalNames.every((name) => report.targets.find((target) => target.name === name)));
});

test("confirmed archive preserves all build directories, new ZIPs and original account data", async (t) => {
  const f = await fixture(t); const report = await applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies);
  assert.equal(report.status, "completed"); assert.equal(report.archivedCount, 2);
  const rootNames = await readdir(f.releaseRoot); const historyNames = await readdir(f.history);
  assert.ok(f.options.historicalNames.every((name) => historyNames.includes(name) && !rootNames.includes(name)));
  assert.ok(f.options.preserveNames.every((name) => rootNames.includes(name)));
  assert.ok(f.options.historicalReleases.every((entry) => rootNames.includes(entry.directoryName)));
  assert.equal(await readFile(path.join(f.projectRoot, "data", "state.json"), "utf8"), "do not touch bindings");
  assert.equal(JSON.parse(await readFile(report.reportPath, "utf8")).archivedCount, 2);
});

test("archive requires explicit confirmation", async (t) => {
  const f = await fixture(t); await assert.rejects(applyHistoricalReleaseArchive(f.options, f.dependencies), /confirmed:true/);
  await assert.rejects(lstat(f.history), { code: "ENOENT" });
});

test("independent public minimal history archives one verified release without touching private editions", async (t) => {
  const f = await fixture(t, { publicMinimal: true, namedNew: true, namedOld: true });
  assert.deepEqual(parseReleaseZipName("采集工具-公开版-最小版-V1.2.zip"), { edition: "minimal", version: "1.2.0" });
  const preview = await previewHistoricalReleaseArchive(f.options, f.dependencies);
  assert.equal(preview.newReleases.length, 1);
  assert.equal(preview.targets.length, 1);
  const result = await applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies);
  assert.equal(result.archivedCount, 1);
  assert.equal(await readFile(path.join(f.projectRoot, "data", "state.json"), "utf8"), "do not touch bindings");
});

test("public-only archive requires independent MIT project metadata", async (t) => {
  const f = await fixture(t, { publicMinimal: true, namedNew: true, namedOld: true });
  await writeFile(path.join(f.projectRoot, "package.json"), JSON.stringify({ name: "media-tracker", license: "MIT" }));
  await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /public minimal release/);
  await assert.rejects(lstat(f.history), { code: "ENOENT" });
});

test("future no-date minor/major ZIP names remain usable with matching internal versions", () => {
  assert.deepEqual(parseReleaseZipName("采集工具-标准版-V1.1.zip"), { edition: "standard", version: "1.1.0" });
  assert.deepEqual(parseReleaseZipName("采集工具-最小版-V2.0.zip"), { edition: "minimal", version: "2.0.0" });
});

test("Chinese no-date standard/minimal/offline directories pass precisely matching manifest gates", async (t) => {
  assert.deepEqual(parseReleaseZipName("采集工具-离线版-V1.0.zip"), { edition: "standard", version: "1.0.0" });
  for (const offlineNew of [false, true]) {
    const f = await fixture(t, { namedNew: true, namedOld: true, offlineNew, offlineOld: true });
    const report = await applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies);
    assert.equal(report.status, "completed"); assert.equal(report.archivedCount, 2);
    assert.ok(f.options.preserveNames.every((name) => report.preserveNames.includes(name)));
    for (const entry of f.options.historicalReleases) {
      assert.equal(await readFile(path.join(f.history, entry.zipName), "utf8"), entry.zipName);
      assert.equal(await readFile(path.join(f.releaseRoot, entry.directoryName, "original.txt"), "utf8"), "never move build directories");
    }
    assert.equal(await readFile(path.join(f.projectRoot, "data", "state.json"), "utf8"), "do not touch bindings");
  }
});

test("Chinese directory labels reject version/edition/distribution mismatches and malformed aliases", async (t) => {
  for (const change of [{ version: "9.9.0" }, { edition: "minimal" }, { distribution: "offline-full" }]) {
    const f = await fixture(t, { namedNew: true }); const entry = f.options.verifiedReleases[0];
    const filename = path.join(f.releaseRoot, entry.directoryName, "release-manifest.json");
    const original = JSON.parse(await readFile(filename, "utf8"));
    await writeFile(filename, JSON.stringify({ ...original, ...change }));
    await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /does not match/);
    await assert.rejects(lstat(f.history), { code: "ENOENT" });
  }
  for (const directoryName of ["采集工具-标准版-V9.9", "采集工具-离线版-V1.0",
    "采集工具-标准版-V01.0", "采集工具-标准版-V1.0-20261010", "采集工具-标准版-V1.0-copy"]) {
    const f = await fixture(t, { namedNew: true }); const entry = f.options.verifiedReleases[0];
    await rename(path.join(f.releaseRoot, entry.directoryName), path.join(f.releaseRoot, directoryName));
    f.options.preserveNames = f.options.preserveNames.map((name) => name === entry.directoryName ? directoryName : name);
    entry.directoryName = directoryName;
    await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /unreviewed build directory|directory version\/edition/);
    await assert.rejects(lstat(f.history), { code: "ENOENT" });
  }
  const offline = await fixture(t, { namedNew: true, offlineNew: true });
  const offlineManifest = path.join(offline.releaseRoot, offline.options.verifiedReleases[0].directoryName, "release-manifest.json");
  const original = JSON.parse(await readFile(offlineManifest, "utf8"));
  await writeFile(offlineManifest, JSON.stringify({ ...original, distribution: "online-slim" }));
  await assert.rejects(previewHistoricalReleaseArchive(offline.options, offline.dependencies), /manifest distribution/);
});

test("old directory mapping can be discovered but is never moved", async (t) => {
  const f = await fixture(t); const options = { ...f.options }; delete options.historicalReleases;
  const report = await previewHistoricalReleaseArchive(options, f.dependencies);
  assert.equal(report.targets.length, 2); assert.ok(report.targets.every((target) => /0\.1\.2/.test(target.retainedDirectory)));
});

for (const invalid of ["../old.zip", "personal.zip", "data", "MediaTracker-local-build-slim-0.1.2-1791549999000", "采集工具-标准版-V1.0.zip ", "采集工具-标准版-V01.1.zip"]) {
  test("rejects arbitrary or unsafe history target: " + invalid, async (t) => {
    const f = await fixture(t); await assert.rejects(previewHistoricalReleaseArchive({ ...f.options, historicalNames: [invalid], historicalReleases: undefined }, f.dependencies), /refused/);
  });
}

test("preserved package names cannot be archive targets", async (t) => {
  const f = await fixture(t); await assert.rejects(previewHistoricalReleaseArchive({ ...f.options, historicalNames: [f.options.verifiedReleases[0].zipName], historicalReleases: undefined }, f.dependencies), /explicitly preserved/);
});

test("new package final smoke must be successful and precisely bound to new ZIP bytes", async (t) => {
  const f = await fixture(t); const entry = f.options.verifiedReleases[0];
  const valid = JSON.parse(await readFile(entry.smokeReportPath, "utf8"));
  for (const change of [{ fullExit: false }, { source: "wrong-build" }, { zipSha256: "c".repeat(64) }, { buildId: "stale" }, { sourceFingerprint: "d".repeat(64) }, { sourceVerified: false }, { privateDataIncluded: true }]) {
    await writeFile(entry.smokeReportPath, JSON.stringify({ ...valid, ...change }));
    await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies), /matching successful/);
    await assert.rejects(lstat(f.history), { code: "ENOENT" });
  }
});

test("minimal final smoke must include actual native Node bootstrap verification", async (t) => {
  const f = await fixture(t); const entry = f.options.verifiedReleases[1];
  const smoke = JSON.parse(await readFile(entry.smokeReportPath, "utf8")); smoke.nodeBootstrapVerified = false;
  await writeFile(entry.smokeReportPath, JSON.stringify(smoke));
  await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /matching successful/);
});

test("a saved successful audit does not bypass live source/ZIP auditing", async (t) => {
  const f = await fixture(t); await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { ...f.dependencies,
    auditReleaseImpl: async () => { throw new Error("live source audit failed"); } }), /live source audit failed/);
});

test("old ZIP filename version and edition must match its retained manifest", async (t) => {
  const f = await fixture(t); const old = f.options.historicalReleases[0];
  await writeFile(path.join(f.releaseRoot, old.directoryName, "release-manifest.json"), JSON.stringify({ version: "9.9.9", edition: "standard" }));
  await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /does not match/);
});

test("unverified arbitrary content under a release-like ZIP name is not archived", async (t) => {
  const f = await fixture(t); const old = f.options.historicalNames[0];
  await assert.rejects(previewHistoricalReleaseArchive(f.options, { ...f.dependencies,
    auditReleaseImpl: async (args) => { if (path.basename(args.zip) === old) throw new Error("invalid old ZIP structure"); return f.dependencies.auditReleaseImpl(args); } }), /invalid old ZIP/);
});

test("changed old ZIP bytes fail verification before history is created", async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.releaseRoot, f.options.historicalNames[0]), "changed old ZIP");
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies), /old ZIP changed/);
  await assert.rejects(lstat(f.history), { code: "ENOENT" });
});

test("all history name collisions are checked before any source moves", async (t) => {
  const f = await fixture(t); await mkdir(f.history);
  await writeFile(path.join(f.history, f.options.historicalNames[1]), "existing archive must survive");
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, f.dependencies), /filename collision/);
  assert.equal(await readFile(path.join(f.history, f.options.historicalNames[1]), "utf8"), "existing archive must survive");
  for (const name of f.options.historicalNames) assert.equal(await readFile(path.join(f.releaseRoot, name), "utf8"), name);
});

test("linked history directory is rejected without modifying the external destination", async (t) => {
  const f = await fixture(t); const outside = path.join(f.projectRoot, "outside"); await mkdir(outside);
  await symlink(outside, f.history, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /nonregular or linked/);
  assert.deepEqual(await readdir(outside), []);
});

test("hard-linked source ZIPs and native reparse points are rejected", async (t) => {
  const f = await fixture(t); await link(path.join(f.releaseRoot, f.options.historicalNames[0]), path.join(f.projectRoot, "outside.zip"));
  await assert.rejects(previewHistoricalReleaseArchive(f.options, f.dependencies), /linked release/);
  await unlink(path.join(f.projectRoot, "outside.zip"));
  await assert.rejects(previewHistoricalReleaseArchive(f.options, { ...f.dependencies, inspectReparsePointsImpl: async () => [f.releaseRoot] }), /reparse points/);
});

test("process references or inspection failure block archive without terminating processes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(previewHistoricalReleaseArchive(f.options, { ...f.dependencies,
    inspectProcessesImpl: async () => [{ ProcessId: 10, Name: "7z.exe", CommandLine: path.join(f.releaseRoot, f.options.historicalNames[0]) }] }), /running processes/);
  await assert.rejects(previewHistoricalReleaseArchive(f.options, { ...f.dependencies,
    inspectProcessesImpl: async () => { throw new Error("CIM unavailable"); } }), /CIM unavailable/);
});

test("native no-overwrite semantics reject a destination created after preflight", async (t) => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { ...f.dependencies,
    moveFileImpl: async (source, destination) => { if (++attempts === 1) await writeFile(destination, "race survivor"); await exclusiveMove(source, destination); } }), (error) => {
    assert.equal(error.archiveReport.archivedCount, 0); return error.code === "EEXIST";
  });
  assert.equal(await readFile(path.join(f.history, f.options.historicalNames[0]), "utf8"), "race survivor");
  assert.equal(await readFile(path.join(f.releaseRoot, f.options.historicalNames[0]), "utf8"), f.options.historicalNames[0]);
});

test("a later move failure safely restores earlier source ZIPs without deletion", async (t) => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { ...f.dependencies,
    moveFileImpl: async (source, destination) => { if (++attempts === 2) throw new Error("player/file lock"); await exclusiveMove(source, destination); } }), (error) => {
    assert.match(error.message, /file lock/); assert.equal(error.archiveReport.status, "rolled-back"); assert.equal(error.archiveReport.archivedCount, 0); return true;
  });
  for (const name of f.options.historicalNames) assert.equal(await readFile(path.join(f.releaseRoot, name), "utf8"), name);
  assert.deepEqual(await readdir(f.history), []);
});

test("rollback refuses to overwrite a new original filename and preserves the archived bytes", async (t) => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { ...f.dependencies,
    moveFileImpl: async (source, destination) => {
      if (++attempts === 2) { await writeFile(path.join(f.releaseRoot, f.options.historicalNames[0]), "new unrelated source"); throw new Error("second move failed"); }
      await exclusiveMove(source, destination);
    } }), (error) => { assert.equal(error.archiveReport.status, "stopped"); assert.equal(error.archiveReport.rollbackErrors.length, 1); return true; });
  assert.equal(await readFile(path.join(f.releaseRoot, f.options.historicalNames[0]), "utf8"), "new unrelated source");
  assert.equal(await readFile(path.join(f.history, f.options.historicalNames[0]), "utf8"), f.options.historicalNames[0]);
});

test("a native move that finishes before reporting failure is verified and safely restored", async (t) => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { ...f.dependencies,
    moveFileImpl: async (source, destination) => {
      await exclusiveMove(source, destination);
      if (++attempts === 1) throw new Error("uncertain native timeout after successful move");
    } }), (error) => {
    assert.equal(error.archiveReport.status, "rolled-back"); assert.equal(error.archiveReport.archivedCount, 0);
    assert.equal(error.archiveReport.targets[0].uncertainMoveRecovered, true); return true;
  });
  for (const name of f.options.historicalNames) assert.equal(await readFile(path.join(f.releaseRoot, name), "utf8"), name);
  assert.deepEqual(await readdir(f.history), []);
});

test("actual Windows native File.Move and CIM/reparse guards work only on isolated fixtures", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const report = await applyHistoricalReleaseArchive({ ...f.options, confirmed: true }, { auditReleaseImpl: f.dependencies.auditReleaseImpl });
  assert.equal(report.archivedCount, 2); assert.equal(report.status, "completed");
  for (const name of f.options.historicalNames) assert.equal(await readFile(path.join(f.history, name), "utf8"), name);
});
