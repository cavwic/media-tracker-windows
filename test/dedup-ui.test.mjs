import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Entirely local routed fixture. No production server, profiles, NAS media,
// deduplication writes, downloads or online services are used by these tests.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const origin = "http://127.0.0.1:54332";
const idle = () => ({ status: "idle", scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], results: [] });
const running = () => ({ ...idle(), id: "dedup-a", scope: "all", personId: null, currentPersonId: "a", status: "running", phase: "scanning", personName: "Wyy", message: "正在本地比对",
  scanned: 2, total: 10, merged: 1, review: 2, archivedBytes: 2048 });
const completed = () => ({ ...running(), status: "completed", scanned: 10, merged: 3, review: 2, message: "本地去重完成",
  results: [{ personId: "a", personName: "Wyy", merged: 3, review: 2, message: "低质量版本已可恢复归档" }] });
const callsTo = (calls, path) => calls.filter((call) => call.path === path);
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

async function fixture(t, { activeSync = false, job = idle(), theme = "dark", width = 1600 } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 1200 }, colorScheme: theme === "light" ? "light" : "dark", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.clock.install();
  t.after(() => context.close());
  const model = { linkedAccounts: [], platforms: { x: { label: "X" } }, settings: { theme }, dedupStatus: job,
    persons: ["a", "b"].map((id) => ({ id, name: id === "a" ? "Wyy" : "采集账号 B", platforms: [], folderPath: `D:\\Fixture\\${id}` })),
    syncSummaries: { a: { id: "sync-a", personId: "a", status: activeSync ? "running" : "completed", newFileCount: 1,
      message: "本地同步测试", counters: { accounts: 1, accountsFinished: activeSync ? 0 : 1, downloaded: 1 },
      errors: [], warnings: [] } } };
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "styles.css", "theme-bootstrap.js"]
    .map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  const calls = [], handlers = new Map(), errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (path.startsWith("/api/")) calls.push({ path, method: request.method(), body: request.postDataJSON() });
    let payload;
    if (handlers.has(path)) payload = await handlers.get(path)(request);
    else if (path === "/api/state") payload = structuredClone(model);
    else if (path === "/api/tools/dedup") payload = { ready: true, directory: "C:\\testtools", installAvailable: true };
    else if (path === "/api/dedup-status") payload = structuredClone(model.dedupStatus);
    else if (path === "/api/dedup-all") { model.dedupStatus = { ...running(), id: `dedup-new-${calls.length}` }; payload = structuredClone(model.dedupStatus); }
    else if (path === "/api/dedup-person") {
      const personId = request.postDataJSON().personId;
      model.dedupStatus = { ...running(), id: `dedup-new-${calls.length}`, scope: "person", personId, currentPersonId: personId,
        personName: model.persons.find((person) => person.id === personId)?.name };
      payload = structuredClone(model.dedupStatus);
    }
    else if (path === "/api/dedup-cancel") { model.dedupStatus = { ...model.dedupStatus, status: "cancelled", dismissed: request.postDataJSON().closeResults === true, message: "已安全停止" }; payload = structuredClone(model.dedupStatus); }
    else if (path === "/api/dedup-close") { model.dedupStatus = { ...model.dedupStatus, dismissed: true }; payload = structuredClone(model.dedupStatus); }
    else if (path.endsWith("/open-post")) payload = { ok: true, message: "已使用绑定账号打开原帖。" };
    else if (path === "/api/sync-jobs/sync-a") payload = structuredClone(model.syncSummaries.a);
    else if (path === "/api/persons/a/new-files") payload = { jobId: "sync-a", available: true,
      files: [{ id: "file-a", mediaId: "media-a", filename: "20260822_Wyy_01_example.jpg", kind: "image", platformLabel: "X", accountLabel: "target" }] };
    else if (path === "/api/persons/a/open-new-file" || path === "/api/persons/a/reveal-new-file") payload = { foreground: true, filename: "current.jpg" };
    else if (/^\/api\/persons\/[^/]+\/media\/[^/]+\/(open|reveal)$/.test(path)) payload = { foreground: true, filename: "authoritative-current-name.jpg" };
    else if (/^\/api\/persons\/[^/]+\/media\/[^/]+\/sources$/.test(path)) payload = { sources: [] };
    else if (path === "/api/persons/a/recheck") {
      model.syncSummaries.a = { ...model.syncSummaries.a, id: "recheck-a", status: "running", forceHistory: true, message: "完整补查已开始" };
      payload = structuredClone(model.syncSummaries.a);
    }
    else if (path === "/api/sync-jobs/recheck-a") payload = structuredClone(model.syncSummaries.a);
    else {
      const name = path === "/" ? "index.html" : path.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ status: 200, contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets.get(name) });
    }
    await route.fulfill({ status: payload?._status || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator(".person-card").count() === 2, "local UI loaded");
  return { page, model, handlers, calls };
}

test("one-click dedup follows sync in the toolbar and requires local recoverable confirmation", async (t) => {
  const { page, calls } = await fixture(t);
  assert.equal(await page.locator("#sync-all-button + #dedup-all-button").count(), 1);
  assert.equal(callsTo(calls, "/api/dedup-status").length, 0, "idle status uses /api/state, not continuous polling");
  await page.locator("#dedup-all-button").click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "dedup confirmation after tools preflight");
  const copy = await page.locator("#confirm-message").textContent();
  assert.match(copy, /图片.*视频/);
  assert.match(copy, /LoRA/);
  assert.match(copy, /Index\/DedupArchive/);
  assert.match(copy, /不上传媒体.*不使用 AI/);
  assert.match(copy, /归档仍占空间.*不会自动永久删除/);
  assert.match(copy, /不清理账号登录资料/);
  assert.equal(await page.locator("#confirm-button.is-neutral").count(), 1);
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  assert.equal(await page.locator("#sync-all-button").isDisabled(), true);
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator("#dedup-all-button").isDisabled()), "safe cancelled confirmation");
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  assert.equal(await page.locator("#sync-all-button").isDisabled(), false);
});

test("confirmed dedup sends one POST and blocks conflicting writes while media stays usable", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  const pending = deferred();
  handlers.set("/api/dedup-all", () => pending.promise);
  await page.locator("#dedup-all-button").click();
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/dedup-all").length === 1, "dedup started once");
  await page.locator("#dedup-all-button").evaluate((button) => button.click());
  assert.deepEqual(callsTo(calls, "/api/dedup-all")[0], { path: "/api/dedup-all", method: "POST", body: { confirm: true } });
  assert.equal(callsTo(calls, "/api/dedup-all").length, 1);
  pending.resolve({ job: running() });
  await until(async () => !(await page.locator("#dedup-receipt").isHidden()), "local receipt shown");
  assert.equal(await page.locator(".sync-person:not(:disabled)").count(), 0);
  assert.equal(await page.locator(".delete-person:not(:disabled)").count(), 0);
  assert.equal(await page.locator("#create-person-button").isDisabled(), true);
  assert.equal(await page.locator(".browse-person-media:not(:disabled)").count(), 2);
  assert.match(await page.locator("#dedup-scanned").textContent(), /2 \/ 10/);
  assert.match(await page.locator("#dedup-archived").textContent(), /2.0 KB/);
});

test("sync disables manual dedup and shows automatic image-video housekeeping counts", async (t) => {
  const { page, model, calls } = await fixture(t, { activeSync: true });
  assert.equal(await page.locator("#dedup-all-button").isDisabled(), true);
  assert.equal(await page.locator(".dedup-person:not(:disabled)").count(), 0);
  await page.locator("#dedup-all-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", deduplication: { merged: 4, review: 2, archivedBytes: 4096 } };
  await page.clock.runFor(600);
  await until(async () => !(await page.locator("#dedup-all-button").isDisabled()), "sync completion unlocks dedup");
  assert.match(await page.locator(".sync-dedup-summary").textContent(), /已合并 4.*疑似项保留 2.*4.0 KB/);
  assert.equal(callsTo(calls, "/api/dedup-status").length, 0, "automatic progress is part of the sync job");
});

test("person dedup follows incremental sync, names only that person and sends one scoped POST", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  assert.equal(await page.locator('.person-card[data-person-id="a"] .sync-person + .dedup-person').count(), 1);
  assert.equal(await page.locator('.person-card[data-person-id="b"] .sync-person + .dedup-person').count(), 1);
  const pending = deferred();
  handlers.set("/api/dedup-person", () => pending.promise);
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "person confirmation after tools preflight");
  assert.match(await page.locator("#confirm-title").textContent(), /仅对“Wyy”/);
  assert.match(await page.locator("#confirm-message").textContent(), /不处理其他人物.*保留不同音轨版本.*停止去重/);
  assert.doesNotMatch(await page.locator("#confirm-message").textContent(), /采集账号 B/);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "dedup-person-confirm-dark.png"), fullPage: true });
  }
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/dedup-person").length === 1, "single-person dedup start");
  assert.deepEqual(callsTo(calls, "/api/dedup-person")[0].body, { confirm: true, personId: "a" });
  await page.locator('.dedup-person[data-person-id="b"]').evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/dedup-person").length, 1);
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  pending.resolve({ ...running(), scope: "person", personId: "a", currentPersonId: "a" });
  await until(async () => (await page.locator('.dedup-person[data-person-id="a"]').textContent()) === "停止并关闭", "selected person stop action");
  assert.equal(await page.locator('.dedup-person[data-person-id="a"]').isDisabled(), false);
  assert.equal(await page.locator('.dedup-person[data-person-id="b"]').isDisabled(), true);
  assert.equal(await page.locator("#dedup-cancel-button").isHidden(), false);
});

test("person stop waits safely, cannot double-cancel and survives a stale running poll", async (t) => {
  const personJob = { ...running(), scope: "person", personId: "a", currentPersonId: "a" };
  const { page, handlers, calls } = await fixture(t, { job: personJob });
  const oldPoll = deferred(), cancellation = deferred();
  handlers.set("/api/dedup-status", () => oldPoll.promise);
  handlers.set("/api/dedup-cancel", () => cancellation.promise);
  await page.clock.runFor(1000);
  await until(() => callsTo(calls, "/api/dedup-status").length === 1, "pending person status");
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await until(() => callsTo(calls, "/api/dedup-cancel").length === 1, "person cancellation request");
  assert.equal(await page.locator('.dedup-person[data-person-id="a"]').textContent(), "正在安全停止…");
  assert.equal(await page.locator('.dedup-person[data-person-id="a"]').isDisabled(), true);
  await page.locator("#dedup-cancel-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/dedup-cancel").length, 1);
  cancellation.resolve({ ...personJob, status: "cancelled", message: "已安全停止" });
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "已停止", "person cancellation completed");
  oldPoll.resolve(personJob);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.locator("#dedup-job-status").textContent(), "已停止");
  assert.equal(await page.locator("#dedup-receipt").isHidden(), true, "safe stop dismisses the result, not its durable records");
  assert.equal(await page.locator('.dedup-person[data-person-id="a"]').textContent(), "资料去重");
  assert.equal(await page.locator('.dedup-person[data-person-id="b"]').isDisabled(), false);
});

test("all-person dedup is stoppable globally and the active card explicitly stops the entire job", async (t) => {
  const { page, calls } = await fixture(t, { job: running() });
  assert.equal(await page.locator("#dedup-cancel-button").textContent(), "停止并关闭");
  assert.equal(await page.locator('.dedup-person[data-person-id="a"]').textContent(), "停止全部并关闭");
  assert.equal(await page.locator('.dedup-person[data-person-id="b"]').isDisabled(), true);
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await until(() => callsTo(calls, "/api/dedup-cancel").length === 1, "stop all from active card");
  assert.deepEqual(callsTo(calls, "/api/dedup-cancel")[0].body, { confirm: true, closeResults: true });
  assert.equal(callsTo(calls, "/api/dedup-person").length, 0);
});

test("opening an app resumes only the running dedup status and completion preserves new file nodes", async (t) => {
  const { page, model, calls } = await fixture(t, { job: running() });
  await page.locator('[data-person-id="a"] .new-files-toggle').click();
  await until(() => page.locator(".new-file-name").count(), "expanded new file list");
  await page.evaluate(() => { window.retainedFileButton = document.querySelector(".new-file-name"); });
  model.dedupStatus = completed();
  await page.clock.runFor(1000);
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "整理完成", "manual report completion");
  assert.equal(await page.evaluate(() => window.retainedFileButton === document.querySelector(".new-file-name")), true);
  assert.equal(await page.locator(".new-files-toggle").first().getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#sync-all-button").isDisabled(), false);
  await page.locator(".new-file-name").click();
  await until(() => callsTo(calls, "/api/persons/a/open-new-file").length === 1, "system file open still works");
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0, "opening or reading cannot start a new dedup job");
});

test("safe cancellation cannot be undone by a late running poll", async (t) => {
  const { page, handlers, calls } = await fixture(t, { job: running() });
  const oldPoll = deferred();
  handlers.set("/api/dedup-status", () => oldPoll.promise);
  await page.clock.runFor(1000);
  await until(() => callsTo(calls, "/api/dedup-status").length === 1, "old poll in flight");
  const cancellation = deferred();
  handlers.set("/api/dedup-cancel", () => cancellation.promise);
  await page.locator("#dedup-cancel-button").click();
  await until(() => callsTo(calls, "/api/dedup-cancel").length === 1, "cancel request");
  await page.locator("#dedup-cancel-button").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/dedup-cancel").length, 1);
  assert.deepEqual(callsTo(calls, "/api/dedup-cancel")[0].body, { confirm: true, closeResults: true });
  cancellation.resolve({ ...running(), status: "cancelled", message: "已安全停止" });
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "已停止", "cancelled receipt");
  oldPoll.resolve(running());
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.locator("#dedup-job-status").textContent(), "已停止");
  assert.equal(await page.locator("#dedup-all-button").isDisabled(), false);
});

test("poll failure preserves active job, retries safely and does not restart dedup", async (t) => {
  const { page, handlers, calls } = await fixture(t, { job: running() });
  handlers.set("/api/dedup-status", () => ({ _status: 503, error: "NAS 暂时不可用" }));
  await page.clock.runFor(1000);
  await until(async () => (await page.locator("#dedup-status").textContent()).includes("自动重试"), "non-destructive read retry");
  assert.equal(await page.locator("#sync-all-button").isDisabled(), true);
  assert.equal(await page.locator("#dedup-scanned").textContent(), "2 / 10");
  handlers.set("/api/dedup-status", () => completed());
  await page.clock.runFor(5000);
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "整理完成", "progress retry completes");
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
});

test("dedup results freeze while open and render errors as text, not executable markup", async (t) => {
  const { page, model } = await fixture(t, { job: { ...running(), results: [{ personName: "Wyy", merged: 1, review: 2, message: "first result" }] } });
  await page.locator("#dedup-details summary").click();
  model.dedupStatus = { ...completed(), errors: [{ personName: '<img src=x onerror="alert(1)">', message: "文件被播放器占用" }] };
  await page.clock.runFor(1000);
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "完成但有失败", "partial failure remains explicit");
  assert.match(await page.locator("#dedup-result-list").textContent(), /first result/);
  await page.locator("#dedup-details summary").click();
  await page.locator("#dedup-details summary").click();
  await until(async () => (await page.locator("#dedup-result-list").textContent()).includes("播放器"), "fresh results after reopening");
  assert.equal(await page.locator("#dedup-result-list img").count(), 0);
  assert.match(await page.locator("#dedup-result-list").textContent(), /<img src=x/);
});

test("pagehide cleans polling timers without cancelling or mutating archived media", async (t) => {
  const { page, calls } = await fixture(t, { job: running() });
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.runFor(20_000);
  assert.equal(callsTo(calls, "/api/dedup-status").length, 0);
  assert.equal(callsTo(calls, "/api/dedup-cancel").length, 0);
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
});

test("named image-video review candidates are visible and remain retained, not raw hash-only labels", async (t) => {
  const reviewItems = [{ mediaIds: ["long-hash-a", "long-hash-b"], filenames: ["20261002_Wyy_02.mp4", "20261004_Wyy_02.mp4"], reason: "内容边界未确认，保留各版本" }];
  const { page, model } = await fixture(t, { job: { ...completed(), results: [{ personName: "Wyy", merged: 3, review: 1, reviewItems }] }, activeSync: true });
  await page.locator("#dedup-details summary").click();
  const manual = await page.locator("#dedup-result-list").textContent();
  assert.match(manual, /20261002_Wyy_02.mp4 ↔ 20261004_Wyy_02.mp4/);
  assert.doesNotMatch(manual, /long-hash/);
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", deduplication: { merged: 0, review: 1, reviewItems } };
  await page.clock.runFor(600);
  await until(() => page.locator(".sync-dedup-details").count(), "automatic review details");
  await page.locator(".sync-dedup-details summary").click();
  assert.match(await page.locator(".sync-dedup-details").textContent(), /20261002_Wyy_02.mp4.*20261004_Wyy_02.mp4.*没有自动合并/);
});

test("retained local variants open, reveal and show sources using indexed IDs, while open results remain stable", async (t) => {
  const reviewItems = [{ mediaIds: ["media-a", "media-b"], filenames: ["first-variant.mp4", "second-variant.mp4"], reason: "音轨不同，已同时保留。" }];
  const { page, model, handlers, calls } = await fixture(t, { job: { ...running(), results: [{ personId: "a", personName: "Wyy", review: 1, reviewItems }] } });
  await page.locator("#dedup-details summary").click();
  assert.match(await page.locator("#dedup-details").textContent(), /不影响采集完成.*无需处理也可继续同步/);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "dedup-person-review-dark.png"), fullPage: true });
  }
  const button = page.locator('#dedup-result-list .dedup-file-name[data-media-id="media-a"]');
  await page.evaluate(() => { window.retainedReviewButton = document.querySelector("#dedup-result-list .dedup-file-name"); });
  await button.click();
  await until(() => callsTo(calls, "/api/persons/a/media/media-a/open").length === 1, "review system-associated open");
  assert.equal(callsTo(calls, "/api/persons/a/media/media-a/open")[0].body, null);
  await button.click({ button: "right" });
  handlers.set("/api/dedup-status", () => ({ ...completed(), results: [{ personId: "a", personName: "Wyy", review: 1,
    reviewItems: [{ ...reviewItems[0], filenames: ["renamed-a.mp4", "renamed-b.mp4"] }] }] }));
  await page.clock.runFor(1000);
  await until(async () => (await page.locator("#dedup-job-status").textContent()) === "整理完成", "job completes with review open");
  assert.equal(await page.evaluate(() => window.retainedReviewButton === document.querySelector("#dedup-result-list .dedup-file-name")), true);
  assert.equal(await page.locator("#file-context-menu").isHidden(), false);
  await page.locator("#reveal-file-location").click();
  await until(() => callsTo(calls, "/api/persons/a/media/media-a/reveal").length === 1, "review authoritative reveal");
  assert.equal(callsTo(calls, "/api/persons/a/media/media-a/reveal")[0].body, null);
  await button.click({ button: "right" });
  await page.locator("#view-file-sources").click();
  await until(() => callsTo(calls, "/api/persons/a/media/media-a/sources").length === 1, "review local provenance");
  assert.equal(await page.locator("#sources-dialog").isVisible(), true);
  assert.equal(await button.textContent(), "first-variant.mp4", "open list remains a stable snapshot; action resolves latest name by ID");
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  assert.equal(callsTo(calls, "/api/dedup-person").length, 0);
  assert.equal(model.persons.length, 2);
});

test("automatic sync review files support the same local open and context location without poll replacement", async (t) => {
  const { page, model, calls } = await fixture(t, { activeSync: true });
  const reviewItems = [{ mediaIds: ["media-a", "media-b"], filenames: ["auto-a.jpg", "auto-b.jpg"], reason: "局部差异，已保留。" }];
  model.syncSummaries.a = { ...model.syncSummaries.a, deduplication: { review: 1, reviewItems } };
  await page.clock.runFor(600);
  await until(() => page.locator(".sync-dedup-details").count(), "automatic candidates");
  await page.locator(".sync-dedup-details summary").click();
  const button = page.locator('.sync-dedup-details .dedup-file-name[data-media-id="media-a"]');
  await page.evaluate(() => { window.retainedAutomaticReviewButton = document.querySelector(".sync-dedup-details .dedup-file-name"); });
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", deduplication: { review: 1,
    reviewItems: [{ ...reviewItems[0], filenames: ["new-a.jpg", "new-b.jpg"] }] } };
  await page.clock.runFor(1000);
  await until(async () => (await page.locator(".sync-status").first().textContent()) === "同步完成", "sync finished");
  assert.equal(await page.evaluate(() => window.retainedAutomaticReviewButton === document.querySelector(".sync-dedup-details .dedup-file-name")), true);
  await button.click();
  await until(() => callsTo(calls, "/api/persons/a/media/media-a/open").length === 1, "automatic review open");
  await button.click({ button: "right" });
  await page.locator("#reveal-file-location").click();
  await until(() => callsTo(calls, "/api/persons/a/media/media-a/reveal").length === 1, "automatic review reveal");
  assert.match(await page.locator(".sync-dedup-details").textContent(), /不影响采集完成.*不需要当作下载失败/);
});

test("pending sync details expose real post counts and immediate full recheck without clearing local media", async (t) => {
  const { page, model, calls } = await fixture(t, { activeSync: true });
  model.persons[0].platforms = [{ id: "instagram", label: "Instagram", accounts: [{ id: "creator-account", label: "creator" }] }];
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", counters: { warnings: 1 },
    warnings: [{ platform: "Instagram", account: "creator", category: "attachments", message: "部分附件待补查" }],
    accountResults: [{ platform: "Instagram", account: "creator", diagnostics: { pendingPostSamples: [
      { postId: "post-a", postUrl: "https://example.test/original/post-a", expectedCount: 5, knownCount: 3 },
      { postId: "post-b", postUrl: "javascript:alert(1)", expectedCount: 2, knownCount: null },
    ] } }] };
  await page.reload();
  await page.clock.runFor(600);
  await until(() => page.locator(".recheck-person").count(), "recheck offered for pending sync");
  const details = page.locator('.person-card[data-person-id="a"] .sync-technical-records');
  await details.locator("summary").click();
  assert.match(await details.textContent(), /已识别 3 \/ 预期 5 个附件/);
  assert.equal(await details.locator(".sync-post-link").getAttribute("href"), null);
  assert.equal(await details.locator(".sync-post-link").getAttribute("data-account-id"), "creator-account");
  assert.equal(await details.locator(".sync-post-link").count(), 1, "untrusted post URL cannot execute");
  assert.match(await details.textContent(), /原帖链接未记录/);
  assert.match(await details.textContent(), /预期 2 个附件 · 已识别数量未知/);
  await page.locator(".recheck-person").click();
  assert.match(await page.locator("#confirm-title").textContent(), /立即完整补查“Wyy”/);
  assert.match(await page.locator("#confirm-message").textContent(), /所有账号.*不等待 24 小时.*已有完整文件直接跳过.*不清空索引/);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "full-recheck-confirm-dark.png"), fullPage: true });
  }
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/persons/a/recheck").length === 1, "forced history request");
  assert.deepEqual(callsTo(calls, "/api/persons/a/recheck")[0], { path: "/api/persons/a/recheck", method: "POST", body: { confirm: true } });
  assert.equal(callsTo(calls, "/api/persons/a/sync").length, 0);
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
});

test("full recheck confirmation can cancel and manual housekeeping disables it rather than silently queueing", async (t) => {
  const { page, model, calls } = await fixture(t, { activeSync: true });
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", counters: { warnings: 1 },
    warnings: [{ category: "history", message: "历史待核验" }] };
  await page.clock.runFor(600);
  await until(() => page.locator(".recheck-person").count(), "recheck control for history gap");
  await page.locator('.person-card[data-person-id="a"] .sync-technical-records summary').click();
  await page.locator(".recheck-person").click();
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator(".recheck-person").isDisabled()), "cancel restores recheck control");
  assert.equal(callsTo(calls, "/api/persons/a/recheck").length, 0);
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await page.locator("#confirm-button").click();
  await until(async () => (await page.locator('.dedup-person[data-person-id="a"]').textContent()) === "停止并关闭", "person dedup started");
  assert.equal(await page.locator(".recheck-person").isDisabled(), true);
  await page.locator(".recheck-person").evaluate((button) => button.click());
  assert.equal(callsTo(calls, "/api/persons/a/recheck").length, 0);
});

test("unavailable full recheck preserves the old warning and media instead of claiming completeness", async (t) => {
  const { page, model, handlers, calls } = await fixture(t, { activeSync: true });
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", counters: { warnings: 1 },
    warnings: [{ category: "history", message: "历史尚未核验完整" }] };
  handlers.set("/api/persons/a/recheck", () => ({ _status: 404, error: "Not found" }));
  await page.clock.runFor(600);
  await until(() => page.locator(".recheck-person").count(), "legacy recheck control");
  await page.locator('.person-card[data-person-id="a"] .sync-technical-records summary').click();
  await page.locator(".recheck-person").click();
  await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#toast").textContent()).includes("重新启动新版"), "legacy recheck error");
  assert.equal(await page.locator(".sync-status").first().textContent(), "同步完成");
  assert.equal(await page.locator(".new-files-toggle").first().getAttribute("aria-expanded"), "false");
  assert.match(await page.locator('.person-card[data-person-id="a"] .sync-technical-records').textContent(), /历史尚未核验完整/);
  assert.equal(callsTo(calls, "/api/persons/a/recheck").length, 1);
  assert.equal(callsTo(calls, "/api/persons/a/sync").length, 0);
});

test("a racing existing normal sync is not misreported as a newly started full-history recheck", async (t) => {
  const { page, model, handlers, calls } = await fixture(t, { activeSync: true });
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", counters: { warnings: 1 },
    warnings: [{ category: "history", message: "历史待核验" }] };
  handlers.set("/api/persons/a/recheck", () => ({ ...model.syncSummaries.a, status: "running", forceHistory: false }));
  await page.clock.runFor(600);
  await until(() => page.locator(".recheck-person").count(), "race recheck control");
  await page.locator('.person-card[data-person-id="a"] .sync-technical-records summary').click();
  await page.locator(".recheck-person").click();
  await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#toast").textContent()).includes("没有新建完整补查"), "existing normal-job truthful receipt");
  assert.doesNotMatch(await page.locator("#toast").textContent(), /完整补查已开始/);
  assert.equal(callsTo(calls, "/api/persons/a/recheck").length, 1);
});

test("an unavailable dedup API displays actionable restart guidance without claiming success", async (t) => {
  const { page, handlers, calls } = await fixture(t);
  handlers.set("/api/dedup-all", () => ({ _status: 404, error: "Not found" }));
  await page.locator("#dedup-all-button").click();
  await page.locator("#confirm-button").click();
  await until(async () => (await page.locator("#dedup-status").textContent()).includes("重新启动新版"), "old backend guidance");
  assert.equal(await page.locator("#dedup-all-button").isDisabled(), false);
  assert.doesNotMatch(await page.locator("#dedup-job-status").textContent(), /整理完成/);
  assert.equal(callsTo(calls, "/api/dedup-status").length, 0);
});

test("stopping keeps controls locked until safe completion, then closes results without losing restart scope", async (t) => {
  const personJob = { ...running(), scope: "person", personId: "a", currentPersonId: "a" };
  const { page, model, handlers, calls } = await fixture(t, { job: personJob });
  handlers.set("/api/dedup-cancel", () => ({ ...personJob, cancelRequested: true, closeResultsRequested: true }));
  await page.locator("#dedup-cancel-button").click();
  await until(async () => (await page.locator("#dedup-cancel-button").textContent()).includes("正在安全停止"), "stopping phase");
  assert.equal(await page.locator("#dedup-receipt").isVisible(), true);
  assert.equal(await page.locator("#sync-all-button").isDisabled(), true);
  model.dedupStatus = { ...personJob, status: "cancelled", dismissed: true };
  await page.clock.runFor(1000);
  await until(async () => await page.locator("#dedup-receipt").isHidden(), "safe terminal auto close");
  assert.equal(await page.locator("#sync-all-button").isDisabled(), false);
  await page.locator('.dedup-person[data-person-id="a"]').click();
  await page.locator("#confirm-button").click();
  await until(() => callsTo(calls, "/api/dedup-person").length === 1, "same scope can restart");
  assert.deepEqual(callsTo(calls, "/api/dedup-person")[0].body, { confirm: true, personId: "a" });
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
});

test("terminal result can continue the original person scope or close persistently without media operations", async (t) => {
  const { page, calls, model } = await fixture(t, { job: { ...completed(), scope: "person", personId: "b", status: "failed" } });
  assert.equal(await page.locator("#dedup-continue-button").isVisible(), true);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "dedup-terminal-continue-close-dark.png"), fullPage: true });
  }
  await page.locator("#dedup-continue-button").click();
  await until(() => page.locator("#confirm-dialog").evaluate((node) => node.open), "continued scope confirmation after tools preflight");
  assert.match(await page.locator("#confirm-title").textContent(), /采集账号 B/);
  await page.locator("#confirm-cancel").click();
  await until(async () => !(await page.locator("#dedup-close-button").isDisabled()), "continue cancellation restored");
  await page.locator("#dedup-close-button").click();
  await until(async () => await page.locator("#dedup-receipt").isHidden(), "closed result");
  assert.deepEqual(callsTo(calls, "/api/dedup-close")[0].body, { confirm: true, jobId: "dedup-a" });
  assert.equal(model.dedupStatus.dismissed, true);
  await page.reload();
  assert.equal(await page.locator("#dedup-receipt").isHidden(), true, "saved dismissal survives reopening");
  assert.equal(callsTo(calls, "/api/dedup-all").length, 0);
  assert.equal(callsTo(calls, "/api/dedup-person").length, 0);
  assert.equal(calls.some((call) => /cache|delete|\/media\/.*\/(open|reveal)$/.test(call.path)), false);
});

test("unavailable close preserves results and cancellation failure does not unlock a running job", async (t) => {
  const { page, handlers } = await fixture(t, { job: completed() });
  handlers.set("/api/dedup-close", () => ({ _status: 404, error: "Not found" }));
  await page.locator("#dedup-close-button").click();
  await until(async () => (await page.locator("#dedup-status").textContent()).includes("重新启动新版"), "missing close API guidance");
  assert.equal(await page.locator("#dedup-receipt").isVisible(), true);
  await page.locator("#dedup-all-button").click();
  await page.locator("#confirm-button").click();
  await until(async () => await page.locator("#dedup-cancel-button").isVisible(), "new running job");
  handlers.set("/api/dedup-cancel", () => ({ _status: 503, error: "停止请求暂时失败" }));
  await page.locator("#dedup-cancel-button").click();
  await until(async () => (await page.locator("#dedup-status").textContent()).includes("停止请求暂时失败"), "cancel error remains explicit");
  assert.equal(await page.locator("#dedup-receipt").isVisible(), true);
  assert.equal(await page.locator("#sync-all-button").isDisabled(), true);
});

test("bound original posts send only authoritative IDs, keep nodes stable, and busy sessions do not open anonymous tabs", async (t) => {
  const { page, model, handlers, calls } = await fixture(t, { activeSync: true });
  model.persons[0].platforms = [{ id: "instagram", label: "Instagram", accounts: [{ id: "creator-account", label: "creator" }] }];
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "completed", counters: { warnings: 1 },
    warnings: [{ category: "attachments", message: "平台返回附件数不足" }], accountResults: [{ platform: "Instagram", account: "creator", platformId: "instagram", accountId: "creator-account",
      diagnostics: { pendingPostSamples: [{ postId: "post-a", postUrl: "https://www.instagram.com/p/post-a/", expectedCount: 3, knownCount: 2 }] } }] };
  await page.reload();
  const technical = page.locator('.person-card[data-person-id="a"] .sync-technical-records');
  assert.equal(await technical.getAttribute("open"), null);
  assert.equal(await page.locator(".sync-followup-metric").count(), 0);
  assert.doesNotMatch(await page.locator("#sync-all-status").textContent(), /待检查/);
  await technical.locator("summary").click();
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "bound-post-technical-dark.png"), fullPage: true });
  }
  const button = technical.locator(".open-bound-post");
  await page.evaluate(() => { window.boundButton = document.querySelector(".sync-technical-records .open-bound-post"); });
  const busy = deferred();
  handlers.set("/api/persons/a/open-post", () => busy.promise);
  await button.click();
  await until(() => callsTo(calls, "/api/persons/a/open-post").length === 1, "bound post operation");
  await button.evaluate((node) => node.click());
  assert.equal(callsTo(calls, "/api/persons/a/open-post").length, 1);
  assert.deepEqual(callsTo(calls, "/api/persons/a/open-post")[0].body, { platformId: "instagram", accountId: "creator-account", postId: "post-a" });
  busy.resolve({ _status: 409, error: "对应登录账号正在同步" });
  await until(async () => (await page.locator("#toast").textContent()).includes("请等待"), "busy account waits without re-login");
  assert.equal(await button.isDisabled(), false);
  assert.equal(await page.evaluate(() => window.boundButton === document.querySelector(".sync-technical-records .open-bound-post")), true);
  assert.equal(await technical.getAttribute("open"), "");
  assert.equal(await page.context().pages().length, 1);
  assert.equal(calls.some((call) => /login|verify/.test(call.path)), false);
  handlers.set("/api/persons/a/open-post", () => ({ ok: true, message: "已使用绑定账号打开原帖。" }));
  await button.click();
  await until(async () => (await page.locator("#toast").textContent()).includes("绑定账号打开"), "explicit bound success");
});

test("queue receipt explains shared-session waiting without card reorder or making technical history a task", async (t) => {
  const { page, model } = await fixture(t, { activeSync: true });
  model.syncSummaries.a = { ...model.syncSummaries.a, status: "queued", queuePosition: 2, queueWaiting: true, queueReason: "等待较早任务释放 X 登录会话",
    warnings: [{ category: "history", message: "历史未取得末页证明" }] };
  await page.clock.runFor(600);
  await until(async () => (await page.locator(".sync-status").first().textContent()) === "排队等待", "queue state");
  assert.match(await page.locator(".sync-queue-reason").textContent(), /队列第 2 位.*较早任务.*X 登录会话/);
  assert.deepEqual(await page.locator(".person-card").evaluateAll((cards) => cards.map((node) => node.dataset.personId)), ["a", "b"]);
  assert.equal(await page.locator(".sync-followup-metric").count(), 0);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "fair-queue-dark.png"), fullPage: true });
  }
});

test("dedup receipt and confirmation retain the existing desktop visual hierarchy", async (t) => {
  const { page } = await fixture(t, { job: completed() });
  const button = await page.locator("#dedup-all-button").boundingBox();
  const sync = await page.locator("#sync-all-button").boundingBox();
  const create = await page.locator("#create-person-button").boundingBox();
  assert.ok(Math.abs(button.y - sync.y) < 1 && Math.abs(create.y - sync.y) < 1, "the three primary actions share a horizontal row");
  assert.ok(create.x + create.width <= sync.x && sync.x + sync.width <= button.x, "create, sync and dedup stay in their existing action order");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "dedup-desktop-dark.png"), fullPage: true });
    await page.locator("#dedup-all-button").click();
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, "dedup-confirm-dark.png"), fullPage: true });
    await page.locator("#confirm-cancel").click();
  }
});

for (const theme of ["dark", "light", "system"]) {
  test(`dedup receipt follows ${theme} theme and fits a narrow viewport`, async (t) => {
    const { page } = await fixture(t, { job: completed(), theme, width: 360 });
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "light" : "dark");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.locator("#dedup-receipt").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    const receiptBackground = await page.locator("#dedup-receipt").evaluate((node) => getComputedStyle(node).backgroundColor);
    const cardBackground = await page.locator(".person-card").first().evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.equal(receiptBackground, cardBackground, "receipt reuses the existing themed paper surface");
    if (process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_DEDUP_UI_SCREENSHOT_DIR, `dedup-mobile-${theme}.png`), fullPage: true });
    }
    await page.locator('[data-view="settings"]').click();
    assert.match(await page.locator("#automatic-dedup-title").textContent(), /新同步文件自动比对/);
    assert.match(await page.locator("#automatic-dedup-title").locator("..").textContent(), /不是 LoRA 训练适配结论.*登录资料不参与/);
  });
}
