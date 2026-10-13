import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { babelParse } = require("../node_modules/playwright/lib/transform/babelBundle.js");
const publicUrl = new URL("../public/", import.meta.url);

function translations(language = "en") {
  const window = {
    navigator: { language: language === "zh" ? "zh-CN" : "en-US" },
    document: { documentElement: { dataset: {}, setAttribute() {} }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return language; }, setItem() {} },
    CustomEvent: class CustomEvent {},
    addEventListener() {},
    dispatchEvent() {},
  };
  window.window = window;
  const context = vm.createContext(window);
  for (const filename of ["i18n.js", "i18n-dynamic.js"]) {
    vm.runInContext(fs.readFileSync(new URL(filename, publicUrl), "utf8"), context, { filename });
  }
  return window.MediaTrackerI18n;
}

function chineseUiLiterals() {
  const ast = babelParse(fs.readFileSync(new URL("app.js", publicUrl), "utf8"), "app.js");
  const literals = new Set();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const value = node.type === "StringLiteral" ? node.value : node.type === "TemplateElement" ? node.value.cooked : null;
    if (typeof value === "string" && /[\u3400-\u9fff]/.test(value)) literals.add(value);
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(ast);
  return literals;
}

test("English dictionary covers every runtime Chinese UI literal and HTML fragment", () => {
  const i18n = translations();
  const missing = [...chineseUiLiterals()].filter((value) => /[\u3400-\u9fff]/.test(i18n.translateLiteral(value)));
  assert.deepEqual(missing, [], `Missing runtime translations: ${JSON.stringify(missing)}`);
});

test("Chinese mode preserves every runtime literal byte-for-byte", () => {
  const i18n = translations("zh");
  for (const value of chineseUiLiterals()) assert.equal(i18n.translateLiteral(value), value);
});

test("runtime labels and safety-critical explanations keep their meaning in English", () => {
  const { tr } = translations();
  assert.equal(tr("增量同步"), "Incremental sync");
  assert.equal(tr("日期未知"), "Date unknown");
  assert.equal(tr("登录验证未通过"), "Login verification failed");
  assert.equal(tr("已使用系统默认程序打开并显示在前台。"), "Opened in the default system app and brought to the foreground.");
  assert.match(tr("将删除这些历史资料夹及其全部文件，包括旧尝试登录留下的 Cookie、网站存储和设置。不进回收站，不能撤销。这与只删除普通缓存不同；如果仍需使用其中的登录资料，请取消。"), /permanently deleted.*cookies.*cannot be undone.*login data/s);
  assert.match(tr("按可测量的分辨率、清晰度与内容完整性选保留版本，不保证适合 LoRA 训练。保留不同音轨版本；判断不充分的文件保留，这不是下载失败。可随时停止去重；安全停止后关闭本次结果，再次开始会复用已保存的本地检查记录。合并版本移入人物 Index/DedupArchive，全部发布来源和恢复记录保留；归档仍占空间，不会自动永久删除。不上传媒体、不使用 AI 服务，也不清理账号登录资料。"), /Different audio tracks are kept.*No media is uploaded, no AI service is used, and account login data is not cleaned/s);
});

test("tagged templates translate UI fragments without changing Chinese names, paths, or HTML", () => {
  const { tr } = translations();
  const personName = "人物名称图片视频";
  const filePath = "\\\\EXAMPLE-NAS\\FileShare\\人物名称\\图片.jpg";
  const result = tr`<span title="单击使用系统默认程序打开；右键打开文件菜单">${personName}</span><small>${filePath}</small><button>查看来源</button>`;
  assert.equal(result, `<span title="Click to open in the default system app; right-click for file actions">${personName}</span><small>${filePath}</small><button>View sources</button>`);
  assert.equal(tr`已识别 ${2} / 预期 ${3} 个附件`, "Found 2 / expected 3 attachments");
  assert.equal(tr`删除人物“${personName}”？`, `Delete person “${personName}”?`);
});

test("unknown runtime messages are not broadly rewritten like UI literals", () => {
  const { translateMessage } = translations();
  const customMessage = "人物名称图片视频：自定义平台错误";
  assert.equal(translateMessage(customMessage), customMessage);
});

test("empty messages remain empty after a literal fragment translates to empty text", () => {
  const i18n = translations();
  assert.equal(i18n.tr(" 位"), "");
  for (const value of [null, undefined, ""]) assert.equal(i18n.translateMessage(value), "");
  i18n.setPreference("zh");
  for (const value of [null, undefined, ""]) assert.equal(i18n.translateMessage(value), "");
});

test("dynamic number fragments compose readable English without changing their values", () => {
  const { tr } = translations();
  assert.equal(tr`队列第 ${7} 位`, "Queue position 7");
  assert.equal(tr`正在为 ${5} 个人物建立并行任务…`, "Creating parallel tasks for 5 people…");
  assert.equal(tr`共 ${12} 条来源记录 · 采集账号移除后，历史来源仍会保留。`, "Total 12 sources · Historical sources remain after a target account is removed.");
  assert.equal(tr`已删除 ${2} 个历史资料夹，删除文件 ${31} 个，释放 ${"3.5 MB"}。`, "Deleted 2 old profiles; files deleted: 31; space freed: 3.5 MB. ");
  assert.equal(tr`已添加 ${3} 个账号。保存人物后生效。`, "Added 3 accounts. Changes take effect after saving the person.");
});

test("fixed service messages translate without losing login or retention guarantees", () => {
  const i18n = translations();
  assert.equal(i18n.translateMessage("已确认账号处于登录状态。"), "Account confirmed as logged in.");
  assert.match(i18n.translateMessage("旧版登录结果尚未通过在线身份检查，请点击“验证登录”；无需重新绑定账号。"), /do not need to link the account again/);
  assert.match(i18n.translateMessage("同步已取消；已完成的文件和索引会保留。"), /files and indexes are retained/);
  assert.match(i18n.translateMessage("画面接近，但音轨不同或无法确认一致，已同时保留。"), /audio tracks differ.*Both retained/);
  assert.match(i18n.translateMessage("该资料现在仍被账号绑定使用，禁止删除。"), /linked account.*Deletion is prohibited/);
  i18n.setPreference("zh");
  assert.equal(i18n.translateMessage("Account confirmed as logged in."), "已确认账号处于登录状态。");
});

test("custom-platform collection messages are translated exactly, without asserting full coverage", () => {
  const i18n = translations();
  const source = fs.readFileSync(new URL("../lib/custom-sync.mjs", import.meta.url), "utf8");
  const ast = babelParse(source, "custom-sync.mjs");
  let messages;
  function find(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id?.name === "MESSAGES") messages = node.init;
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(find);
      else find(child);
    }
  }
  find(ast);
  assert.equal(messages?.type, "ObjectExpression");
  for (const property of messages.properties) {
    const original = property.value.value;
    const english = i18n.translateMessage(original);
    assert.notEqual(english, original, property.key.value);
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
  }
  assert.match(i18n.translateMessage("已识别账号类采集器和可下载媒体；本次仅检测少量元数据，不代表完整历史已同步。"), /small metadata sample.*full history has not been synced/);
  assert.match(i18n.translateMessage("已识别可下载媒体，但尚不能确认此链接支持完整账号历史；当前仅具备单页或有限范围采集能力。"), /full account-history support.*unconfirmed.*single page or limited scope/);
});

test("anchored service-progress formats preserve opaque names, HTML, paths, URLs, and diagnostic text", () => {
  const i18n = translations();
  const account = '人物 的 <b>图片与视频</b> \\\\EXAMPLE-NAS\\FileShare\\图片。jpg';
  const platform = "自定义微博平台";
  const url = "https://example.com/人物的视频?folder=图片&name=%E4%BA%BA";
  const diagnostic = "fetch failed：\\\\EXAMPLE-NAS\\FileShare\\图片。jpg <script>账户</script>";
  const pairs = [
    [`正在读取 ${account} 的 X 时间线。`, `Reading the X timeline for ${account}.`],
    [`正在读取 ${account} 的 Instagram 时间线。`, `Reading the Instagram timeline for ${account}.`],
    [`正在读取 ${account}：已发现 42 个媒体文件。`, `Reading ${account}: 42 media files found.`],
    [`正在保存 ${account} 的 视频。`, `Saving a video from ${account}.`],
    [`正在本地检查 ${account} 的图片和视频；冗余版本仅隔离保留。`, `Checking images and videos locally for ${account}; redundant versions are archived, not deleted.`],
    [`正在检查 ${account}：2/8，已合并 1 份，差异版本保留 3 项。`, `Checking ${account}: 2/8; 1 versions merged; 3 distinct versions kept.`],
    ["正在本地去重：2/8，合并 1 份，差异版本保留 3 项。", "Local deduplication: 2/8; 1 versions merged; 3 distinct versions kept."],
    ["媒体服务器返回 HTTP 404。", "The media server returned HTTP 404."],
    ["未能读取 Instagram 时间线（匹配响应 4 个）。", "Could not read the Instagram timeline (4 matching responses)."],
    ["TikTok 时间线请求失败（HTTP 403）", "TikTok timeline request failed (HTTP 403)."],
    [`媒体下载失败（${url}）：${diagnostic}`, `Media download failed (${url}): ${diagnostic}`],
  ];
  for (const [original, expected] of pairs) assert.equal(i18n.translateMessage(original), expected);
  const customPlatform = `${platform} 的 <span>图片</span>`;
  const customMessage = `正在读取 ${account} 的 ${customPlatform} 媒体。`;
  assert.equal(i18n.translateMessage(customMessage), customMessage, "ambiguous custom names are never split without model context");
  assert.equal(i18n.translateMessage(customMessage, { accountLabel: account, platformLabel: customPlatform }), `Reading ${customPlatform} media for ${account}.`);
  for (const original of [account, platform, url, diagnostic, `自定义说明：正在读取 ${account} 的 X 时间线。`]) {
    assert.equal(i18n.translateMessage(original), original);
  }
  i18n.setPreference("zh");
  assert.equal(i18n.translateMessage(`Reading ${customPlatform} media for ${account}.`), customMessage);
  for (const [original, english] of pairs) assert.equal(i18n.translateMessage(english), original);
});
