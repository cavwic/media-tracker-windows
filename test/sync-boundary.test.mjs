import test from "node:test";
import assert from "node:assert/strict";
import { createSyncBoundary } from "../lib/sync-boundary.mjs";

const old = (id) => ({ postKey: String(id), createdAt: "2026-09-26T00:00:00Z" });
const knownPosts = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), true]));
const options = { knownPosts, initialComplete: true, since: "2026-09-28T00:00:00Z" };

test("incremental boundary requires two distinct known batches and ignores pinned or repeated posts", () => {
  const boundary = createSyncBoundary(options);
  assert.equal(boundary.observe([{ ...old(0), pinned: true }]), false);
  assert.equal(boundary.observe([old(1), old(2), old(3)]), false);
  assert.equal(boundary.observe([old(1), old(2), old(3)]), false);
  assert.equal(boundary.observe([old(4), old(5), old(6)]), true);
});

test("newly visible old posts reset the boundary and a six-hour overlap remains visible", () => {
  const boundary = createSyncBoundary(options);
  assert.equal(boundary.observe([old(1), old(2), old(3)]), false);
  assert.equal(boundary.observe([old("new"), old(4), old(5)]), false);
  assert.equal(boundary.observe([6, 7, 8].map((id) => ({ ...old(id), createdAt: "2026-09-27T23:00:00Z" }))), false);
  assert.equal(boundary.observe([old(9), old(10), old(11)]), false);
  assert.equal(boundary.observe([old(12), old(13), old(14)]), true);
});

test("initial scans never stop at existing records and missing timestamps do not claim an old boundary", () => {
  const initial = createSyncBoundary({ ...options, initialComplete: false });
  for (let i = 0; i < 4; i++) assert.equal(initial.observe([old(i * 3), old(i * 3 + 1), old(i * 3 + 2)]), false);
  const missingDates = createSyncBoundary(options);
  for (let i = 0; i < 4; i++) assert.equal(missingDates.observe([i * 3, i * 3 + 1, i * 3 + 2].map((id) => ({ postKey: String(id) }))), false);
});

test("late unseen or incomplete posts revoke an already reached boundary", () => {
  for (const late of [old("late"), { ...old(1), mediaComplete: false }]) {
    const boundary = createSyncBoundary(options);
    boundary.observe([old(1), old(2), old(3)]);
    assert.equal(boundary.observe([old(4), old(5), old(6)]), true);
    assert.equal(boundary.observe([late]), false);
    assert.equal(boundary.reached, false);
  }
});

test("boundary reset discards previous proof and pinned incomplete posts cannot impersonate normal history", () => {
  const boundary = createSyncBoundary(options);
  boundary.observe([old(1), old(2), old(3)]);
  assert.equal(boundary.observe([old(4), old(5), old(6)]), true);
  assert.equal(boundary.observe([{ ...old("pinned"), pinned: true, mediaComplete: false }]), true);
  boundary.reset();
  assert.equal(boundary.reached, false);
  assert.equal(boundary.observe([old(1), old(2), old(3)]), false);
  assert.equal(boundary.observe([old(4), old(5), old(6)]), true);
});
