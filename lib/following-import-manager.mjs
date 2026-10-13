import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPlatformRegistry } from "./platform-registry.mjs";
import { canonicalFollowingAccount, discoverFollowing } from "./following-discovery.mjs";
import { canonicalCustomFollowingAccount, discoverCustomFollowing } from "./custom-following.mjs";

export const FOLLOWING_SUPPORTED_PLATFORM_IDS = Object.freeze(["x", "instagram", "facebook", "threads", "tiktok"]);
export function followingSupportedPlatformIds(customPlatforms = []) {
  return [...FOLLOWING_SUPPORTED_PLATFORM_IDS, ...Object.values(getPlatformRegistry(customPlatforms))
    .filter(platform => platform.custom && platform.followingUrl).map(platform => platform.id)];
}
const discoverConfiguredFollowing = input => input.platform.custom ? discoverCustomFollowing(input) : discoverFollowing(input);
const ACTIVE = new Set(["queued", "running"]);
const invalid = (status, message) => Object.assign(new Error(message), { status });
const keyForProfile = value => path.resolve(value).toLowerCase();
const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
const abortError = () => new DOMException("已停止读取已关注账号。", "AbortError");
const FAILURE_MESSAGES = Object.freeze({
  "login-required": "当前登录资料未通过在线登录检查，请在“我的账号”完成登录并验证后重试。",
  "profile-busy": "这个账号的独立登录窗口仍在使用，请关闭登录窗口后重试；未关闭任何现有页面。",
  "profile-missing": "登录资料文件夹不存在或无法读取，请在“我的账号”检查原绑定；未重建或清除登录资料。",
  "binding-changed": "这个登录绑定已解除或发生变化，请重新选择当前绑定后读取。",
  "platform-changed": "该平台的关注页或登录验证配置已改变，请重新选择平台后读取；未修改登录资料。",
  "following-url-required": "请先在平台设置中添加该自定义平台的关注页，再读取已关注账号；手动添加账号及现有媒体同步不受影响。",
  "login-rule-required": "该自定义平台尚未配置登录验证规则，请先在平台设置中配置并验证登录，再读取关注页。",
  "login-rule-invalid": "该自定义平台的登录验证规则无效，请在平台设置中修改后重新验证登录。",
  "following-url-unsafe": "关注页跳转到了其他网站或非公网地址，已停止读取；请检查平台设置中的关注页地址。",
  "custom-following-ui-missing": "此关注页没有提供可识别的已关注列表，请检查关注页地址，或手动添加账号；该网站的页面结构可能需要专用适配。",
  "self-unknown": "平台尚未提供可确认的当前账号主页入口，请稍后重试；没有使用绑定名称猜测账号。只有平台要求登录时才需要重新验证登录。",
  "following-ui-missing": "平台未提供可读取的已关注列表，请确认当前账号能查看自己的关注列表。",
  "facebook-following-unavailable": "已确认 Facebook 登录及本人主页，但当前页面未显示关注名单入口；不是登录绑定失效。请提供能打开的关注名单网址，或手动添加目标账号。",
  "deadline": "读取已关注列表超时，已保留本次已读取的候选账号。可以稍后重新读取。",
  "browser-unavailable": "工具的后台浏览器暂时无法启动，请关闭独立登录窗口后重试。",
  "browser-close-failed": "本次后台工作页未能确认关闭，已暂停使用这份登录资料以避免冲突。请完整退出工具后重新打开；登录信息和媒体未删除。",
  "network": "未能连接平台或读取已关注列表，请检查网络及当前登录账号的访问权限。",
  "access-restricted": "平台拒绝了关注列表请求（未授权、访问受限或限流），本次读取已停止；请检查账号权限或稍后重试。",
});
const FAILURE_ALIASES = Object.freeze({ "self-profile-unavailable": "self-unknown",
  "following-list-unavailable": "following-ui-missing", "platform-unavailable": "network" });

/** Read-only, bounded in-memory jobs. No state, media or checkpoint writes. */
export class FollowingImportManager {
  constructor({ loadState, scheduler, discover = discoverConfiguredFollowing,
    withProfileUse = (_account, callback) => callback(), checkProfile = async () => {},
    signal, timeoutMs = 180_000, retentionMs = 3_600_000, maxJobs = 20,
    maxAccounts = 10_000, now = Date.now } = {}) {
    this.loadState = loadState;
    this.scheduler = scheduler;
    this.discover = discover;
    this.withProfileUse = withProfileUse;
    this.checkProfile = checkProfile;
    this.timeoutMs = timeoutMs;
    this.retentionMs = retentionMs;
    this.maxJobs = maxJobs;
    this.maxAccounts = maxAccounts;
    this.now = now;
    this.jobs = new Map();
    this.closed = false;
    this.signal = signal;
    this.abort = () => {
      this.closed = true;
      for (const entry of this.jobs.values()) if (ACTIVE.has(entry.job.status)) this.stop(entry);
    };
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  prune() {
    for (const [id, entry] of this.jobs) {
      if (!entry.retainedLease && !ACTIVE.has(entry.job.status) && this.now() - entry.finishedAt >= this.retentionMs) this.jobs.delete(id);
    }
    while (this.jobs.size >= this.maxJobs) {
      const oldest = [...this.jobs].find(([, entry]) => !entry.retainedLease && !ACTIVE.has(entry.job.status));
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
    }
  }

  publicJob(entry) {
    // Private snapshots, profile paths, callbacks and lease keys never escape.
    return structuredClone(entry.job);
  }

  async start(input) {
    if (this.closed) throw invalid(503, "工具正在退出，不能开始读取已关注账号。");
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => key !== "linkedAccountId") || !validId(input.linkedAccountId)) {
      throw invalid(400, "请选择已绑定的登录账号；不接受网址、密码或登录资料路径。");
    }
    const state = await this.loadState();
    if (this.closed) throw invalid(503, "工具正在退出，不能开始读取已关注账号。");
    const account = state.linkedAccounts?.find(item => item.id === input.linkedAccountId);
    if (!account) throw invalid(404, "关联账号不存在，请重新选择。");
    const platform = getPlatformRegistry(state.customPlatforms)[account.platformId];
    if (!platform || !platform.custom && !FOLLOWING_SUPPORTED_PLATFORM_IDS.includes(account.platformId)) {
      throw invalid(400, "该自定义平台尚未接入关注列表读取，请手动添加目标账号；现有内容同步不受影响。");
    }
    if (platform.custom && !platform.followingUrl) throw invalid(409, FAILURE_MESSAGES["following-url-required"]);
    if (account.loginStatus !== "verified") throw invalid(409, "请先在“我的账号”验证这个账号登录成功，再读取已关注列表；无需重新绑定。");
    if (typeof account.profileDirectory !== "string" || !path.isAbsolute(account.profileDirectory)
      || /[\0\r\n]/.test(account.profileDirectory)) throw invalid(409, FAILURE_MESSAGES["profile-missing"]);
    const existing = [...this.jobs.values()].find(entry => entry.account.id === account.id && ACTIVE.has(entry.job.status));
    if (existing) return this.publicJob(existing);
    if ([...this.jobs.values()].some(entry => entry.retainedLease
      && keyForProfile(entry.account.profileDirectory) === keyForProfile(account.profileDirectory))) {
      throw invalid(409, FAILURE_MESSAGES["browser-close-failed"]);
    }
    this.prune();
    if (this.jobs.size >= this.maxJobs) throw invalid(429, "读取任务较多，请先停止不需要的任务后重试。");
    const entry = {
      account: structuredClone(account), platform: { ...structuredClone(platform), id: account.platformId },
      controller: new AbortController(), targets: new Map(), finishedAt: null,
      job: { id: randomUUID(), linkedAccountId: account.id, platformId: account.platformId,
        platform: platform.label, accountLabel: String(account.label || "").slice(0, 200),
        status: "queued", phase: "queued", accounts: [], discovered: 0,
        completeness: "partial", emptyConfirmed: false, message: "正在等待这个账号的登录会话；其他人物和平台仍可继续同步。",
        error: "", errorCode: "", cancelRequested: false,
        startedAt: new Date(this.now()).toISOString(), finishedAt: null },
    };
    this.jobs.set(entry.job.id, entry);
    entry.promise = this.run(entry);
    // The response always uses this explicit whitelist, not the entry itself.
    return this.publicJob(entry);
  }

  get(id) {
    if (!validId(id)) throw invalid(400, "已关注读取任务标识无效。");
    const entry = this.jobs.get(id);
    if (!entry) throw invalid(404, "已关注读取结果已关闭或过期，请重新读取。");
    if (!entry.retainedLease && !ACTIVE.has(entry.job.status) && this.now() - entry.finishedAt >= this.retentionMs) {
      this.jobs.delete(id);
      throw invalid(404, "已关注读取结果已关闭或过期，请重新读取。");
    }
    return this.publicJob(entry);
  }

  mergeAccounts(entry, values) {
    if (!Array.isArray(values)) return;
    for (const value of values.slice(0, this.maxAccounts)) {
      const target = entry.platform.custom ? canonicalCustomFollowingAccount(entry.platform, value)
        : canonicalFollowingAccount(entry.account.platformId, value);
      if (!target) continue;
      const key = entry.platform.custom ? target.profileUrl : target.profileUrl.toLowerCase();
      if (!entry.targets.has(key) && entry.targets.size < this.maxAccounts) {
        // Ignore a supplied platform, binding, avatar or private raw response.
        entry.targets.set(key, { platformId: entry.account.platformId, handle: target.handle,
          label: target.label, displayName: target.displayName || "", profileUrl: target.profileUrl });
      }
    }
    entry.job.accounts = [...entry.targets.values()];
    entry.job.discovered = entry.targets.size;
  }

  async run(entry) {
    let release;
    let timer;
    let deadline = false;
    const signal = entry.controller.signal;
    try {
      const keys = [`login:${entry.account.id}`, `profile:${keyForProfile(entry.account.profileDirectory)}`];
      release = await this.scheduler.acquire({ keys, labels: Object.fromEntries(keys.map(key => [key, entry.platform.label])),
        owner: { personName: "读取已关注账号" }, signal,
        onWaiting: waiting => {
          if (waiting.length) entry.job.message = "正在等待这个账号的登录会话；其他人物和平台仍可继续同步。";
        } });
      signal.throwIfAborted();
      const currentState = await this.loadState();
      const current = currentState.linkedAccounts?.find(item => item.id === entry.account.id);
      if (!current || current.platformId !== entry.account.platformId
        || typeof current.profileDirectory !== "string"
        || keyForProfile(current.profileDirectory) !== keyForProfile(entry.account.profileDirectory)) {
        throw Object.assign(new Error(), { code: "binding-changed" });
      }
      if (current.loginStatus !== "verified") throw Object.assign(new Error(), { code: "login-required" });
      if (entry.platform.custom) {
        const currentPlatform = getPlatformRegistry(currentState.customPlatforms)[entry.account.platformId];
        if (!currentPlatform || ["homepageUrl", "followingUrl", "loginMarker", "logoutMarker", "verificationUrl", "loginUrl"]
          .some(field => (currentPlatform[field] || "") !== (entry.platform[field] || ""))) {
          throw Object.assign(new Error(), { code: "platform-changed" });
        }
      }
      signal.throwIfAborted();
      entry.job.status = "running";
      entry.job.phase = "reading";
      entry.job.message = "正在读取当前登录账号的已关注列表；可以停止读取并使用已显示的候选。";
      timer = setTimeout(() => { deadline = true; entry.controller.abort(abortError()); }, this.timeoutMs);
      await this.checkProfile(entry.account, { signal });
      signal.throwIfAborted();
      const result = await this.withProfileUse(entry.account, () => this.discover({
        platform: entry.platform, linkedAccount: entry.account, signal,
        onProgress: progress => {
          if (signal.aborted) return;
          this.mergeAccounts(entry, progress?.accounts);
        },
      }));
      signal.throwIfAborted();
      this.mergeAccounts(entry, result?.accounts);
      // An empty parse is not proof of an empty following list. The collector
      // must explicitly confirm zero from the signed-in viewer's count/list.
      if (!entry.targets.size && (result?.emptyConfirmed !== true || !Array.isArray(result.accounts) || result.accounts.length !== 0)) {
        throw Object.assign(new Error(), { code: "following-ui-missing" });
      }
      entry.job.emptyConfirmed = !entry.targets.size && result?.emptyConfirmed === true;
      entry.job.completeness = (entry.job.emptyConfirmed
        || result?.completeness === "complete" && entry.targets.size < this.maxAccounts) ? "complete" : "partial";
      entry.job.status = "completed";
      entry.job.message = entry.job.emptyConfirmed
        ? "当前登录账号的关注列表为空（平台已确认），可手动添加目标账号。"
        : entry.job.completeness === "complete"
        ? "已读取平台返回的完整关注列表。勾选账号后只会加入当前人物草稿，不会自动同步。"
        : "已读取当前可见的部分关注列表；平台未确认列表末尾，不代表全部关注。可导入已显示的账号或稍后重试。";
    } catch (error) {
      if (error?.code === "browser-close-failed" && error.retainProfileLease === true) {
        entry.retainedLease = true;
        entry.retryDispose = typeof error.retryDispose === "function" ? error.retryDispose : null;
        entry.job.status = "failed";
        entry.job.errorCode = "browser-close-failed";
        entry.job.error = FAILURE_MESSAGES["browser-close-failed"];
        entry.job.message = entry.job.error;
      } else if (signal.aborted && !deadline) {
        entry.job.status = "cancelled";
        entry.job.message = "已停止读取；已显示的候选仍可导入，人物及登录资料未修改。";
      } else {
        entry.job.status = "failed";
        const code = entry.platform.custom && error?.code === "following-list-unavailable"
          ? "custom-following-ui-missing" : FAILURE_ALIASES[error?.code] || error?.code;
        entry.job.errorCode = deadline ? "deadline" : Object.hasOwn(FAILURE_MESSAGES, code) ? code : "network";
        entry.job.error = FAILURE_MESSAGES[entry.job.errorCode];
        entry.job.message = entry.job.error;
      }
    } finally {
      clearTimeout(timer);
      // discover must finish its own browser/page disposal before returning.
      // Even a cancelled job retains its exclusive lease until that point.
      if (entry.retainedLease) entry.release = release;
      else release?.();
      entry.job.phase = "finished";
      entry.finishedAt = this.now();
      entry.job.finishedAt = new Date(entry.finishedAt).toISOString();
    }
  }

  stop(entry) {
    entry.job.cancelRequested = true;
    entry.job.message = "正在停止读取并关闭本次后台工作页；已显示的候选会保留。";
    entry.controller.abort(abortError());
  }

  cancel(id) {
    const job = this.get(id);
    const entry = this.jobs.get(job.id);
    if (ACTIVE.has(entry.job.status)) this.stop(entry);
    return this.publicJob(entry);
  }

  cancelForAccount(id) {
    for (const entry of this.jobs.values()) if (entry.account.id === id && ACTIVE.has(entry.job.status)) this.stop(entry);
  }

  async wait(id) {
    const entry = this.jobs.get(id);
    if (!entry) return this.get(id);
    await entry.promise;
    return this.publicJob(entry);
  }

  async shutdown() {
    this.abort();
    await Promise.allSettled([...this.jobs.values()].map(entry => entry.promise));
    this.signal?.removeEventListener("abort", this.abort);
    const failures = [];
    for (const entry of this.jobs.values()) if (entry.retainedLease) {
      try {
        if (!entry.retryDispose) throw new Error();
        await entry.retryDispose();
        entry.release?.();
        entry.retainedLease = false;
      } catch { failures.push(new Error(FAILURE_MESSAGES["browser-close-failed"])); }
    }
    if (failures.length) throw new AggregateError(failures, "读取关注列表的后台浏览器退出未全部确认。");
  }
}

