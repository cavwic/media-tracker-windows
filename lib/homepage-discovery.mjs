import dns from "node:dns/promises";
import net from "node:net";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const STANDARD_PORTS = new Set(["", "80", "443"]);
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLATFORM_ORDER = Object.freeze({ x: 0, instagram: 1, threads: 2, facebook: 3, tiktok: 4 });
const X_RESERVED = new Set([
  "about", "compose", "explore", "hashtag", "home", "i", "intent", "login", "messages",
  "notifications", "privacy", "search", "settings", "share", "signup", "tos",
]);
const INSTAGRAM_RESERVED = new Set([
  "about", "accounts", "challenge", "developer", "direct", "directory", "explore", "legal",
  "p", "privacy", "reel", "reels", "stories", "web",
]);
const FACEBOOK_RESERVED = new Set([
  "about", "ads", "business", "events", "friends", "gaming", "groups", "help", "home.php",
  "login", "marketplace", "messages", "pages", "photo", "privacy", "reel", "reels", "share",
  "sharer", "story.php", "watch",
]);

export class HomepageDiscoveryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function abortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) void Promise.resolve(operation).catch(() => {});
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function cleanEmbeddedUrl(value) {
  return decodeEntities(value)
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/[),.;]+$/g, "")
    .trim();
}

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.)/, "");
}

function firstPathSegment(url) {
  return decodeURIComponent(url.pathname).split("/").filter(Boolean)[0] || "";
}

function candidate(platformId, label, profileUrl, originalUrl) {
  const platformLabels = { x: "X", instagram: "Instagram", threads: "Threads", facebook: "Facebook", tiktok: "TikTok" };
  return {
    id: `${platformId}:${profileUrl.toLowerCase()}`,
    platformId,
    platformLabel: platformLabels[platformId],
    label,
    profileUrl,
    originalUrl,
    confidence: "high",
    evidence: "个人主页直接链接",
  };
}

export function classifySocialProfile(rawUrl, baseUrl = undefined) {
  let url;
  try {
    url = new URL(cleanEmbeddedUrl(rawUrl), baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;

  const host = normalizeHost(url.hostname);
  const segment = firstPathSegment(url);

  if (host === "x.com" || host === "twitter.com") {
    const handle = segment.replace(/^@/, "");
    if (!X_RESERVED.has(handle.toLowerCase()) && /^[a-z0-9_]{1,15}$/i.test(handle)) {
      return candidate("x", `@${handle}`, `https://x.com/${handle}`, url.href);
    }
  }

  if (host === "instagram.com") {
    const handle = segment.replace(/^@/, "");
    if (!INSTAGRAM_RESERVED.has(handle.toLowerCase()) && /^[a-z0-9._]{1,30}$/i.test(handle)) {
      return candidate("instagram", `@${handle}`, `https://www.instagram.com/${handle}/`, url.href);
    }
  }

  if (host === "threads.com" || host === "threads.net") {
    const handle = segment.startsWith("@") ? segment.slice(1) : "";
    if (/^[a-z0-9._]{1,30}$/i.test(handle)) {
      return candidate("threads", `@${handle}`, `https://www.threads.com/@${handle}`, url.href);
    }
  }

  if (host === "facebook.com" || host === "fb.com") {
    if (url.pathname.toLowerCase() === "/profile.php" && /^\d+$/.test(url.searchParams.get("id") || "")) {
      const id = url.searchParams.get("id");
      return candidate("facebook", `Facebook ID ${id}`, `https://www.facebook.com/profile.php?id=${id}`, url.href);
    }
    const username = segment.replace(/^@/, "");
    if (!FACEBOOK_RESERVED.has(username.toLowerCase()) && /^[a-z0-9.]{3,80}$/i.test(username)) {
      return candidate("facebook", username, `https://www.facebook.com/${username}`, url.href);
    }
  }

  if (host === "tiktok.com") {
    const handle = segment.startsWith("@") ? segment.slice(1) : "";
    if (/^[a-z0-9._-]{2,24}$/i.test(handle)) {
      return candidate("tiktok", `@${handle}`, `https://www.tiktok.com/@${handle}`, url.href);
    }
  }

  return null;
}

export function extractSocialCandidates(html, baseUrl) {
  const source = String(html || "");
  const urls = [];
  const anchorPattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of source.matchAll(anchorPattern)) urls.push(match[1] ?? match[2] ?? match[3] ?? "");

  const normalizedSource = source.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  const embeddedPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const match of normalizedSource.matchAll(embeddedPattern)) urls.push(match[0]);

  return candidatesFromUrls(urls, baseUrl);
}

function candidatesFromUrls(urls, baseUrl) {
  const found = new Map();
  for (const rawUrl of urls) {
    const item = classifySocialProfile(rawUrl, baseUrl);
    if (item && !found.has(item.id)) found.set(item.id, item);
    if (found.size >= 50) break;
  }

  return [...found.values()].sort((left, right) => {
    const platformDelta = PLATFORM_ORDER[left.platformId] - PLATFORM_ORDER[right.platformId];
    return platformDelta || left.label.localeCompare(right.label, "zh-CN");
  });
}

export function normalizeHomepageUrl(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new HomepageDiscoveryError(400, "个人主页网址格式无效。");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HomepageDiscoveryError(400, "个人主页只支持不含账号密码的 HTTP 或 HTTPS 网址。");
  }
  if (!STANDARD_PORTS.has(url.port)) {
    throw new HomepageDiscoveryError(400, "个人主页只允许使用标准的 80 或 443 端口。");
  }
  url.hash = "";
  return url.href;
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function isBlockedAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") || /^fe[89a-f]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

async function assertPublicDestination(url, lookup = dns.lookup, signal) {
  signal?.throwIfAborted();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !STANDARD_PORTS.has(url.port)) {
    throw new HomepageDiscoveryError(400, "个人主页跳转到了不支持或不安全的地址。");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new HomepageDiscoveryError(400, "不能扫描本机或局域网主页地址。");
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new HomepageDiscoveryError(400, "不能扫描本机或局域网主页地址。");
    return;
  }

  let addresses;
  try {
    addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch {
    signal?.throwIfAborted();
    throw new HomepageDiscoveryError(502, "无法解析个人主页域名，请检查网址或网络连接。");
  }
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new HomepageDiscoveryError(400, "不能扫描解析到本机或局域网的主页地址。");
  }
}

async function readLimitedHtml(response, signal) {
  signal?.throwIfAborted();
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_HTML_BYTES) throw new HomepageDiscoveryError(413, "个人主页响应超过 2 MB，已停止分析。");
  if (!response.body) return "";

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new HomepageDiscoveryError(413, "个人主页响应超过 2 MB，已停止分析。");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function extractTitle(html) {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].replace(/\s+/g, " ").trim()).slice(0, 160) : "";
}

function networkErrorCode(error) {
  const source = `${error?.cause?.code || ""} ${error?.code || ""} ${error?.message || ""}`;
  return source.match(/\b(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)\b/)?.[0] || error?.name || "NETWORK_ERROR";
}

async function analyzeWithBundledBrowser(sourceUrl, startUrl, lookup, { signal, browserType = chromium } = {}) {
  signal?.throwIfAborted();
  let browser;
  let launch;
  let closePromise;
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    closePromise ||= browser.close().catch(() => {});
    return closePromise;
  };
  const cancel = () => { void closeBrowser(); };
  let blockedDocumentError = null;
  try {
    signal?.addEventListener("abort", cancel, { once: true });
    launch = browserType.launch({
      headless: true,
      executablePath: BACKGROUND_CHROMIUM_EXECUTABLE,
      args: ["--disable-background-mode", "--disable-background-networking"],
    }).then((launched) => {
      browser = launched;
      if (signal?.aborted) void closeBrowser();
      return launched;
    });
    browser = await abortable(launch, signal);
    signal?.throwIfAborted();
    const context = await abortable(browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
    }), signal);
    signal?.throwIfAborted();
    const checkedHosts = new Set();
    await abortable(context.route("**/*", async (route) => {
      if (signal?.aborted) return route.abort("blockedbyclient").catch(() => {});
      const request = route.request();
      if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
      let target;
      try {
        target = new URL(request.url());
      } catch {
        return route.abort();
      }
      if (["data:", "blob:", "about:"].includes(target.protocol)) return route.continue();
      const destinationKey = `${target.protocol}//${target.host}`;
      try {
        if (!checkedHosts.has(destinationKey)) {
          await assertPublicDestination(target, lookup, signal);
          checkedHosts.add(destinationKey);
        }
        signal?.throwIfAborted();
        return route.continue();
      } catch (error) {
        if (request.isNavigationRequest() && request.frame() === request.frame().page()?.mainFrame()) {
          blockedDocumentError = error;
        }
        return route.abort("blockedbyclient");
      }
    }), signal);

    const page = await abortable(context.newPage(), signal);
    signal?.throwIfAborted();
    let response;
    try {
      response = await abortable(page.goto(startUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (blockedDocumentError) throw blockedDocumentError;
      throw new HomepageDiscoveryError(502, `内置网页内核无法连接个人主页（${networkErrorCode(error)}）。`);
    }
    signal?.throwIfAborted();
    if (blockedDocumentError) throw blockedDocumentError;
    if (response && response.status() >= 400) {
      throw new HomepageDiscoveryError(502, `个人主页返回 HTTP ${response.status()}，暂时无法分析。`);
    }
    await abortable(page.waitForTimeout(1200), signal);
    signal?.throwIfAborted();
    const snapshot = await abortable(page.evaluate(() => ({
      title: document.title,
      links: [...document.querySelectorAll("a[href]")].slice(0, 2000).map((anchor) => anchor.href),
    })), signal);
    signal?.throwIfAborted();
    return {
      sourceUrl,
      finalUrl: page.url(),
      title: String(snapshot.title || "").trim().slice(0, 160),
      scannedAt: new Date().toISOString(),
      candidates: candidatesFromUrls(snapshot.links, page.url()),
      rendered: true,
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
    // A launch can still resolve after cancellation. Wait for its exact browser
    // and close it before reporting completion, never leave an orphan launcher.
    if (launch) await launch.catch(() => {});
    await closeBrowser();
  }
}

export async function analyzeHomepage(value, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookup = options.lookup || dns.lookup;
  const sourceUrl = normalizeHomepageUrl(value);
  const browserFallback = options.browserFallback !== false && (!options.fetchImpl || Boolean(options.browserType));
  let currentUrl = new URL(sourceUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicDestination(currentUrl, lookup, signal);
    let response;
    try {
      const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
      response = await abortable(fetchImpl(currentUrl, {
        redirect: "manual",
        signal: fetchSignal,
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": BROWSER_USER_AGENT,
        },
      }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof HomepageDiscoveryError) throw error;
      const directCode = networkErrorCode(error);
      if (browserFallback) {
        try {
          return await analyzeWithBundledBrowser(sourceUrl, currentUrl, lookup, options);
        } catch (browserError) {
          signal?.throwIfAborted();
          if (browserError instanceof HomepageDiscoveryError && browserError.status < 500) throw browserError;
          const browserCode = networkErrorCode(browserError);
          throw new HomepageDiscoveryError(
            502,
            `本机网络无法连接该个人主页（普通请求：${directCode}；内置网页内核：${browserCode}）。请确认该网址能在不依赖浏览器扩展的网络环境中打开，或启用对独立应用生效的系统代理/VPN。`,
          );
        }
      }
      throw new HomepageDiscoveryError(502, `无法读取个人主页（${directCode}），请检查网络、网址或对方网站的访问限制。`);
    }
    signal?.throwIfAborted();

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new HomepageDiscoveryError(502, "个人主页返回了无目标地址的跳转。");
      if (redirectCount === MAX_REDIRECTS) throw new HomepageDiscoveryError(502, "个人主页跳转次数过多，已停止分析。");
      currentUrl = new URL(location, currentUrl);
      if (!['http:', 'https:'].includes(currentUrl.protocol)) {
        throw new HomepageDiscoveryError(400, "个人主页跳转到了不支持的地址类型。");
      }
      continue;
    }

    if (!response.ok) {
      // Public edition respects an explicit HTTP refusal/rate limit. A browser
      // fallback remains available for ordinary transport and client-rendered
      // pages, but not as an alternate path after an access-control response.
      throw new HomepageDiscoveryError(502, `个人主页返回 HTTP ${response.status}，暂时无法分析。`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new HomepageDiscoveryError(415, "该地址不是可分析的网页。");
    }

    const html = await readLimitedHtml(response, signal);
    signal?.throwIfAborted();
    const result = {
      sourceUrl,
      finalUrl: currentUrl.href,
      title: extractTitle(html),
      scannedAt: new Date().toISOString(),
      candidates: extractSocialCandidates(html, currentUrl.href),
    };
    if (browserFallback && result.candidates.length === 0) {
      try {
        return await analyzeWithBundledBrowser(sourceUrl, currentUrl, lookup, options);
      } catch {
        signal?.throwIfAborted();
        return result;
      }
    }
    signal?.throwIfAborted();
    return result;
  }

  throw new HomepageDiscoveryError(502, "个人主页分析未完成。");
}
