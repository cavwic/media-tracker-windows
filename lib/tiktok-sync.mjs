import { createSyncBoundary } from "./sync-boundary.mjs";
import { createTikTokMediaFetch, extractTikTokTimeline, normalizeTikTokHandle } from "./tiktok-media.mjs";
import { createTikTokImageFetch } from "./tiktok-image-fetch.mjs";
import { createPublicationDateCollector } from "./publication-date.mjs";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";

export class TikTokDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function classifyTikTokFailure({ url = "", bodyText = "", status = 0, statusCode = 0, statusMessage = "", hasCaptcha = false, hasPasswordField = false } = {}) {
  const text = `${bodyText}\n${statusMessage}`;
  if (status === 429 || /too many requests|rate limit|访问过于频繁|操作太频繁/i.test(text)) {
    return new TikTokDiscoveryError("rate-limited", "TikTok 暂时限制了请求频率，请稍后再同步。");
  }
  if (hasCaptcha || /\/captcha(?:\/|\?|$)/i.test(url) || /verify to continue|verify you are human|complete the puzzle|拖动滑块|完成验证|验证以继续/i.test(text)) {
    return new TikTokDiscoveryError("verification-required", "TikTok 要求完成验证码，请打开关联账号的登录窗口完成验证后再同步。");
  }
  if (/\/login(?:\/|\?|$)/i.test(url) || hasPasswordField || /log in to (?:view|see|watch)|登录以查看|登录后(?:查看|观看)/i.test(text)) {
    return new TikTokDiscoveryError("login-required", "TikTok 要求登录，请选择已验证的关联账号，或重新登录并验证。");
  }
  if (status === 404 || /couldn't find this account|could not find this account|couldn't find this video|video (?:is )?unavailable|账号不存在|视频不存在/i.test(text)) {
    return new TikTokDiscoveryError("content-unavailable", "TikTok 账号或作品不存在，或当前账号无法访问。");
  }
  if (/this account is private|follow this account to see|private account|此账号为私密|该账号为私密/i.test(text)) {
    return new TikTokDiscoveryError("private-account", "TikTok 账号为私密账号，请使用已获准关注它的关联账号。");
  }
  if (status >= 400 || Number(statusCode) !== 0) {
    return new TikTokDiscoveryError("timeline-unavailable", `TikTok 时间线请求失败（${status >= 400 ? `HTTP ${status}` : `平台状态 ${statusCode}`}）。`);
  }
  return null;
}

function abortError() { return new DOMException("同步已取消。", "AbortError"); }

function retryUrl(value, handle) {
  try {
    const url = new URL(typeof value === "string" ? value : value.postUrl);
    const match = url.pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)\/?$/);
    return url.protocol === "https:" && ["www.tiktok.com", "tiktok.com"].includes(url.hostname)
      && match && match[1].toLowerCase() === handle.toLowerCase() ? `${url.origin}${url.pathname}` : "";
  } catch { return ""; }
}

async function scrollTikTokTimeline(page, handle) {
  let lastTile = page.locator('[data-e2e="user-post-item"]').last();
  if (!await lastTile.count()) {
    const links = ["video", "photo"].flatMap((kind) => [
      `a[href^="/@${handle}/${kind}/"]`,
      `a[href^="https://www.tiktok.com/@${handle}/${kind}/"]`,
    ]);
    lastTile = page.locator(links.join(",")).last();
  }
  let tileBox = null;
  if (await lastTile.count()) {
    // This scrolls every relevant ancestor, including TikTok's inner grid
    // scroller. The bounded wait tolerates a tile being replaced mid-render.
    await lastTile.scrollIntoViewIfNeeded({ timeout: 1_200 }).catch(() => {});
    tileBox = await lastTile.boundingBox({ timeout: 300 }).catch(() => null);
  }
  const layout = await page.evaluate(() => {
    const main = document.querySelector('main, [role="main"], [data-e2e="user-page"]');
    const rect = main?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight,
      main: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
  });
  const visibleCenter = (box) => {
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const left = Math.max(1, box.x);
    const right = Math.min(layout.width - 2, box.x + box.width);
    const top = Math.max(1, box.y);
    const bottom = Math.min(layout.height - 2, box.y + box.height);
    return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
  };
  const point = visibleCenter(tileBox) || visibleCenter(layout.main)
    || { x: layout.width * 0.7, y: layout.height * 0.65 };
  // A wheel event at the default (0, 0) can land in the fixed navigation rail
  // and never reach the works list, even though more pages are available.
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 6_000);
}

export async function discoverTikTokMedia({ handle, linkedAccount, knownPosts = {}, knownMediaKeys = [], knownPostCoverage = {}, initialComplete = false, since,
  retryPosts = [], scanMode = "history", signal, onProgress, maxScrolls = 10_000, maxDetailPages = 50, browserType, acquirePage,
  initialWaitMs = 20_000, imageFetchFactory = createTikTokImageFetch }) {
  handle = normalizeTikTokHandle(handle);
  if (!handle) throw new TikTokDiscoveryError("invalid-handle", "TikTok 账号名称无效。");
  if (signal?.aborted) throw abortError();
  let browser;
  let context;
  let page;
  let release;
  let releasePromise;
  let responseListener;
  let requestListener;
  let requestFinishedListener;
  let requestFailedListener;
  const posts = new Map();
  const media = new Map();
  const unresolved = new Map();
  const coverage = new Map();
  const knownMedia = new Set(knownMediaKeys);
  const failedPages = new Map();
  const pageOrdinals = new Map();
  const pageIssues = new Map();
  const parseIssues = [];
  const pending = new Set();
  const inFlightRequests = new Map();
  const requestEntries = new WeakMap();
  const boundary = createSyncBoundary({ knownPosts, initialComplete, since });
  const publicationDates = createPublicationDateCollector("tiktok");
  let timelineResponses = 0;
  let matchedResponses = 0;
  let reachedEnd = false;
  let phase = "timeline";
  let timelineFailure = null;
  let detailFailure = null;
  let navigationFailure = null;
  let requestOrdinal = 0;
  let latestValidOrdinal = 0;
  let latestFailureOrdinal = 0;
  let terminalEmptyOrdinal = 0;
  let terminalEmptyPageKey = "";
  let terminalEmptySecUid = "";
  let latestPageOrdinal = 0;
  let profileZeroConfirmed = false;
  let profileSecUid = "";
  let headEvidenceAccepted = false;
  const headPostIds = new Set();
  const embeddedSeen = new Set();
  for (const [postKey, item] of Object.entries(knownPostCoverage)) {
    if (!/^\d+$/.test(postKey) || !item || typeof item !== "object") continue;
    const expectedMediaKeys = new Set((Array.isArray(item.mediaExpectedKeys) ? item.mediaExpectedKeys : []).filter((key) => {
      const match = typeof key === "string" && key.match(/^(\d+):(image|video):([1-9]\d{0,3}|10000)$/);
      return match && match[1] === postKey;
    }));
    const expectedMediaCount = Math.max(expectedMediaKeys.size,
      Number.isSafeInteger(item.mediaExpectedCount) && item.mediaExpectedCount >= 0 ? item.mediaExpectedCount : 0);
    const post = { postKey, postId: postKey, createdAt: null, mediaComplete: false, mediaExpectedCount: expectedMediaCount,
      mediaExpectedKeys: [...expectedMediaKeys],
      postUrl: retryUrl(item.postUrl, handle) || `https://www.tiktok.com/@${handle}/video/${postKey}` };
    posts.set(postKey, post);
    unresolved.set(postKey, post);
    coverage.set(postKey, { coverageKnown: false, expectedMediaCount, expectedMediaKeys });
  }

  const settleResponses = async (timeoutMs = 1_000) => {
    if (!pending.size) return;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
      ]);
    } finally { clearTimeout(timer); }
  };

  const recordFailure = (error, ordinal, pageKey) => {
    if (ordinal >= (pageOrdinals.get(pageKey) || 0)) {
      pageOrdinals.set(pageKey, ordinal);
      failedPages.set(pageKey, error);
    }
    reachedEnd = false;
    boundary.reset?.();
    if (ordinal < latestValidOrdinal || ordinal < latestFailureOrdinal) return;
    latestFailureOrdinal = ordinal;
    timelineFailure = error;
  };

  const recordValid = (ordinal, pageKey) => {
    if (ordinal >= (pageOrdinals.get(pageKey) || 0)) {
      pageOrdinals.set(pageKey, ordinal);
      failedPages.delete(pageKey);
    }
    latestValidOrdinal = Math.max(latestValidOrdinal, ordinal);
    if (ordinal >= latestFailureOrdinal) timelineFailure = null;
    navigationFailure = null;
  };

  const httpFailure = (status, resource) => {
    if (status < 400) return null;
    const classified = classifyTikTokFailure({ status });
    if (status === 429) return classified;
    const label = resource === "homepage" ? "主页" : "作品列表";
    return new TikTokDiscoveryError(`${resource}-http-error`, `TikTok ${label}返回 HTTP ${status}。请在工具专用的普通登录窗口中确认能查看该账号；若页面要求验证，请先手动完成。`);
  };

  const add = (parsed, isTimeline) => {
    if (!parsed.recognized) return;
    if (isTimeline) timelineResponses += 1;
    let unseenPosts = 0;
    for (const post of parsed.posts) {
      if (!posts.has(post.postKey) && !knownPosts[post.postKey]) unseenPosts += 1;
      posts.set(post.postKey, post);
    }
    for (const item of parsed.media) media.set(item.logicalKey, item);
    for (const entry of parsed.postCoverage || []) {
      const previous = coverage.get(entry.postKey);
      const expectedMediaCount = Math.max(previous?.expectedMediaCount || 0, entry.expectedMediaCount || entry.expectedMediaKeys.length);
      const expectedMediaKeys = new Set([...(previous?.expectedMediaKeys || []), ...entry.expectedMediaKeys]);
      if (expectedMediaCount <= 10_000 && [...expectedMediaKeys].some((key) => key.includes(":image:"))) {
        for (let index = 1; index <= expectedMediaCount; index += 1) expectedMediaKeys.add(`${entry.postKey}:image:${index}`);
      }
      coverage.set(entry.postKey, { coverageKnown: entry.coverageKnown || Boolean(previous?.coverageKnown), expectedMediaCount, expectedMediaKeys });
    }
    for (const [postKey, post] of posts) {
      const entry = coverage.get(postKey);
      post.mediaExpectedCount = entry?.expectedMediaCount || 0;
      post.mediaExpectedKeys = [...(entry?.expectedMediaKeys || [])];
      post.mediaComplete = Boolean(entry?.coverageKnown && entry.expectedMediaKeys.size
        && entry.expectedMediaKeys.size >= entry.expectedMediaCount
        && [...entry.expectedMediaKeys].every((key) => media.has(key) || knownMedia.has(key)));
      if (post.mediaComplete) unresolved.delete(postKey);
      else unresolved.set(postKey, post);
    }
    if (isTimeline) {
      boundary.observe(parsed.posts);
    }
    // Older post gaps have their own retry ledger. They must not invalidate
    // clean current-feed batches during a daily incremental scan; an incomplete
    // post in this very batch still retracts the boundary inside observe().
    if (scanMode !== "incremental" && unresolved.size) boundary.reset?.();
    onProgress?.({ posts: posts.size, media: media.size, unseenPosts, timelineResponses });
  };

  const consume = async (response) => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (!/(?:^|\.)tiktok\.com$/i.test(url.hostname)) return;
    // User-detail, recommendations, and unrelated background calls do not
    // determine whether the requested creator's works are readable.
    const request = response.request?.();
    const requestEntry = request && requestEntries.get(request);
    const responsePhase = requestEntry?.phase || phase;
    const isTimeline = responsePhase === "timeline"
      && /^\/api\/post\/item_list\/?$/.test(url.pathname);
    const isDetail = responsePhase === "detail" && /^\/api\/item\/detail\/?$/.test(url.pathname);
    if (!isTimeline && !isDetail) return;
    const requestHandle = url.searchParams.get("uniqueId") || url.searchParams.get("unique_id");
    if (requestHandle && requestHandle.toLowerCase().replace(/^@/, "") !== handle.toLowerCase()) return;
    const requestSecUid = url.searchParams.get("secUid");
    if (isTimeline && requestSecUid && profileSecUid && requestSecUid !== profileSecUid) return;
    const ordinal = requestEntry?.ordinal || ++requestOrdinal;
    const pageKey = url.searchParams.get("cursor") || "initial";
    matchedResponses += 1;
    const fail = (error) => {
      if (isTimeline) recordFailure(error, ordinal, pageKey);
      else detailFailure = error;
    };
    try {
      const failure = httpFailure(response.status(), "timeline");
      if (failure) { fail(failure); return; }
      const body = response.headers()["content-length"] === "0" ? "" : await response.text();
      if (!body.trim()) {
        fail(new TikTokDiscoveryError("timeline-empty-response", "TikTok 作品列表返回了空响应（HTTP 200），尚未确认作品可访问。请在工具专用的普通登录窗口查看该主页，完成页面要求的验证后再试。"));
        return;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        fail(new TikTokDiscoveryError("timeline-invalid-json", "TikTok 作品列表返回的内容不是有效数据（HTTP 200）。请在工具专用的普通登录窗口检查该主页是否要求登录或人工验证。"));
        return;
      }
      if (!payload || typeof payload !== "object") {
        fail(new TikTokDiscoveryError("timeline-invalid-data", "TikTok 作品列表没有返回可识别的数据，请在工具专用的普通登录窗口确认主页可访问。"));
        return;
      }
      const apiFailure = classifyTikTokFailure({ statusCode: payload.statusCode ?? payload.status_code ?? 0,
        statusMessage: payload.statusMsg || payload.status_msg || "" });
      if (apiFailure) { fail(apiFailure); return; }
      const parsed = extractTikTokTimeline(payload, handle);
      if (!isTimeline) {
        if (parsed.posts.length) { add(parsed, false); detailFailure = null; }
        else detailFailure = new TikTokDiscoveryError("detail-invalid-data", "TikTok 作品详情未返回可识别的媒体数据。已识别内容会保留，下次重试。");
        return;
      }
      const items = payload.itemList || payload.item_list;
      if (!Array.isArray(items) || !parsed.recognized || (items.length && !parsed.posts.length)) {
        fail(new TikTokDiscoveryError("timeline-invalid-data", "TikTok 作品列表未包含该账号的有效作品数据，请在工具专用的普通登录窗口确认主页可访问。"));
        return;
      }
      // SSR can provide a few real tiles while an access challenge returns an
      // empty initial API page. Those tiles do not certify the entire history.
      if (!items.length && !timelineResponses && !profileZeroConfirmed
        && (!url.searchParams.get("cursor") || url.searchParams.get("cursor") === "0")) {
        if (parsed.hasMore === false) {
          terminalEmptyOrdinal = ordinal; terminalEmptyPageKey = pageKey;
          terminalEmptySecUid = requestSecUid || "";
        }
        fail(new TikTokDiscoveryError("timeline-empty-unconfirmed", "TikTok 返回了空作品列表，但尚未确认该账号没有作品；本次不会更新同步边界。请在工具专用的普通登录窗口检查主页。"));
        return;
      }
      recordValid(ordinal, pageKey);
      if (ordinal === pageOrdinals.get(pageKey)) {
        if (parsed.unparsedItems || parsed.foreignItems) {
          pageIssues.set(pageKey, "TikTok 作品列表包含未能核对账号或媒体结构的条目，尚不能确认完整历史。");
          boundary.reset?.();
        } else pageIssues.delete(pageKey);
      }
      add(parsed, true);
      const firstPage = !url.searchParams.get("cursor") || url.searchParams.get("cursor") === "0";
      if (firstPage && !parsed.unparsedItems && !parsed.foreignItems
        && (items.length > 0 || (profileZeroConfirmed && (!requestSecUid || requestSecUid === profileSecUid)))) {
        // Authored works prove the target of a nonempty page. Empty pages need
        // independent target identity plus an explicit zero count. Hydrated SSR
        // tiles never establish a head or synthetic pagination batch by itself.
        headEvidenceAccepted = true;
        for (const post of parsed.posts) headPostIds.add(post.postKey);
      }
      // Completion belongs to the latest issued page. A slow old request or
      // out-of-order body read cannot overwrite newer hasMore evidence.
      if (ordinal >= latestPageOrdinal) {
        latestPageOrdinal = ordinal;
        reachedEnd = parsed.hasMore === false;
      }
    } catch (error) {
      // Do not emit response bodies or signed media URLs in diagnostics.
      if (signal?.aborted) return;
      fail(error instanceof TikTokDiscoveryError ? error : new TikTokDiscoveryError("timeline-response-unreadable", "未能读完 TikTok 作品列表响应，请稍后再试。"));
    }
  };

  const checkPage = async (page) => {
    const snapshot = await page.evaluate(() => ({
      url: location.href,
      bodyText: document.body?.innerText.slice(0, 5_000) || "",
      hasCaptcha: [...document.querySelectorAll('iframe[src*="captcha"], #captcha_container, [id^="captcha-verify"]')]
        .some((element) => element.getBoundingClientRect().width > 0),
      hasPasswordField: [...document.querySelectorAll('input[type="password"]')]
        .some((element) => element.getBoundingClientRect().width > 0),
    }));
    const failure = classifyTikTokFailure(snapshot);
    if (failure) throw failure;
  };

  const readEmbedded = async (page, isTimeline) => {
    await publicationDates.capture(page);
    const texts = await page.locator('script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE, script#sigi-persisted-data').allTextContents();
    for (const text of texts) {
      if (embeddedSeen.has(text)) continue;
      embeddedSeen.add(text);
      try {
        const payload = JSON.parse(text);
        const detail = payload.__DEFAULT_SCOPE__?.["webapp.user-detail"];
        if (detail?.userInfo?.user?.uniqueId?.toLowerCase() === handle.toLowerCase()) {
          profileSecUid = String(detail.userInfo.user.secUid || "");
          const count = detail.userInfo.stats?.videoCount;
          profileZeroConfirmed = [0, "0"].includes(count)
            && Number(detail.statusCode) === 0 && detail.userInfo.user.privateAccount !== true;
        }
        const parsed = extractTikTokTimeline(payload, handle);
        // Embedded state supplements the first response; it is not a fresh
        // pagination batch and must not count twice toward the known boundary.
        add(parsed, false);
        if (parsed.unparsedItems) {
          const detailUrl = !isTimeline && retryUrl(page.url(), handle);
          const postKey = detailUrl ? new URL(detailUrl).pathname.split("/").at(-1) : null;
          parseIssues.push(postKey ? { postKey, reason: "retry-post-unavailable",
            message: "TikTok 作品详情包含未解析的作品条目，已保留补查记录。" }
            : "TikTok 初始页面包含未解析的作品条目，尚不能确认完整历史。");
          if (isTimeline || scanMode !== "incremental") boundary.reset?.();
        }
      } catch {}
    }
    if (isTimeline && profileZeroConfirmed && terminalEmptyOrdinal && (!terminalEmptySecUid || terminalEmptySecUid === profileSecUid)
      && terminalEmptyOrdinal >= latestFailureOrdinal
      && terminalEmptyOrdinal >= latestPageOrdinal) {
      recordValid(terminalEmptyOrdinal, terminalEmptyPageKey);
      timelineResponses += 1;
      reachedEnd = true;
      headEvidenceAccepted = true;
    }
  };

  const releaseOnce = () => {
    if (!release) return Promise.resolve();
    releasePromise ||= Promise.resolve().then(release);
    return releasePromise;
  };
  const cancel = () => { void releaseOnce().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (!browserType) {
      const acquire = acquirePage || (await import("./tiktok-browser.mjs")).acquireTikTokPage;
      const session = await acquire({ profileDirectory: linkedAccount?.profileDirectory, signal, purpose: "sync" });
      ({ context, page } = session);
      release = () => session.release();
      if (session.needsHomeWarmup) {
        // A newly started ordinary browser must let the site's homepage
        // initialize its session before requesting a profile feed. A direct
        // cold navigation can otherwise return an empty HTTP 200 item list.
        // Reused background sessions skip this extra navigation and wait.
        const home = await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
        const failure = httpFailure(home?.status() || 0, "homepage");
        if (failure) throw failure;
        await page.waitForTimeout(5_000);
        await checkPage(page);
        if (signal?.aborted) throw abortError();
        await session.markHomeWarmupComplete?.();
      }
    } else if (linkedAccount) {
      context = await browserType.launchPersistentContext(linkedAccount.profileDirectory, {
        headless: true, viewport: { width: 1280, height: 900 },
        executablePath: BACKGROUND_CHROMIUM_EXECUTABLE,
        args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"],
      });
    } else {
      browser = await browserType.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    }
    if (!release) release = async () => {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    };
    if (signal?.aborted) throw abortError();
    page ||= context.pages()[0] || await context.newPage();
    responseListener = (response) => {
      const task = consume(response).finally(() => pending.delete(task));
      pending.add(task);
    };
    const targetRequest = (request) => {
      try {
        const url = new URL(request.url());
        const requestedHandle = url.searchParams.get("uniqueId") || url.searchParams.get("unique_id");
        const requestedSecUid = url.searchParams.get("secUid");
        return /(?:^|\.)tiktok\.com$/i.test(url.hostname) && /^\/api\/post\/item_list\/?$/.test(url.pathname)
          && (!requestedHandle || requestedHandle.toLowerCase().replace(/^@/, "") === handle.toLowerCase())
          && (!requestedSecUid || !profileSecUid || requestedSecUid === profileSecUid) ? url : null;
      } catch { return null; }
    };
    requestListener = (request) => {
      if (phase !== "timeline" || !targetRequest(request)) return;
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const entry = { promise, resolve, ordinal: ++requestOrdinal, phase };
      inFlightRequests.set(request, entry);
      requestEntries.set(request, entry);
      pending.add(promise);
    };
    requestFinishedListener = (request) => {
      const entry = inFlightRequests.get(request);
      if (!entry) return;
      inFlightRequests.delete(request);
      pending.delete(entry.promise);
      entry.resolve();
    };
    requestFailedListener = (request) => {
      if (inFlightRequests.has(request) && !signal?.aborted) {
        const url = targetRequest(request);
        const pageKey = url?.searchParams.get("cursor") || "initial";
        // A received HTTP/JSON/empty-body diagnosis is more informative than
        // the transport's later generic requestfailed event for that response.
        if (!failedPages.has(pageKey)) recordFailure(new TikTokDiscoveryError("timeline-request-failed", "TikTok 作品列表请求未完成，已识别内容会保留，下次重试。"),
          inFlightRequests.get(request).ordinal, pageKey);
      }
      requestFinishedListener(request);
    };
    page.on("request", requestListener);
    page.on("requestfinished", requestFinishedListener);
    page.on("requestfailed", requestFailedListener);
    page.on("response", responseListener);
    const profileUrl = `https://www.tiktok.com/@${handle}`;
    const alreadyOnProfile = (() => {
      try { const current = new URL(page.url()); return current.hostname === "www.tiktok.com" && current.pathname.replace(/\/$/, "").toLowerCase() === `/@${handle.toLowerCase()}`; } catch { return false; }
    })();
    if (!alreadyOnProfile) {
      const navigation = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      navigationFailure = httpFailure(navigation?.status() || 0, "homepage");
    }
    // A normal page may briefly receive a rejected/empty API response before
    // its own scripts establish a usable session. Wait for real target data.
    const initialDeadline = Date.now() + Math.max(0, initialWaitMs);
    do {
      if (signal?.aborted) throw abortError();
      await readEmbedded(page, true);
      await settleResponses(Math.min(250, Math.max(0, initialDeadline - Date.now())));
      await checkPage(page);
      if ((timelineResponses > 0 || reachedEnd) && !timelineFailure && pending.size === 0) break;
      const remaining = initialDeadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(250, remaining));
    } while (true);
    if (navigationFailure) throw navigationFailure;
    if (!posts.size && !reachedEnd) {
      if (timelineFailure) throw timelineFailure;
      throw new TikTokDiscoveryError("timeline-unavailable", `未能读取 TikTok 作品列表（匹配响应 ${matchedResponses} 个）。请在工具专用的普通登录窗口确认能查看该账号作品，完成页面要求的人工验证后再试。`);
    }

    let idle = 0;
    for (let scroll = 0; scroll < maxScrolls && !reachedEnd && !boundary.reached; scroll += 1) {
      if (signal?.aborted) throw abortError();
      const previousCount = posts.size;
      await scrollTikTokTimeline(page, handle);
      await page.waitForTimeout(1_300);
      await settleResponses();
      await checkPage(page);
      await publicationDates.capture(page);
      idle = posts.size > previousCount ? 0 : idle + 1;
      if (idle >= 6) break;
    }
    if (timelineFailure && !posts.size) throw timelineFailure;

    // Preserve the authenticated browser's UA before detail navigation. A
    // missing/deleted detail may leave an asynchronously replaced error-page
    // execution context, but must not discard previously recognized media.
    const userAgent = await page.evaluate(() => navigator.userAgent);
    phase = "detail";
    const details = [...new Set([...retryPosts, ...[...unresolved.values()].map((post) => post.postUrl)]
      .map((value) => retryUrl(value, handle)).filter(Boolean))].slice(0, maxDetailPages);
    for (const url of details) {
      if (signal?.aborted) throw abortError();
      detailFailure = null;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        if (response?.status() >= 400) {
          detailFailure = new TikTokDiscoveryError("detail-unavailable", `TikTok 作品详情返回 HTTP ${response.status()}，未将该作品确认完整。`);
        } else {
          await page.waitForTimeout(900);
          await readEmbedded(page, false);
          await settleResponses();
          await checkPage(page);
        }
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw abortError();
        detailFailure = error instanceof TikTokDiscoveryError ? error
          : new TikTokDiscoveryError("detail-request-failed", "TikTok 作品详情请求未完成，已识别内容和待重试记录会保留。");
      }
      const critical = detailFailure && ["login-required", "verification-required", "rate-limited"].includes(detailFailure.code);
      if (critical) throw detailFailure;
      const postId = new URL(url).pathname.split("/").at(-1);
      if (detailFailure || !posts.has(postId)) {
        const post = posts.get(postId) || { postId, postKey: postId, postUrl: url, createdAt: null };
        post.mediaComplete = false;
        posts.set(postId, post);
        unresolved.set(postId, post);
        parseIssues.push({ postKey: postId, reason: detailFailure ? "detail-refresh-failure" : "retry-post-unavailable",
          message: detailFailure?.message || "TikTok 作品详情未返回目标作品数据，已保留待重试记录。" });
        if (scanMode !== "incremental") boundary.reset?.();
      }
    }
    const mediaItems = publicationDates.apply([...media.values()]);
    const fetchVideo = createTikTokMediaFetch({ cookies: await context.cookies(), userAgent,
      mediaUrls: mediaItems.flatMap((item) => (item.variants || [item]).map((variant) => variant.sourceUrl)) });
    // Image CDN traffic must use the same browser/network path as the login
    // session. Keep videos on the streaming, Range-capable transport. The image
    // session is lazy: discovery releases its tab before any download acquires it.
    const images = imageFetchFactory({ profileDirectory: linkedAccount?.profileDirectory, acquirePage });
    const imageUrls = new Set(mediaItems.filter((item) => item.kind === "image")
      .flatMap((item) => (item.variants || [item]).map((variant) => variant.sourceUrl)));
    const fetchMedia = (url, options = {}) => (options.mediaKind
      ? options.mediaKind === "image" : imageUrls.has(String(url)))
      ? images.fetchImage(url, options) : fetchVideo(url, options);
    const unresolvedMedia = [...unresolved.values()].flatMap((post) => {
      const entry = coverage.get(post.postKey);
      const missing = [...(entry?.expectedMediaKeys || [])].filter((key) => !media.has(key) && !knownMedia.has(key));
      return missing.length ? missing.map((logicalKey) => {
        const [, kind, index] = logicalKey.split(":");
        return { postKey: post.postKey, postId: post.postId, postUrl: post.postUrl,
          logicalKey, kind, mediaIndex: Number(index), reason: "TikTok 附件地址尚未解析，已保留待重试记录。" };
      }) : [{ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl,
        reason: "TikTok 作品媒体结构尚未完整确认，已保留待重试记录。" }];
    });
    const failureIssue = (error) => ({ message: error.message, reason: ({
      "timeline-http-error": "timeline-http-failure", "rate-limited": "timeline-http-429",
      "timeline-invalid-json": "timeline-json-invalid", "timeline-request-failed": "timeline-request-failed",
      "timeline-response-unreadable": "timeline-request-failed", "timeline-unavailable": "timeline-api-error",
      "timeline-empty-response": "timeline-api-error",
    })[error.code] || error.code || "timeline-read-error" });
    const feedIssues = [...failedPages.values()].map(failureIssue).concat([...pageIssues.values()],
      parseIssues.filter((issue) => typeof issue === "string" || !issue.postKey));
    // Preserve blocking feed evidence before bounded per-post samples, rather
    // than letting many old detail retries hide a real pagination failure.
    const issues = [...feedIssues, ...parseIssues.filter((issue) => typeof issue !== "string" && issue.postKey)].slice(0, 20);
    const headCaptured = headEvidenceAccepted && [...headPostIds].every((postKey) => posts.get(postKey)?.mediaComplete === true);
    const rangeComplete = headCaptured && (reachedEnd || boundary.reached) && pending.size === 0
      && inFlightRequests.size === 0 && feedIssues.length === 0;
    const complete = rangeComplete && unresolved.size === 0 && issues.length === 0;
    const incompleteReason = (typeof issues[0] === "string" ? issues[0] : issues[0]?.message) || (unresolved.size ? "TikTok 存在尚未解析完整的作品或附件，下次继续检查。"
      : pending.size ? "TikTok 尚有作品列表响应未读取完成，下次继续检查。"
        : !headCaptured ? "TikTok 目标账号的首屏作品尚未完整确认，下次继续检查。"
          : !reachedEnd && !boundary.reached ? "TikTok 尚未确认分页末尾或可靠的已知增量边界，下次继续检查。" : "");
    return { posts: publicationDates.apply([...posts.values()]), media: mediaItems, unresolvedMedia,
      complete, rangeComplete, headCaptured, incompleteReason: complete ? "" : incompleteReason, parseIssues: issues,
      completionReason: complete ? reachedEnd ? "terminal-page" : "known-boundary" : null,
      rangeCompletionReason: rangeComplete ? reachedEnd ? "terminal-page" : "known-boundary" : null,
      reachedEnd, reachedKnownBoundary: rangeComplete && !reachedEnd && boundary.reached, timelineResponses, unresolvedPosts: unresolved.size,
      fetchMedia, dispose: () => images.dispose() };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (/user data directory is already in use|ProcessSingleton|profile.*in use/i.test(String(error?.message || error))) {
      throw new TikTokDiscoveryError("profile-busy", "TikTok 专用登录会话暂时无法连接，请先关闭该工具的 TikTok 登录窗口，再验证或同步。");
    }
    const networkCode = String(error?.message || "").match(/net::ERR_[A-Z_]+/)?.[0];
    if (networkCode || error?.name === "TimeoutError") {
      throw new TikTokDiscoveryError("network-unavailable", `无法连接 TikTok（${networkCode || "请求超时"}）。请检查当前网络能否访问 TikTok 后重试。`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (page && responseListener) page.off("response", responseListener);
    if (page && requestListener) page.off("request", requestListener);
    if (page && requestFinishedListener) page.off("requestfinished", requestFinishedListener);
    if (page && requestFailedListener) page.off("requestfailed", requestFailedListener);
    for (const request of [...inFlightRequests.keys()]) requestFinishedListener(request);
    await releaseOnce().catch(() => {});
  }
}
