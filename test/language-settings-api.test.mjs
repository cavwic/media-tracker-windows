import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");

async function fixture(t, { systemLanguage = "zh-CN", language } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "collector-language-settings-"));
  const data = path.join(root, "data");
  const profile = path.join(data, "browser-profiles", "x", "preserved-login");
  const folder = path.join(root, "archive", "Fixture");
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(folder, "Image"), { recursive: true });
  const mediaFile = path.join(folder, "Image", "preserved.jpg");
  const loginFile = path.join(profile, "Cookies-sentinel.txt");
  await writeFile(mediaFile, "fixture media bytes, no download or app opening");
  await writeFile(loginFile, "fixture login bytes, never clear or open the profile");
  const original = { version: 4, settings: { theme: "dark", ...(language ? { language } : {}),
    dedupTools: { directory: "fixture/tools" }, futureSetting: { keep: "unchanged" } },
    customPlatforms: [], recentPaths: [folder],
    linkedAccounts: [{ id: "preserved-login", platformId: "x", platformLabel: "X", label: "Preserved login",
      profileDirectory: profile, loginStatus: "verified", loginCheckedAt: "2026-01-01T00:00:00Z", loginMessage: "Preserved verified status" }],
    persons: [{ id: "person-fixture", name: "Fixture", note: "Preserved person", folderPath: folder,
      platforms: [], homepageUrl: "", homepageAnalysis: null }] };
  const statePath = path.join(data, "state.json");
  const indexPath = path.join(data, "sync-index.json");
  const indexBytes = JSON.stringify({ version: 3, layout: "person-v1", scopes: {
    "person-fixture:x:target": { initialComplete: true, scanCompletedAt: "2026-10-01T00:00:00Z",
      media: {}, hashes: {}, knownPosts: { preserved: "2026-09-01T00:00:00Z" }, pendingMedia: {} },
  }, summaries: {}, receipts: {}, storageInitialized: {} });
  await writeFile(statePath, JSON.stringify(original));
  await writeFile(indexPath, indexBytes);
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("collector-language-settings-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const start = async () => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { cwd: ROOT, windowsHide: true,
      env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(port),
        MEDIA_TRACKER_SYSTEM_UI_LANGUAGE: systemLanguage, MEDIA_TRACKER_NO_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const deadline = Date.now() + 10_000;
    while (!output.includes("Media Tracker 已启动：")) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Isolated language fixture failed to start. ${output}\n${errors}`);
      }
      await delay(10);
    }
    return child;
  };
  const api = async (pathname, method = "GET", body, requestOrigin = origin) => fetch(`${origin}${pathname}`, {
    method, headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
  });
  const unchangedData = async () => {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.persons, original.persons);
    for (const [key, value] of Object.entries(original.linkedAccounts[0])) assert.deepEqual(state.linkedAccounts[0][key], value, key);
    assert.deepEqual(state.recentPaths, original.recentPaths);
    assert.deepEqual(state.customPlatforms, original.customPlatforms);
    assert.deepEqual(state.settings.dedupTools, original.settings.dedupTools);
    assert.deepEqual(state.settings.futureSetting, original.settings.futureSetting);
    assert.equal(await readFile(indexPath, "utf8"), indexBytes, "UI settings must not change any incremental boundary or receipt");
    assert.equal(await readFile(mediaFile, "utf8"), "fixture media bytes, no download or app opening");
    assert.equal(await readFile(loginFile, "utf8"), "fixture login bytes, never clear or open the profile");
    return state;
  };
  return { api, start, unchangedData, statePath, original };
}

test("language-only settings persist, default to system, preserve theme/tools/people/login/media/boundaries, and survive restart", { timeout: 20_000 }, async (t) => {
  const setup = await fixture(t);
  const child = await setup.start();
  const state = await (await setup.api("/api/state")).json();
  assert.equal(state.settings.language, "system");
  assert.equal(state.runtime.systemLanguage, "zh");
  assert.equal(state.settings.theme, "dark");
  assert.equal((await (await setup.api("/api/runtime/status")).json()).systemLanguage, "zh");
  // A read-only default must not rewrite any of the user's stored data.
  assert.deepEqual(JSON.parse(await readFile(setup.statePath, "utf8")), setup.original);
  const english = await setup.api("/api/settings", "PUT", { language: "en" });
  assert.equal(english.status, 200);
  const settings = await english.json();
  assert.equal(settings.theme, "dark");
  assert.equal(settings.language, "en");
  await setup.unchangedData();
  const theme = await setup.api("/api/settings", "PUT", { theme: "light" });
  assert.equal(theme.status, 200);
  assert.equal((await theme.json()).language, "en", "the old theme-only API remains compatible");
  await setup.unchangedData();
  const closed = once(child, "exit");
  const response = await setup.api("/api/runtime/exit", "POST", { confirm: true });
  assert.equal(response.status, 202);
  assert.equal((await closed)[0], 0);
  await setup.start();
  const restarted = await (await setup.api("/api/state")).json();
  assert.equal(restarted.settings.language, "en");
  assert.equal(restarted.settings.theme, "light");
  await setup.unchangedData();
});

test("settings validation is atomic and parallel language/theme requests do not overwrite each other", { timeout: 15_000 }, async (t) => {
  const setup = await fixture(t, { systemLanguage: "ja-JP", language: "zh" });
  await setup.start();
  const before = await readFile(setup.statePath, "utf8");
  for (const body of [null, [], {}, { language: "fr" }, { language: false }, { language: "zh-CN" },
    { language: "en", theme: "invalid" }, { theme: "dark", unknown: true }, { language: { name: "en" } }]) {
    assert.equal((await setup.api("/api/settings", "PUT", body)).status, 400, JSON.stringify(body));
    assert.equal(await readFile(setup.statePath, "utf8"), before);
  }
  assert.equal((await setup.api("/api/settings", "PUT", { language: "en" }, "https://foreign.invalid")).status, 403);
  assert.equal(await readFile(setup.statePath, "utf8"), before);
  const result = await Promise.all([
    setup.api("/api/settings", "PUT", { language: "en" }),
    setup.api("/api/settings", "PUT", { theme: "light" }),
  ]);
  assert.deepEqual(result.map(({ status }) => status), [200, 200]);
  const state = await (await setup.api("/api/state")).json();
  assert.equal(state.runtime.systemLanguage, "en", "all non-Chinese system display languages default to English");
  assert.equal(state.settings.language, "en");
  assert.equal(state.settings.theme, "light");
  await setup.unchangedData();
  assert.equal((await setup.api("/api/settings", "PUT", { language: "SYSTEM", theme: "DARK" })).status, 200);
  assert.equal((await setup.unchangedData()).settings.language, "system");
});
