import path from "node:path";

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED_ROUTES = new Set(["home", "explore", "notifications", "messages", "i", "settings", "search"]);

export function normalizeXHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "");
  if (!HANDLE_PATTERN.test(handle) || RESERVED_ROUTES.has(handle.toLowerCase())) return "";
  return handle;
}

export function resolveXHandle(account = {}) {
  const profileUrl = String(account.profileUrl || "").trim();
  if (profileUrl) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(profileUrl) ? profileUrl : `https://${profileUrl}`);
      if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(parsed.hostname.toLowerCase())) {
        const candidate = normalizeXHandle(parsed.pathname.split("/").filter(Boolean)[0]);
        if (candidate) return candidate;
      }
    } catch {}
  }
  return normalizeXHandle(account.label);
}

function tweetResult(value) {
  if (value?.__typename === "TweetWithVisibilityResults") return value.tweet;
  if (value?.tweet?.rest_id && value?.tweet?.legacy) return value.tweet;
  return value;
}

function authorHandle(tweet) {
  const user = tweet?.core?.user_results?.result;
  return normalizeXHandle(user?.core?.screen_name || user?.legacy?.screen_name);
}

function originalPhotoUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.searchParams.set("name", "orig");
    return parsed.href;
  } catch {
    return value;
  }
}

function mp4Variants(media) {
  const seen = new Set();
  return (Array.isArray(media?.video_info?.variants) ? media.video_info.variants : [])
    .filter((variant) => variant?.content_type === "video/mp4" && variant?.url)
    .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
    .filter((variant) => {
      if (seen.has(variant.url)) return false;
      seen.add(variant.url);
      return true;
    })
    .map((variant) => ({ sourceUrl: variant.url, bitrate: Number(variant.bitrate || 0) }));
}

function extensionFromUrl(value, fallback) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension;
  } catch {}
  return fallback;
}

function mapMedia(tweet, handle, unresolved) {
  const postId = String(tweet.rest_id);
  const createdAt = Number.isNaN(Date.parse(tweet.legacy?.created_at))
    ? null
    : new Date(tweet.legacy.created_at).toISOString();
  const extended = tweet.legacy?.extended_entities?.media;
  const previews = tweet.legacy?.entities?.media;
  const items = Array.isArray(extended) ? extended : Array.isArray(previews) ? previews : [];
  const postUrl = `https://x.com/${handle}/status/${postId}`;
  if ((extended != null && !Array.isArray(extended))
    || (Array.isArray(previews) && previews.length > 0 && (!Array.isArray(extended) || extended.length < previews.length))) {
    unresolved.push({ postKey: postId, postId, postUrl, reason: "帖子的完整附件信息尚未加载。" });
  }
  const declaredCount = Number(tweet.legacy?.media_count ?? tweet.media_count ?? 0);
  if (Number.isFinite(declaredCount) && declaredCount > items.length) {
    unresolved.push({ postKey: postId, postId, postUrl, reason: "实际解析附件数少于帖子声明的附件数。" });
  }
  return items.flatMap((media, index) => {
    const position = index + 1;
    const common = {
      platformId: "x",
      postId,
      postKey: postId,
      logicalKey: `${postId}:${position}`,
      mediaIndex: position,
      handle,
      createdAt,
      sensitive: Boolean(tweet.legacy?.possibly_sensitive),
      postUrl,
    };

    if (media?.type === "photo" && media.media_url_https) {
      const sourceUrl = originalPhotoUrl(media.media_url_https);
      return [{ ...common, kind: "image", sourceUrl, extension: extensionFromUrl(sourceUrl, ".jpg") }];
    }

    if (["video", "animated_gif"].includes(media?.type)) {
      const variants = mp4Variants(media);
      const variant = variants[0];
      if (!variant) {
        unresolved.push({ postKey: postId, postId, logicalKey: common.logicalKey, mediaIndex: position,
          postUrl, kind: media.type === "animated_gif" ? "gif" : "video", reason: "视频的可下载 MP4 地址尚未解析。" });
        return [];
      }
      return [{
        ...common,
        kind: media.type === "animated_gif" ? "gif" : "video",
        sourceUrl: variant.sourceUrl,
        variants,
        extension: ".mp4",
        bitrate: Number(variant.bitrate || 0),
      }];
    }
    unresolved.push({ postKey: postId, postId, logicalKey: common.logicalKey, mediaIndex: position,
      postUrl, ...(media?.type === "photo" ? { kind: "image" } : {}), reason: media?.type === "photo" ? "图片下载地址尚未解析。" : "附件类型未知或信息尚未加载。" });
    return [];
  });
}

// Read embedded JSON without executing any page-provided JavaScript. Balanced
// objects are needed because INITIAL_STATE is often followed by more scripts.
export function parseXInitialState(html, { onIssue = () => {} } = {}) {
  const payloads = [];
  const parse = (text, required = false) => {
    try { payloads.push(JSON.parse(text)); }
    catch { if (required) onIssue("X 首屏内嵌状态包含无法解析的 JSON。"); }
  };
  for (const match of String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attributes, source] = match;
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']|\bid\s*=\s*["']__NEXT_DATA__["']/i.test(attributes)) {
      parse(source.trim(), /\btype\s*=\s*["']application\/json["']|\bid\s*=\s*["']__NEXT_DATA__["']/i.test(attributes));
    }
    const assignment = /(?:\bwindow\s*\.\s*|\bglobalThis\s*\.\s*)?__INITIAL_STATE__\s*=\s*/g;
    let assignmentMatch;
    while ((assignmentMatch = assignment.exec(source))) {
      const start = assignment.lastIndex;
      if (source[start] !== "{" && source[start] !== "[") {
        onIssue("X 首屏内嵌状态不是可安全解析的 JSON。");
        continue;
      }
      let depth = 0, inString = false, escaped = false;
      let closed = false;
      for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{" || character === "[") depth += 1;
        else if (character === "}" || character === "]") depth -= 1;
        if (!depth) { parse(source.slice(start, index + 1), true); assignment.lastIndex = index + 1; closed = true; break; }
      }
      if (!closed) onIssue("X 首屏内嵌 JSON 数据不完整。");
    }
  }
  return payloads;
}

function hydratedTweets(payload) {
  const entities = payload?.entities;
  const tweets = entities?.tweets?.entities || entities?.tweets;
  const users = entities?.users?.entities || entities?.users;
  if (!tweets || typeof tweets !== "object") return [];
  return Object.entries(tweets).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    if (value.rest_id && value.legacy) return [value];
    if (!value.id_str && !value.created_at && !value.extended_entities) return [];
    const user = value.user || users?.[value.user_id_str || value.user_id];
    const userResult = user?.legacy || user?.core ? user : { legacy: user || {} };
    return [{ __typename: "Tweet", rest_id: value.id_str || id, legacy: value,
      core: value.core || { user_results: { result: { ...userResult,
        rest_id: user?.rest_id || user?.id_str || value.user_id_str || value.user_id } } } }];
  });
}

function scopedTimeline(payload) {
  const user = payload?.data?.user?.result;
  const timeline = [user?.timeline_v2?.timeline, user?.timeline?.timeline, user?.timeline,
    user?.timeline_response?.timeline, user?.timeline_response].find((value) => Array.isArray(value?.instructions));
  const pagination = { bottomCursorSeen: false, bottomCursor: null, endConfirmed: false };
  for (const instruction of timeline?.instructions || []) {
    if (instruction?.type === "TimelineTerminateTimeline" && String(instruction.direction).toLowerCase() === "bottom") pagination.endConfirmed = true;
    const entries = instruction?.type === "TimelineAddEntries" ? instruction.entries
      : instruction?.type === "TimelineReplaceEntry" ? [instruction.entry] : [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const content = entry?.content;
      if (String(content?.cursorType || "").toLowerCase() !== "bottom") continue;
      pagination.bottomCursorSeen = true;
      pagination.bottomCursor = typeof content.value === "string" ? content.value : null;
      // A bottom-termination instruction is authoritative for this response.
      // The same page can retain its opaque cursor for UI state afterwards.
      pagination.endConfirmed ||= content.value === "";
    }
  }
  return { present: Boolean(timeline), ownerId: String(user?.rest_id || user?.id_str || ""),
    ownerHandle: normalizeXHandle(user?.core?.screen_name || user?.legacy?.screen_name), pagination };
}

function unavailableObservation(result, postId, targetHandle) {
  if (!postId || !/^Tweet(?:Unavailable|Tombstone)$/.test(String(result?.__typename || ""))) return null;
  // Do not infer deletion from an empty wrapper, a nested quote, or a generic
  // access restriction. Only the platform's explicit unavailable/deleted marker
  // can resolve a zero-expectation observation; prior positive coverage is kept
  // by the sync store and no archived asset or source is removed.
  const marker = String(result.reason || result.reason_code || result.reasonCode || "");
  const text = [result.message, result.reason_message, result.tombstone?.text?.text,
    result.tombstone?.text, result.text?.text, result.unavailable_message?.text]
    .filter((value) => typeof value === "string").join(" ").slice(0, 1000);
  const deleted = /^(?:Deleted|TweetDeleted|PostDeleted|NotFound|TweetNotFound|PostNotFound)$/i.test(marker)
    || /\b(?:this|the) (?:tweet|post) (?:was|has been|is) deleted\b|\bdeleted by (?:the )?(?:tweet|post) author\b|(?:此|该)(?:推文|帖子|贴文).{0,8}(?:已删除|被删除)/i.test(text);
  const unavailable = /^(?:Unavailable|TweetUnavailable|PostUnavailable)$/i.test(marker)
    || /\bthis (?:tweet|post) is unavailable\b|(?:此|该)(?:推文|帖子|贴文)(?:不可用|已不可用)/i.test(text);
  if (!deleted && !unavailable) return null;
  return {
    postKey: postId, postId, postUrl: `https://x.com/${targetHandle}/status/${postId}`,
    reasonCode: deleted ? "post-deleted" : "post-unavailable",
    reason: deleted ? "平台明确标记此帖子已删除或不存在；保留此前已采集的文件及来源。"
      : "平台明确标记此帖子不可用；保留此前已采集的文件及来源。",
    mediaComplete: true, mediaExpectedCount: 0, mediaExpectedKeys: [], mediaReportedCount: 0,
    createdAt: null, pinned: false,
  };
}

function isRepostEntry(value) {
  const context = String(value?.socialContext?.contextType || value?.socialContext?.type || "");
  return /(?:retweet|repost)/i.test(context);
}

export function extractXTimeline(payload, targetHandle, { expectedPostIds = [], requestedPostId = null } = {}) {
  const normalizedTarget = normalizeXHandle(targetHandle).toLowerCase();
  if (!normalizedTarget) throw new Error("X 账号名称无效。");

  const seenObjects = new WeakSet();
  const posts = new Map();
  const media = new Map();
  const parsedMediaKeys = new Map();
  const unresolved = new Map();
  const resolvedPostIds = new Set();
  const unavailablePosts = new Map();
  const emptyRootPostIds = new Set();
  const expectedTargetPosts = new Set(expectedPostIds.map(String));
  if (requestedPostId) expectedTargetPosts.add(String(requestedPostId));
  const targetUserIds = new Set();
  let recognized = false;
  const pagination = { bottomCursorSeen: false, bottomCursor: null, endConfirmed: false };

  const visit = (value, inheritedPinned = false, inheritedEntry = null, insideTweet = false) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    const candidateHandle = normalizeXHandle(value.core?.screen_name || value.legacy?.screen_name || value.screen_name);
    const candidateId = value.rest_id || value.id_str;
    if (candidateId && candidateHandle.toLowerCase() === normalizedTarget) targetUserIds.add(String(candidateId));
    const instruction = value.type || value.__typename;
    const ownEntryId = String(value.entryId || "").match(/^(?:tweet|profile-conversation)-(\d+)/)?.[1];
    const entry = ownEntryId ? { postId: ownEntryId, repost: false } : inheritedEntry;
    const entryPostId = entry?.postId || "";
    const repost = Boolean(entry?.repost || isRepostEntry(value));
    const pinned = inheritedPinned || instruction === "TimelinePinEntry" || value.is_pinned === true
      || value.socialContext?.contextType === "Pin" || value.socialContext?.contextType === "Pinned";
    if (Array.isArray(value.instructions) || /^Timeline(?:AddEntries|AddToModule|ReplaceEntry|PinEntry|TerminateTimeline)$/.test(instruction || "")) recognized = true;
    if (instruction === "TimelineTerminateTimeline" && String(value.direction || "").toLowerCase() === "bottom") pagination.endConfirmed = true;
    if (String(value.cursorType || "").toLowerCase() === "bottom") {
      pagination.bottomCursorSeen = true;
      pagination.bottomCursor = typeof value.value === "string" ? value.value : null;
      // Absent/opaque cursors and an empty entries array are never proof of end.
      pagination.endConfirmed ||= value.value === "";
    }
    const tweet = tweetResult(value);
    const handle = authorHandle(tweet);
    const postId = String(tweet?.rest_id || "");
    const tweetNode = /^Tweet(?:WithVisibilityResults)?$/.test(String(tweet?.__typename || ""));
    const authorId = String(tweet?.core?.user_results?.result?.rest_id || tweet?.legacy?.user_id_str || "");
    const expectedTarget = handle.toLowerCase() === normalizedTarget
      || Boolean(!handle && authorId && targetUserIds.has(authorId))
      || Boolean(expectedTargetPosts.has(postId || entryPostId) && !handle && !repost);
    if (!insideTweet && postId && tweetNode && expectedTarget && (!tweet.legacy || !handle)
      && !posts.get(postId)?.mediaComplete) {
      unresolved.set(`${postId}:post`, { postKey: postId, postId, postUrl: `https://x.com/${targetHandle}/status/${postId}`, reason: "帖子正文或发布者信息尚未加载。" });
    }
    const rootResult = value.tweet_results ? tweetResult(value.tweet_results.result) : value;
    if (!insideTweet && entryPostId && value.itemType === "TimelineTweet" && value.tweet_results
      && (!value.tweet_results.result || (typeof value.tweet_results.result === "object"
        && Object.keys(value.tweet_results.result).length === 0))) emptyRootPostIds.add(entryPostId);
    if (!insideTweet && entryPostId && (value.tweet_results || value.itemType === "TimelineTweet"
      || /^Tweet(?:Unavailable|Tombstone)$/.test(String(value.__typename || "")))) {
      const unavailable = unavailableObservation(rootResult, entryPostId, targetHandle);
      if (unavailable) {
        unavailablePosts.set(entryPostId, { ...unavailable, pinned });
        resolvedPostIds.add(entryPostId);
        for (const [key, item] of unresolved) if (item.postId === entryPostId) unresolved.delete(key);
      } else if (!repost && expectedTargetPosts.has(entryPostId) && !rootResult?.rest_id && !posts.get(entryPostId)?.mediaComplete) {
        // An authorless unavailable entry might be a repost. Treat it as a
        // target gap only with independent target-post evidence (known record,
        // target permalink seen in the DOM, or the requested detail identity).
        unresolved.set(`${entryPostId}:post`, { postKey: entryPostId, postId: entryPostId,
          postUrl: `https://x.com/${targetHandle}/status/${entryPostId}`, reason: "目标帖子的正文或附件信息尚未完整加载。" });
      }
    }
    if (!insideTweet && postId && tweet?.legacy && handle) resolvedPostIds.add(postId);
    if (!insideTweet && postId && tweet?.legacy && handle.toLowerCase() === normalizedTarget) {
      unavailablePosts.delete(postId);
      const missing = [];
      const items = mapMedia(tweet, handle, missing);
      const previous = posts.get(postId);
      const extended = tweet.legacy.extended_entities?.media;
      const previews = tweet.legacy.entities?.media;
      const reportedCount = Array.isArray(extended) ? extended.length : Array.isArray(previews) ? previews.length : 0;
      const declaredCount = Number(tweet.legacy.media_count ?? tweet.media_count ?? 0);
      const mediaExpectedCount = Math.max(previous?.mediaExpectedCount || 0, reportedCount,
        Array.isArray(previews) ? previews.length : 0, Number.isInteger(declaredCount) && declaredCount > 0 ? declaredCount : 0);
      const references = Array.isArray(extended) ? extended : Array.isArray(previews) ? previews : [];
      const mediaExpectedKeys = [...new Set([...(previous?.mediaExpectedKeys || []), ...references.flatMap((item, index) =>
        ["photo", "video", "animated_gif"].includes(item?.type) ? [`${postId}:${index + 1}`] : [])])];
      for (const item of items) {
        media.set(item.logicalKey, item);
        if (!parsedMediaKeys.has(postId)) parsedMediaKeys.set(postId, new Set());
        parsedMediaKeys.get(postId).add(item.logicalKey);
      }
      if (reportedCount < mediaExpectedCount) missing.push({ postKey: postId, postId,
        postUrl: `https://x.com/${handle}/status/${postId}`, reason: "附件数量少于此前已观察到的数量，仍需补全。" });
      // A payload can contain several versions of one tweet. Preserve larger
      // expectations even after a smaller version was previously complete;
      // conversely, an earlier complete full version proves later missing URLs.
      const fullVersionProved = (!missing.length && reportedCount >= mediaExpectedCount)
        || (previous?.mediaComplete && previous.mediaExpectedCount >= mediaExpectedCount);
      for (const [key, item] of unresolved) {
        if (item.postId === postId && (fullVersionProved || media.has(key))) unresolved.delete(key);
      }
      if (!fullVersionProved) for (const item of missing) {
        if (item.logicalKey && media.has(item.logicalKey)) continue;
        unresolved.set(item.logicalKey || `${postId}:post`, item);
      }
      const mediaComplete = ![...unresolved.values()].some((item) => item.postId === postId)
        && (parsedMediaKeys.get(postId)?.size || 0) >= mediaExpectedCount;
      const post = {
        postKey: postId,
        postId,
        handle,
        pinned: pinned || tweet.legacy.is_pinned === true || previous?.pinned === true,
        mediaComplete,
        mediaExpectedCount,
        mediaExpectedKeys,
        mediaReportedCount: reportedCount,
        postUrl: `https://x.com/${handle}/status/${postId}`,
        createdAt: Number.isNaN(Date.parse(tweet.legacy.created_at))
          ? previous?.createdAt || null
          : new Date(tweet.legacy.created_at).toISOString(),
      };
      posts.set(postId, post);
    }
    for (const [key, child] of Object.entries(value)) {
      // A quoted/retweeted tweet is not a fresh profile-feed batch. Target
      // replies remain included, but another author's nested tweet is excluded.
      if (["quoted_status_result", "retweeted_status_result", "quoted_status", "retweeted_status"].includes(key)) continue;
      // The entry identity is only a fallback for its root result. It must not
      // leak into nested quoted/unavailable objects inside an otherwise valid
      // tweet, even when a platform introduces an unfamiliar wrapper name.
      const enteredTweet = insideTweet || tweetNode;
      const detailEntry = !entry && !insideTweet && requestedPostId && (key === "tweetResult" || key === "tweet_result")
        && value === payload?.data ? { postId: String(requestedPostId), repost: false } : null;
      visit(child, pinned, enteredTweet ? null : entry ? { ...entry, repost } : detailEntry, enteredTweet);
    }
    if (!insideTweet) for (const hydrated of hydratedTweets(value)) visit(hydrated, pinned);
  };

  visit(payload);
  return { recognized: recognized || posts.size > 0 || unavailablePosts.size > 0, posts: [...posts.values(), ...[...unavailablePosts.values()].filter((post) => !posts.has(post.postId))], media: [...media.values()],
    unresolvedMedia: [...unresolved.values()], resolvedPostIds: [...resolvedPostIds], pagination,
    unavailablePosts: [...unavailablePosts.values()].filter((post) => !posts.has(post.postId)),
    // An empty root is not deletion proof. The discoverer can corroborate it
    // only with the same requested detail's explicit unavailable-page UI.
    emptyRootPostIds: [...emptyRootPostIds].filter((postId) => !posts.has(postId)),
    targetUserIds: [...targetUserIds], timelineScope: scopedTimeline(payload) };
}
