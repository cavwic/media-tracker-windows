import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { documentationFiles, documentationImages } from "../packaging/documentation-files.mjs";
import { permittedSourcePath } from "../packaging/export-github-source.mjs";
import { permittedPackagePath } from "../packaging/build-portable.mjs";

test("only reviewed documentation images are allowed into source publication", () => {
  assert.equal(Object.isFrozen(documentationImages), true);
  assert.equal(Object.isFrozen(documentationFiles), true);
  assert.equal(documentationImages.length, 7);
  assert.equal(new Set(documentationFiles).size, documentationFiles.length);
  assert.deepEqual(documentationFiles, ["README.en.md", ...documentationImages]);
  for (const file of documentationFiles) {
    assert.equal(permittedSourcePath(file), true, file);
    assert.equal(permittedPackagePath(file), true, file);
  }
  for (const file of ["docs/images/account-profile.png", "docs/images/login.jpg", "docs/images/banner-copy.jpg", "packaging/verification/private.png"]) {
    assert.equal(permittedSourcePath(file), false, file);
  }
});

test("bilingual readmes use professional headings, matching screenshots and valid local links", async () => {
  for (const [file, language, headings] of [
    ["README.md", "zh", ["产品亮点", "产品简介", "快速上手", "界面预览"]],
    ["README.en.md", "en", ["Highlights", "Overview", "Quick start", "Interface preview"]],
  ]) {
    const text = await readFile(new URL("../" + file, import.meta.url), "utf8");
    assert.deepEqual(text.match(/^## .+$/gm), headings.map((heading) => "## " + heading));
    assert.match(text, /README\.en\.md/);
    assert.match(text, /Windows 10\/11 x64/);
    assert.match(text, /首次编译\.cmd/);
    assert.match(text, /采集工具\.exe/);
    assert.doesNotMatch(text, /公开最小版|最小公开版|后续计划|本版内容|## 是什么|## 能做什么|## 怎么用/);
    const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
    assert.deepEqual(images, [documentationImages[0], ...["overview", "setup", "sources"].map((name) => `docs/images/${name}-${language}.png`)]);
    for (const match of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) {
      assert.equal(match[1].startsWith("../"), false);
      await readFile(new URL("../" + match[1], import.meta.url));
    }
    assert.match(text, language === "zh" ? /虚构演示数据/ : /fictional demo data/);
    assert.match(text, language === "zh" ? /未获平台自动采集许可/ : /not received platform authorization/);
    assert.match(text, language === "zh" ? /未签名/ : /unsigned/);
  }
});

test("documentation raster assets have expected formats and a small total size", async () => {
  let total = 0;
  for (const file of documentationImages) {
    const bytes = await readFile(new URL("../" + file, import.meta.url));
    assert.ok(bytes.length > 100 && bytes.length < 1024 * 1024, file);
    if (file.endsWith(".jpg")) assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255]);
    else {
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(bytes.readUInt32BE(16) >= 1200, file);
      assert.ok(bytes.readUInt32BE(20) >= 800, file);
    }
    total += bytes.length;
  }
  assert.ok(total < 2 * 1024 * 1024, "Documentation images should not bloat the next portable package");
});

test("portable builder fingerprints and copies the same reviewed bilingual documentation", async () => {
  const build = await readFile(new URL("../packaging/build-portable.mjs", import.meta.url), "utf8");
  assert.match(build, /documentationFiles\.map\(\(name\) => \(\{ source: name, file: name \}\)\)/);
  assert.match(build, /for \(const name of documentationFiles\) await copyTree/);
});
