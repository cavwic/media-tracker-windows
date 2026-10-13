import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { acquireTikTokPage as acquireBackgroundTikTokPage } from "./tiktok-browser.mjs";
import { assembleFacebookResponse, parseFacebookResponseText } from "./facebook-media.mjs";

const HOMES = Object.freeze({ x: "https://x.com/home", instagram: "https://www.instagram.com/",
  facebook: "https://www.facebook.com/", threads: "https://www.threads.com/", tiktok: "https://www.tiktok.com/" });
const HOSTS = Object.freeze({ x: ["x.com", "twitter.com"], instagram: ["instagram.com"],
  facebook: ["facebook.com", "web.facebook.com"], threads: ["threads.com", "threads.net"], tiktok: ["tiktok.com"] });
const RESERVED = new Set(["home", "explore", "search", "settings", "login", "logout", "signup", "accounts", "direct", "inbox",
  "messages", "notifications", "activity", "reels", "reel", "p", "tv", "about", "privacy", "help", "i", "intent", "compose",
  "friends", "groups", "pages", "watch", "marketplace", "gaming", "events", "photo", "photos", "videos", "stories", "me", "share",
  "photo.php", "video.php", "story.php", "permalink.php"]);
const abortError = () => Object.assign(new Error("已取消读取关注列表。"), { name: "AbortError", code: "cancelled" });
const failure = (code, message) => Object.assign(new Error(message), { code });
const cleanText = (value, length = 200) => String(value || "").replace(/[\x00-\x1f]/g, " ").trim().slice(0, length);
const platformKey = (platform) => typeof platform === "string" ? platform : platform?.id;
const safeHost = (id, url) => url.protocol === "https:" && !url.username && !url.password && !url.port
  && HOSTS[id]?.includes(url.hostname.toLowerCase().replace(/^www\./, ""));

// This is also used by the job manager to validate incremental results before
// exposing them. No arbitrary href, script URL or login directory is returned.
export function canonicalFollowingAccount(platform, input = {}) {
  const id = platformKey(platform);
  if (!HOSTS[id] || !input || typeof input !== "object") return null;
  let handle = cleanText(input.handle || input.username || input.uniqueId || input.screen_name, 100).replace(/^@/, "");
  let url;
  if (input.profileUrl || input.url) {
    try { url = new URL(input.profileUrl || input.url, HOMES[id]); } catch { return null; }
    if (!safeHost(id, url) || url.href.length > 2048) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (id === "facebook" && parts[0] === "profile.php" && parts.length === 1) {
      handle = url.searchParams.get("id") || "";
      if (!/^\d{1,30}$/.test(handle)) return null;
    } else if (id === "facebook" && parts[0] === "people" && parts.length === 3 && /^\d{1,30}$/.test(parts[2])) {
      handle = parts[2];
    } else {
      if (parts.length !== 1) return null;
      try { handle = decodeURIComponent(parts[0]).replace(/^@/, ""); } catch { return null; }
      if (["threads", "tiktok"].includes(id) && !parts[0].startsWith("@")) return null;
    }
  }
  const pattern = id === "x" ? /^[A-Za-z0-9_]{1,15}$/ : id === "facebook" ? /^[A-Za-z0-9_.-]{1,100}$/ : /^[A-Za-z0-9._]{1,64}$/;
  if (!pattern.test(handle) || RESERVED.has(handle.toLowerCase()) || handle === "." || handle === "..") return null;
  const profileUrl = id === "x" ? `https://x.com/${handle}` : id === "instagram" ? `https://www.instagram.com/${handle}/`
    : id === "facebook" ? /^\d+$/.test(handle) ? `https://www.facebook.com/profile.php?id=${handle}` : `https://www.facebook.com/${handle}`
    : id === "threads" ? `https://www.threads.com/@${handle}` : `https://www.tiktok.com/@${handle}`;
  return { platformId: id, handle, label: handle, displayName: cleanText(input.displayName || input.full_name || input.nickname || input.name), profileUrl };
}

function walk(value, visit, maximum = 50_000) {
  const stack = [{ value, key: "", parent: null }];
  let count = 0;
  while (stack.length && ++count <= maximum) {
    const next = stack.pop();
    if (!next.value || typeof next.value !== "object") continue;
    if (visit(next.value, next.key, next.parent) === false) continue;
    for (const [key, child] of Object.entries(next.value)) if (child && typeof child === "object") stack.push({ value: child, key, parent: next.value });
  }
}
function requestVariables(url, postData) {
  try {
    const parsed = new URL(url);
    const form = new URLSearchParams(postData || "");
    const value = parsed.searchParams.get("variables") || form.get("variables");
    if (value) return JSON.parse(value);
    return JSON.parse(postData || "{}").variables || {};
  } catch { return {}; }
}
function hasPayloadError(body) {
  let failed = false;
  walk(body, (value) => {
    if (value?.errors?.length || value?.status === "fail" || value?.status_code && Number(value.status_code) !== 0) failed = true;
  });
  return failed;
}

async function currentSessionUserId(context, id) {
  // Only use this inside an online, authenticated navigation branch. These
  // account IDs disambiguate the viewer; cached cookies alone prove no login.
  const name = { x: "twid", instagram: "ds_user_id", facebook: "c_user" }[id];
  if (!name || typeof context?.cookies !== "function") return "";
  try {
    const cookies = await context.cookies(HOMES[id]);
    const cookie = cookies.find(item => item.name === name
      && HOSTS[id].includes(String(item.domain || "").replace(/^\./, "").replace(/^www\./, "").toLowerCase()));
    const value = decodeURIComponent(cookie?.value || "");
    const match = id === "x" ? /^u=(\d{1,30})$/.exec(value) : /^(\d{1,30})$/.exec(value);
    return match?.[1] || "";
  } catch { return ""; }
}

// Parse only a response actually requested by the following-list UI. This
// never fabricates/replays private API requests. Unrelated feed, followers,
// recommendations and suggested-user responses are deliberately excluded.
export function parseFollowingResponse(platform, { url, body, postData = "", followingOpened = false, selfId = "" } = {}) {
  const id = platformKey(platform);
  const empty = { matched: false, accounts: [], terminal: false, cursor: null, error: false, emptyConfirmed: false };
  let parsed;
  try { parsed = new URL(url); } catch { return empty; }
  if (!followingOpened || !safeHost(id, parsed) || !body || typeof body !== "object") return empty;
  const operation = `${parsed.pathname} ${new URLSearchParams(postData).get("fb_api_req_friendly_name") || ""}`;
  if (/followers|suggest|recommend/i.test(operation)) return empty;
  let matched = false, terminal = false, cursor = null;
  let relationshipArrays = 0, relationshipItems = 0, rejectedItems = 0, nonemptyXEntries = false;
  const accounts = new Map();
  const add = (user) => {
    if (user?.promotedMetadata || user?.promoted_metadata) return;
    relationshipItems += 1;
    if (!user || typeof user !== "object") { rejectedItems += 1; return; }
    const legacy = user.legacy || {};
    const current = user.core || {};
    const record = canonicalFollowingAccount(id, { handle: user.username || user.uniqueId || current.screen_name || legacy.screen_name,
      profileUrl: id === "facebook" ? user.profile_url || user.url || user.profileUrl : "",
      displayName: user.full_name || user.nickname || current.name || legacy.name || user.name });
    if (record) accounts.set(record.handle.toLowerCase(), record);
    else rejectedItems += 1;
  };
  if (id === "x" && /\/(?:Following|UserFollowing)(?:\?|\/|$)/.test(parsed.pathname)) {
    const variables = requestVariables(url, postData);
    if (selfId && variables.userId && String(variables.userId) !== String(selfId)) return empty;
    matched = true;
    walk(body, (value) => {
      if (value.promotedMetadata || value.promoted_metadata) return false;
      if (value.type === "TimelineAddEntries" && Array.isArray(value.entries)) {
        relationshipArrays += 1; nonemptyXEntries ||= value.entries.length > 0;
      }
      const item = value.itemContent || value.item?.itemContent;
      if (item?.user_results?.result && !item.promotedMetadata) add(item.user_results.result);
      if (value.cursorType === "Bottom") { cursor = String(value.value || ""); terminal = !cursor || /^0+$/.test(cursor); }
      if (value.type === "TimelineTerminateTimeline" && value.direction === "Bottom") terminal = true;
    });
  } else if (id === "instagram" && /^\/api\/v1\/friendships\/\d+\/following\/?$/.test(parsed.pathname)) {
    const owner = /\/friendships\/(\d+)\//.exec(parsed.pathname)?.[1];
    if (selfId && owner !== String(selfId)) return empty;
    if (!Array.isArray(body.users)) return { ...empty, matched: true, error: true };
    matched = true;
    relationshipArrays += 1;
    for (const user of body.users) add(user);
    cursor = body.next_max_id == null ? null : String(body.next_max_id);
    terminal = body.has_more === false || (Object.hasOwn(body, "next_max_id") && !body.next_max_id);
  } else if (id === "tiktok" && /^\/api\/user\/list\/?$/.test(parsed.pathname) && Array.isArray(body.userList)) {
    const owner = parsed.searchParams.get("userId") || parsed.searchParams.get("uid");
    if (selfId && owner && owner !== String(selfId)) return empty;
    matched = true;
    relationshipArrays += 1;
    for (const item of body.userList) add(item.user || item.userInfo?.user || item);
    cursor = body.cursor == null ? null : String(body.cursor);
    terminal = body.hasMore === false || body.hasMore === 0 || body.has_more === false || body.has_more === 0;
  } else if (["instagram", "threads", "facebook"].includes(id) && /graphql/i.test(parsed.pathname)) {
    // Connection names are evidence of relationship type; never harvest all
    // nested user objects from a general GraphQL response or profile document.
    walk(body, (value, key) => {
      if (!/(?:^|_)(?:following|followings|edge_follow|subscribed_profiles)(?:$|_)/i.test(key)) return;
      if (!Array.isArray(value.edges) && !Array.isArray(value.users) && !Array.isArray(value.nodes)) return;
      matched = true;
      relationshipArrays += 1;
      for (const entry of value.edges || value.users || value.nodes) {
        const node = entry?.node || entry;
        if (id === "facebook") {
          const actor = node?.profile || node?.actor || node;
          add(actor && { ...actor, profile_url: actor.profile_url || actor.url || actor.profileUrl });
        } else add(node?.user || node);
      }
      const pageInfo = value.page_info || value.pageInfo;
      if (pageInfo) {
        cursor = pageInfo.end_cursor ?? pageInfo.endCursor ?? null;
        terminal = pageInfo.has_next_page === false || pageInfo.hasNextPage === false;
      }
    });
  }
  const error = matched && (rejectedItems > 0 || hasPayloadError(body) || id === "tiktok" && Object.hasOwn(body, "statusCode") && Number(body.statusCode) !== 0);
  return { matched, accounts: [...accounts.values()], terminal: terminal && !error, cursor, error,
    emptyConfirmed: matched && terminal && !error && relationshipArrays > 0 && relationshipItems === 0 && !nonemptyXEntries };
}

function readNavigationSnapshot(id) {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const markers = { x: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]',
    instagram: 'a[href="/direct/inbox/"], a[href="/direct/inbox"], a[href="/accounts/edit/"], a[href="/accounts/edit"]', threads: 'a[href="/activity"], a[href="/settings"]',
    facebook: '[aria-label="Your profile"], [aria-label="你的个人主页"], [aria-label="你的个人档案"], [role="button"][aria-label="Account"], [role="button"][aria-label="帐户"], [role="button"][aria-label="账户"]',
    tiktok: '[data-e2e="nav-profile"], [data-e2e="profile-icon"]' };
  const selectors = { x: '[data-testid="AppTabBar_Profile_Link"], nav a[href], [role="navigation"] a[href]',
    instagram: 'a[href]', threads: 'nav a[href], a[href][role="link"], a[aria-label="Profile"], a[aria-label="个人主页"]',
    facebook: 'a[aria-label="Your profile"], a[aria-label="你的个人主页"], [role="menu"] a[href], a[href="/me/"]',
    tiktok: '[data-e2e="nav-profile"], [data-e2e="profile-icon"], nav a[aria-label="Profile"], nav a[aria-label="个人主页"]' };
  let viewer = null;
  if (id === "tiktok") {
    try {
      const app = JSON.parse(document.querySelector("script#__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "{}").__DEFAULT_SCOPE__?.["webapp.app-context"];
      // Only the authenticated app-context viewer, never webapp.user-detail
      // (which describes whichever profile happens to be displayed).
      const users = [app?.user, app?.user_info, app?.userInfo?.user, app?.viewer, app?.profile]
        .map(user => ({ uid: String(user?.uid || user?.id || ""), uniqueId: user?.uniqueId || user?.unique_id || user?.username || "" }))
        .filter(user => /^\d{1,30}$/.test(user.uid) && /^[A-Za-z0-9._]{1,64}$/.test(user.uniqueId));
      const identities = new Map(users.map(user => [`${user.uid}:${user.uniqueId.toLowerCase()}`, user]));
      if (identities.size === 1) viewer = [...identities.values()][0];
    } catch {}
  }
  const profileLabel = /^(?:Profile|Your profile|See your profile|个人主页|个人资料|个人档案|查看你的个人主页|查看个人主页)$/i;
  const ownProfileLink = (link) => {
    if (id === "instagram" && link.closest('main, [role="main"]')) return false;
    const labels = [link.innerText, link.getAttribute("aria-label"), link.querySelector('svg[aria-label]')?.getAttribute("aria-label"),
      link.querySelector('img[alt]')?.getAttribute("alt")].map(label => (label || "").trim());
    if (labels.some(label => profileLabel.test(label)) && (!link.closest('aside') || link.closest('nav, [role="navigation"]'))) return true;
    if (id === "tiktok" && (link.matches('[data-e2e="nav-profile"], [data-e2e="profile-icon"]')
      || link.closest('[data-e2e="nav-profile"], [data-e2e="profile-icon"]'))) return true;
    if (id !== "instagram") return false;
    // Instagram's navigation avatar may show the actual username, without a
    // Profile text label. An avatar alone elsewhere is another person's link.
    let nav = link.closest('nav, [role="navigation"], header');
    if (!nav) {
      // Some Instagram desktop builds render the sidebar as plain divs. A
      // small shared navigation container with multiple visible destinations
      // is acceptable; the app root/body or a post/recommendation container is
      // not. The local binding label is never used to infer this identity.
      for (let container = link.parentElement, depth = 0; container && depth < 12; container = container.parentElement, depth += 1) {
        if (container.matches('body, html, main, [role="main"], article, [role="article"], [role="dialog"], [role="menu"]')) break;
        if (container.querySelector('main, [role="main"], article, [role="article"], [data-e2e="recommend-list"]')) continue;
        if (/Suggested for you|Suggested accounts|为你推荐|推荐关注/i.test(container.innerText || "")) continue;
        const destinations = new Set([...container.querySelectorAll('a[href]')].filter(visible).map(anchor => {
          try { const path = new URL(anchor.href).pathname.replace(/\/$/, "");
            return /^\/(?:direct\/inbox|explore|reels|accounts\/(?:edit|activity))$/.test(path) ? path : "";
          } catch { return ""; }
        }).filter(Boolean));
        if (destinations.size >= 2) { nav = container; break; }
      }
    }
    if (!nav) return false;
    let handle;
    try { handle = decodeURIComponent(new URL(link.href).pathname.split("/").filter(Boolean)[0] || ""); } catch { return false; }
    const alt = (link.querySelector('img[alt]')?.getAttribute("alt") || "").trim();
    return alt.toLowerCase() === `${handle.toLowerCase()}'s profile picture`
      || alt.toLowerCase() === `${handle.toLowerCase()}’s profile picture`
      || alt === `${handle}的头像` || alt === `${handle} 的头像` || alt === `${handle}的个人主页照片`;
  };
  const links = [...document.querySelectorAll(selectors[id] || "none")]
    .map(element => element.matches('a[href]') ? element : element.closest('a[href]') || element.querySelector('a[href]'))
    .filter(link => visible(link) && !link.closest('article, [role="article"], [data-testid="tweet"], [role="menu"], [role="dialog"], [data-e2e="recommend-list"]'))
    .filter(link => id === "x" || !link.closest('aside') || link.closest('nav, [role="navigation"]') || id === "instagram" && ownProfileLink(link))
    .filter(link => id !== "x" || link.matches('[data-testid="AppTabBar_Profile_Link"]')
      || link.querySelector('[data-testid="AppTabBar_Profile_Link"]')
      || /^(?:Profile|个人主页|个人资料)$/i.test((link.getAttribute("aria-label") || link.querySelector('svg[aria-label]')?.getAttribute("aria-label") || link.innerText || "").trim()))
    .map((link) => ({ href: link.href,
    text: link.innerText || link.getAttribute("aria-label") || link.querySelector('svg[aria-label]')?.getAttribute("aria-label") || "",
    testId: link.getAttribute("data-testid"), e2e: link.getAttribute("data-e2e"),
    ownAvatar: ownProfileLink(link), ownNavigation: ownProfileLink(link) }));
  const accountButton = id === "x" ? document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') : null;
  const ownTexts = visible(accountButton) && !accountButton.closest('[role="menu"], [role="dialog"]')
    ? [accountButton.innerText || "", accountButton.getAttribute("aria-label") || "",
      ...[...accountButton.querySelectorAll('span, div')]
        .filter(element => visible(element) && !element.closest('[role="menu"], [role="dialog"]')
          && /^@[A-Za-z0-9_]{1,15}$/.test((element.innerText || "").trim()))
        .map(element => element.innerText.trim())] : [];
  const ownHandles = visible(accountButton) && !accountButton.closest('[role="menu"], [role="dialog"]')
    ? [...new Set([...ownTexts.join("\n")
      .matchAll(/(?:^|\s)@([A-Za-z0-9_]{1,15})(?=\s|$)/g)].map(match => match[1].toLowerCase()))] : [];
  return { url: location.href, authenticated: [...document.querySelectorAll(markers[id] || "none")].some(visible),
    hasPasswordField: [...document.querySelectorAll('input[type="password"], input[name="pass"]')].some(visible),
    viewer: viewer ? { uid: viewer.uid, uniqueId: viewer.uniqueId } : null,
    ownHandle: ownHandles.length === 1 ? ownHandles[0] : "", links };
}

function requiresLogin(snapshot) {
  return snapshot.hasPasswordField || /\/(?:login|checkpoint|challenge)(?:\/|\?|$)|\/accounts\/login|\/i\/flow\/(?:login|challenge)/i.test(snapshot.url);
}

function isXFollowingRoute(value, viewer) {
  try {
    const url = new URL(value);
    return safeHost("x", url) && url.pathname.toLowerCase().replace(/\/$/, "") === `/${viewer.handle.toLowerCase()}/following`;
  } catch { return false; }
}

// The binding label is just a local label. Resolve the current X viewer only
// from their own visible navigation, and wait for SPA hydration instead of
// deciding that a still-loading home page means the binding is invalid.
async function identifyXViewer(page, context, { signal, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.ceil(timeoutMs / 250) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const snapshot = await page.evaluate(readNavigationSnapshot, "x");
    if (requiresLogin(snapshot)) throw failure("login-required", "该绑定账号当前需要重新登录或完成平台验证，请先在“我的账号”验证登录。");
    let location;
    try { location = new URL(snapshot.url); } catch {}
    if (location && safeHost("x", location) && snapshot.authenticated) {
      const fromLink = (snapshot.links || []).map(link => canonicalFollowingAccount("x", { profileUrl: link.href })).find(Boolean);
      const fromButton = canonicalFollowingAccount("x", { handle: snapshot.ownHandle });
      const viewer = fromLink || fromButton;
      // A stale nav during an account switch is not sufficient evidence.
      if (viewer && (!fromLink || !fromButton || fromLink.handle.toLowerCase() === fromButton.handle.toLowerCase())) {
        const userId = await currentSessionUserId(context, "x");
        if (userId) viewer.userId = userId;
        return viewer;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempt + 1 === attempts) break;
    await page.waitForTimeout(Math.min(250, remaining));
  }
  throw failure("self-profile-unavailable", "X 首页尚未提供可确认的当前账号入口，未使用绑定名称猜测账号。请稍后重试；如平台要求登录，请在“我的账号”验证登录。");
}

async function identifyPlatformViewer(page, context, id, { signal, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.ceil(timeoutMs / 250) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const snapshot = await page.evaluate(readNavigationSnapshot, id);
    if (requiresLogin(snapshot)) throw failure("login-required", "该绑定账号当前需要重新登录或完成平台验证，请先在“我的账号”验证登录。");
    let location;
    try { location = new URL(snapshot.url); } catch {}
    if (location && safeHost(id, location) && snapshot.authenticated) {
      const profiles = new Map((snapshot.links || []).filter(link => link.ownNavigation === true || link.ownNavigation === undefined
        && (link.ownAvatar || /^\s*(?:Profile|Your profile|See your profile|个人主页|个人资料|个人档案|查看你的个人主页|查看个人主页)\s*$/i.test(link.text)))
        .map(link => canonicalFollowingAccount(id, { profileUrl: link.href })).filter(Boolean)
        .map(profile => [profile.handle.toLowerCase(), profile]));
      let viewer = profiles.size === 1 ? [...profiles.values()][0] : null;
      if (id === "tiktok" && /^\d{1,30}$/.test(String(snapshot.viewer?.uid || ""))) {
        const hydrated = canonicalFollowingAccount(id, { handle: snapshot.viewer.uniqueId });
        if (hydrated && profiles.size <= 1 && (!viewer || viewer.handle.toLowerCase() === hydrated.handle.toLowerCase())) {
          viewer = hydrated;
          viewer.userId = String(snapshot.viewer.uid);
        } else viewer = null;
      }
      const userId = await currentSessionUserId(context, id);
      // Facebook's actual-name account menu need not expose a username. The
      // c_user ID is used only after visible online authenticated navigation.
      if (!viewer && !profiles.size && id === "facebook" && userId) viewer = canonicalFollowingAccount(id, { handle: userId });
      if (viewer) {
        if (userId) viewer.userId = userId;
        return viewer;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempt + 1 === attempts) break;
    await page.waitForTimeout(Math.min(250, remaining));
  }
  throw failure("self-profile-unavailable", "平台尚未提供可确认的当前账号主页入口，未使用绑定名称猜测账号。请稍后重试；只有平台要求登录时才需要重新验证登录。");
}

function isOwnFollowingLocation(id, value, viewer) {
  if (id === "x") return isXFollowingRoute(value, viewer);
  try {
    const url = new URL(value), profile = new URL(viewer.profileUrl);
    if (!safeHost(id, url)) return false;
    const current = url.pathname.replace(/\/$/, "").toLowerCase(), own = profile.pathname.replace(/\/$/, "").toLowerCase();
    if (id === "facebook" && own === "/profile.php") return current === own
      && url.searchParams.get("id") === profile.searchParams.get("id")
      && [null, "", "following", "friends", "friends_following"].includes(url.searchParams.get("sk"));
    return current === own || current === `${own}/following` || id === "facebook"
      && ["friends", "friends_following"].some(suffix => current === `${own}/${suffix}`);
  } catch { return false; }
}

async function waitForPlatformFollowingEntry(page, id, { signal, timeoutMs, viewer, allowFriends = true, allowMore = true }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.ceil(timeoutMs / 250) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const snapshot = await page.evaluate(readNavigationSnapshot, id);
    if (requiresLogin(snapshot)) throw failure("login-required", "当前关注页面需要重新登录或完成平台验证，请先在“我的账号”验证登录。");
    if (!isOwnFollowingLocation(id, snapshot.url, viewer)) throw failure("following-list-unavailable", "平台没有打开当前账号自己的主页，本次读取已停止。");
    const entry = await page.evaluate(readFollowingEntry, id);
    if (entry.followingHref || entry.followingSelector || entry.tiktokSelector || entry.threadsFollowersSelector || entry.followingTabAvailable
      || allowFriends && entry.friendsHref || allowMore && entry.moreSelector) return entry;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempt + 1 === attempts) return entry;
    await page.waitForTimeout(Math.min(250, remaining));
  }
}

async function waitForXFollowingEntry(page, { signal, timeoutMs, viewer }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.ceil(timeoutMs / 250) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const snapshot = await page.evaluate(readNavigationSnapshot, "x");
    if (requiresLogin(snapshot)) throw failure("login-required", "X 当前需要重新登录或完成平台验证，请先在“我的账号”验证登录。");
    const displayedProfile = canonicalFollowingAccount("x", { profileUrl: snapshot.url });
    if (!displayedProfile || displayedProfile.handle.toLowerCase() !== viewer.handle.toLowerCase()) {
      // A redirect must never supply a different profile's count or link.
      return { followingHref: "", expectedCount: null };
    }
    const entry = await page.evaluate(readFollowingEntry, "x");
    if (entry.followingHref) return entry;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempt + 1 === attempts) return entry;
    await page.waitForTimeout(Math.min(250, remaining));
  }
}

function readFollowingEntry(id) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const links = [...document.querySelectorAll('a[href]')].filter(link => visible(link)
    && !link.closest('article, [role="article"], [role="dialog"], aside, [data-e2e="recommend-list"]')).map((link) => ({ href: link.href,
    text: link.innerText || link.getAttribute("aria-label") || "", rawHref: link.getAttribute("href") }));
  const own = new URL(location.href);
  const profilePath = id === "facebook" ? own.pathname.replace(/\/(?:friends|friends_following)\/?$/, "") : own.pathname;
  const following = links.find((link) => {
    try {
      const target = new URL(link.href);
      return target.origin === own.origin && (target.pathname.replace(/\/$/, "") === `${profilePath.replace(/\/$/, "")}/following`
        || id === "facebook" && target.pathname.replace(/\/$/, "") === `${profilePath.replace(/\/$/, "")}/friends_following`
        || id === "facebook" && own.pathname === "/profile.php" && target.pathname === own.pathname
          && target.searchParams.get("id") === own.searchParams.get("id") && ["following", "friends_following"].includes(target.searchParams.get("sk")));
    } catch { return false; }
  });
  let expectedCount = null;
  if (following) {
    const text = following.text.replace(/[,，\s]/g, "");
    const match = /^(\d+)(?:following|关注|正在关注|已关注)$/i.exec(text) || /^(?:following|关注|正在关注|已关注)(\d+)$/i.exec(text);
    if (match && Number.isSafeInteger(Number(match[1]))) expectedCount = Number(match[1]);
  }
  // Some Instagram builds keep the counter href on the current profile and
  // open a relationship modal in JS. Require a numeric counter on this own
  // profile, not a generic Following action (which could unfollow someone).
  let followingSelector = "";
  if (id === "instagram" && !following) {
    const counters = [...document.querySelectorAll('a[role="link"], button, [role="button"], [role="link"]')].filter(element => {
      if (!visible(element) || element.closest('article, [role="article"], [role="dialog"], [role="menu"], aside')) return false;
      const text = (element.innerText || element.getAttribute("aria-label") || "").replace(/[,，\s]/g, "");
      if (!/^(?:\d+(?:following|关注|正在关注|已关注)|(?:following|关注|正在关注|已关注)\d+)$/i.test(text)) return false;
      if (!element.getAttribute("href")) return Boolean(element.closest('header, section'));
      try { const target = new URL(element.getAttribute("href"), own);
        return target.origin === own.origin && target.pathname.replace(/\/$/, "") === own.pathname.replace(/\/$/, "");
      } catch { return false; }
    });
    if (counters.length === 1) {
      const counter = counters[0], text = (counter.innerText || counter.getAttribute("aria-label") || "").replace(/[,，\s]/g, "");
      const count = /\d+/.exec(text)?.[0];
      if (Number.isSafeInteger(Number(count))) expectedCount = Number(count);
      counter.setAttribute("data-media-tracker-following-entry", "instagram");
      followingSelector = '[data-media-tracker-following-entry="instagram"]';
    }
  }
  const followingCounter = id === "tiktok" ? document.querySelector('[data-e2e="following-count"]') : null;
  if (followingCounter && visible(followingCounter) && !followingCounter.closest('article, [role="article"], [role="dialog"], aside')) {
    const text = (followingCounter.innerText || "").trim().replace(/[,，\s]/g, "");
    if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) expectedCount = Number(text);
  }
  let tiktokProfile = null;
  if (id === "tiktok") try {
    const profile = JSON.parse(document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || '{}').__DEFAULT_SCOPE__?.['webapp.user-detail'];
    const user = profile?.userInfo?.user, count = profile?.userInfo?.stats?.followingCount;
    if (profile?.statusCode === 0 && /^\d{1,30}$/.test(String(user?.id || user?.uid || ""))
      && own.pathname.toLowerCase() === `/@${String(user?.uniqueId || "").toLowerCase()}`
      && Number.isSafeInteger(count) && count >= 0) tiktokProfile = { userId: String(user.id || user.uid), followingCount: count };
  } catch {}
  const friends = id === "facebook" ? links.find(link => {
    try {
      const target = new URL(link.href);
      return target.origin === own.origin && (target.pathname.replace(/\/$/, "") === `${profilePath.replace(/\/$/, "")}/friends`
        || own.pathname === "/profile.php" && target.pathname === own.pathname && target.searchParams.get("id") === own.searchParams.get("id")
          && target.searchParams.get("sk") === "friends");
    } catch { return false; }
  }) : null;
  const threadButtons = id === "threads" ? [...document.querySelectorAll('header button[data-pressable-container="true"]')] : [];
  const threadCounter = threadButtons.findIndex(button => visible(button)
    && !button.closest('article, [role="article"], [role="dialog"]') && /followers|位粉丝|个粉丝/i.test(button.innerText || ""));
  const more = id === "facebook" ? [...document.querySelectorAll('[role="tab"], [role="button"], button')].filter(element => visible(element)
    && !element.closest('article, [role="article"], [role="dialog"], aside')
    && /^(?:更多个人主页版块|更多个人主页板块|More profile sections)$/i.test(element.getAttribute('aria-label') || '')) : [];
  let moreSelector = "";
  if (more.length === 1) { more[0].setAttribute('data-media-tracker-profile-more', 'facebook'); moreSelector = '[data-media-tracker-profile-more="facebook"]'; }
  const followingTabs = id === "facebook" ? [...document.querySelectorAll('[role="tab"]')].filter(tab => visible(tab)
    && !tab.closest('article, [role="article"], [role="dialog"], aside')
    && /^(?:Following|关注|正在关注|已关注)$/i.test((tab.innerText || tab.getAttribute("aria-label") || "").trim())) : [];
  let followingTabSelector = "";
  if (followingTabs.length === 1) { followingTabs[0].setAttribute('data-media-tracker-following-tab', 'facebook'); followingTabSelector = '[data-media-tracker-following-tab="facebook"]'; }
  return { followingHref: following?.rawHref || "", followingSelector, expectedCount, tiktokProfile, friendsHref: friends?.rawHref || "",
    moreSelector,
    followingTabAvailable: Boolean(followingTabSelector), followingTabSelector,
    tiktokSelector: followingCounter && visible(followingCounter) && !followingCounter.closest('article, [role="article"], [role="dialog"], aside') ? '[data-e2e="following-count"]' : "",
    // Threads exposes its relationship dialog through a header followers
    // counter, then an explicit Following tab. Capture only this profile
    // header control, not similarly named controls in posts/recommendations.
    threadsFollowersSelector: threadCounter >= 0 ? `header button[data-pressable-container="true"] >> nth=${threadCounter}` : "" };
}

function readFollowingRows(id) {
  // Following routes and dialogs have their own list scope. Sidebar profile
  // links, article authors and "Suggested for you" panels are not candidates.
  const visible = (element) => { if (!element) return false; const r = element.getBoundingClientRect(), style = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden"; };
  const relationHeading = /^(?:Following|关注|正在关注|已关注)$/i;
  const isFollowingDialog = element => {
    const selectedRelations = [...element.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(tab => visible(tab)
      && /^(?:Following|Followers|关注|正在关注|已关注|粉丝)$/i.test((tab.innerText || "").trim()));
    if (selectedRelations.length) return selectedRelations.length === 1 && relationHeading.test((selectedRelations[0].innerText || "").trim());
    return [...element.querySelectorAll('h1,h2,h3,[role="heading"]')].some(heading => visible(heading) && relationHeading.test((heading.innerText || "").trim()))
      || relationHeading.test((element.innerText || "").split('\n').find(line => line.trim())?.trim() || "");
  };
  const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible).find(isFollowingDialog);
  const tiktokList = id === "tiktok" ? [...document.querySelectorAll('[data-e2e="follow-list"]')].find(element => visible(element)
    && (!element.closest('[role="dialog"]') || isFollowingDialog(element.closest('[role="dialog"]')))) : null;
  const followingRoute = /\/(?:following|friends_following)\/?$/.test(location.pathname)
    || ["following", "friends_following"].includes(new URL(location.href).searchParams.get("sk"));
  const selectedFollowingTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(tab => visible(tab)
    && !tab.closest('article,[role="article"],[role="dialog"],aside') && relationHeading.test((tab.innerText || "").trim()));
  const selectedFollowing = selectedFollowingTabs.length > 0;
  const selectedFollowers = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(tab => visible(tab)
    && !tab.closest('article,[role="article"],[role="dialog"],aside') && /^(?:Followers|粉丝)$/i.test((tab.innerText || '').trim()));
  // New Facebook layouts render plain div cards with avatar/name links but no
  // Following action or listitem role. Its selected relationship tab scopes
  // the profile app collection; photos/reels/recommendations elsewhere in the
  // same main area must not be harvested.
  const facebookSections = id === "facebook" && followingRoute ? [...new Set(selectedFollowingTabs
    .map(tab => tab.closest('[data-pagelet^="ProfileAppSection_"]')).filter(Boolean))] : [];
  const facebookSection = facebookSections.length === 1 ? facebookSections[0] : null;
  const root = dialog || tiktokList || (!selectedFollowers && facebookSections.length <= 1 ? facebookSection
    || (followingRoute || selectedFollowing ? document.querySelector('main, [role="main"]') : null) : null);
  if (!root) return { url: location.href, links: [], scrollable: false, explicitEnd: false };
  const rows = id === "x" ? [...root.querySelectorAll('[data-testid="UserCell"]')]
    : id === "tiktok" ? [...root.querySelectorAll('[data-e2e*="follow-list"], [data-e2e="user-list-item"], [data-e2e="follow-item"]')]
      : [...root.querySelectorAll('[role="listitem"], [data-visualcompletion="ignore-dynamic"], [data-e2e="user-list-item"]')];
  // Instagram/Threads dialogs currently often omit semantic listitem roles.
  // A row must contain an existing "Following" action (not "Follow"), so
  // recommendation/followback entries are excluded without clicking it.
  if (id !== "x") for (const button of root.querySelectorAll('button, [role="button"]')) {
    if (/^(?:Following|Requested|Friends|Friend|已关注|正在关注|已请求|好友)$/i.test((button.innerText || "").trim())) {
      for (let row = button.parentElement, depth = 0; row && row !== root && depth < 10; row = row.parentElement, depth += 1) {
        const profiles = new Set([...row.querySelectorAll('a[href]')].filter(visible).map(anchor => {
          try { const url = new URL(anchor.href); const path = url.pathname.replace(/\/$/, "");
            return url.origin === location.origin && (/^\/[^/]+$/.test(path) || id === "facebook" && /^\/people\/[^/]+\/\d+$/.test(path))
              ? `${path}${path === '/profile.php' ? `?id=${url.searchParams.get('id')}` : ''}` : "";
          } catch { return ""; }
        }).filter(Boolean));
        if (profiles.size > 1) break;
        if (profiles.size === 1) { rows.push(row); break; }
      }
    }
  }
  const links = [];
  if (facebookSection && root === facebookSection) {
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (!visible(anchor) || anchor.closest('article,[role="article"],[role="tab"],[role="heading"], [data-pagelet*="Recommend"], [data-pagelet*="Suggested"]')) continue;
      // Only profile destinations, not collection/navigation or media links.
      let target; try { target = new URL(anchor.href); } catch { continue; }
      if (target.origin !== location.origin || target.searchParams.has('sk')) continue;
      const parts = target.pathname.split('/').filter(Boolean);
      if (!(parts.length === 1 && (parts[0] !== 'profile.php' || /^\d{1,30}$/.test(target.searchParams.get('id') || ''))
        || parts.length === 3 && parts[0] === 'people' && /^\d{1,30}$/.test(parts[2]))) continue;
      links.push({ profileUrl: target.href, displayName: anchor.innerText || anchor.getAttribute('aria-label') || '' });
    }
  }
  for (const row of new Set(rows)) {
    if (!visible(row) || row.closest('article, [role="article"], [data-testid="tweet"], [data-pagelet*="Recommend"], [data-pagelet*="Suggested"]')) continue;
    if (/^(?:Suggested for you|为你推荐|推荐关注)/i.test((row.innerText || "").trim())) continue;
    const actions = [...row.querySelectorAll('button, [role="button"]')]
      .map((button) => (button.innerText || button.getAttribute("aria-label") || "").trim());
    if (actions.some((label) => /^(?:Follow|Follow back|关注|回关)$/i.test(label))) continue;
    if (!actions.some((label) => /^(?:Following|Requested|已关注|正在关注|已请求)$/i.test(label)
      || (id === "tiktok" || id === "facebook" && followingRoute) && /^(?:Friends|Friend|好友)$/i.test(label)
      || /^(?:Following|已关注)\s+@?[A-Za-z0-9._-]+$/.test(label))) continue;
    for (const anchor of row.querySelectorAll('a[href]')) if (visible(anchor)) links.push({ profileUrl: anchor.href,
      displayName: anchor.innerText || anchor.getAttribute("aria-label") || "" });
  }
  const candidates = [root, ...root.querySelectorAll("div")].filter((element) => {
    const style = getComputedStyle(element);
    return visible(element) && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 5;
  });
  const scroller = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (scroller) scroller.scrollBy(0, Math.max(scroller.clientHeight * .85, 450));
  else window.scrollBy(0, Math.max(innerHeight * .85, 600));
  const text = (root.innerText || "").slice(-1000);
  return { url: location.href, links, scrollable: Boolean(scroller), explicitEnd: /(?:^|\n)(?:No more (?:users|accounts)|You've reached the end|没有更多(?:用户|账号)|已显示全部)(?:\n|$)/i.test(text) };
}

async function clickFollowingEntry(page, id, entry, { signal, timeoutMs = 12_000 } = {}) {
  if (entry.followingSelector) {
    await page.locator(entry.followingSelector).first().click({ timeout: 5000 });
    return true;
  }
  if (entry.followingHref) {
    await page.locator(`a[href=${JSON.stringify(entry.followingHref)}]`).first().click({ timeout: 5000 });
    return true;
  }
  if (entry.tiktokSelector) { await page.locator(entry.tiktokSelector).first().click({ timeout: 5000 }); return true; }
  // Never click Follow/Unfollow controls, or a generic "Following" link in
  // someone's post. The destinations/counters above were bound to our profile.
  const names = /^(?:Following|关注|正在关注|已关注)$/i;
  if (entry.followingTabAvailable) {
    const target = page.locator(entry.followingTabSelector || '[data-media-tracker-following-tab="facebook"]').first();
    if (await target.isVisible().catch(() => false)) { await target.click({ timeout: 5000 }); return true; }
  }
  if (entry.threadsFollowersSelector) {
    await page.locator(entry.threadsFollowersSelector).first().click({ timeout: 5000 });
    const tab = page.locator('[role="dialog"]').getByRole("tab", { name: names }).first();
    const deadline = Date.now() + timeoutMs;
    const attempts = Math.ceil(timeoutMs / 250) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      signal?.throwIfAborted();
      if (await tab.isVisible().catch(() => false)) { await tab.click({ timeout: 5000 }); return true; }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || attempt + 1 === attempts) break;
      await page.waitForTimeout(Math.min(250, remaining));
    }
  }
  return false;
}

export async function discoverFollowing({ platform, linkedAccount, signal, onProgress,
  browserType = chromium, acquireTikTokPage = acquireBackgroundTikTokPage, maxDurationMs = 90_000,
  maxPages = 150, maxAccounts = 10_000, settleMs = 700, cleanupTimeoutMs = 3000, navigationTimeoutMs = 12_000 } = {}) {
  const id = platformKey(platform);
  if (!HOSTS[id] || platform?.custom) throw failure("unsupported-platform", "该自定义平台暂不支持读取已关注列表；可继续手动添加目标账号。");
  if (!linkedAccount?.profileDirectory || linkedAccount.platformId !== id) throw failure("login-required", "请选择这个平台已经绑定的登录账号。");
  signal?.throwIfAborted();
  maxDurationMs = Math.min(180_000, Math.max(1000, Number(maxDurationMs) || 90_000));
  maxPages = Math.min(1000, Math.max(1, Number(maxPages) || 150));
  maxAccounts = Math.min(50_000, Math.max(1, Number(maxAccounts) || 10_000));
  settleMs = Math.min(3000, Math.max(0, Number(settleMs) || 0));
  cleanupTimeoutMs = Math.min(10_000, Math.max(20, Number(cleanupTimeoutMs) || 3000));
  navigationTimeoutMs = Number.isFinite(Number(navigationTimeoutMs)) ? Math.min(15_000, Math.max(0, Number(navigationTimeoutMs))) : 12_000;
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false, context, page, tikTokLease, closePromise, followingOpened = false, disposed = false, self, expectedCount = null;
  let followingScopeConfirmed = false, confirmFollowingScope, accessRestriction;
  const followingScopeReady = new Promise(resolve => { confirmFollowingScope = resolve; });
  let terminal = false, terminalEmptyConfirmed = false, parseFailed = false, emptyConfirmed = false, matchedResponses = 0, lastCursor = null, stagnantRounds = 0, responseQueue = Promise.resolve();
  const accounts = new Map(), pending = new Set();
  const finish = (completeness, message) => ({ accounts: [...accounts.values()], completeness, message,
    observedCount: accounts.size, selfProfileUrl: self?.profileUrl || "", matchedResponses, emptyConfirmed });
  const publish = (extra = {}) => onProgress?.({ accounts: [...accounts.values()], observedCount: accounts.size,
    message: `已读取 ${accounts.size} 个已关注账号。`, ...extra });
  const add = (items) => {
    for (const item of items) {
      const record = canonicalFollowingAccount(id, item);
      if (!record || record.handle.toLowerCase() === self?.handle.toLowerCase()) continue;
      if (accounts.size >= maxAccounts && !accounts.has(record.handle.toLowerCase())) continue;
      const previous = accounts.get(record.handle.toLowerCase());
      if (!record.displayName && previous?.displayName) record.displayName = previous.displayName;
      accounts.set(record.handle.toLowerCase(), record);
    }
  };
  const close = () => {
    if (!tikTokLease && !context) return Promise.resolve();
    return closePromise ||= (async () => {
    if (tikTokLease) await tikTokLease.release();
    else if (context) await context.close();
    })();
  };
  const boundedClose = async (operation) => {
    let closeTimer;
    try { await Promise.race([operation, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("Background browser close timed out.")), cleanupTimeoutMs); })]); }
    finally { clearTimeout(closeTimer); }
  };
  const disposeConfirmed = async () => {
    try { await boundedClose(close()); }
    catch {
      let confirmed = false;
      if (!tikTokLease) {
        const browser = context?.browser?.();
        if (browser && browser.isConnected?.() === false) confirmed = true;
        else if (browser) {
          try { await boundedClose(browser.close()); confirmed = browser.isConnected?.() !== true; } catch {}
        }
      }
      if (!confirmed) throw Object.assign(failure("browser-close-failed", "关注列表已停止，但后台登录会话未能确认关闭；请完全退出工具后重试。"),
        { retainProfileLease: true, retryDispose: async () => { closePromise = null; await disposeConfirmed(); } });
    }
  };
  const awaitPending = async () => {
    if (workSignal.aborted) throw abortError();
    let abort;
    const interrupted = new Promise((_, reject) => { abort = () => reject(abortError()); workSignal.addEventListener("abort", abort, { once: true }); });
    try { await Promise.race([Promise.allSettled([...pending]), interrupted]); }
    finally { workSignal.removeEventListener("abort", abort); }
  };
  const cancel = () => { void close().catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, maxDurationMs);
  timer.unref?.();
  workSignal.addEventListener("abort", cancel, { once: true });
  let responseListener;
  try {
    if (id === "tiktok") {
      tikTokLease = await acquireTikTokPage({ profileDirectory: linkedAccount.profileDirectory, signal: workSignal, purpose: "following" });
      ({ context, page } = tikTokLease);
    } else {
      context = await browserType.launchPersistentContext(linkedAccount.profileDirectory, { headless: true,
        executablePath: BACKGROUND_CHROMIUM_EXECUTABLE, timeout: 15_000, viewport: { width: 1280, height: 900 },
        args: ["--no-first-run", "--disable-background-networking", "--disable-background-mode"] });
      page = context.pages()[0] || await context.newPage();
      for (const extra of context.pages().slice(1)) await extra.close();
    }
    // An abort during launch must still close the context assigned afterward.
    if (workSignal.aborted) throw abortError();
    responseListener = (response) => {
      const opened = followingOpened;
      if (!opened) return;
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (!safeHost(id, url) || !/graphql|friendships|user\/list/.test(url.pathname)) return;
      // An explicit refusal on this following request ends the read. Do not
      // scroll for another request or fall back to alternate endpoints.
      const operation = `${url.pathname} ${response.request?.().postData?.() || ""}`;
      if ([401, 403, 429].includes(response.status())
        && /Following|\/following(?:\/|$)|\/api\/user\/list|following|subscribed_profiles/.test(operation)) {
        accessRestriction = Object.assign(failure("access-restricted", "平台拒绝了本次关注列表请求，已停止读取；可稍后检查账号权限再重试。"), { status: response.status() });
        controller.abort();
        return;
      }
      const task = responseQueue.then(async () => {
        // Observe fast list requests during navigation, but do not expose any
        // candidates until the destination is confirmed as our own list.
        await followingScopeReady;
        if (!followingScopeConfirmed || disposed || workSignal.aborted) return;
        let body;
        try {
          if (id === "facebook") {
            const assembled = assembleFacebookResponse(parseFacebookResponseText(await response.text()));
            body = assembled.payloads;
            if (assembled.patchIssues.length) parseFailed = true;
          } else body = await response.json();
        } catch {
          const operation = `${url.pathname} ${response.request?.().postData?.() || ""}`;
          if (/Following|\/following(?:\/|$)|\/api\/user\/list|following|subscribed_profiles/.test(operation)) parseFailed = true;
          return;
        }
        if (disposed || workSignal.aborted) return;
        if (!followingScopeConfirmed || typeof page.url === "function" && !isOwnFollowingLocation(id, page.url(), self)) return;
        const parsed = parseFollowingResponse(id, { url: url.href, body, followingOpened: opened,
          postData: response.request?.().postData?.() || "", selfId: self?.userId || "" });
        if (!parsed.matched) return;
        matchedResponses += 1;
        parseFailed ||= parsed.error || response.status() >= 400;
        if (parsed.error || response.status() >= 400) { terminal = false; terminalEmptyConfirmed = false; return; }
        add(parsed.accounts);
        // Response bodies are serialized in arrival order; any
        // nonterminal page arriving later revokes an earlier terminal result.
        terminal = parsed.terminal;
        terminalEmptyConfirmed = parsed.emptyConfirmed === true;
        lastCursor = parsed.cursor;
        publish();
      }).catch(() => { parseFailed = true; }).finally(() => pending.delete(task));
      responseQueue = task;
      pending.add(task);
    };
    page.on("response", responseListener);
    const navigation = await page.goto(HOMES[id], { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (navigation?.status() >= 400) throw failure("platform-unavailable", `平台主页返回 HTTP ${navigation.status()}，未能读取关注列表。`);
    await page.waitForTimeout(settleMs);
    if (workSignal.aborted) throw abortError();
    let snapshot = await page.evaluate(readNavigationSnapshot, id);
    if (requiresLogin(snapshot)) {
      throw failure("login-required", "该绑定账号当前需要重新登录或完成平台验证，请先在“我的账号”验证登录。");
    }
    if (id === "x") {
      self = await identifyXViewer(page, context, { signal: workSignal, timeoutMs: navigationTimeoutMs });
    } else {
      self = await identifyPlatformViewer(page, context, id, { signal: workSignal, timeoutMs: navigationTimeoutMs });
      if (id === "tiktok") await tikTokLease.markHomeWarmupComplete?.();
    }
    const profileNavigation = await page.goto(self.profileUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (profileNavigation?.status() >= 400) throw failure("platform-unavailable", "当前账号个人主页暂不可访问，请稍后重试。");
    await page.waitForTimeout(settleMs);
    if (workSignal.aborted) throw abortError();
    const entry = id === "x" ? await waitForXFollowingEntry(page, { signal: workSignal, timeoutMs: navigationTimeoutMs, viewer: self })
      : await waitForPlatformFollowingEntry(page, id, { signal: workSignal, timeoutMs: navigationTimeoutMs, viewer: self });
    expectedCount = entry.expectedCount;
    if (expectedCount === 0 && (id !== "tiktok" || entry.tiktokProfile?.followingCount === 0
      && self.userId && entry.tiktokProfile.userId === self.userId)) {
      emptyConfirmed = true;
      return finish("complete", "当前登录账号未关注任何账号（平台已确认）。");
    }
    followingOpened = true;
    if (id === "x") {
      // X's home "Following" tab is a post feed, NOT the followed-account
      // directory. Navigate only the identified viewer's separate list route.
      const followingNavigation = await page.goto(`${self.profileUrl}/following`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (followingNavigation?.status() >= 400) throw failure("platform-unavailable", "X 当前账号的关注页面暂不可访问，请稍后重试。");
      const followingSnapshot = await page.evaluate(readNavigationSnapshot, id);
      if (requiresLogin(followingSnapshot)) throw failure("login-required", "X 关注页面要求登录或平台验证，请在“我的账号”验证登录后重试。");
      if (!isXFollowingRoute(followingSnapshot.url, self)) {
        throw failure("following-list-unavailable", "X 未打开当前账号自己的关注页面，请稍后重试。");
      }
      followingScopeConfirmed = true;
      confirmFollowingScope();
    } else {
      const clickOptions = { signal: workSignal, timeoutMs: navigationTimeoutMs };
      let opened = await clickFollowingEntry(page, id, entry, clickOptions);
      if (!opened && id === "facebook" && entry.friendsHref) {
        await page.locator(`a[href=${JSON.stringify(entry.friendsHref)}]`).first().click({ timeout: 5000 });
        await page.waitForTimeout(settleMs);
        const friendsEntry = await waitForPlatformFollowingEntry(page, id, { signal: workSignal,
          timeoutMs: navigationTimeoutMs, viewer: self, allowFriends: false, allowMore: false });
        opened = await clickFollowingEntry(page, id, friendsEntry, clickOptions);
      }
      if (!opened && id === "facebook") {
        // Try the usual Friends > Following path first. Opening the profile
        // sections menu is a fallback, not an extra delay on every read.
        const currentEntry = await page.evaluate(readFollowingEntry, id);
        if (currentEntry.moreSelector) {
          await page.locator(currentEntry.moreSelector).first().click({ timeout: 5000 });
          const expandedEntry = await waitForPlatformFollowingEntry(page, id, { signal: workSignal,
            timeoutMs: navigationTimeoutMs, viewer: self, allowFriends: false, allowMore: false });
          opened = await clickFollowingEntry(page, id, expandedEntry, clickOptions);
        }
      }
      if (!opened) throw failure(id === "facebook" ? "facebook-following-unavailable" : "following-list-unavailable",
        "已确认当前登录账号，但平台主页未提供可读取的关注名单入口。好友、粉丝和推荐账号不会被当作关注列表。");
      const followingSnapshot = await page.evaluate(readNavigationSnapshot, id);
      if (requiresLogin(followingSnapshot)) throw failure("login-required", "关注页面要求登录或平台验证，请在“我的账号”验证登录后重试。");
      if (!isOwnFollowingLocation(id, followingSnapshot.url, self)) throw failure("following-list-unavailable", "平台没有打开当前账号自己的关注页面，本次读取已停止。");
      followingScopeConfirmed = true;
      confirmFollowingScope();
    }
    let previousCount = -1, previousCursor = null;
    const initialListDeadline = Date.now() + navigationTimeoutMs;
    for (let round = 0; round < maxPages; round += 1) {
      if (workSignal.aborted) throw abortError();
      await page.waitForTimeout(settleMs);
      const followingSnapshot = await page.evaluate(readNavigationSnapshot, id);
      if (requiresLogin(followingSnapshot) || !isOwnFollowingLocation(id, followingSnapshot.url, self)) {
        followingScopeConfirmed = false;
        throw failure(requiresLogin(followingSnapshot) ? "login-required" : "following-list-unavailable", "平台已离开当前账号的关注页面，本次读取已停止。");
      }
      await awaitPending();
      const rows = await page.evaluate(readFollowingRows, id);
      if (workSignal.aborted) throw abortError();
      if (rows.url && !isOwnFollowingLocation(id, rows.url, self)
        || typeof page.url === "function" && !isOwnFollowingLocation(id, page.url(), self)) {
        followingScopeConfirmed = false;
        throw failure("following-list-unavailable", "平台已离开当前账号的关注页面，本次读取已停止。");
      }
      add(rows.links); publish();
      await awaitPending();
      if (workSignal.aborted) throw abortError();
      if (terminal && !parseFailed && (accounts.size > 0 || terminalEmptyConfirmed)
        || rows.explicitEnd && !parseFailed && accounts.size > 0
        || expectedCount > 0 && accounts.size === expectedCount && !parseFailed) {
        emptyConfirmed = accounts.size === 0 && terminalEmptyConfirmed;
        return finish("complete", `已读取当前列表中的 ${accounts.size} 个已关注账号，请选择需要导入的人物。`);
      }
      if (accounts.size >= maxAccounts) return finish("partial", `已读取 ${accounts.size} 个账号，达到本次读取上限；可先选择导入这些账号。`);
      stagnantRounds = accounts.size === previousCount && previousCursor === lastCursor ? stagnantRounds + 1 : 0;
      previousCount = accounts.size; previousCursor = lastCursor;
      if (stagnantRounds >= 5 && (accounts.size || Date.now() >= initialListDeadline)) break;
    }
    if (!accounts.size) throw failure("following-list-unavailable", "平台未提供可读取的已关注列表，请确认当前账号能查看自己的关注列表；这不代表列表为空。");
    return finish("partial", `已读取 ${accounts.size} 个账号，但平台没有确认列表已全部返回；可先选择导入这些账号，稍后重试读取。`);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (accessRestriction) {
      if (accounts.size) return finish("partial", "平台拒绝了后续关注列表请求，已停止读取；已读取的账号仍可选择导入。");
      throw accessRestriction;
    }
    if (timedOut) return finish("partial", `已读取 ${accounts.size} 个账号，本次读取超时；可先选择导入这些账号，稍后重试。`);
    if (accounts.size) return finish("partial", `已读取 ${accounts.size} 个账号，后续读取未完成：${cleanText(error.message, 250)}`);
    if (/user data directory is already in use|ProcessSingleton|profile.*in use/i.test(String(error?.message))) {
      throw failure("profile-busy", "该绑定登录资料正在使用中，请关闭对应登录窗口或等待当前任务结束后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    disposed = true;
    followingScopeConfirmed = false;
    confirmFollowingScope();
    workSignal.removeEventListener("abort", cancel);
    page?.off?.("response", responseListener);
    await disposeConfirmed();
    let settleTimer;
    try { await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => { settleTimer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(settleTimer); }
  }
}

