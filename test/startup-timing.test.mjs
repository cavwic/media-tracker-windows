import test from "node:test";
import assert from "node:assert/strict";
import { createStartupTiming } from "../lib/startup-timing.mjs";

test("startup timing records only fixed stages and rounded numeric durations", () => {
  const lines = [];
  const timing = createStartupTiming({ launchStartedAt: "1000", now: () => 1500,
    nodeElapsed: () => 123.6, write: (line) => lines.push(line) });
  timing("window.primary-page-ready", 42.4);
  assert.deepEqual(lines, ["[startup] window.primary-page-ready node=124ms launch=500ms phase=42ms"]);
  for (const invalid of ["https://example.test/", "person name", "stage\nsecret", "", {}, null, "a".repeat(81)]) {
    timing(invalid, 10);
  }
  assert.equal(lines.length, 1);
});

test("invalid launch timestamps and clocks cannot produce misleading elapsed durations", () => {
  for (const launchStartedAt of [undefined, "", "invalid", 0, -1, 2000, -Infinity]) {
    const lines = [];
    createStartupTiming({ launchStartedAt, now: () => 1500, nodeElapsed: () => 10,
      write: (line) => lines.push(line) })("service-listening", NaN);
    assert.equal(lines[0], "[startup] service-listening node=10ms");
  }
  const lines = [];
  createStartupTiming({ launchStartedAt: 1000, now: () => 3_601_000,
    nodeElapsed: () => -1, write: (line) => lines.push(line) })("modules-loaded", -2);
  assert.deepEqual(lines, ["[startup] modules-loaded"]);
});

test("diagnostic failures never break startup, including rejected asynchronous sinks", async () => {
  assert.doesNotThrow(() => createStartupTiming({ now: () => { throw Error("clock"); } })("modules-loaded"));
  assert.doesNotThrow(() => createStartupTiming({ nodeElapsed: () => { throw Error("timer"); } })("modules-loaded"));
  assert.doesNotThrow(() => createStartupTiming({ write: () => { throw Error("sink"); } })("modules-loaded"));
  createStartupTiming({ write: () => Promise.reject(Error("async sink")) })("modules-loaded");
  await new Promise((resolve) => setImmediate(resolve));
});
