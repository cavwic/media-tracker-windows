import { chromium } from "playwright";
import { BACKGROUND_CHROMIUM_EXECUTABLE } from "./background-chromium.mjs";
import { assertCustomPublicUrl, validateTargetUrl } from "./platform-registry.mjs";

const LOGIN_PATH = /\/(?:login|signin|sign-in|passport|checkpoint|captcha)(?:[/?#]|$)/i;
const fail = (message, code = "login-unverified") => ({ verified: false, code, message });

function authenticatedFailure(platform, snapshot) {
  if (!platform.loginMarker) return fail("此平台尚未配置登录验证规则。请在“平台设置”指定登录后独有页面及元素标记，再验证；保存 Cookie 或打开页面不等于验证成功。", "login-rule-required");
  try { validateTargetUrl(platform, snapshot.url); } catch { return fail("页面跳转到了其他站点，无法确认该平台的登录状态。"); }
  if (!(snapshot.status >= 200 && snapshot.status < 300)) return fail(`登录验证页面未正常返回（HTTP ${snapshot.status || "未知"}）。`);
  if (snapshot.invalidSelector) return fail("登录验证 CSS 选择器无效，请修改平台设置。", "login-rule-invalid");
  if (snapshot.rootMarker) return fail("登录标记匹配到了 HTML 或 BODY 页面根元素，不能用整页证明登录。请改为登录后专有元素。", "login-rule-invalid");
  if (snapshot.challenge || snapshot.hasCredentialForm || snapshot.loggedOut
    || LOGIN_PATH.test(snapshot.url)) {
    return fail("仍需登录、验证码或身份确认。请打开专用登录窗口完成操作后重试。");
  }
  if (!snapshot.loggedIn) return fail("没有找到指定的登录后专属标记。请检查登录是否过期，或修改平台的验证规则。");
  return null;
}

export function classifyCustomLogin(platform, snapshot = {}) {
  const candidateFailure = authenticatedFailure(platform, snapshot);
  if (candidateFailure) return candidateFailure;
  const anonymous = snapshot.anonymous;
  const uncertain = (message) => fail(message, "login-comparison-inconclusive");
  if (!anonymous) return uncertain("登录标记已出现，但尚未完成独立匿名对照，不能确认登录成功。");
  try { validateTargetUrl(platform, anonymous.url); }
  catch { return uncertain("匿名验证页面跳转到了其他站点，无法确认此标记是否仅在登录后出现。请换用同平台验证页面。"); }
  if (!(anonymous.status >= 200 && anonymous.status < 300) || anonymous.challenge || anonymous.invalidSelector) {
    return uncertain("匿名对照遇到网络错误、访问验证或无效规则，未将标记缺失视为登录成功。请检查验证页面后重试。");
  }
  if (anonymous.rootMarker) return fail("匿名对照发现登录标记匹配整页根元素，请改用登录后专有标记。", "login-rule-invalid");
  if (anonymous.loggedIn) return fail("该登录标记在未登录的独立窗口中也可见，不能证明已登录。请改用登录后专有元素。", "login-marker-public");
  // An empty/unrendered public page is not evidence of a logged-out state.
  if (!(anonymous.loggedOut || anonymous.hasCredentialForm || /\/(?:login|signin|sign-in)(?:[/?#]|$)/i.test(anonymous.url))) {
    return uncertain("匿名页面没有明确的未登录证据。请补充“未登录时可见标记”，或使用未登录时会跳转到登录页的验证页面。");
  }
  return { verified: true, code: "verified-marker", message: "登录后标记已通过独立匿名对照；目标账号的内容访问权限仍需点击“测试采集”确认。" };
}

export async function readCustomLoginSnapshot(page, platform) {
  return page.evaluate(({ loginMarker, logoutMarker }) => {
    const visible = (element) => {
      const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    try {
      const loginElements = [...document.querySelectorAll(loginMarker)];
      return { url: location.href,
        rootMarker: loginElements.some((element) => ["HTML", "BODY"].includes(element.tagName)),
        loggedIn: loginElements.some(visible),
        loggedOut: Boolean(logoutMarker) && [...document.querySelectorAll(logoutMarker)].some(visible),
        hasCredentialForm: [...document.querySelectorAll('input[type="password"], input[autocomplete="username"]')].some(visible),
        challenge: [...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"], [class*="captcha"]')].some(visible),
      };
    } catch { return { url: location.href, invalidSelector: true }; }
  }, platform);
}

export async function inspectCustomLogin(platform, account, { browserType = chromium, checkUrl = assertCustomPublicUrl } = {}) {
  if (!platform.loginMarker) return classifyCustomLogin(platform);
  let context;
  let anonymousContext;
  let comparing = false;
  try {
    const url = validateTargetUrl(platform, platform.verificationUrl || platform.homepageUrl);
    await checkUrl(url);
    context = await browserType.launchPersistentContext(account.profileDirectory, {
      headless: true, serviceWorkers: "block", viewport: { width: 1280, height: 800 },
      executablePath: BACKGROUND_CHROMIUM_EXECUTABLE,
      args: ["--no-first-run", "--disable-background-mode"],
    });
    // Both contexts recheck redirects and subresources. The anonymous context
    // receives no storageState, cookies or credentials from the linked profile.
    const guard = async (route) => {
      try { await checkUrl(route.request().url()); await route.continue(); }
      catch { await route.abort(); }
    };
    await context.route("**/*", guard);
    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1000);
    const snapshot = { ...await readCustomLoginSnapshot(page, platform), status: response?.status() || 0 };
    const candidateFailure = authenticatedFailure(platform, snapshot);
    if (candidateFailure) return candidateFailure;
    comparing = true;
    const browser = context.browser();
    if (!browser) return fail("无法创建独立匿名对照，暂不能确认此自定义平台登录状态。", "login-comparison-inconclusive");
    anonymousContext = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
    await anonymousContext.route("**/*", guard);
    const anonymousPage = await anonymousContext.newPage();
    const anonymousResponse = await anonymousPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await anonymousPage.waitForTimeout(1000);
    const anonymous = { ...await readCustomLoginSnapshot(anonymousPage, platform), status: anonymousResponse?.status() || 0 };
    return classifyCustomLogin(platform, { ...snapshot, anonymous });
  } catch (error) {
    if (/ProcessSingleton|user data directory is already in use|profile.*in use/i.test(String(error?.message))) {
      return { verified: false, code: "profile-busy", message: "专用登录窗口仍在使用，请先关闭再验证。" };
    }
    if (comparing) return fail("独立匿名对照未完成，不能将匿名页面的网络失败当作登录成功。请检查网络和平台访问验证后重试。", "login-comparison-inconclusive");
    return { verified: false, code: "login-check-failed", message: "登录验证未完成：网络、站点限制或验证页面不可用，请在专用窗口检查后重试。" };
  } finally {
    await anonymousContext?.close().catch(() => {});
    await context?.close().catch(() => {});
  }
}
