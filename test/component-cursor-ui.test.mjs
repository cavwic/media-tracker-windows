import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Offline stylesheet fixtures: no accounts, installers, production service,
// media, component downloads or requests to social-media websites.
let browser;
let styles;
before(async () => {
  styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, theme) {
  const context = await browser.newContext({ colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  const external = [];
  await page.route("**/*", (route) => { external.push(route.request().url()); return route.abort(); });
  t.after(() => assert.deepEqual(external, []));
  await page.setContent(`<html data-theme="${theme === "system" ? "dark" : theme}"><body>
    <button id="missing-toolbar" class="secondary-button dedup-unavailable" aria-disabled="true" aria-busy="false">Prepare dedup tools</button>
    <div class="person-card-actions"><button id="missing-person" class="secondary-button dedup-unavailable" aria-disabled="true" aria-busy="false">Prepare person dedup</button>
      <button id="disabled-person" class="primary-button" disabled>Unavailable action</button>
    </div>
    <dialog id="tools" class="dedup-tools-dialog" aria-busy="false">
      <button id="cannot-install" class="primary-button" disabled>Installation unavailable</button>
      <button id="fixed-location" class="secondary-button" disabled>Fixed location</button>
      <button id="install" class="primary-button">Prepare environment</button>
      <input id="path" disabled aria-label="Fixed installation path">
      <button id="close" class="secondary-button">Close</button>
    </dialog>
  </body></html>`);
  await page.addStyleTag({ content: styles });
  return page;
}

async function cursor(page, selector) {
  return page.locator(selector).evaluate((node) => getComputedStyle(node).cursor);
}

for (const theme of ["light", "dark", "system"]) {
  test(`missing components use a normal cursor in ${theme} appearance`, async (t) => {
    const page = await fixture(t, theme);
    for (const selector of ["#missing-toolbar", "#missing-person", "#disabled-person"]) {
      assert.equal(await cursor(page, selector), "default");
    }
    await page.evaluate(() => document.querySelector("#tools").showModal());
    for (const selector of ["#cannot-install", "#fixed-location"]) {
      assert.equal(await cursor(page, selector), "default");
    }
    assert.equal(await cursor(page, "#install"), "pointer");
    assert.equal(await cursor(page, "#close"), "pointer");
    if (theme === "system") {
      await page.emulateMedia({ colorScheme: "light" });
      await page.evaluate(() => document.documentElement.dataset.theme = "light");
      assert.equal(await cursor(page, "#fixed-location"), "default");
      assert.equal(await cursor(page, "#install"), "pointer");
    }
  });
}

test("only explicit preparation or operation states show a busy cursor", async (t) => {
  const page = await fixture(t, "dark");
  await page.evaluate(() => {
    document.querySelector("#missing-toolbar").setAttribute("aria-busy", "true");
    document.querySelector("#missing-person").setAttribute("aria-busy", "true");
    document.querySelector("#disabled-person").setAttribute("aria-busy", "true");
    document.querySelector("#tools").setAttribute("aria-busy", "true");
    document.querySelector("#tools").showModal();
  });
  for (const selector of ["#missing-toolbar", "#missing-person", "#disabled-person", "#cannot-install", "#fixed-location", "#path"]) {
    assert.equal(await cursor(page, selector), "wait");
  }
  assert.equal(await cursor(page, "#close"), "pointer", "cancellation remains an ordinary actionable control");
  await page.evaluate(() => {
    document.querySelector("#tools").setAttribute("aria-busy", "false");
    document.querySelector("#missing-toolbar").setAttribute("aria-busy", "false");
  });
  assert.equal(await cursor(page, "#fixed-location"), "default");
  assert.equal(await cursor(page, "#missing-toolbar"), "default");
});

test("normal cursor does not make the missing-tool preparation entry inaccessible", async (t) => {
  const page = await fixture(t, "dark");
  await page.evaluate(() => {
    window.preparationOffers = 0;
    document.querySelector("#missing-toolbar").addEventListener("click", () => { window.preparationOffers += 1; });
  });
  await page.locator("#missing-toolbar").focus();
  assert.equal(await page.locator("#missing-toolbar").evaluate((node) => document.activeElement === node), true);
  assert.equal(await page.locator("#missing-toolbar").evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.preparationOffers), 1);
  assert.equal(await cursor(page, "#missing-toolbar"), "default");
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.preparationOffers), 2);
});
