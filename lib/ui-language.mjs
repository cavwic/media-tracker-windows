import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const UI_LANGUAGES = new Set(["system", "zh", "en"]);

export function normalizeUiLanguage(value) {
  return UI_LANGUAGES.has(value) ? value : "system";
}

/** Map the Windows display-language tag, not a browser or formatting locale. */
export function classifySystemUiLanguage(value) {
  if (typeof value !== "string") return null;
  const tag = value.trim().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) return null;
  return /^zh(?:-|$)/i.test(tag) ? "zh" : "en";
}

// Used only by direct `node server.mjs` startup. The ordinary Windows launchers
// already know their current UI culture and pass it to this service process.
// This fixed ASCII script does not read browser profiles or mutate Windows.
const WINDOWS_UI_LANGUAGE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class MediaTrackerUiLanguageNative { [DllImport(\"kernel32.dll\")] public static extern ushort GetUserDefaultUILanguage(); }'",
  "$collectorUiLanguageId = [MediaTrackerUiLanguageNative]::GetUserDefaultUILanguage()",
  "if ($collectorUiLanguageId -eq 0x1400) { (Get-UICulture).Name } elseif (($collectorUiLanguageId -band 0x03ff) -eq 4) { 'zh' } else { 'en' }",
].join("; ");

/** A single asynchronous, bounded probe; never blocks service/UI startup. */
export function createSystemLanguageProvider({
  environment = process.env,
  platform = process.platform,
  execute = executeFile,
  nativeLocale = () => Intl.DateTimeFormat().resolvedOptions().locale,
} = {}) {
  let language = classifySystemUiLanguage(environment.MEDIA_TRACKER_SYSTEM_UI_LANGUAGE);
  const ready = language !== null ? Promise.resolve(language)
    : platform !== "win32" ? Promise.resolve().then(() => {
      language = classifySystemUiLanguage(nativeLocale());
      return language;
    }).catch(() => null)
      : Promise.resolve().then(async () => {
        const { stdout } = await execute("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_UI_LANGUAGE_SCRIPT,
        ], { windowsHide: true, encoding: "utf8", timeout: 3_000, maxBuffer: 4_096 });
        language = classifySystemUiLanguage(stdout);
        return language;
      }).catch(() => null);
  return { get language() { return language; }, ready };
}
