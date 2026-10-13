import path from "node:path";

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com"]);

export function resolveFacebookProfile(account = {}) {
  let source = String(account.profileUrl || "").trim();
  if (!source && /^[A-Za-z0-9.\-_]+$/.test(String(account.label || "").trim())) {
    source = `https://www.facebook.com/${String(account.label).trim()}`;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(source) ? source : `https://${source}`);
    if (!FACEBOOK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    parsed.hostname = "www.facebook.com";
    parsed.hash = "";
    const profileId = /^\d+$/.test(parsed.searchParams.get("id") || "") ? parsed.searchParams.get("id") : "";
    return { profileUrl: parsed.href, profileId };
  } catch {
    return null;
  }
}

export function parseFacebookResponseText(text, { strict = true } = {}) {
  const payloads = [];
  for (const line of String(text || "").split("\n")) {
    const cleaned = line.replace(/^for \(;;\);/, "").trim();
    if (!cleaned) continue;
    try { payloads.push(JSON.parse(cleaned)); }
    catch (error) { if (strict) throw error; }
  }
  return payloads;
}

const UNSAFE_RELAY_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RELAY_IDENTITY_KEYS = new Set(["id", "__typename", "post_id"]);
const MAX_RELAY_ARRAY_INDEX = 100_000;
function safeRelayPath(pathValue) {
  return Array.isArray(pathValue) && pathValue.length > 0 && pathValue.length <= 80
    && pathValue.every((part) => typeof part === "string"
      ? part.length > 0 && part.length <= 512 && !UNSAFE_RELAY_KEYS.has(part)
      : Number.isSafeInteger(part) && part >= 0 && part <= MAX_RELAY_ARRAY_INDEX);
}
function isFeedPath(pathValue) {
  return Array.isArray(pathValue) && pathValue.includes("timeline_list_feed_units");
}
function isRequiredFeedPath(pathValue) {
  if (!isFeedPath(pathValue)) return false;
  // Reactions/comments/caption translation are optional UI components even
  // when they happen to be deferred underneath a timeline Story. Attachment,
  // author and paging failures remain relevant; unknown feed fields stay strict.
  const tail = pathValue.slice(pathValue.indexOf("timeline_list_feed_units") + 1);
  return !tail.some((part) => /^(?:feedback|feedback_context|feedback_rendering_instance|reactions?|comments?|comment_rendering|message_translation|profile_header_renderer)$/.test(String(part)));
}
function mergeRelayValue(target, source, depth = 0) {
  if (depth > 80) throw new Error("Facebook Relay patch exceeds safe depth.");
  if (!source || typeof source !== "object" || Array.isArray(source)) return structuredClone(source);
  const result = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_RELAY_KEYS.has(key)) throw new Error("Unsafe Facebook Relay patch key.");
    if (RELAY_IDENTITY_KEYS.has(key) && Object.hasOwn(result, key) && result[key] != null
      && String(result[key]) !== String(value)) throw new Error("Facebook Relay patch changes an existing identity.");
    result[key] = mergeRelayValue(Object.hasOwn(result, key) ? result[key] : undefined, value, depth + 1);
  }
  return result;
}

// One GraphQL response is a Relay document, not independent feed pages. Stream
// edges and deferred page_info must be applied to its original target node.
// Never execute code, follow arbitrary object prototypes or manufacture a root
// owner for an orphan patch. The caller still parses all JSON lines strictly.
export function assembleFacebookResponse(payloads) {
  const documents = [];
  const patchIssues = new Set();
  let current = null;
  let relayFinal = null;
  let incrementalOpen = null;
  const apply = (part) => {
    if (!part || typeof part !== "object") return;
    if (typeof part.extensions?.is_final === "boolean") relayFinal = part.extensions.is_final;
    if (typeof part.hasNext === "boolean") incrementalOpen = part.hasNext;
    if (!Object.hasOwn(part, "path")) {
      if (Object.hasOwn(part, "data")) {
        current = structuredClone(part);
        documents.push(current);
      } else if (Array.isArray(part.errors)) {
        documents.push(structuredClone(part));
      }
      for (const child of part.incremental || []) apply(child);
      return;
    }
    const pathValue = part.path;
    const relevant = isFeedPath(pathValue) || /timeline_list_feed_units/.test(String(part.label || ""));
    const ownerIdentityPatch = Array.isArray(pathValue) && pathValue[0] === "node" && pathValue.length <= 2
      && Object.hasOwn(current?.data?.node || {}, "timeline_list_feed_units");
    if (!safeRelayPath(pathValue) || !current?.data || typeof current.data !== "object") {
      if (relevant) patchIssues.add("timeline-invalid-relay-patch");
      return;
    }
    let parent = current.data;
    for (const key of pathValue.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) {
        if (relevant) patchIssues.add("timeline-orphan-relay-patch");
        return;
      }
      parent = parent[key];
    }
    const leaf = pathValue.at(-1);
    if (!parent || typeof parent !== "object" || (Array.isArray(parent) && typeof leaf !== "number")) {
      if (relevant) patchIssues.add("timeline-invalid-relay-patch");
      return;
    }
    if (Array.isArray(part.errors) && part.errors.length) {
      current.errors ||= [];
      current.errors.push(...part.errors.map((error) => ({ ...error,
        path: Array.isArray(error.path) && error.path[0] === "node" ? error.path
          : [...pathValue, ...(Array.isArray(error.path) ? error.path : [])] })));
    }
    try {
      if (RELAY_IDENTITY_KEYS.has(String(leaf)) && Object.hasOwn(parent, leaf) && parent[leaf] != null
        && Object.hasOwn(part, "data") && String(parent[leaf]) !== String(part.data)) {
        patchIssues.add("timeline-relay-identity-change"); return;
      }
      if (Object.hasOwn(part, "data")) parent[leaf] = mergeRelayValue(parent[leaf], part.data);
      // GraphQL's incremental stream format represents a run of array entries.
      if (Array.isArray(part.items)) {
        if (!Array.isArray(parent) || typeof leaf !== "number" || leaf + part.items.length > MAX_RELAY_ARRAY_INDEX) {
          if (relevant) patchIssues.add("timeline-invalid-relay-patch");
        } else part.items.forEach((item, index) => { parent[leaf + index] = mergeRelayValue(parent[leaf + index], item); });
      }
    } catch {
      if (relevant || ownerIdentityPatch) patchIssues.add("timeline-invalid-relay-patch");
    }
    for (const child of part.incremental || []) apply(child);
  };
  for (const payload of payloads) apply(payload);
  if (relayFinal === false || incrementalOpen === true) patchIssues.add("timeline-relay-stream-incomplete");
  return { payloads: documents, patchIssues: [...patchIssues] };
}

// Relay's server-rendered JSON can contain another JSON document as a string.
// Decode only JSON, never executable script or arbitrary JavaScript expressions.
export function parseFacebookHtml(html) {
  const source = String(html || "");
  if (source.length > 16 * 1024 * 1024) throw new Error("Facebook 首屏数据超出安全读取范围。");
  const payloads = [];
  const decoded = new Set();
  let visited = 0;
  const expand = (value, depth = 0, relayArguments = false) => {
    if (depth > 80 || ++visited > 300_000) throw new Error("Facebook 首屏数据结构超出安全读取范围。");
    if (typeof value === "string") {
      const text = value.trim().replace(/^for \(;;\);/, "");
      // Only framework Relay arguments may contain encoded documents. A post
      // caption that happens to look like JSON must never become feed metadata.
      if (!relayArguments || !/^[\[{]/.test(text) || decoded.has(text)) return;
      decoded.add(text);
      try { const parsed = JSON.parse(text); payloads.push(parsed); expand(parsed, depth + 1); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    } else if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        const relayCall = value[0] === "RelayPrefetchedStreamCache" && value[1] === "add";
        value.forEach((child, index) => expand(child, depth + 1, relayArguments || (relayCall && index === 3)));
      } else {
        for (const child of Object.values(value)) expand(child, depth + 1);
      }
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

function attachmentCoverage(attachments, refs) {
  let expected = refs.length;
  let more = false;
  let unknown = false;
  const visit = (value, key = "") => {
    if (!value || typeof value !== "object") return;
    if (/^(?:subattachments|all_subattachments)$/.test(key)) {
      for (const field of ["count", "total_count"]) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0) expected = Math.max(expected, value[field]);
      }
      if (value.page_info?.has_next_page === true || value.has_more === true) more = true;
    }
    const type = String(value.__typename || "");
    if (Object.hasOwn(value, "media") && value.media === null) unknown = true;
    if (["Photo", "Video", "AnimatedImage"].includes(type) && !value.id) unknown = true;
    if (key === "media" && !Array.isArray(value)
      && !["Photo", "Video", "AnimatedImage", "ExternalUrl", "ExternalUrlMedia", "ExternalLink", "Link"].includes(type)) unknown = true;
    for (const [childKey, child] of Object.entries(value)) visit(child, key === "media" && Array.isArray(value) ? "media" : childKey);
  };
  visit(attachments);
  return { expected, more, unknown };
}

function directCdnUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && ["fbcdn.net", "fbsbx.com"]
      .some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function extensionFromUrl(value, fallback) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension;
  } catch {}
  return fallback;
}

function imageCandidates(media) {
  const result = [];
  const seen = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (typeof value.uri === "string" && directCdnUrl(value.uri)) {
      const width = Number(value.width || 0);
      const height = Number(value.height || 0);
      result.push({ sourceUrl: value.uri, width, height, qualityScore: (width * height) || 1 });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(media);
  return result;
}

function videoCandidates(media) {
  const result = [];
  const seen = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^(?:progressive_url|playable_url|playable_url_quality_hd|browser_native_hd_url|browser_native_sd_url)$/.test(key) && directCdnUrl(child)) {
        const quality = String(value.quality || value.metadata?.quality || key).toUpperCase();
        const hd = /HD/.test(quality) ? 1 : 0;
        result.push({ sourceUrl: child, quality, qualityScore: (hd * 1_000_000_000) + Number(media.original_width || media.width || 0) * Number(media.original_height || media.height || 0) });
      } else {
        visit(child);
      }
    }
  };
  visit(media);
  return result;
}

function catalogEntry(media) {
  const typename = String(media.__typename || "");
  const id = String(media.id || "");
  if (!id || !["Photo", "Video", "AnimatedImage"].includes(typename)) return null;
  const videoLike = typename !== "Photo";
  const candidates = videoLike ? videoCandidates(media) : imageCandidates(media);
  const best = candidates.sort((left, right) => right.qualityScore - left.qualityScore)[0];
  if (!best) return null;
  const animated = typename === "AnimatedImage" || Boolean(media.animated_image_caption);
  return {
    mediaId: id,
    typename,
    kind: animated ? "gif" : videoLike ? "video" : "image",
    sourceUrl: best.sourceUrl,
    extension: extensionFromUrl(best.sourceUrl, videoLike ? ".mp4" : ".jpg"),
    qualityScore: best.qualityScore,
    width: Number(best.width || media.original_width || media.width || 0),
    height: Number(best.height || media.original_height || media.height || 0),
  };
}

function collectMediaRefs(attachments) {
  const refs = [];
  const refKeys = new Set();
  const seen = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const typename = String(value.__typename || "");
    if (["Photo", "Video", "AnimatedImage"].includes(typename) && value.id) {
      const mediaId = String(value.id);
      if (!refKeys.has(mediaId)) {
        refKeys.add(mediaId);
        refs.push({ mediaId, typename });
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(attachments);
  return refs;
}

export function extractFacebookTimeline(payload, expectedProfileId = "") {
  let profileId = String(expectedProfileId || "");
  let recognized = false;
  const catalog = new Map();
  const storyNodes = [];
  const pagination = [];
  let hasErrors = false;
  const seen = new WeakSet();

  const visit = (value, objectPath = []) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value.errors) && value.errors.length) {
      // An error in badges, tiles or other profile components is not a missing
      // timeline page. Root errors without a field path remain conservative.
      hasErrors ||= value.errors.some((error) => Array.isArray(error?.path)
        ? isRequiredFeedPath(error.path) || error.path.length === 0 || (error.path.length === 1 && error.path[0] === "node")
        : isRequiredFeedPath(objectPath) || objectPath.length === 0);
    }
    if (Object.hasOwn(value, "timeline_list_feed_units")) {
      const owner = String(value.id || "");
      if (owner && profileId && owner !== profileId) return;
      if (!profileId && owner) profileId = owner;
      if (owner && owner === profileId) {
        recognized = true;
        const info = value.timeline_list_feed_units?.page_info;
        if (typeof info?.has_next_page === "boolean") pagination.push({ hasNextPage: info.has_next_page,
          endCursor: typeof info.end_cursor === "string" ? info.end_cursor : null });
      }
    }
    const entry = catalogEntry(value);
    if (entry) {
      const previous = catalog.get(entry.mediaId);
      if (!previous || entry.qualityScore > previous.qualityScore) catalog.set(entry.mediaId, entry);
    }
    if (value.__typename === "Story" && (value.post_id || value.id)) storyNodes.push(value);
    for (const [key, child] of Object.entries(value)) visit(child, [...objectPath, key]);
  };
  visit(payload);

  const posts = new Map();
  const refs = new Map();
  const unresolvedMedia = [];
  for (const story of storyNodes) {
    const actors = Array.isArray(story.actors) ? story.actors : Array.isArray(story.actors?.edges)
      ? story.actors.edges.map((edge) => edge.node) : [];
    const actorIds = actors.map((actor) => String(actor?.id || ""));
    // An unresolved alias cannot grant authority to arbitrary authors in SSR.
    if (!profileId || !actorIds.includes(profileId)) continue;
    const postId = String(story.post_id || story.id || "");
    if (!postId) continue;
    const createdSeconds = Number(story.creation_time || 0);
    const mediaRefs = collectMediaRefs(story.attachments);
    const coverage = attachmentCoverage(story.attachments, mediaRefs);
    const missing = mediaRefs.filter((ref) => !catalog.has(ref.mediaId));
    const structuralIssue = !Array.isArray(story.attachments) || coverage.more || coverage.unknown || coverage.expected > mediaRefs.length;
    const post = {
      postKey: postId,
      postId,
      createdAt: createdSeconds > 0 ? new Date(createdSeconds * 1_000).toISOString() : null,
      postUrl: String(story.permalink_url || ""),
      pinned: Boolean(story.is_pinned || story.is_pinned_post || story.is_pinned_story),
      mediaComplete: !structuralIssue && !missing.length,
      mediaExpectedCount: coverage.expected,
      mediaExpectedKeys: mediaRefs.map((ref) => `${postId}:${ref.mediaId}`),
      mediaStructureComplete: !structuralIssue,
      mediaStructureKnown: Array.isArray(story.attachments),
    };
    posts.set(postId, post);
    mediaRefs.forEach((ref, index) => {
      const logicalKey = `${postId}:${ref.mediaId}`;
      refs.set(logicalKey, { ...ref, ...post, logicalKey, mediaIndex: index + 1 });
    });
    for (const ref of missing) unresolvedMedia.push({ ...post, logicalKey: `${postId}:${ref.mediaId}`,
      mediaId: ref.mediaId, reason: "media-url-missing" });
    if (structuralIssue) unresolvedMedia.push({ ...post, reason: "attachment-coverage-incomplete" });
  }

  return {
    recognized,
    profileId,
    posts: [...posts.values()],
    refs: [...refs.values()],
    catalog: [...catalog.values()],
    pagination,
    hasErrors,
    unresolvedMedia,
  };
}

export function materializeFacebookMedia(ref, catalogEntryValue) {
  if (!ref || !catalogEntryValue?.sourceUrl) return null;
  return {
    platformId: "facebook",
    postId: ref.postId,
    postKey: ref.postKey,
    logicalKey: ref.logicalKey,
    mediaId: ref.mediaId,
    mediaIndex: ref.mediaIndex,
    createdAt: ref.createdAt,
    sensitive: true,
    postUrl: ref.postUrl,
    kind: catalogEntryValue.kind,
    sourceUrl: catalogEntryValue.sourceUrl,
    extension: catalogEntryValue.extension,
    width: catalogEntryValue.width,
    height: catalogEntryValue.height,
    referer: "https://www.facebook.com/",
  };
}

