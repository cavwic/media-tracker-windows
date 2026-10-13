import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifySystemUiLanguage, normalizeUiLanguage, createSystemLanguageProvider } from "../lib/ui-language.mjs";

test("system display languages select Chinese only for Chinese language tags", () => {
  for (const tag of ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hans", "zh-Hant-TW", "ZH_cn", " zh-SG "]) {
    assert.equal(classifySystemUiLanguage(tag), "zh", tag);
  }
  for (const tag of ["en", "en-US", "ja-JP", "fr-FR", "de", "ar-SA", "yue-HK"]) {
    assert.equal(classifySystemUiLanguage(tag), "en", tag);
  }
  for (const value of [undefined, null, "", {}, 1033, "zh!", "zh-cn\nsecret", "zh-CN; Start-Process", "zh--CN"]) {
    assert.equal(classifySystemUiLanguage(value), null);
  }
  for (const value of ["system", "zh", "en"]) assert.equal(normalizeUiLanguage(value), value);
  for (const value of [undefined, null, {}, "en-US", "ZH", "browser", ""]) assert.equal(normalizeUiLanguage(value), "system");
});

test("Windows launcher UI culture is immediate and does not start another process", async () => {
  for (const [tag, expected] of [["zh-CN", "zh"], ["zh-TW", "zh"], ["en-US", "en"], ["ja-JP", "en"]]) {
    let called = false;
    const provider = createSystemLanguageProvider({ environment: { MEDIA_TRACKER_SYSTEM_UI_LANGUAGE: tag }, platform: "win32",
      execute: async () => { called = true; throw new Error("must not start a helper"); } });
    assert.equal(provider.language, expected);
    assert.equal(await provider.ready, expected);
    assert.equal(called, false);
  }
});

test("direct Windows startup probes once, asynchronously, hidden, bounded, and without browser locale", async () => {
  let complete;
  const response = new Promise((resolve) => { complete = resolve; });
  const calls = [];
  const provider = createSystemLanguageProvider({ environment: {}, platform: "win32",
    nativeLocale: () => { throw new Error("Windows UI must not be inferred from formatting/browser locale"); },
    execute: async (...args) => { calls.push(args); return response; } });
  assert.equal(provider.language, null, "constructing a provider must not block startup");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, "powershell.exe");
  assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(args.at(-1), /GetUserDefaultUILanguage/);
  assert.doesNotMatch(args.at(-1), /http|browser-profiles|Set-Culture|Set-Win|Set-ItemProperty|reg\.exe|Start-Process/i);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 3_000);
  complete({ stdout: "zh\r\n" });
  assert.equal(await provider.ready, "zh");
  assert.equal(provider.language, "zh");
  assert.equal(provider.language, "zh");
  assert.equal(calls.length, 1, "API polling reads the resolved value without rerunning PowerShell");
});

test("failed or malformed Windows UI detection remains unknown and never produces an unhandled rejection", async () => {
  for (const execute of [async () => { throw new Error("fixture timeout"); }, async () => ({ stdout: "error: zh" })]) {
    const provider = createSystemLanguageProvider({ environment: {}, platform: "win32", execute });
    assert.equal(await provider.ready, null);
    assert.equal(provider.language, null);
  }
});

test("both ordinary Windows launchers pass only a scoped child UI language without an extra detector", async () => {
  const hidden = await readFile(new URL("../scripts/start-hidden.ps1", import.meta.url), "utf8");
  const portable = await readFile(new URL("../packaging/local-compile/Launcher.cs", import.meta.url), "utf8");
  assert.match(hidden, /EnvironmentVariables\['MEDIA_TRACKER_SYSTEM_UI_LANGUAGE'\]\s*=\s*\(Get-UICulture\)\.Name/);
  assert.match(portable, /EnvironmentVariables\["MEDIA_TRACKER_SYSTEM_UI_LANGUAGE"\]\s*=\s*System\.Globalization\.CultureInfo\.CurrentUICulture\.Name/);
  assert.doesNotMatch(hidden, /\$env:MEDIA_TRACKER_SYSTEM_UI_LANGUAGE\s*=/i);
  assert.doesNotMatch(portable, /SetEnvironmentVariable\("MEDIA_TRACKER_SYSTEM_UI_LANGUAGE"/);
});
