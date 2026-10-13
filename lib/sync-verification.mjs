// Recent-range checkpoints do not prove that older history is complete.
// History diagnostics never schedule another traversal. A normal user-triggered
// sync resumes the latest captured range; full history is an explicit operation.
export const HISTORY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function legacyHistoryAttemptAt(scope, { version, verificationStartedAt } = {}) {
  if (scope.historyVerification || scope.completionVerificationRequired !== version) return null;
  const upgradeStarted = Date.parse(verificationStartedAt || "");
  const lastSync = Date.parse(scope.lastSyncAt || "");
  if (!Number.isFinite(upgradeStarted) || !Number.isFinite(lastSync) || lastSync < upgradeStarted) return null;
  // The first release forced a history check but did not save its timestamp.
  // Use its FIXED upgrade epoch, not lastSyncAt, which every incremental run
  // advances. Otherwise frequent manual syncs postpone history checks forever.
  const provenHistoryAttempt = scope.lastDiscovery?.scanMode === "history"
    ? Date.parse(scope.lastDiscovery.checkedAt || "") : NaN;
  return new Date(Number.isFinite(provenHistoryAttempt) ? provenHistoryAttempt : upgradeStarted).toISOString();
}

export function selectScopeScan(scope, { version, policyChanged = false, forceHistory = false } = {}) {
  const historyVerified = Boolean(scope.initialComplete && scope.completionVersion === version);
  // Merely seeing the newest page is not proof that the previous accessible
  // range was scanned. A head-only baseline cannot skip unknown older posts.
  const anchor = [scope.incrementalCheckpoint?.scanStartedAt, scope.scanCompletedAt,
    scope.lastSuccessfulSyncAt].find((value) => Number.isFinite(Date.parse(value || "")));
  const anchorValid = Number.isFinite(Date.parse(anchor || ""));
  const mode = forceHistory || policyChanged || !anchorValid ? "history" : "incremental";
  return { mode, historyVerified, since: mode === "incremental" && anchorValid ? anchor : null,
    allowKnownBoundary: mode === "incremental" && Object.keys(scope.knownPosts || {}).length > 0,
    reason: forceHistory ? "explicit-recheck" : policyChanged ? "media-policy-expanded" : !anchorValid ? "first-scan" : "last-range-checkpoint",
    nextHistoryCheckAt: null };
}

const code = (value, fallback) => typeof value === "string" && /^[a-z][a-z0-9-]{0,99}$/.test(value) ? value : fallback;
const issueCode = (value) => {
  const machineCode = code(value, null);
  if (machineCode) return machineCode;
  if (/GraphQL.*错误/i.test(String(value))) return "timeline-graphql-error";
  if (/网络(?:请求|错误)/.test(String(value))) return "timeline-network-error";
  if (/响应.*(?:读取|JSON).*失败/.test(String(value))) return "timeline-json-invalid";
  if (/访问失败/.test(String(value))) return "timeline-request-failed";
  if (/请求未完成/.test(String(value))) return "timeline-request-timeout";
  return "timeline-read-error";
};

export function blockingDiscoveryFailure(discovery) {
  const failure = (discovery.parseIssues || []).find((issue) => {
    const reason = typeof issue === "string" ? issue : issue?.reason;
    return typeof reason === "string" && (/^(?:timeline-http-\d+|timeline-http-failure|timeline-request-failed|timeline-request-failure|timeline-request-timeout|timeline-pending-timeout|timeline-network-error|timeline-api-error|timeline-graphql-error|graphql-error|timeline-json-invalid|timeline-parse-failure|page-http-failure|page-data-parse-failure|detail-refresh-failure)$/.test(reason)
      || /(?:网络(?:请求|错误)|访问失败|请求未完成|HTTP\s*\d{3}|响应.*(?:读取|JSON).*失败|GraphQL.*错误)/i.test(reason));
  });
  return failure ? issueCode(typeof failure === "string" ? failure : failure.reason) : null;
}

export function discoveryIssueSamples(discovery) {
  const issues = [...(discovery.parseIssues || [])];
  // Actual access/transport failures must not be displaced by old album gaps.
  issues.sort((a, b) => Number(Boolean(blockingDiscoveryFailure({ parseIssues: [b] })))
    - Number(Boolean(blockingDiscoveryFailure({ parseIssues: [a] }))));
  return issues.slice(0, 10).map((issue) => {
    const item = typeof issue === "object" && issue ? issue : {};
    const sample = { reason: issueCode(typeof issue === "string" ? issue : item.reason) };
    if (typeof item.postKey === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.postKey)) sample.postId = item.postKey;
    if (typeof item.operation === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.operation)) sample.operation = item.operation;
    if (["timeline", "feed", "detail", "metadata"].includes(item.scope)) sample.scope = item.scope;
    if (Number.isSafeInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599) sample.httpStatus = item.httpStatus;
    if (Number.isSafeInteger(item.graphqlCode) || (typeof item.graphqlCode === "string"
      && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.graphqlCode))) sample.graphqlCode = item.graphqlCode;
    if (Array.isArray(item.fieldPath) && item.fieldPath.length <= 20 && item.fieldPath.every((part) =>
      (Number.isSafeInteger(part) && part >= 0 && part <= 100_000)
      || (typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(part)))) sample.fieldPath = item.fieldPath;
    return sample;
  });
}

export function discoveryFailureMessage(discovery, failureCode = blockingDiscoveryFailure(discovery)) {
  const sample = discoveryIssueSamples(discovery).find((item) => blockingDiscoveryFailure({ parseIssues: [item] }));
  const detail = sample?.scope === "detail" || sample?.postId;
  const clues = [failureCode, sample?.operation && `接口 ${sample.operation}`,
    sample?.postId && `帖子 ${sample.postId}`, sample?.fieldPath?.length && `字段 ${sample.fieldPath.join(".")}`,
    sample?.graphqlCode !== undefined && `错误码 ${sample.graphqlCode}`, sample?.httpStatus && `HTTP ${sample.httpStatus}`].filter(Boolean);
  return `${detail ? "单帖或附件" : "时间线或分页"}读取失败${clues.length ? `（${clues.join("；")}）` : ""}；已保存文件保留，未将未确认范围标记为完成。`;
}

function publicPostUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    // Only known platforms' public post permalinks, never signed media URLs,
    // credentials, arbitrary hosts, local addresses, or tracker query strings.
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname;
    if (["x.com", "twitter.com"].includes(host) && /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(path) && !url.search) return url.href;
    if (host === "instagram.com" && /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(path) && !url.search) return url.href;
    if (host === "tiktok.com" && /^\/@[A-Za-z0-9_.]+\/(?:video|photo)\/\d+\/?$/.test(path) && !url.search) return url.href;
    if (host === "facebook.com" && /^\/(?:[A-Za-z0-9_.-]+\/(?:posts|videos)\/[A-Za-z0-9_.-]+|(?:permalink|story|photo)\.php|photo)\/?$/.test(path)
      && [...url.searchParams].every(([key, item]) => ["id", "story_fbid", "fbid"].includes(key) && /^\d+$/.test(item))) return url.href;
  } catch {}
  return null;
}

export function discoveryDiagnostics(discovery, { scanMode, checkedAt, pendingPosts = {}, availableMediaKeys = [] } = {}) {
  const identified = new Set([...availableMediaKeys, ...(discovery.media || []).map((item) => item.logicalKey)]);
  const reasons = [...new Set((discovery.parseIssues || []).map((item) =>
    issueCode(typeof item === "string" ? item : item?.reason)))].slice(0, 30);
  return {
    version: 1, checkedAt, scanMode,
    reachedEnd: discovery.reachedEnd === true,
    reachedKnownBoundary: discovery.reachedKnownBoundary === true,
    rangeComplete: discovery.rangeComplete === true || discovery.complete === true,
    completionReason: code(discovery.completionReason, null),
    rangeCompletionReason: code(discovery.rangeCompletionReason || discovery.completionReason, null),
    incompleteReason: code(discovery.incompleteReason, discovery.complete ? null : "timeline-unconfirmed"),
    parseIssueCodes: reasons,
    parseIssueSamples: discoveryIssueSamples(discovery),
    pendingPostCount: Object.keys(pendingPosts).length,
    attachmentGapCount: Object.values(pendingPosts).filter((item) => item.mediaExpectedCount > 0 || item.mediaExpectedKeys?.length).length,
    // Public post identifiers only. Never persist response bodies, headers,
    // cookies, signed media URLs, profile directories or browser diagnostics.
    pendingPostSamples: Object.values(pendingPosts).slice(0, 10).map((item) => {
      const keys = Array.isArray(item.mediaExpectedKeys) ? [...new Set(item.mediaExpectedKeys)] : [];
      return {
        postId: String(item.postId || item.postKey || "").slice(0, 128),
        postUrl: publicPostUrl(item.postUrl),
        reason: code(item.reason, "media-incomplete"),
        expectedCount: Number.isSafeInteger(item.mediaExpectedCount) ? item.mediaExpectedCount : 0,
        knownCount: keys.length ? keys.filter((key) => identified.has(key)).length : null,
      };
    }),
  };
}

export function normalizeSyncSummary(saved) {
  if (!saved) return saved;
  const summary = structuredClone(saved);
  const legacyWarnings = (summary.errors || []).filter((item) => item.code === "timeline-incomplete");
  summary.counters ||= {};
  if (legacyWarnings.length) {
    summary.errors = (summary.errors || []).filter((item) => item.code !== "timeline-incomplete");
    summary.warnings = [...(summary.warnings || []), ...legacyWarnings.map((item) => ({ ...item, category: "verification" }))];
    summary.counters.failed = Math.max(0, Number(summary.counters.failed || 0) - legacyWarnings.length);
    summary.counters.warnings = Number(summary.counters.warnings || 0) + legacyWarnings.length;
  }
  const realFailures = Math.max(Number(summary.counters.failed || 0), (summary.errors || []).length);
  summary.operationStatus = summary.status === "failed" ? "failed" : realFailures ? "partial"
    : summary.status === "completed" ? "synced" : summary.status;
  if (summary.status === "completed") {
    summary.message = realFailures
      ? `本轮同步已结束；有 ${realFailures} 项失败，可再次增量同步重试，已保存文件保留。`
      : "本轮可读取媒体已同步，后续按已保存增量节点继续。";
  }
  return summary;
}
