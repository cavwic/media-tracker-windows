import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openPersonMediaIndex } from "./person-media-index.mjs";

const MEDIA_FOLDERS = Object.freeze({ image: "Image", video: "Video", gif: "Image" });
const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/mpeg": ".mpeg",
});

function abortError() {
  return new DOMException("同步已取消。", "AbortError");
}

function safeExtension(item, contentType = "") {
  return CONTENT_TYPE_EXTENSIONS[contentType.split(";")[0].toLowerCase()]
    || (/^\.[a-z0-9]{2,5}$/i.test(item.extension) ? item.extension.toLowerCase() : ".bin");
}

function actualMediaKind(item, extension, contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (/^\.(?:mp4|webm|mov|mkv|avi|mpeg|mpg|m4v|ts)$/i.test(extension)) return "video";
  if (/^\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|ico)$/i.test(extension)) return "image";
  return item.kind === "video" ? "video" : "image";
}

export async function sha256File(filePath, signal) {
  if (signal?.aborted) throw abortError();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  const abort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function indexExistingMedia(accountRoot, { signal, onFile } = {}) {
  const records = [];
  for (const folder of new Set(Object.values(MEDIA_FOLDERS))) {
    const directory = path.join(accountRoot, folder);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (signal?.aborted) throw abortError();
      if (!entry.isFile() || entry.name.endsWith(".part")) continue;
      const absolutePath = path.join(directory, entry.name);
      const sha256 = await sha256File(absolutePath, signal);
      const relativePath = path.relative(accountRoot, absolutePath);
      records.push({ sha256, relativePath });
      onFile?.({ sha256, relativePath });
    }
  }
  return records;
}

async function fetchToPartial(url, partialPath, signal, onProgress, referer = "https://x.com/", fetchMedia = fetch, mediaKind) {
  const partialSize = await stat(partialPath).then((value) => value.size).catch((error) => {
    if (error?.code === "ENOENT") return 0;
    throw error;
  });
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    Referer: referer,
  };
  if (partialSize > 0) headers.Range = `bytes=${partialSize}-`;
  const timeout = AbortSignal.timeout(90_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const normalizeAbort = (error) => {
    if (timeout.aborted && !signal?.aborted) throw new DOMException("媒体请求超时。", "TimeoutError");
    throw error;
  };
  const response = await Promise.resolve().then(() => fetchMedia(url, { headers, signal: combined, redirect: "follow", mediaKind })).catch(normalizeAbort);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`媒体服务器返回 HTTP ${response.status}。`);
    error.status = response.status;
    throw error;
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (["text/html", "application/xhtml+xml", "application/json"].includes(contentType) || contentType.endsWith("+json")) {
    await response.body.cancel().catch(() => {});
    const error = new Error("媒体服务器返回网页或 JSON，而非媒体文件；请检查登录状态或访问验证。");
    error.code = "unexpected-media-content";
    throw error;
  }
  const append = partialSize > 0 && response.status === 206;
  if (append && !response.headers.get("content-range")?.startsWith(`bytes ${partialSize}-`)) {
    await response.body.cancel().catch(() => {});
    await unlink(partialPath).catch(() => {});
    const error = new Error("媒体服务器返回了不匹配的续传范围，已重新开始下载。");
    error.code = "unexpected-content-range";
    throw error;
  }
  const startingSize = append ? partialSize : 0;
  let received = startingSize;
  const meter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress?.(received);
      controller.enqueue(chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(meter)),
    createWriteStream(partialPath, { flags: append ? "a" : "w" }),
    { signal: combined },
  ).catch(normalizeAbort);
  return { contentType: response.headers.get("content-type") || "", bytes: received };
}

function sourceCandidates(item) {
  const candidates = [
    { sourceUrl: item.sourceUrl, bitrate: item.bitrate },
    ...(Array.isArray(item.variants) ? item.variants : []),
    ...(Array.isArray(item.sourceUrls) ? item.sourceUrls.map((sourceUrl) => ({ sourceUrl })) : []),
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.sourceUrl || seen.has(candidate.sourceUrl)) return false;
    seen.add(candidate.sourceUrl);
    return true;
  });
}

const MEDIA_ERROR_LABELS = Object.freeze({
  "unexpected-media-content": "媒体服务器返回网页或 JSON，而非媒体文件；请检查登录状态或访问验证。",
  "unexpected-content-range": "媒体服务器返回了不匹配的续传范围，请重新同步。",
  "tiktok-image-redirect-blocked": "TikTok 图片地址或跳转不在允许的媒体域名内，已停止请求。",
  "tiktok-image-too-large": "TikTok 单张图片超过 64 MiB 上限，已停止下载。",
});

function retryable(error) {
  if (Object.hasOwn(MEDIA_ERROR_LABELS, error?.code) && error.code !== "unexpected-content-range") return false;
  // Public edition: rate limiting is an instruction to stop this request, not
  // permission to retry immediately or switch to another CDN rendition.
  return !error?.status || [408, 416].includes(error.status) || error.status >= 500;
}

const NETWORK_ERROR_LABELS = Object.freeze({
  ECONNRESET: "连接被重置", ECONNREFUSED: "连接被拒绝", ETIMEDOUT: "连接超时",
  ENOTFOUND: "无法解析服务器地址", EAI_AGAIN: "域名解析暂时失败",
  ENETUNREACH: "网络不可达", EHOSTUNREACH: "服务器不可达",
  UND_ERR_CONNECT_TIMEOUT: "连接超时", UND_ERR_HEADERS_TIMEOUT: "等待响应超时",
  UND_ERR_BODY_TIMEOUT: "读取媒体超时", UND_ERR_SOCKET: "媒体连接意外断开",
  EACCES: "文件访问权限不足", EPERM: "文件操作权限不足", ENOSPC: "存储空间不足",
  ERR_CONNECTION_RESET: "连接被重置", ERR_CONNECTION_REFUSED: "连接被拒绝",
  ERR_CONNECTION_CLOSED: "媒体连接意外断开", ERR_TIMED_OUT: "连接超时",
  ERR_CONNECTION_TIMED_OUT: "连接超时", ERR_NAME_NOT_RESOLVED: "无法解析服务器地址",
  ERR_INTERNET_DISCONNECTED: "网络已断开", ERR_PROXY_CONNECTION_FAILED: "代理连接失败",
  ERR_TUNNEL_CONNECTION_FAILED: "代理隧道连接失败",
});

function safeErrorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  const queue = [error];
  while (queue.length && seen.size < 64) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === "string" && /^(?:E[A-Z0-9_]{2,40}|UND_ERR_[A-Z0-9_]{1,40})$/.test(current.code)) codes.add(current.code);
    if (current.name === "TimeoutError") codes.add("ETIMEDOUT");
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 64));
  }
  return [...codes];
}

function mediaError(item, error, failures) {
  const post = item.postUrl || item.postId || item.logicalKey || "未知帖子";
  const statuses = [...new Set(failures.map((failure) => failure.status).filter(Boolean))];
  const codes = [...new Set(failures.flatMap(safeErrorCodes))];
  const details = [];
  if (statuses.length) details.push(`尝试 ${failures.length} 个媒体地址，HTTP ${statuses.join("、")}。`);
  if (codes.length) details.push(codes.map((code) => `${NETWORK_ERROR_LABELS[code] || "媒体请求失败"}（${code}）`).join("；"));
  if (Object.hasOwn(MEDIA_ERROR_LABELS, error.code)) details.push(MEDIA_ERROR_LABELS[error.code]);
  const detail = details.join(" ") || "媒体请求失败，请检查网络连接后重试。";
  // Raw transport errors may contain signed URLs, headers, or credentials. Keep
  // only bounded error codes and our own descriptions in both message and cause.
  const safeCause = Object.assign(new Error(detail), { code: codes[0] || error.status });
  const wrapped = new Error(`媒体下载失败（${post}）：${detail}`, { cause: safeCause });
  wrapped.status = error.status;
  wrapped.code = Object.hasOwn(MEDIA_ERROR_LABELS, error.code) ? error.code : codes[0];
  wrapped.networkCodes = codes;
  wrapped.postId = item.postId;
  return wrapped;
}

export async function downloadMediaItem(item, personRoot, scope, { signal, onProgress, fetchMedia, mediaIndex, source } = {}) {
  if (signal?.aborted) throw abortError();
  if (!Object.hasOwn(MEDIA_FOLDERS, item.kind)) throw new Error(`不支持的媒体类型：${item.kind}`);
  // The engine has already verified the person root and storage generation.
  // Standalone fixture callers may use the lazy, root-scoped local fallback.
  if (!mediaIndex) await mkdir(personRoot, { recursive: true });
  const partialPath = path.join(personRoot, `.media-tracker-${randomUUID()}.part`);
  let responseInfo;
  let lastError;
  let selectedSource;
  let attemptedSources = 0;
  const failures = [];

  try {
    const candidates = sourceCandidates(item);
    if (!candidates.length) throw new Error("媒体缺少下载地址。");
    for (const candidate of candidates) {
      // Partial bytes belong to one encoding only; a lower bitrate must start at zero.
      if (attemptedSources > 0) await unlink(partialPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      attemptedSources += 1;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          responseInfo = await fetchToPartial(candidate.sourceUrl, partialPath, signal, onProgress, item.referer, fetchMedia, item.kind);
          selectedSource = candidate;
          lastError = null;
          break;
        } catch (error) {
          // Internal request timeouts are normalized above and remain retryable.
          if (signal?.aborted) throw abortError();
          if (error?.name === "AbortError") throw error;
          lastError = error;
          // Gone CDN variants are permanent failures; do not spend two retries on them.
          if (!retryable(error)) break;
          if (error.status === 416) await unlink(partialPath).catch(() => {});
          if (attempt < 3) await delay(attempt * 1_000, undefined, { signal });
        }
      }
      if (selectedSource) break;
      failures.push(lastError);
      if (!retryable(lastError) && ![404, 410].includes(lastError.status)) break;
    }
    if (lastError) throw mediaError(item, lastError, failures);
    const sourceInfo = {
      sourceUrl: selectedSource.sourceUrl,
      bitrate: selectedSource.bitrate ?? null,
      fallbackUsed: attemptedSources > 1,
      fallbackFrom: attemptedSources > 1 ? candidates[0].sourceUrl : null,
      attemptedSources,
    };

    const sha256 = await sha256File(partialPath, signal);
    const extension = safeExtension(item, responseInfo.contentType);
    const index = mediaIndex || await openPersonMediaIndex({
      id: `standalone-${createHash("sha256").update(path.resolve(personRoot).toLowerCase()).digest("hex")}`,
      name: path.basename(personRoot),
      folderPath: personRoot,
    }, { create: true, signal });
    const result = await index.commitDownloaded({
      partialPath, sha256, bytes: responseInfo.bytes, extension,
      mediaKind: actualMediaKind(item, extension, responseInfo.contentType),
      source: source || {
        platformId: item.platformId || "standalone",
        accountId: "standalone", logicalKey: item.logicalKey || `${item.postId}:${item.mediaIndex}`,
        postId: item.postId, postUrl: item.postUrl, createdAt: item.createdAt, mediaIndex: item.mediaIndex,
        publicationDate: item.publicationDate ?? null, dateBasis: item.dateBasis || "unknown",
        displayTimeZone: item.displayTimeZone ?? null,
      },
    }, { signal });
    return { ...result, ...sourceInfo };
  } catch (error) {
    await unlink(partialPath).catch(() => {});
    throw error;
  }
}

export { MEDIA_FOLDERS };
