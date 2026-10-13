import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCustomPlatform, normalizeCustomPlatforms, updateCustomPlatform } from "../lib/platform-registry.mjs";
import { discoverCustomMedia, runCustomSourceWorker } from "../lib/custom-sync.mjs";

test("public source requirements and worker contain no gallery-dl library integration", async () => {
  const requirements = await readFile(new URL("../scripts/source-engines-requirements.txt", import.meta.url), "utf8");
  const worker = await readFile(new URL("../scripts/media-source-worker.py", import.meta.url), "utf8");
  assert.doesNotMatch(requirements, /^gallery-dl[=<>]/m);
  assert.match(requirements, /^yt-dlp==/m);
  assert.doesNotMatch(worker, /(?:from|import)\s+gallery_dl(?:[.\s]|$)/m);
  assert.doesNotMatch(worker, /def\s+gallery_collect\(/);
  assert.match(worker, /ytdlp_collect\(options, collector\)/);
});

test("public registry rejects new gallery definitions while preserving legacy configuration for explicit repair", () => {
  const fields = { label: "Example platform", homepageUrl: "https://example.com/" };
  assert.throws(() => createCustomPlatform({ ...fields, engine: "gallery-dl" }), /未集成 gallery-dl/);
  const enabled = createCustomPlatform(fields);
  const legacy = { ...enabled, engine: "gallery-dl" };
  assert.equal(normalizeCustomPlatforms([legacy])[0].engine, "gallery-dl", "legacy mode is never silently replaced");
  assert.throws(() => updateCustomPlatform(legacy, { label: "Renamed" }, [legacy]), /未集成 gallery-dl/);
  assert.equal(updateCustomPlatform(legacy, { engine: "yt-dlp" }, [legacy]).engine, "yt-dlp");
  assert.equal(createCustomPlatform({ ...fields, engine: "none" }).engine, "none");
});

test("gallery sync and direct worker calls stop before exporting credentials or starting an executable", async () => {
  let touched = 0;
  await assert.rejects(discoverCustomMedia({
    platform: { id: "custom-fixture", custom: true, engine: "gallery-dl", homepageUrl: "https://example.com/" },
    account: { profileUrl: "https://example.com/user" },
    sessionExporter: async () => { touched++; throw new Error("must not export"); },
    runWorker: async () => { touched++; throw new Error("must not execute"); },
  }), { code: "public-engine-not-integrated" });
  await assert.rejects(runCustomSourceWorker({ engine: "gallery-dl" }, {
    pythonPath: "never-access-this-missing-executable.exe",
  }), { code: "public-engine-not-integrated" });
  assert.equal(touched, 0);
});
