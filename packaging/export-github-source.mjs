import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstat, realpath, readdir, mkdir, readFile, writeFile } from "node:fs/promises";

// A source publication is a fresh allowlisted export, never the developer
// working directory or a recursive copy of it. Runtime and user data are not
// allowed even when .gitignore would normally hide them.
const roots = new Set([".gitignore", "LICENSE", "README.md", "PRIVACY.md", "PUBLIC-EDITION.md", "PUBLISHING.md",
  "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "package.json", "package-lock.json", "server.mjs",
  "start.cmd", "start.vbs", "clean-cache.cmd", "setup-source-engines.cmd"]);
const scripts = new Set(["build-icons.mjs", "clean-browser-cache.mjs", "import-backup.mjs", "media-source-worker.py",
  "prepare-portable-runtime.mjs", "probe-tiktok.mjs", "rebuild-readable-names.mjs", "setup-sources.ps1",
  "source-engines-requirements.txt", "start-hidden.ps1", "start-service.mjs", "tiktok-background-browser.ps1",
  "update-shortcut-icon.ps1", "windows-app-frame.cs", "windows-file-action.ps1", "windows-folder-open.ps1",
  "windows-media-open.cs", "publish-github.mjs"]);
const packaging = new Set(["archive-historical-releases.mjs", "audit-release.mjs", "bootstrap-node.json", "build-portable.mjs", "clean-historical-releases.mjs",
  "export-github-source.mjs", "ffmpeg-package.json", "minimal-instructions.txt", "portable-instructions.txt",
  "release-source.mjs", "release-version.mjs", "release-workflow.md", "runtime-manifest.json", "third-party-notices.txt",
  "verify-node-bootstrap.cs", "verify-portable.mjs", "local-compile/Launcher.cs", "local-compile/build.ps1",
  "local-compile/launcher.manifest", "local-compile/首次编译.cmd"]);
const binaryFiles = new Set(["public/media-tracker-v2.ico", "public/media-tracker-256.png", "lib/app-themes/dark/Cached Theme.pak"]);
const textExtension = /\.(?:mjs|js|json|html|css|svg|md|txt|ps1|py|cs|cmd|vbs|manifest|yml|yaml)$/i;
const forbiddenParts = /^(?:data|node_modules|runtime|\.runtime|\.cache|verification|history|release|tools|components|__pycache__|\.qa-data|\.qa-output)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function permittedSourcePath(relative) {
  if (typeof relative !== "string" || !relative || /[\\:\0]/.test(relative) || relative.startsWith("/")) return false;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || forbiddenParts.test(part))) return false;
  if (roots.has(relative) || binaryFiles.has(relative)) return true;
  if (relative.startsWith("scripts/")) return scripts.has(relative.slice(8));
  if (relative.startsWith("packaging/")) return packaging.has(relative.slice(10));
  return /^(?:lib|public|test|\.github|docs)\//.test(relative) && textExtension.test(relative);
}

function safeRedactions(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid private fixture redaction configuration.");
  return value.map((item) => {
    if (!item || typeof item.original !== "string" || item.original.length < 3 || item.original.length > 100
      || typeof item.replacement !== "string" || !/^[a-z0-9_-]{3,80}$/i.test(item.replacement)) {
      throw new Error("Invalid private fixture redaction entry.");
    }
    return { ...item, regex: new RegExp(item.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") };
  });
}

export function inspectSourceText(text, { redactions = [] } = {}) {
  const findings = [];
  if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*$/m.test(text)) findings.push("private-key");
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(text)) findings.push("credential-token");
  if (/[a-z]:\\+(?:Users\\+[^\\\r\n"']+|Codex Project\\+)/i.test(text)) findings.push("private-workspace-path");
  for (const rule of safeRedactions(redactions)) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) findings.push("private-fixture-identifier");
  }
  return [...new Set(findings)];
}

async function regularDirectory(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  const info = await lstat(value);
  const actual = await realpath(value);
  if (!info.isDirectory() || info.isSymbolicLink() || actual.toLowerCase() !== path.resolve(value).toLowerCase()) {
    throw new Error(`${label} must be an ordinary directory without links.`);
  }
}

async function sourceFiles(root, { exported = false } = {}) {
  const files = [];
  async function visit(relative) {
    const filename = path.join(root, ...relative.split("/"));
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error("Publication refuses symbolic links: " + relative);
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      if (!permittedSourcePath(relative)) throw new Error("Publication refuses unallowlisted files: " + relative);
      if (info.size > MAX_FILE_BYTES) throw new Error("Publication file exceeds the source size limit: " + relative);
      files.push(relative);
    } else throw new Error("Publication refuses nonregular files: " + relative);
  }
  if (exported) {
    for (const name of (await readdir(root)).sort()) {
      // Git's own metadata is never part of a published source manifest.
      if (name === ".git") continue;
      await visit(name);
    }
  } else {
    const available = new Set(await readdir(root));
    for (const name of [...roots].sort()) if (available.has(name)) await visit(name);
    for (const directory of ["lib", "public", "test", ".github", "docs"]) if (available.has(directory)) await visit(directory);
    for (const [directory, names] of [["scripts", scripts], ["packaging", packaging]]) {
      for (const name of [...names].sort()) {
        const relative = `${directory}/${name}`;
        try { await lstat(path.join(root, ...relative.split("/"))); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        await visit(relative);
      }
    }
  }
  return files.sort();
}

export async function auditGitHubSource({ directory, redactions = [] } = {}) {
  await regularDirectory(directory, "Publication directory");
  const records = [];
  for (const file of await sourceFiles(directory, { exported: true })) {
    const bytes = await readFile(path.join(directory, ...file.split("/")));
    if (!binaryFiles.has(file)) {
      if (bytes.includes(0)) throw new Error("Unexpected binary content in source: " + file);
      const findings = inspectSourceText(bytes.toString("utf8"), { redactions });
      if (findings.length) throw new Error("Publication privacy scan failed: " + file + " (" + findings.join(", ") + ")");
    }
    records.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const meta = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (meta.name !== "media-tracker-public" || meta.license !== "MIT") throw new Error("Only the independent MIT public edition can be published.");
  return { schemaVersion: 1, ok: true, version: meta.version, platform: "windows-x64", sourceDataIncluded: false,
    fileCount: records.length, totalBytes: records.reduce((sum, file) => sum + file.bytes, 0),
    fingerprint: createHash("sha256").update(JSON.stringify(records)).digest("hex"), files: records };
}

export async function exportGitHubSource({ root, output, redactions = [] } = {}) {
  await regularDirectory(root, "Source root");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "media-tracker-public" || metadata.license !== "MIT") {
    throw new Error("Only the independent MIT public source tree can be exported.");
  }
  if (!path.isAbsolute(output) || path.resolve(output) === path.resolve(root)) throw new Error("Publication output must be a fresh absolute directory.");
  await regularDirectory(path.dirname(output), "Publication parent");
  const relative = path.relative(root, output).replaceAll(path.sep, "/");
  if (["lib", "public", "test", "scripts", ".github", "docs"].some((name) => relative === name || relative.startsWith(name + "/"))) {
    throw new Error("Publication output cannot be inside a mapped source directory.");
  }
  const rules = safeRedactions(redactions);
  const files = await sourceFiles(root);
  const ready = [];
  let changedFixtures = 0;
  for (const file of files) {
    let bytes = await readFile(path.join(root, ...file.split("/")));
    if (!binaryFiles.has(file) && bytes.includes(0)) throw new Error("Unexpected binary content in source: " + file);
    if (file.startsWith("test/") && !binaryFiles.has(file)) {
      let text = bytes.toString("utf8");
      for (const rule of rules) text = text.replace(rule.regex, (match) => match === match.toUpperCase() ? rule.replacement.toUpperCase() : rule.replacement);
      if (text !== bytes.toString("utf8")) changedFixtures += 1;
      bytes = Buffer.from(text, "utf8");
    }
    if (!binaryFiles.has(file)) {
      const findings = inspectSourceText(bytes.toString("utf8"), { redactions });
      if (findings.length) throw new Error("Publication privacy scan failed before writing: " + file + " (" + findings.join(", ") + ")");
    }
    ready.push({ file, bytes });
  }
  await mkdir(output); // Existing source, data and previous publications are never overwritten.
  for (const { file, bytes } of ready) {
    const destination = path.join(output, ...file.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }
  return { ...(await auditGitHubSource({ directory: output, redactions })), anonymizedFixtureFiles: changedFixtures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const audit = args.includes("--audit");
    const configAt = args.indexOf("--private-redactions");
    const redactions = configAt >= 0 ? JSON.parse(await readFile(args[configAt + 1], "utf8")) : [];
    if (configAt >= 0) args.splice(configAt, 2);
    const positional = args.filter((arg) => arg !== "--audit");
    if (positional.length !== 1 || positional[0].startsWith("--")) throw new Error("Usage: export-github-source.mjs [--audit] output-directory [--private-redactions local-config.json]");
    const directory = path.resolve(positional[0]);
    const result = audit ? await auditGitHubSource({ directory, redactions })
      : await exportGitHubSource({ root: path.resolve(import.meta.dirname, ".."), output: directory, redactions });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
