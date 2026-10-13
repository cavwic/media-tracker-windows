import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRelease } from "../packaging/audit-release.mjs";

// Maintainer-only helper. Credentials stay in memory, come from Git's existing
// credential helper, and are sent only to fixed HTTPS GitHub API hosts.
const repository = "cavwic/media-tracker-windows";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "inspect";
if (!["inspect", "create-repository", "configure-repository", "publish-release"].includes(mode)) {
  throw new Error("Usage: node scripts/publish-github.mjs inspect|create-repository|configure-repository|publish-release [ZIP] [SHA256SUMS] [release-notes]");
}
const credential = spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", windowsHide: true,
  env: { ...process.env, GCM_INTERACTIVE: "Never" },
});
if (credential.status !== 0) throw new Error("Sign in to GitHub using Git Credential Manager first.");
const fields = Object.fromEntries(credential.stdout.trim().split(/\r?\n/).map((line) => {
  const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)];
}));
if (!fields.password) throw new Error("No GitHub credential is available.");
const headers = {
  Authorization: "Bearer " + fields.password, Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "media-tracker-release",
};
credential.stdout = "";

async function request(route, { method = "GET", body, binary, upload = false, allowMissing = false } = {}) {
  const host = upload ? "https://uploads.github.com" : "https://api.github.com";
  if (!route.startsWith("/repos/" + repository + "/") && route !== "/repos/" + repository
    && route !== "/user" && route !== "/user/repos") throw new Error("Unexpected GitHub API route.");
  const response = await fetch(host + route, {
    method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}),
      ...(binary ? { "Content-Type": "application/octet-stream" } : {}) },
    body: binary || (body ? JSON.stringify(body) : undefined), redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (allowMissing && response.status === 404) return null;
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error("GitHub API returned HTTP " + response.status + ": " + String(result.message || "Request failed"));
  return result;
}
const profile = await request("/user");
if (profile.login !== repository.split("/")[0]) throw new Error("The authenticated GitHub owner does not match the release target.");
let repo = await request("/repos/" + repository, { allowMissing: true });
if (mode === "create-repository" && !repo) {
  repo = await request("/user/repos", { method: "POST", body: {
    name: repository.split("/")[1], private: false, auto_init: false,
    description: "Windows-only, local-first media collection, incremental sync, deduplication and source indexing. MIT open source.",
    has_issues: true, has_projects: false, has_wiki: false,
  } });
}
if (mode === "configure-repository") {
  if (!repo || repo.private || repo.full_name !== repository) throw new Error("The expected public repository must exist before configuration.");
  await request("/repos/" + repository + "/private-vulnerability-reporting", { method: "PUT" });
  await request("/repos/" + repository + "/topics", { method: "PUT", body: { names:
    ["windows", "local-first", "media-manager", "incremental-sync", "deduplication", "mit-license"] } });
  console.log(JSON.stringify({ repository: repo.html_url, privateVulnerabilityReporting:
    await request("/repos/" + repository + "/private-vulnerability-reporting") }));
  process.exit(0);
}
if (mode !== "publish-release") {
  console.log(JSON.stringify({ owner: profile.login, repository: repo?.html_url || null, public: repo ? !repo.private : null }));
  process.exit(0);
}
if (!repo || repo.private || repo.full_name !== repository) throw new Error("The expected public repository must exist before publishing.");
const metadata = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
if (metadata.name !== "media-tracker-public" || metadata.license !== "MIT") throw new Error("Only the independent MIT public edition can be released.");
const tag = "v" + metadata.version;
const [zipPath, sumsPath, notesPath] = process.argv.slice(3).map((filename) => filename && path.resolve(filename));
if (!zipPath || !sumsPath || !notesPath) throw new Error("ZIP, SHA256SUMS and release-notes paths are required.");
const versionLabel = "V" + metadata.version.split(".").slice(0, 2).join(".");
const expectedName = "采集工具-公开版-最小版-" + versionLabel;
if (path.basename(zipPath) !== expectedName + ".zip"
  || path.dirname(zipPath) !== path.join(project, "release")) throw new Error("Publish only this edition's current, local minimal release ZIP.");
const releaseDirectory = path.join(project, "release", expectedName);
const manifest = JSON.parse(await readFile(path.join(releaseDirectory, "release-manifest.json"), "utf8"));
if (manifest.version !== metadata.version || manifest.edition !== "minimal") throw new Error("The release manifest version or edition is incorrect.");
const audit = await auditRelease({ directory: releaseDirectory, zip: zipPath, sourceRoot: project });
if (!audit.ok || !audit.checks.source || !audit.checks.zip) throw new Error("Source and package privacy/integrity audit must pass before upload.");
const zip = await readFile(zipPath);
const sums = await readFile(sumsPath);
const checksum = createHash("sha256").update(zip).digest("hex");
if (!sums.toString("utf8").split(/\r?\n/).includes(checksum + "  " + path.basename(zipPath))) throw new Error("The release ZIP checksum does not match SHA256SUMS.");
const remoteTag = await request("/repos/" + repository + "/git/ref/tags/" + tag);
if (!remoteTag.object?.sha) throw new Error("Push and verify the source tag before publishing release assets.");
let release = await request("/repos/" + repository + "/releases/tags/" + tag, { allowMissing: true });
if (!release) release = await request("/repos/" + repository + "/releases", { method: "POST", body: {
  tag_name: tag, name: "Media Tracker " + tag + " · Windows x64", draft: true, prerelease: false,
  body: await readFile(notesPath, "utf8"),
} });
for (const [filename, buffer] of [[path.basename(zipPath), zip], [path.basename(sumsPath), sums]]) {
  const existing = release.assets?.find((asset) => asset.name === filename);
  const digest = "sha256:" + createHash("sha256").update(buffer).digest("hex");
  if (existing) {
    if (existing.size !== buffer.length || existing.digest !== digest) throw new Error("A different release asset already exists; no file was overwritten.");
    continue;
  }
  const asset = await request("/repos/" + repository + "/releases/" + release.id + "/assets?name=" + encodeURIComponent(filename), {
    method: "POST", binary: buffer, upload: true,
  });
  if (asset.size !== buffer.length || asset.digest !== digest) throw new Error("Uploaded release asset verification failed; release remains a draft.");
  console.log(JSON.stringify({ asset: filename, bytes: asset.size, digest: asset.digest }));
}
release = await request("/repos/" + repository + "/releases/" + release.id, { method: "PATCH", body: { draft: false, make_latest: "true" } });
console.log(JSON.stringify({ release: release.html_url, tag: release.tag_name, assets: release.assets.map(({ name, size, digest }) => ({ name, size, digest })) }));
