import test from "node:test";
import assert from "node:assert/strict";
import { selectScopeScan, discoveryDiagnostics, discoveryFailureMessage, normalizeSyncSummary, blockingDiscoveryFailure, HISTORY_CHECK_INTERVAL_MS } from "../lib/sync-verification.mjs";

const now = Date.parse("2026-10-05T14:00:00Z");
const prior = "2026-10-05T13:00:00Z";
const scope = () => ({ knownPosts: { old: prior }, initialComplete: false, completionVerificationRequired: 1,
  scanCompletedAt: prior, historyVerification: { lastAttemptAt: prior, status: "pending" } });

test("unverified older history does not force every recent sync into a full scan", () => {
  const plan = selectScopeScan(scope(), { version: 1, now });
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.allowKnownBoundary, true);
  assert.equal(plan.historyVerified, false);
  assert.equal(plan.since, prior);
});

test("pending album metadata does not disable a reliable daily known boundary", () => {
  const s = scope(); s.pendingPosts = { album: { mediaExpectedCount: 3 } };
  assert.equal(selectScopeScan(s, { version: 1, now }).allowKnownBoundary, true);
});

test("only first run or explicit newly enabled media scope requires history traversal", () => {
  assert.equal(selectScopeScan({ knownPosts: {} }, { version: 1, now }).mode, "history");
  assert.equal(selectScopeScan(scope(), { version: 1, now, policyChanged: true }).mode, "history");
  assert.equal(selectScopeScan(scope(), { version: 1, now: Date.parse(prior) + HISTORY_CHECK_INTERVAL_MS }).mode, "incremental");
});

test("a captured head alone cannot skip unknown first-scan history", () => {
  const s = scope(); delete s.scanCompletedAt; s.incrementalBaselineAt = prior;
  assert.equal(selectScopeScan(s, { version: 1, now }).mode, "history");
  assert.equal(s.initialComplete, false);
  assert.equal(s.scanCompletedAt, undefined);
});

test("the prior release's completed history attempt is recognized without changing its flags", () => {
  const s = scope(); delete s.historyVerification; s.lastSyncAt = prior;
  const plan = selectScopeScan(s, { version: 1, now, verificationStartedAt: "2026-10-05T12:00:00Z" });
  assert.equal(plan.mode, "incremental");
  assert.equal(s.initialComplete, false);
  assert.equal(selectScopeScan(s, { version: 1, now, verificationStartedAt: "2026-10-05T13:30:00Z" }).mode, "incremental");
});

test("legacy completion flags and elapsed days never schedule history checks during ordinary incremental sync", () => {
  const s = scope(); delete s.historyVerification;
  const started = "2026-10-05T12:00:00Z";
  for (const hours of [1, 12, 21, 25, 42]) {
    const at = Date.parse(started) + hours * 60 * 60 * 1000;
    s.lastSyncAt = new Date(at - 30_000).toISOString();
    const plan = selectScopeScan(s, { version: 1, now: at, verificationStartedAt: started });
    assert.equal(plan.mode, "incremental");
    assert.equal(plan.nextHistoryCheckAt, null);
  }
});

test("verified history uses a recent checkpoint even with old unresolved attachments", () => {
  const s = { ...scope(), initialComplete: true, completionVersion: 1, incrementalCheckpoint: { scanStartedAt: prior } };
  assert.equal(selectScopeScan(s, { version: 1, now: now + 7 * HISTORY_CHECK_INTERVAL_MS }).mode, "incremental");
});

test("explicit complete recheck bypasses the interval and clears only discovery cutoff options", () => {
  for (const verified of [false, true]) {
    const s = { ...scope(), initialComplete: verified, completionVersion: verified ? 1 : undefined };
    const before = structuredClone(s);
    const plan = selectScopeScan(s, { version: 1, now, forceHistory: true });
    assert.equal(plan.mode, "history");
    assert.equal(plan.allowKnownBoundary, false);
    assert.equal(plan.since, null);
    assert.equal(plan.historyVerified, verified);
    assert.deepEqual(s, before, "manual recheck must not reset historical state");
  }
});

test("attachment diagnostics expose bounded public post links and actual identified attachment counts", () => {
  const d = discoveryDiagnostics({ media: [{ logicalKey: "album:2" }] }, {
    availableMediaKeys: ["album:1"], pendingPosts: {
      album: { postId: "ABCdef123", postUrl: "https://www.instagram.com/p/ABCdef123/", mediaExpectedCount: 3,
        mediaExpectedKeys: ["album:1", "album:2", "album:3"] },
      unsafe: { postId: "unsafe", postUrl: "https://127.0.0.1/private?token=secret", mediaExpectedCount: 1 },
      query: { postId: "query", postUrl: "https://www.instagram.com/p/ABC/?token=secret" },
      media: { postId: "media", postUrl: "https://video.tiktokcdn.com/private.mp4?token=secret" },
    },
  });
  assert.equal(d.pendingPostSamples[0].postUrl, "https://www.instagram.com/p/ABCdef123/");
  assert.equal(d.pendingPostSamples[0].expectedCount, 3);
  assert.equal(d.pendingPostSamples[0].knownCount, 2);
  for (const entry of d.pendingPostSamples.slice(1)) {
    assert.equal(entry.postUrl, null);
    assert.equal(entry.knownCount, null);
  }
  assert.doesNotMatch(JSON.stringify(d), /127\.0\.0\.1|token|secret|tiktokcdn/);
});

test("legacy receipts separate incomplete warnings without mutating persisted summaries", () => {
  const original = { status: "completed", counters: { failed: 2 }, errors: [
    { code: "timeline-incomplete", message: "pending" }, { code: "download-error", message: "404" } ] };
  const normalized = normalizeSyncSummary(original);
  assert.equal(normalized.counters.failed, 1);
  assert.equal(normalized.counters.warnings, 1);
  assert.deepEqual(normalized.errors.map(i => i.code), ["download-error"]);
  assert.deepEqual(original.counters, { failed: 2 });
  assert.match(normalized.message, /1 项失败/);
  assert.doesNotMatch(normalized.message, /待检查/);
  assert.equal(normalized.operationStatus, "partial");
  assert.equal(normalizeSyncSummary(normalized).counters.warnings, 1);
});

test("the proven scan-start checkpoint takes precedence over later finish time and head-only baseline", () => {
  const s = { ...scope(), incrementalCheckpoint: { scanStartedAt: prior, verifiedAt: "2026-10-05T13:59:00Z" },
    incrementalBaselineAt: "2026-10-05T12:00:00Z", lastSuccessfulSyncAt: "2026-10-05T13:59:00Z" };
  const plan = selectScopeScan(s, { version: 42, now: now + 200 * HISTORY_CHECK_INTERVAL_MS });
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.since, prior);
  assert.equal(plan.reason, "last-range-checkpoint");
});

test("old incomplete-only summaries become ordinary synced receipts without changing diagnostic records", () => {
  const original = { status: "completed", counters: { failed: 0, warnings: 2 }, warnings: [
    { code: "history-verification-pending", category: "history" }, { code: "timeline-incomplete", category: "attachments" } ] };
  const normalized = normalizeSyncSummary(original);
  assert.equal(normalized.operationStatus, "synced");
  assert.doesNotMatch(normalized.message, /待检查|完整同步/);
  assert.deepEqual(normalized.warnings, original.warnings);
  assert.equal(original.message, undefined);
});

test("machine diagnostics persist only bounded codes and public post identifiers", () => {
  const d = discoveryDiagnostics({ reachedEnd: true, rangeComplete: true,
    cookies: "secret", profileDirectory: "private", parseIssues: [{ reason: "attachment-missing", postKey: "p", sourceUrl: "secret-url" }],
    incompleteReason: "https://private.example/?token=secret", completionReason: "terminal-page" },
  { scanMode: "history", checkedAt: prior, pendingPosts: { p: { postId: "p", mediaExpectedCount: 3, reason: "attachment-missing", sourceUrl: "secret-url" } } });
  assert.equal(d.pendingPostCount, 1);
  assert.deepEqual(d.parseIssueCodes, ["attachment-missing"]);
  assert.doesNotMatch(JSON.stringify(d), /secret|private|cookies|profileDirectory/);
});

test("real request/HTTP failures remain failures, unlike unconfirmed boundaries or attachment gaps", () => {
  assert.equal(blockingDiscoveryFailure({ parseIssues: [{ reason: "timeline-http-403" }] }), "timeline-http-403");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["graphql-error"] }), "graphql-error");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["X 时间线响应读取或 JSON 解析失败。"] }), "timeline-json-invalid");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["X 响应包含未恢复的 GraphQL 错误。"] }), "timeline-graphql-error");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["X 时间线请求发生未恢复的网络错误。"] }), "timeline-network-error");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["TikTok 作品列表请求未完成。"] }), "timeline-request-timeout");
  assert.equal(blockingDiscoveryFailure({ parseIssues: [{ reason: "attachment-missing", postKey: "p" }] }), null);
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["timeline-pending-timeout"] }), "timeline-pending-timeout");
  assert.equal(blockingDiscoveryFailure({ parseIssues: ["unconfirmed-pagination"] }), null);
});

test("safe error samples identify the failed operation and field without persisting raw server details", () => {
  const discovery = { parseIssues: [
    ...Array.from({ length: 20 }, (_, i) => ({ reason: "attachment-missing", postKey: `post${i}` })),
    { reason: "timeline-graphql-error", operation: "PolarisProfilePostsTabContentQuery_connection", scope: "timeline",
      graphqlCode: "FORBIDDEN", httpStatus: 200, fieldPath: ["feed", "edges", 3, "node", "media"],
      message: "private-token", response: "secret-cookie", url: "https://secret/?token=private" },
    { reason: "timeline-http-403", operation: "https://secret/?token=private", fieldPath: ["https://private/?token=secret"] },
  ] };
  const d = discoveryDiagnostics(discovery);
  assert.equal(d.parseIssueSamples[0].reason, "timeline-graphql-error");
  assert.equal(d.parseIssueSamples[0].operation, "PolarisProfilePostsTabContentQuery_connection");
  assert.deepEqual(d.parseIssueSamples[0].fieldPath, ["feed", "edges", 3, "node", "media"]);
  assert.equal(d.parseIssueSamples[1].operation, undefined);
  assert.equal(d.parseIssueSamples[1].fieldPath, undefined);
  assert.doesNotMatch(JSON.stringify(d), /private|secret|token|cookie|response/);
  const message = discoveryFailureMessage(discovery);
  assert.match(message, /时间线或分页读取失败/);
  assert.match(message, /feed\.edges\.3\.node\.media/);
  assert.match(message, /FORBIDDEN/);
  assert.doesNotMatch(message, /private|secret/);
});

test("detail failures identify the affected public post rather than claiming all recent posts failed", () => {
  assert.match(discoveryFailureMessage({ parseIssues: [
    { reason: "detail-refresh-failure", scope: "detail", postKey: "public-post" },
  ] }), /单帖或附件读取失败.*帖子 public-post/);
});
