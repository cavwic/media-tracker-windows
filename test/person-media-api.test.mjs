import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from "node:fs/promises";
import { openPersonMediaIndex, clearPersonMediaIndexCache } from "../lib/person-media-index.mjs";

function waitForServiceStartup(child, timeoutMs = 10_000) {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrors);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (message) => {
      cleanup();
      reject(new Error(`${message}\nstdout: ${output}\nstderr: ${errors}`));
    };
    const onOutput = (chunk) => {
      output = (output + chunk).slice(-65_536);
      if (!output.includes("已启动")) return;
      cleanup();
      resolve(output);
    };
    const onErrors = (chunk) => { errors = (errors + chunk).slice(-65_536); };
    const onError = (error) => fail(`Test service failed to start: ${error.message}`);
    const onExit = (code, signal) => fail(`Test service exited before startup (${code}, ${signal ?? "no signal"})`);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrors);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => fail("Test service startup timed out"), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

test("media APIs query all sources, preserve settings and reject missing or foreign assets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-media-api-"));
  const data = path.join(root, "data");
  const person = { id: "fixture-person", name: "Fixture", folderPath: path.join(root, "Person"), platforms: [] };
  const state = { version: 4, persons: [person], linkedAccounts: [], customPlatforms: [], settings: { theme: "dark",
    publicReleaseUse: { version: 1, acceptedAt: "2026-10-12T00:00:00Z" } }, recentPaths: [] };
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "state.json"), JSON.stringify(state));
  // Prepare entirely local files before the service starts; no extractor or
  // external network is used and no actual Windows default app is launched.
  const index = await openPersonMediaIndex(person, { create: true });
  const bytes = Buffer.from("local exact duplicate fixture");
  const mediaId = createHash("sha256").update(bytes).digest("hex");
  const partialPath = path.join(person.folderPath, ".api-fixture.part");
  await writeFile(partialPath, bytes);
  await index.commitDownloaded({ partialPath, sha256: mediaId, bytes: bytes.length, extension: ".jpg", mediaKind: "image",
    source: { platformId: "x", platformLabel: "X", accountId: "removed-account-a", accountLabel: "A", logicalKey: "post-a:0", postId: "post-a", postUrl: "https://x.com/a/status/1", createdAt: null } });
  await index.addSource(mediaId, { platformId: "instagram", platformLabel: "Instagram", accountId: "removed-account-b", accountLabel: "B", logicalKey: "post-b:0", postId: "post-b", postUrl: "https://www.instagram.com/p/fixture/", createdAt: "2026-10-01T00:00:00Z" });
  await index.compact();
  const socket = http.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MEDIA_TRACKER_DATA_DIR: data, MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    clearPersonMediaIndexCache(person.id);
    await rm(root, { recursive: true, force: true });
  });
  assert.match(await waitForServiceStartup(child), /已启动/);
  const api = (suffix, method = "GET", body) => fetch(`${origin}/api/persons/${person.id}/${suffix}`, { method,
    headers: { Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await api("open-folder", "POST", { path: "C:\\arbitrary" })).status, 400,
    "folder opening never accepts a client-supplied path");
  assert.equal((await fetch(`${origin}/api/persons/missing/open-folder`, { method: "POST", headers: { Origin: origin } })).status, 404);
  assert.equal((await fetch(`${origin}/api/persons/${person.id}/open-folder`, { method: "POST", headers: { Origin: "https://untrusted.example" } })).status, 403,
    "a foreign page cannot launch Explorer");
  assert.equal((await api("open-folder")).status, 404, "merely loading a URL cannot open Explorer");
  const listing = await (await api("media?limit=1&offset=0")).json();
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].mediaId, mediaId);
  assert.equal(listing.items[0].sourceCount, 2);
  assert.equal((await (await api(`media?query=${mediaId.slice(0, 8)}`)).json()).total, 1);
  assert.equal((await (await api("media?query=missing-name")).json()).total, 0);
  assert.equal((await api("media?offset=-1")).status, 400);
  assert.equal((await api("media?limit=99999")).status, 400);
  const provenance = await (await api(`media/${mediaId}/sources`)).json();
  assert.equal(provenance.mediaId, mediaId);
  assert.deepEqual(provenance.sources.map(({ accountId }) => accountId).sort(), ["removed-account-a", "removed-account-b"]);
  for (const source of provenance.sources) {
    assert.equal(source.sourceKey, JSON.stringify([source.platformId, source.accountId, source.logicalKey]));
  }
  assert.equal((await api("open-post", "POST", { mediaId, sourceKey: provenance.sources[0].sourceKey })).status, 409,
    "historical sources remain queryable after account removal, but must not open an anonymous browser");
  assert.equal((await api("open-post", "POST", { url: "https://www.instagram.com/p/fixture/" })).status, 400);
  assert.equal((await fetch(`${origin}/api/persons/${person.id}/open-post`, { method: "POST",
    headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, sourceKey: provenance.sources[0].sourceKey }) })).status, 403);
  const unknown = "f".repeat(64);
  assert.equal((await api(`media/${unknown}/sources`)).status, 404);
  assert.equal((await api(`media/${unknown}/open`, "POST", { path: path.join(root, "not-media") })).status, 404);
  assert.equal((await fetch(`${origin}/api/persons/${person.id}/media/${mediaId}/open`, { method: "POST",
    headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ path: "C:\\arbitrary" }) })).status, 403,
    "wrong origin must be blocked before invoking the system association");
  await unlink(await index.resolve(mediaId));
  assert.equal((await api(`media/${mediaId}/open`, "POST")).status, 404);
  assert.equal((await api(`media/${mediaId}/reveal`, "POST")).status, 404);
  assert.deepEqual(JSON.parse(await readFile(path.join(data, "state.json"), "utf8")), state);
});
