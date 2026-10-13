import dns from "node:dns/promises";
import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { sanitizeSegment } from "./archive.mjs";
import { readCustomLoginSnapshot } from "./custom-login.mjs";
import { assertCustomPublicUrl, validateTargetUrl } from "./platform-registry.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
const abortError = () => Object.assign(failure("cancelled", "已取消读取关注列表。"), { name: "AbortError" });
const cleanText = (value, length = 200) => String(value || "").replace(/[\x00-\x1f]/g, " ").trim().slice(0, length);
const LOGIN_PATH = /\/(?:login|signin|sign-in|passport|checkpoint|challenge|captcha)(?:[/?#]|$)/i;
const NAVIGATION_SEGMENT = /^(?:home|login|logout|signin|signup|register|settings|following|followings|followers|friends|subscriptions|search|explore|feed|news|notifications|messages|privacy|terms|help|about)$/i;
const POST_SEGMENT = /^(?:posts?|status|photos?|videos?|reels?|stories|articles?|comments?)$/i;
const SENSITIVE_QUERY = /^(?:token|access_token|refresh_token|id_token|auth|auth_token|authorization|session|session_id|sessionid|sid|password|passwd|secret|api_key|apikey|oauth_token|code|client_secret|csrf_token)$/i;
const PAGINATION_QUERY = /^(?:page|p|cursor|max_id|next_max_id|offset|limit|after|before|start|index)$/i;

// A custom website need not use @handles. Its complete, canonical same-site
// profile URL is its stable identity; display names never invent a URL.
export function canonicalCustomFollowingAccount(platform, input = {}) {
  if (!platform?.custom || !platform.id || !input || typeof input !== "object") return null;
  const source = input.profileUrl || input.url;
  if (typeof source !== "string" || !/^https:\/\//i.test(source)) return null;
  let url;
  try { url = new URL(validateTargetUrl(platform, source)); } catch { return null; }
  let parts;
  try { parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part)); } catch { return null; }
  if (!parts.length || parts.some(part => NAVIGATION_SEGMENT.test(part) || POST_SEGMENT.test(part))) return null;
  if ([...url.searchParams.keys()].some(key => SENSITIVE_QUERY.test(key))) return null;
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid|ref|referrer|source)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "");
  // Treat the configured www alias as one site, not two copies of a person.
  url.hostname = new URL(platform.homepageUrl).hostname.toLowerCase();
  let label;
  label = parts.at(-1);
  const queryId = url.searchParams.get("id") || url.searchParams.get("user") || url.searchParams.get("username");
  if (queryId) label += `_${queryId}`;
  try { label = sanitizeSegment(label, "账号名称"); } catch { return null; }
  if (!label || url.href === new URL(platform.followingUrl || platform.homepageUrl).href) return null;
  return { platformId: platform.id, handle: url.href, label,
    displayName: cleanText(input.displayName || input.name), profileUrl: url.href };
}

// Runs in the actual page. Only rows of a specifically identified following
// list are candidates. This does not inspect every anchor or every user object.
function readCustomFollowingRows() {
  const visible = (element) => {
    if (!element) return false;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const text = element => (element?.innerText || element?.getAttribute("aria-label") || "").trim();
  const ownFollowing = /^(?:Following|Followings|Subscriptions|关注|已关注|正在关注|关注列表|我的关注|关注的人)$/i;
  const emptyFollowing = /^(?:No followed accounts|No subscriptions yet|You(?:['’]re| are) not following anyone|You (?:aren['’]t|are not) following anyone|You haven['’]t followed anyone(?: yet)?|暂无关注|尚未关注任何人|(?:你|您)还没有关注任何人)[.!。！\s]*$/i;
  const wrong = /followers|recommend|suggest|feed|timeline|粉丝|推荐|猜你喜欢/i;
  const excluded = element => {
    if (element.closest('nav, [role="navigation"], article, [role="article"], [data-post], [data-testid="tweet"]')) return true;
    for (let parent = element; parent && !["BODY", "HTML"].includes(parent.tagName); parent = parent.parentElement) {
      if (wrong.test(`${parent.id || ""} ${parent.className || ""} ${parent.getAttribute("aria-label") || ""}`)) return true;
    }
    return false;
  };
  const listElements = [...document.querySelectorAll('ul, ol, [role="list"], [data-following-list], [id], [class]')]
    .filter(element => visible(element) && !excluded(element));
  const isExplicit = (element) => {
    const semantic = `${element.id || ""} ${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-testid") || ""}`;
    if (wrong.test(semantic)) return false;
    return element.hasAttribute("data-following-list") || /(?:^|[\s_-])(?:following|followings|subscriptions)(?:[\s_-]|$)/i.test(semantic)
      || ownFollowing.test(element.getAttribute("aria-label") || "");
  };
  let root = listElements.find(element => isExplicit(element) && (element.matches('ul, ol, [role="list"], [data-following-list]')
    || element.querySelector('li, [role="listitem"]') || emptyFollowing.test(text(element))));
  if (!root) {
    // A dedicated list named by its visible heading is also valid. Merely
    // being on the configured URL does not make an unrelated list trustworthy.
    const scope = [...document.querySelectorAll('main, [role="main"], [role="dialog"], section')]
      .filter(element => visible(element) && !excluded(element));
    for (const container of scope) {
      const heading = [...container.querySelectorAll('h1, h2, h3, [role="heading"]')].find(element => visible(element) && ownFollowing.test(text(element)));
      if (!heading) continue;
      const candidates = [...container.querySelectorAll('ul, ol, [role="list"]')]
        .filter(element => visible(element) && !excluded(element) && !wrong.test(`${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`));
      if (candidates.length === 1) { root = candidates[0]; break; }
    }
  }
  if (!root) return { url: location.href, scoped: false, links: [], explicitEnd: false, emptyConfirmed: false };
  const links = [];
  const visibleRows = [...root.querySelectorAll('li, [role="listitem"]')].filter(row => visible(row) && !excluded(row));
  const accountRows = visibleRows.filter(row => !(emptyFollowing.test(text(row)) && !row.querySelector('a[href], button, [role="button"]')));
  for (const row of accountRows) {
    if (!visible(row) || excluded(row)) continue;
    let parent = row;
    let rejected = false;
    while (parent && parent !== root) {
      if (wrong.test(`${parent.id || ""} ${parent.className || ""} ${parent.getAttribute("aria-label") || ""}`)) rejected = true;
      parent = parent.parentElement;
    }
    if (rejected || /^(?:Suggested for you|Recommended|为你推荐|推荐关注)/i.test(text(row))) continue;
    const actions = [...row.querySelectorAll('button, [role="button"]')].filter(visible).map(text);
    if (actions.some(value => /^(?:Follow|Follow back|关注|回关)$/i.test(value))) continue;
    // Non-semantic site rows may include actions; absent buttons are allowed
    // only because the surrounding explicit semantic following list is proof.
    if (actions.length && !actions.some(value => /^(?:Following|Requested|Subscribed|Friends|已关注|正在关注|已请求|好友|已订阅)$/i.test(value))) continue;
    const anchors = [...row.querySelectorAll('a[href]')].filter(element => visible(element) && !excluded(element));
    // Multiple distinct profile-like destinations in one row are ambiguous:
    // prefer the row's profile-labelled/name/avatar link, never all anchors.
    const anchor = anchors.find(element => element.getAttribute("rel") === "author"
      || /profile|user|member|account/i.test(element.getAttribute("data-testid") || "")
      || element.querySelector('img')) || anchors.find(element => text(element));
    if (anchor) links.push({ profileUrl: anchor.href, displayName: text(anchor) });
  }
  const tail = text(root).slice(-1500);
  // A terminal list marker alone proves no next page, not that account rows
  // were successfully understood. Confirm zero only from an explicit empty
  // following statement/count with no actual visible account rows or links.
  const emptyStatement = [root, ...root.querySelectorAll('p, span, div, li, [role="status"]')]
    .some(element => visible(element) && !excluded(element) && emptyFollowing.test(text(element)));
  const visibleAnchors = [...root.querySelectorAll('a[href]')].filter(element => visible(element) && !excluded(element));
  const emptyConfirmed = accountRows.length === 0 && links.length === 0 && visibleAnchors.length === 0
    && (emptyStatement || root.getAttribute("data-following-count") === "0");
  const explicitEnd = emptyConfirmed || /(?:^|\n)(?:No more (?:users|accounts)|You've reached the end|All (?:users|accounts) (?:shown|loaded)|没有更多(?:用户|账号)|已显示全部)(?:\n|$)/i.test(tail)
    || root.getAttribute("data-has-more") === "false"
    || [...root.querySelectorAll('[data-list-end="true"]')].some(visible);
  const scrollers = [root, ...root.querySelectorAll("div")].filter(element => visible(element)
    && /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 5);
  const scroller = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (scroller) scroller.scrollBy(0, Math.max(scroller.clientHeight * .85, 450));
  else window.scrollBy(0, Math.max(innerHeight * .85, 600));
  return { url: location.href, scoped: true, links, explicitEnd, emptyConfirmed };
}

function checkLoginSnapshot(platform, snapshot, { requireMarker = false } = {}) {
  try { validateTargetUrl(platform, snapshot.url); }
  catch { throw failure("following-url-unsafe", "关注页面跳转到了其他网站，已停止读取。"); }
  if (snapshot.invalidSelector || snapshot.rootMarker) throw failure("login-rule-invalid", "此平台的登录验证标记无效，请修改平台设置。");
  if (snapshot.challenge || snapshot.hasCredentialForm || snapshot.loggedOut || LOGIN_PATH.test(snapshot.url)) {
    throw failure("login-required", "关注页面要求登录或平台验证，请先在“我的账号”完成登录验证。");
  }
  return !requireMarker || snapshot.loggedIn;
}

function assertFollowingLocation(platform, configured, actual) {
  let expected, current;
  try { expected = new URL(validateTargetUrl(platform, configured)); current = new URL(validateTargetUrl(platform, actual)); }
  catch { throw failure("following-url-unsafe", "关注页面跳转到了其他网站，已停止读取。"); }
  const mismatch = () => { throw failure("following-list-unavailable", "自定义平台未保持在配置的当前账号关注页，已停止读取。"); };
  if (expected.pathname.replace(/\/+$/, "") !== current.pathname.replace(/\/+$/, "")) mismatch();
  // Only known pagination keys may change. Preserve configured owner IDs and
  // never accept an added ?user=/uid=/id= that changes whose list is read.
  for (const key of new Set([...expected.searchParams.keys(), ...current.searchParams.keys()])) {
    if (PAGINATION_QUERY.test(key)) continue;
    if (JSON.stringify(expected.searchParams.getAll(key)) !== JSON.stringify(current.searchParams.getAll(key))) mismatch();
  }
}

export async function discoverCustomFollowing({ platform, linkedAccount, signal, onProgress, browserType = chromium,
  lookup = dns.lookup, navigationTimeoutMs = 12_000, maxDurationMs = 90_000, maxPages = 150,
  maxAccounts = 10_000, settleMs = 700, cleanupTimeoutMs = 3000 } = {}) {
  if (!platform?.custom) throw failure("unsupported-platform", "请选择已配置的自定义平台。");
  if (!platform.followingUrl) throw failure("following-url-required", "请先在平台设置中添加此自定义平台的关注页，再读取关注列表。");
  const followingUrl = validateTargetUrl(platform, platform.followingUrl);
  if (!linkedAccount?.profileDirectory || linkedAccount.platformId !== platform.id) throw failure("login-required", "请选择这个平台已经绑定的登录账号。");
  if (!platform.loginMarker) throw failure("login-rule-required", "请在平台设置中配置此自定义平台的登录验证标记。");
  signal?.throwIfAborted();
  navigationTimeoutMs = Math.min(15_000, Math.max(0, Number(navigationTimeoutMs) || 0));
  maxDurationMs = Math.min(180_000, Math.max(1000, Number(maxDurationMs) || 90_000));
  maxPages = Math.min(1000, Math.max(1, Number(maxPages) || 150));
  maxAccounts = Math.min(50_000, Math.max(1, Number(maxAccounts) || 10_000));
  settleMs = Math.min(3000, Math.max(0, Number(settleMs) || 0));
  cleanupTimeoutMs = Math.min(10_000, Math.max(20, Number(cleanupTimeoutMs) || 3000));
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const accounts = new Map();
  let context, page, closePromise, timedOut = false, blockedDocument = false;
  const finish = (completeness, message, emptyConfirmed = false) => ({ accounts: [...accounts.values()], completeness, message,
    emptyConfirmed: accounts.size === 0 && completeness === "complete" && emptyConfirmed === true,
    observedCount: accounts.size, selfProfileUrl: "", matchedResponses: 0 });
  const close = () => context ? closePromise ||= context.close() : Promise.resolve();
  const boundedClose = async operation => {
    let timer;
    try { await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Close timeout")), cleanupTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const disposeConfirmed = async () => {
    try { await boundedClose(close()); }
    catch {
      const browser = context?.browser?.();
      let confirmed = browser?.isConnected?.() === false;
      if (!confirmed && browser) { try { await boundedClose(browser.close()); confirmed = browser.isConnected?.() !== true; } catch {} }
      if (!confirmed) throw Object.assign(failure("browser-close-failed", "后台登录会话未能确认关闭，请完全退出工具后重试。"),
        { retainProfileLease: true, retryDispose: async () => { closePromise = null; await disposeConfirmed(); } });
    }
  };
  const cancel = () => { void close().catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, maxDurationMs);
  timer.unref?.();
  workSignal.addEventListener("abort", cancel, { once: true });
  const checkPublic = async value => {
    workSignal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(abortError()); workSignal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([assertCustomPublicUrl(value, lookup), cancelled]); }
    finally { workSignal.removeEventListener("abort", abort); }
  };
  try {
    await checkPublic(followingUrl);
    const verificationUrl = validateTargetUrl(platform, platform.verificationUrl || platform.homepageUrl);
    await checkPublic(verificationUrl);
    workSignal.throwIfAborted();
    context = await browserType.launchPersistentContext(linkedAccount.profileDirectory, { headless: true, serviceWorkers: "block",
      executablePath: BACKGROUND_CHROMIUM_EXECUTABLE, timeout: 15_000, viewport: { width: 1280, height: 900 },
      args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"] });
    if (workSignal.aborted) throw abortError();
    page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().slice(1)) await extra.close();
    context.on?.("page", extra => { if (extra !== page) void extra.close().catch(() => {}); });
    await context.route("**/*", async route => {
      const request = route.request();
      const navigation = request.isNavigationRequest();
      try {
        workSignal.throwIfAborted();
        if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
        if (navigation) validateTargetUrl(platform, request.url());
        // Redirects and every network subresource are checked, not just the
        // first hostname. Existing cookies stay inside their browser profile.
        await checkPublic(request.url());
        workSignal.throwIfAborted();
        await route.continue();
      } catch {
        if (navigation && request.frame() === page.mainFrame()) blockedDocument = true;
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    // HTTP routing does not guard WebSockets. A generic read-only collector
    // does not need them, so no site may use a socket to reach private hosts.
    if (typeof context.routeWebSocket === "function") await context.routeWebSocket("**/*", socket => socket.close());
    const navigate = async url => {
      let response;
      try { response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); }
      catch (error) { if (blockedDocument) throw failure("following-url-unsafe", "关注页面尝试访问其他网站或非公网地址，已停止读取。"); throw error; }
      if (blockedDocument) throw failure("following-url-unsafe", "关注页面尝试访问其他网站或非公网地址，已停止读取。");
      if (response?.status() >= 400) throw failure("platform-unavailable", "自定义平台页面暂不可访问，请稍后重试。");
      workSignal.throwIfAborted();
    };
    await navigate(verificationUrl);
    const deadline = Date.now() + navigationTimeoutMs;
    for (;;) {
      const snapshot = await readCustomLoginSnapshot(page, platform);
      workSignal.throwIfAborted();
      if (checkLoginSnapshot(platform, snapshot, { requireMarker: true })) break;
      if (Date.now() >= deadline) throw failure("login-required", "未找到此平台已验证的登录后标记，请在“我的账号”验证登录。");
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    await navigate(followingUrl);
    let stagnant = 0, lastCount = -1, foundScope = false;
    for (let round = 0; round < maxPages; round += 1) {
      await page.waitForTimeout(settleMs);
      workSignal.throwIfAborted();
      const login = await readCustomLoginSnapshot(page, platform);
      checkLoginSnapshot(platform, login);
      assertFollowingLocation(platform, followingUrl, login.url);
      const rows = await page.evaluate(readCustomFollowingRows);
      workSignal.throwIfAborted();
      assertFollowingLocation(platform, followingUrl, rows.url);
      foundScope ||= rows.scoped;
      for (const item of rows.scoped ? rows.links || [] : []) {
        const record = canonicalCustomFollowingAccount(platform, item);
        if (!record || accounts.has(record.handle) || accounts.size >= maxAccounts) continue;
        await checkPublic(record.profileUrl);
        workSignal.throwIfAborted();
        accounts.set(record.handle, record);
      }
      onProgress?.({ accounts: [...accounts.values()], observedCount: accounts.size, message: `已读取 ${accounts.size} 个已关注账号。` });
      if (rows.scoped && rows.explicitEnd && accounts.size < maxAccounts) {
        const confirmedZero = rows.emptyConfirmed === true && Array.isArray(rows.links) && rows.links.length === 0;
        if (!accounts.size && !confirmedZero) throw failure("following-list-unavailable", "关注页尚未提供可识别的账号，也没有确认关注列表为空；请检查关注页或手动添加账号。");
        return finish("complete", `已读取关注页中的 ${accounts.size} 个账号，请选择需要导入的账号。`, confirmedZero);
      }
      if (accounts.size >= maxAccounts) return finish("partial", "已达到本次读取上限；可先选择导入已读取账号。");
      stagnant = accounts.size === lastCount ? stagnant + 1 : 0;
      lastCount = accounts.size;
      if (stagnant >= 5) break;
    }
    if (!foundScope || !accounts.size) throw failure("following-list-unavailable", "此关注页未提供可识别的已关注列表；请检查地址，或手动添加目标账号。不同网站的页面结构可能需要专用适配。");
    return finish("partial", `已读取 ${accounts.size} 个账号，但关注页未确认完整返回；可先选择导入这些账号。`);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut && accounts.size) return finish("partial", "本次读取超时；可先选择导入已读取账号。");
    if (timedOut) throw failure("following-list-unavailable", "读取超时，关注页尚未提供可识别的已关注列表。请稍后重试或手动添加。");
    if (accounts.size) return finish("partial", "后续读取未完成；可先选择导入已读取账号。");
    if (/ProcessSingleton|user data directory is already in use|profile.*in use/i.test(String(error?.message))) throw failure("profile-busy", "该登录资料正在使用中，请关闭登录窗口或等待任务结束。");
    throw error;
  } finally {
    clearTimeout(timer);
    workSignal.removeEventListener("abort", cancel);
    await disposeConfirmed();
  }
}

