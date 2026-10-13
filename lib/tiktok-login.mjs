function isTikTokPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"));
  } catch { return false; }
}

export function classifyTikTokLogin(snapshot = {}) {
  if (!isTikTokPage(snapshot.url)) {
    return { verified: false, message: "当前页面不是 TikTok 官方页面，无法确认登录状态。" };
  }
  const status = Number(snapshot.status ?? 200);
  if (snapshot.networkError || !Number.isFinite(status) || status < 200 || status >= 400) {
    return { verified: false, message: status >= 400
      ? `TikTok 页面返回 HTTP ${status}，尚未通过在线登录验证。`
      : "TikTok 页面未能正常加载，尚未通过在线登录验证。" };
  }
  const pathname = new URL(snapshot.url).pathname;
  if (snapshot.hasCaptcha || /\/(?:captcha|verify)(?:\/|$)/i.test(pathname)) {
    return { verified: false, message: "TikTok 要求完成验证，请在登录窗口完成验证后重试。" };
  }
  if (/\/login(?:\/|$)/i.test(pathname) || snapshot.hasPasswordField || snapshot.hasUsernameField || snapshot.hasLoginPrompt) {
    return { verified: false, message: "TikTok 页面仍显示登录入口，请完成登录后再次验证。" };
  }
  // Only app-context.user describes the current viewer. Profile/author data
  // and generic navigation links can also be present for anonymous visitors.
  const uid = String(snapshot.viewer?.uid ?? "").trim();
  const username = String(snapshot.viewer?.uniqueId ?? "").trim();
  if (!/^\d+$/.test(uid) || /^0+$/.test(uid) || !/^[A-Za-z0-9._]{1,64}$/.test(username)) {
    return { verified: false, message: "尚未读取到 TikTok 当前登录账号，请等待页面加载完成后再次验证。" };
  }
  return { verified: true, username, message: `已在线确认 TikTok 账号 @${username} 处于登录状态。` };
}

export async function inspectTikTokPageLogin(page, { status = 200 } = {}) {
  let snapshot;
  try {
    snapshot = await page.evaluate(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden"
          && bounds.width > 0 && bounds.height > 0;
      };
      const visible = (selector) => [...document.querySelectorAll(selector)].some(isVisible);
      let viewer = null;
      for (const script of document.querySelectorAll("script#__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
        try {
          const payload = JSON.parse(script.textContent || "{}");
          const user = payload.__DEFAULT_SCOPE__?.["webapp.app-context"]?.user;
          if (user && typeof user === "object") {
            viewer = { uid: user.uid, uniqueId: user.uniqueId };
            break;
          }
        } catch {}
      }
      return {
        url: location.href,
        viewer,
        hasCaptcha: visible('iframe[src*="captcha"], #captcha_container, [id^="captcha-verify"], [data-e2e="captcha"]'),
        hasPasswordField: visible('input[type="password"]'),
        hasUsernameField: visible('input[name="username"], input[name="email"][autocomplete="username"]'),
        hasLoginPrompt: visible('button[data-e2e*="login"], [data-e2e="top-login-button"], a[href*="/login"]'),
      };
    });
  } catch {
    return { verified: false, message: "无法读取 TikTok 登录页面，请等待页面加载完成后再次验证。" };
  }
  return classifyTikTokLogin({ ...snapshot, status });
}
