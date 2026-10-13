(() => {
  "use strict";

  const storageKey = "media-tracker-language";
  const dictionary = new Map();
  const staticRecords = new WeakMap();
  const renderedPairs = new Map();
  let fragmentMatcher;
  const normalizeLanguage = (value) => /^zh(?:[-_]|$)/i.test(String(value || "")) ? "zh" : "en";
  const normalizePreference = (value) => ["system", "zh", "en"].includes(value) ? value : "system";
  let preference = "system";
  try { preference = normalizePreference(localStorage.getItem(storageKey)); } catch {}
  let systemLanguage = normalizeLanguage(navigator.language);
  let systemLanguageConfirmed = false;
  let language = preference === "system" ? systemLanguage : preference;

  function register(entries) {
    for (const [original, translated] of Object.entries(entries || {})) {
      if (typeof translated === "string") dictionary.set(original, translated);
    }
    fragmentMatcher = undefined;
  }

  function translateLiteral(value, resolvedLanguage = language) {
    const original = String(value ?? "");
    if (resolvedLanguage === "zh") return original;
    const punctuation = (text) => text.replace(/[，。？！：；（）]/g,
      (mark) => ({ "，": ", ", "。": ". ", "？": "?", "！": "!", "：": ": ", "；": "; ", "（": "(", "）": ")" })[mark]);
    if (dictionary.has(original)) return punctuation(dictionary.get(original));
    if (!/[\u3400-\u9fff]/.test(original)) return punctuation(original);
    if (!fragmentMatcher) {
      const fragments = [...dictionary.keys()].filter((key) => key.length > 1 && /[\u3400-\u9fff]/.test(key));
      fragments.sort((left, right) => right.length - left.length);
      fragmentMatcher = fragments.length ? new RegExp(fragments.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : /$^/g;
    }
    return punctuation(original.replace(fragmentMatcher, (match) => dictionary.get(match)));
  }

  // Template values are deliberately left untouched: names, paths and filenames are user data.
  function rememberPair(pair) {
    if (pair.zh) renderedPairs.set(pair.zh, pair);
    if (pair.en) renderedPairs.set(pair.en, pair);
    while (renderedPairs.size > 4000) renderedPairs.delete(renderedPairs.keys().next().value);
    return pair[language];
  }

  function tr(value, ...substitutions) {
    const template = Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "raw");
    const render = (resolvedLanguage) => template
      ? value.reduce((result, literal, index) => result + translateLiteral(literal, resolvedLanguage) + (index < substitutions.length ? String(substitutions[index] ?? "") : ""), "")
      : translateLiteral(value, resolvedLanguage);
    const pair = { zh: render("zh"), en: render("en") };
    return rememberPair(pair);
  }

  // Only known service message formats are translated. Captured names, platforms,
  // URLs and diagnostic details are opaque; arbitrary site/user text is not rewritten.
  const messageFormats = [
    [/^正在读取 (.+) 的 (X|Instagram|TikTok|Facebook) 时间线。$/, (_, account, platform) => `Reading the ${platform} timeline for ${account}.`],
    [/^正在读取 (.+)：已发现 (\d+) 个媒体文件。$/, (_, account, count) => `Reading ${account}: ${count} media files found.`],
    [/^正在保存 (.+) 的 (图片|视频|动图)。$/, (_, account, kind) => `Saving ${({ 图片: "an image", 视频: "a video", 动图: "a GIF" })[kind]} from ${account}.`],
    [/^排队第 (\d+) 位；(.+)$/, (_, position, reason) => `Queue position ${position}; ${translateMessage(reason)}`],
    [/^正在本地检查(?: (.+) |(所有人物))的图片和视频；冗余版本仅隔离保留。$/, (_, person) => `Checking images and videos locally for ${person || "all people"}; redundant versions are archived, not deleted.`],
    [/^正在检查 (.+)：(\d+)\/(\d+)，已合并 (\d+) 份，差异版本保留 (\d+) 项。$/, (_, person, checked, total, merged, kept) => `Checking ${person}: ${checked}/${total}; ${merged} versions merged; ${kept} distinct versions kept.`],
    [/^正在本地去重：(\d+)\/(\d+)，合并 (\d+) 份，差异版本保留 (\d+) 项。$/, (_, checked, total, merged, kept) => `Local deduplication: ${checked}/${total}; ${merged} versions merged; ${kept} distinct versions kept.`],
    [/^本地去重结束：合并 (\d+) 份，差异版本保留 (\d+) 项(?:，(\d+) 项检查未完成)?。差异版本已按保守规则自动保留，不是漏下载，也不要求手动检查。冗余原文件保存在 Index\/DedupArchive，全部发布来源保留；尚未释放总磁盘空间。$/, (_, merged, kept, incomplete) => `Local deduplication finished: ${merged} versions merged; ${kept} distinct versions kept${incomplete ? `; ${incomplete} checks incomplete` : ""}. Distinct versions were kept conservatively; they are not missing downloads and do not require manual review. Redundant originals are in Index/DedupArchive, with all publication sources preserved. Total disk space has not been freed.`],
    [/^媒体服务器返回 HTTP (\d{3})。$/, (_, status) => `The media server returned HTTP ${status}.`],
    [/^同步完成，但有 (\d+) 项失败，可再次同步重试。$/, (_, count) => `Sync finished with ${count} failures. Sync again to retry.`],
    [/^未能读取 Instagram 时间线（匹配响应 (\d+) 个）。$/, (_, count) => `Could not read the Instagram timeline (${count} matching responses).`],
    [/^TikTok 时间线请求失败（HTTP (\d{3})）$/, (_, status) => `TikTok timeline request failed (HTTP ${status}).`],
    [/^媒体下载失败（([^\r\n]+)）：([^\r\n]+)$/, (_, url, detail) => `Media download failed (${url}): ${detail}`],
  ];

  function translateMessage(value, context) {
    const original = String(value ?? "");
    if (!original) return "";
    const previous = renderedPairs.get(original);
    if (previous) return previous[language];
    // Custom names can contain the grammatical separator itself. Use supplied
    // model fields rather than guessing where an account/platform name ends.
    if (typeof context?.accountLabel === "string" && typeof context?.platformLabel === "string"
      && original === `正在读取 ${context.accountLabel} 的 ${context.platformLabel} 媒体。`) {
      return rememberPair({ zh: original, en: `Reading ${context.platformLabel} media for ${context.accountLabel}.` });
    }
    if (language === "en" && dictionary.has(original)) return dictionary.get(original);
    if (language === "en") {
      for (const [pattern, render] of messageFormats) {
        const match = original.match(pattern);
        if (match) return rememberPair({ zh: original, en: render(...match) });
      }
    }
    if (language === "zh") {
      for (const [source, translated] of dictionary) if (translated === original) return source;
    }
    return original;
  }

  function applyStatic(root = document) {
    for (const element of root.querySelectorAll("[data-i18n], [data-i18n-attrs]")) {
      let record = staticRecords.get(element);
      if (!record) {
        record = {
          texts: element.hasAttribute("data-i18n") ? [...element.childNodes].filter((node) => node.nodeType === 3 && node.nodeValue.trim()).map((node) => ({ node, original: node.nodeValue, last: node.nodeValue })) : [],
          attributes: (element.getAttribute("data-i18n-attrs") || "").split(/\s+/).filter(Boolean).map((name) => ({ name, original: element.getAttribute(name) || "", last: element.getAttribute(name) || "" })),
        };
        staticRecords.set(element, record);
      }
      for (const text of record.texts) {
        if (text.node.parentNode === element && text.node.nodeValue === text.last) {
          text.last = translateLiteral(text.original);
          text.node.nodeValue = text.last;
        }
      }
      for (const attribute of record.attributes) {
        if (element.getAttribute(attribute.name) === attribute.last) {
          attribute.last = translateLiteral(attribute.original);
          element.setAttribute(attribute.name, attribute.last);
        }
      }
    }
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.language = language;
    for (const input of document.querySelectorAll('#language-control input[name="language"]')) input.checked = input.value === preference;
  }

  function setPreference(value, confirmedSystemLanguage) {
    const previousLanguage = language;
    const previousPreference = preference;
    preference = normalizePreference(value);
    if (confirmedSystemLanguage) {
      systemLanguage = normalizeLanguage(confirmedSystemLanguage);
      systemLanguageConfirmed = true;
    }
    language = preference === "system" ? systemLanguage : preference;
    try { localStorage.setItem(storageKey, preference); } catch {}
    if (previousLanguage !== language) applyStatic();
    else for (const input of document.querySelectorAll('#language-control input[name="language"]')) input.checked = input.value === preference;
    if (previousLanguage !== language || previousPreference !== preference) {
      window.dispatchEvent(new CustomEvent("media-tracker-language-change", { detail: { preference, language, locale: language === "zh" ? "zh-CN" : "en-US", languageChanged: previousLanguage !== language } }));
    }
    return language;
  }

  register({
    "Media Tracker · 本地媒体档案": "Media Tracker · Local media archive",
    "本地媒体档案": "Local media archive",
    "窗口操作": "Window controls",
    "最小化窗口": "Minimize window",
    "最大化窗口": "Maximize window",
    "还原窗口": "Restore window",
    "关闭工具": "Close app",
    "关闭工具并退出后台": "Close app and stop its background service",
    "主要导航": "Main navigation",
    "维护导航": "Maintenance navigation",
    "采集账号": "Tracked accounts",
    "我的账号": "My accounts",
    "人": "P", "连": "A", "清": "C",
    "界面语言": "Language",
    "语言与主题": "Language and theme",
    "选择界面语言": "Choose display language",
    "选择界面主题": "Choose theme",
    "语言模式": "Language preference",
    "界面主题": "Theme",
    "主题模式": "Theme preference",
    "跟随系统": "System",
    "系统": "System",
    "浅色": "Light",
    "深色": "Dark",
    "缓存清理": "Cache cleanup",
    "仅保存在本机": "Stored locally only",
    "密码不会写入本工具": "Passwords are not stored here",
    "目标账号信息": "Target accounts",
    "每个平台可添加多个账号，同一人物的媒体统一保存，并保留全部发布来源。": "Add multiple accounts per platform. Each person's media is stored together with every publication source preserved.",
    "新建人物": "Add person",
    "一键同步全部": "Sync all",
    "一键去重": "Deduplicate all",
    "已有账号走增量，全部人物并行同步。": "Existing accounts sync incrementally. All people sync in parallel.",
    "图片与视频 · 本地比对 · 来源保留": "Images and videos · Local comparison · Sources preserved",
    "本地整理": "Local organization",
    "图片与视频去重": "Image and video deduplication",
    "等待开始": "Ready to start",
    "停止并关闭": "Stop and close",
    "继续去重": "Resume deduplication",
    "关闭结果": "Close results",
    "去重扫描进度": "Deduplication scan progress",
    "去重统计": "Deduplication statistics",
    "已检查文件": "Files checked",
    "已合并版本": "Versions merged",
    "疑似项保留": "Uncertain versions kept",
    "可恢复归档": "Recoverable archive",
    "查看结果与保留规则": "Results and retention rules",
    "只在同一人物内合并高置信度的同内容图片或完整视频。保留版本参考分辨率、清晰度和内容完整性，不保证适合 LoRA 训练；裁剪、编辑、音轨不同或判断不充分的版本保留。疑似版本已保留，不影响采集完成，无需处理也可继续同步。": "Only high-confidence copies of the same image or complete video are merged within one person. Resolution, sharpness and completeness guide retention; this does not establish suitability for LoRA training. Cropped, edited, different-audio and uncertain versions are kept. You can continue syncing without reviewing them.",
    "合并版本移到人物 Index/DedupArchive，发布来源与恢复记录保留。归档仍占磁盘空间，不会自动永久删除。": "Merged versions move to the person's Index/DedupArchive. Publication sources and recovery records are preserved. Archived files still use disk space and are not permanently deleted automatically.",
    "下方疑似项可单击文件名用系统关联程序检查，右键可打开文件位置或查看来源；全人物或单个人物的去重都可安全停止。": "Click a filename below to open it with your default app. Right-click to reveal its location or view sources. Both all-person and individual deduplication can be stopped safely.",
    "外观与独立账号会话": "Appearance and independent account sessions",
    "关联你用于查看内容的账号": "Connect your viewing accounts",
    "登录与同步都使用工具内置的独立运行内核，不调用或占用本机 Chrome、Edge，也不读取它们的账号资料。": "Login and syncing use the tool's independent built-in browser engine. They do not use your installed Chrome or Edge, or read their account data.",
    "所有工具窗口保持一致": "Consistent across all tool windows",
    "左侧底部可随时切换语言和主题。跟随系统语言时，Windows 显示语言为中文则使用中文，否则使用英文；跟随系统主题会随 Windows 深浅色自动切换。手动选择可覆盖系统设置。": "Switch language and theme at the bottom of the sidebar. System language uses Chinese for a Chinese Windows display language, and English otherwise. System theme follows Windows; manual choices override the system.",
    "右上角可随时切换语言和主题。选择系统语言时，Windows 显示语言为中文则使用中文，否则使用英文；选择系统主题会随 Windows 深浅色自动切换。手动选择可覆盖系统设置。": "Switch language and theme in the top-right corner. System language uses Chinese for a Chinese Windows display language, and English otherwise. System theme follows Windows; manual choices override the system.",
    "本地媒体整理": "Local media organization",
    "新同步文件自动比对": "Automatically compare newly synced files",
    "同步保存后自动与同一人物的媒体比对，图片与视频均包含。保留版本参考可测量的分辨率、清晰度与完整性，不是 LoRA 训练适配结论。无法确认的疑似项保留，合并版本进入 Index/DedupArchive 可恢复归档；账号登录资料不参与去重。": "After saving, new images and videos are compared with the same person's media. Measurable resolution, sharpness and completeness guide retention, not LoRA training suitability. Uncertain versions are kept; merged versions enter the recoverable Index/DedupArchive. Account login data is never deduplicated.",
    "可选本地组件": "Optional local components",
    "图片与视频去重组件": "Image and video deduplication tools",
    "精确去重无需额外安装。相似去重使用 FFmpeg 与 ffprobe，不需要 AI 模型；缺少组件时先询问，不会自动安装。": "Exact deduplication needs no extra installation. Similarity comparison uses FFmpeg and ffprobe, not AI models. Missing tools are not installed without asking.",
    "点击设置可检查组件或指定已有工具的位置。": "Open settings to check components or choose existing tools.",
    "设置去重组件": "Configure tools",
    "连接新账号": "Connect an account",
    "平台": "Platform",
    "＋ 自定义平台": "＋ Custom platform",
    "账号名称": "Account label",
    "例如：我的 X 主账号": "Example: My main X account",
    "创建关联": "Connect account",
    "不登录也可尝试部分公开内容；敏感媒体、受限页面和完整历史通常需要登录。Google、Apple、Facebook 等关联登录会在工具自己的窗口中完成。": "Some public content can be attempted without login. Sensitive media, restricted pages and full histories usually require login. Sign-in through Google, Apple or Facebook is completed in the tool's own window.",
    "本地维护": "Local maintenance",
    "清理普通缓存保留登录状态；不用的历史资料夹可单独勾选删除。两项操作不影响已采集内容。": "Regular cache cleanup preserves login sessions. Select unused historical profiles separately to delete them. Neither action changes your collected media.",
    "扫描缓存": "Scan cache",
    "清理缓存": "Clean cache",
    "缓存统计": "Cache statistics",
    "预计可释放": "Reclaimable space",
    "缓存文件": "Cache files",
    "登录资料夹": "Login profiles",
    "清理普通缓存，保留账号登录信息": "Clean regular cache; keep account logins",
    "上方“清理缓存”只删除可重新生成的缓存，保留 Cookie、网站存储、登录设置、人物信息、同步索引及图片和视频。列表中的大小仅为普通缓存；0 B 不表示没有登录资料。正在使用的资料夹会跳过。清理的缓存不进回收站，下次访问网站时会重新生成。": "Clean cache deletes only regenerable cache. Cookies, website storage, login settings, people, sync indexes, images and videos are preserved. Listed sizes cover regular cache only; 0 B does not mean there is no login data. Profiles in use are skipped. Cache is deleted without the Recycle Bin and will be regenerated on future visits.",
    "删除不用的历史资料夹": "Delete unused historical profiles",
    "不用的历史资料夹": "Unused historical profiles",
    "可能来自绑定失败或以前解除的关联，不代表当前账号登录失败。只有未被当前绑定使用且空闲的资料夹可勾选；删除会移除整个历史资料夹，包括其遗留登录信息，不能撤销。": "These may come from failed or disconnected past bindings; they do not indicate a current login failure. Only idle profiles not used by current bindings can be selected. Deletion removes the entire historical profile, including leftover login data, and cannot be undone.",
    "未选择历史资料夹": "No historical profiles selected",
    "删除所选历史资料": "Delete selected profiles",
    "进入此页后会扫描缓存；扫描不会删除文件。": "Cache is scanned when this page opens. Scanning does not delete files.",
    "新人物": "New person",
    "建立采集账号": "Create tracked person",
    "关闭": "Close",
    "人物信息": "Person details",
    "名称用于界面显示；已有目录不会因改名而移动。": "The name is displayed in the interface. Renaming does not move existing folders.",
    "人物名称": "Person name",
    "例如：人物 M": "Example: Person M",
    "备注（可选）": "Note (optional)",
    "例如：摄影与旅行内容": "Example: Photography and travel",
    "本地人物文件夹": "Local person folder",
    "可以在所选位置新建人物文件夹，也可以使用已经存在的文件夹。": "Create a person folder at the selected location, or use an existing folder.",
    "新建人物文件夹": "Create person folder",
    "使用现有文件夹": "Use existing folder",
    "可直接粘贴 D:\\目录 或 \\\\服务器\\共享\\目录": "Paste D:\\Folder or \\\\Server\\Share\\Folder",
    "Windows 浏览": "Browse Windows",
    "请选择父目录，工具将在其中新建人物名称文件夹。": "Choose a parent folder. A folder named after the person will be created inside it.",
    "个人主页与账号发现": "Homepage and account discovery",
    "扫描主页公开链接，先生成候选账号，再由你决定添加、待关注和下载范围。": "Scan public homepage links for candidate accounts, then choose which to add, mark to follow, and download.",
    "个人主页（可选）": "Personal homepage (optional)",
    "https://example.com 或 Linktree 等公开主页": "https://example.com or a public Linktree page",
    "分析主页账号": "Find linked accounts",
    "只读取该网页公开呈现的社交账号链接，不会根据姓名猜测同名账号。": "Only social account links publicly shown on this page are read. Accounts are not guessed from matching names.",
    "社交媒体账号": "Social media accounts",
    "同一平台可以添加多个账号，并为每个账号选择图片、视频、GIF 和待关注状态。": "Add multiple accounts per platform and choose images, videos, GIFs and follow status for each account.",
    "选择社交媒体平台": "Choose a social media platform",
    "添加平台": "Add platform",
    "创建结果": "Folder preview",
    "文件夹蓝图": "Folder structure",
    "敏感媒体：包含": "Sensitive media: included",
    "保存时建立人物目录和 Index 来源索引目录。图片、视频目录在首次成功下载时按需创建；移除平台或账号不会删除媒体或历史来源。": "Saving creates the person folder and Index source folder. Image and Video folders are created only when their first file is saved. Removing a platform or account does not delete media or historical sources.",
    "取消": "Cancel",
    "创建人物": "Create person",
    "全局平台": "Shared platform",
    "添加自定义平台": "Add custom platform",
    "关闭自定义平台": "Close custom platform",
    "创建后，所有人物和“我的账号”都能选择此平台。平台名称只用于归档；能否采集需用目标账号链接测试。": "The new platform will be available to all people and My accounts. The platform name labels your archive; use a target account link to test collection support.",
    "平台名称": "Platform name",
    "例如：我的相册站": "Example: My photo site",
    "采集方式": "Collection method",
    "自动识别支持的站点（推荐）": "Detect supported sites (recommended)",
    "gallery-dl · 图片与相册": "gallery-dl · Images and albums",
    "yt-dlp · 视频": "yt-dlp · Videos",
    "仅保存账号资料，暂不采集": "Save account details without collecting",
    "平台主页": "Platform homepage",
    "平台主页域名创建后固定，以隔离登录资料。修改名称不会更改登录资料或媒体位置；如需其他网站，请新建平台。": "The homepage domain is fixed after creation to isolate login profiles. Renaming does not change login data or media locations. Create another platform for a different website.",
    "登录网址（可选，默认使用主页）": "Login URL (optional; defaults to homepage)",
    "登录在工具专用窗口中完成，也可在站点内使用第三方关联登录。打开页面不等于登录成功，之后仍需点击“验证登录”。": "Sign in using the tool's dedicated window, including third-party sign-in offered by the site. Opening a page does not verify login; click Verify login afterward.",
    "高级：登录验证规则（需要登录时配置）": "Advanced: login verification rules (for sites requiring login)",
    "本版自定义平台需配置登录后专有标记，并用独立匿名页面对照；匿名时应出现未登录标记，或跳转到登录页。不能使用 body 或通用导航。未配置、匿名也能看到同一标记或对照失败时，不会判为已登录。修改规则后需重新验证关联账号。": "Custom platforms require a marker visible only after login, checked against a separate anonymous page. The anonymous page must show a logged-out marker or redirect to login. Do not use body or general navigation. Unconfigured rules, public markers and failed comparisons are not treated as verified logins. Verify connected accounts again after changing these rules.",
    "验证页面网址": "Verification page URL",
    "例如：https://example.com/settings": "Example: https://example.com/settings",
    "登录后可见标记（CSS 选择器）": "Logged-in marker (CSS selector)",
    '例如：[data-testid="account-menu"]': 'Example: [data-testid="account-menu"]',
    "未登录时可见标记（CSS 选择器，无登录跳转时需填）": "Logged-out marker (CSS selector; required without login redirect)",
    '例如：form[action="/login"]': 'Example: form[action="/login"]',
    "创建平台": "Create platform",
    "仅使用本地计算": "Local processing only",
    "准备去重组件": "Set up deduplication tools",
    "去重工具包准备进度": "Deduplication package setup progress",
    "需要 FFmpeg 与 ffprobe 才能比对压缩后不同的图片和视频。组件下载需要网络；去重不上传媒体，不使用 AI 服务。": "FFmpeg and ffprobe are required to compare differently compressed images and videos. Downloading these tools uses the network; deduplication does not upload media or use AI services.",
    "组件安装的父文件夹": "Parent folder for tool installation",
    "默认：采集工具文件夹下的 tools": "Default: tools inside the Media Tracker folder",
    "浏览": "Browse",
    "只在所选位置新建独立版本目录，不改注册表或系统 PATH，不覆盖已有工具。": "A separate version folder is created at your selected location. The registry, system PATH and existing tools are not changed.",
    "下载并安装组件": "Download and install tools",
    "已经安装，或不希望下载": "Already installed, or prefer not to download",
    "已有 FFmpeg 的 bin 文件夹": "Existing FFmpeg bin folder",
    "该目录应同时包含 ffmpeg.exe 与 ffprobe.exe": "The folder must contain ffmpeg.exe and ffprobe.exe",
    "请选择可信工具的位置。确认后会运行这两个程序进行版本和能力检查。": "Choose a trusted tool location. Both programs will be run to check their versions and capabilities.",
    "暂不安装": "Not now",
    "验证并使用已有工具": "Verify and use existing tools",
    "请确认": "Please confirm",
    "移除账号关联？": "Disconnect account?",
    "是，保留内容": "Yes, keep media",
    "确认移除": "Disconnect",
    "人物媒体索引": "Person media index",
    "媒体与来源": "Media and sources",
    "关闭媒体与来源": "Close media and sources",
    "同一人物的相同文件只保存一份；查看来源可追溯各平台、账号和帖子。": "Identical files are stored once per person. Sources trace each platform, account and post.",
    "搜索文件名": "Search filenames",
    "输入完整或部分文件名": "Enter a full or partial filename",
    "搜索": "Search",
    "刷新": "Refresh",
    "上一页": "Previous",
    "下一页": "Next",
    "全部来源记录": "All publication sources",
    "文件来源": "File sources",
    "关闭文件来源": "Close file sources",
    "文件操作": "File actions",
    "打开文件位置": "Show in folder",
    "查看来源": "View sources",
  });

  window.MediaTrackerI18n = {
    tr, register, translateLiteral, translateMessage, setPreference, applyStatic,
    get preference() { return preference; },
    get language() { return language; },
    get locale() { return language === "zh" ? "zh-CN" : "en-US"; },
  };
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.language = language;
  window.addEventListener("languagechange", () => {
    if (preference === "system" && !systemLanguageConfirmed) {
      systemLanguage = normalizeLanguage(navigator.language);
      setPreference("system");
    }
  });
})();
