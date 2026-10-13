import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Rasterize our own vector locally. No image service, network, font or new
// runtime dependency participates in icon generation.
const publicDirectory = path.resolve(import.meta.dirname, "../public");
const svg = await readFile(path.join(publicDirectory, "media-tracker.svg"), "utf8");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
try {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  const entries = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    const png = await page.screenshot({ type: "png", omitBackground: true });
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    entries.push({ size, png });
    if (size === 256) await writeFile(path.join(publicDirectory, "media-tracker-256.png"), png);
  }
  const directory = Buffer.alloc(6 + 16 * entries.length);
  directory.writeUInt16LE(1, 2); // ICONDIR type: Windows icon.
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  for (let index = 0; index < entries.length; index++) {
    const { size, png } = entries[index];
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  await writeFile(path.join(publicDirectory, "media-tracker-v2.ico"), Buffer.concat([directory, ...entries.map(({ png }) => png)]));
  console.log(`Local icons built: ${sizes.join(", ")} px; SVG + PNG + Windows ICO.`);
} finally { await browser.close(); }
