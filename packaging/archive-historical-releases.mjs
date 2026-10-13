import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { auditRelease } from "./audit-release.mjs";

const run = promisify(execFile);
const HEX = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error("Release history archive refused: " + message); };
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const LEGACY_BUILD_DIRECTORY = /^MediaTracker-local-build-(?:(slim|minimal|full)-)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-\d{13}$/;
const NAMED_BUILD_DIRECTORY = /^采集工具-(?:公开版-)?(标准版|最小版|离线版)-V(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const reviewedBuildDirectory = (value) => LEGACY_BUILD_DIRECTORY.test(value) || NAMED_BUILD_DIRECTORY.test(value);

function childName(value) {
  if (typeof value !== "string" || !value || /[\\/:\0-\x1f]/.test(value) || /[. ]$/.test(value)
    || [".", ".."].includes(value) || path.basename(value) !== value) fail("unsafe direct-child name");
  return value;
}

export function parseReleaseZipName(value) {
  childName(value);
  const match = /^采集工具-(?:公开版-)?(标准版|最小版|离线版)-(?:V(0|[1-9]\d*)\.(0|[1-9]\d*)|((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(\d{8}))\.zip$/.exec(value);
  if (!match) fail("not a reviewed release ZIP filename: " + value);
  return { edition: match[1] === "最小版" ? "minimal" : "standard", version: match[4] || match[2] + "." + match[3] + ".0" };
}

function names(value, label) {
  if (!Array.isArray(value) || !value.length) fail(label + " must be an explicit nonempty whitelist");
  const checked = value.map(childName);
  if (new Set(checked.map((name) => name.toLowerCase())).size !== checked.length) fail("duplicate " + label);
  return checked;
}

async function noLinks(filename) {
  for (let current = path.resolve(filename);;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail("path contains a link: " + current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function regularChild(root, name, directory) {
  const filename = path.join(root, childName(name));
  if (!equalPath(path.dirname(filename), root)) fail("path escaped the direct release child");
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) fail("nonregular or linked release item");
  if (!equalPath(await realpath(filename), filename)) fail("release item resolved outside its direct location");
  return { filename, info };
}

async function optionalHistory(releaseRoot) {
  const filename = path.join(releaseRoot, "history");
  try { await regularChild(releaseRoot, "history", true); return { path: filename, exists: true }; }
  catch (error) { if (error.code === "ENOENT") return { path: filename, exists: false }; throw error; }
}

async function digest(filename, before) {
  before ??= await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) fail("ZIP is not a regular unlinked file");
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  const after = await lstat(filename);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || before.size !== bytes || after.size !== bytes
    || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("release ZIP changed while hashing");
  return { bytes, sha256: hash.digest("hex") };
}

async function nativePowerShell(script) {
  if (process.platform !== "win32") fail("native Windows inspection/move is required");
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, "")) : [];
}

async function inspectProcesses() {
  return nativePowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine) -Compress -Depth 3");
}

async function inspectReparses(paths) {
  if (process.platform !== "win32") return [];
  const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  return nativePowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$scan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; "
    + "$found=@(foreach($scanPath in $scan){$item=Get-Item -LiteralPath $scanPath -Force; "
    + "if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){$item.FullName}}); ConvertTo-Json -InputObject @($found) -Compress");
}

async function moveFileNoOverwrite(source, destination) {
  const payload = Buffer.from(JSON.stringify({ source, destination }), "utf8").toString("base64");
  // File.Move's two-argument Windows implementation refuses an existing destination.
  // No Force, replace, delete, shell path expansion, or cross-shell file operation is used.
  await nativePowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$move=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; "
    + "[IO.File]::Move([string]$move.source,[string]$move.destination)");
}

async function assertNoCollision(history, targets) {
  if (!history.exists) return;
  for (const target of targets) {
    try { await lstat(target.destination); fail("history filename collision: " + target.name); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function assertNoProcesses(dependencies, targets) {
  const processes = await dependencies.inspectProcessesImpl();
  if (!Array.isArray(processes)) fail("process inspection was unavailable");
  const referenced = processes.flatMap((process) => {
    const text = [process.CommandLine, process.ExecutablePath].filter((value) => typeof value === "string").join("\n").replaceAll("/", "\\").toLowerCase();
    const matches = targets.filter((target) => [target.source, target.destination].some((filename) => text.includes(filename.replaceAll("/", "\\").toLowerCase())));
    return matches.length ? [{ processId: process.ProcessId, name: process.Name, targetNames: matches.map((target) => target.name) }] : [];
  });
  if (referenced.length) fail("running processes reference archive targets: " + JSON.stringify(referenced));
}

async function assertNoReparses(dependencies, paths) {
  const found = await dependencies.inspectReparsePointsImpl(paths);
  if (!Array.isArray(found) || found.length) fail("Windows reparse points are forbidden");
}

function auditPassed(audit, entry, currentSource) {
  if (!audit || audit.schemaVersion !== 1 || audit.ok !== true || audit.edition !== entry.edition
    || audit.directoryName !== entry.directoryName || audit.zipName !== entry.zipName || !HEX.test(audit.sourceTreeSha256 || "")
    || !HEX.test(audit.zipSha256 || "") || audit.checks?.manifest !== true || audit.checks?.zip !== true
    || currentSource && audit.checks?.source !== true) fail("incomplete release audit");
  return audit;
}

async function localReport(verification, filename) {
  const resolved = path.resolve(filename || "");
  if (!equalPath(path.dirname(resolved), verification) || path.extname(resolved) !== ".json") fail("evidence must be direct local verification JSON");
  await noLinks(resolved);
  const info = await lstat(resolved);
  if (!info.isFile() || info.nlink > 1) fail("evidence is not a regular unlinked file");
  return JSON.parse(await readFile(resolved, "utf8"));
}

function smokePassed(smoke, entry, audit) {
  const required = ["compiled", "cleaned", "standaloneEnvironment", "runtimePrepared", "windowStarted", "repeatLaunch", "fullExit", "sourceVerified"];
  if (!smoke || required.some((field) => smoke[field] !== true) || smoke.privateDataIncluded !== false || smoke.error
    || smoke.source !== entry.directoryName || smoke.edition !== entry.edition || smoke.buildId !== audit.buildId
    || typeof smoke.buildId !== "string" || !smoke.buildId || smoke.sourceFingerprint !== audit.sourceTreeSha256
    || smoke.zipSha256 !== audit.zipSha256 || entry.edition === "minimal" && smoke.nodeBootstrapVerified !== true) fail("new release requires matching successful final startup/exit smoke evidence");
  return smoke;
}

async function packageManifest(releaseRoot, directoryName, friendly, zipName) {
  if (!reviewedBuildDirectory(childName(directoryName))) fail("unreviewed build directory name");
  const directory = await regularChild(releaseRoot, directoryName, true);
  await noLinks(path.join(directory.filename, "release-manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(directory.filename, "release-manifest.json"), "utf8"));
  if (manifest.version !== friendly.version || manifest.edition !== friendly.edition) fail("ZIP filename version/edition does not match its manifest");
  const named = NAMED_BUILD_DIRECTORY.exec(directoryName);
  const legacy = LEGACY_BUILD_DIRECTORY.exec(directoryName);
  const directoryVersion = named ? named[2] + "." + named[3] + ".0" : legacy[2];
  const directoryEdition = (named ? named[1] === "最小版" : legacy[1] === "minimal") ? "minimal" : "standard";
  if (directoryVersion !== manifest.version || directoryEdition !== manifest.edition
    || named && directoryName + ".zip" !== zipName) fail("build directory version/edition does not match its ZIP/manifest");
  if (named) {
    const distribution = named[1] === "离线版" ? "offline-full" : named[1] === "最小版" ? "online-minimal" : "online-slim";
    if (manifest.distribution !== distribution) fail("build directory label does not match its manifest distribution");
  }
  return directory;
}

async function resolveHistoricalPackage(releaseRoot, name, options, dependencies) {
  const friendly = parseReleaseZipName(name);
  const mapping = options.historicalReleases?.find((entry) => entry.zipName === name);
  const candidates = mapping ? [mapping.directoryName] : (await readdir(releaseRoot)).filter(reviewedBuildDirectory);
  const accepted = [];
  for (const directoryName of candidates) {
    try {
      const directory = await packageManifest(releaseRoot, directoryName, friendly, name);
      const audit = auditPassed(await dependencies.auditReleaseImpl({ directory: directory.filename, zip: path.join(releaseRoot, name) }),
        { ...friendly, directoryName, zipName: name }, false);
      accepted.push({ directoryName, directory: directory.filename, audit });
    } catch (error) { if (mapping) throw error; }
  }
  if (accepted.length !== 1) fail("old ZIP must resolve to exactly one retained, internally verified build directory: " + name);
  return { ...friendly, ...accepted[0] };
}

async function prepare(options, dependencies) {
  if (typeof options.projectRoot !== "string" || !path.isAbsolute(options.projectRoot)) fail("an explicit absolute projectRoot is required");
  const projectRoot = path.resolve(options.projectRoot); await noLinks(projectRoot);
  if (!equalPath(await realpath(projectRoot), projectRoot)) fail("project root is not canonical");
  const releaseRoot = path.join(projectRoot, "release"); await noLinks(releaseRoot);
  if (!equalPath(await realpath(releaseRoot), releaseRoot)) fail("release root is not canonical");
  const verification = path.join(projectRoot, "packaging", "verification"); await noLinks(verification);
  if (!equalPath(await realpath(verification), verification)) fail("verification directory is not canonical");
  const historicalNames = names(options.historicalNames, "historical ZIP names"); historicalNames.forEach(parseReleaseZipName);
  const preserveNames = names(options.preserveNames, "preserved names");
  if (historicalNames.some((name) => preserveNames.some((keep) => name.toLowerCase() === keep.toLowerCase()))) fail("archive target is explicitly preserved");
  if (options.historicalReleases !== undefined && (!Array.isArray(options.historicalReleases)
    || new Set(options.historicalReleases.map((entry) => entry?.zipName)).size !== options.historicalReleases.length
    || options.historicalReleases.some((entry) => !historicalNames.includes(entry?.zipName) || !reviewedBuildDirectory(childName(entry.directoryName))))) fail("invalid historical release mapping");
  const releases = options.verifiedReleases;
  if (options.publicMinimalOnly === true) {
    const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    if (packageMetadata.name !== "media-tracker-public" || packageMetadata.license !== "MIT"
      || !Array.isArray(releases) || releases.length !== 1 || releases[0]?.edition !== "minimal"
      || ![...historicalNames, releases[0]?.zipName].every((name) => /^采集工具-公开版-最小版-/.test(name || ""))) {
      fail("one verified public minimal release and public-only history are required");
    }
  } else if (!Array.isArray(releases) || releases.length !== 2 || new Set(releases.map((entry) => entry?.edition)).size !== 2
    || releases.some((entry) => !["standard", "minimal"].includes(entry?.edition))) fail("one verified new standard and minimal release are required");
  const newReleases = [];
  for (const entry of releases) {
    if (![entry.directoryName, entry.zipName].every((name) => preserveNames.includes(name))) fail("new directory and ZIP must be preserved");
    const friendly = parseReleaseZipName(entry.zipName);
    if (friendly.edition !== entry.edition) fail("new ZIP edition mismatch");
    const directory = await packageManifest(releaseRoot, entry.directoryName, friendly, entry.zipName);
    const zip = await regularChild(releaseRoot, entry.zipName, false);
    const saved = auditPassed(await localReport(verification, entry.auditReportPath), entry, true);
    const current = auditPassed(await dependencies.auditReleaseImpl({ directory: directory.filename, zip: zip.filename, sourceRoot: projectRoot }), entry, true);
    if (saved.buildId !== current.buildId || saved.sourceTreeSha256 !== current.sourceTreeSha256 || saved.zipSha256 !== current.zipSha256
      || (await digest(zip.filename, zip.info)).sha256 !== current.zipSha256) fail("new package changed after saved audit");
    const smoke = smokePassed(await localReport(verification, entry.smokeReportPath), entry, current);
    newReleases.push({ audit: current, smoke, directory: directory.filename, zip: zip.filename });
  }
  if (newReleases.length > 1 && newReleases[0].audit.sourceTreeSha256 !== newReleases[1].audit.sourceTreeSha256) fail("new editions do not share one current source snapshot");
  const history = await optionalHistory(releaseRoot);
  const targets = [];
  for (const name of historicalNames) {
    const source = await regularChild(releaseRoot, name, false);
    const old = await resolveHistoricalPackage(releaseRoot, name, options, dependencies);
    const hash = await digest(source.filename, source.info);
    if (hash.sha256 !== old.audit.zipSha256) fail("old ZIP changed during audit");
    targets.push({ name, source: source.filename, destination: path.join(history.path, name), ...hash, edition: old.edition,
      version: old.version, retainedDirectory: old.directory, historicalAudit: old.audit, archived: false });
  }
  await assertNoCollision(history, targets);
  await assertNoReparses(dependencies, [projectRoot, releaseRoot, verification, ...(history.exists ? [history.path] : []), ...targets.flatMap((target) => [target.source, target.retainedDirectory])]);
  await assertNoProcesses(dependencies, targets);
  return { verification, history, report: { schemaVersion: 1, mode: "preview", status: "ready", privacy: "local-verification-only",
    createdAt: new Date().toISOString(), projectRoot, releaseRoot, historyRoot: history.path, preserveNames, newReleases, targets,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0), archivedCount: 0, archivedBytes: 0 } };
}

async function persist(reportPath, report, initial = false) {
  const temporary = initial ? reportPath : reportPath + ".tmp-" + randomUUID();
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
  if (!initial) {
    const info = await lstat(reportPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) fail("archive report became nonregular");
    await rename(temporary, reportPath);
  }
}

const defaults = { auditReleaseImpl: auditRelease, inspectProcessesImpl: inspectProcesses, inspectReparsePointsImpl: inspectReparses, moveFileImpl: moveFileNoOverwrite };

export async function previewHistoricalReleaseArchive(options, testingDependencies = {}) {
  const { verification, report } = await prepare(options, { ...defaults, ...testingDependencies });
  const reportPath = path.join(verification, "release-history-preview-" + Date.now() + "-" + randomUUID() + ".json");
  await persist(reportPath, report, true);
  return { ...report, reportPath };
}

export async function applyHistoricalReleaseArchive(options, testingDependencies = {}) {
  if (options.confirmed !== true) fail("confirmed:true is required to move historical ZIPs");
  const dependencies = { ...defaults, ...testingDependencies };
  const { verification, history, report } = await prepare(options, dependencies);
  report.mode = "apply"; report.status = "prepared";
  const reportPath = path.join(verification, "release-history-apply-" + Date.now() + "-" + randomUUID() + ".json");
  await persist(reportPath, report, true);
  try {
    await noLinks(report.releaseRoot);
    if (!history.exists) await mkdir(history.path); // No history directory is created by preview.
    await regularChild(report.releaseRoot, "history", true); history.exists = true;
    await assertNoCollision(history, report.targets);
    for (const target of report.targets) {
      const current = await regularChild(report.releaseRoot, target.name, false);
      const hash = await digest(current.filename, current.info);
      if (hash.sha256 !== target.sha256 || hash.bytes !== target.bytes) fail("archive source changed after inventory");
    }
    await assertNoProcesses(dependencies, report.targets);
    for (const target of report.targets) {
      await noLinks(report.releaseRoot); await regularChild(report.releaseRoot, "history", true);
      await assertNoCollision(history, report.targets.filter((item) => !item.archived));
      await assertNoReparses(dependencies, [report.releaseRoot, history.path, target.source]);
      await assertNoProcesses(dependencies, report.targets);
      const current = await regularChild(report.releaseRoot, target.name, false);
      const hash = await digest(current.filename, current.info);
      if (hash.sha256 !== target.sha256 || hash.bytes !== target.bytes) fail("archive source changed before move");
      await dependencies.moveFileImpl(target.source, target.destination); // Native no-overwrite move; no deletion fallback.
      const archived = await regularChild(history.path, target.name, false);
      if ((await digest(archived.filename, archived.info)).sha256 !== target.sha256) fail("archived ZIP integrity check failed");
      target.archived = true; target.archivedAt = new Date().toISOString(); report.archivedCount++; report.archivedBytes += target.bytes;
      await persist(reportPath, report);
    }
    report.status = "completed"; report.completedAt = new Date().toISOString(); await persist(reportPath, report);
    return { ...report, reportPath };
  } catch (error) {
    report.status = "stopped"; report.error = error.message; report.rollbackErrors = [];
    // A timeout can make a native move's result uncertain. Recover only a missing
    // source whose destination is exactly the previously verified ZIP, never an
    // arbitrary new file or a destination alongside an intact original.
    for (const target of report.targets.filter((item) => !item.archived)) {
      try {
        try { await lstat(target.source); continue; } catch (sourceError) { if (sourceError.code !== "ENOENT") throw sourceError; }
        await regularChild(report.releaseRoot, "history", true);
        const archived = await regularChild(history.path, target.name, false);
        if ((await digest(archived.filename, archived.info)).sha256 !== target.sha256) fail("uncertain move destination does not match the verified ZIP");
        target.archived = true; target.uncertainMoveRecovered = true; report.archivedCount++; report.archivedBytes += target.bytes;
      } catch (inspectionError) { report.rollbackErrors.push({ name: target.name, error: inspectionError.message }); }
    }
    for (const target of [...report.targets].reverse().filter((item) => item.archived)) {
      try {
        await noLinks(report.releaseRoot); await regularChild(report.releaseRoot, "history", true);
        const archived = await regularChild(history.path, target.name, false);
        if ((await digest(archived.filename, archived.info)).sha256 !== target.sha256) fail("archived ZIP changed; rollback refused");
        await assertNoProcesses(dependencies, [target]);
        await dependencies.moveFileImpl(target.destination, target.source); // Also refuses an occupied original filename.
        target.archived = false; target.restoredAt = new Date().toISOString(); report.archivedCount--; report.archivedBytes -= target.bytes;
      } catch (rollbackError) { report.rollbackErrors.push({ name: target.name, error: rollbackError.message }); }
    }
    if (!report.rollbackErrors.length) report.status = "rolled-back";
    try { await persist(reportPath, report); } catch (reportError) { report.reportError = reportError.message; }
    error.archiveReport = { ...report, reportPath }; throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const index = args.indexOf("--plan");
    if (index < 0 || !args[index + 1]) fail("usage: archive-historical-releases.mjs --plan local-plan.json [--apply --confirmed]");
    const planPath = path.resolve(args[index + 1]); args.splice(index, 2);
    if (args.some((value) => !["--apply", "--confirmed"].includes(value)) || args.includes("--confirmed") && !args.includes("--apply")) fail("unsupported arguments");
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const verification = path.join(projectRoot, "packaging", "verification");
    const options = { ...await localReport(verification, planPath), projectRoot, confirmed: args.includes("--confirmed") };
    console.log(JSON.stringify(await (args.includes("--apply") ? applyHistoricalReleaseArchive(options) : previewHistoricalReleaseArchive(options)), null, 2));
  } catch (error) { console.error(error.message); if (error.archiveReport) console.error(JSON.stringify(error.archiveReport, null, 2)); process.exitCode = 1; }
}
