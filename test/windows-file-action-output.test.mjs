import test from "node:test";
import assert from "node:assert/strict";
import { parseWindowsFileActionOutput } from "../lib/windows-file-action.mjs";

test("Windows file action reports launched and verified foreground independently", () => {
  assert.deepEqual(parseWindowsFileActionOutput("launched=true\r\nforeground=true\r\nreason=foreground\r\n"),
    { launched: true, foreground: true, reason: "foreground" });
  assert.deepEqual(parseWindowsFileActionOutput("launched=true\nforeground=false\nreason=user-switched"),
    { launched: true, foreground: false, reason: "user-switched" });
  assert.deepEqual(parseWindowsFileActionOutput("launched=true\nforeground=false\nreason=target-ambiguous"),
    { launched: true, foreground: false, reason: "target-ambiguous" });
});

test("legacy reveal output remains compatible and unrelated messages cannot imply activation", () => {
  assert.deepEqual(parseWindowsFileActionOutput("launched=true\nforeground=true"), { launched: true, foreground: true });
  assert.deepEqual(parseWindowsFileActionOutput("Could not report launched=true or foreground=true"),
    { launched: false, foreground: false });
  assert.deepEqual(parseWindowsFileActionOutput(null), { launched: false, foreground: false });
});

test("conflicting fields and non-machine reasons are not accepted", () => {
  assert.deepEqual(parseWindowsFileActionOutput("launched=true\nforeground=true\nforeground=false\nreason=other window title"),
    { launched: true, foreground: false });
  assert.deepEqual(parseWindowsFileActionOutput("launched=false\nlaunched=true\nforeground=false\nreason=timeout"),
    { launched: false, foreground: false, reason: "timeout" });
});
