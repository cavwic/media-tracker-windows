import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("collection UI uses the requested navigation and heading without the retired eyebrow", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /data-view="people" aria-label="采集账号"/);
  assert.match(html, /<h1\b(?=[^>]*\bid="people-title")[^>]*>目标账号信息<\/h1>/);
  assert.doesNotMatch(html + app, /人物档案|人物与目录|把分散的账号，归到同一个人名下/);
  assert.match(html, /id="create-person-button"/);
  assert.match(app, /建立采集账号/);
});
