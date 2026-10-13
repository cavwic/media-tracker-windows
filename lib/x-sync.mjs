import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { extractXTimeline, parseXInitialState } from "./x-media.mjs";
import { createSyncBoundary } from "./sync-boundary.mjs";
import { createPublicationDateCollector } from "./publication-date.mjs";

function abortError() {
  return new DOMException("同步已取消。", "AbortError");
}

function profileBusy(error) {
  return /user data directory is already in use|ProcessSingleton|profile.*in use/i.test(String(error?.message || error));
}

export class XDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function responseIdentity(response) {
  let url;
  try { url = new URL(response.url()); } catch { return null; }
  if (!["x.com", "www.x.com", "api.x.com", "twitter.com", "www.twitter.com", "api.twitter.com"].includes(url.hostname)) return null;
  if (!url.pathname.includes("/graphql/")) return null;
  const operation = url.pathname.split("/").filter(Boolean).at(-1);
  if (!/^(?:UserByScreenName|UserOriginalsTimeline|UserTweets(?:AndReplies)?|UserMedia|UserVideoTimeline|TweetDetail)$/.test(operation || "")) return null;
  let variables = {};
  try { variables = JSON.parse(url.searchParams.get("variables") || "{}"); } catch {}
  const userId = String(variables.userId || "");
  const screenName = String(variables.screen_name || variables.screenName || "").toLowerCase();
  return { operation, userId, screenName, cursor: variables.cursor || null, requestedPostId: variables.focalTweetId || null,
    key: `${operation}:${userId || screenName || "unknown-user"}:${variables.cursor || variables.focalTweetId || "first"}` };
}

function detailPagePostId(value, handle) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
    return url.protocol === "https:" && ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
      && match && match[1].toLowerCase() === handle.toLowerCase() ? match[2] : null;
  } catch { return null; }
}

export function xDetailExplicitlyUnavailable(snapshot, { handle, postId }) {
  if (!snapshot || detailPagePostId(snapshot.url, handle) !== postId || snapshot.hasTweet
    || snapshot.hasLoginField || snapshot.hasChallenge) return false;
  const text = String(snapshot.text || "");
  if (/log in to (?:x|view)|sign in to (?:x|view)|登录(?:\s*X|以查看|后查看)|ログインして|verify (?:you|to continue)|完成验证|验证码|something went wrong|try (?:again|reloading)|出了点问题|网络.{0,8}(?:错误|失败)|読み込み.{0,8}失敗/i.test(text)) return false;
  return /this page (?:doesn['’]t|does not) exist|(?:该|这个|此)页面不存在|このページは存在しません/i.test(text);
}

export async function discoverXMedia({ handle, linkedAccount, knownPosts = {}, knownMediaKeys = [], knownPostCoverage = {}, initialComplete = false, since, retryPosts = [], scanMode = "history", signal, onProgress, maxScrolls = 10_000, browserType = chromium, requestSettleTimeoutMs = 10_000 }) {
  let browser;
  let context;
  const collectedPosts = new Map();
  const collectedMedia = new Map();
  const unresolved = new Map();
  const unavailablePosts = new Map();
  const emptyDetailEvidence = new Map();
  const expectedTargetPostIds = new Set(Object.keys(knownPosts));
  const failures = new Map();
  const targetUserIds = new Set();
  const requestIdentities = new Map();
  const requestMetadata = new WeakMap();
  let nextRequestOrder = 0;
  const unverifiedBatches = new Map();
  let replayingBatches = false;
  const knownMedia = new Set(knownMediaKeys);
  const provedMediaByPost = new Map();
  const proveMedia = (postId, logicalKey) => {
    if (!provedMediaByPost.has(postId)) provedMediaByPost.set(postId, new Set());
    provedMediaByPost.get(postId).add(logicalKey);
  };
  for (const key of knownMedia) {
    const separator = key.lastIndexOf(":");
    if (separator > 0) proveMedia(key.slice(0, separator), key);
  }
  const pendingResponses = new Set();
  const inFlightRequests = new Map();
  const timedOutRequests = new WeakSet();
  const requestWaiters = new Set();
  let responseQueue = Promise.resolve();
  let stalledResponse = null;
  let disposed = false;
  let detachPageEvents = () => {};
  let timelineResponses = 0;
  let consecutiveIdleScrolls = 0;
  let reachedKnownBoundary = false;
  let reachedEnd = false;
  let refreshingRetries = false;
  let primaryOperation = null;
  let headCaptured = false;
  let headEvidenceAccepted = false;
  const headPostIds = new Set();
  let primaryFrontierOrder = 0;
  let boundary = createSyncBoundary({ knownPosts, initialComplete, since });
  const publicationDates = createPublicationDateCollector("x");

  const resetBoundary = () => {
    if (typeof boundary.reset === "function") boundary.reset();
    else boundary = createSyncBoundary({ knownPosts, initialComplete, since });
    reachedKnownBoundary = false;
  };
  const recordFailure = (key, message) => {
    failures.set(key, message);
    resetBoundary();
  };
  const finishAllowed = () => unresolved.size === 0 && failures.size === 0 && inFlightRequests.size === 0 && pendingResponses.size === 0;
  const rangeFinishAllowed = () => failures.size === 0 && inFlightRequests.size === 0 && pendingResponses.size === 0;
  const stopFeedAllowed = () => scanMode === "incremental" ? rangeFinishAllowed() : finishAllowed();

  const foreignRequest = (identity) => identity.operation === "UserByScreenName"
    ? Boolean(identity.screenName && identity.screenName !== handle.toLowerCase())
    : Boolean(identity.userId && targetUserIds.size && !targetUserIds.has(identity.userId));
  const confirmedScope = (batch, identity) => {
    const scope = batch.timelineScope;
    if (!scope.present || (scope.ownerHandle && scope.ownerHandle.toLowerCase() !== handle.toLowerCase())) return false;
    if (identity.userId) return targetUserIds.has(identity.userId) && (!scope.ownerId || scope.ownerId === identity.userId);
    return scope.ownerHandle.toLowerCase() === handle.toLowerCase()
      || Boolean(scope.ownerId && targetUserIds.has(scope.ownerId));
  };
  const pruneForeignRequests = () => {
    for (const [key, identity] of requestIdentities) {
      if (!foreignRequest(identity)) continue;
      failures.delete(key);
      failures.delete(`${key}:scope`);
      unverifiedBatches.delete(key);
    }
    for (const [request, identity] of inFlightRequests) {
      if (foreignRequest(identity)) inFlightRequests.delete(request);
    }
    for (const notify of requestWaiters) notify();
  };

  const consumeBatch = (payload, identity = {}) => {
    const { operation = null, key = "first-screen", firstScreen = false } = identity;
    const batch = extractXTimeline(payload, handle, { expectedPostIds: [...expectedTargetPostIds],
      requestedPostId: operation === "TweetDetail" ? identity.requestedPostId : null });
    const previousIdentityCount = targetUserIds.size;
    for (const id of batch.targetUserIds) targetUserIds.add(id);
    pruneForeignRequests();
    if (operation && foreignRequest(identity)) return false;
    if (operation === "UserByScreenName") {
      if (Array.isArray(payload?.errors) && payload.errors.length) recordFailure(key, "X 目标账号身份读取失败。");
      else if (!batch.targetUserIds.length) recordFailure(key, "X 目标账号身份未得到确认。");
      else failures.delete(key);
      replayVerifiedBatches();
      return true;
    }
    if (firstScreen && !batch.recognized && !batch.unresolvedMedia.length) {
      if (targetUserIds.size !== previousIdentityCount) replayVerifiedBatches();
      return false;
    }
    const hasErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;
    if (hasErrors) {
      recordFailure(key, "X 响应包含未恢复的 GraphQL 错误。");
    }
    if (!batch.recognized && !batch.unresolvedMedia.length) {
      if (!firstScreen) recordFailure(key, "X 时间线响应结构无法识别。");
      return false;
    }
    if (!hasErrors) failures.delete(key);
    if (operation === "TweetDetail" && identity.requestedPostId === identity.detailPagePostId && !hasErrors) {
      const postId = String(identity.requestedPostId || "");
      if (batch.emptyRootPostIds?.includes(postId)) emptyDetailEvidence.set(postId, identity.requestOrder);
      else if (batch.posts.some((post) => post.postId === postId)) emptyDetailEvidence.delete(postId);
    }
    let unseenPosts = 0;
    for (const post of batch.unavailablePosts || []) unavailablePosts.set(post.postKey, post);
    for (const post of batch.posts) if (!(batch.unavailablePosts || []).some((item) => item.postKey === post.postKey)) {
      unavailablePosts.delete(post.postKey);
      expectedTargetPostIds.add(post.postKey);
    }
    for (const item of batch.media) {
      collectedMedia.set(item.logicalKey, item);
      proveMedia(item.postId, item.logicalKey);
    }
    const missing = batch.unresolvedMedia.filter((item) => !item.logicalKey
      || (!knownMedia.has(item.logicalKey) && !collectedMedia.has(item.logicalKey)));
    const expectedCounts = new Map();
    const expectedKeys = new Map();
    for (const post of batch.posts) {
      const expected = Math.max(post.mediaExpectedCount || 0, collectedPosts.get(post.postKey)?.mediaExpectedCount || 0,
        knownPostCoverage[post.postKey]?.mediaExpectedCount || 0);
      expectedCounts.set(post.postId, expected);
      const keys = [...new Set([...(post.mediaExpectedKeys || []), ...(collectedPosts.get(post.postKey)?.mediaExpectedKeys || []),
        ...(knownPostCoverage[post.postKey]?.mediaExpectedKeys || [])])];
      expectedKeys.set(post.postId, keys);
      for (const key of keys) {
        if (provedMediaByPost.get(post.postId)?.has(key)) continue;
        missing.push({ postKey: post.postKey, postId: post.postId, logicalKey: key, postUrl: post.postUrl,
          reason: "此前已观察到的附件仍未得到可下载或已保存证明。" });
      }
      if (expected > Math.max(post.mediaReportedCount || 0, provedMediaByPost.get(post.postId)?.size || 0)) {
        missing.push({ postKey: post.postKey, postId: post.postId, postUrl: post.postUrl,
          reason: "附件数量少于此前已观察到的数量，仍需补全。" });
      }
    }
    const missingPosts = new Set(missing.map((item) => item.postId));
    const targetedPosts = new Set(batch.posts.map((post) => post.postId));
    for (const postId of batch.resolvedPostIds) {
      if (!targetedPosts.has(postId) || !missingPosts.has(postId)) {
        for (const [missingKey, item] of unresolved) if (item.postId === postId) unresolved.delete(missingKey);
      }
    }
    for (const item of missing) unresolved.set(item.logicalKey || `${item.postId}:post`, item);
    const posts = batch.posts.map((post) => ({ ...post, mediaExpectedCount: expectedCounts.get(post.postId),
      mediaExpectedKeys: expectedKeys.get(post.postId), mediaComplete: !missingPosts.has(post.postId) }));
    for (const post of posts) {
      if (!knownPosts[post.postKey] && !collectedPosts.has(post.postKey)) unseenPosts += 1;
      collectedPosts.set(post.postKey, post);
    }
    if (boundary.reached && identity.timeline && operation !== "TweetDetail"
      && posts.some((post) => !knownPosts[post.postKey] || post.mediaComplete === false)) resetBoundary();
    if (identity.timeline && operation && operation !== "TweetDetail") {
      if (!confirmedScope(batch, identity)) {
        if (unverifiedBatches.size < 100 || unverifiedBatches.has(key)) unverifiedBatches.set(key, { payload, identity });
        recordFailure(`${key}:scope`, "X 尚未确认该时间线及结束标记归属于目标账号。");
      } else {
        failures.delete(`${key}:scope`);
        unverifiedBatches.delete(key);
        // The base profile page is a posts feed. Supplemental media/video
        // feeds can arrive first, but their terminal page cannot end that feed.
        if (/^(?:UserOriginalsTimeline|UserTweets(?:AndReplies)?)$/.test(operation)) primaryOperation ||= operation;
      }
      if (confirmedScope(batch, identity) && operation === primaryOperation) {
        if (!identity.cursor && !hasErrors) {
          headEvidenceAccepted = true;
          for (const post of posts) headPostIds.add(post.postId);
          for (const item of missing) if (item.postId) headPostIds.add(item.postId);
        }
        if (!Number.isSafeInteger(identity.requestOrder)) {
          recordFailure(`${key}:order`, "X 时间线请求的发起顺序尚未确认，不能采用其结束标记。");
        } else if (identity.requestOrder >= primaryFrontierOrder) {
          failures.delete(`${key}:order`);
          primaryFrontierOrder = identity.requestOrder;
          reachedEnd = batch.timelineScope.pagination.endConfirmed;
          // A late older page must not replace newer pagination proof. Keep
          // request-time phase so feed responses still retract end in details.
          if (!failures.size && (scanMode === "incremental" || !unresolved.size)) {
            boundary.observe(posts);
            if (!boundary.reached) reachedKnownBoundary = false;
          }
          else resetBoundary();
        }
      }
    } else if (failures.size || (scanMode !== "incremental" && unresolved.size)) resetBoundary();
    // Embedded JSON supplies first-screen media, not a second artificial batch
    // for the incremental boundary. A feed response must confirm completion.
    if (!firstScreen) timelineResponses += 1;
    onProgress?.({ posts: collectedPosts.size, media: collectedMedia.size, unseenPosts, timelineResponses });
    if (targetUserIds.size !== previousIdentityCount) replayVerifiedBatches();
    return true;
  };

  const replayVerifiedBatches = () => {
    if (replayingBatches || !targetUserIds.size) return;
    replayingBatches = true;
    try {
      for (const [key, saved] of [...unverifiedBatches]) {
        if (foreignRequest(saved.identity)) { unverifiedBatches.delete(key); failures.delete(`${key}:scope`); continue; }
        const batch = extractXTimeline(saved.payload, handle, { expectedPostIds: [...expectedTargetPostIds] });
        if (!confirmedScope(batch, saved.identity)) continue;
        unverifiedBatches.delete(key);
        failures.delete(`${key}:scope`);
        consumeBatch(saved.payload, saved.identity);
      }
    } finally { replayingBatches = false; }
  };

  const consumeResponse = async (response) => {
    if (disposed) return;
    const parsedIdentity = responseIdentity(response);
    if (!parsedIdentity) return;
    const identity = { ...parsedIdentity, ...requestMetadata.get(response.request?.()) };
    requestIdentities.set(identity.key, identity);
    if (foreignRequest(identity)) return;
    try {
      const status = typeof response.status === "function" ? response.status() : 200;
      if (status < 200 || status >= 300) {
        recordFailure(identity.key, `X 时间线请求失败（HTTP ${status}）。`);
        return;
      }
      const payload = await response.json();
      if (disposed) return;
      consumeBatch(payload, identity);
    } catch { if (!disposed) recordFailure(identity.key, "X 时间线响应读取或 JSON 解析失败。"); }
  };

  const settleResponses = async () => {
    if (signal?.aborted) throw abortError();
    if (stalledResponse && pendingResponses.has(stalledResponse)) return;
    stalledResponse = null;
    const deadline = Date.now() + requestSettleTimeoutMs;
    while (pendingResponses.size) {
      let timer;
      let onAbort;
      const settled = await Promise.race([
        Promise.allSettled([...pendingResponses]).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
        new Promise((_, reject) => {
          onAbort = () => reject(abortError());
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); });
      if (!settled) {
        stalledResponse = pendingResponses.values().next().value;
        recordFailure("pending-response", "X 时间线响应正文仍未读取完成，不能确认采集结束。");
        return;
      }
    }
    failures.delete("pending-response");
  };

  const settleIssuedRequests = async () => {
    if (signal?.aborted) throw abortError();
    if (!inFlightRequests.size) return;
    if ([...inFlightRequests.keys()].every((request) => timedOutRequests.has(request))) return;
    let timer;
    let notify;
    let onAbort;
    await new Promise((resolve, reject) => {
      notify = () => { if (!inFlightRequests.size) resolve(); };
      requestWaiters.add(notify);
      onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(resolve, requestSettleTimeoutMs);
      notify();
      if (signal?.aborted) onAbort();
    }).finally(() => { clearTimeout(timer); requestWaiters.delete(notify); signal?.removeEventListener("abort", onAbort); });
    if (inFlightRequests.size) {
      for (const [request, identity] of inFlightRequests) {
        timedOutRequests.add(request);
        recordFailure(identity.key, "X 时间线仍有未完成的网络请求，不能确认采集结束。");
      }
    }
    await settleResponses();
  };

  const captureFirstScreen = async (page, scope = "profile") => {
    const readKey = `first-screen-read:${scope}`;
    const jsonKey = `first-screen-json:${scope}`;
    try {
      if (typeof page.content === "function") {
        const issues = [];
        const payloads = parseXInitialState(await page.content(), { onIssue: (issue) => issues.push(issue) });
        for (const payload of payloads) consumeBatch(payload, { key: `first-screen-data:${scope}`, firstScreen: true, timeline: scope === "profile" });
        if (issues.length) recordFailure(jsonKey, issues.slice(0, 3).join(" "));
        else failures.delete(jsonKey);
      }
      failures.delete(readKey);
    } catch { recordFailure(readKey, "X 首屏内嵌数据未能读取。"); }
  };

  const captureVisiblePosts = async (page) => {
    try {
      const ids = await page.evaluate(({ handle: target }) => {
        const ids = new Set();
        for (const article of document.querySelectorAll('[data-testid="tweet"], article')) {
          for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
            try {
              const url = new URL(anchor.href, location.href);
              const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/);
              if (match && match[1].toLowerCase() === target.toLowerCase()) ids.add(match[2]);
            } catch {}
          }
        }
        return [...ids].slice(0, 200);
      }, { kind: "x-visible-posts", handle });
      if (!Array.isArray(ids)) return;
      failures.delete("visible-posts");
      for (const postId of ids) {
        expectedTargetPostIds.add(String(postId));
        if (!/^\d+$/.test(String(postId)) || collectedPosts.has(String(postId))) continue;
        unresolved.set(`${postId}:post`, { postKey: String(postId), postId: String(postId),
          postUrl: `https://x.com/${handle}/status/${postId}`, reason: "页面可见的帖子尚未从首屏或时间线数据中解析。" });
        resetBoundary();
      }
    } catch { recordFailure("visible-posts", "X 首屏帖子完整性检查失败。"); }
  };

  const confirmUnavailableDetail = async (page, postId) => {
    // X sometimes returns a successful TweetDetail whose root tweet_results
    // is empty, rather than a typed TweetUnavailable. Neither that empty object
    // nor zero expected attachments alone proves unavailability. Require the
    // exact detail request/page identity and a visible, explicit missing-page
    // message, with no tweet, login, challenge, transport or parsing failure.
    if (!emptyDetailEvidence.has(postId) || failures.size || pendingResponses.size || inFlightRequests.size) return;
    let snapshot;
    try {
      snapshot = await page.evaluate(() => {
        const visible = (element) => Boolean(element && element.getBoundingClientRect().width > 0
          && element.getBoundingClientRect().height > 0);
        return {
          url: location.href,
          text: (document.querySelector('main, [role="main"]')?.innerText || document.body?.innerText || "").slice(0, 6000),
          hasTweet: [...document.querySelectorAll('[data-testid="tweet"], article')].some(visible),
          hasLoginField: [...document.querySelectorAll('input[type="password"], input[name="text"], [data-testid="ocfEnterTextTextInput"]')].some(visible),
          hasChallenge: [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"], [data-testid="arkoseIframe"]')].some(visible),
        };
      }, { kind: "x-detail-availability", handle, postId });
    } catch { return; }
    if (!xDetailExplicitlyUnavailable(snapshot, { handle, postId })) return;
    const previous = collectedPosts.get(postId);
    const pendingItems = [...unresolved.values()].filter((item) => item.postId === postId);
    const expectedCount = Math.max(previous?.mediaExpectedCount || 0, knownPostCoverage[postId]?.mediaExpectedCount || 0,
      ...pendingItems.map((item) => item.mediaExpectedCount || 0));
    const expectedKeys = [...new Set([...(previous?.mediaExpectedKeys || []), ...(knownPostCoverage[postId]?.mediaExpectedKeys || []),
      ...pendingItems.map((item) => item.logicalKey).filter(Boolean)])];
    const positiveExpectation = expectedCount > 0 || expectedKeys.length > 0;
    const observation = { postKey: postId, postId, postUrl: `https://x.com/${handle}/status/${postId}`,
      reasonCode: "post-unavailable", reason: "平台详情明确显示此页面不存在；此前已采集的文件及来源保留。",
      mediaComplete: true, mediaExpectedCount: 0, mediaExpectedKeys: [], mediaReportedCount: 0,
      createdAt: previous?.createdAt || (typeof knownPosts[postId] === "string" ? knownPosts[postId] : null), pinned: false };
    unavailablePosts.set(postId, observation);
    collectedPosts.set(postId, { ...observation, mediaExpectedCount: expectedCount, mediaExpectedKeys: expectedKeys,
      mediaComplete: !positiveExpectation });
    if (!positiveExpectation) {
      for (const [key, item] of unresolved) if (item.postId === postId) unresolved.delete(key);
    } else if (![...unresolved.values()].some((item) => item.postId === postId)) {
      unresolved.set(`${postId}:post`, { postKey: postId, postId, postUrl: observation.postUrl,
        reason: "平台详情显示帖子不可用，但此前观察到的附件仍待核对；不会删除已采集内容。" });
    }
  };

  try {
    if (linkedAccount) {
      context = await browserType.launchPersistentContext(linkedAccount.profileDirectory, {
        headless: true,
        executablePath: BACKGROUND_CHROMIUM_EXECUTABLE,
        viewport: { width: 1280, height: 900 },
        args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"],
      });
    } else {
      browser = await browserType.launch({ headless: true, executablePath: BACKGROUND_CHROMIUM_EXECUTABLE });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    }
    const page = context.pages()[0] || await context.newPage();
    const onRequest = (request) => {
      const identity = responseIdentity(request);
      if (identity && !foreignRequest(identity)) {
        const metadata = { requestOrder: ++nextRequestOrder, timeline: !refreshingRetries,
          detailPagePostId: identity.operation === "TweetDetail" ? detailPagePostId(page.url(), handle) : null };
        requestMetadata.set(request, metadata);
        requestIdentities.set(identity.key, identity);
        inFlightRequests.set(request, identity);
      }
    };
    const onRequestFinished = (request) => {
      inFlightRequests.delete(request);
      for (const notify of requestWaiters) notify();
    };
    const onRequestFailed = (request) => {
      const identity = inFlightRequests.get(request) || responseIdentity(request);
      if (identity && !foreignRequest(identity)) recordFailure(identity.key, "X 时间线请求发生未恢复的网络错误。");
      onRequestFinished(request);
    };
    const onResponse = (response) => {
      // Preserve response arrival order even when JSON bodies finish later.
      responseQueue = responseQueue.then(() => consumeResponse(response));
      const task = responseQueue.finally(() => pendingResponses.delete(task));
      pendingResponses.add(task);
    };
    page.on("request", onRequest);
    page.on("requestfinished", onRequestFinished);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    detachPageEvents = () => {
      page.off("request", onRequest);
      page.off("requestfinished", onRequestFinished);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    };
    await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1_500);
    await settleResponses();
    await captureFirstScreen(page);
    await captureVisiblePosts(page);
    await publicationDates.capture(page);

    if (/\/i\/flow\/login|\/login(?:\?|$)/.test(page.url())) {
      throw new XDiscoveryError("login-required", "X 要求登录。请为该账号选择一个已验证的关联账号。");
    }

    let previousProgress = collectedPosts.size + collectedMedia.size;
    for (let scroll = 0; scroll < maxScrolls; scroll += 1) {
      if (signal?.aborted) throw abortError();
      await publicationDates.capture(page);
      if ((reachedEnd || boundary.reached) && stopFeedAllowed()) { reachedKnownBoundary = !reachedEnd && boundary.reached; break; }
      await page.mouse.wheel(0, 7_000);
      await page.waitForTimeout(1_250);
      await settleResponses();
      await captureVisiblePosts(page);
      await publicationDates.capture(page);

      const progress = collectedPosts.size + collectedMedia.size;
      const gainedPosts = progress > previousProgress;
      previousProgress = progress;

      consecutiveIdleScrolls = gainedPosts ? 0 : consecutiveIdleScrolls + 1;

      if ((reachedEnd || boundary.reached) && stopFeedAllowed()) {
        reachedKnownBoundary = !reachedEnd && boundary.reached;
        break;
      }
      if (consecutiveIdleScrolls >= 6) {
        break;
      }
    }
    await settleResponses();
    await settleIssuedRequests();
    await captureFirstScreen(page);
    await captureVisiblePosts(page);
    if (boundary.reached && stopFeedAllowed() && !reachedEnd) reachedKnownBoundary = true;

    if (timelineResponses === 0 && collectedPosts.size === 0 && unresolved.size === 0) {
      const hasLoginField = await page.locator('input[type="password"], input[name="text"]').first().isVisible().catch(() => false);
      throw new XDiscoveryError(
        hasLoginField ? "login-required" : "timeline-unavailable",
        hasLoginField
          ? "X 登录状态不可用，请重新打开登录窗口并验证。"
          : [...failures.values()][0] || "未能读取 X 时间线，可能遇到访问限制或网络异常。",
      );
    }

    refreshingRetries = true;
    const refreshUrls = [...new Set([...retryPosts, ...[...unresolved.values()].map((item) => item.postUrl).filter(Boolean)])].slice(0, 50);
    for (const postUrl of refreshUrls) {
      if (signal?.aborted) throw abortError();
      const postId = String(postUrl).match(/\/status\/(\d+)/)?.[1];
      if (!postId) continue;
      try {
        await page.goto(`https://x.com/${encodeURIComponent(handle)}/status/${postId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        failures.delete(`detail-navigation:${postId}`);
      } catch { recordFailure(`detail-navigation:${postId}`, "X 待补全帖子的详情页面访问失败。"); }
      await page.waitForTimeout(1_500);
      await settleResponses();
      await captureFirstScreen(page, `detail:${postId}`);
      await publicationDates.capture(page);
      await confirmUnavailableDetail(page, postId);
    }

    await settleResponses();
    await settleIssuedRequests();

    // A target feed's range can be verified even if independently retained
    // attachment retries remain. These gaps still prevent full completion;
    // they must not force every subsequent daily sync to re-walk all history.
    headCaptured = headEvidenceAccepted && [...headPostIds].every((postId) =>
      collectedPosts.get(postId)?.mediaComplete !== false && ![...unresolved.values()].some((item) => item.postId === postId));
    const rangeComplete = headCaptured && (reachedEnd || boundary.reached) && failures.size === 0
      && inFlightRequests.size === 0 && pendingResponses.size === 0;
    const complete = rangeComplete && unresolved.size === 0;
    reachedKnownBoundary = rangeComplete && !reachedEnd && boundary.reached;
    const incompleteReason = complete ? "" : [
      !reachedEnd && !reachedKnownBoundary ? "X 未提供可靠的历史结束标记或已知增量边界；无进展滚动不代表已全部读取。" : "",
      unresolved.size ? `仍有 ${unresolved.size} 项帖子或附件信息尚未完整解析。` : "",
      inFlightRequests.size && !failures.size ? "X 时间线仍有未完成的网络请求。" : "",
      pendingResponses.size && !failures.size ? "X 时间线响应正文尚未读取完成。" : "",
      failures.size ? [...failures.values()].slice(0, 3).join(" ") : "",
    ].filter(Boolean).join(" ");
    return {
      posts: publicationDates.apply([...collectedPosts.values()]),
      media: publicationDates.apply([...collectedMedia.values()]),
      complete,
      rangeComplete,
      headCaptured,
      reachedEnd,
      reachedKnownBoundary,
      timelineResponses,
      completionReason: complete ? reachedEnd ? "terminal-page" : "known-boundary" : null,
      rangeCompletionReason: rangeComplete ? reachedEnd ? "terminal-page" : "known-boundary" : null,
      incompleteReason,
      unresolvedMedia: [...unresolved.values()],
      unavailablePosts: [...unavailablePosts.values()],
      parseIssues: [...failures.values()].slice(0, 20),
    };
  } catch (error) {
    if (profileBusy(error)) {
      throw new XDiscoveryError("profile-busy", "关联账号的登录窗口仍在运行。请关闭该窗口后再同步。");
    }
    throw error;
  } finally {
    disposed = true;
    detachPageEvents();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
