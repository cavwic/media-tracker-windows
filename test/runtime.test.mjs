import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

test("the application uses its Playwright-managed Chromium runtime", () => {
  const executable = chromium.executablePath();
  assert.equal(existsSync(executable), true);
  assert.match(executable, /ms-playwright[\\/]chromium-/i);
  assert.doesNotMatch(executable, /Microsoft[\\/]Edge|Google[\\/]Chrome[\\/]Application/i);
});
