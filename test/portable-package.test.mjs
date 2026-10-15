import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPortable, permittedPackagePath, renderReleaseInstructions } from "../packaging/build-portable.mjs";

test("release whitelist excludes all source private state and startup entries", () => {
  for (const entry of ["data/state.json", "data/browser-profiles/Cookies", ".runtime/venv", "start.cmd", "采集工具.lnk", "server.out.log", "test/a.mjs", "app/../data/state.json", "/app/server.mjs", "app/server.mjs:ads", "app\\private"]) assert.equal(permittedPackagePath(entry), false);
  for (const entry of ["app/server.mjs", "runtime/node/node.exe", "compile/Launcher.cs", "components/ffmpeg-package.json", "首次编译.cmd", "LICENSE", "README.md", "PUBLISHING.md", "PRIVACY.md", "PUBLIC-EDITION.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "docs/PUBLISHING.md", "docs/PRIVACY.md", "docs/PUBLIC-EDITION.md"]) assert.equal(permittedPackagePath(entry), true);
});

test("release instructions derive their public version from the single internal version", async () => {
  assert.equal(renderReleaseInstructions("本次发布 {{RELEASE_VERSION}}。", "1.0.0"), "本次发布 V1.0。");
  assert.equal(renderReleaseInstructions("本次发布 {{RELEASE_VERSION}}。", "1.12.0"), "本次发布 V1.12。");
  assert.throws(() => renderReleaseInstructions("没有版本占位", "1.0.0"));
  assert.throws(() => renderReleaseInstructions("{{RELEASE_VERSION}}{{RELEASE_VERSION}}", "1.0.0"));
  for (const name of ["portable-instructions.txt", "minimal-instructions.txt"]) {
    const template = await readFile(new URL("../packaging/" + name, import.meta.url), "utf8");
    const rendered = renderReleaseInstructions(template, "1.0.0");
    assert.match(rendered, /V1\.0/);
    assert.ok(!rendered.includes("{{RELEASE_VERSION}}"));
  }
});

test("user documentation stays concise while publication rules remain in the maintainer workflow", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const instructions = await readFile(new URL("../packaging/minimal-instructions.txt", import.meta.url), "utf8");
  for (const text of [readme, instructions]) {
    for (const heading of ["是什么", "能做什么", "怎么用"]) assert.ok(text.includes(heading), heading);
    assert.doesNotMatch(text, /公开最小版|最小公开版|本版内容|后续计划|版本与来源|release\/history/);
    assert.match(text, /Windows/);
    assert.match(text, /首次编译\.cmd/);
    assert.match(text, /未签名/);
    assert.match(text, /平台自动采集许可/);
  }
  const workflow = await readFile(new URL("../packaging/release-workflow.md", import.meta.url), "utf8");
  for (const required of ["更新最新版", "GitHub", "Release", "release/history", "不删除、不覆盖", "不得改动或重启自用版", "登录资料", "白名单", "SHA-256"]) assert.ok(workflow.includes(required), required);
});

test("optional component uses pinned provider, version and SHA, not mutable latest install", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packaging/ffmpeg-package.json", import.meta.url)));
  assert.equal(manifest.version, "9.0.2");
  assert.match(manifest.remoteURL, /^https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/ffmpeg-9\.0\.2-essentials_build\.zip$/);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test("portable packages carry both the Windows file-action script and its foreground helper source", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  const scriptList = build.match(/const scripts = \[([\s\S]*?)\];/)?.[1];
  assert.ok(scriptList);
  assert.match(scriptList, /"windows-file-action\.ps1"/);
  assert.match(scriptList, /"windows-media-open\.cs"/);
  assert.match(scriptList, /"windows-folder-open\.ps1"/);
  assert.match(scriptList, /"windows-app-frame\.cs"/);
  assert.match(scriptList, /"prepare-portable-runtime\.mjs"/);
});

test("portable packages include interface language assets and detector through their normal public/lib trees", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  assert.match(build, /copyTree\(path\.join\(project, name\), path\.join\(target, "app", name\)/);
  assert.match(build, /for \(const name of \["server\.mjs", "lib", "public", "package\.json", "package-lock\.json"\]\)/);
  for (const name of ["app/public/i18n.js", "app/public/i18n-dynamic.js", "app/lib/ui-language.mjs"]) assert.equal(permittedPackagePath(name), true);
  for (const name of ["app/lib/app-titlebar-theme.mjs", "app/lib/app-themes/light/manifest.json", "app/lib/app-themes/dark/manifest.json", "app/scripts/windows-folder-open.ps1", "app/lib/app-window-frame.mjs", "app/scripts/windows-app-frame.cs"]) assert.equal(permittedPackagePath(name), true);
});

test("independent public release permits only the minimal bootstrap and omits unused browser helpers", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  assert.match(build, /includeRuntime = false/);
  assert.match(build, /minimal = true/);
  assert.match(build, /minimal !== true \|\| includeRuntime !== false/);
  assert.match(build, /public edition is minimal-only/);
  assert.match(build, /includeRuntime: process\.argv\.includes\("--full"\)/);
  assert.match(build, /const browserDirectories = \[\]/);
  assert.doesNotMatch(build, /`ffmpeg-\$\{ffmpeg\.revision\}`/);
  assert.doesNotMatch(build, /"winldd-1007"/);
  assert.match(build, /if \(!includeRuntime\).*"runtime-manifest\.json"/);
});

test("public builder rejects standard/offline editions before creating or downloading anything", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  await assert.rejects(buildPortable({ minimal: false }), /minimal-only/);
  await assert.rejects(buildPortable({ includeRuntime: true }), /minimal-only/);
});

test("public package includes legal docs and records exact public identity without reusing private data", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  assert.match(build, /packageMetadata\.name !== "media-tracker-public"/);
  assert.match(build, /packageMetadata\.license !== "MIT"/);
  assert.match(build, /"PUBLISHING\.md", "PRIVACY\.md", "PUBLIC-EDITION\.md"/);
  assert.match(build, /"LICENSE", file: "LICENSE"/);
  assert.match(build, /external publisher cache is read-only/);
  assert.match(build, /allowBuildDownload = false/);
  const manifest = JSON.parse(await readFile(new URL("../packaging/runtime-manifest.json", import.meta.url)));
  const python = manifest.components.find((item) => item.id === "python");
  assert.equal(python.wheels.length, 6);
  assert.ok(python.wheels.every((wheel) => !/gallery/.test(wheel.name) && wheel.licenseFiles?.length));
  assert.ok(manifest.components.find((item) => item.id === "chromium").requiredFiles.includes("chrome-win64/ABOUT"));
});

test("minimal edition defers only its independent Node runtime and gates optional dedup without removing collection code", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  const bootstrap = JSON.parse(await readFile(new URL("../packaging/bootstrap-node.json", import.meta.url), "utf8"));
  assert.match(build, /minimal = true/);
  assert.match(build, /minimal: !process\.argv\.includes\("--standard"\)/);
  assert.match(build, /if \(!minimal\) await copyTree\(path\.join\(nodeSource, "node\.exe"\)/);
  assert.match(build, /edition: minimal \? "minimal" : "standard"/);
  assert.match(build, /dedup: minimal \? "on-demand" : "included"/);
  assert.match(build, /"bootstrap-node\.json"/);
  assert.match(build, /minimal !== true \|\| includeRuntime !== false/);
  assert.match(build, /minimal && zipBytes > 8 \* 1024 \* 1024/);
  assert.equal(bootstrap.schemaVersion, 1);
  assert.equal(bootstrap.id, "node");
  assert.equal(bootstrap.platform, "win32-x64");
  assert.equal(bootstrap.archiveURL, "https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip");
  assert.equal(bootstrap.archiveSha256, "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70");
  assert.equal(bootstrap.archiveBytes, 36358527);
  assert.ok(bootstrap.maxArchiveBytes >= bootstrap.archiveBytes && bootstrap.maxArchiveBytes <= 100 * 1024 * 1024);
});
