import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { PLATFORMS, sanitizeSegment } from "./archive.mjs";
import { isBlockedAddress } from "./homepage-discovery.mjs";

export const CUSTOM_PLATFORM_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENGINES = new Set(["auto", "yt-dlp", "none"]);
const hostKey = (hostname) => hostname.toLowerCase().replace(/^www\./, "");
const nameKey = (value) => String(value).normalize("NFKC").trim().toLowerCase();
const invalid = (message) => Object.assign(new Error(message), { status: 400, code: "invalid-platform" });

export function normalizeCustomUrl(value, field = "网站地址") {
  const source = String(value || "").trim();
  if (!source || source.length > 2048) throw invalid(`${field}为空或过长。`);
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `https://${source}`); }
  catch { throw invalid(`${field}格式无效。`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.port || url.username || url.password
    || !host.includes(".") || host.endsWith(".") || net.isIP(host.replace(/^\[|\]$/g, ""))
    || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host)) {
    throw invalid(`${field}必须是不含密码、使用标准 HTTPS 的公网域名，不能使用本机或局域网地址。`);
  }
  url.hash = "";
  return url.href;
}

export function validateTargetUrl(platform, value) {
  const url = normalizeCustomUrl(value, "账号或平台页面地址");
  if (hostKey(new URL(url).hostname) !== hostKey(new URL(platform.homepageUrl).hostname)) {
    throw invalid("账号及验证页面必须属于该自定义平台的域名；其他平台请分别创建，避免混用登录资料。");
  }
  return url;
}

export async function assertCustomPublicUrl(value, lookup = dns.lookup) {
  const url = normalizeCustomUrl(value);
  const addresses = await lookup(new URL(url).hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw invalid("网站解析到了本机、局域网或保留地址，已拒绝访问。");
  }
  return url;
}

function marker(value, label) {
  const result = String(value || "").trim();
  if (result.length > 500 || /[\r\n\x00]/.test(result)) throw invalid(`${label}格式无效。`);
  if (result && (!/[.#\[]/.test(result) || /(?:^|,)\s*(?:html|body|\*)(?=[\s.#\[:>+~,]|$)/i.test(result))) {
    throw invalid(`${label}请使用具体的 CSS 选择器（如 #account-menu），不能用通用页面元素。`);
  }
  return result;
}

function definition(input, { id, folderName, preserveLegacyEngine = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("自定义平台配置格式无效。");
  const label = String(input.label || "").normalize("NFKC").trim();
  let safeLabel;
  try { safeLabel = sanitizeSegment(label); } catch { throw invalid("平台名称须为 1–60 个合法文件夹字符，不能含路径分隔符。"); }
  if (!label || label.length > 60 || safeLabel !== label) throw invalid("平台名称须为 1–60 个合法文件夹字符，不能含路径分隔符。");
  const homepageUrl = normalizeCustomUrl(input.homepageUrl);
  const result = { id: id || `custom-${randomUUID()}`, custom: true, label,
    folderName: folderName || label, homepageUrl, engine: String(input.engine || "auto") };
  if (result.engine === "gallery-dl" && !preserveLegacyEngine) {
    throw invalid("公开发行版未集成 gallery-dl；请改用 yt-dlp 或仅登记平台信息，不会自动替换旧的采集方式。");
  }
  // Legacy definitions remain visible/editable, but custom-sync rejects this
  // engine before reading a login session or launching any process.
  if (!ENGINES.has(result.engine) && !(preserveLegacyEngine && result.engine === "gallery-dl")) throw invalid("采集方式无效。");
  result.loginUrl = validateTargetUrl(result, input.loginUrl || homepageUrl);
  // Optional navigation metadata: do not invalidate an authenticated binding
  // or change the independent media-download adapter when it is edited.
  const followingUrl = String(input.followingUrl || "").trim();
  result.followingUrl = followingUrl ? validateTargetUrl(result, followingUrl) : "";
  result.verificationUrl = input.verificationUrl ? validateTargetUrl(result, input.verificationUrl) : "";
  result.loginMarker = marker(input.loginMarker, "登录成功标记");
  result.logoutMarker = marker(input.logoutMarker, "未登录标记");
  return result;
}

export function normalizeCustomPlatforms(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw invalid("自定义平台列表格式无效或超过 100 个。");
  const ids = new Set();
  const names = new Set(Object.values(PLATFORMS).map((platform) => nameKey(platform.label)));
  const folders = new Set(names);
  return value.map((item) => {
    if (!item || !CUSTOM_PLATFORM_ID.test(item.id) || ids.has(item.id)) throw invalid("自定义平台 ID 无效或重复。");
    const result = definition(item, { id: item.id, folderName: item.folderName || item.label, preserveLegacyEngine: true });
    if (sanitizeSegment(result.folderName) !== result.folderName || result.folderName.length > 100) throw invalid("平台目录名无效。");
    if (names.has(nameKey(result.label)) || folders.has(nameKey(result.folderName))) throw invalid("平台名称或目录名与现有平台重复。");
    ids.add(result.id); names.add(nameKey(result.label)); folders.add(nameKey(result.folderName));
    return result;
  });
}

export function getPlatformRegistry(customPlatforms = []) {
  return Object.assign(Object.create(null), PLATFORMS,
    Object.fromEntries(normalizeCustomPlatforms(customPlatforms).map((item) => [item.id, item])));
}

export function createCustomPlatform(input, existing = []) {
  const result = definition(input);
  normalizeCustomPlatforms([...existing, result]);
  return result;
}

export function updateCustomPlatform(previous, input, existing = []) {
  const result = definition({ ...previous, ...input }, { id: previous.id, folderName: previous.folderName });
  if (hostKey(new URL(result.homepageUrl).hostname) !== hostKey(new URL(previous.homepageUrl).hostname)) {
    throw invalid("不能把现有平台改成另一个网站；请新建平台，以隔离已有登录资料。");
  }
  normalizeCustomPlatforms(existing.map((item) => item.id === result.id ? result : item));
  return result;
}
