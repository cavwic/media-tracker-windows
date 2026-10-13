import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { createInstagramPostCoverage, extractInstagramTimeline, instagramDetailDocuments, instagramGraphQLIssues, instagramTimelineDocuments, normalizeInstagramHandle, parseInstagramHtml } from "./instagram-media.mjs";
import { createSyncBoundary } from "./sync-boundary.mjs";
import { createPublicationDateCollector } from "./publication-date.mjs";

function abortError() {
  return new DOMException("同步已取消。", "AbortError");
}

function profileBusy(error) {
  return /user data directory is already in use|ProcessSingleton|profile.*in use/i.test(String(error?.message || error));
}

function instagramApiUrl(value) {
  try {
    const url = new URL(value);
    if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) return null;
    return /^\/(?:api\/graphql|graphql\/query)(?:\/|$)/.test(url.pathname)
      || /^\/api\/v1\/(?:feed\/user|users\/web_profile_info)(?:\/|$)/.test(url.pathname) ? url : null;
  } catch { return null; }
}

function timelineRequestIdentity(request, target, targetUserIds) {
  try {
    const url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || "");
    const variablesText = body.get("variables") || url.searchParams.get("variables");
    const variables = variablesText ? JSON.parse(variablesText) : {};
    const operation = body.get("fb_api_req_friendly_name") || body.get("operationName")
      || url.searchParams.get("fb_api_req_friendly_name") || url.searchParams.get("operationName")
      || request.headers?.()["x-fb-friendly-name"] || "";
    const feedOperation = /^PolarisProfilePosts(?:TabContent)?Query(?:_connection)?$/.test(operation);
    const potentialFeedOperation = /^PolarisProfilePosts[A-Za-z0-9_]*Query(?:_connection)?$/.test(operation);
    const legacyFeed = /^\/api\/v1\/feed\/user\/(\d+)(?:\/|$)/.test(url.pathname);
    const profileMetadata = /^\/api\/v1\/users\/web_profile_info(?:\/|$)/.test(url.pathname);
    // Numeric user IDs occur on dozens of profile/inbox components. They are
    // target-feed identity only on a known posts operation or legacy feed API.
    let eligible = !profileMetadata && (legacyFeed || feedOperation || !operation);
    const username = normalizeInstagramHandle(variables.username || variables.user_name || url.searchParams.get("username"));
    const feedId = url.pathname.match(/^\/api\/v1\/feed\/user\/(\d+)(?:\/|$)/)?.[1];
    const id = feedId || variables.user_id || variables.userId || variables.id;
    const otherTarget = Boolean(username && username.toLowerCase() !== target.toLowerCase())
      || Boolean((legacyFeed || feedOperation) && id && targetUserIds.size && !targetUserIds.has(String(id)));
    eligible &&= !otherTarget;
    const targeted = eligible && (username.toLowerCase() === target.toLowerCase()
      || ((legacyFeed || feedOperation) && id && targetUserIds.has(String(id))));
    const canonical = (value) => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const key = JSON.stringify([url.pathname, operation, canonical(variables),
      [...url.searchParams].filter(([name]) => name !== "variables" && name !== "__a" && name !== "__req").sort()]);
    const hasCursor = (value) => value && typeof value === "object" && Object.entries(value).some(([name, entry]) =>
      (/^(?:after|before|cursor|max_id|maxId|next_max_id|end_cursor)$/i.test(name) && entry != null && entry !== "")
      || hasCursor(entry));
    const requestedPostKey = String(variables.shortcode || variables.code || variables.data?.shortcode || "");
    return { requestedHandle: targeted ? target : "", eligible, confirmedFeed: feedOperation || legacyFeed, key, operation,
      requestedUsername: username, requestedUserId: id ? String(id) : "", otherTarget,
      potentialFeedOperation,
      potentialTarget: potentialFeedOperation && !otherTarget && (username.toLowerCase() === target.toLowerCase()
        || (id && targetUserIds.has(String(id)))),
      excludedOperation: profileMetadata || /(?:ProfilePageContent|PostRoot|Suggested|Recommend|Inbox|Story)/i.test(operation),
      detailOperation: /^PolarisPostRootQuery$/.test(operation),
      requestedPostKey: /^[A-Za-z0-9_-]{1,128}$/.test(requestedPostKey) ? requestedPostKey : "",
      firstPage: !hasCursor(variables) && ![...url.searchParams].some(([name, entry]) =>
        /^(?:after|before|cursor|max_id|next_max_id)$/i.test(name) && entry !== "") };
  } catch { /* Request identity is optional; explicit post owners still work. */ }
  return { requestedHandle: "", eligible: true, confirmedFeed: false, key: "unknown", firstPage: false, operation: "" };
}

async function visibleFailure(page) {
  const password = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  if (password || /\/accounts\/login(?:\/|$)/.test(new URL(page.url()).pathname)) {
    return new InstagramDiscoveryError("login-required", "Instagram 登录状态不可用，请重新登录并验证。");
  }
  if (/\/(?:challenge|checkpoint)(?:\/|$)/.test(new URL(page.url()).pathname)) {
    return new InstagramDiscoveryError("verification-required", "Instagram 要求完成账号安全验证，请在独立登录窗口确认后重试。");
  }
  const warning = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const scope = document.querySelector('main, [role="main"]') || document.body;
    const unavailableTitle = /^(?:(?:很)?抱歉[，,!！.。\s]*)?(?:(?:此|这)(?:个)?页面(?:无法访问|不可用)|无法访问(?:此|这)(?:个)?页面|用户未找到)[。.!！\s]*$|^(?:sorry[,!\s]*)?(?:(?:this )?page (?:isn['’]t|is not) available|(?:this )?content (?:isn['’]t|is not) available)[.!\s]*$/i;
    const excluded = 'article, footer, nav, [role="dialog"], [role="navigation"], [role="contentinfo"]';
    const candidates = scope ? [...scope.querySelectorAll('h1,h2,h3,[role="heading"],p,span,div')]
      .filter(element => !element.closest(excluded) && (element.childElementCount === 0 || /^H[1-3]$/.test(element.tagName)
        || element.getAttribute("role") === "heading"))
      .map(element => ({ text: (element.innerText || "").trim(), heading: /^H[1-3]$/.test(element.tagName)
        || element.getAttribute("role") === "heading" })).filter(entry => entry.text.length > 0 && entry.text.length <= 300) : [];
    // The minimal text-only error page also occurs in static/offline responses.
    if (scope && scope.childElementCount === 0) candidates.push({ text: (scope.innerText || "").trim(), heading: false });
    const titles = candidates.filter(entry => unavailableTitle.test(entry.text));
    // The real error's explanation includes an inline "Return to Instagram"
    // anchor. It is not a leaf span; admit short explanatory containers, but
    // never aggregate excluded post/footer/navigation/dialog descendants.
    const explanations = scope ? [...scope.querySelectorAll('p,span,div')]
      .filter(element => !element.closest(excluded) && !element.querySelector(excluded))
      .map(element => (element.innerText || "").trim()).filter(value => value.length > 0 && value.length <= 500) : [];
    const explanation = [...candidates.map(entry => entry.text), ...explanations].some(value => /(?:你点击的)?链接可能(?:已)?损坏|页面(?:可能)?已被移除|链接(?:已)?失效|(?:the )?link (?:you followed |you clicked )?may be broken|(?:the )?page may have been removed/i.test(value));
    const postPresent = Boolean(scope?.querySelector('article,a[href^="/p/"],a[href^="/reel/"],a[href^="https://www.instagram.com/p/"],a[href^="https://www.instagram.com/reel/"]'));
    return {
      privateAccount: /this account is private|这是私密(?:帐|账)户|(?:帐|账)户是私密/i.test(text),
      unavailable: !postPresent && titles.length > 0 && (explanation || titles.some(entry => entry.heading)
        || (scope?.childElementCount === 0 && unavailableTitle.test((scope.innerText || "").trim()))),
    };
  }).catch(() => ({}));
  if (warning.privateAccount) return new InstagramDiscoveryError("private-account", "Instagram 目标账号为私密账号，当前关联账号未获准查看其作品。");
  if (warning.unavailable) return new InstagramDiscoveryError("content-unavailable", "Instagram 目标主页不可用，请核对账号名称及当前访问权限。");
  return null;
}

export class InstagramDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function discoverInstagramMedia({ handle, linkedAccount, knownPosts = {}, knownPostCoverage = {}, knownMediaKeys = [], initialComplete = false, since, retryPosts = [], signal, onProgress, maxScrolls = 10_000,
  browserType = chromium, timelineWaitMs = 30_000, retryTimelineWaitMs = 15_000, scrollWaitMs = 1_250, responseWaitMs = 1_000 }) {
  handle = normalizeInstagramHandle(handle);
  if (!handle) throw new InstagramDiscoveryError("invalid-handle", "Instagram 账号名称无效。");
  if (signal?.aborted) throw abortError();
  responseWaitMs = Number.isFinite(Number(responseWaitMs)) ? Math.min(10_000, Math.max(0, Number(responseWaitMs))) : 1_000;
  let browser;
  let context;
  let page;
  let responseListener;
  let requestListener;
  let requestFinishedListener;
  let requestFailedListener;
  const posts = new Map();
  const media = new Map();
  const pending = new Set();
  const timelinePending = new Set();
  const inFlightRequests = new Map();
  let timelineResponses = 0;
  let matchedResponses = 0;
  let invalidResponses = 0;
  const apiFailures = { target: new Map(), candidate: new Map() };
  const responseOperations = new Map();
  const responseFeedRoots = new Map();
  const profileSsrDocuments = new Map();
  let profileNavigationSequence = 0;
  let previousDomScripts = "";
  let timelineHasNextPage = null;
  const targetUserIds = new Set();
  let consecutiveIdleScrolls = 0;
  let reachedKnownBoundary = false;
  let reachedEnd = false;
  let headTraversalCaptured = false;
  let headCaptured = false;
  let refreshingRetries = false;
  let retryPostKey = null;
  let stopReason = null;
  let responseSequence = 0;
  let latestTimelineSequence = 0;
  const traversalFailures = new Map();
  const successfulRequestSequences = new Map();
  const confirmedFeedRequests = new Set();
  const parseIssues = new Map();
  const detailFailures = new Map();
  const successfulDetailSequences = new Map();
  const unresolvedByPost = new Map();
  const coverage = createInstagramPostCoverage({ knownPostCoverage, knownMediaKeys });
  for (const [postKey, previous] of Object.entries(knownPostCoverage || {})) {
    unresolvedByPost.set(postKey, [{ postKey, postId: previous?.postId || postKey, postUrl: previous?.postUrl,
      mediaExpectedCount: previous?.mediaExpectedCount, mediaExpectedKeys: previous?.mediaExpectedKeys, reason: "known-media-unresolved" }]);
  }
  const boundary = createSyncBoundary({ knownPosts, initialComplete, since });
  const publicationDates = createPublicationDateCollector("instagram");
  const settleResponses = async (milliseconds = responseWaitMs) => {
    const deadline = Date.now() + Math.max(0, Number(milliseconds) || 0);
    do {
      if (signal?.aborted) throw abortError();
      if (!pending.size) return true;
      let timer;
      let abortListener;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
          ...(signal ? [new Promise((_resolve, reject) => {
            abortListener = () => reject(abortError());
            signal.addEventListener("abort", abortListener, { once: true });
          })] : []),
        ]);
      } finally {
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener("abort", abortListener);
      }
      if (!pending.size) return true;
    } while (Date.now() < deadline);
    return false;
  };
  const issueKey = (entry) => JSON.stringify([entry.reason, entry.postKey || "", entry.scope || "",
    entry.operation || "", entry.fieldPath || null, entry.graphqlCode ?? null]);
  const recordIssue = (entry) => {
    const key = issueKey(entry);
    if (parseIssues.has(key) || parseIssues.size < 50) parseIssues.set(key, entry);
  };
  const recordDetailIssues = (postKey, sequence, issues) => {
    if (!postKey || !issues.length || (successfulDetailSequences.get(postKey) || 0) > sequence) return;
    const previous = detailFailures.get(postKey);
    if (previous && previous.sequence > sequence) return;
    const combined = [...(previous?.sequence === sequence ? previous.issues : []), ...issues];
    detailFailures.set(postKey, { sequence, issues: [...new Map(combined.map((entry) => [issueKey(entry), entry])).values()] });
  };
  const resolveDetailIssues = (postKey, sequence) => {
    successfulDetailSequences.set(postKey, Math.max(successfulDetailSequences.get(postKey) || 0, sequence));
    if ((detailFailures.get(postKey)?.sequence ?? Infinity) <= sequence) detailFailures.delete(postKey);
  };
  const detailRequestMatches = (identity, postKey) => (identity.detailOperation && (!identity.requestedPostKey || identity.requestedPostKey === postKey))
    || (!identity.operation && identity.requestedPostKey === postKey);
  const reliableDetailRecovery = (postKey, parsed) => {
    const current = posts.get(postKey);
    const incoming = parsed.posts.find((post) => post.postKey === postKey);
    return current?.mediaComplete === true && incoming?.mediaComplete === true
      && incoming.mediaExpectedCount >= current.mediaExpectedCount
      && (current.mediaExpectedKeys || []).every((key) => incoming.mediaExpectedKeys?.includes(key));
  };
  const recordDetailFailure = (postKey, identity = {}, extra = {}, sequence = ++responseSequence) => {
    if (!postKey) return;
    recordDetailIssues(postKey, sequence, [{ reason: "detail-refresh-failure", scope: "detail", postKey,
      ...(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(identity.operation || "") ? { operation: identity.operation } : {}), ...extra }]);
  };
  const invalidateTraversal = (reason, identity, sequence, issues = []) => {
    if ((successfulRequestSequences.get(identity.key) || 0) > sequence) return;
    const previous = traversalFailures.get(identity.key);
    if (previous && previous.sequence > sequence) return;
    const requestIssues = [...(previous?.sequence === sequence ? previous.issues : []), ...issues, { reason }];
    traversalFailures.set(identity.key, { sequence, issues: [...new Map(requestIssues.map((entry) =>
      [issueKey(entry), entry])).values()] });
    boundary.reset?.();
    reachedKnownBoundary = false;
    reachedEnd = false;
    timelineHasNextPage = null;
  };
  const resolveTraversal = (identity, sequence) => {
    successfulRequestSequences.set(identity.key, Math.max(successfulRequestSequences.get(identity.key) || 0, sequence));
    if ((traversalFailures.get(identity.key)?.sequence ?? Infinity) <= sequence) traversalFailures.delete(identity.key);
  };

  const countShape = (map, label) => {
    if (map.has(label) || map.size < 12) map.set(label, (map.get(label) || 0) + 1);
  };
  const recordResponseShape = (identity, payload) => {
    const operation = /^Polaris[A-Za-z0-9_]{0,120}$/.test(identity.operation || "") ? identity.operation : identity.operation ? "其他命名操作" : "未命名操作";
    countShape(responseOperations, operation);
    const data = payload?.data;
    for (const root of ["xdt_api__v1__feed__user_timeline_graphql_connection", "user", "media", "shortcode_media", "xdt_shortcode_media", "xdt_api__v1__media__shortcode__web_info"]) {
      if (Object.hasOwn(data || {}, root)) countShape(responseFeedRoots, root === "user"
        ? data.user?.edge_owner_to_timeline_media ? "legacy-profile-feed" : "profile-metadata" : root);
    }
  };
  const consume = async (response, { ssr = false, identityOverride, sequenceOverride, parsedOverride, graphqlRoots, graphqlIssuesOverride } = {}) => {
    if (!ssr && !instagramApiUrl(response.url())) return;
    const requestEntry = inFlightRequests.get(response.request());
    const sequence = sequenceOverride ?? requestEntry?.sequence ?? ++responseSequence;
    if (!ssr) matchedResponses += 1;
    let identity = identityOverride || timelineRequestIdentity(response.request(), handle, targetUserIds);
    let { requestedHandle } = identity;
    // A request started on the timeline remains a timeline request even if its
    // response/body arrives while a pending post's detail is being refreshed.
    const isTimeline = requestEntry?.timeline ?? !refreshingRetries;
    const potentialTarget = requestedHandle || identity.potentialTarget;
    const failures = potentialTarget ? apiFailures.target : apiFailures.candidate;
    const recordFailure = (classification) => failures.set(classification, (failures.get(classification) || 0) + 1);
    const status = response.status();
    if (status >= 400) {
      recordFailure(`HTTP ${status}`);
      // An unrelated inbox/profile-component denial must not fail an otherwise
      // readable target feed. Report only bounded status counts if no feed loads.
      if (potentialTarget && isTimeline && (identity.confirmedFeed || identity.potentialFeedOperation || confirmedFeedRequests.has(identity.key))) {
        invalidateTraversal(`timeline-http-${status}`, identity, sequence);
      }
      if (!isTimeline && detailRequestMatches(identity, requestEntry?.postKey || retryPostKey)) {
        recordDetailFailure(requestEntry?.postKey || retryPostKey, identity, { httpStatus: status }, sequence);
      }
      return;
    }
    try {
      const payload = await response.json();
      if (!ssr) recordResponseShape(identity, payload);
      if ((Array.isArray(payload?.errors) && payload.errors.length > 0) || graphqlIssuesOverride?.length) recordFailure("GraphQL 错误");
      const hasApiError = payload?.status === "fail" || payload?.error || payload?.error_type;
      if (hasApiError) recordFailure("API 错误 JSON");
      let parsed = parsedOverride || extractInstagramTimeline(payload, handle, { requestedHandle });
      for (const id of parsed.targetUserIds) targetUserIds.add(id);
      // Owner/coauthor records can prove the numeric target ID in the first
      // response itself. Recheck the request before treating its feed as ours.
      identity = identityOverride || timelineRequestIdentity(response.request(), handle, targetUserIds);
      // An unknown/new posts-operation name is accepted only when the request
      // names this exact target and a real feed root independently proves it.
      // Known profile components, details and recommendations stay excluded.
      if (!ssr && !identity.eligible && !identity.excludedOperation && !identity.otherTarget
        && (identity.requestedUsername.toLowerCase() === handle.toLowerCase()
          || (identity.requestedUserId && targetUserIds.has(identity.requestedUserId)))) {
        const documents = instagramTimelineDocuments(payload, handle);
        if (documents.some((document) => document.parsed.recognized)) {
          identity = { ...identity, eligible: true, confirmedFeed: true, requestedHandle: handle };
          parsed = extractInstagramTimeline(documents.map((document) => document.feedPayload), handle, { requestedHandle: handle });
          graphqlRoots = [...new Set(documents.flatMap((document) => document.roots))];
        }
      }
      if (identity.requestedHandle && !requestedHandle) {
        requestedHandle = identity.requestedHandle;
        if (!parsedOverride && !graphqlRoots) parsed = extractInstagramTimeline(payload, handle, { requestedHandle });
      }
      if (requestEntry && inFlightRequests.has(response.request()) && requestedHandle && !requestEntry.targeted) {
        requestEntry.targeted = true;
        pending.add(requestEntry.promise);
        if (requestEntry.timeline) timelinePending.add(requestEntry.promise);
      }
      const detailPostKey = requestEntry?.postKey || retryPostKey;
      const detailDocuments = !isTimeline && detailPostKey ? instagramDetailDocuments(payload, handle, detailPostKey) : [];
      const graphqlIssues = isTimeline ? graphqlIssuesOverride || instagramGraphQLIssues(payload, parsed, { operation: identity.operation, scope: "timeline", roots: graphqlRoots })
        : detailDocuments.length ? detailDocuments.flatMap((document) => instagramGraphQLIssues(document.payload, document.parsed,
          { operation: identity.operation, scope: "detail", postKey: detailPostKey, roots: document.roots }))
          : detailRequestMatches(identity, detailPostKey)
            ? instagramGraphQLIssues(payload, parsed, { operation: identity.operation, scope: "detail", postKey: detailPostKey,
              roots: ["media", "shortcode_media", "xdt_shortcode_media", "xdt_api__v1__media__shortcode__web_info"] }) : [];
      const hasGraphQLError = graphqlIssues.length > 0;
      if (!isTimeline && detailPostKey) {
        // Post-detail pages contain recommended posts too. A retry can refresh
        // only its requested post, never import the recommendations' media.
        parsed = extractInstagramTimeline(detailDocuments.map((document) => ({ data: Object.fromEntries(document.roots.map((root) =>
          [root, document.payload.data[root]])) })), handle);
        parsed = { ...parsed, posts: parsed.posts.filter((post) => post.postKey === detailPostKey),
          media: parsed.media.filter((item) => item.postKey === detailPostKey),
          unresolvedMedia: parsed.unresolvedMedia.filter((entry) => entry.postKey === detailPostKey),
          parseIssues: parsed.parseIssues.filter((entry) => entry.postKey === detailPostKey) };
        recordDetailIssues(detailPostKey, sequence, graphqlIssues);
        if (hasApiError && (detailDocuments.length || detailRequestMatches(identity, detailPostKey))) {
          recordDetailFailure(detailPostKey, identity, {}, sequence);
        }
      }
      // The profile's numeric ID may not have been known when its first API
      // requests started. Promote still-running candidates once identity is
      // confirmed, before a terminal response can complete discovery.
      for (const [request, entry] of inFlightRequests) {
        const currentIdentity = timelineRequestIdentity(request, handle, targetUserIds);
        if (!entry.targeted && (currentIdentity.requestedHandle || currentIdentity.potentialTarget)) {
          entry.targeted = true;
          pending.add(entry.promise);
          if (entry.timeline) timelinePending.add(entry.promise);
        }
      }
      const feedEvidence = (identity.eligible && (identity.confirmedFeed || confirmedFeedRequests.has(identity.key) || parsed.recognized))
        || (identity.potentialTarget && identity.potentialFeedOperation);
      if (parsed.recognized && identity.eligible && isTimeline) confirmedFeedRequests.add(identity.key);
      if ((hasGraphQLError || hasApiError) && feedEvidence && (requestedHandle || identity.potentialTarget || parsed.recognized) && isTimeline) {
        invalidateTraversal(hasGraphQLError ? "timeline-graphql-error" : "timeline-api-error", identity, sequence, graphqlIssues);
      }
      if (hasApiError && parsed.posts.length === 0) return;
      if (!identity.eligible && isTimeline) return;
      for (const entry of parsed.parseIssues.filter((entry) => entry.postKey)) recordIssue(entry);
      const structuralIssues = parsed.parseIssues.filter((entry) => !entry.postKey);
      if (structuralIssues.length && feedEvidence && isTimeline) {
        invalidateTraversal("timeline-parse-incomplete", identity, sequence, structuralIssues);
      }
      if (!parsed.recognized && parsed.posts.length === 0) {
        if (requestedHandle && feedEvidence && isTimeline && parsed.targetUserIds.length === 0) {
          invalidateTraversal("timeline-response-empty", identity, sequence);
        }
        return;
      }
      let unseenPosts = 0;
      for (const post of parsed.posts) {
        if (!knownPosts[post.postKey] && !posts.has(post.postKey)) unseenPosts += 1;
        const merged = coverage.observe(post, parsed.media.filter((item) => item.postKey === post.postKey),
          parsed.unresolvedMedia.filter((entry) => entry.postKey === post.postKey));
        posts.set(post.postKey, merged.post);
        if (merged.post.mediaComplete) unresolvedByPost.delete(post.postKey);
        else unresolvedByPost.set(post.postKey, merged.unresolvedMedia);
      }
      for (const item of parsed.media) media.set(item.logicalKey, item);
      if (!isTimeline && detailPostKey && detailDocuments.length && !hasGraphQLError && !hasApiError
        && reliableDetailRecovery(detailPostKey, parsed)) resolveDetailIssues(detailPostKey, sequence);
      // A target post-detail response can refresh failed media, but is not
      // evidence that a target feed hydrated, reached its end, or crossed a
      // reliable incremental boundary.
      if (parsed.recognized && identity.eligible && isTimeline) {
        timelineResponses += 1;
        if (!hasGraphQLError && !hasApiError && !structuralIssues.length) {
          resolveTraversal(identity, sequence);
          if (!ssr && identity.firstPage && identity.requestedHandle) {
            // A newer authoritative first-page API can repair a partial SSR
            // copy of the same initial profile feed, not an older API failure.
            resolveTraversal({ key: "ssr:profile-feed" }, sequence);
          }
        }
        if (identity.firstPage && !hasGraphQLError && !hasApiError && !structuralIssues.length
          && parsed.timelineBatches.length && (requestedHandle || parsed.posts.length)) headTraversalCaptured = true;
        if (requestedHandle && identity.confirmedFeed && identity.firstPage && !hasGraphQLError && !hasApiError
          && !structuralIssues.length && parsed.timelineBatches.length
          && parsed.timelineBatches.every((batch) => batch.reliable && batch.posts.every((post) => posts.get(post.postKey)?.mediaComplete))) {
          headCaptured = true;
        }
        if (sequence >= latestTimelineSequence) {
          latestTimelineSequence = sequence;
          timelineHasNextPage = hasGraphQLError || hasApiError ? null : parsed.hasNextPage;
        }
        for (const batch of parsed.timelineBatches) {
          const mergedPosts = batch.posts.map((post) => posts.get(post.postKey));
          if (batch.reliable && mergedPosts.every((post) => post.mediaComplete) && !hasGraphQLError && !hasApiError) boundary.observe(mergedPosts);
          else { boundary.reset?.(); reachedKnownBoundary = false; }
        }
      }
      onProgress?.({ posts: posts.size, media: media.size, unseenPosts, timelineResponses });
    } catch {
      invalidResponses += 1;
      recordFailure("无效 JSON/解析失败");
      if ((requestedHandle || identity.potentialTarget) && isTimeline && (identity.confirmedFeed || identity.potentialFeedOperation || confirmedFeedRequests.has(identity.key))) {
        invalidateTraversal("timeline-json-invalid", identity, sequence);
      }
      if (!isTimeline && detailRequestMatches(identity, requestEntry?.postKey || retryPostKey)) {
        recordDetailFailure(requestEntry?.postKey || retryPostKey, identity, {}, sequence);
      }
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
    page = context.pages()[0] || await context.newPage();
    // A persistent profile can retain empty worker tabs after a crash. Discovery
    // owns this context exclusively; keep just its one background worker page.
    for (const extraPage of context.pages().slice(1)) await extraPage.close();
    responseListener = (response) => {
      const entry = inFlightRequests.get(response.request());
      const timeline = (entry?.timeline ?? !refreshingRetries)
        && timelineRequestIdentity(response.request(), handle, targetUserIds).eligible;
      const task = consume(response).finally(() => { pending.delete(task); timelinePending.delete(task); });
      pending.add(task);
      if (timeline) timelinePending.add(task);
    };
    requestListener = (request) => {
      if (!instagramApiUrl(request.url())) return;
      if (inFlightRequests.has(request)) return;
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const identity = timelineRequestIdentity(request, handle, targetUserIds);
      const targeted = Boolean(identity.requestedHandle || identity.potentialTarget);
      inFlightRequests.set(request, { promise, resolve, timeline: !refreshingRetries, targeted,
        postKey: refreshingRetries ? retryPostKey : null, sequence: ++responseSequence });
      if (targeted) { pending.add(promise); if (!refreshingRetries) timelinePending.add(promise); }
    };
    requestFinishedListener = (request) => {
      const entry = inFlightRequests.get(request);
      if (!entry) return;
      inFlightRequests.delete(request);
      pending.delete(entry.promise);
      timelinePending.delete(entry.promise);
      entry.resolve();
    };
    requestFailedListener = (request) => {
      if (!instagramApiUrl(request.url())) return;
      const entry = inFlightRequests.get(request);
      const identity = timelineRequestIdentity(request, handle, targetUserIds);
      const targeted = identity.requestedHandle || identity.potentialTarget;
      if (!signal?.aborted && (entry?.timeline ?? !refreshingRetries)) {
        const failures = targeted ? apiFailures.target : apiFailures.candidate;
        failures.set("网络请求失败", (failures.get("网络请求失败") || 0) + 1);
        if (targeted && (identity.confirmedFeed || identity.potentialFeedOperation || confirmedFeedRequests.has(identity.key))) {
          invalidateTraversal("timeline-request-failed", identity, entry?.sequence ?? ++responseSequence);
        }
      } else if (!signal?.aborted && detailRequestMatches(identity, entry?.postKey || retryPostKey)) {
        recordDetailFailure(entry?.postKey || retryPostKey, identity, {}, entry?.sequence ?? ++responseSequence);
      }
      requestFinishedListener(request);
    };
    page.on("request", requestListener);
    page.on("requestfinished", requestFinishedListener);
    page.on("requestfailed", requestFailedListener);
    page.on("response", responseListener);
    const profileUrl = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
    const onTargetProfile = () => {
      try {
        const current = new URL(page.url());
        return ["instagram.com", "www.instagram.com"].includes(current.hostname.toLowerCase())
          && normalizeInstagramHandle(current.pathname.split("/").filter(Boolean)[0]).toLowerCase() === handle.toLowerCase()
          && current.pathname.split("/").filter(Boolean).length === 1;
      } catch { return false; }
    };
    const consumeProfileHtml = async (html, sequence) => {
      if (signal?.aborted) throw abortError();
      if (!onTargetProfile() || typeof html !== "string" || !html.trim()) return;
      let documents;
      try { documents = instagramTimelineDocuments(parseInstagramHtml(html), handle); }
      catch {
        countShape(apiFailures.candidate, "SSR 数据无法解析");
        return;
      }
      let changed = false;
      for (const document of documents) {
        const fingerprint = createHash("sha256").update(JSON.stringify([document.feedPayload, document.payload.errors || [],
          Boolean(document.payload.status === "fail" || document.payload.error || document.payload.error_type)])).digest("hex");
        if (profileSsrDocuments.has(fingerprint)) continue;
        if (profileSsrDocuments.size >= 64) { recordIssue({ reason: "timeline-ssr-document-limit" }); break; }
        profileSsrDocuments.set(fingerprint, document);
        changed = true;
      }
      if (!changed) return;
      const currentDocuments = [...profileSsrDocuments.values()];
      const parsed = extractInstagramTimeline(currentDocuments.map(document => document.feedPayload), handle, { requestedHandle: handle });
      // All SSR modules belong to this navigation's same first-page snapshot.
      // Their continuing/unknown cursors cannot be hidden by another terminal
      // module, and distinct modules are not distinct incremental page batches.
      const batches = parsed.timelineBatches;
      parsed.timelineBatches = batches.length ? [{ posts: [...new Map(batches.flatMap(batch => batch.posts)
        .map(post => [post.postKey, post])).values()], hasNextPage: parsed.hasNextPage,
        reliable: batches.every(batch => batch.reliable), endCursor: null }] : [];
      const graphqlIssues = currentDocuments.flatMap(document => instagramGraphQLIssues(document.payload, document.parsed,
        { operation: "ProfileTimelineSSR", scope: "timeline", roots: document.roots }));
      const hasApiError = currentDocuments.some(document => document.payload.status === "fail" || document.payload.error || document.payload.error_type);
      await consume({ request: () => null, status: () => 200, json: async () => hasApiError ? { status: "fail" } : {} }, {
        ssr: true, sequenceOverride: sequence, parsedOverride: parsed, graphqlIssuesOverride: graphqlIssues,
        identityOverride: { requestedHandle: handle, eligible: true, confirmedFeed: true,
          key: "ssr:profile-feed", operation: "ProfileTimelineSSR", firstPage: true },
      });
    };
    const captureProfileScripts = async () => {
      if (!onTargetProfile()) return;
      const html = await page.evaluate(() => Array.from(document.querySelectorAll('script[type="application/json"], script[data-sjs]'))
        .map((script) => script.outerHTML).join("\n")).catch(() => "");
      if (typeof html !== "string" || html === previousDomScripts) return;
      previousDomScripts = html;
      // DOM streaming may complete after API pagination has already arrived.
      // It is still the navigation's first-page snapshot, not a later cursor.
      await consumeProfileHtml(html, profileNavigationSequence);
    };
    const openProfile = async () => {
      if (signal?.aborted) throw abortError();
      profileNavigationSequence = ++responseSequence;
      previousDomScripts = "";
      profileSsrDocuments.clear();
      const response = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const status = response?.status();
      if (status === 429) throw new InstagramDiscoveryError("rate-limited", "Instagram 暂时限制访问频率，请稍后重试。");
      if (status === 403) throw new InstagramDiscoveryError("profile-http-error", "Instagram 主页访问被拒绝（HTTP 403），请检查当前网络与账号访问权限。");
      if (status === 404) throw new InstagramDiscoveryError("content-unavailable", "Instagram 目标主页不存在或当前不可访问（HTTP 404）。");
      if (status >= 400) throw new InstagramDiscoveryError("profile-http-error", `Instagram 主页请求失败（HTTP ${status}）。`);
      const failure = await visibleFailure(page);
      if (failure) throw failure;
      if (response?.text) {
        let timer;
        let abortListener;
        let html;
        try {
          html = await Promise.race([response.text().catch(() => ""), new Promise(resolve => {
            timer = setTimeout(() => resolve(""), Math.max(1_000, Math.min(3_000, responseWaitMs)));
          }), ...(signal ? [new Promise((_resolve, reject) => {
            abortListener = () => reject(abortError());
            signal.addEventListener("abort", abortListener, { once: true });
          })] : [])]);
        } finally {
          clearTimeout(timer);
          if (abortListener) signal.removeEventListener("abort", abortListener);
        }
        await consumeProfileHtml(html, profileNavigationSequence);
      }
      await captureProfileScripts();
    };
    const waitForTimeline = async (milliseconds) => {
      const deadline = Date.now() + Math.max(0, Number(milliseconds) || 0);
      do {
        if (signal?.aborted) throw abortError();
        await settleResponses(Math.min(responseWaitMs, Math.max(0, deadline - Date.now())));
        await captureProfileScripts();
        if (timelineResponses > 0) return true;
        const failure = await visibleFailure(page);
        if (failure) throw failure;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await page.waitForTimeout(Math.min(500, remaining));
      } while (true);
      return false;
    };
    await openProfile();
    if (!await waitForTimeline(timelineWaitMs)) {
      // Unrelated GraphQL responses can arrive while profile hydration stalls.
      // One bounded background navigation retries that load, not the login or
      // the media download; an unresolved feed still fails explicitly.
      await openProfile();
      if (!await waitForTimeline(retryTimelineWaitMs)) {
        const diagnostics = Object.entries(apiFailures).flatMap(([scope, counts]) => counts.size
          ? [`${scope === "target" ? "目标账号" : "候选"} API：${[...counts].map(([label, count]) => `${label} ×${count}`).join("、")}`] : []).join("；");
        const shapes = [responseOperations.size ? `响应操作：${[...responseOperations].map(([label, count]) => `${label} ×${count}`).join("、")}` : "",
          responseFeedRoots.size ? `响应结构：${[...responseFeedRoots].map(([label, count]) => `${label} ×${count}`).join("、")}` : ""].filter(Boolean).join("；");
        throw new InstagramDiscoveryError("timeline-unavailable", `未能读取 Instagram 时间线（匹配响应 ${matchedResponses} 个${invalidResponses ? `，其中 ${invalidResponses} 个无法解析` : ""}；已等待目标作品加载并静默重试一次${diagnostics ? `；${diagnostics}` : ""}${shapes ? `；${shapes}` : ""}）。`);
      }
    }
    const hydratedFailure = await visibleFailure(page);
    if (hydratedFailure) throw hydratedFailure;
    await publicationDates.capture(page);
    reachedEnd = timelineHasNextPage === false;

    let previousPostCount = posts.size;
    for (let scroll = 0; scroll < maxScrolls; scroll += 1) {
      if (signal?.aborted) throw abortError();
      await publicationDates.capture(page);
      if (boundary.reached) { reachedKnownBoundary = true; break; }
      if (reachedEnd) break;
      await page.mouse.wheel(0, 6_000);
      await page.waitForTimeout(scrollWaitMs);
      await settleResponses();
      await publicationDates.capture(page);
      const gainedPosts = posts.size > previousPostCount;
      previousPostCount = posts.size;
      consecutiveIdleScrolls = gainedPosts ? 0 : consecutiveIdleScrolls + 1;
      if (boundary.reached) {
        reachedKnownBoundary = true;
        break;
      }
      if (timelineHasNextPage === false) { reachedEnd = true; break; }
      if (consecutiveIdleScrolls >= 6) {
        // No response, an unknown cursor, and has_next_page=true all mean that
        // pagination stalled, never that every historical post was read.
        stopReason = timelineHasNextPage === true ? "pagination-stalled" : "pagination-unknown";
        break;
      }
    }
    await settleResponses();
    reachedEnd = timelineHasNextPage === false;
    reachedKnownBoundary = boundary.reached;
    if (!reachedEnd && !reachedKnownBoundary && !stopReason) stopReason = "scroll-limit";

    refreshingRetries = true;
    for (const postUrl of [...new Set(retryPosts)]) {
      if (signal?.aborted) throw abortError();
      const match = String(postUrl).match(/^https:\/\/(?:www\.)?instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)\//);
      if (!match || (posts.get(match[2])?.mediaComplete === true && !detailFailures.has(match[2]))) continue;
      const safePostUrl = `https://www.instagram.com/${match[1]}/${match[2]}/`;
      retryPostKey = match[2];
      const detailSequence = ++responseSequence;
      try {
        const navigation = await page.goto(safePostUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const status = navigation?.status?.();
        if (status >= 400) recordDetailFailure(retryPostKey, {}, { httpStatus: status }, detailSequence);
        else if (navigation?.text || page.content) {
          const payloads = [];
          if (navigation?.text) payloads.push(...parseInstagramHtml(await navigation.text()));
          if (page.content) payloads.push(...parseInstagramHtml(await page.content()));
          const documents = instagramDetailDocuments(payloads, handle, retryPostKey);
          const graphqlIssues = documents.flatMap((document) => instagramGraphQLIssues(document.payload, document.parsed,
            { operation: "PolarisPostRootQuery", scope: "detail", postKey: retryPostKey, roots: document.roots }));
          recordDetailIssues(retryPostKey, detailSequence, graphqlIssues);
          const parsed = extractInstagramTimeline(documents.map((document) => ({ data: Object.fromEntries(document.roots.map((root) =>
            [root, document.payload.data[root]])) })), handle);
          for (const post of parsed.posts.filter((post) => post.postKey === retryPostKey)) {
            const merged = coverage.observe(post, parsed.media.filter((item) => item.postKey === retryPostKey),
              parsed.unresolvedMedia.filter((entry) => entry.postKey === retryPostKey));
            posts.set(post.postKey, merged.post);
            if (merged.post.mediaComplete) unresolvedByPost.delete(post.postKey);
            else unresolvedByPost.set(post.postKey, merged.unresolvedMedia);
          }
          for (const item of parsed.media.filter((item) => item.postKey === retryPostKey)) media.set(item.logicalKey, item);
          for (const entry of parsed.parseIssues.filter((entry) => entry.postKey === retryPostKey)) recordIssue(entry);
          if (documents.length && !graphqlIssues.length && reliableDetailRecovery(retryPostKey, parsed)) {
            resolveDetailIssues(retryPostKey, detailSequence);
          }
        }
      } catch (error) {
        if (signal?.aborted) throw abortError();
        recordDetailFailure(retryPostKey, {}, {}, detailSequence);
      }
      await page.waitForTimeout(1_500);
      await settleResponses();
      await publicationDates.capture(page);
      if (!posts.has(match[2])) {
        const entry = { postKey: match[2], postId: match[2], postUrl: safePostUrl, reason: "retry-post-unavailable" };
        unresolvedByPost.set(match[2], [entry]);
        recordIssue(entry);
      }
    }
    await settleResponses();
    if (signal?.aborted) throw abortError();
    reachedEnd = timelineHasNextPage === false;
    reachedKnownBoundary = boundary.reached;
    const unresolvedMedia = [...unresolvedByPost.values()].flat();
    for (const postKey of detailFailures.keys()) {
      const post = posts.get(postKey);
      if (post) posts.set(postKey, { ...post, mediaComplete: false });
      unresolvedMedia.push({ postKey, postId: post?.postId || postKey, postUrl: post?.postUrl || `https://www.instagram.com/p/${postKey}/`,
        mediaExpectedCount: post?.mediaExpectedCount || knownPostCoverage[postKey]?.mediaExpectedCount || 0,
        mediaExpectedKeys: post?.mediaExpectedKeys || knownPostCoverage[postKey]?.mediaExpectedKeys || [], reason: "detail-refresh-unresolved" });
    }
    const remainingIssues = [...new Map([...parseIssues.values(), ...[...traversalFailures.values()].flatMap((entry) => entry.issues)]
      .filter((entry) => !entry.postKey || posts.get(entry.postKey)?.mediaComplete !== true)
      .concat([...detailFailures.values()].flatMap((entry) => entry.issues)).map((entry) => [issueKey(entry), entry])).values()];
    const rangeComplete = Boolean(headTraversalCaptured && (reachedEnd || reachedKnownBoundary) && !timelinePending.size && !traversalFailures.size);
    const complete = Boolean(rangeComplete && !pending.size && !unresolvedMedia.length && !remainingIssues.length);
    const incompleteReason = complete ? null : unresolvedMedia.length ? "media-unresolved"
      : traversalFailures.size || remainingIssues.length ? "timeline-unresolved" : pending.size ? "timeline-in-flight"
        : !headTraversalCaptured ? "timeline-head-unconfirmed" : stopReason || (timelineHasNextPage === true ? "pagination-stalled" : "pagination-unknown");
    return {
      posts: publicationDates.apply([...posts.values()]),
      media: publicationDates.apply([...media.values()]),
      complete,
      rangeComplete,
      headCaptured,
      headTraversalCaptured,
      completionReason: complete ? reachedEnd ? "terminal-page" : "known-boundary" : null,
      incompleteReason,
      parseIssues: remainingIssues,
      unresolvedMedia,
      reachedEnd,
      reachedKnownBoundary,
      timelineResponses,
    };
  } catch (error) {
    if (profileBusy(error)) throw new InstagramDiscoveryError("profile-busy", "Instagram 登录窗口仍在运行，请关闭后再同步。");
    throw error;
  } finally {
    if (page && responseListener) page.off("response", responseListener);
    if (page && requestListener) page.off("request", requestListener);
    if (page && requestFinishedListener) page.off("requestfinished", requestFinishedListener);
    if (page && requestFailedListener) page.off("requestfailed", requestFailedListener);
    for (const request of [...inFlightRequests.keys()]) requestFinishedListener(request);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
