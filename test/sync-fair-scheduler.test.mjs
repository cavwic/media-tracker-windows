import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate, message = "The local account queue did not settle") {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function fixture(t, definitions = [
  ["first", ["x"]], ["mixed", ["x", "instagram"]], ["later", ["instagram"]],
  ["independent", ["tiktok"]], ["other_x", ["x"]],
]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tracker-account-fair-"));
  const state = { persons: definitions.map(([id, platforms]) => ({ id, name: id, folderPath: path.join(root, id),
    platforms: platforms.map((platform) => ({ id: platform, label: platform === "x" ? "X" : platform,
      accounts: [{ id: `${id}-${platform}`, label: `@${id}`, linkedAccountId: `binding-${platform}` }] })) })),
  linkedAccounts: ["x", "instagram", "tiktok"].map((id) => ({ id: `binding-${id}`, platformId: id,
    profileDirectory: path.join(root, "private-profiles", id), loginStatus: "verified" })) };
  for (const person of state.persons) await mkdir(person.folderPath);
  const started = [], active = new Set(), releases = new Map();
  const discoverers = Object.fromEntries(["x", "instagram", "tiktok"].map((platform) => [platform,
    async ({ handle, signal }) => {
      const key = `${platform}:${handle}`;
      started.push(key); active.add(key);
      try {
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Fixture cancelled", "AbortError"));
          releases.set(key, () => { signal.removeEventListener("abort", abort); resolve(); });
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      } finally { active.delete(key); }
      return { posts: [], media: [], complete: true, reachedEnd: true, completionReason: "terminal-page" };
    }]));
  const manager = new SyncManager({ indexFile: path.join(root, "index.json"), loadState: async () => state,
    discoverers, download: async () => { throw new Error("The empty offline feed must never download"); } });
  t.after(async () => {
    for (const release of releases.values()) release();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager, started, active, releases, state };
}

test("an X-blocked person immediately uses its free Instagram login, and later Instagram remains FIFO", async (t) => {
  const { manager, started, releases } = await fixture(t);
  await manager.start("first");
  await waitFor(() => started.includes("x:first"));
  const mixed = (await manager.start("mixed")).job;
  await waitFor(() => started.includes("instagram:mixed"), "A blocked X account must not reserve or delay its free Instagram account");
  const later = (await manager.start("later")).job;
  await manager.start("independent");
  await waitFor(() => started.includes("tiktok:independent"));
  await waitFor(() => manager.get(later.id).accountProgress.some(progress => progress.waiting.length));
  assert.equal(started.includes("x:mixed"), false);
  assert.equal(started.includes("instagram:later"), false);
  assert.deepEqual(manager.get(mixed.id).accountProgress.find(progress => progress.platformId === "x").waiting,
    [{ platform: "X", personName: "first", reason: "busy" }]);
  assert.deepEqual(manager.get(later.id).accountProgress.find(progress => progress.platformId === "instagram").waiting,
    [{ platform: "instagram", personName: "mixed", reason: "busy" }]);
  assert.doesNotMatch(JSON.stringify(manager.get(later.id)), /private-profiles|folder:|login:|profile:|resourceLabels/);

  releases.get("instagram:mixed")();
  await waitFor(() => started.includes("instagram:later"));
  assert.equal(started.includes("x:mixed"), false, "Instagram progress must not wait for another platform's X lock");
  assert.equal(manager.get(mixed.id).status, "running", "The person must await its still-queued X pipeline");
  releases.get("x:first")();
  await waitFor(() => started.includes("x:mixed"));
  for (const release of releases.values()) release();
  await waitFor(() => manager.activeJobIds.size === 0);
  assert.equal(manager.get(mixed.id).counters.accountsFinished, 2);
  assert.equal(manager.get(later.id).counters.accountsFinished, 1);
});

test("cancelling a mixed person's active and queued accounts releases the login FIFO without starting its blocked account", async (t) => {
  const { manager, started, releases } = await fixture(t);
  await manager.start("first"); await waitFor(() => started.includes("x:first"));
  const mixed = (await manager.start("mixed")).job;
  await waitFor(() => started.includes("instagram:mixed"));
  const later = (await manager.start("later")).job;
  manager.cancel(mixed.id);
  await waitFor(() => manager.get(mixed.id).status === "cancelled" && !manager.activeJobIds.has(mixed.id));
  await waitFor(() => started.includes("instagram:later"));
  assert.equal(started.includes("x:mixed"), false);
  assert.equal((await manager.store.summary("mixed")).status, "cancelled");
  assert.equal(manager.get(mixed.id).queuePosition, null);
  releases.get("instagram:later")(); releases.get("x:first")();
  await waitFor(() => manager.activeJobIds.size === 0);
  assert.equal(manager.get(later.id).status, "completed");
  assert.equal(manager.activeResourceKeys.size, 0);
});

test("an external login reservation blocks only that account and resumes when the external owner drains", async (t) => {
  const { manager, started, releases } = await fixture(t);
  manager.activeResourceKeys.add("login:binding-x");
  const mixed = (await manager.start("mixed")).job;
  await waitFor(() => started.includes("instagram:mixed"));
  assert.equal(started.includes("x:mixed"), false);
  assert.deepEqual(manager.get(mixed.id).accountProgress.find(progress => progress.platformId === "x").waiting,
    [{ platform: "X", reason: "busy" }], "External account-session owners expose no private profile path or fictitious person owner");
  manager.activeResourceKeys.delete("login:binding-x"); manager.drain();
  await waitFor(() => started.includes("x:mixed"));
  for (const release of releases.values()) release();
  await waitFor(() => !manager.activeJobIds.has(mixed.id));
  assert.equal(manager.get(mixed.id).status, "completed");
  assert.equal(manager.get(mixed.id).counters.accountsFinished, 2);
});

test("different binding IDs that resolve to the same profile remain one exclusive resource", async (t) => {
  const { root, manager, state, started, releases } = await fixture(t, [["first", ["x"]], ["later", ["instagram"]]]);
  state.linkedAccounts.find((item) => item.platformId === "instagram").profileDirectory = path.join(root, "private-profiles", "unused", "..", "x");
  const first = (await manager.start("first")).job;
  await waitFor(() => started.includes("x:first"));
  const later = (await manager.start("later")).job;
  await tick(); await tick();
  assert.equal(started.includes("instagram:later"), false);
  releases.get("x:first")();
  await waitFor(() => started.includes("instagram:later"));
  releases.get("instagram:later")();
  await waitFor(() => manager.activeJobIds.size === 0);
  assert.equal(manager.get(first.id).status, "completed");
  assert.equal(manager.get(later.id).status, "completed");
});

test("shutdown aborts active discovery and every account waiting in the shared-login queue without a live lock", async (t) => {
  const { manager, started } = await fixture(t);
  const first = (await manager.start("first")).job;
  await waitFor(() => started.includes("x:first"));
  const mixed = (await manager.start("mixed")).job;
  await waitFor(() => started.includes("instagram:mixed"));
  const later = (await manager.start("later")).job;
  await manager.shutdown({ timeoutMs: 2_000 });
  assert.deepEqual(new Set(started), new Set(["x:first", "instagram:mixed"]));
  for (const job of [first, mixed, later]) assert.equal(manager.get(job.id).status, "cancelled");
  assert.equal(manager.activeResourceKeys.size, 0);
  assert.equal(manager.activeJobIds.size, 0);
  assert.equal(manager.activeRunPromises.size, 0);
  assert.equal(manager.pendingJobIds.length, 0);
  assert.equal(manager.pendingReceiptWrites.size, 0);
  await assert.rejects(manager.start("first"), { code: "service-shutting-down" });
});
