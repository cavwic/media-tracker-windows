import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const origin = "http://127.0.0.1:54321";
const files = [{ id: "file-a", filename: "first.jpg", kind: "image", platformLabel: "TikTok", accountLabel: "example" }];
const card = (id) => `.person-card[data-person-id="${id}"]`;
const makeJob = (personId, status) => ({
  id: `job-${personId}`, personId, status, message: `${personId} initial`, newFileCount: 1,
  counters: { accounts: 1, accountsFinished: status === "completed" ? 1 : 0, downloaded: 1, failed: 1 },
  errors: [{ platform: "TikTok", account: "example", message: "Example network failure" }],
});

async function until(predicate, label) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1600, height: 2200 } });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.clock.install();
  const model = {
    persons: ["a", "b"].map((id) => ({ id, name: `Person ${id}`, note: "", folderPath: `D:\\Fixture\\${id}`, platforms: [] })),
    linkedAccounts: [], platforms: { tiktok: { label: "TikTok" } }, settings: { theme: "dark" },
    syncSummaries: { a: makeJob("a", "completed"), b: makeJob("b", "running") },
  };
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [];
  const handlers = new Map();
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const pathname = url.pathname;
    calls.push({ pathname, body: request.postDataJSON() });
    let payload;
    if (handlers.has(pathname)) payload = await handlers.get(pathname)(request);
    else if (pathname === "/api/state") payload = structuredClone(model);
    else if (pathname.startsWith("/api/sync-jobs/")) payload = Object.values(model.syncSummaries).find((job) => pathname.endsWith(job.id));
    else if (pathname.endsWith("/new-files")) {
      const id = pathname.split("/")[3];
      payload = { jobId: model.syncSummaries[id].id, available: true, files: structuredClone(files) };
    } else if (pathname.endsWith("-new-file")) payload = { foreground: true };
    else {
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ status: 200, contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets.get(name) });
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator(".person-card").count() === 2, "initial cards");
  return { page, model, calls, handlers };
}

async function expandFiles(page, personId = "a") {
  await page.locator(`${card(personId)} .new-files-toggle`).click();
  await until(() => page.locator(`${card(personId)} .new-file-name`).count(), "new file names");
}

test("genuine errors remain visible even when many verification warnings arrive", async (t) => {
  const { page, model } = await fixture(t);
  model.syncSummaries.b = { ...makeJob("b", "completed"), message: "Completed with followups", counters: { failed: 1, warnings: 20 },
    errors: [{ platform: "X", account: "creator", code: "download-error", message: "Actual file failed HTTP 404" }],
    warnings: Array.from({ length: 20 }, (_, i) => ({ platform: "X", account: `target-${i}`, code: "timeline-incomplete", category: "history", message: `History check ${i}` })) };
  await page.clock.runFor(1_500);
  await until(async () => (await page.locator(`${card("b")} .sync-status`).textContent()) === "完成但有失败", "latest classification");
  await page.locator(`${card("b")} .sync-operational-errors summary`).click();
  const details = await page.locator(`${card("b")} .sync-operational-errors ul`).textContent();
  assert.match(details, /Actual file failed HTTP 404/);
  assert.doesNotMatch(details, /历史待核验|History check|待检查/);
  assert.equal(await page.locator(`${card("b")} .sync-technical-records`).getAttribute("open"), null);
  assert.match(await page.locator(`${card("b")} .sync-technical-records`).textContent(), /History check/);
});

test("legacy completeness warnings are not labelled as failed downloads", async (t) => {
  const { page, model } = await fixture(t);
  model.syncSummaries.b = { ...makeJob("b", "completed"), message: "同步完成，但有 1 项失败", counters: { failed: 1 },
    errors: [{ code: "timeline-incomplete", platform: "Instagram", account: "creator", message: "History unconfirmed" }] };
  await page.clock.runFor(1_500);
  await until(async () => (await page.locator(`${card("b")} .sync-status`).textContent()) === "同步完成", "legacy warning is not an artificial user task");
  assert.equal(await page.locator(`${card("b")} .sync-metrics span`).nth(3).textContent(), "0失败");
  assert.equal(await page.locator(`${card("b")} .sync-followup-metric`).count(), 0);
  assert.doesNotMatch(await page.locator(`${card("b")} .sync-receipt > p`).textContent(), /1 项失败/);
});

test("real local dedup failures stay actionable while platform history and attachment records do not become user tasks", async (t) => {
  const { page, model } = await fixture(t);
  model.syncSummaries.b = { ...makeJob("b", "completed"), counters: { failed: 0, warnings: 3 }, errors: [], warnings: [
    { code: "similarity-check-pending", category: "verification", message: "本地去重解码失败，请再次资料去重" },
    { code: "timeline-incomplete", category: "history", message: "平台历史末页证明缺失" },
    { code: "timeline-incomplete", category: "attachments", message: "平台未返回 1 个附件" },
  ] };
  await page.clock.runFor(600);
  await until(async () => (await page.locator(`${card("b")} .sync-status`).textContent()).includes("处理提示"), "local failure label");
  const operational = page.locator(`${card("b")} .sync-operational-errors`);
  await operational.locator("summary").click();
  assert.match(await operational.textContent(), /本地去重解码失败/);
  assert.doesNotMatch(await operational.textContent(), /末页证明|未返回 1 个附件/);
  assert.equal(await page.locator(`${card("b")} .sync-followup-metric`).count(), 0);
  assert.equal(await page.locator(`${card("b")} .sync-technical-records`).getAttribute("open"), null);
});

test("polling preserves a pressed file, details, focus and a completed card without DOM mutations", async (t) => {
  const { page, model, calls } = await fixture(t);
  await expandFiles(page);
  await page.locator(`${card("a")} .sync-operational-errors summary`).click();
  await page.locator(`${card("b")} .sync-operational-errors summary`).click();
  await page.evaluate(() => {
    const done = document.querySelector('[data-person-id="a"].person-card');
    const active = document.querySelector('[data-person-id="b"].person-card');
    window.savedUi = { done, active, file: done.querySelector(".new-file-name"), details: active.querySelector("details"), mutations: 0 };
    new MutationObserver((changes) => { window.savedUi.mutations += changes.length; }).observe(done, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const button = page.locator(`${card("a")} .new-file-name`);
  const bounds = await button.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const beforeScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  model.syncSummaries.b.message = "progress after pointer down";
  model.syncSummaries.b.counters.bytes = 2048;
  model.syncSummaries.b.errors.push({ message: "Another network failure" });
  await page.clock.runFor(600);
  await until(async () => (await page.locator(`${card("b")} .sync-receipt > p`).textContent()) === model.syncSummaries.b.message, "poll updated active card");
  assert.deepEqual(await page.evaluate(() => ({
    file: window.savedUi.file === document.querySelector('[data-person-id="a"].person-card .new-file-name'),
    active: window.savedUi.active === document.querySelector('[data-person-id="b"].person-card'),
    details: window.savedUi.details === document.querySelector('[data-person-id="b"].person-card details'),
    detailsOpen: window.savedUi.details.open,
    completedDetailsOpen: window.savedUi.done.querySelector("details").open,
    focus: document.activeElement === window.savedUi.file,
    mutations: window.savedUi.mutations,
    scroll: { x: scrollX, y: scrollY },
  })), { file: true, active: true, details: true, detailsOpen: true, completedDetailsOpen: true, focus: true, mutations: 0, scroll: beforeScroll });
  assert.doesNotMatch(await page.locator(`${card("b")} .sync-operational-errors ul`).textContent(), /Another network failure/);
  await page.mouse.up();
  await until(() => calls.some((call) => call.pathname === "/api/persons/a/open-new-file"), "system open request after mouse up");
  assert.deepEqual(calls.find((call) => call.pathname === "/api/persons/a/open-new-file").body, { fileId: "file-a" });
  await page.locator(`${card("b")} .sync-operational-errors summary`).click();
  await until(async () => (await page.locator(`${card("b")} .sync-operational-errors ul`).textContent()).includes("Another network failure"), "latest errors after closing details");
  await page.locator(`${card("b")} .sync-operational-errors summary`).click();
  assert.equal(await page.locator(`${card("b")} .sync-operational-errors`).getAttribute("open"), "");
});

test("a file context menu survives sync progress and still reveals through the existing system API", async (t) => {
  const { page, model, calls } = await fixture(t);
  await expandFiles(page);
  await page.locator(`${card("a")} .new-file-name`).click({ button: "right" });
  model.syncSummaries.b.message = "progress while context menu is open";
  await page.clock.runFor(600);
  await until(async () => (await page.locator(`${card("b")} .sync-receipt > p`).textContent()) === model.syncSummaries.b.message, "context-menu poll");
  assert.equal(await page.locator("#file-context-menu").isVisible(), true);
  assert.equal(await page.locator("#reveal-file-location").evaluate((node) => document.activeElement === node), true);
  await page.locator("#reveal-file-location").click();
  await until(() => calls.some((call) => call.pathname === "/api/persons/a/reveal-new-file"), "system reveal request");
});

test("appending files for the active person preserves existing button identity during a press", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  await expandFiles(page, "b");
  await page.evaluate(() => { window.existingFile = document.querySelector('[data-person-id="b"].person-card .new-file-name'); });
  handlers.set("/api/persons/b/new-files", () => ({
    jobId: "job-b", available: true, files: [...files, { ...files[0], id: "file-b", filename: "second.jpg" }],
  }));
  const bounds = await page.locator(`${card("b")} .new-file-name`).boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  model.syncSummaries.b.newFileCount = 2;
  await page.clock.runFor(600);
  await until(() => calls.filter((call) => call.pathname === "/api/persons/b/new-files").length === 2, "refresh queued during mouse press");
  assert.equal(await page.locator(`${card("b")} .new-file-name`).count(), 1);
  assert.equal(await page.evaluate(() => window.existingFile === document.querySelector('[data-person-id="b"].person-card .new-file-name')), true);
  await page.mouse.up();
  await until(() => calls.some((call) => call.pathname === "/api/persons/b/open-new-file"), "active file system open");
  await until(async () => await page.locator(`${card("b")} .new-file-name`).count() === 2, "append new files after mouse release");
});

test("a delayed receipt from the previous job cannot overwrite the new job's files", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  const oldReceipt = deferred();
  handlers.set("/api/persons/a/new-files", () => oldReceipt.promise);
  await page.locator(`${card("a")} .new-files-toggle`).click();
  await until(() => calls.some((call) => call.pathname === "/api/persons/a/new-files"), "old receipt request");
  handlers.set("/api/persons/a/sync", () => {
    model.syncSummaries.a = { ...makeJob("a", "running"), id: "job-a-new", newFileCount: 1 };
    return model.syncSummaries.a;
  });
  await page.locator(`${card("a")} .sync-person`).click();
  await until(() => page.locator(`${card("a")} .cancel-sync`).count(), "new job launched");
  handlers.set("/api/persons/a/new-files", () => ({ jobId: "job-a-new", available: true, files: [{ ...files[0], id: "fresh", filename: "fresh.jpg" }] }));
  await expandFiles(page);
  oldReceipt.resolve({ jobId: "job-a", available: true, files: [{ ...files[0], filename: "stale.jpg" }] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.locator(`${card("a")} .new-file-name`).textContent(), "fresh.jpg");
  assert.equal(await page.locator(`${card("a")} .cancel-sync`).getAttribute("data-job-id"), "job-a-new");
});

test("a late running poll cannot resurrect a cancelled job", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  const oldPoll = deferred();
  handlers.set("/api/sync-jobs/job-b", () => oldPoll.promise);
  await page.clock.runFor(600);
  await until(() => calls.some((call) => call.pathname === "/api/sync-jobs/job-b"), "pending running poll");
  handlers.set("/api/sync-jobs/job-b/cancel", () => ({ ...model.syncSummaries.b, status: "cancelled", message: "Cancelled" }));
  await page.locator(`${card("b")} .cancel-sync`).click();
  await until(() => page.locator(`${card("b")} .sync-person`).count(), "cancelled job");
  oldPoll.resolve(model.syncSummaries.b);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.locator(`${card("b")} .sync-status`).textContent(), "已取消");
});

test("a receipt in flight at completion is followed by one final file-list refresh", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  const partialReceipt = deferred();
  handlers.set("/api/persons/b/new-files", () => partialReceipt.promise);
  await page.locator(`${card("b")} .new-files-toggle`).click();
  await until(() => calls.some((call) => call.pathname === "/api/persons/b/new-files"), "pending partial receipt");
  model.syncSummaries.b = { ...model.syncSummaries.b, status: "completed", newFileCount: 2, message: "complete with two files" };
  await page.clock.runFor(600);
  await until(() => page.locator(`${card("b")} .sync-person`).count(), "final poll completed");
  handlers.set("/api/persons/b/new-files", () => ({
    jobId: "job-b", available: true, files: [...files, { ...files[0], id: "last", filename: "last.jpg" }],
  }));
  partialReceipt.resolve({ jobId: "job-b", available: true, files });
  await until(async () => await page.locator(`${card("b")} .new-file-name`).count() === 2, "final file missing from partial response");
  assert.equal(calls.filter((call) => call.pathname === "/api/persons/b/new-files").length, 2);
});

test("a loading drawer can be closed and reopened without waiting for its response", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  const receipt = deferred();
  handlers.set("/api/persons/a/new-files", () => receipt.promise);
  const toggle = page.locator(`${card("a")} .new-files-toggle`);
  await toggle.click();
  await until(() => calls.some((call) => call.pathname === "/api/persons/a/new-files"), "loading receipt");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(`${card("a")} .new-files-panel`).isVisible(), true);
  receipt.resolve({ jobId: "job-a", available: true, files });
  await until(() => page.locator(`${card("a")} .new-file-name`).count(), "receipt after reopen");
});

test("a delayed cancellation cannot overwrite a newer job on the same retained action button", async (t) => {
  const { page, model, handlers, calls } = await fixture(t);
  const cancellation = deferred();
  const oldJob = structuredClone(model.syncSummaries.b);
  handlers.set("/api/sync-jobs/job-b/cancel", () => cancellation.promise);
  await page.locator(`${card("b")} .cancel-sync`).click();
  await until(() => calls.some((call) => call.pathname.endsWith("/cancel")), "pending cancellation");
  model.syncSummaries.b = { ...oldJob, status: "completed" };
  await page.clock.runFor(600);
  await until(async () => !(await page.locator("#sync-all-button").isDisabled()), "last job complete");
  handlers.set("/api/sync-all", () => {
    model.syncSummaries.b = { ...oldJob, id: "job-b-next", status: "running" };
    return { jobs: [model.syncSummaries.b], startedCount: 1, existingCount: 0 };
  });
  await page.locator("#sync-all-button").click();
  await until(async () => (await page.locator(`${card("b")} .cancel-sync`).getAttribute("data-job-id")) === "job-b-next", "new job replaces button data");
  cancellation.resolve({ ...oldJob, status: "cancelled" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.locator(`${card("b")} .cancel-sync`).getAttribute("data-job-id"), "job-b-next");
  assert.equal(await page.locator(`${card("b")} .sync-status`).textContent(), "正在同步");
});
