import path from "node:path";
import os from "node:os";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, lstat, realpath, readFile, writeFile, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { captureReleaseSource, assertUnchangedSource } from "./release-source.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

const run = promisify(execFile);
const project = path.resolve(import.meta.dirname, "..");
const pinnedNode = { version: "24.14.1", file: "node-v24.14.1-win-x64.zip",
  sha256: "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70" };
const scripts = ["start-service.mjs", "prepare-portable-runtime.mjs", "windows-file-action.ps1", "windows-media-open.cs", "windows-app-frame.cs", "tiktok-background-browser.ps1",
  "media-source-worker.py", "source-engines-requirements.txt", "rebuild-readable-names.mjs", "import-backup.mjs", "clean-browser-cache.mjs", "windows-folder-open.ps1"];
const pythonModules = ["yt_dlp", "requests", "certifi", "charset_normalizer", "idna", "urllib3"];
const releaseDocuments = ["PUBLISHING.md", "PRIVACY.md", "PUBLIC-EDITION.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"];
const windowsPowerShell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const quotePs = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function permittedPackagePath(value) {
  if (typeof value !== "string" || !value || /[\\:\0]/.test(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return value === "首次编译.cmd" || value === "使用说明.txt" || value === "THIRD-PARTY-NOTICES.txt"
    || value === "LICENSE" || value === "README.md" || releaseDocuments.includes(value)
    || value === "release-manifest.json" || /^(?:app|compile|runtime|components|licenses|docs)\//.test(value);
}
export function renderReleaseInstructions(template, version) {
  const { label } = parseReleaseVersion(version);
  if (typeof template !== "string" || template.split("{{RELEASE_VERSION}}").length !== 2) {
    throw new Error("Release instructions must contain exactly one version placeholder.");
  }
  return template.replace("{{RELEASE_VERSION}}", label);
}
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function copyTree(source, destination, { skip = () => false } = {}) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("A source symlink was rejected: " + source);
  if (skip(path.basename(source), info)) return;
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(destination, name), { skip });
  } else if (info.isFile()) { await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); }
  else throw new Error("A nonregular source was rejected: " + source);
}
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const name of await readdir(directory)) {
    const filename = path.join(directory, name);
    const relative = prefix + name;
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error("A packaged symlink was rejected.");
    if (info.isDirectory()) files.push(...await listFiles(filename, relative + "/"));
    else files.push({ file: relative, bytes: info.size, sha256: await sha256(filename) });
  }
  return files;
}
async function downloadNode(cache, { allowDownload = false } = {}) {
  const archive = path.join(cache, pinnedNode.file);
  try { if (await sha256(archive) === pinnedNode.sha256) return archive; throw new Error("Cached Node archive integrity mismatch; remove that exact cache file before retrying."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!allowDownload) throw new Error("The pinned Node archive is not cached. Supply a read-only publisherCache or explicitly allow a build-time download.");
  const response = await fetch(`https://nodejs.org/dist/v${pinnedNode.version}/${pinnedNode.file}`,
    { redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error("Official Node runtime download failed: " + response.status);
  const temporary = archive + ".partial-" + Date.now();
  let size = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (stream) {
    for await (const chunk of stream) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error("Node archive exceeded the build limit."); yield chunk; }
  }, createWriteStream(temporary, { flags: "wx" }));
  if (await sha256(temporary) !== pinnedNode.sha256) throw new Error("Official Node runtime SHA-256 mismatch; the download was not used.");
  const { rename } = await import("node:fs/promises");
  await rename(temporary, archive);
  return archive;
}

export async function buildPortable({ output, browserCache = path.join(process.env.LOCALAPPDATA, "ms-playwright"),
  pythonHome, createZip = true, includeRuntime = false, minimal = true,
  publisherCache, allowBuildDownload = false } = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build on Windows x64.");
  if (minimal !== true || includeRuntime !== false) throw new Error("This independent public edition is minimal-only; bundled and offline editions are not allowed.");
  const packageMetadata = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  if (packageMetadata.name !== "media-tracker-public" || packageMetadata.license !== "MIT") {
    throw new Error("This builder accepts only the independent MIT-licensed public source tree.");
  }
  const version = packageMetadata.version;
  const releaseVersion = parseReleaseVersion(version);
  const lock = JSON.parse(await readFile(path.join(project, "package-lock.json"), "utf8"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("Package and lock versions must match before building the public minimal edition.");
  }
  const sourceMappings = [
    ...["server.mjs", "lib", "public", "package.json", "package-lock.json"].map((source) => ({ source, file: "app/" + source })),
    ...["playwright", "playwright-core"].map((name) => ({ source: "node_modules/" + name, file: "app/node_modules/" + name })),
    ...scripts.map((name) => ({ source: "scripts/" + name, file: "app/scripts/" + name })),
    ...["Launcher.cs", "build.ps1", "launcher.manifest"].map((name) => ({ source: "packaging/local-compile/" + name, file: "compile/" + name })),
    { source: "packaging/local-compile/首次编译.cmd", file: "首次编译.cmd" },
    { source: "packaging/ffmpeg-package.json", file: "components/ffmpeg-package.json" },
    { source: "packaging/third-party-notices.txt", file: "THIRD-PARTY-NOTICES.txt" },
    { source: "LICENSE", file: "LICENSE" },
    { source: "README.md", file: "README.md" },
    ...releaseDocuments.map((name) => ({ source: name, file: name })),
    ...(!includeRuntime ? [{ source: "packaging/runtime-manifest.json", file: "components/runtime-manifest.json" }] : []),
  ];
  const initialSource = await captureReleaseSource({ root: project, mappings: sourceMappings });
  const parent = path.join(project, "release");
  await mkdir(parent, { recursive: true });
  const target = path.resolve(output || path.join(parent, `采集工具-公开版-最小版-${releaseVersion.label}`));
  if (path.dirname(target) !== parent) throw new Error("Build output must be a fresh child of this project's release directory.");
  await mkdir(target); // No existing release, credentials or user folder can be overwritten.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-package-build-"));
  try {
    const cache = publisherCache ? path.resolve(publisherCache) : path.join(project, "packaging", ".cache");
    if (publisherCache) {
      const info = await lstat(cache);
      if (!path.isAbsolute(publisherCache) || !info.isDirectory() || info.isSymbolicLink()
        || path.resolve(await realpath(cache)).toLowerCase() !== cache.toLowerCase()) {
        throw new Error("The read-only publisher cache must be an ordinary absolute directory.");
      }
      if (allowBuildDownload) throw new Error("An external publisher cache is read-only and cannot receive downloads.");
    } else await mkdir(cache, { recursive: true });
    const archive = await downloadNode(cache, { allowDownload: allowBuildDownload });
    await run(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath ${quotePs(archive)} -DestinationPath ${quotePs(path.join(temporary, "node"))}`], { windowsHide: true, timeout: 120_000 });
    const nodeSource = path.join(temporary, "node", `node-v${pinnedNode.version}-win-x64`);
    if (!minimal) await copyTree(path.join(nodeSource, "node.exe"), path.join(target, "runtime", "node", "node.exe"));
    await copyTree(path.join(nodeSource, "LICENSE"), path.join(target, "licenses", "Node-LICENSE.txt"));
    for (const name of ["server.mjs", "lib", "public", "package.json", "package-lock.json"]) {
      await copyTree(path.join(project, name), path.join(target, "app", name));
    }
    for (const name of ["playwright", "playwright-core"]) {
      await copyTree(path.join(project, "node_modules", name), path.join(target, "app", "node_modules", name));
    }
    for (const name of scripts) await copyTree(path.join(project, "scripts", name), path.join(target, "app", "scripts", name));
    const definitions = JSON.parse(await readFile(path.join(project, "node_modules", "playwright-core", "browsers.json"), "utf8"));
    const chromium = definitions.browsers.find((browser) => browser.name === "chromium");
    if (!includeRuntime) {
      const runtimeLock = JSON.parse(await readFile(path.join(project, "packaging", "runtime-manifest.json"), "utf8"));
      const lockedBrowser = runtimeLock.components?.find((component) => component.id === "chromium");
      if (runtimeLock.schemaVersion !== 1 || runtimeLock.platform !== "windows-x64"
        || lockedBrowser?.browserRevision !== chromium.revision || lockedBrowser?.version !== chromium.browserVersion) {
        throw new Error("The pinned browser must match this release's Playwright; refresh and verify the runtime manifest before building.");
      }
    }
    // The app launches the pinned browser with an explicit executablePath and
    // does not record Playwright videos. Do not redistribute the unused
    // FFmpeg recording helper or PrintDeps host-dependency probe.
    const browserDirectories = [];
    if (includeRuntime) browserDirectories.unshift(`chromium-${chromium.revision}`);
    for (const name of browserDirectories) {
      await copyTree(path.join(browserCache, name), path.join(target, "runtime", "browsers", name));
    }
    if (includeRuntime) {
      // The old venv's Scripts/python.exe is NOT portable: copy its actual base
      // runtime and the pinned worker modules instead. Never copy the venv itself.
      if (!pythonHome) {
        const cfg = await readFile(path.join(project, ".runtime", "sources-python", "pyvenv.cfg"), "utf8");
        pythonHome = cfg.match(/^executable\s*=\s*(.+)$/m)?.[1]?.trim();
        if (!pythonHome) throw new Error("Missing Python runtime source.");
        pythonHome = path.dirname(pythonHome);
      }
      pythonHome = await realpath(pythonHome);
      const skipPython = (name) => ["__pycache__", "site-packages", "include", "libs", "Scripts"].includes(name) || name.endsWith(".pyc");
      await copyTree(pythonHome, path.join(target, "runtime", "python"), { skip: skipPython });
      await copyTree(path.join(pythonHome, "LICENSE.txt"), path.join(target, "licenses", "Python-LICENSE.txt"));
      const sitePackages = path.join(project, ".runtime", "sources-python", "Lib", "site-packages");
      for (const name of await readdir(sitePackages)) {
        if (pythonModules.includes(name) || (name.endsWith(".dist-info") && pythonModules.some((module) => name.startsWith(module.replaceAll("_", "-") + "-") || name.startsWith(module + "-")))) {
          await copyTree(path.join(sitePackages, name), path.join(target, "runtime", "python", "Lib", "site-packages", name),
            { skip: (entry) => entry === "__pycache__" || entry.endsWith(".pyc") });
        }
      }
    }
    for (const name of ["Launcher.cs", "build.ps1", "launcher.manifest"]) {
      await copyTree(path.join(project, "packaging", "local-compile", name), path.join(target, "compile", name));
    }
    await copyTree(path.join(project, "packaging", "local-compile", "首次编译.cmd"), path.join(target, "首次编译.cmd"));
    await copyTree(path.join(project, "packaging", "ffmpeg-package.json"), path.join(target, "components", "ffmpeg-package.json"));
    if (!includeRuntime) await copyTree(path.join(project, "packaging", "runtime-manifest.json"), path.join(target, "components", "runtime-manifest.json"));
    await writeFile(path.join(target, "components", "edition.json"), JSON.stringify({ schemaVersion: 1,
      edition: minimal ? "minimal" : "standard", dedup: minimal ? "on-demand" : "included" }, null, 2) + "\n", { flag: "wx" });
    if (minimal) {
      const bootstrapFile = path.join(project, "packaging", "bootstrap-node.json");
      const bootstrap = JSON.parse(await readFile(bootstrapFile, "utf8"));
      if (bootstrap.schemaVersion !== 1 || bootstrap.id !== "node" || bootstrap.platform !== "win32-x64"
        || bootstrap.version !== pinnedNode.version || bootstrap.archiveSha256 !== pinnedNode.sha256
        || bootstrap.archiveURL !== `https://nodejs.org/dist/v${pinnedNode.version}/${pinnedNode.file}`
        || bootstrap.archiveBytes !== (await stat(archive)).size || bootstrap.maxArchiveBytes < bootstrap.archiveBytes
        || bootstrap.maxArchiveBytes > 100 * 1024 * 1024) throw new Error("Minimal Node bootstrap does not match the verified publisher archive.");
      await copyTree(bootstrapFile, path.join(target, "components", "bootstrap-node.json"));
    }
    const instructionTemplate = await readFile(path.join(project, "packaging", minimal ? "minimal-instructions.txt" : "portable-instructions.txt"), "utf8");
    await writeFile(path.join(target, "使用说明.txt"), renderReleaseInstructions(instructionTemplate, version), { flag: "wx" });
    await copyTree(path.join(project, "packaging", "third-party-notices.txt"), path.join(target, "THIRD-PARTY-NOTICES.txt"));
    await copyTree(path.join(project, "LICENSE"), path.join(target, "LICENSE"));
    await copyTree(path.join(project, "README.md"), path.join(target, "README.md"));
    for (const name of releaseDocuments) await copyTree(path.join(project, name), path.join(target, name));
    // The slim artifact must stay unprepared and free of author data. Its
    // pinned downloaded runtime is tested in a separate, disposable fixture.
    if (includeRuntime) {
      // Validate Python without network or importing the service/user state.
      const python = path.join(target, "runtime", "python", "python.exe");
      const pythonProof = await run(python, ["-I", "-B", "-X", "utf8", "-c", "import yt_dlp,requests,certifi,sys; print(sys.prefix); print('source-engines-ready')"],
        { windowsHide: true, timeout: 30_000, env: { ...process.env, PYTHONHOME: "", PYTHONPATH: "", PYTHONDONTWRITEBYTECODE: "1" } });
      if (path.resolve(pythonProof.stdout.split(/\r?\n/)[0]).toLowerCase() !== path.dirname(python).toLowerCase()) throw new Error("Bundled Python resolved outside the portable package.");
    }
    const files = await listFiles(target);
    for (const entry of files) if (!permittedPackagePath(entry.file) || /(?:^|\/)data\//.test(entry.file)) throw new Error("Nonwhitelisted release content: " + entry.file);
    const source = await captureReleaseSource({ root: project, mappings: sourceMappings });
    assertUnchangedSource(initialSource, source, files);
    if (JSON.parse(await readFile(path.join(target, "app", "package.json"), "utf8")).version !== version) {
      throw new Error("Package version changed during capture; rebuild from the latest source.");
    }
    const builtAt = new Date().toISOString();
    const buildId = `media-tracker-${version}-${minimal ? "minimal" : "standard"}-${builtAt.replace(/[^0-9TZ]/g, "")}-${source.fingerprint.slice(0, 12)}`;
    await writeFile(path.join(target, "release-manifest.json"), JSON.stringify({ schemaVersion: 1, version, versionLabel: releaseVersion.label,
      buildId, builtAt, source,
      buildType: "user-local-compile-unsigned", distribution: minimal ? "online-minimal" : includeRuntime ? "offline-full" : "online-slim",
      edition: minimal ? "minimal" : "standard", applicationId: "media-tracker-public", platform: "windows-x64", sourceDataIncluded: false,
      node: { ...pinnedNode, bundled: !minimal }, chromium: chromium.browserVersion, files }, null, 2) + "\n", { flag: "wx" });
    let zip, zipBytes;
    if (createZip) {
      zip = target + ".zip";
      await run(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quotePs(target)},${quotePs(zip)},[IO.Compression.CompressionLevel]::Optimal,$true)`],
      { windowsHide: true, timeout: 300_000 });
      zipBytes = (await stat(zip)).size;
      if (!includeRuntime && zipBytes > 45 * 1024 * 1024) throw new Error("Slim release exceeded its 45 MiB distribution budget.");
      if (minimal && zipBytes > 8 * 1024 * 1024) throw new Error("Minimal release exceeded its 8 MiB distribution budget.");
    }
    assertUnchangedSource(source, await captureReleaseSource({ root: project, mappings: sourceMappings }), files);
    return { directory: target, zip, zipBytes, version, versionLabel: releaseVersion.label, edition: minimal ? "minimal" : "standard",
      buildId, sourceFingerprint: source.fingerprint,
      distribution: minimal ? "online-minimal" : includeRuntime ? "offline-full" : "online-slim", fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("collector-package-build-")) throw new Error("Unsafe build temporary cleanup.");
    await rm(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cacheIndex = process.argv.indexOf("--publisher-cache");
  try { console.log(JSON.stringify(await buildPortable({ createZip: !process.argv.includes("--no-zip"), includeRuntime: process.argv.includes("--full"),
    minimal: !process.argv.includes("--standard"), publisherCache: cacheIndex >= 0 ? process.argv[cacheIndex + 1] : undefined,
    allowBuildDownload: process.argv.includes("--allow-build-download") }), null, 2)); }
  catch (error) { console.error("Portable build failed: " + error.message); process.exitCode = 1; }
}
