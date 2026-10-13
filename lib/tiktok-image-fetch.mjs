import { acquireTikTokPage } from "./tiktok-browser.mjs";

const CDN_DOMAINS = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktok.com", "tiktokv.com",
  "ibytedtos.com", "ibyteimg.com", "byteoversea.com", "muscdn.com", "musical.ly"];
const IMAGE_MIME = /^image\/(?:jpe?g|png|gif|webp|avif|bmp|x-ms-bmp|tiff|hei[cf]|x-icon|vnd\.microsoft\.icon)$/i;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export function validateTikTokImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      && CDN_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function imageError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function transportError(error) {
  const code = String(error?.netErrorName || error?.message || "").match(/\b(?:net::)?(ERR_[A-Z0-9_]{1,70})\b/)?.[1];
  return imageError(code || "ERR_TIKTOK_IMAGE_TRANSPORT",
    `TikTok 图片连接失败${code ? `（${code}）` : ""}，请稍后重试。`);
}

function abortError(signal) {
  return signal?.reason?.name === "TimeoutError"
    ? new DOMException("TikTok 图片请求超时。", "TimeoutError")
    : new DOMException("TikTok 图片下载已取消。", "AbortError");
}

async function settleBounded(operation, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Use an ordinary browser navigation intercepted BEFORE committing the response.
// Network.loadNetworkResource cannot be used here: it follows redirects outside
// Fetch interception, preventing us from blocking a private/unknown destination.
export function createTikTokImageFetch({ profileDirectory, acquirePage = acquireTikTokPage,
  maxImageBytes = MAX_IMAGE_BYTES, requestTimeoutMs = 90_000 } = {}) {
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > MAX_IMAGE_BYTES) throw new Error("Invalid image byte limit.");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("Invalid image timeout.");
  const lifetime = new AbortController();
  let sessionPromise;
  let sessionOwner;
  let pendingSetup;
  let active;
  let disposed = false;
  let disposePromise;

  const retireOwner = (owner) => {
    if (!owner) return Promise.resolve();
    if (owner.retirement) return owner.retirement;
    owner.retired = true;
    if (sessionOwner === owner) {
      sessionOwner = null;
      if (sessionPromise === owner.operation) sessionPromise = null;
    }
    owner.cdp?.off("Fetch.requestPaused", owner.onPaused);
    owner.cdp?.off("Network.loadingFailed", owner.onNetworkFailed);
    owner.controller.abort();
    owner.retirement = (async () => {
      // Close this work tab before detaching interception. In particular, an
      // HTML/error response must not start rendering when interception ends.
      await settleBounded(owner.lease.release(), 5_000);
      if (owner.cdp) await settleBounded(owner.cdp.detach());
    })();
    return owner.retirement;
  };

  const finish = (transfer, error, successfulEof = false) => {
    if (transfer.cleanup) return transfer.cleanup;
    transfer.closed = true;
    clearTimeout(transfer.timer);
    transfer.signal?.removeEventListener("abort", transfer.onAbort);
    if (error) {
      transfer.reject(error);
      try { transfer.controller?.error(error); } catch {}
    }
    transfer.cleanup = (async () => {
      const owner = transfer.owner;
      const cdp = owner?.cdp;
      for (const requestId of transfer.requestIds) owner?.tombstones.add(requestId);
      const commands = [];
      if (cdp && transfer.handle) commands.push(settleBounded(cdp.send("IO.close", { handle: transfer.handle })));
      if (cdp && transfer.requestId) commands.push(settleBounded(cdp.send("Fetch.failRequest", { requestId: transfer.requestId, errorReason: "Aborted" })));
      if (cdp && transfer.navigationStarted) commands.push(settleBounded(cdp.send("Page.stopLoading")));
      const confirmed = (await Promise.all(commands)).every(Boolean);
      // A failed/cancelled navigation can emit events after its abort. Retire
      // that tab, giving the next image a different CDP target and owner epoch.
      if (owner && (!successfulEof || !confirmed || disposed)) await retireOwner(owner);
      if (!owner && pendingSetup) {
        const setup = pendingSetup;
        setup.controller.abort();
        await settleBounded(setup.promise, 5_000);
      }
      if (active === transfer) active = null;
    })();
    return transfer.cleanup;
  };

  const handlePaused = async (owner, event) => {
    const cdp = owner.cdp;
    const transfer = active;
    if (owner.retired || owner !== sessionOwner || !transfer || transfer.closed || transfer.owner !== owner
      || owner.tombstones.has(event.requestId)) {
      await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => {});
      return;
    }
    try {
      const isRequest = event.responseStatusCode == null && !event.responseErrorReason;
      if (isRequest) {
        if (event.request.url !== transfer.expectedUrl) {
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
          return;
        }
        transfer.expectedUrl = null;
        transfer.requestIds.add(event.requestId);
      } else if (!transfer.requestIds.has(event.requestId)) {
        await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => {});
        return;
      }
      transfer.requestId = event.requestId;
      if (event.networkId) transfer.networkIds.add(event.networkId);
      if (!validateTikTokImageUrl(event.request.url) || event.request.method !== "GET"
        || !["Document", "Image"].includes(event.resourceType)) {
        throw imageError("tiktok-image-redirect-blocked", "TikTok 图片请求或跳转地址不在允许的媒体域名内，已停止下载。");
      }
      if (event.responseErrorReason) {
        throw transportError({ netErrorName: `ERR_${String(event.responseErrorReason).replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}` });
      }
      if (isRequest) {
        // Do not forward downloader headers (including Range or credentials).
        // Chromium supplies its own current session and domain-scoped cookies.
        await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        return;
      }
      const status = event.responseStatusCode;
      const headers = new Headers((event.responseHeaders || []).map(({ name, value }) => [name, value]));
      if ([301, 302, 303, 307, 308].includes(status)) {
        let destination;
        try { if (headers.get("location")) destination = new URL(headers.get("location"), event.request.url); } catch {}
        if (!destination || !validateTikTokImageUrl(destination.href) || ++transfer.redirects > 5) {
          throw imageError("tiktok-image-redirect-blocked", "TikTok 图片跳转到了不允许的地址或跳转次数过多，已停止下载。");
        }
        destination.hash = "";
        transfer.expectedUrl = destination.href;
        await cdp.send("Fetch.continueResponse", { requestId: event.requestId });
        return;
      }
      if (status !== 200) throw imageError("ERR_TIKTOK_IMAGE_HTTP", `TikTok 图片服务器返回 HTTP ${status}。`, status);
      if (headers.has("content-range")) throw imageError("unexpected-content-range", "TikTok 图片返回了非完整响应，已停止下载。");
      const mime = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_MIME.test(mime)) throw imageError("unexpected-media-content", "TikTok 图片请求返回了网页或非图片内容，请检查登录或页面验证。");
      const announcedBytes = Number(headers.get("content-length"));
      if (headers.has("content-length") && announcedBytes > maxImageBytes) {
        throw imageError("tiktok-image-too-large", "TikTok 单张图片超过 64 MiB 下载上限，已停止下载。");
      }
      const encoding = (headers.get("content-encoding") || "identity").trim().toLowerCase();
      transfer.expectedBytes = headers.has("content-length") && /^\d+$/.test(headers.get("content-length"))
        && encoding === "identity" ? announcedBytes : null;
      const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId: event.requestId });
      if (transfer.closed) {
        await settleBounded(cdp.send("IO.close", { handle: stream }));
        return;
      }
      transfer.handle = stream;
      const body = new ReadableStream({
        start(controller) { transfer.controller = controller; },
        async pull(controller) {
          if (transfer.closed) return;
          try {
            const chunk = await cdp.send("IO.read", { handle: stream, size: CHUNK_BYTES });
            if (transfer.closed) return;
            const bytes = Buffer.from(chunk.data || "", chunk.base64Encoded ? "base64" : "utf8");
            transfer.bytes += bytes.byteLength;
            if (transfer.bytes > maxImageBytes) throw imageError("tiktok-image-too-large", "TikTok 单张图片超过 64 MiB 下载上限，已停止下载。");
            if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            if (chunk.eof) {
              if (!transfer.bytes) throw imageError("unexpected-media-content", "TikTok 图片响应为空，未保存文件。");
              if (transfer.expectedBytes != null && transfer.bytes !== transfer.expectedBytes) {
                throw imageError("ERR_CONTENT_LENGTH_MISMATCH", "TikTok 图片传输长度不完整，请重试。");
              }
              await finish(transfer, null, true);
              controller.close();
            }
          } catch (error) {
            if (!transfer.closed) await finish(transfer, error.code ? error : transportError(error));
          }
        },
        async cancel() { await finish(transfer); },
      }, { highWaterMark: 0 });
      // Always a whole image. An existing partial file must be overwritten;
      // this transport never invents a 206 response or a Content-Range header.
      transfer.resolve(new Response(body, { status: 200, headers: { "content-type": mime } }));
    } catch (error) {
      if (!transfer.closed) await finish(transfer, error.code ? error : transportError(error));
    }
  };

  const ensureSession = async () => {
    if (sessionOwner && !sessionOwner.retired) {
      if (!sessionOwner.lease.page.isClosed?.()) return sessionOwner;
      await retireOwner(sessionOwner);
    }
    if (sessionPromise) return sessionPromise;
    const setup = { controller: new AbortController(), promise: null };
    pendingSetup = setup;
    const operation = (async () => {
      const acquired = await acquirePage({ profileDirectory,
        signal: AbortSignal.any([lifetime.signal, setup.controller.signal]), purpose: "download" });
      if (disposed || setup.controller.signal.aborted) { await acquired.release(); throw abortError(setup.controller.signal); }
      const owner = { lease: acquired, controller: setup.controller, cdp: null,
        retired: false, retirement: null, tombstones: new Set(), operation };
      try {
        owner.cdp = await acquired.context.newCDPSession(acquired.page);
        owner.onPaused = (event) => { void handlePaused(owner, event); };
        owner.onNetworkFailed = (event) => {
          if (active && active.owner === owner && !active.closed && active.networkIds.has(event.requestId)) {
            void finish(active, transportError({ netErrorName: event.errorText }));
          }
        };
        owner.cdp.on("Fetch.requestPaused", owner.onPaused);
        owner.cdp.on("Network.loadingFailed", owner.onNetworkFailed);
        await owner.cdp.send("Network.enable");
        await owner.cdp.send("Fetch.enable", { patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "*", requestStage: "Response" },
        ] });
        await owner.cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        if (disposed || setup.controller.signal.aborted) throw abortError(setup.controller.signal);
        sessionOwner = owner;
        return owner;
      } catch (error) {
        await retireOwner(owner);
        throw error;
      }
    })().catch((error) => {
      if (sessionPromise === operation) sessionPromise = null;
      throw error;
    }).finally(() => { if (pendingSetup === setup) pendingSetup = null; });
    setup.promise = operation;
    sessionPromise = operation;
    return operation;
  };

  const fetchImage = async (url, options = {}) => {
    if (disposed) throw imageError("ERR_TIKTOK_FETCH_DISPOSED", "TikTok 图片下载会话已结束。");
    if (!validateTikTokImageUrl(url)) throw imageError("tiktok-image-redirect-blocked", "TikTok 图片地址不在允许的媒体域名内。");
    if (options.mediaKind && !["image", "gif"].includes(options.mediaKind)) throw imageError("unexpected-media-content", "此下载通道仅用于 TikTok 图片。");
    if (options.signal?.aborted) throw abortError(options.signal);
    if (active?.closed) await active.cleanup;
    if (disposed) throw imageError("ERR_TIKTOK_FETCH_DISPOSED", "TikTok 图片下载会话已结束。");
    if (options.signal?.aborted) throw abortError(options.signal);
    if (active) throw imageError("EBUSY", "TikTok 图片下载通道正在使用，请等待当前图片结束。");
    const imageUrl = new URL(url);
    imageUrl.hash = "";
    let resolve, reject;
    const response = new Promise((yes, no) => { resolve = yes; reject = no; });
    const transfer = { resolve, reject, signal: options.signal, handle: null, requestId: null,
      bytes: 0, redirects: 0, closed: false, navigationStarted: false, cleanup: null,
      owner: null, expectedUrl: imageUrl.href, requestIds: new Set(), networkIds: new Set() };
    active = transfer;
    transfer.onAbort = () => { void finish(transfer, abortError(options.signal)); };
    options.signal?.addEventListener("abort", transfer.onAbort, { once: true });
    transfer.timer = setTimeout(() => { void finish(transfer, new DOMException("TikTok 图片请求超时。", "TimeoutError")); }, requestTimeoutMs);
    void (async () => {
      const owner = await ensureSession();
      if (transfer.closed || disposed) return;
      transfer.owner = owner;
      transfer.navigationStarted = true;
      // Response-stage interception consumes images without committing them to
      // the page. HTML/JS is rejected before it can execute in the work tab.
      await owner.lease.page.goto(imageUrl.href, { waitUntil: "commit", timeout: 0 });
    })().catch((error) => {
      if (!transfer.closed) void finish(transfer, transportError(error));
    });
    return response;
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    lifetime.abort();
    disposePromise = (async () => {
      if (active) await finish(active, abortError(lifetime.signal));
      if (sessionPromise) await settleBounded(sessionPromise, 5_000);
      if (sessionOwner) await retireOwner(sessionOwner);
    })();
    return disposePromise;
  };

  return { fetchImage, dispose };
}
