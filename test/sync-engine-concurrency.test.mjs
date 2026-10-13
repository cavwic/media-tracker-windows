import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { SyncManager } from "../lib/sync-engine.mjs";

async function waitFor(predicate, message) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function gate(signal) {
  let release;
  const promise = new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Fixture cancelled", "AbortError"));
    release = () => { signal.removeEventListener("abort", abort); resolve(); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return { promise, release };
}

test("actual account discovery runs every independent person concurrently while shared-login leases stay FIFO by arrival", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-tracker-concurrency-"));
  const people = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
    id: `person-${id}`, name: `Person ${id}`, folderPath: path.join(root, id),
    platforms: [{ id: "x", label: "X", accounts: [{ id: `target-${id}`, label: `@target_${id}`,
      linkedAccountId: ["d", "g"].includes(id) ? "login-a" : `login-${id}` }] }],
  }));
  for (const person of people) await mkdir(person.folderPath);
  const state = { persons: people, linkedAccounts: ["a", "b", "c", "e", "f"].map((id) => ({
    id: `login-${id}`, platformId: "x", loginStatus: "verified", profileDirectory: path.join(root, "profiles", id),
  })) };
  const active = new Set(), started = [], releases = new Map();
  const sharedHandles = new Set(["target_a", "target_d", "target_g"]);
  const sharedArrivals = [], sharedGrants = [];
  let maxObserved = 0;
  const manager = new SyncManager({ indexFile: path.join(root, "sync-index.json"), loadState: async () => state,
    discoverers: { x: async ({ handle, signal }) => {
      if (sharedHandles.has(handle)) {
        assert.equal([...active].some(item => sharedHandles.has(item)), false,
          "Two targets must never use the same login/profile concurrently");
      }
      active.add(handle); started.push(handle); maxObserved = Math.max(maxObserved, active.size);
      const current = gate(signal); releases.set(handle, current.release);
      try { await current.promise; }
      finally { active.delete(handle); }
      return { posts: [], media: [], complete: true, reachedEnd: true, completionReason: "terminal-page" };
    } },
    download: async () => { throw new Error("The empty offline timeline must not download media"); },
  });
  // Person index validation does asynchronous filesystem I/O before an account
  // needs its browser lease. Creation order is not scheduler arrival order.
  // Observe the real lease queue without changing when or how it acquires.
  const acquire = manager.accountScheduler.acquire.bind(manager.accountScheduler);
  manager.accountScheduler.acquire = options => {
    const handle = `target_${options.owner.personName.slice(-1)}`;
    const shared = options.keys.includes("login:login-a");
    if (shared) sharedArrivals.push(handle);
    return acquire(options).then(release => {
      if (shared) sharedGrants.push(handle);
      return release;
    });
  };
  t.after(async () => {
    for (const release of releases.values()) release();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const results = await Promise.all(people.map((person) => manager.start(person.id)));
  assert.equal(results.every(({ job }) => !Object.hasOwn(job, "resourceKeys") && !Object.hasOwn(job, "newFiles")), true);
  assert.equal(results.every(({ job }) => job.newFileCount === 0), true);
  await waitFor(() => active.size === 5, "The five independent account discoveries did not all start");
  await waitFor(() => sharedArrivals.length === 3, "All shared-login targets did not submit their leases");
  const [firstShared, secondShared, thirdShared] = sharedArrivals;
  assert.deepEqual(new Set(started), new Set([firstShared, "target_b", "target_c", "target_e", "target_f"]));
  assert.deepEqual(sharedGrants, [firstShared]);
  assert.equal(maxObserved, 5, "There must not be a four-person concurrency limit");
  releases.get("target_b")();
  await waitFor(() => !active.has("target_b"), "Person B discovery did not finish");
  assert.equal(started.includes(secondShared), false, "An unrelated profile release cannot release login A");
  assert.equal(started.includes(thirdShared), false, "An unrelated profile release cannot release login A");
  releases.get(firstShared)();
  await waitFor(() => active.has(secondShared), "The oldest waiting shared-login account did not start after release");
  assert.equal(started.includes(thirdShared), false, "A later shared-login target must not jump the queue");
  assert.deepEqual(sharedGrants, [firstShared, secondShared]);
  releases.get(secondShared)();
  await waitFor(() => active.has(thirdShared), "The third shared-login account did not start after the second release");
  assert.deepEqual(sharedGrants, sharedArrivals, "Shared-login grant order must exactly equal submission order");
  for (const release of releases.values()) release();
  await waitFor(() => manager.activeJobIds.size === 0, "All real account pipelines did not settle");
  for (const { job } of results) {
    const saved = manager.get(job.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.counters.accountsFinished, 1);
    assert.equal(saved.counters.failed, 0);
  }
  assert.equal(manager.activeResourceKeys.size, 0);
});
