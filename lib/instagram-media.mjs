import path from "node:path";

const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeInstagramHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "");
  return HANDLE_PATTERN.test(handle) ? handle : "";
}

export function resolveInstagramHandle(account = {}) {
  const profileUrl = String(account.profileUrl || "").trim();
  if (profileUrl) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(profileUrl) ? profileUrl : `https://${profileUrl}`);
      if (["instagram.com", "www.instagram.com"].includes(parsed.hostname.toLowerCase())) {
        const handle = normalizeInstagramHandle(parsed.pathname.split("/").filter(Boolean)[0]);
        if (handle) return handle;
      }
    } catch {}
  }
  return normalizeInstagramHandle(account.label);
}

function extensionFromUrl(value, fallback) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension;
  } catch {}
  return fallback;
}

function largestVariant(variants = []) {
  return (Array.isArray(variants) ? variants : [])
    .filter((item) => {
      try { return ["http:", "https:"].includes(new URL(item?.url).protocol); } catch { return false; }
    })
    .sort((left, right) => (Number(right.width || 0) * Number(right.height || 0)) - (Number(left.width || 0) * Number(left.height || 0)))[0] || null;
}

function instagramTimestamp(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapInstagramItem(item, parent, position, handle) {
  if (!item || typeof item !== "object") return null;
  const video = largestVariant(item.video_versions)
    || largestVariant(item.video_url ? [{ url: item.video_url }] : []);
  const image = largestVariant(item.image_versions2?.candidates)
    || largestVariant(item.display_url ? [{ url: item.display_url }] : []);
  // A playable video URL is required for a video. Its preview image must not
  // silently turn an inaccessible clip into a successfully collected image.
  const isVideo = Boolean(video || item.is_video === true || Number(item.media_type) === 2 || item.__typename === "GraphVideo");
  const source = isVideo ? video : image;
  if (!source) return null;
  const code = String(parent.code || parent.shortcode || parent.pk || parent.id);
  const mediaId = String(item.pk || item.id || position);
  const createdAt = instagramTimestamp(parent.taken_at || item.taken_at || parent.taken_at_timestamp || item.taken_at_timestamp);
  const kind = isVideo ? "video" : "image";
  return {
    platformId: "instagram",
    postId: code,
    postKey: code,
    logicalKey: `${code}:${mediaId}`,
    mediaId,
    mediaIdentityKnown: Boolean(item.pk || item.id),
    mediaIndex: position,
    handle,
    createdAt,
    sensitive: true,
    postUrl: `https://www.instagram.com/${parent.product_type === "clips" ? "reel" : "p"}/${code}/`,
    kind,
    sourceUrl: source.url,
    extension: extensionFromUrl(source.url, video ? ".mp4" : ".jpg"),
    width: Number(source.width || item.original_width || 0),
    height: Number(source.height || item.original_height || 0),
    referer: "https://www.instagram.com/",
  };
}

// A later, smaller representation of an album is not proof that an earlier
// missing attachment disappeared. Keep the strongest coverage observed across
// responses, and optionally across runs, without downloading anything here.
export function createInstagramPostCoverage({ knownPostCoverage = {}, knownMediaKeys = [] } = {}) {
  const coverage = new Map();
  const knownByPost = new Map();
  for (const key of Array.isArray(knownMediaKeys) ? knownMediaKeys : []) {
    if (typeof key !== "string" || !key.includes(":")) continue;
    const postKey = key.slice(0, key.indexOf(":"));
    if (!knownByPost.has(postKey)) knownByPost.set(postKey, new Set());
    knownByPost.get(postKey).add(key);
  }
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const stableKeys = (value, postKey) => Array.isArray(value) ? value.filter((key) => typeof key === "string"
    && key.length <= 1_000 && key.startsWith(`${postKey}:`)).slice(0, 2_000) : [];
  return {
    observe(post, items = [], missing = []) {
      const postKey = String(post.postKey);
      let entry = coverage.get(postKey);
      if (!entry) {
        const previous = Object.hasOwn(knownPostCoverage || {}, postKey) ? knownPostCoverage[postKey] : null;
        entry = { expectedCount: count(previous?.mediaExpectedCount), expectedKeys: new Set(stableKeys(previous?.mediaExpectedKeys, postKey)),
          resolvedKeys: new Set(knownByPost.get(postKey) || []), missing: new Map() };
        coverage.set(postKey, entry);
      }
      entry.expectedCount = Math.max(entry.expectedCount, count(post.mediaExpectedCount));
      for (const key of stableKeys(post.mediaExpectedKeys, postKey)) entry.expectedKeys.add(key);
      for (const item of items) {
        if (item.postKey !== postKey || typeof item.logicalKey !== "string") continue;
        entry.resolvedKeys.add(item.logicalKey);
        if (item.mediaIdentityKnown !== false) entry.expectedKeys.add(item.logicalKey);
      }
      for (const item of missing) {
        if (item.postKey !== postKey) continue;
        if (item.mediaIdentityKnown === true && item.logicalKey) entry.expectedKeys.add(item.logicalKey);
        entry.missing.set(item.logicalKey || `${postKey}:${item.mediaIndex || "unknown"}`, item);
      }
      const mediaComplete = Boolean(entry.expectedCount > 0 && entry.resolvedKeys.size >= entry.expectedCount
        && [...entry.expectedKeys].every((key) => entry.resolvedKeys.has(key)));
      const merged = { ...post, mediaExpectedCount: entry.expectedCount,
        mediaExpectedKeys: [...entry.expectedKeys], mediaComplete };
      const unresolvedMedia = mediaComplete ? [] : [...entry.missing.values()].filter((item) => item.mediaIdentityKnown === true
        ? !entry.resolvedKeys.has(item.logicalKey) : entry.resolvedKeys.size < entry.expectedCount);
      if (!mediaComplete && !unresolvedMedia.length) unresolvedMedia.push({ postKey, postId: post.postId || postKey,
        postUrl: post.postUrl, mediaExpectedCount: entry.expectedCount, mediaExpectedKeys: [...entry.expectedKeys], reason: "media-coverage-unresolved" });
      return { post: merged, unresolvedMedia };
    },
  };
}

// A successful posts query can also report errors for decorative metadata.
// Only the observed location avatar is exempt, and only when its indexed feed
// node is an actual parsed target post. Unknown paths remain blocking errors.
export function instagramGraphQLIssues(payload, parsed, { operation = "", scope = "timeline", postKey = "", roots = null } = {}) {
  const root = "xdt_api__v1__feed__user_timeline_graphql_connection";
  const identifier = (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
  const errorCode = (value) => Number.isSafeInteger(value) || (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value));
  return (Array.isArray(payload?.errors) ? payload.errors : []).flatMap((error) => {
    const fieldPath = Array.isArray(error?.path) && error.path.length <= 20
      && error.path.every((part) => identifier(part) || (Number.isSafeInteger(part) && part >= 0)) ? error.path : null;
    // A query may also return viewer/recommendation modules. A precise error
    // path on another declared root is not an error in the selected post data.
    if (roots && fieldPath && !roots.includes(fieldPath[0]) && Object.hasOwn(payload?.data || {}, fieldPath[0])) return [];
    if (roots && fieldPath) {
      let current = payload?.data;
      let targetBranch = false;
      for (const part of fieldPath) {
        current = current?.[part];
        const ownerPostKey = String(current?.code || current?.shortcode || "");
        // Album attachments can have their own shortcode. Once the path has
        // entered the requested album, those attachment errors still belong
        // to it, rather than being foreign-post recommendations.
        if (!targetBranch && ownerPostKey && ownerPostKey !== postKey) return [];
        if (ownerPostKey === postKey) targetBranch = true;
      }
    }
    const pathToNode = fieldPath?.slice(0, -2) || [];
    const node = pathToNode.reduce((value, part) => value?.[part], payload?.data);
    const nodeKey = String(node?.code || node?.shortcode || "");
    const targetPost = nodeKey && parsed?.posts?.some((post) => post.postKey === nodeKey);
    const allowedRoot = fieldPath?.[0] === root || (roots && roots.includes(fieldPath?.[0]));
    if (allowedRoot && targetPost && fieldPath?.at(-2) === "location" && fieldPath.at(-1) === "profile_pic_url") return [];
    const graphqlCode = error?.code ?? error?.extensions?.code ?? error?.error_code;
    return [{ reason: "timeline-graphql-error", scope,
      ...(identifier(operation) ? { operation } : {}),
      ...(postKey ? { postKey } : {}),
      ...(fieldPath ? { fieldPath: [...fieldPath] } : {}),
      ...(errorCode(graphqlCode) ? { graphqlCode } : {}),
    }];
  });
}

const INSTAGRAM_DETAIL_ROOTS = ["media", "shortcode_media", "xdt_shortcode_media", "xdt_api__v1__media__shortcode__web_info"];
const INSTAGRAM_TIMELINE_ROOT = "xdt_api__v1__feed__user_timeline_graphql_connection";

// Profile SSR contains viewer, recommendations and post-detail modules too.
// Select only actual feed documents, and prove their target from that same
// document (not from the URL or an unrelated viewer/profile module).
export function instagramTimelineDocuments(payloads, targetHandle) {
  const target = normalizeInstagramHandle(targetHandle).toLowerCase();
  const documents = [];
  const seen = new WeakSet();
  const matches = (value) => normalizeInstagramHandle(value?.username).toLowerCase() === target;
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const data = value.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (Object.hasOwn(data, INSTAGRAM_TIMELINE_ROOT)) {
        const connection = data[INSTAGRAM_TIMELINE_ROOT];
        const metadataTarget = matches(data.user) || matches(data.profile?.user);
        const ownerTarget = Array.isArray(connection?.edges) && connection.edges.some((edge) =>
          matches(edge?.node?.user) || matches(edge?.node?.owner));
        if (metadataTarget || ownerTarget) {
          const metadata = matches(data.user) ? data.user : data.profile?.user;
          const feedPayload = { data: { [INSTAGRAM_TIMELINE_ROOT]: connection,
            ...(metadataTarget ? { user: { username: metadata.username, id: metadata.id || metadata.pk } } : {}) } };
          // Only explicit metadata proves an empty feed. Owned nodes prove a
          // non-empty feed without allowing foreign coauthor recommendations.
          const requestedHandle = metadataTarget ? targetHandle : "";
          const parsed = extractInstagramTimeline(feedPayload, targetHandle, { requestedHandle });
          documents.push({ payload: value, feedPayload, roots: [INSTAGRAM_TIMELINE_ROOT], parsed,
            targetConfirmed: true, metadataTarget });
        }
      }
      if (matches(data.user) && Object.hasOwn(data.user, "edge_owner_to_timeline_media")) {
        const feedPayload = { data: { user: { username: data.user.username, id: data.user.id || data.user.pk,
          edge_owner_to_timeline_media: data.user.edge_owner_to_timeline_media } } };
        documents.push({ payload: value, feedPayload, roots: ["user"],
          parsed: extractInstagramTimeline(feedPayload, targetHandle), targetConfirmed: true, metadataTarget: true });
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  if (target) visit(payloads);
  return documents;
}

// Restrict detail proof to real post-query roots and the requested post. Relay
// SSR contains independent queries, recommended posts and arbitrary data too.
export function instagramDetailDocuments(payloads, targetHandle, postKey) {
  const documents = [];
  const seen = new WeakSet();
  const containsPost = (value, traversed = new WeakSet()) => {
    if (!value || typeof value !== "object" || traversed.has(value)) return false;
    traversed.add(value);
    if (String(value.code || value.shortcode || "") === postKey) return true;
    return Object.values(value).some((child) => containsPost(child, traversed));
  };
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const roots = INSTAGRAM_DETAIL_ROOTS.filter((root) => Object.hasOwn(value.data || {}, root) && containsPost(value.data[root]));
    if (roots.length) {
      const parsed = extractInstagramTimeline({ data: Object.fromEntries(roots.map((root) => [root, value.data[root]])) }, targetHandle);
      documents.push({ payload: value, roots, parsed });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payloads);
  return documents;
}

// Instagram frequently embeds post details in Relay SSR JSON and issues no
// post API request at all. Decode data scripts, never JavaScript or captions.
export function parseInstagramHtml(html) {
  const source = String(html || "");
  if (source.length > 16 * 1024 * 1024) throw new Error("Instagram 详情数据超出安全读取范围。");
  const payloads = [];
  const decoded = new Set();
  let visited = 0;
  const expand = (value, depth = 0, relayArguments = false) => {
    if (depth > 80 || ++visited > 300_000) throw new Error("Instagram 详情数据结构超出安全读取范围。");
    if (typeof value === "string") {
      const text = value.trim().replace(/^for \(;;\);/, "");
      if (!relayArguments || !/^[\[{]/.test(text) || decoded.has(text)) return;
      decoded.add(text);
      try { const parsed = JSON.parse(text); payloads.push(parsed); expand(parsed, depth + 1); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    } else if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        const relayCall = value[0] === "RelayPrefetchedStreamCache" && value[1] === "add";
        value.forEach((child, index) => expand(child, depth + 1, relayArguments || (relayCall && index === 3)));
      } else for (const child of Object.values(value)) expand(child, depth + 1);
    }
  };
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/json["']|\bdata-sjs\b/i.test(match[1])) continue;
    const text = match[2].trim();
    if (!text) continue;
    const parsed = JSON.parse(text.replace(/^for \(;;\);/, ""));
    payloads.push(parsed);
    expand(parsed);
  }
  return payloads;
}

export function extractInstagramTimeline(payload, targetHandle, { requestedHandle = "" } = {}) {
  const normalizedTarget = normalizeInstagramHandle(targetHandle).toLowerCase();
  if (!normalizedTarget) throw new Error("Instagram 账号名称无效。");
  const posts = new Map();
  const media = new Map();
  const seen = new WeakSet();
  const connections = [];
  const targetUserIds = new Set();
  const unresolvedByPost = new Map();
  const coverage = createInstagramPostCoverage();
  const parseIssues = [];
  const timelineBatches = [];
  let recognized = false;
  let hasNextPage = null;
  const requestedTarget = normalizeInstagramHandle(requestedHandle).toLowerCase() === normalizedTarget;
  const ownerHandle = (value) => normalizeInstagramHandle(value?.user?.username || value?.owner?.username);
  // Collaborative posts are published on every accepted coauthor's profile,
  // even when Instagram returns another account as the primary owner. An
  // invitation is not proof that the target accepted/published the post.
  const belongsToTarget = (value) => ownerHandle(value).toLowerCase() === normalizedTarget
    || (Array.isArray(value?.coauthor_producers) && value.coauthor_producers.some((producer) =>
      normalizeInstagramHandle(producer?.username).toLowerCase() === normalizedTarget));
  const issue = (reason, postKey) => {
    if (parseIssues.length < 50 && !parseIssues.some((entry) => entry.reason === reason && entry.postKey === postKey)) {
      parseIssues.push({ reason, ...(postKey ? { postKey } : {}) });
    }
  };
  const missing = (parent, item, position, reason) => {
    const code = String(parent.code || parent.shortcode);
    const mediaId = String(item?.pk || item?.id || position);
    const kind = item && (item.is_video === true || Number(item.media_type) === 2 || item.__typename === "GraphVideo") ? "video" : "image";
    const entry = { postKey: code, postId: code, logicalKey: `${code}:${mediaId}`, mediaId,
      mediaIdentityKnown: Boolean(item?.pk || item?.id),
      mediaIndex: position, kind, postUrl: `https://www.instagram.com/${parent.product_type === "clips" ? "reel" : "p"}/${code}/`, reason };
    issue(reason, code);
    return entry;
  };

  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Object.hasOwn(value, "xdt_api__v1__feed__user_timeline_graphql_connection")) {
      connections.push({ connection: value.xdt_api__v1__feed__user_timeline_graphql_connection, scoped: requestedTarget });
    }
    if (Object.hasOwn(value, "edge_owner_to_timeline_media")) {
      connections.push({ connection: value.edge_owner_to_timeline_media,
        scoped: normalizeInstagramHandle(value.username).toLowerCase() === normalizedTarget });
    }
    if (requestedTarget && Object.hasOwn(value, "items") && Object.hasOwn(value, "more_available")) {
      connections.push({ connection: { edges: Array.isArray(value.items) ? value.items.map((node) => ({ node })) : value.items,
        page_info: { has_next_page: value.more_available, end_cursor: value.next_max_id } }, scoped: true });
    }
    if (normalizeInstagramHandle(value.username).toLowerCase() === normalizedTarget) {
      const id = value.pk || value.id;
      if (id) targetUserIds.add(String(id));
    }

    const handle = normalizeInstagramHandle(targetHandle);
    const isPost = Boolean((value.code || value.shortcode) && (value.pk || value.id) && belongsToTarget(value));
    if (isPost) {
      const code = String(value.code || value.shortcode);
      const children = Array.isArray(value.carousel_media) ? value.carousel_media
        : Array.isArray(value.edge_sidecar_to_children?.edges) ? value.edge_sidecar_to_children.edges.map((edge) => edge?.node)
          : Number(value.media_type) === 8 || value.__typename === "GraphSidecar" ? [] : [value];
      const declaredCount = Number(value.carousel_media_count || value.carousel_media?.length || 0);
      const expectedCount = Math.max(children.length, Number.isInteger(declaredCount) && declaredCount > 0 ? declaredCount : 0, 1);
      let mediaComplete = true;
      const parsedItems = [];
      const missingItems = [];
      for (let index = 0; index < expectedCount; index += 1) {
        const item = children[index];
        const mapped = mapInstagramItem(item, value, index + 1, handle);
        if (mapped) { media.set(mapped.logicalKey, mapped); parsedItems.push(mapped); }
        else { mediaComplete = false; missingItems.push(missing(value, item, index + 1, item ? "media-url-missing" : "attachment-missing")); }
      }
      const merged = coverage.observe({
        postKey: code,
        postId: code,
        handle,
        createdAt: instagramTimestamp(value.taken_at || value.taken_at_timestamp),
        postUrl: `https://www.instagram.com/${value.product_type === "clips" ? "reel" : "p"}/${code}/`,
        mediaComplete,
        mediaExpectedCount: expectedCount,
        pinned: value.is_pinned === true || value.is_pinned_for_users?.length > 0,
      }, parsedItems, missingItems);
      posts.set(code, merged.post);
      unresolvedByPost.set(code, merged.unresolvedMedia);
    }
    for (const child of Object.values(value)) visit(child);
  };

  visit(payload);
  // A response for a recommendation/another profile is not proof that this
  // target's timeline loaded. Empty feeds require an explicitly scoped request.
  for (const { connection, scoped } of connections) {
    if (!connection || typeof connection !== "object" || !Array.isArray(connection.edges)) {
      if (scoped) issue("timeline-edges-invalid");
      continue;
    }
    const nodes = connection.edges.map((edge) => edge?.node);
    const targetNodes = nodes.some(belongsToTarget);
    if (!targetNodes && !(scoped && (nodes.length === 0 || nodes.some((node) => !ownerHandle(node))))) continue;
    if (nodes.length === 0 && Array.isArray(payload?.errors) && payload.errors.length) continue;
    recognized = true;
    const batchPosts = [];
    let reliable = true;
    for (const node of nodes) {
      const code = String(node?.code || node?.shortcode || "");
      const post = belongsToTarget(node) ? posts.get(code) : null;
      if (!post) { reliable = false; issue("timeline-post-invalid"); }
      else {
        batchPosts.push(post);
        if (!post.mediaComplete) reliable = false;
      }
    }
    const next = typeof connection.page_info?.has_next_page === "boolean" ? connection.page_info.has_next_page : null;
    timelineBatches.push({ posts: batchPosts, hasNextPage: next, reliable,
      endCursor: typeof connection.page_info?.end_cursor === "string" ? connection.page_info.end_cursor : null });
  }
  // Multiple connections cannot make one another's missing/continuing cursor
  // disappear. Only an unambiguous terminal batch is evidence of exhaustion.
  if (timelineBatches.length && timelineBatches.every((batch) => batch.hasNextPage === false)) hasNextPage = false;
  else if (timelineBatches.some((batch) => batch.hasNextPage === true)) hasNextPage = true;
  return { recognized, posts: [...posts.values()], media: [...media.values()], hasNextPage,
    timelineBatches, unresolvedMedia: [...unresolvedByPost.values()].flat(),
    parseIssues: parseIssues.filter((entry) => !entry.postKey || posts.get(entry.postKey)?.mediaComplete !== true),
    targetUserIds: [...targetUserIds] };
}
