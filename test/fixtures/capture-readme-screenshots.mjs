/**
 * README demonstration screenshots of the real application UI.
 * All accounts, paths, posts, media metadata and sync receipts are fictional.
 * Playwright routes every request; no server, login profile, platform or media
 * download is opened. No runtime HTML, CSS or JavaScript is modified.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const imageDirectory = new URL("docs/images/", root);
const origin = "http://127.0.0.1:54389";
const assetNames = ["index.html", "app.js", "i18n.js", "i18n-dynamic.js", "theme-bootstrap.js", "styles.css", "media-tracker.svg"];
const assets = new Map(await Promise.all(assetNames.map(async (name) => [name, await readFile(new URL(`public/${name}`, root))])));
const platforms = { x: { label: "X" }, instagram: { label: "Instagram" }, facebook: { label: "Facebook" }, tiktok: { label: "TikTok" } };
const examplePerson = (id, name, entries, note) => ({
  id, name, note, folderPath: `D:\\Media Library\\${name}`,
  homepageUrl: `https://${id}.example.invalid/`,
  platforms: entries.map((platformId, index) => ({ id: platformId, label: platforms[platformId].label,
    accounts: [{ id: `${id}-${platformId}`, label: `example_${id}${index ? "_studio" : ""}`,
      profileUrl: `https://${platformId}.example.invalid/example_${id}/`,
      linkedAccountId: `demo-login-${platformId}`, syncEnabled: true,
      downloadMedia: { image: true, video: true, gif: true } }] })),
});
const people = [
  examplePerson("nova", "Studio Nova", ["x", "instagram"], "Photography & travel"),
  examplePerson("cedar", "Cedar Lens", ["instagram", "tiktok"], "Portraits & short films"),
  examplePerson("vale", "Vale River", ["x", "facebook"], "Daily sketches & process"),
  examplePerson("shore", "Shoreline Frame", ["tiktok"], "Coastal stories"),
];
const hash = (index) => createHash("sha256").update(`fictional-readme-asset-${index}`).digest("hex");
const filename = (index, extension = "jpg") => `20261014_Studio Nova_${String(index).padStart(2, "0")}_${hash(index).slice(0, 16)}.${extension}`;
const media = Array.from({ length: 7 }, (_, index) => ({
  mediaId: hash(index + 1), filename: filename(index + 1, index === 3 ? "mp4" : "jpg"),
  relativePath: `${index === 3 ? "Video" : "Image"}/${filename(index + 1, index === 3 ? "mp4" : "jpg")}`,
  kind: index === 3 ? "video" : "image", bytes: index === 3 ? 18_451_200 : 3_244_032 + index * 58_000,
  sourceCount: index ? 1 : 3,
}));
const sources = ["x", "instagram", "x"].map((platformId, index) => ({
  platformId, platformLabel: platforms[platformId].label,
  accountId: index === 2 ? "nova-x-secondary" : `nova-${platformId}`,
  accountLabel: index === 2 ? "example_nova_sketches" : `example_nova${index ? "_studio" : ""}`,
  logicalKey: `demo-post-${index + 1}:0`, postId: `demo-post-${index + 1}`,
  postUrl: `https://${platformId}.example.invalid/post/demo-post-${index + 1}`,
  publicationDate: "20261014", dateBasis: "created-at-beijing", displayTimeZone: "Asia/Shanghai",
  createdAt: `2026-10-14T0${index + 1}:30:00.000Z`, firstSeenAt: "2026-10-15T01:00:00.000Z",
}));

function modelFor(language, theme) {
  return {
    runtime: { label: "工具内置 Chromium", systemLanguage: language },
    release: { edition: "public", channel: "minimal", version: "1.2.0" },
    settings: { language, theme }, platforms, persons: structuredClone(people),
    linkedAccounts: Object.keys(platforms).map((platformId) => ({ id: `demo-login-${platformId}`, platformId,
      platformLabel: platforms[platformId].label, label: `Demo · ${platforms[platformId].label}`, loginStatus: "verified" })),
    syncSummaries: {
      nova: { id: "demo-job-nova", personId: "nova", status: "completed", message: "同步完成。", newFileCount: 1,
        finishedAt: "2026-10-15T01:08:00.000Z", counters: { accounts: 2, accountsFinished: 2, discovered: 18, downloaded: 1, skipped: 17, failed: 0, bytes: 3_244_032 } },
      cedar: { id: "demo-job-cedar", personId: "cedar", status: "completed", message: "同步完成。", newFileCount: 1,
        finishedAt: "2026-10-15T01:07:00.000Z", counters: { accounts: 2, accountsFinished: 2, discovered: 12, downloaded: 1, skipped: 11, failed: 0, bytes: 18_451_200 } },
      vale: { id: "demo-job-vale", personId: "vale", status: "completed", message: "同步完成。", newFileCount: 0,
        finishedAt: "2026-10-15T01:06:00.000Z", counters: { accounts: 2, accountsFinished: 2, discovered: 6, downloaded: 0, skipped: 6, failed: 0, bytes: 0 } },
    },
    features: { dedup: { id: "similarity-dedup", available: false, installed: false, included: false,
      installing: false, installAvailable: true, packageAvailable: true, progress: null,
      message: "相似去重尚未启用；采集与精确去重保留。" } },
  };
}

async function fixture(browser, language, theme) {
  const context = await browser.newContext({ locale: language === "zh" ? "zh-CN" : "en-US",
    viewport: { width: 1440, height: 1100 }, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage();
  const model = modelFor(language, theme);
  const errors = [], external = [], unexpected = [], mutations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("__mediaTrackerWindow", async () => ({ frameless: true, maximized: false, minimized: false }));
  await page.addInitScript(() => { window.__mediaTrackerWindowState = { frameless: true, maximized: false, minimized: false }; });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (request.method() !== "GET") mutations.push({ path: url.pathname, method: request.method() });
    let payload;
    if (url.pathname === "/api/session") payload = { token: "a".repeat(64), header: "X-Media-Tracker-Token", applicationId: "media-tracker-public" };
    else if (url.pathname === "/api/state") payload = model;
    else if (url.pathname === "/api/runtime/status") payload = model.runtime;
    else if (/^\/api\/persons\/[^/]+\/new-files$/.test(url.pathname)) {
      const personId = url.pathname.split("/")[3];
      payload = { available: true, jobId: model.syncSummaries[personId]?.id,
        files: media.slice(0, 1).map((item, index) => ({ id: `demo-file-${index}`, ...item, platformLabel: "X", accountLabel: "example_nova" })) };
    } else if (url.pathname === "/api/persons/nova/media") payload = { items: media, total: media.length, offset: 0, limit: 50 };
    else if (/^\/api\/persons\/nova\/media\/[^/]+\/sources$/.test(url.pathname)) payload = { mediaId: media[0].mediaId, sources };
    else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!assets.has(name)) { unexpected.push(url.pathname); return route.fulfill({ status: 404, body: "Not found" }); }
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html", body: assets.get(name) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(origin);
  await page.locator('.person-card[data-person-id="nova"]').waitFor();
  await page.waitForFunction(({ language, theme }) => document.documentElement.dataset.language === language && document.documentElement.dataset.theme === theme, { language, theme });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, async verify() { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpected, []); assert.deepEqual(mutations, []); } };
}

async function save(page, name) {
  await page.mouse.move(1430, 1090);
  const target = new URL(name, imageDirectory);
  await page.screenshot({ path: fileURLToPath(target), animations: "disabled" });
  const { size } = await stat(target);
  console.log(JSON.stringify({ file: `docs/images/${name}`, bytes: size, width: 1440, height: 1100 }));
}

await mkdir(imageDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const language of ["zh", "en"]) {
    let view = await fixture(browser, language, "dark");
    await view.page.locator('.person-card[data-person-id="nova"] .new-files-toggle').click();
    await view.page.locator('.person-card[data-person-id="nova"] .new-file-name').first().waitFor();
    await save(view.page, `overview-${language}.png`);
    await view.verify();
    await view.context.close();

    view = await fixture(browser, language, "light");
    await view.page.locator('.person-card[data-person-id="nova"] .edit-person').click();
    await view.page.locator('#person-dialog').waitFor({ state: "visible" });
    // Use the actual scrollable editor, showing its account controls beside the
    // sticky unified-directory blueprint, just as a user would scroll to them.
    await view.page.locator('#platform-editor').scrollIntoViewIfNeeded();
    await save(view.page, `setup-${language}.png`);
    await view.verify();
    await view.context.close();

    view = await fixture(browser, language, "light");
    await view.page.locator('.person-card[data-person-id="nova"] .browse-person-media').click();
    await view.page.locator('.media-library-row').first().waitFor();
    await view.page.locator('.file-sources-button').first().click();
    await view.page.locator('.media-source-record').nth(2).waitFor();
    await save(view.page, `sources-${language}.png`);
    await view.verify();
    await view.context.close();
  }
} finally { await browser.close(); }
