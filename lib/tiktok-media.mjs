import path from "node:path";

const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,24}$/;

export function normalizeTikTokHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "");
  return HANDLE_PATTERN.test(handle) ? handle : "";
}

export function resolveTikTokHandle(account = {}) {
  if (account.profileUrl) {
    try {
      const url = new URL(/^https?:\/\//i.test(account.profileUrl) ? account.profileUrl : `https://${account.profileUrl}`);
      if (["www.tiktok.com", "tiktok.com"].includes(url.hostname.toLowerCase())) {
        const segment = url.pathname.split("/").filter(Boolean)[0] || "";
        if (segment.startsWith("@")) return normalizeTikTokHandle(segment);
      }
    } catch {}
  }
  return normalizeTikTokHandle(account.label);
}

function urls(value) {
  if (typeof value === "string") {
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      return url.protocol === "https:" && !url.username && !url.password ? [url.href] : [];
    } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(urls);
  if (!value || typeof value !== "object") return [];
  return urls(value.urlList || value.UrlList || value.url_list || value.src || value.url || []);
}

function extension(url, fallback) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return /\.(?:jpe?g|png|webp|gif|mp4)$/.test(ext) ? ext : fallback;
}

function createdAt(item) {
  const seconds = Number(item.createTime || item.create_time || 0);
  const date = new Date(seconds * 1_000);
  return seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function videoVariants(video = {}) {
  const candidates = [];
  const bitrates = video.bitrateInfo || video.bitrate_info;
  for (const entry of Array.isArray(bitrates) ? bitrates : []) {
    if (!entry || typeof entry !== "object") continue;
    const address = entry.PlayAddr || entry.playAddr || entry.play_addr || {};
    const codec = String(entry.CodecType || entry.codecType || "").toLowerCase();
    // TikTok's bytevc2 is not a generally playable archive format. The
    // media-video-hvc1 rendition can omit audio; prefer complete MP4 sources.
    if (/bytevc2|vvc/.test(codec + String(address.UrlKey || ""))) continue;
    for (const sourceUrl of urls(address)) {
      if (new URL(sourceUrl).pathname.endsWith("/media-video-hvc1/")) continue;
      candidates.push({ sourceUrl, bitrate: Number(entry.Bitrate || entry.bitrate || 0),
        width: Number(address.Width || video.width || 0), height: Number(address.Height || video.height || 0) });
    }
  }
  candidates.sort((a, b) => b.bitrate - a.bitrate || b.width * b.height - a.width * a.height);
  for (const sourceUrl of urls(video.playAddr || video.play_addr)) {
    candidates.push({ sourceUrl, bitrate: Number(video.bitrate || 0), width: Number(video.width || 0), height: Number(video.height || 0) });
  }
  for (const sourceUrl of urls(video.downloadAddr || video.download_addr || video.download)) {
    candidates.push({ sourceUrl, bitrate: 0, width: Number(video.width || 0), height: Number(video.height || 0) });
  }
  const seen = new Set();
  return candidates.filter(({ sourceUrl }) => !seen.has(sourceUrl) && seen.add(sourceUrl));
}

export function extractTikTokTimeline(payload, targetHandle) {
  const target = normalizeTikTokHandle(targetHandle).toLowerCase();
  if (!target) throw new Error("TikTok 账号名称无效。");
  const posts = new Map();
  const media = new Map();
  const unresolvedPosts = new Map();
  const postCoverage = new Map();
  const candidates = new Set();
  const seen = new WeakSet();
  let recognized = false;
  let hasMore = null;
  let cursor = null;
  let statusCode = null;
  const primaryList = Array.isArray(payload?.itemList) || Array.isArray(payload?.item_list);
  let unparsedItems = 0;
  let foreignItems = 0;

  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value.itemList) || Array.isArray(value.item_list)) {
      recognized = true;
      for (const item of value.itemList || value.item_list) candidates.add(item);
      if (!primaryList || value === payload) {
        const more = value.hasMore ?? value.has_more;
        if ([true, false, 0, 1].includes(more)) hasMore = Boolean(more);
        cursor = value.cursor ?? value.maxCursor ?? cursor;
        statusCode = Number(value.statusCode ?? value.status_code ?? 0);
      }
    }
    if (value.ItemModule || value.itemInfo?.itemStruct) {
      recognized = true;
      for (const item of Object.values(value.ItemModule || {})) candidates.add(item);
      if (value.itemInfo?.itemStruct) candidates.add(value.itemInfo.itemStruct);
    }
    const handle = normalizeTikTokHandle(typeof value.author === "string" ? value.author : value.author?.uniqueId || value.author?.unique_id);
    const rawId = value.id || value.aweme_id;
    const postId = typeof rawId === "string" ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : "";
    if (/^\d+$/.test(postId) && handle.toLowerCase() === target) {
      recognized = true;
      const imagePost = value.imagePost || value.image_post_info;
      const images = Array.isArray(imagePost?.images) ? imagePost.images : [];
      const declaredCount = imagePost?.imageCount ?? imagePost?.image_count;
      const imageCount = Number.isSafeInteger(Number(declaredCount)) && Number(declaredCount) > 0
        ? Math.max(images.length, Number(declaredCount)) : images.length;
      const coverageKnown = imagePost ? Array.isArray(imagePost.images) && imageCount > 0 : Boolean(value.video && typeof value.video === "object");
      const expectedMediaKeys = imagePost
        ? Array.from({ length: Math.min(imageCount, 10_000) }, (_, index) => `${postId}:image:${index + 1}`)
        : coverageKnown ? [`${postId}:video:1`] : [];
      const post = { postId, postKey: postId, handle, createdAt: createdAt(value),
        pinned: Boolean(value.isPinnedItem || value.isPinned || value.pinned),
        postUrl: `https://www.tiktok.com/@${handle}/${imagePost ? "photo" : "video"}/${postId}` };
      posts.set(postId, post);
      const base = { ...post, platformId: "tiktok", sensitive: true, referer: "https://www.tiktok.com/" };
      let resolved = coverageKnown && imageCount <= 10_000;
      if (imagePost) {
        images.forEach((item, index) => {
          const candidates = [...new Set(urls(item?.imageURL || item?.imageUrl || item?.display_image || item?.image_url))];
          if (!candidates.length) { resolved = false; return; }
          const mediaIndex = index + 1;
          const logicalKey = `${postId}:image:${mediaIndex}`;
          media.set(logicalKey, { ...base, mediaId: `image:${mediaIndex}`, mediaIndex, logicalKey, kind: "image",
            sourceUrl: candidates[0], variants: candidates.map((sourceUrl) => ({ sourceUrl, bitrate: 0 })),
            extension: extension(candidates[0], ".jpg"), width: Number(item.imageWidth || item.width || 0), height: Number(item.imageHeight || item.height || 0) });
        });
      } else {
        const variants = videoVariants(value.video || {});
        if (variants.length) {
          const logicalKey = `${postId}:video:1`;
          media.set(logicalKey, { ...base, mediaId: "video:1", mediaIndex: 1, logicalKey, kind: "video",
            ...variants[0], variants, extension: ".mp4" });
        } else resolved = false;
      }
      resolved &&= expectedMediaKeys.every((key) => media.has(key));
      const previous = postCoverage.get(postId);
      const expected = [...new Set([...(previous?.expectedMediaKeys || []), ...expectedMediaKeys])];
      const coverage = { postKey: postId, expectedMediaKeys: expected,
        expectedMediaCount: Math.max(previous?.expectedMediaCount || 0, imagePost ? imageCount : expectedMediaKeys.length),
        coverageKnown: coverageKnown || Boolean(previous?.coverageKnown),
        mediaComplete: (coverageKnown || Boolean(previous?.coverageKnown)) && expected.length > 0
          && expected.length >= Math.max(previous?.expectedMediaCount || 0, imagePost ? imageCount : expectedMediaKeys.length)
          && expected.every((key) => media.has(key)) };
      postCoverage.set(postId, coverage);
      post.mediaExpectedCount = coverage.expectedMediaCount;
      post.mediaExpectedKeys = expected;
      post.mediaComplete = coverage.mediaComplete && resolved;
      if (post.mediaComplete) unresolvedPosts.delete(postId);
      else unresolvedPosts.set(postId, post);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  for (const item of candidates) {
    if (!item || typeof item !== "object") { unparsedItems += 1; continue; }
    const author = normalizeTikTokHandle(typeof item.author === "string" ? item.author : item.author?.uniqueId || item.author?.unique_id);
    const rawId = item.id || item.aweme_id;
    const id = typeof rawId === "string" ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : "";
    if (author && author.toLowerCase() !== target) foreignItems += 1;
    else if (!/^\d+$/.test(id) || !author || !posts.has(id)) {
      unparsedItems += 1;
      if (/^\d+$/.test(id) && !posts.has(id)) {
        // Retain a retryable post reference, never its unverified media URLs.
        const post = { postId: id, postKey: id, handle: target, createdAt: createdAt(item),
          postUrl: `https://www.tiktok.com/@${target}/${item.imagePost || item.image_post_info ? "photo" : "video"}/${id}`,
          mediaComplete: false, mediaExpectedCount: 0 };
        posts.set(id, post);
        unresolvedPosts.set(id, post);
        postCoverage.set(id, { postKey: id, expectedMediaKeys: [], expectedMediaCount: 0, coverageKnown: false, mediaComplete: false });
      }
    }
  }
  return { recognized, posts: [...posts.values()], media: [...media.values()], unresolvedPosts: [...unresolvedPosts.values()],
    postCoverage: [...postCoverage.values()], unparsedItems, foreignItems, hasMore, cursor, statusCode };
}

function matchesCookie(cookie, url, now) {
  const rawDomain = String(cookie.domain || "").toLowerCase();
  const domain = rawDomain.replace(/^\./, "");
  const host = url.hostname.toLowerCase();
  if (host !== domain && !(rawDomain.startsWith(".") && host.endsWith(`.${domain}`))) return false;
  const cookiePath = cookie.path || "/";
  if (url.pathname !== cookiePath && !url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)) return false;
  return (!cookie.secure || url.protocol === "https:")
    && (!cookie.expires || cookie.expires < 0 || cookie.expires * 1_000 > now);
}

export function createTikTokMediaFetch({ cookies = [], userAgent, mediaUrls = [], fetchImpl = fetch }) {
  // Credentials live in this per-sync closure only, never in media/index records.
  const jar = cookies.map((cookie) => ({ ...cookie }));
  const hosts = new Set(mediaUrls.map((value) => new URL(value).hostname.toLowerCase()));
  const knownCdn = /(?:^|\.)(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|ibyteimg\.com|muscdn\.com|musical\.ly)$/i;
  return async (input, options = {}) => {
    let current = new URL(input);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      if (current.protocol !== "https:" || current.username || current.password || (!hosts.has(current.hostname.toLowerCase()) && !knownCdn.test(current.hostname))) {
        throw new Error("TikTok 媒体跳转到了不支持的地址。");
      }
      const headers = new Headers(options.headers);
      headers.delete("cookie");
      headers.delete("authorization");
      if (userAgent) headers.set("user-agent", userAgent);
      headers.set("referer", "https://www.tiktok.com/");
      const cookieValue = jar.filter((cookie) => matchesCookie(cookie, current, Date.now()))
        .map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      if (cookieValue) headers.set("cookie", cookieValue);
      const response = await fetchImpl(current.href, { ...options, headers, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get("location")) return response;
      await response.body?.cancel();
      current = new URL(response.headers.get("location"), current);
    }
    throw new Error("TikTok 媒体地址重定向过多。");
  };
}
