import { classifyTikTokLogin } from "./tiktok-login.mjs";

const LOGIN_PATH_PATTERNS = Object.freeze({
  x: [/\/login(?:[/?#]|$)/i, /\/i\/flow\/login/i],
  instagram: [/\/accounts\/login/i],
  threads: [/\/login(?:[/?#]|$)/i],
  facebook: [/\/login(?:[/?#]|$)/i, /\/checkpoint\//i],
  tiktok: [/\/login(?:[/?#]|$)/i],
});

const TIKTOK_SESSION_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt"]);

export function hasValidTikTokSession(cookies = [], nowMs = Date.now()) {
  // Cached cookie presence is not proof of a successful online login check.
  return cookies.some((cookie) => {
    const domain = String(cookie?.domain || "").toLowerCase().replace(/^\./, "");
    const expires = Number(cookie?.expires ?? -1);
    const unexpired = expires < 0 || (Number.isFinite(expires) && expires * 1_000 > nowMs);
    return (domain === "tiktok.com" || domain.endsWith(".tiktok.com"))
      && TIKTOK_SESSION_COOKIE_NAMES.has(String(cookie?.name || ""))
      && Boolean(cookie?.value)
      && unexpired;
  });
}

export function classifyLogin(platformId, snapshot) {
  if (platformId === "tiktok") return classifyTikTokLogin(snapshot);
  const url = String(snapshot?.url || "");
  const bodyText = String(snapshot?.bodyText || "").slice(0, 4000);
  const patterns = LOGIN_PATH_PATTERNS[platformId] || [];
  const onLoginPage = patterns.some((pattern) => pattern.test(url));
  const hasCredentialForm = Boolean(snapshot?.hasPasswordField || snapshot?.hasUsernameField);
  const hasLoginPrompt = Boolean(snapshot?.hasLoginPrompt) || /(?:^|\s)(?:log in|sign in|登录)(?:\s|$)/i.test(bodyText)
    && !/(?:log out|退出登录)/i.test(bodyText);

  if (snapshot?.hasAuthenticatedMarker) {
    return { verified: true, message: "已确认账号处于登录状态。" };
  }

  if (onLoginPage || hasCredentialForm) {
    return { verified: false, message: "平台仍显示登录输入框，请在独立登录窗口中完成登录后再次验证。" };
  }

  if (["threads", "tiktok"].includes(platformId) && hasLoginPrompt) {
    return { verified: false, message: `${platformId === "tiktok" ? "TikTok" : "Threads"} 页面仍显示登录入口。` };
  }

  return { verified: true, message: "已通过基本登录验证。" };
}
