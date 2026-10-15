import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Offline native-browser regression, not a substitute for GitHub integration.
// The prefix is the current official Markdown API's observed sanitization;
// publishing also verifies that API output and the actual repository page.
test("README native language selection reveals only one body, including after scrolling", {
  skip: !existsSync(chromium.executablePath()), timeout: 30000,
}, async (t) => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const nativeFixture = readme.replace(/name="(readme-[^"]+)"/g, 'name="user-content-$1"');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 700, height: 260 } });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(nativeFixture);
  const zh = "面向 Windows 的本地媒体采集与管理工具";
  const en = "A local media collection and management tool for Windows.";
  async function selected(language) {
    await page.waitForFunction((locale) => {
      const groups = [...document.querySelectorAll('details[name="user-content-readme-language"]')];
      return groups.length === 2 && groups[locale === "zh" ? 0 : 1].open && !groups[locale === "zh" ? 1 : 0].open;
    }, language);
    const text = await page.locator("body").innerText();
    assert.equal(text.includes(zh), language === "zh");
    assert.equal(text.includes(en), language === "en");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const afterScroll = await page.locator("body").innerText();
    assert.equal(afterScroll.includes(zh), language === "zh");
    assert.equal(afterScroll.includes(en), language === "en");
  }
  await selected("zh");
  await page.locator('a[href="#user-content-readme-en"]').click();
  await selected("en");
  await page.locator('a[href="#user-content-readme-zh"]').click();
  await selected("zh");
  const englishSummary = page.locator("details").nth(1).locator("summary");
  await englishSummary.focus();
  await page.keyboard.press("Enter");
  await selected("en");
  await page.locator("details").nth(0).locator("summary").click();
  await selected("zh");
});
