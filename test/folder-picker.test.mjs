import test from "node:test";
import assert from "node:assert/strict";
import { buildFolderPickerScript } from "../lib/folder-picker.mjs";

test("folder picker stays above the application and releases its owner", () => {
  const script = buildFolderPickerScript("D:\\媒体目录");
  assert.match(script, /\$owner\.TopMost = \$true/);
  assert.match(script, /\$dialog\.ShowDialog\(\$owner\)/);
  assert.match(script, /bool BringToFront/);
  assert.match(script, /FolderPickerWindow\]::Watch/);
  assert.match(script, /SetWindowPos/);
  assert.match(script, /\$dialog\.Dispose\(\)/);
  assert.match(script, /\$owner\.Dispose\(\)/);
});

test("folder picker safely embeds paths containing apostrophes", () => {
  const script = buildFolderPickerScript("D:\\Person's Media");
  assert.match(script, /D:\\Person''s Media/);
});
