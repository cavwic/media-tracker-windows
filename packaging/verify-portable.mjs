import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, cp, stat, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preparePortableRuntime, portableRuntimeStatus, readRuntimeManifest } from "../lib/portable-runtime.mjs";
import { auditRelease } from "./audit-release.mjs";

const project = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const source = path.resolve(process.argv[2] || "");
const zipArgument = process.argv.indexOf("--zip");
const sourceZip = zipArgument >= 0 ? path.resolve(process.argv[zipArgument + 1] || "") : source + ".zip";
const cacheArgument = process.argv.indexOf("--publisher-cache");
const publisherCache = cacheArgument >= 0 ? path.resolve(process.argv[cacheArgument + 1] || "") : path.join(project, "packaging", ".cache");
if (path.dirname(source) !== path.join(project, "release")) throw new Error("Select a generated direct-child release fixture.");
const audited = await auditRelease({ directory: source, zip: sourceZip, sourceRoot: project });
assert.ok(!(await readdir(source)).includes("data"), "Release must have no author data");
assert.ok(!(await readdir(source)).includes("采集工具.exe"), "Release is user-compiled, not precompiled");
const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-real-portable-test-"));
const root = path.join(temporary, "便携编译 空格路径");
const reportDirectory = path.join(project, "packaging", "verification");
await mkdir(reportDirectory, { recursive: true });
const proof = { source: path.basename(source), compiled: false, cleaned: false, privateDataIncluded: false,
  standaloneEnvironment: false, nodeBootstrapVerified: false, runtimePrepared: false, runtimeDownloads: 0,
  windowStarted: false, repeatLaunch: false, fullExit: false, screenshots: [], checks: [],
  sourceVerified: audited.ok, sourceFingerprint: audited.sourceTreeSha256, zipSha256: audited.zipSha256 };
let native, browser, baseURL, expectedKey, sessionToken;
async function waitUntil(callback, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await callback()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function get(portPath) {
  const response = await fetch(baseURL + portPath, { signal: AbortSignal.timeout(1000),
    headers: sessionToken ? { "X-Media-Tracker-Token": sessionToken } : {} });
  if (!response.ok) throw new Error("Fixture API failed " + response.status);
  return response.json();
}
async function exitOwnedService() {
  const runtime = await get("/api/runtime/status");
  assert.equal(runtime.instanceKey, expectedKey, "Never close an unrelated tool");
  await fetch(baseURL + "/api/runtime/exit", { method: "POST",
    body: JSON.stringify({ confirm: true }), headers: { Origin: baseURL, "Content-Type": "application/json", "X-Media-Tracker-Token": sessionToken }, signal: AbortSignal.timeout(10_000) });
  await waitUntil(async () => { try { await get("/api/runtime/status"); return false; } catch { return true; } }, "Owned service did not exit");
}
try {
  await cp(source, root, { recursive: true, errorOnExist: true, force: false });
  const release = JSON.parse(await readFile(path.join(root, "release-manifest.json"), "utf8"));
  proof.version = release.version;
  proof.versionLabel = release.versionLabel || release.version;
  proof.edition = release.edition || "standard";
  if (proof.edition === "minimal") {
    assert.ok(!release.files.some((file) => file.file === "runtime/node/node.exe"), "Minimal ZIP must not carry a prepared Node runtime");
    assert.equal(release.node.bundled, false);
    const descriptor = JSON.parse(await readFile(path.join(root, "components", "bootstrap-node.json"), "utf8"));
    const archive = path.join(publisherCache, path.posix.basename(new URL(descriptor.archiveURL).pathname));
    const windowsRoot = process.env.SystemRoot || "C:\\Windows";
    const compiler = path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const probe = path.join(root, ".node-bootstrap-probe.exe");
    await run(compiler, ["/nologo", "/target:exe", "/main:NodeBootstrapProbe", "/platform:x64", "/optimize+", "/utf8output",
      "/reference:System.Windows.Forms.dll", "/reference:System.Runtime.Serialization.dll", "/reference:System.Drawing.dll",
      "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll", "/out:" + probe,
      path.join(root, "compile", "Launcher.cs"), path.join(project, "packaging", "verify-node-bootstrap.cs")],
      { cwd: root, windowsHide: true, timeout: 30_000 });
    const validated = await run(probe, [archive], { cwd: root, windowsHide: true, timeout: 30_000 });
    assert.match(validated.stdout, /pinned-node-archive-prepared-and-validated/);
    await rm(probe); // Exactly the verification executable, never application files.
    proof.nodeBootstrapVerified = true;
    proof.checks.push("actual native bootstrap official ZIP and Node receipt checks", "no system Node fallback");
  }
  if ((await readdir(path.join(root, "components"))).includes("runtime-manifest.json")) {
    const initial = await portableRuntimeStatus({ root });
    assert.equal(initial.ready, false, "Slim release must not contain already prepared runtime");
    const manifest = await readRuntimeManifest(root);
    const expectedBytes = manifest.components.reduce((total, component) => total + (component.downloadBytes || component.maxDownloadBytes)
      + (component.wheels || []).reduce((sum, wheel) => sum + (wheel.downloadBytes || wheel.maxDownloadBytes), 0), 0);
    assert.equal(initial.totalDownloadBytes, expectedBytes);
    const cached = new Map();
    for (const component of manifest.components) {
      const filename = component.id === "chromium" ? `chrome-win64-${component.version}.zip`
        : path.posix.basename(new URL(component.archiveURL).pathname);
      cached.set(component.archiveURL, path.join(publisherCache, filename));
      for (const wheel of component.wheels || []) cached.set(wheel.archiveURL,
        path.join(publisherCache, path.posix.basename(new URL(wheel.archiveURL).pathname)));
    }
    const fetcher = process.argv.includes("--use-verified-cache") ? async (url, options) => {
      const filename = cached.get(String(url));
      assert.ok(filename, "Fixture fetcher accepts only publisher-pinned URLs");
      options.signal?.throwIfAborted();
      proof.runtimeDownloads += 1;
      return new Response(Readable.toWeb(createReadStream(filename)), { status: 200,
        headers: { "content-length": String((await stat(filename)).size) } });
    } : async (url, options) => { proof.runtimeDownloads += 1; return fetch(url, options); };
    const prepared = await preparePortableRuntime({ root, confirmed: true, fetcher });
    assert.equal(prepared.ready, true);
    assert.equal(proof.runtimeDownloads, manifest.components.reduce((sum, component) => sum + 1 + (component.wheels || []).length, 0));
    const checkedAgain = await preparePortableRuntime({ root, confirmed: true,
      fetcher: () => { throw new Error("Complete runtime must never be downloaded again"); } });
    assert.equal(checkedAgain.ready, true);
    proof.runtimePrepared = true;
    proof.checks.push("pinned original runtime archives", "real embedded Python isolated imports", "no repeated runtime downloads");
  }
  expectedKey = createHash("sha256").update(`${path.join(root, "app").toLowerCase()}\0${path.join(root, "data").toLowerCase()}`).digest("hex");
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const cleanEnvironment = { ...process.env, MEDIA_TRACKER_PORT: "1",
    PATH: [path.join(windowsRoot, "System32"), windowsRoot, path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter),
    MEDIA_TRACKER_PORTABLE_ROOT: path.join(temporary, "stale-root"), MEDIA_TRACKER_DATA_DIR: path.join(temporary, "stale-data"),
    PYTHONHOME: path.join(temporary, "stale-python"), PYTHONPATH: path.join(temporary, "stale-pythonpath") };
  native = spawn(path.join(windowsRoot, "System32", "cmd.exe"), ["/d", "/c", path.join(root, "首次编译.cmd")],
    { cwd: root, env: cleanEnvironment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  native.stdout.on("data", (chunk) => { output += chunk.toString(); });
  native.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitUntil(() => native.exitCode !== null, "Real first-run CMD failed to finish");
  assert.equal(native.exitCode, 0, output);
  assert.ok((await stat(path.join(root, "采集工具.exe"))).size > 0);
  proof.compiled = true;
  await waitUntil(async () => {
    const names = await readdir(root);
    return !names.includes("首次编译.cmd") && !names.includes("compile");
  }, "Successful first-run cleanup did not finish", 10_000);
  const remaining = await readdir(root);
  assert.ok(!remaining.includes("首次编译.cmd") && !remaining.includes("compile"));
  proof.cleaned = true;
  assert.match(output, /Application startup was confirmed/);
  await waitUntil(async () => {
    for (const port of [4178, ...Array.from({ length: 10 }, (_, index) => 43178 + index)]) {
      try {
        const candidate = `http://127.0.0.1:${port}`;
        const response = await fetch(candidate + "/api/runtime/status", { signal: AbortSignal.timeout(300), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const running = await response.json();
        if (running.instanceKey === expectedKey && running.applicationId === "media-tracker-public") { baseURL = candidate; return true; }
      } catch {}
    }
    return false;
  }, "Could not locate this exact public package service");
  const session = await get("/api/session");
  assert.equal(session.header, "X-Media-Tracker-Token");
  assert.equal(session.applicationId, "media-tracker-public");
  assert.match(session.token, /^[a-f0-9]{64}$/);
  sessionToken = session.token;
  const runtime = await get("/api/runtime/status");
  assert.equal(runtime.instanceKey, expectedKey);
  assert.equal(runtime.release?.buildId, release.buildId, "The running service must be this exact new build, not an older instance");
  assert.equal(runtime.release?.sourceFingerprint, release.source.fingerprint);
  assert.equal(runtime.release?.version, release.version);
  proof.buildId = runtime.release.buildId;
  proof.checks.push("current source and independent ZIP bytes verified", "actual service build ID and source fingerprint verified");
  assert.equal(runtime.windowOpen, true);
  proof.windowStarted = true;
  const state = await get("/api/state");
  assert.deepEqual(state.persons, []); assert.deepEqual(state.linkedAccounts, []);
  assert.equal(state.runtime.release.buildId, release.buildId);
  assert.equal(state.features?.dedup?.edition, proof.edition);
  assert.equal(state.features?.dedup?.available, proof.edition !== "minimal");
  const tools = await get("/api/tools/dedup");
  assert.equal(tools.ready, false, "No developer FFmpeg/PATH allowed");
  assert.equal(tools.installAvailable, true);
  assert.equal(tools.defaultInstallDirectory, path.join(root, "tools"));
  assert.ok(!(await readdir(temporary)).some((name) => name.startsWith("stale-")));
  proof.standaloneEnvironment = true;
  const repeat = spawn(path.join(root, "采集工具.exe"), [], { cwd: temporary, env: cleanEnvironment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let repeatOutput = "";
  repeat.stdout.on("data", (chunk) => { repeatOutput += chunk.toString(); });
  repeat.stderr.on("data", (chunk) => { repeatOutput += chunk.toString(); });
  await waitUntil(() => repeat.exitCode !== null, "Repeat launch did not forward to existing app");
  assert.equal(repeat.exitCode, 0, repeatOutput); assert.equal((await get("/api/runtime/status")).windowOpen, true);
  proof.repeatLaunch = true;
  browser = await chromium.launch({ headless: true, executablePath: path.join(root, "runtime", "browsers", "chromium-1234", "chrome-win64", "chrome.exe") });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: "dark" });
  await page.goto(baseURL);
  for (const name of ["app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "index.html"]) {
    const resource = await fetch(baseURL + (name === "index.html" ? "/" : "/" + name), { signal: AbortSignal.timeout(5000) });
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("x-media-tracker-build"), release.buildId, "Assets must be served by the verified new service");
    const actual = createHash("sha256").update(Buffer.from(await resource.arrayBuffer())).digest("hex");
    const entry = release.files.find((file) => file.file === "app/public/" + name);
    assert.equal(actual, entry.sha256, `Actual served ${name} must match the current source`);
  }
  await page.locator("#window-chrome").waitFor({ state: "attached" });
  await page.locator("#appearance-toolbar").waitFor({ state: "visible" });
  for (const mode of ["system", "light", "dark"]) assert.equal(await page.locator(`#theme-control input[value="${mode}"]`).count(), 1);
  for (const mode of ["light", "dark", "system"]) {
    await page.locator("#theme-menu-button").click();
    await page.locator(`#theme-control label:has(input[value="${mode}"])`).click();
    await page.waitForFunction((mode) => document.querySelector(`#theme-control input[value="${mode}"]`).checked, mode);
    await page.waitForFunction((mode) => document.documentElement.dataset.theme === (mode === "system" ? "dark" : mode), mode);
    await page.locator("#theme-menu").waitFor({ state: "hidden" });
  }
  const frameDigest = createHash("sha256").update(await readFile(path.join(root, "app", "scripts", "windows-app-frame.cs"))).digest("hex");
  assert.ok((await stat(path.join(root, "data", "native-app-frame", `app-frame-${frameDigest}.exe`))).size > 0,
    "The new native window frame must actually be prepared by this launch");
  proof.checks.push("HTTP-loaded UI/language/theme bytes match new ZIP", "new window frame and all theme modes present");
  const rejectedDownloads = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/features/dedup/install") rejectedDownloads.push(request.url());
  });
  if (proof.edition === "minimal") {
    const unavailable = page.locator("#dedup-all-button");
    await unavailable.waitFor();
    assert.equal(await unavailable.getAttribute("aria-disabled"), "true");
    assert.equal(await unavailable.evaluate((element) => element.disabled), false, "Gray installation offer must remain reachable");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await unavailable.focus(); await page.keyboard.press("Enter");
      await page.locator("#confirm-dialog[open]").waitFor();
      assert.match(await page.locator("#confirm-title").textContent(), /去重|[Dd]edup/);
      const screenshot = path.join(reportDirectory, `minimal-offer-${theme}.png`);
      await page.screenshot({ path: screenshot }); proof.screenshots.push(path.basename(screenshot));
      await page.locator("#confirm-cancel").click();
      await page.locator("#confirm-dialog[open]").waitFor({ state: "hidden" });
      // Native dialog close is dispatched asynchronously. Wait for the
      // existing offer to settle before exercising another keyboard action.
      await page.waitForFunction(() => document.querySelector("#dedup-all-button").getAttribute("aria-busy") === "false");
    }
    assert.equal(rejectedDownloads.length, 0);
    assert.equal((await get("/api/features/dedup")).installing, false);
    assert.equal((await get("/api/dedup-status")).status, "idle");
    proof.checks.push("minimal gray keyboard-accessible dedup offer", "declining download performs no installation or media operation");
  }
  await page.locator('[data-view="settings"]').click();
  await page.locator('#language-menu-button').click();
  await page.locator('#language-control label:has(input[value="en"])').click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.match(await page.locator('#dedup-tools-settings').textContent(), /[Dd]edup|[Tt]ools|[Cc]omponent/);
  await page.locator('#language-menu-button').click();
  await page.locator('#language-control label:has(input[value="zh"])').click();
  await page.waitForFunction(() => document.documentElement.lang.startsWith("zh"));
  proof.checks.push("current language assets and settings work in the packaged app");
  await page.locator("#dedup-tools-settings").click();
  await page.locator("#dedup-tools-dialog[open]").waitFor();
  assert.match(await page.locator("#dedup-tools-status").textContent(), /FFmpeg|ffprobe/);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const screenshot = path.join(reportDirectory, `${proof.edition}-tools-${theme}.png`);
    await page.screenshot({ path: screenshot }); proof.screenshots.push(path.basename(screenshot));
  }
  await page.locator("#dedup-tools-cancel").click();
  await page.close(); await browser.close(); browser = undefined;
  await exitOwnedService(); proof.fullExit = true;
  // Start only the generated EXE after compiler source cleanup; then stop its
  // exact instance through the same normal, complete shutdown path.
  const restarted = spawn(path.join(root, "采集工具.exe"), [], { cwd: temporary, env: cleanEnvironment, shell: false, windowsHide: true });
  await waitUntil(async () => (await get("/api/runtime/status")).windowOpen, "EXE alone did not restart");
  sessionToken = (await get("/api/session")).token;
  await exitOwnedService();
  await waitUntil(() => restarted.exitCode !== null, "Native launcher remained after complete shutdown");
  assert.equal(restarted.exitCode, 0);
  proof.checks.push("actual CMD self-deletion", "standalone Node and Python environment", "no author data", "missing-tool preflight", "repeat launch", "EXE-only restart and complete exit");
  await writeFile(path.join(reportDirectory, `portable-smoke-${proof.edition}.json`), JSON.stringify(proof, null, 2) + "\n");
  await writeFile(path.join(reportDirectory, "portable-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  const logs = {};
  const logDirectory = path.join(root, "data", "startup-logs");
  for (const name of (await readdir(logDirectory).catch(() => [])).filter((name) => /\.(out|err)\.log$/.test(name))) {
    logs[name] = (await readFile(path.join(logDirectory, name), "utf8")).slice(-12_000);
  }
  await writeFile(path.join(reportDirectory, "portable-smoke-failure.json"), JSON.stringify({ ...proof, error: error.stack, logs }, null, 2) + "\n");
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (!proof.fullExit && baseURL) await exitOwnedService().catch(() => {});
  if (native && native.exitCode === null) native.kill();
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("collector-real-portable-test-")) throw new Error("Unsafe fixture cleanup");
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
}
