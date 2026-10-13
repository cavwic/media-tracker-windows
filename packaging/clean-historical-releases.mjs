import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { auditRelease } from "./audit-release.mjs";

const run = promisify(execFile);
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const HEX = /^[a-f0-9]{64}$/;

// Only the historical artifacts actually inventoried for this cleanup may be removed.
// A later release requires a fresh, reviewed inventory, not a recursive wildcard.
export const HISTORICAL_RELEASE_NAMES = Object.freeze([
  "MediaTracker-local-build-0.1.0-1791457805553",
  "MediaTracker-local-build-0.1.0-1791458236399",
  "MediaTracker-local-build-0.1.0-1791458335664",
  "MediaTracker-local-build-0.1.0-1791458906285",
  "MediaTracker-local-build-0.1.0-1791459893695",
  "MediaTracker-local-build-0.1.0-1791460014209",
  "MediaTracker-local-build-minimal-0.1.1-1791536808955",
  "MediaTracker-local-build-minimal-0.1.1-1791537088687",
  "MediaTracker-local-build-slim-0.1.0-1791462180273",
  "MediaTracker-local-build-slim-0.1.0-1791462619900",
  "MediaTracker-local-build-slim-0.1.0-1791462791579",
  "MediaTracker-local-build-slim-0.1.1-1791536798622",
  "MediaTracker-local-build-slim-0.1.1-1791537078522",
  "采集工具-本地编译便携版-20261008.zip",
  "采集工具-标准版-0.1.1-20261009.zip",
  "采集工具-精简本地编译版-20261008.zip",
  "采集工具-最小版-0.1.1-20261009.zip",
  "MediaTracker-local-build-minimal-0.1.1-1791536808955.zip",
  "MediaTracker-local-build-slim-0.1.0-1791462180273.zip",
  "MediaTracker-local-build-slim-0.1.0-1791462619900.zip",
  "MediaTracker-local-build-slim-0.1.1-1791536798622.zip",
  "MediaTracker-local-build-slim-0.1.2-1791540656322",
  "MediaTracker-local-build-minimal-0.1.2-1791540666443",
  "采集工具-标准版-0.1.2-未验收候选-20261009.zip",
  "采集工具-最小版-0.1.2-未验收候选-20261009.zip",
]);
const historical = new Set(HISTORICAL_RELEASE_NAMES);
const fail = (message) => { throw new Error("Historical release cleanup refused: " + message); };
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function childName(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".."
    || /[\\/:\0-\x1f]/.test(value) || /[. ]$/.test(value) || path.basename(value) !== value) fail("unsafe direct-child name");
  return value;
}

function names(value, label) {
  if (!Array.isArray(value) || !value.length) fail(label + " must be a nonempty explicit whitelist");
  const checked = value.map(childName);
  if (new Set(checked.map((name) => name.toLowerCase())).size !== checked.length) fail("duplicate " + label);
  return checked;
}

async function noLinkChain(filename) {
  let current = path.resolve(filename);
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail("link in path: " + current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function directChild(releaseRoot, name, { missing = false, directory } = {}) {
  const filename = path.join(releaseRoot, childName(name));
  if (!equalPath(path.dirname(filename), releaseRoot)) fail("target escaped the release root");
  let info;
  try { info = await lstat(filename); } catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || info.isFile() && info.nlink > 1) fail("nonregular or linked target: " + filename);
  if (directory !== undefined && info.isDirectory() !== directory) fail("incorrect target type: " + filename);
  const actual = await realpath(filename);
  if (!equalPath(path.dirname(actual), releaseRoot) || !equalPath(actual, filename)) fail("target resolved outside its direct-child location");
  return { filename, info };
}

async function encodedPowerShell(script) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, "")) : [];
}

async function inspectProcesses() {
  if (process.platform !== "win32") fail("Windows process inspection is required before cleanup");
  return encodedPowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine) -Compress -Depth 3");
}

async function inspectReparsePoints(roots, recursive) {
  if (process.platform !== "win32") return [];
  const payload = Buffer.from(JSON.stringify({ roots, recursive }), "utf8").toString("base64");
  return encodedPowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$scan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; "
    + "$found=@(foreach($scanPath in $scan.roots) { $scanItem=Get-Item -LiteralPath $scanPath -Force; "
    + "if($scanItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {$scanItem.FullName}; "
    + "if($scan.recursive -and $scanItem.PSIsContainer) { Get-ChildItem -LiteralPath $scanPath -Recurse -Force | "
    + "Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -ExpandProperty FullName }}); "
    + "ConvertTo-Json -InputObject @($found) -Compress");
}

function referencedProcesses(processes, targets) {
  if (!Array.isArray(processes)) fail("process inspection did not return an array");
  return processes.flatMap((process) => {
    const text = [process.ExecutablePath, process.CommandLine].filter((value) => typeof value === "string").join("\n").replaceAll("/", "\\").toLowerCase();
    const referenced = targets.filter((target) => text.includes(target.path.replaceAll("/", "\\").toLowerCase()));
    return referenced.length ? [{ processId: process.ProcessId, name: process.Name, targetNames: referenced.map((target) => target.name) }] : [];
  });
}

async function fileDigest(filename, info) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
  const after = await lstat(filename);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || bytes !== info.size
    || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.ino !== info.ino) fail("file changed during inventory: " + filename);
  return { bytes, sha256: hash.digest("hex") };
}

async function inventory(releaseRoot, name) {
  const child = await directChild(releaseRoot, name, { missing: true, directory: !name.endsWith(".zip") });
  if (!child) return { name, path: path.join(releaseRoot, name), exists: false, bytes: 0, fileCount: 0, sha256: null, deleted: false };
  const records = [];
  const directories = [];
  async function visit(filename, relative) {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) fail("linked inventory entry: " + filename);
    if (relative.startsWith("data/") && relative.split("/").some((part) => ["state.json", "sync-index.json", "browser-profiles"].includes(part.toLowerCase()))) fail("old release contains account bindings or a sync index: " + filename);
    const actual = await realpath(filename);
    const offset = path.relative(child.filename, actual);
    if (offset === ".." || offset.startsWith(".." + path.sep) || path.isAbsolute(offset)) fail("inventory entry escaped its release directory");
    if (info.isDirectory()) {
      directories.push(relative);
      const entries = (await readdir(filename)).sort();
      if (relative === "data" && entries.some((entry) => !["builtin-app-profile-v1", "startup-logs"].includes(entry))) fail("unknown user data in old release: " + filename);
      if (path.basename(filename).toLowerCase() === "data"
        && entries.some((entry) => ["state.json", "sync-index.json", "browser-profiles"].includes(entry.toLowerCase()))) fail("old release contains account bindings or a sync index: " + filename);
      for (const entry of entries) await visit(path.join(filename, entry), relative ? relative + "/" + entry : entry);
    } else if (info.isFile()) records.push({ file: relative, ...await fileDigest(filename, info) });
    else fail("special inventory entry: " + filename);
  }
  if (child.info.isFile()) {
    const digest = await fileDigest(child.filename, child.info);
    return { name, path: child.filename, exists: true, kind: "file", ...digest, fileCount: 1, deleted: false };
  }
  await visit(child.filename, "");
  const canonical = { directories: directories.sort(), files: records.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0) };
  return { name, path: child.filename, exists: true, kind: "directory", bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    fileCount: records.length, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"), deleted: false };
}

function passedAudit(value, release) {
  if (!value || value.schemaVersion !== 1 || value.ok !== true || value.edition !== release.edition
    || value.directoryName !== release.directoryName || value.zipName !== release.zipName
    || !HEX.test(value.sourceTreeSha256 || "") || !HEX.test(value.zipSha256 || "")
    || value.checks?.manifest !== true || value.checks?.source !== true || value.checks?.zip !== true) fail("both releases need a complete successful current-source/manifest/ZIP audit");
  return value;
}

async function verificationRoot(projectRoot) {
  const packaging = path.join(projectRoot, "packaging");
  await noLinkChain(packaging);
  const verification = path.join(packaging, "verification");
  await mkdir(verification, { recursive: true });
  await noLinkChain(verification);
  if (!equalPath(await realpath(verification), verification)) fail("verification report directory is not regular");
  return verification;
}

async function prepare(options, dependencies) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  await noLinkChain(projectRoot);
  if (!equalPath(await realpath(projectRoot), projectRoot)) fail("project root is not its canonical location");
  const releaseRoot = path.join(projectRoot, "release");
  await noLinkChain(releaseRoot);
  if (!equalPath(await realpath(releaseRoot), releaseRoot) || !(await lstat(releaseRoot)).isDirectory()) fail("release root is not regular");
  const historicalNames = names(options.historicalNames, "historical names");
  if (historicalNames.some((name) => !historical.has(name))) fail("historical name was not in the reviewed inventory");
  const preserveNames = names(options.preserveNames, "preserved names");
  if (historicalNames.some((name) => preserveNames.some((keep) => keep.toLowerCase() === name.toLowerCase()))) fail("a deletion target is also preserved");
  const releases = options.verifiedReleases;
  if (!Array.isArray(releases) || releases.length !== 2 || new Set(releases.map((release) => release?.edition)).size !== 2
    || releases.some((release) => !["standard", "minimal"].includes(release?.edition))) fail("exactly one new standard and one new minimal release are required");
  const verification = await verificationRoot(projectRoot);
  const newAudits = [];
  for (const release of releases) {
    childName(release.directoryName); childName(release.zipName);
    if (release.directoryName === release.zipName || !release.zipName.endsWith(".zip")
      || ![release.directoryName, release.zipName].every((name) => preserveNames.includes(name))
      || historicalNames.includes(release.directoryName) || historicalNames.includes(release.zipName)) fail("new release directory and ZIP must be explicitly preserved");
    const directory = await directChild(releaseRoot, release.directoryName, { directory: true });
    const zip = await directChild(releaseRoot, release.zipName, { directory: false });
    const reportPath = path.resolve(release.auditReportPath || "");
    if (!equalPath(path.dirname(reportPath), verification) || path.extname(reportPath) !== ".json") fail("audit reports must be direct local verification JSON files");
    await noLinkChain(reportPath);
    const reportInfo = await lstat(reportPath);
    if (!reportInfo.isFile() || reportInfo.nlink > 1) fail("audit report must be a regular unlinked file");
    const saved = passedAudit(JSON.parse(await readFile(reportPath, "utf8")), release);
    const current = passedAudit(await dependencies.auditReleaseImpl({ directory: directory.filename, zip: zip.filename, sourceRoot: projectRoot }), release);
    if (saved.sourceTreeSha256 !== current.sourceTreeSha256 || saved.zipSha256 !== current.zipSha256
      || (await fileDigest(zip.filename, zip.info)).sha256 !== current.zipSha256) fail("new release changed after its saved audit");
    newAudits.push({ ...current, directory: directory.filename, zip: zip.filename, auditReportPath: reportPath });
  }
  if (newAudits[0].sourceTreeSha256 !== newAudits[1].sourceTreeSha256) fail("standard and minimal releases were not built from the same source snapshot");
  const targets = [];
  for (const name of historicalNames) targets.push(await inventory(releaseRoot, name));
  const reparses = await dependencies.inspectReparsePointsImpl([projectRoot, releaseRoot, verification], false);
  const targetReparses = await dependencies.inspectReparsePointsImpl(targets.filter((target) => target.exists).map((target) => target.path), true);
  if (!Array.isArray(reparses) || !Array.isArray(targetReparses) || reparses.length || targetReparses.length) fail("Windows reparse points are forbidden");
  const blocked = referencedProcesses(await dependencies.inspectProcessesImpl(), targets.filter((target) => target.exists));
  if (blocked.length) fail("running processes reference old releases: " + JSON.stringify(blocked));
  return { verification, report: { schemaVersion: 1, mode: "preview", status: "ready", createdAt: new Date().toISOString(),
    privacy: "local-verification-only", projectRoot, releaseRoot, preserveNames, newAudits, targets,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0), deletedBytes: 0, deletedCount: 0 } };
}

async function persistReport(reportPath, report, initial = false) {
  const filename = initial ? reportPath : reportPath + ".tmp-" + randomUUID();
  const handle = await open(filename, "wx");
  try { await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  if (!initial) {
    const info = await lstat(reportPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) fail("cleanup report changed while applying");
    await rename(filename, reportPath);
  }
}

const defaultDependencies = { auditReleaseImpl: auditRelease, inspectProcessesImpl: inspectProcesses, inspectReparsePointsImpl: inspectReparsePoints };

export async function previewHistoricalReleaseCleanup(options, testingDependencies = {}) {
  const prepared = await prepare(options, { ...defaultDependencies, ...testingDependencies });
  const reportPath = path.join(prepared.verification, "historical-release-cleanup-preview-" + Date.now() + "-" + randomUUID() + ".json");
  await persistReport(reportPath, prepared.report, true);
  return { ...prepared.report, reportPath };
}

export async function applyHistoricalReleaseCleanup(options, testingDependencies = {}) {
  if (options.confirmed !== true) fail("explicit confirmed:true is required to delete historical releases");
  const dependencies = { ...defaultDependencies, ...testingDependencies };
  const { verification, report } = await prepare(options, dependencies); // Always re-audit the actual new ZIPs and current source.
  report.mode = "apply"; report.status = "prepared";
  const reportPath = path.join(verification, "historical-release-cleanup-apply-" + Date.now() + "-" + randomUUID() + ".json");
  await persistReport(reportPath, report, true); // Do not delete unless the explicit target inventory is durable.
  try {
    for (const target of report.targets.filter((target) => target.exists)) {
      await noLinkChain(report.releaseRoot);
      const current = await inventory(report.releaseRoot, target.name);
      if (!current.exists || current.kind !== target.kind || current.bytes !== target.bytes || current.sha256 !== target.sha256) fail("old release changed after inventory: " + target.name);
      const reparses = await dependencies.inspectReparsePointsImpl([target.path], true);
      if (!Array.isArray(reparses) || reparses.length) fail("target became a Windows reparse point");
      const blocked = referencedProcesses(await dependencies.inspectProcessesImpl(), report.targets.filter((item) => item.exists && !item.deleted));
      if (blocked.length) fail("a process started referencing an old release; cleanup stopped");
      await directChild(report.releaseRoot, target.name, { directory: target.kind === "directory" });
      await rm(target.path, { recursive: target.kind === "directory", force: false });
      target.deleted = true; target.deletedAt = new Date().toISOString();
      report.deletedCount++; report.deletedBytes += target.bytes;
      await persistReport(reportPath, report);
    }
    report.status = "completed"; report.completedAt = new Date().toISOString();
    await persistReport(reportPath, report);
    return { ...report, reportPath };
  } catch (error) {
    report.status = "stopped"; report.error = error.message;
    try { await persistReport(reportPath, report); } catch (reportError) { report.reportError = reportError.message; }
    error.cleanupReport = { ...report, reportPath };
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const planAt = args.indexOf("--plan");
    if (planAt < 0 || !args[planAt + 1]) fail("usage: clean-historical-releases.mjs --plan local-plan.json [--apply --confirmed]");
    const planPath = path.resolve(args[planAt + 1]);
    args.splice(planAt, 2);
    if (args.some((argument) => !["--apply", "--confirmed"].includes(argument)) || args.includes("--confirmed") && !args.includes("--apply")) fail("unsupported cleanup arguments");
    const verification = await verificationRoot(PROJECT_ROOT);
    if (!equalPath(path.dirname(planPath), verification) || path.extname(planPath) !== ".json") fail("the plan must be a local verification JSON file");
    await noLinkChain(planPath);
    const options = { ...JSON.parse(await readFile(planPath, "utf8")), projectRoot: PROJECT_ROOT, confirmed: args.includes("--confirmed") };
    const result = await (args.includes("--apply") ? applyHistoricalReleaseCleanup(options) : previewHistoricalReleaseCleanup(options));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); if (error.cleanupReport) console.error(JSON.stringify(error.cleanupReport, null, 2)); process.exitCode = 1; }
}
