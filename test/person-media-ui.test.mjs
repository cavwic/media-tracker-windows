import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const origin = "http://127.0.0.1:54323";
const makeMedia = (index) => ({ mediaId: `hash-${index}`, filename: `hash-${index}.jpg`, relativePath: `Image/hash-${index}.jpg`, kind: "image", bytes: 2048, sourceCount: 3 });
const defaultSources = [
  { platformId: "x", platformLabel: "X", accountId: "account-a", accountLabel: "作者 A", logicalKey: "post1:0", postId: "post1", postUrl: "https://x.com/author/status/1", createdAt: "2026-10-01T00:00:00.000Z", firstSeenAt: "2026-10-02T00:00:00.000Z" },
  { platformId: "x", platformLabel: "X", accountId: "account-b-removed", accountLabel: "作者 B", logicalKey: "post2:0", postId: "post2", postUrl: "https://x.com/author2/status/2", createdAt: null, firstSeenAt: "2026-10-02T00:00:00.000Z" },
  { platformId: "instagram", platformLabel: "Instagram", accountId: "account-c", accountLabel: "作者 C", logicalKey: "post3:0", postId: "post3", postUrl: "https://www.instagram.com/p/example/", createdAt: true, firstSeenAt: null },
];

async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
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

async function fixture(t, { theme = "dark", width = 1400, running = false, count = 55 } = {}) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 1000 } });
  const page = await context.newPage();
  t.after(() => context.close());
  const job = { id: "job-person", personId: "person", status: running ? "running" : "completed", message: "同步记录", newFileCount: 1, counters: { accounts: 1, accountsFinished: running ? 0 : 1, downloaded: 1 } };
  const model = {
    persons: [{ id: "person", name: "人物 A", note: "", folderPath: "D:\\Fixture\\人物 A", platforms: [{ id: "x", label: "X", accounts: [{ id: "account-a", label: "作者 A" }] }] }],
    platforms: { x: { label: "X" }, instagram: { label: "Instagram" } }, linkedAccounts: [], settings: { theme }, syncSummaries: { person: job },
  };
  const media = Array.from({ length: count }, (_, index) => makeMedia(index));
  const calls = [];
  const handlers = new Map();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const assets = new Map(await Promise.all(["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css"].map(async (name) => [name, await readFile(new URL(`../public/${name}`, import.meta.url), "utf8")])));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" }) });
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    calls.push({ pathname: url.pathname, search: url.search, body: request.postDataJSON(), method: request.method() });
    let payload;
    if (handlers.has(url.pathname)) payload = await handlers.get(url.pathname)(request, url);
    else if (url.pathname === "/api/state") payload = structuredClone(model);
    else if (url.pathname === "/api/sync-jobs/job-person") payload = structuredClone(model.syncSummaries.person);
    else if (url.pathname === "/api/persons/person/media") {
      const query = url.searchParams.get("query") || "";
      const filtered = media.filter((file) => file.filename.includes(query));
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 50);
      payload = { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
    } else if (url.pathname.endsWith("/sources")) payload = { mediaId: url.pathname.split("/")[5], sources: structuredClone(defaultSources) };
    else if (/\/media\/[^/]+\/(open|reveal)$/.test(url.pathname) || url.pathname.endsWith("-new-file")) payload = { foreground: true };
    else if (url.pathname.endsWith("/new-files")) payload = { available: true, jobId: job.id, files: [{ id: "receipt-1", ...makeMedia(0), platformLabel: "X", accountLabel: "作者 A" }] };
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ status: 200, contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets.get(name) });
    }
    const failure = payload?._status;
    await route.fulfill({ status: failure || 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await until(async () => await page.locator(".person-card").count() === 1, "initial person");
  return { page, calls, handlers, model, media };
}

async function openLibrary(page) {
  await page.locator(".browse-person-media").click();
  await until(async () => await page.locator("#media-list").getAttribute("aria-busy") === "false", "media page ready");
}

test("the blueprint is always flat, including drafts with multiple platform accounts", async (t) => {
  const { page } = await fixture(t);
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("新的名称");
  assert.match(await page.locator("#folder-tree").textContent(), /新的名称[\s\S]*Image[\s\S]*Video[\s\S]*Index/);
  await page.locator("#add-platform-button").click();
  await page.locator('[data-field="label"]').fill("不作为文件夹的账号");
  await page.locator(".add-account-button").click();
  const blueprint = await page.locator("#folder-tree").textContent();
  assert.doesNotMatch(blueprint, /不作为文件夹的账号|├─ X|gif 文件夹/);
  assert.match(blueprint, /按需创建/);
  assert.equal(await page.locator("#save-person-button").textContent(), "创建人物");
  assert.doesNotMatch(await page.locator(".blueprint-note").textContent(), /账号目录/);
});

test("media pagination and filename search use the local index and system file APIs", async (t) => {
  const { page, calls } = await fixture(t);
  await openLibrary(page);
  assert.equal(await page.locator(".media-library-row").count(), 50);
  assert.equal(await page.locator("#media-page-status").textContent(), "1–50 / 55 个文件");
  assert.equal(await page.locator("#media-previous-page").isDisabled(), true);
  await page.locator("#media-next-page").click();
  await until(async () => await page.locator(".media-library-row").count() === 5, "second page");
  assert.equal(await page.locator("#media-page-status").textContent(), "51–55 / 55 个文件");
  await page.locator("#media-search").fill("hash-54");
  await page.locator('#media-search-form button[type="submit"]').click();
  await until(async () => await page.locator(".media-file-name").count() === 1, "search result");
  assert.equal(await page.locator(".media-file-name").textContent(), "hash-54.jpg");
  assert.equal(await page.locator("#media-page-status").textContent(), "1–1 / 1 个文件");
  await page.locator(".media-file-name").click();
  await until(() => calls.some((call) => call.pathname === "/api/persons/person/media/hash-54/open"), "system association request");
  const call = calls.find((item) => item.pathname.endsWith("hash-54/open"));
  assert.equal(call.method, "POST");
  assert.equal(call.body, null);
  assert.equal(calls.some((item) => item.pathname.includes("/sync")), false);
  assert.equal(await page.locator("#media-dialog video, #media-dialog iframe, #media-dialog img").count(), 0);
  await page.locator("#close-media-dialog").click();
  assert.equal(await page.locator(".browse-person-media").evaluate((node) => node === document.activeElement), true);
});

test("the folder action sits beside each name, opens only its person ID and remains stable during sync", async (t) => {
  const { page, calls, handlers, model } = await fixture(t, { running: true });
  const pending = deferred();
  handlers.set("/api/persons/person/open-folder", () => pending.promise);
  const folder = page.locator(".open-person-folder");
  const bounds = await page.locator(".person-name-row").evaluate((node) => ({ name: node.querySelector("h3").getBoundingClientRect().toJSON(),
    button: node.querySelector("button").getBoundingClientRect().toJSON() }));
  assert.ok(bounds.button.x >= bounds.name.x + bounds.name.width, "folder button is to the right of the name");
  assert.equal(await folder.textContent(), "查看文件");
  await folder.evaluate((node) => { window.fixtureFolderButton = node; });
  await folder.click();
  await until(() => calls.some((call) => call.pathname.endsWith("/open-folder")), "folder request sent");
  assert.equal(await folder.isDisabled(), true);
  model.syncSummaries.person.message = "同步继续进行";
  model.syncSummaries.person.counters.downloaded = 2;
  await page.waitForTimeout(1050);
  assert.equal(await folder.evaluate((node) => window.fixtureFolderButton === node), true);
  assert.equal(await folder.isDisabled(), true);
  pending.resolve({ ok: true, launched: true, foreground: true });
  await until(() => folder.isEnabled(), "folder action finished");
  const requests = calls.filter((call) => call.pathname.endsWith("/open-folder"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].body, null, "the browser cannot choose the native path");
  assert.match(await page.locator("#toast").textContent(), /人物文件夹/);
  assert.equal(calls.some((call) => call.method === "POST" && !call.pathname.endsWith("/open-folder")), false);
});

test("folder failures remain actionable and long names fit narrow cards", async (t) => {
  const { page, handlers, model } = await fixture(t, { width: 390 });
  model.persons[0].name = "很长的人物名称VeryLongPersonName".repeat(4);
  await page.reload();
  await page.locator(".open-person-folder").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  handlers.set("/api/persons/person/open-folder", () => ({ _status: 503, error: "人物文件夹当前不可访问，请检查网络共享、磁盘连接或目录是否存在。" }));
  await page.locator(".open-person-folder").click();
  await until(() => page.locator("#toast").textContent().then((text) => text.includes("不可访问")), "unreachable folder explanation");
  assert.equal(await page.locator(".open-person-folder").isEnabled(), true);
  assert.equal(await page.locator(".person-card h3").textContent(), model.persons[0].name);
});

test("newly created people automatically receive the same folder action", async (t) => {
  const { page, handlers, model } = await fixture(t);
  handlers.set("/api/persons", (request) => {
    const body = request.postDataJSON();
    const person = { id: "new-person", name: body.name, note: body.note, folderPath: "D:\\Fixture\\新人物", platforms: body.platforms };
    model.persons.push(person);
    return person;
  });
  await page.locator("#create-person-button").click();
  await page.locator("#person-name").fill("新人物");
  await page.locator("#selected-path").fill("D:\\Fixture");
  await page.locator("#add-platform-button").click();
  await page.locator('[data-field="label"]').fill("target");
  await page.locator("#save-person-button").click();
  await until(() => page.locator('.person-card[data-person-id="new-person"] .open-person-folder').count().then((count) => count === 1), "new person's folder action");
  assert.equal(await page.locator('.person-card[data-person-id="new-person"] .open-person-folder').getAttribute("data-person-id"), "new-person");
});

test("system media opening distinguishes verified foreground, taskbar fallback and user window switching", async (t) => {
  const { page, handlers } = await fixture(t, { count: 1 });
  await openLibrary(page);
  const button = page.locator(".media-file-name");
  await button.evaluate((node) => { node.dataset.fixtureStable = "true"; });
  for (const [result, expected] of [
    [{ launched: true, foreground: true, reason: "foreground" }, "已使用系统默认程序打开并显示在前台。"],
    [{ launched: true, foreground: false, reason: "target-unconfirmed" }, "文件已交给系统默认程序打开；暂未确认前台显示，请查看任务栏。"],
    [{ launched: true, foreground: false, reason: "user-switched" }, "文件已打开；你已切换窗口，未打断当前操作。"],
  ]) {
    handlers.set("/api/persons/person/media/hash-0/open", () => result);
    await button.click();
    await until(async () => await page.locator("#media-list-status").textContent() === expected, "accurate file action feedback");
    assert.equal(await page.locator("#toast").textContent(), expected);
    assert.equal(await button.getAttribute("data-fixture-stable"), "true", "opening does not rebuild the file list");
  }
  assert.equal(await page.locator("#media-dialog video, #media-dialog iframe, #media-dialog img").count(), 0);
});

test("new-file image opening confirms foreground without changing receipt nodes", async (t) => {
  const { page, handlers, calls } = await fixture(t, { count: 1, running: true });
  handlers.set("/api/persons/person/open-new-file", () => ({ launched: true, foreground: true, reason: "already-foreground" }));
  await page.locator(".new-files-toggle").click();
  await until(async () => await page.locator(".new-file-name").count() === 1, "new file ready");
  const button = page.locator(".new-file-name");
  await button.evaluate((node) => { node.dataset.fixtureStable = "true"; });
  await button.click();
  await until(async () => (await page.locator("#toast").textContent()).includes("显示在前台"), "foreground receipt feedback");
  assert.equal(await button.getAttribute("data-fixture-stable"), "true");
  assert.deepEqual(calls.find((item) => item.pathname.endsWith("/open-new-file")).body, { fileId: "receipt-1" });
  assert.equal(await page.locator(".new-files-toggle").getAttribute("aria-expanded"), "true");
});

test("all historical sources remain visible, with unknown timestamps and unsafe links escaped", async (t) => {
  const { page, handlers, media } = await fixture(t, { count: 1 });
  media[0].filename = '<img src=x onerror="window.injected=1">.jpg';
  handlers.set("/api/persons/person/media/hash-0/sources", () => ({ sources: [...defaultSources, {
    platformLabel: '<img src=x onerror="window.injected=1">', accountLabel: "<script>bad()</script>", postId: "<svg onload=bad()>", postUrl: "javascript:alert(1)", createdAt: "not-a-date", firstSeenAt: true,
  }] }));
  await openLibrary(page);
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".media-source-record").count() === 4, "source records");
  const text = await page.locator("#sources-list").textContent();
  assert.match(text, /作者 A[\s\S]*作者 B[\s\S]*作者 C/);
  assert.equal(await page.locator(".source-history-chip").count(), 3);
  assert.equal(await page.locator(".media-source-heading .open-bound-post").count(), 3);
  assert.equal(await page.locator(".media-source-heading a").count(), 0, "original posts never open in the anonymous main-shell session");
  assert.ok((text.match(/未知/g) || []).length >= 4);
  assert.equal(await page.locator("#sources-list img, #sources-list script, #sources-list svg").count(), 0);
  assert.equal(await page.locator("#media-list img, #sources-file-name img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator('#sources-list a[href^="javascript:"]').count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#sources-dialog").isVisible(), false);
  assert.equal(await page.locator("#media-dialog").isVisible(), true);
  assert.equal(await page.locator("#media-list .file-sources-button").evaluate((node) => node === document.activeElement), true);
});

test("source original-post controls resolve indexed source keys without sending a URL or modifying login state", async (t) => {
  const { page, handlers, calls } = await fixture(t, { count: 1 });
  await openLibrary(page);
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".media-source-record").count() === 3, "source rows");
  const button = page.locator(".media-source-heading .open-bound-post").first();
  handlers.set("/api/persons/person/open-post", () => ({ _status: 409, error: "该登录资料正在使用中" }));
  await button.click();
  await until(async () => (await page.locator("#toast").textContent()).includes("请等待"), "busy source prompt");
  const call = calls.find((item) => item.pathname === "/api/persons/person/open-post");
  assert.deepEqual(call.body, { mediaId: "hash-0", sourceKey: JSON.stringify(["x", "account-a", "post1:0"]) });
  assert.equal(call.method, "POST");
  assert.equal(await button.getAttribute("href"), null);
  assert.equal(await page.context().pages().length, 1);
  assert.equal(await page.locator("#sources-dialog").isVisible(), true);
  assert.equal(calls.some((item) => /verify|login|linked-account/.test(item.pathname)), false);
});

test("source records distinguish the platform publication date from raw timestamps and unknown dates", async (t) => {
  const { page, handlers } = await fixture(t, { count: 1 });
  handlers.set("/api/persons/person/media/hash-0/sources", () => ({ sources: [
    { ...defaultSources[0], publicationDate: "20261001", dateBasis: "session-timezone", displayTimeZone: "Asia/Tokyo" },
    { ...defaultSources[1], createdAt: "2026-10-01T23:00:00Z", publicationDate: null, dateBasis: "unknown" },
    { ...defaultSources[0], accountLabel: "UTC account", publicationDate: "20261001", dateBasis: "created-at-utc", displayTimeZone: "UTC" },
    { ...defaultSources[1], accountLabel: "No publication account", createdAt: null, publicationDate: "20261002", dateBasis: "first-collected-utc", displayTimeZone: "UTC" },
    { ...defaultSources[0], accountLabel: "Beijing account", createdAt: "2026-10-01T16:30:00Z", publicationDate: "20261002", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai" },
    { ...defaultSources[1], accountLabel: "Beijing collection account", createdAt: null, publicationDate: "20261002", dateBasis: "first-collected-beijing", displayTimeZone: "Asia/Shanghai", firstSeenAt: "2026-10-01T16:30:00Z" },
  ] }));
  await page.locator(".browse-person-media").click();
  await until(async () => await page.locator("#media-list .file-sources-button").count() === 1, "media ready");
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".media-source-record").count() === 6, "source date records");
  const text = await page.locator("#sources-list").textContent();
  assert.match(text, /20261001/);
  assert.match(text, /平台会话 · Asia\/Tokyo/);
  assert.match(text, /日期未知/);
  assert.match(text, /2026-10-01T23:00:00\.000Z/);
  assert.match(text, /平台发布时间（UTC，历史记录）/);
  assert.match(text, /命名日期（首次采集）/);
  assert.match(text, /首次采集日期（无发布时间，UTC，历史记录）/);
  assert.match(text, /平台发布时间（北京时间）/);
  assert.match(text, /首次采集日期（无发布时间，北京时间）/);
  assert.match(text, /首次采集（北京时间）/);
  const beijing = page.locator(".media-source-record").nth(4);
  assert.match(await beijing.textContent(), /20261002[\s\S]*2026\/10\/2 00:30:00/);
  const collected = page.locator(".media-source-record").nth(5);
  assert.match(await collected.textContent(), /命名日期（首次采集）[\s\S]*2026\/10\/2 00:30:00/);
});

test("the context menu remains usable near the bottom of a long media page", async (t) => {
  const { page, calls } = await fixture(t);
  await openLibrary(page);
  await page.locator(".media-file-name").last().click({ button: "right" });
  await page.locator("#reveal-file-location").click();
  await until(() => calls.some((item) => item.pathname === "/api/persons/person/media/hash-49/reveal"), "last-row Explorer request");
});

test("a modal file context menu is interactive, keyboard accessible and resolves only asset IDs", async (t) => {
  const { page, calls } = await fixture(t, { count: 1 });
  await openLibrary(page);
  await page.locator(".media-file-name").focus();
  await page.keyboard.press("Shift+F10");
  assert.equal(await page.locator("#file-context-menu").evaluate((node) => node.parentElement.id), "media-dialog");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#view-file-sources").evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#media-dialog").isVisible(), true);
  assert.equal(await page.locator("#file-context-menu").isVisible(), false);
  assert.equal(await page.locator(".media-file-name").evaluate((node) => node === document.activeElement), true);
  await page.locator(".media-file-name").click({ button: "right" });
  await page.locator("#reveal-file-location").click();
  await until(() => calls.some((item) => item.pathname === "/api/persons/person/media/hash-0/reveal"), "Explorer request");
  assert.equal(calls.find((item) => item.pathname.endsWith("/reveal")).body, null);
  await page.locator(".media-file-name").click({ button: "right" });
  await page.locator("#view-file-sources").click();
  await until(async () => await page.locator(".media-source-record").count() === 3, "sources from context menu");
  await page.locator("#close-sources-dialog").click();
  assert.equal(await page.locator(".media-file-name").evaluate((node) => node === document.activeElement), true);
});

test("new-file source buttons preserve legacy open and reveal behavior", async (t) => {
  const { page, calls } = await fixture(t, { count: 1 });
  await page.locator(".new-files-toggle").click();
  await until(async () => await page.locator(".new-file-name").count() === 1, "receipt loaded");
  await page.locator(".new-file-name").click();
  await until(() => calls.some((item) => item.pathname === "/api/persons/person/open-new-file"), "legacy open request");
  assert.deepEqual(calls.find((item) => item.pathname.endsWith("/open-new-file")).body, { fileId: "receipt-1" });
  await page.locator(".new-file-row .file-sources-button").click();
  await until(async () => await page.locator(".media-source-record").count() === 3, "receipt sources");
  await page.locator("#close-sources-dialog").click();
  await page.locator(".new-file-name").click({ button: "right" });
  assert.equal(await page.locator("#file-context-menu").evaluate((node) => node.parentElement.tagName), "BODY");
  await page.locator("#reveal-file-location").click();
  await until(() => calls.some((item) => item.pathname === "/api/persons/person/reveal-new-file"), "legacy reveal request");
  assert.deepEqual(calls.find((item) => item.pathname.endsWith("/reveal-new-file")).body, { fileId: "receipt-1" });
});

test("late search and source responses cannot overwrite the newer request or reopened dialog", async (t) => {
  const { page, handlers, calls } = await fixture(t, { count: 2 });
  await openLibrary(page);
  const slow = deferred();
  handlers.set("/api/persons/person/media", (_, url) => url.searchParams.get("query") === "old" ? slow.promise : { items: [makeMedia(1)], total: 1, offset: 0, limit: 50 });
  await page.locator("#media-search").fill("old");
  await page.locator('#media-search-form button[type="submit"]').click();
  await until(() => calls.some((item) => item.search.includes("query=old")), "old search pending");
  await page.locator("#media-search").fill("new");
  await page.locator('#media-search-form button[type="submit"]').click();
  await until(async () => await page.locator(".media-file-name").count() === 1 && await page.locator(".media-file-name").textContent() === "hash-1.jpg", "new search ready");
  slow.resolve({ items: [makeMedia(0)], total: 1, offset: 0, limit: 50 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".media-file-name").textContent(), "hash-1.jpg");
  const sourcePending = deferred();
  handlers.set("/api/persons/person/media/hash-1/sources", () => sourcePending.promise);
  await page.locator("#media-list .file-sources-button").click();
  await until(() => calls.some((item) => item.pathname.endsWith("hash-1/sources")), "source pending");
  await page.locator("#close-sources-dialog").click();
  handlers.set("/api/persons/person/media/hash-1/sources", () => ({ sources: [{ ...defaultSources[0], accountLabel: "NEW RECORD" }] }));
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => (await page.locator("#sources-list").textContent()).includes("NEW RECORD"), "reopened sources");
  sourcePending.resolve({ sources: [{ ...defaultSources[0], accountLabel: "OLD RECORD" }] });
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator("#sources-list").textContent(), /OLD RECORD/);
});

test("sync polling never replaces the open media dialog, file button or source records", async (t) => {
  const { page, model } = await fixture(t, { running: true, count: 1 });
  await page.clock.install();
  await openLibrary(page);
  await page.evaluate(() => {
    window.libraryState = { dialog: document.querySelector("#media-dialog"), file: document.querySelector(".media-file-name"), mutations: 0 };
    new MutationObserver((changes) => { window.libraryState.mutations += changes.length; }).observe(document.querySelector("#media-list"), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.locator(".media-file-name").focus();
  model.syncSummaries.person.message = "更新同步进度";
  await page.clock.runFor(1_600);
  await until(async () => (await page.locator(".sync-receipt > p").textContent()) === "更新同步进度", "background progress");
  assert.deepEqual(await page.evaluate(() => ({ dialog: window.libraryState.dialog === document.querySelector("#media-dialog"), file: window.libraryState.file === document.querySelector(".media-file-name"), focused: document.activeElement === window.libraryState.file, mutations: window.libraryState.mutations })), { dialog: true, file: true, focused: true, mutations: 0 });
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".media-source-record").count() === 3, "source records loaded");
  await page.evaluate(() => { window.sourceRecord = document.querySelector(".media-source-record"); });
  model.syncSummaries.person.message = "继续同步";
  await page.clock.runFor(1_100);
  await until(async () => (await page.locator(".sync-receipt > p").textContent()) === "继续同步", "second progress");
  assert.equal(await page.evaluate(() => window.sourceRecord === document.querySelector(".media-source-record")), true);
});

test("empty and failed local indices show actionable messages and can be retried", async (t) => {
  const { page, handlers } = await fixture(t, { count: 0 });
  await openLibrary(page);
  assert.match(await page.locator("#media-list").textContent(), /完成首次同步/);
  handlers.set("/api/persons/person/media", () => ({ _status: 503, error: "NAS 暂时不可访问" }));
  await page.locator("#refresh-media-list").click();
  await until(async () => (await page.locator("#media-list-status").textContent()).includes("NAS"), "index failure");
  assert.equal(await page.locator("#refresh-media-list").isEnabled(), true);
  handlers.set("/api/persons/person/media", () => ({ items: [makeMedia(0)], total: 1, offset: 0, limit: 50 }));
  await page.locator("#refresh-media-list").click();
  await until(async () => await page.locator(".media-file-name").count() === 1, "index retry");
  handlers.set("/api/persons/person/media/hash-0/sources", () => ({ _status: 503, error: "索引日志不可读取" }));
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".retry-file-sources").count() === 1, "source failure");
  handlers.delete("/api/persons/person/media/hash-0/sources");
  await page.locator(".retry-file-sources").click();
  await until(async () => await page.locator(".media-source-record").count() === 3, "source retry");
});

test("media and source dialogs inherit light, dark and system themes at mobile width", async (t) => {
  for (const theme of ["light", "dark", "system"]) {
    const { page, media } = await fixture(t, { theme, width: 390, count: 2 });
    media.forEach((file, index) => {
      file.filename = `${String(index).padStart(64, "a")}.jpg`;
      file.relativePath = `Image/${file.filename}`;
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await openLibrary(page);
    const expectedBackground = theme === "light" ? "rgb(255, 255, 255)" : "rgb(21, 30, 45)";
    const expectedForeground = theme === "light" ? "rgb(23, 32, 51)" : "rgb(238, 243, 251)";
    for (const id of ["media-dialog", "sources-dialog"]) {
      if (id === "sources-dialog") {
        await page.locator("#media-list .file-sources-button").first().click();
        await until(async () => await page.locator(".media-source-record").count() === 3, "themed sources");
      }
      const layout = await page.locator(`#${id}`).evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color, width: node.getBoundingClientRect().width, viewport: innerWidth, overflow: node.querySelector(".media-dialog-body").scrollWidth > node.querySelector(".media-dialog-body").clientWidth }));
      assert.equal(layout.background, expectedBackground);
      assert.equal(layout.foreground, expectedForeground);
      assert.ok(layout.width <= layout.viewport);
      assert.equal(layout.overflow, false);
      if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
        await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `${id}-mobile-${theme}.png`) });
        await page.setViewportSize({ width: 1400, height: 1000 });
        await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, `${id}-desktop-${theme}.png`) });
        await page.setViewportSize({ width: 390, height: 1000 });
      }
    }
  }
});

test("backup provenance stays escaped, readable and stable during sync polling", async (t) => {
  const { page, handlers, calls, model } = await fixture(t, { running: true, width: 390, count: 1 });
  const oldName = '<img src=x onerror="window.injected=1">_旧图片.jpg';
  const backupPath = `\\\\EXAMPLE-NAS\\FileShare\\People\\人物 A\\X\\作者 A\\Image\\${oldName}`;
  handlers.set("/api/persons/person/media/hash-0/sources", () => ({ sources: [{
    ...defaultSources[0], dateBasis: "legacy-filename", publicationDate: "20260927", displayTimeZone: "UTC",
    backupImports: [{ originalFileName: oldName, backupPath, importedAt: "2026-10-02T01:00:00.000Z" }],
  }] }));
  await openLibrary(page);
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".media-source-backups").count() === 1, "backup provenance");
  assert.equal(await page.locator(".backup-original-name").textContent(), oldName);
  assert.equal(await page.locator(".backup-source-path").textContent(), backupPath);
  assert.match(await page.locator("#sources-list").textContent(), /含备份记录|完整发布时间未知/);
  assert.match(await page.locator("#sources-list").textContent(), /首次导入（北京时间）/);
  assert.equal(await page.locator("#sources-list img, #sources-list script").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator(".media-dialog-body").last().evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.locator(".media-source-backups").evaluate((node) => { window.backupSourceNode = node; });
  model.syncSummaries.person.message = "其他账号正在同步";
  await page.waitForTimeout(1_300);
  assert.equal(await page.locator(".media-source-backups").evaluate((node) => node === window.backupSourceNode), true);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/sources")).length, 1);
  if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
    await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, "backup-sources-mobile-dark.png") });
  }
});

test("reviewed backup variants distinguish local edits from publisher originals", async (t) => {
  const { page, handlers } = await fixture(t, { width: 390, count: 1 });
  const original = "a".repeat(64), observed = "b".repeat(64);
  const evidence = '<script>window.injected=1</script> · 本地旋转并重新编码';
  handlers.set("/api/persons/person/media/hash-0/sources", () => ({ sources: [{
    ...defaultSources[0], dateBasis: "created-at-beijing", publicationDate: "20250121", displayTimeZone: "Asia/Shanghai",
    backupImports: [{ originalFileName: "20250120_1881404990302113831_01.jpg", backupPath: "\\\\EXAMPLE-NAS\\FileShare\\People\\7\\X\\作者\\Image\\original.jpg", importedAt: "2026-10-02T13:00:00.000Z",
      attributionEvidence: "local-modified", derivedFromMediaId: original, manifestExpectedSha256: original, observedSha256: observed,
      reviewEvidence: { method: "local-rotation-reencode", details: evidence } }],
  }] }));
  await openLibrary(page);
  await page.locator("#media-list .file-sources-button").click();
  await until(async () => await page.locator(".backup-variant-note").count() === 1, "backup variant");
  assert.match(await page.locator("#sources-list").textContent(), /本地修改副本.*原图发布日期/s);
  assert.match(await page.locator(".backup-variant-note").textContent(), /单独保留.*已核验原图/);
  assert.equal(await page.locator(".media-source-heading .open-bound-post").textContent(), "查看原图原帖 ↗");
  assert.equal(await page.locator("#sources-list script").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator(".media-dialog-body").last().evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.ok((await page.locator(".media-source-backups").textContent()).includes(evidence));
  assert.ok((await page.locator(".media-source-backups").textContent()).includes(original));
  if (process.env.MEDIA_TRACKER_UI_SCREENSHOTS) {
    await mkdir(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEDIA_TRACKER_UI_SCREENSHOTS, "backup-variant-mobile-dark.png") });
  }
});
