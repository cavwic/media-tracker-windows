import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { documentationFiles, documentationImages } from "../packaging/documentation-files.mjs";
import { permittedSourcePath } from "../packaging/export-github-source.mjs";
import { permittedPackagePath } from "../packaging/build-portable.mjs";

test("only reviewed documentation images are allowed into source publication", () => {
  assert.equal(Object.isFrozen(documentationImages), true);
  assert.equal(Object.isFrozen(documentationFiles), true);
  assert.equal(documentationImages.length, 7);
  assert.equal(new Set(documentationFiles).size, documentationFiles.length);
  assert.deepEqual(documentationFiles, ["docs/README.en.md", ...documentationImages]);
  for (const file of documentationFiles) {
    assert.equal(permittedSourcePath(file), true, file);
    assert.equal(permittedPackagePath(file), true, file);
  }
  for (const file of ["docs/images/account-profile.png", "docs/images/login.jpg", "docs/images/banner-copy.jpg", "packaging/verification/private.png"]) {
    assert.equal(permittedSourcePath(file), false, file);
  }
});

test("bilingual readmes use professional headings, matching screenshots and valid local links", async () => {
  const chineseHeadings = ["产品亮点", "产品简介", "快速上手", "界面预览"];
  const englishHeadings = ["Highlights", "Overview", "Quick start", "Interface preview"];
  for (const [file, language, headings] of [
    ["README.md", "both", [...chineseHeadings, ...englishHeadings]],
    ["docs/README.en.md", "en", englishHeadings],
  ]) {
    const project = new URL("../", import.meta.url);
    const document = new URL(file, project);
    const resolveLink = (link) => {
      const target = new URL(link, document);
      const relative = path.relative(fileURLToPath(project), fileURLToPath(target));
      assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep), link);
      return { target, relative: relative.split(path.sep).join("/") };
    };
    const text = await readFile(document, "utf8");
    assert.deepEqual(text.match(/^## .+$/gm), headings.map((heading) => "## " + heading));
    if (language === "both") {
      assert.doesNotMatch(text, /\]\(README\.en\.md/);
      assert.deepEqual([...text.matchAll(/<details name="readme-language"( open)?>/g)].map((match) => Boolean(match[1])), [true, false]);
      for (const locale of ["zh", "en"]) {
        assert.ok(text.includes(`href="#user-content-readme-${locale}"`));
        assert.ok(text.includes(`<a name="readme-${locale}"></a>`));
      }
      assert.doesNotMatch(text, /<script|<style|onclick=/i);
    }
    assert.match(text, /Windows 10\/11 x64/);
    assert.match(text, /首次编译\.cmd/);
    assert.match(text, /采集工具\.exe/);
    assert.doesNotMatch(text, /公开最小版|最小公开版|后续计划|本版内容|## 是什么|## 能做什么|## 怎么用/);
    const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => resolveLink(match[1]).relative);
    const languages = language === "both" ? ["zh", "en"] : [language];
    assert.deepEqual(images, [documentationImages[0], ...languages.flatMap((locale) => ["overview", "setup", "sources"].map((name) => `docs/images/${name}-${locale}.png`))]);
    for (const match of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) {
      await readFile(resolveLink(match[1]).target);
    }
    assert.match(text, /fictional demo data/);
    assert.match(text, /not received platform authorization/);
    assert.match(text, /unsigned/);
    if (language === "both") {
      assert.match(text, /虚构演示数据/);
      assert.match(text, /未获平台自动采集许可/);
      assert.match(text, /未签名/);
    }
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

test("all documentation screenshot views use the same dark theme", async () => {
  const capture = await readFile(new URL("fixtures/capture-readme-screenshots.mjs", import.meta.url), "utf8");
  assert.equal([...capture.matchAll(/fixture\(browser, language, "dark"\)/g)].length, 3);
  assert.doesNotMatch(capture, /fixture\(browser, language, "light"\)/);
});
