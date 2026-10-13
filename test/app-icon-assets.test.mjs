import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const publicDirectory = path.join(root, "public");
test("the Windows icon includes sharp alpha PNG frames at every common taskbar and shortcut size", async () => {
  const icon = await readFile(path.join(publicDirectory, "media-tracker-v2.ico"));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 7);
  const sizes = [];
  for (let index = 0; index < 7; index++) {
    const entry = 6 + index * 16;
    const width = icon[entry] || 256, height = icon[entry + 1] || 256;
    assert.equal(width, height);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    const bytes = icon.readUInt32LE(entry + 8), offset = icon.readUInt32LE(entry + 12);
    assert.ok(offset >= 118 && offset + bytes <= icon.length);
    const png = icon.subarray(offset, offset + bytes);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    assert.equal(png[25], 6, "RGBA transparency avoids opaque square corners");
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test("the brand SVG and browser favicon stay local and render in light/dark themes without layout overflow", async (t) => {
  const html = await readFile(path.join(publicDirectory, "index.html"), "utf8");
  const svg = await readFile(path.join(publicDirectory, "media-tracker.svg"), "utf8");
  assert.match(html, /rel="icon"[^>]*href="\/media-tracker\.svg"/);
  assert.match(html, /rel="alternate icon"[^>]*href="\/media-tracker-v2\.ico"/);
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject|text)\b|(?:href|src)=/i);
  const stylesheet = await readFile(path.join(publicDirectory, "styles.css"), "utf8");
  const server = http.createServer((request, response) => {
    if (request.url === "/media-tracker.svg") { response.setHeader("Content-Type", "image/svg+xml"); response.end(svg); }
    else { response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><style>${stylesheet}</style><div class="brand-block"><img class="brand-mark" src="/media-tracker.svg" width="40" height="40" alt=""><strong>Media Tracker</strong></div>`); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 200 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const external = [];
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    assert.deepEqual(await page.locator(".brand-mark").evaluate((element) => ({ width: element.clientWidth,
      height: element.clientHeight, loaded: element.complete && element.naturalWidth > 0 })), { width: 40, height: 40, loaded: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  assert.deepEqual(external, []);
});
