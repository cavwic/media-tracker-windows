import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { createSyncBoundary } from "./sync-boundary.mjs";
import { createPublicationDateCollector } from "./publication-date.mjs";
import { assembleFacebookResponse, extractFacebookTimeline, materializeFacebookMedia, parseFacebookHtml, parseFacebookResponseText } from "./facebook-media.mjs";

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com"]);
function abortError() { return new DOMException("同步已取消。", "AbortError"); }
function profileBusy(error) { return /user data directory is already in use|ProcessSingleton|profile.*in use/i.test(String(error?.message || error)); }
function requestInfo(request) {
  const fields = new URLSearchParams(request.postData?.() || "");
  let variables = {};
  try { variables = JSON.parse(fields.get("variables") || "{}"); } catch {}
  return { operation: fields.get("fb_api_req_friendly_name") || "", variables };
}
function primaryTimelineOperation(operation) {
  // TilesFeed belongs to the profile's separate photos/tiles component. Its
  // empty data or component error is not evidence that the main feed failed.
  return /^ProfileCometTimelineFeed/.test(operation);
}
function requestFailureKey(request) {
  const { operation, variables } = requestInfo(request);
  const ordered = Object.fromEntries(Object.keys(variables).sort().map((key) => [key, variables[key]]));
  return `${operation}:${JSON.stringify(ordered)}`;
}

export class FacebookDiscoveryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function discoverFacebookMedia({ profileUrl, profileId = "", linkedAccount, knownPosts = {}, knownMediaKeys = [], knownPostCoverage = {}, initialComplete = false,
  since, retryPosts = [], signal, onProgress, maxScrolls = 10_000, browserType = chromium, allowKnownBoundary = false,
  settleTimeoutMs = 8_000 } = {}) {
  let browser;
  let context;
  let resolvedProfileId = String(profileId || "");
  const posts = new Map(), refs = new Map(), catalog = new Map(), pending = new Set();
  const issues = new Set(), permanentIssues = new Set(), requestFailures = new Map(), inflight = new Set();
  const failureSequences = new Map(), successSequences = new Map();
  const knownMedia = new Set(knownMediaKeys);
  const requestStages = new WeakMap(), timedOut = new WeakSet();
  let timelineResponses = 0, matchedResponses = 0, requestSequence = 0, paginationSequence = -1;
  let disposed = false;
  let detach = () => {};
  let timelineHasNextPage = null, headCaptured = false, reachedEnd = false, reachedKnownBoundary = false, refreshingRetries = false;
  const boundary = createSyncBoundary({ knownPosts, initialComplete, since });
  const dates = createPublicationDateCollector("facebook");
  for (const [postKey, item] of Object.entries(knownPostCoverage)) {
    if (!item || typeof item !== "object" || !postKey || postKey.length > 512) continue;
    posts.set(postKey, { postKey, postId: String(item.postId || postKey), postUrl: item.postUrl || "", createdAt: null,
      mediaExpectedCount: Number.isSafeInteger(item.mediaExpectedCount) && item.mediaExpectedCount >= 0 ? item.mediaExpectedCount : 0,
      mediaExpectedKeys: Array.isArray(item.mediaExpectedKeys) ? item.mediaExpectedKeys.filter((key) => typeof key === "string"
        && key.length <= 1000 && key.startsWith(`${postKey}:`)).slice(0, 2000) : [],
      mediaStructureComplete: false, mediaComplete: false });
  }
  const refreshIssues = () => {
    issues.clear();
    for (const code of permanentIssues) issues.add(code);
    for (const codes of requestFailures.values()) for (const code of codes) issues.add(code);
  };
  const recordIssue = (code, failureKey = null, sequence = 0) => {
    if (failureKey) {
      if (sequence < (successSequences.get(failureKey) ?? -1)) return;
      if (!requestFailures.has(failureKey)) requestFailures.set(failureKey, new Set());
      requestFailures.get(failureKey).add(code);
      failureSequences.set(failureKey, Math.max(sequence, failureSequences.get(failureKey) ?? -1));
    } else permanentIssues.add(code);
    refreshIssues(); boundary.reset();
  };
  const matchingRequest = (request) => {
    let parsed;
    try { parsed = new URL(request.url()); } catch { return false; }
    if (!FACEBOOK_HOSTS.has(parsed.hostname)) return false;
    const { operation, variables } = requestInfo(request);
    const target = variables.id || variables.userID || variables.profileID;
    if (resolvedProfileId && target && String(target) !== resolvedProfileId) return false;
    return primaryTimelineOperation(operation)
      || (refreshingRetries && /\/(?:api\/)?graphql\/?$/.test(parsed.pathname));
  };
  const settle = async () => {
    if ([...pending, ...inflight].every((item) => timedOut.has(item))) return !pending.size && !inflight.size;
    const deadline = Date.now() + settleTimeoutMs;
    while (pending.size || inflight.size) {
      if (signal?.aborted) throw abortError();
      if (Date.now() >= deadline) {
        for (const item of [...pending, ...inflight]) timedOut.add(item);
        recordIssue("timeline-pending-timeout"); return false;
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    return true;
  };
  const updateCoverage = () => {
    for (const post of posts.values()) {
      const items = [...refs.values()].filter((ref) => ref.postKey === post.postKey);
      post.mediaComplete = post.mediaStructureComplete && items.length >= post.mediaExpectedCount
        && items.every((ref) => catalog.has(ref.mediaId) || knownMedia.has(ref.logicalKey))
        && post.mediaExpectedKeys.every((key) => knownMedia.has(key) || (refs.has(key) && catalog.has(refs.get(key).mediaId)));
    }
  };
  const merge = (payloads, { timeline = false, head = false, sequence = 0, failureKey = null, readReliable = true } = {}) => {
    let recognized = false;
    let readFailure = false;
    const pagination = [];
    const batch = new Map();
    for (const payload of payloads) {
      const parsed = extractFacebookTimeline(payload, resolvedProfileId);
      if (parsed.hasErrors && (parsed.recognized || timeline || failureKey)) {
        readFailure = true; recordIssue("graphql-error", failureKey, sequence);
      }
      if (!resolvedProfileId && parsed.profileId) resolvedProfileId = parsed.profileId;
      recognized ||= parsed.recognized;
      for (const entry of parsed.catalog) {
        const previous = catalog.get(entry.mediaId);
        if (!previous || entry.qualityScore > previous.qualityScore) catalog.set(entry.mediaId, entry);
      }
      for (const post of parsed.posts) {
        const previous = posts.get(post.postKey);
        const priorCoverage = Object.hasOwn(knownPostCoverage, post.postKey) ? knownPostCoverage[post.postKey] : null;
        const expected = Math.max(previous?.mediaExpectedCount || 0, post.mediaExpectedCount || 0, priorCoverage?.mediaExpectedCount || 0);
        const structure = post.mediaStructureKnown
          ? Boolean(post.mediaStructureComplete && post.mediaExpectedCount >= expected) : Boolean(previous?.mediaStructureComplete);
        const expectedKeys = [...new Set([...(previous?.mediaExpectedKeys || []), ...(priorCoverage?.mediaExpectedKeys || []), ...(post.mediaExpectedKeys || [])])];
        posts.set(post.postKey, { ...previous, ...post, mediaExpectedCount: expected, mediaExpectedKeys: expectedKeys, mediaStructureComplete: structure });
        batch.set(post.postKey, posts.get(post.postKey));
      }
      for (const ref of parsed.refs) refs.set(ref.logicalKey, ref);
      if (parsed.recognized) pagination.push(...parsed.pagination);
    }
    updateCoverage();
    if (timeline && recognized) {
      if (sequence >= paginationSequence) {
        paginationSequence = sequence;
        timelineHasNextPage = pagination.some((item) => item.hasNextPage === true) ? true
          : pagination.length && pagination.every((item) => item.hasNextPage === false) ? false : null;
        reachedEnd = timelineHasNextPage === false;
      }
      timelineResponses++;
      if (head && readReliable && !readFailure) headCaptured = true;
      boundary.observe([...batch.values()]);
    }
    onProgress?.({ posts: posts.size, media: [...refs.values()].filter((ref) => catalog.has(ref.mediaId)).length, timelineResponses });
    return { recognized, readFailure };
  };
  const consume = async (response, sequence, stage) => {
    if (disposed) return;
    let parsedUrl;
    try { parsedUrl = new URL(response.url()); } catch { return; }
    if (!FACEBOOK_HOSTS.has(parsedUrl.hostname)) return;
    const { operation, variables } = requestInfo(response.request());
    const timeline = primaryTimelineOperation(operation) && (stage?.timeline ?? !refreshingRetries);
    if (!timeline && !(refreshingRetries && /\/(?:api\/)?graphql\/?$/.test(parsedUrl.pathname))) return;
    const requestTarget = variables.id || variables.userID || variables.profileID;
    if (resolvedProfileId && requestTarget && String(requestTarget) !== resolvedProfileId) return;
    matchedResponses++;
    const failureKey = stage?.failureKey || requestFailureKey(response.request());
    try {
      const status = response.status?.() ?? 200;
      if (status < 200 || status >= 300) { recordIssue("timeline-http-failure", failureKey, sequence); return; }
      const assembled = assembleFacebookResponse(parseFacebookResponseText(await response.text()));
      const payloads = assembled.payloads;
      if (disposed) return;
      if (!payloads.length) { recordIssue("timeline-empty-response", failureKey, sequence); return; }
      for (const code of assembled.patchIssues) recordIssue(code, failureKey, sequence);
      const head = timeline && /ProfileCometTimelineFeed(?!Pagination)/.test(operation)
        && variables.cursor == null && variables.after == null;
      const merged = merge(payloads, { timeline, head, sequence, failureKey, readReliable: !assembled.patchIssues.length });
      if (!merged.recognized && timeline) recordIssue("timeline-unrecognized-response", failureKey, sequence);
      else if (merged.recognized && !merged.readFailure && !assembled.patchIssues.length) {
        // Only a successful retry of the exact same page can clear that page's
        // error; another terminal page must never hide a missing intermediate.
        if (sequence >= (failureSequences.get(failureKey) ?? -1)) requestFailures.delete(failureKey);
        successSequences.set(failureKey, Math.max(sequence, successSequences.get(failureKey) ?? -1));
        refreshIssues();
      }
    } catch { recordIssue("timeline-parse-failure", failureKey, sequence); }
  };
  const captureHtml = async (page, navigation, timeline = false, head = false) => {
    try {
      if (navigation?.status && (navigation.status() < 200 || navigation.status() >= 300)) {
        recordIssue("page-http-failure"); return;
      }
      // Preserve original SSR before hydration removes script nodes. Also read
      // currently hydrated JSON, without executing page script ourselves.
      if (navigation?.text) merge(parseFacebookHtml(await navigation.text()), { timeline, head, sequence: 0 });
      if (page.content) merge(parseFacebookHtml(await page.content()), { timeline, head, sequence: 0 });
    } catch { recordIssue("page-data-parse-failure"); }
  };
  const unresolved = () => {
    const result = [];
    for (const post of posts.values()) {
      const items = [...refs.values()].filter((ref) => ref.postKey === post.postKey);
      for (const ref of items.filter((item) => !catalog.has(item.mediaId) && !knownMedia.has(item.logicalKey))) {
        result.push({ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl,
          logicalKey: ref.logicalKey, mediaId: ref.mediaId, mediaIndex: ref.mediaIndex,
          kind: ref.typename === "Photo" ? "image" : ref.typename === "AnimatedImage" ? "gif" : "video", reason: "media-url-missing" });
      }
      if (post.mediaExpectedKeys.some((key) => !knownMedia.has(key) && !refs.has(key))) {
        result.push({ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl, reason: "previous-attachment-reference-missing" });
      }
      if (!post.mediaStructureComplete || items.length < post.mediaExpectedCount) {
        result.push({ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl, reason: "attachment-coverage-incomplete" });
      }
    }
    return result;
  };

  try {
    if (signal?.aborted) throw abortError();
    if (linkedAccount) context = await browserType.launchPersistentContext(linkedAccount.profileDirectory, {
      headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE, viewport: { width: 1280, height: 900 },
      args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"],
    });
    else {
      browser = await browserType.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    }
    const page = context.pages()[0] || await context.newPage();
    const onRequest = (request) => {
      if (!matchingRequest(request)) return;
      if (!resolvedProfileId && primaryTimelineOperation(requestInfo(request).operation)) {
        const { variables } = requestInfo(request);
        const target = variables.id || variables.userID || variables.profileID;
        if (target && String(target).length <= 512) resolvedProfileId = String(target);
      }
      requestStages.set(request, { sequence: ++requestSequence, timeline: !refreshingRetries, failureKey: requestFailureKey(request) });
      inflight.add(request);
    };
    const onFinished = (request) => { inflight.delete(request); };
    const onFailed = (request) => {
      if (inflight.delete(request) || matchingRequest(request)) recordIssue("timeline-request-failure",
        requestStages.get(request)?.failureKey || requestFailureKey(request), requestStages.get(request)?.sequence ?? ++requestSequence);
    };
    const onResponse = (response) => {
      if (!matchingRequest(response.request())) return;
      const stage = requestStages.get(response.request());
      const sequence = stage?.sequence ?? ++requestSequence;
      const task = consume(response, sequence, stage).finally(() => pending.delete(task));
      pending.add(task);
    };
    for (const [event, handler] of [["request", onRequest], ["requestfinished", onFinished], ["requestfailed", onFailed], ["response", onResponse]]) {
      page.on(event, handler);
    }
    detach = () => {
      for (const [event, handler] of [["request", onRequest], ["requestfinished", onFinished], ["requestfailed", onFailed], ["response", onResponse]]) page.off?.(event, handler);
    };
    const navigation = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1_800);
    if (/\/login(?:\/|\?|$)|login\.php/.test(page.url())) throw new FacebookDiscoveryError("login-required", "Facebook 要求登录，请选择一个已验证的关联账号。");
    await captureHtml(page, navigation, true, true);
    await settle();
    await dates.capture(page);
    let idle = 0;
    let progress = `${posts.size}:${refs.size}:${catalog.size}`;
    for (let scroll = 0; scroll < maxScrolls; scroll++) {
      if (signal?.aborted) throw abortError();
      // Facebook's ranked profile feed is not a verified chronological feed.
      // Production uses explicit pagination, never a date-only early cutoff.
      if (headCaptured && !inflight.size && !pending.size
        && (reachedEnd || (allowKnownBoundary && boundary.reached && !issues.size && !unresolved().length))) break;
      await page.mouse.wheel(0, 6_000);
      await page.waitForTimeout(1_300);
      await settle();
      await captureHtml(page, null, true);
      await dates.capture(page);
      const next = `${posts.size}:${refs.size}:${catalog.size}`;
      idle = next === progress ? idle + 1 : 0;
      progress = next;
      if (idle >= 7) break; // Stall is incomplete, not proof of end-of-history.
    }
    await settle();
    if (!timelineResponses) {
      const loginVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
      throw new FacebookDiscoveryError(loginVisible ? "login-required" : "timeline-unavailable", loginVisible
        ? "Facebook 登录状态不可用，请重新登录并验证。" : `未能读取 Facebook 目标时间线（匹配响应 ${matchedResponses} 个）。`);
    }
    refreshingRetries = true;
    for (const postUrl of [...new Set(retryPosts)]) {
      if (signal?.aborted) throw abortError();
      let parsed;
      try { parsed = new URL(postUrl); } catch { continue; }
      if (parsed.protocol !== "https:" || !FACEBOOK_HOSTS.has(parsed.hostname)) continue;
      if ([...posts.values()].some((post) => post.postUrl === postUrl && post.mediaComplete)) continue;
      try {
        const detail = await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1_500);
        await captureHtml(page, detail, false);
        await settle();
        await dates.capture(page);
      } catch (error) { if (signal?.aborted) throw abortError(); recordIssue("detail-refresh-failure"); }
    }
    updateCoverage();
    const unresolvedMedia = unresolved();
    reachedKnownBoundary = allowKnownBoundary && headCaptured && boundary.reached;
    const rangeComplete = Boolean(resolvedProfileId && headCaptured && (reachedEnd || reachedKnownBoundary) && !issues.size);
    const complete = rangeComplete && !unresolvedMedia.length;
    const incompleteReason = complete ? "" : issues.size ? "Facebook 页面或分页请求读取失败，不能确认历史完整。"
      : unresolvedMedia.length ? "Facebook 有未解析完整的帖子附件，已保留补查记录。"
      : !headCaptured ? "Facebook 首屏时间线尚未确认完整读取。" : "Facebook 未提供明确分页末尾；停止加载不代表同步完成。";
    return { posts: dates.apply([...posts.values()]), media: dates.apply([...refs.values()]
      .map((ref) => materializeFacebookMedia(ref, catalog.get(ref.mediaId))).filter(Boolean)),
      complete, rangeComplete, headCaptured, reachedEnd, reachedKnownBoundary, timelineResponses, profileId: resolvedProfileId,
      unresolvedMedia, parseIssues: [...issues].slice(0, 20), incompleteReason,
      completionReason: complete ? reachedEnd ? "terminal-page" : "known-boundary" : null };
  } catch (error) {
    if (profileBusy(error)) throw new FacebookDiscoveryError("profile-busy", "Facebook 登录窗口仍在运行，请关闭后再同步。");
    throw error;
  } finally { disposed = true; detach(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); }
}
