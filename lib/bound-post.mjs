import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { syncScopeKey } from "./sync-store.mjs";
import { validateTargetUrl } from "./platform-registry.mjs";

const failure = (status, message) => Object.assign(new Error(message), { status });
const HASH = /^[a-f0-9]{64}$/;
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);

export function validateRecordedPostUrl(platform, value) {
  if (typeof value !== "string") throw failure(400, "原帖链接无效，未打开任何窗口。");
  let url;
  try { url = new URL(value); } catch { throw failure(400, "原帖链接无效，未打开任何窗口。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 4000) {
    throw failure(400, "仅能打开该平台的安全原帖链接。");
  }
  if (platform.custom) return validateTargetUrl(platform, value);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const route = url.pathname;
  const accepted = platform.id === "instagram" ? host === "instagram.com" && /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(route)
    : platform.id === "x" ? ["x.com", "twitter.com"].includes(host) && /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(route)
    : platform.id === "tiktok" ? host === "tiktok.com" && /^\/@[A-Za-z0-9_.]+\/(?:video|photo)\/\d+\/?$/.test(route)
    : platform.id === "threads" ? ["threads.com", "threads.net"].includes(host) && /^\/@[A-Za-z0-9_.]+\/post\/[A-Za-z0-9_-]+\/?$/.test(route)
    : platform.id === "facebook" ? host === "facebook.com" && /^\/(?:[A-Za-z0-9_.-]+\/(?:posts|videos)\/[A-Za-z0-9_.-]+|(?:permalink|story|photo)\.php|photo|reel\/\d+)\/?$/.test(route)
    : false;
  if (!accepted) throw failure(400, "原帖不属于当前绑定的平台，未打开任何窗口。");
  url.hash = "";
  const parameters = [...url.searchParams];
  url.search = "";
  if (platform.id === "facebook") for (const [key, value] of parameters) {
    if (["id", "story_fbid", "fbid"].includes(key) && /^[A-Za-z0-9_-]{1,512}$/.test(value)) url.searchParams.set(key, value);
  }
  return url.href;
}

// Client identifiers select existing authoritative records; URLs, cookies and
// browser directories are never accepted from the frontend.
export async function resolveBoundPost({ state, personId, body, scopes, openMediaIndex, profilesRoot }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw failure(400, "请选择已记录的原帖。");
  const keys = Object.keys(body).sort().join(",");
  const bySource = keys === "mediaId,sourceKey" && typeof body.mediaId === "string" && HASH.test(body.mediaId) && identifier(body.sourceKey);
  const byPost = keys === "accountId,platformId,postId" && [body.accountId, body.platformId, body.postId].every(identifier);
  if (!bySource && !byPost) throw failure(400, "打开原帖只接受已记录的来源标识，不接受网址或目录参数。");
  const person = state.persons.find((item) => item.id === personId);
  if (!person) throw failure(404, "采集账号不存在。");
  let source;
  if (bySource) {
    const index = await openMediaIndex(person);
    if (!index.get(body.mediaId, { includeFingerprint: false })) throw failure(404, "媒体记录不存在。");
    source = index.sources(body.mediaId).find((item) => JSON.stringify([item.platformId, item.accountId, item.logicalKey]) === body.sourceKey);
    if (!source) throw failure(404, "这条发布来源不存在。");
  } else {
    const scope = scopes[syncScopeKey(person.id, body.platformId, body.accountId)];
    source = Object.values(scope?.pendingPosts || {}).find((item) => String(item.postId || item.postKey) === body.postId);
    if (!source) source = Object.values(scope?.media || {}).find((item) => String(item.postId || item.postKey) === body.postId && item.postUrl);
    if (!source) throw failure(404, "该原帖已不在补查记录中，请刷新回执。");
    source = { ...source, platformId: body.platformId, accountId: body.accountId };
  }
  const configured = person.platforms.find((item) => item.id === source.platformId);
  const account = configured?.accounts.find((item) => item.id === source.accountId);
  if (!account) throw failure(409, "这个历史来源账号已移除，无法使用原绑定会话打开。");
  const linked = state.linkedAccounts.find((item) => item.id === account.linkedAccountId);
  if (!linked || linked.platformId !== configured.id || !linked.profileDirectory) {
    throw failure(409, "该目标账号没有可用的关联登录资料，请在账号设置中选择已有绑定。");
  }
  const profile = path.resolve(linked.profileDirectory);
  if (path.dirname(profile).toLowerCase() !== path.join(path.resolve(profilesRoot), linked.platformId).toLowerCase()) {
    throw failure(400, "登录资料路径不属于工具，未打开任何窗口。");
  }
  const custom = state.customPlatforms?.find((item) => item.id === configured.id && item.custom);
  const platform = { ...(custom || {}), id: configured.id, custom: Boolean(custom) };
  return { person, platform, account, linked, url: validateRecordedPostUrl(platform, source.postUrl), profile };
}

export async function assertBoundProfile({ profile, platform, profilesRoot }) {
  const root = path.resolve(profilesRoot);
  if (path.dirname(path.resolve(profile)).toLowerCase() !== path.join(root, platform.id).toLowerCase()) {
    throw failure(400, "登录资料目录越界，未打开原帖。");
  }
  for (const directory of [root, path.join(root, platform.id), profile]) {
    let info;
    try { info = await lstat(directory); }
    catch { throw failure(409, "登录资料目录暂时无法访问，请检查原有绑定；不会新建未登录窗口。"); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure(400, "登录资料目录异常，未打开原帖。");
  }
  let actualRoot, actualProfile;
  try { [actualRoot, actualProfile] = await Promise.all([realpath(root), realpath(profile)]); }
  catch { throw failure(409, "登录资料目录暂时无法访问，请检查原有绑定；不会新建未登录窗口。"); }
  const relative = path.relative(actualRoot, actualProfile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure(400, "登录资料目录越界，未打开原帖。");
}
