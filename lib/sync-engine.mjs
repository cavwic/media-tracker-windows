import path from "node:path";
import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import { AccountResourceScheduler } from "./account-resource-scheduler.mjs";
import { downloadMediaItem } from "./downloader.mjs";
import { openPersonMediaIndex } from "./person-media-index.mjs";
import { SyncStore, syncScopeKey, SYNC_COMPLETION_VERSION } from "./sync-store.mjs";
import { discoverXMedia, XDiscoveryError } from "./x-sync.mjs";
import { resolveXHandle } from "./x-media.mjs";
import { discoverInstagramMedia, InstagramDiscoveryError } from "./instagram-sync.mjs";
import { resolveInstagramHandle } from "./instagram-media.mjs";
import { discoverFacebookMedia, FacebookDiscoveryError } from "./facebook-sync.mjs";
import { resolveFacebookProfile } from "./facebook-media.mjs";
import { discoverTikTokMedia, TikTokDiscoveryError } from "./tiktok-sync.mjs";
import { resolveTikTokHandle } from "./tiktok-media.mjs";
import { discoverCustomMedia } from "./custom-sync.mjs";
import { selectScopeScan, blockingDiscoveryFailure, discoveryFailureMessage } from "./sync-verification.mjs";

function publicJob(job) {
  const { controller, resourceKeys, resourceLabels, newFiles = [], ...result } = job;
  return structuredClone({ ...result, newFileCount: newFiles.length });
}

function publicReceipt(receipt, personId, status = "completed") {
  if (!receipt) return { available: false, personId, jobId: "", status, files: [] };
  const files = Array.isArray(receipt.files) ? receipt.files : [];
  return {
    available: true,
    personId,
    jobId: receipt.jobId,
    status,
    files: files.map(({ relativePath, ...file }) => file),
  };
}

function mediaEnabled(account, kind) {
  return account.downloadMedia?.[kind] !== false;
}

function mediaSource(platform, account, item) {
  return {
    platformId: platform.id, platformLabel: platform.label,
    accountId: account.id, accountLabel: account.label,
    logicalKey: item.logicalKey, postId: item.postId,
    postUrl: item.postUrl, createdAt: item.createdAt, mediaIndex: item.mediaIndex,
    publicationDate: item.publicationDate ?? null,
    dateBasis: item.dateBasis || "unknown",
    displayTimeZone: item.displayTimeZone ?? null,
  };
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "同步已取消。";
  return String(error?.message || error || "未知错误");
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAccessRestriction(error) {
  return [401, 403, 429].includes(error?.status)
    || ["login-required", "verification-required", "rate-limited"].includes(error?.code);
}

function incompleteDiscoveryMessage(discovery) {
  if (/[\u4e00-\u9fff]/.test(discovery.incompleteReason || "")) return discovery.incompleteReason;
  if (discovery.unresolvedMedia?.length) return "部分帖子附件尚未解析完整；已保存文件保留，缺项将在下次补查。";
  if (discovery.parseIssues?.length) return "时间线或分页响应读取异常，不能确认本次完整；已保存文件保留，下次继续检查。";
  return "本次未取得明确历史末尾或可靠增量边界；停止加载不代表同步完成，已保存文件保留，下次继续检查。";
}

function cacheCleanupReport(candidate, report = {}) {
  const statuses = new Set(["cleaned", "empty", "partial", "skipped", "failed"]);
  const reasons = new Set([
    "sync-not-successful", "resource-release-failed", "cleanup-failed", "profile-busy",
    "browser-busy", "login-window-open", "verification-active", "profile-missing",
    "invalid-profile", "unsafe-path", "locked", "cancelled",
    "no-profile", "unsafe-profile", "cleanup-unavailable",
  ]);
  const result = {
    linkedAccountId: candidate.linkedAccount.id,
    platformId: candidate.platformId,
    status: statuses.has(report.status) ? report.status : "failed",
  };
  if (reasons.has(report.reason)) result.reason = report.reason;
  for (const field of ["removedBytes", "removedFiles", "removedDirectories"]) {
    if (Number.isSafeInteger(report[field]) && report[field] >= 0) result[field] = report[field];
  }
  return result;
}

export class SyncManager {
  constructor({ indexFile, loadState, discoverers = {}, download = downloadMediaItem, openMediaIndex = openPersonMediaIndex, cleanupAccountCache = null, deduplicate = null, checkDedupTools = null }) {
    this.store = new SyncStore(indexFile);
    this.loadState = loadState;
    this.jobs = new Map();
    this.pendingJobIds = [];
    this.activeJobIds = new Set();
    this.activeRunPromises = new Map();
    this.activeResourceKeys = new Set();
    this.accountScheduler = new AccountResourceScheduler(this.activeResourceKeys);
    this.pendingReceiptWrites = new Set();
    this.pendingCancellationJobIds = new Set();
    this.receiptWriteErrors = [];
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.shutdownCompletion = null;
    this.deletingPersonIds = new Set();
    this.personGenerations = new Map();
    this.discoverers = { x: discoverXMedia, instagram: discoverInstagramMedia, facebook: discoverFacebookMedia, tiktok: discoverTikTokMedia, custom: discoverCustomMedia, ...discoverers };
    this.download = download;
    this.openMediaIndex = openMediaIndex;
    this.cleanupAccountCache = cleanupAccountCache;
    this.deduplicate = deduplicate;
    this.checkDedupTools = checkDedupTools;
    this.mediaMaintenanceToken = null;
  }

  beginMediaMaintenance() {
    if (this.shuttingDown || this.mediaMaintenanceToken || this.activeJobIds.size || this.pendingJobIds.length
      || this.deletingPersonIds.size || [...this.jobs.values()].some((job) => ["queued", "running"].includes(job.status))) {
      throw Object.assign(adapterError("media-maintenance-busy", "正在同步、退出或维护，请等待全部结束后再一键去重。"), { status: 409 });
    }
    this.mediaMaintenanceToken = randomUUID();
    return this.mediaMaintenanceToken;
  }

  endMediaMaintenance(token) {
    if (this.mediaMaintenanceToken === token) this.mediaMaintenanceToken = null;
  }

  isPersonBusy(personId) {
    return [...this.jobs.values()].some((job) => job.personId === personId && (["queued", "running"].includes(job.status)
      || this.activeJobIds.has(job.id) || this.pendingCancellationJobIds.has(job.id)));
  }

  async withPersonDeletion(personId, callback) {
    if (this.mediaMaintenanceToken || this.deletingPersonIds.has(personId) || this.isPersonBusy(personId)) {
      const error = new Error("人物正在同步或删除，请停止同步并等待结束后重试。");
      error.status = 409;
      throw error;
    }
    this.deletingPersonIds.add(personId);
    this.personGenerations.set(personId, (this.personGenerations.get(personId) || 0) + 1);
    try { return await callback(); }
    finally { this.deletingPersonIds.delete(personId); }
  }

  async removePersonData(personId) {
    if (!this.deletingPersonIds.has(personId) || this.isPersonBusy(personId)) throw new Error("删除人物必须先锁定并结束同步。");
    for (const [id, job] of this.jobs) if (job.personId === personId) this.jobs.delete(id);
    await this.store.removePerson(personId);
  }

  resourceKeys(person, linkedAccountDefinitions = []) {
    return [`folder:${path.resolve(person.folderPath).toLowerCase()}`];
  }

  accountResourceKeys(platform, account, linkedAccount) {
    return [...new Set([
      ...(account.linkedAccountId ? [`login:${account.linkedAccountId}`] : []),
      ...(linkedAccount?.profileDirectory ? [`profile:${path.resolve(linkedAccount.profileDirectory).toLowerCase()}`]
        : platform.id === "tiktok" ? ["session:tiktok-anonymous"] : []),
    ])];
  }

  canRun(job, reservedKeys = new Set()) {
    return job.resourceKeys.every((key) => !this.activeResourceKeys.has(key) && !reservedKeys.has(key));
  }

  refreshQueueState() {
    const reservations = new Map();
    let position = 0;
    for (const job of this.jobs.values()) if (job.status !== "queued") {
      job.queuePosition = null;
      job.queueWaiting = [];
      job.queueReason = "";
    }
    for (const jobId of this.pendingJobIds) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued" || job.cancelRequested) continue;
      job.queuePosition = ++position;
      const waiting = [];
      for (const key of job.resourceKeys) {
        if (!this.activeResourceKeys.has(key) && !reservations.has(key)) continue;
        const activeOwner = [...this.activeJobIds].map((id) => this.jobs.get(id))
          .find((owner) => owner?.resourceKeys.includes(key));
        const earlierOwner = reservations.get(key);
        const platform = job.resourceLabels[key] || "关联账号";
        const personName = activeOwner?.personName || earlierOwner?.personName || "";
        const reason = this.activeResourceKeys.has(key) ? "busy" : "earlier-job";
        if (!waiting.some((item) => item.platform === platform && item.personName === personName && item.reason === reason)) {
          waiting.push({ platform, ...(personName ? { personName } : {}), reason });
        }
      }
      job.queueWaiting = waiting;
      job.queueReason = waiting.length ? waiting.map((item) => item.reason === "earlier-job"
        ? `按队列顺序等待 ${item.personName} 的 ${item.platform} 资源`
        : item.personName ? `等待 ${item.personName} 释放 ${item.platform} 资源`
          : `等待 ${item.platform} 的登录窗口、验证或维护结束`).join("；") : "等待启动同步。";
      job.message = `排队第 ${position} 位；${job.queueReason}`;
      // Older blocked jobs reserve all their resources, including currently
      // free profiles. Younger unrelated jobs still start concurrently.
      if (waiting.length) for (const key of job.resourceKeys) if (!reservations.has(key)) reservations.set(key, job);
    }
  }

  drain() {
    if (this.shuttingDown) return;
    this.accountScheduler.drain();
    while (this.pendingJobIds.length > 0) {
      const reservedKeys = new Set();
      const pendingIndex = this.pendingJobIds.findIndex((jobId) => {
        const job = this.jobs.get(jobId);
        if (!job || job.status !== "queued" || job.cancelRequested) return false;
        if (this.canRun(job, reservedKeys)) return true;
        for (const key of job.resourceKeys) reservedKeys.add(key);
        return false;
      });
      if (pendingIndex < 0) { this.refreshQueueState(); return; }

      const [jobId] = this.pendingJobIds.splice(pendingIndex, 1);
      const job = this.jobs.get(jobId);
      if (!job) continue;
      this.activeJobIds.add(jobId);
      for (const key of job.resourceKeys) this.activeResourceKeys.add(key);
      job.queuePosition = null;
      job.queueWaiting = [];
      job.queueReason = "";
      const runPromise = Promise.resolve()
        .then(() => this.run(jobId))
        .catch((error) => {
          console.error(error);
          return { error };
        })
        .finally(() => {
          this.activeJobIds.delete(jobId);
          this.activeRunPromises.delete(jobId);
          for (const key of job.resourceKeys) this.activeResourceKeys.delete(key);
          this.drain();
        });
      this.activeRunPromises.set(jobId, runPromise);
    }
    this.refreshQueueState();
  }

  shutdown({ timeoutMs = 30_000 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("退出同步等待时间无效。");
    // Stop scheduling synchronously, including starts that are waiting on a
    // state read. Active locks stay held until adapters and writes have settled.
    this.shuttingDown = true;
    this.accountScheduler.close();
    const activeRuns = [...this.activeRunPromises.values()];
    for (const job of this.jobs.values()) {
      if (["queued", "running"].includes(job.status)) this.cancel(job.id);
    }
    const pendingWrites = [...this.pendingReceiptWrites];
    this.shutdownCompletion = (async () => {
      const outcomes = await Promise.allSettled([this.store.ready, ...activeRuns, ...pendingWrites]);
      const errors = [...this.receiptWriteErrors, ...outcomes.flatMap((outcome) => outcome.status === "rejected"
        ? [outcome.reason] : outcome.value?.error ? [outcome.value.error] : [])];
      // Summary writes may enqueue after cancellation. Read the current queue
      // only after every job and queued receipt has finished, never a stale one.
      try { await this.store.writeQueue; }
      catch (error) { if (!errors.includes(error)) errors.push(error); }
      if (errors.length) {
        const error = new AggregateError(errors, "停止同步时未能完整保存同步索引；已保存媒体不会删除，请检查日志并在下次启动后重试。");
        error.code = "shutdown-persistence-failed";
        throw error;
      }
    })();
    if (timeoutMs === 0) this.shutdownPromise = this.shutdownCompletion;
    else {
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = adapterError("sync-shutdown-timeout", "停止同步等待超时，仍有媒体或索引写入未结束；后台未删除任何已保存媒体，请检查日志后重试。");
          reject(error);
        }, timeoutMs);
      });
      // A timeout only reports the delay. Cancellation, disposal and durable
      // writes keep running, and shutdownCompletion still tracks their outcome.
      this.shutdownPromise = Promise.race([this.shutdownCompletion, deadline]).finally(() => clearTimeout(timer));
    }
    return this.shutdownPromise;
  }

  async summaries(personIds) {
    const result = {};
    for (const personId of personIds) {
      const jobs = [...this.jobs.values()].filter((job) => job.personId === personId);
      const live = jobs.find((job) => ["queued", "running"].includes(job.status))
        || jobs.find((job) => this.activeJobIds.has(job.id));
      result[personId] = live ? publicJob(live) : await this.store.summary(personId);
    }
    return result;
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  latestJob(personId) {
    return [...this.jobs.values()]
      .filter((job) => job.personId === personId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
  }

  async receipt(personId) {
    const live = this.latestJob(personId);
    if (live) {
      return publicReceipt({ jobId: live.id, files: await this.currentFileNames(personId, live.newFiles) }, personId, live.status);
    }
    const saved = await this.store.receipt(personId);
    const summary = await this.store.summary(personId);
    return publicReceipt(saved ? { ...saved, files: await this.currentFileNames(personId, saved.files || []) } : null,
      personId, summary?.status || "completed");
  }

  async currentFileNames(personId, files) {
    const result = structuredClone(files);
    if (!result.some((file) => /^[a-f0-9]{64}$/.test(file.mediaId || ""))) return result;
    const state = await this.loadState();
    const person = state.persons.find((item) => item.id === personId);
    if (!person) return result;
    const index = await this.openMediaIndex(person, {
      requireExisting: await this.store.personStorageInitialized(personId),
    });
    for (const file of result) {
      const asset = index.get(file.mediaId, { includeFingerprint: false });
      if (asset) {
        file.relativePath = asset.relativePath;
        file.filename = path.basename(asset.relativePath);
      }
    }
    return result;
  }

  async receiptFile(personId, fileId) {
    const live = this.latestJob(personId);
    const files = live ? live.newFiles : (await this.store.receipt(personId))?.files || [];
    return structuredClone(files.find((file) => file.id === fileId) || null);
  }

  async start(personId, { forceHistory = false } = {}) {
    if (typeof forceHistory !== "boolean") throw Object.assign(adapterError("invalid-sync-option", "历史补查选项无效。"), { status: 400 });
    if (this.shuttingDown) throw adapterError("service-shutting-down", "采集工具正在退出，不能开始新的同步。");
    if (this.mediaMaintenanceToken) throw Object.assign(adapterError("media-maintenance-busy", "本地去重正在进行，请等待完成或停止后再同步。"), { status: 409 });
    if (this.deletingPersonIds.has(personId)) throw adapterError("person-deleting", "人物正在删除，请稍后重试。");
    const generation = this.personGenerations.get(personId) || 0;
    const running = [...this.jobs.values()].find((job) => job.personId === personId && ["queued", "running"].includes(job.status));
    if (running) return { existing: true, job: publicJob(running) };
    const state = await this.loadState();
    if (this.shuttingDown) throw adapterError("service-shutting-down", "采集工具正在退出，不能开始新的同步。");
    if (this.mediaMaintenanceToken) throw Object.assign(adapterError("media-maintenance-busy", "本地去重正在进行，请等待完成或停止后再同步。"), { status: 409 });
    if (this.deletingPersonIds.has(personId) || generation !== (this.personGenerations.get(personId) || 0)) throw adapterError("person-deleting", "人物已删除或正在删除，请刷新后重试。");
    const concurrentlyStarted = [...this.jobs.values()].find((job) => job.personId === personId && ["queued", "running"].includes(job.status));
    if (concurrentlyStarted) return { existing: true, job: publicJob(concurrentlyStarted) };
    const person = state.persons.find((item) => item.id === personId);
    if (!person) throw new Error("人物不存在。");
    const resourceLabels = { [`folder:${path.resolve(person.folderPath).toLowerCase()}`]: "人物目录" };
    for (const platform of person.platforms) for (const account of platform.accounts) if (account.linkedAccountId) {
      resourceLabels[`login:${account.linkedAccountId}`] = platform.label;
      const linked = (state.linkedAccounts || []).find((item) => item.id === account.linkedAccountId);
      if (linked?.profileDirectory) resourceLabels[`profile:${path.resolve(linked.profileDirectory).toLowerCase()}`] = platform.label;
    }

    const job = {
      id: randomUUID(),
      personId,
      personName: person.name,
      forceHistory,
      status: "queued",
      phase: "queued",
      message: "同步任务已排队。",
      currentAccount: "",
      currentFile: "",
      currentBytes: 0,
      counters: {
        accounts: person.platforms.reduce((sum, platform) => sum + platform.accounts.filter(account => account.syncEnabled !== false).length, 0),
        pausedAccounts: person.platforms.reduce((sum, platform) => sum + platform.accounts.filter(account => account.syncEnabled === false).length, 0),
        accountsFinished: 0,
        discovered: 0,
        selected: 0,
        downloaded: 0,
        logicalDuplicates: 0,
        contentDuplicates: 0,
        skippedByPolicy: 0,
        unsupportedAccounts: 0,
        failed: 0,
        warnings: 0,
        pendingAccounts: 0,
        historyPendingAccounts: 0,
        bytes: 0,
      },
      errors: [],
      warnings: [],
      accountResults: [],
      accountProgress: [],
      cacheCleanup: [],
      newFiles: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      queuePosition: null,
      queueWaiting: [],
      queueReason: "",
      controller: new AbortController(),
      resourceKeys: this.resourceKeys(person, state.linkedAccounts),
      resourceLabels,
    };
    // Several account stages share this cancellation signal, not one browser.
    setMaxListeners(0, job.controller.signal);
    this.jobs.set(job.id, job);
    this.pendingJobIds.push(job.id);
    this.drain();
    return { existing: false, job: publicJob(job) };
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!["queued", "running"].includes(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.message = "正在停止同步…";
    job.controller.abort();
    if (job.status === "queued" && !this.activeJobIds.has(jobId)) {
      // Cancelling a blocked job must release FIFO reservations immediately,
      // not wait until the busy profile becomes available merely to abort it.
      this.pendingJobIds = this.pendingJobIds.filter((id) => id !== jobId);
      job.status = "cancelled";
      job.phase = "cancelled";
      job.operationStatus = "cancelled";
      job.queuePosition = null;
      job.queueWaiting = [];
      job.queueReason = "";
      job.message = "同步已取消；已完成的文件和索引会保留。";
      job.finishedAt = new Date().toISOString();
      this.pendingCancellationJobIds.add(job.id);
      const writing = this.store.saveSummary(job.personId, publicJob(job), job.newFiles).catch((error) => {
        this.receiptWriteErrors.push(error);
        return { error };
      }).finally(() => {
        this.pendingReceiptWrites.delete(writing);
        this.pendingCancellationJobIds.delete(job.id);
      });
      this.pendingReceiptWrites.add(writing);
      this.drain();
      this.refreshQueueState();
    }
    return publicJob(job);
  }

  addError(job, platform, account, error) {
    job.counters.failed += 1;
    job.errors.push({
      platform: platform.label,
      account: account.label,
      ...(platform.id ? { platformId: platform.id } : {}),
      ...(account.id ? { accountId: account.id } : {}),
      code: String(error?.code || "sync-error"),
      message: errorMessage(error),
    });
    job.errors = job.errors.slice(-20);
  }

  addWarning(job, platform, account, code, message, category = "verification") {
    job.counters.warnings += 1;
    job.warnings.push({ platform: platform.label, account: account.label,
      ...(platform.id ? { platformId: platform.id } : {}), ...(account.id ? { accountId: account.id } : {}), code, message, category });
    job.warnings = job.warnings.slice(-30);
  }

  async run(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.phase = "preparing";
    job.message = "正在准备同步索引。";
    job.startedAt = new Date().toISOString();

    try {
      if (job.controller.signal.aborted) throw new DOMException("同步已取消。", "AbortError");
      const state = structuredClone(await this.loadState());
      const person = state.persons.find((item) => item.id === job.personId);
      if (!person) throw new Error("人物已不存在，无法继续同步。");
      // Snapshot each target/binding at preparation time. Saving an edit while
      // this run is active affects the next run, never the current lease keys.
      const entries = person.platforms.flatMap(platform => platform.accounts.map(account => ({ platform, account })))
        .filter(({ account }) => account.syncEnabled !== false);
      job.counters.accounts = entries.length;
      job.counters.pausedAccounts = person.platforms.reduce((sum, platform) =>
        sum + platform.accounts.filter(account => account.syncEnabled === false).length, 0);
      if (!entries.length) {
        job.status = "completed";
        job.phase = "completed";
        job.operationStatus = "synced";
        job.message = "全部账号已暂停，本次未读取平台或修改增量节点。";
        return;
      }
      const storageInitialized = await this.store.personStorageInitialized(person.id);
      const mediaIndex = await this.openMediaIndex(person, {
        create: !storageInitialized, requireExisting: storageInitialized,
        writable: true,
        signal: job.controller.signal,
      });
      await this.store.markPersonStorageInitialized(person.id);
      const validAssets = new Map();
      const assetPresent = async (mediaId) => {
        if (!mediaId) return false;
        if (!validAssets.has(mediaId)) validAssets.set(mediaId, mediaIndex.has(mediaId));
        return validAssets.get(mediaId);
      };

      // Keep profile paths and account credentials local to this run, never in
      // public jobs or persisted summaries. A failed target vetoes cleanup for
      // every other target using the same profile in this job.
      const cacheCandidates = new Map();

      const accountRuns = entries.map(async ({ platform, account }) => {
        const customPlatform = state.customPlatforms?.find((definition) => definition.id === platform.id && definition.custom === true);
        const progress = { platformId: platform.id, platform: platform.label, accountId: account.id,
          account: account.label, status: "queued", phase: "queued", discovered: 0, currentBytes: 0, waiting: [] };
        job.accountProgress.push(progress);
        let releaseSession;
        const updateActivity = () => {
          const active = job.accountProgress.filter(item => item.status === "running");
          job.currentAccount = active.map(item => `${item.platform} · ${item.account}`).join("；");
          job.currentBytes = active.reduce((sum, item) => sum + item.currentBytes, 0);
          job.queueWaiting = job.accountProgress.flatMap(item => item.waiting);
        };
        try {
          if (job.controller.signal.aborted) throw new DOMException("同步已取消。", "AbortError");
          const linkedAccount = account.linkedAccountId
            ? (state.linkedAccounts || []).find((item) => item.id === account.linkedAccountId)
            : null;
          let cacheCandidate;
          if (this.cleanupAccountCache && linkedAccount?.profileDirectory) {
            const profileKey = path.resolve(linkedAccount.profileDirectory).toLowerCase();
            if (!cacheCandidates.has(profileKey)) {
              cacheCandidates.set(profileKey, { linkedAccount, platformId: platform.id, successful: false, unsafeReason: "" });
            }
            cacheCandidate = cacheCandidates.get(profileKey);
          }
          if (!customPlatform && !new Set(["x", "instagram", "facebook", "tiktok"]).has(platform.id)) {
            if (cacheCandidate) cacheCandidate.unsafeReason ||= "sync-not-successful";
            job.counters.unsupportedAccounts += 1;
            const error = adapterError("adapter-pending", platform.id.startsWith("custom-")
              ? `${platform.label} 的自定义平台配置已不存在，请重新配置平台后同步。`
              : `${platform.label} 下载适配器尚未接入，本次已明确跳过。`);
            if (platform.id.startsWith("custom-")) this.addError(job, platform, account, error);
            else job.errors.push({ platform: platform.label, account: account.label, code: error.code, message: error.message });
            progress.status = "failed";
            return;
          }

          const keys = this.accountResourceKeys(platform, account, linkedAccount);
          releaseSession = await this.accountScheduler.acquire({ keys, labels: Object.fromEntries(keys.map(key => [key, platform.label])),
            owner: { personName: person.name }, signal: job.controller.signal,
            onWaiting(waiting) { progress.waiting = waiting; updateActivity(); } });
          progress.status = "running";
          progress.phase = "discovering";
          updateActivity();
          const scopeKey = syncScopeKey(person.id, platform.id, account.id);
          const scope = await this.store.scope(scopeKey);
          const root = person.folderPath;
          let accountFailed = false;
          let accountSuccessful = false;
          let discovery;
          try {
            await this.store.ensureCompletionVerification(scopeKey);
            if (customPlatform && !["auto", "gallery-dl", "yt-dlp"].includes(customPlatform.engine)) {
              job.counters.unsupportedAccounts += 1;
              throw adapterError("adapter-pending", `${platform.label} 尚未配置可用的媒体下载引擎，请在自定义平台设置中选择下载引擎后重试。`);
            }
            const mediaPolicy = ["image", "video", "gif"].filter((kind) => mediaEnabled(account, kind)).join(",");
            const previousPolicy = scope.lastScanMediaPolicy ?? scope.mediaPolicy;
            // Disabling an existing media type does not justify traversing all
            // history. Only a newly requested type needs its first backfill.
            const policyChanged = previousPolicy != null && mediaPolicy.split(",")
              .some((kind) => kind && !previousPolicy.split(",").includes(kind));
            if (policyChanged) scope.initialComplete = false;

            if (account.linkedAccountId) {
              if (!linkedAccount || linkedAccount.platformId !== platform.id) {
                throw adapterError("linked-account-missing", `选定的 ${platform.label} 关联账号已不存在，请修改人物信息。`);
              }
              if (linkedAccount.loginStatus !== "verified") {
                throw adapterError("login-unverified", `选定的 ${platform.label} 关联账号尚未通过登录验证。`);
              }
            }

            job.phase = "discovering";
            let targetLabel;
            const scanStartedAt = new Date().toISOString();
            const scanPlan = selectScopeScan(scope, { version: SYNC_COMPLETION_VERSION, policyChanged,
              forceHistory: job.forceHistory,
              verificationStartedAt: this.store.index.completionVerification?.startedAt });
            job.message = scanPlan.reason === "media-policy-expanded"
              ? "已启用新的媒体类型，正在补采该账号的现有内容。" : job.message;
            if (scanPlan.mode === "history") await this.store.markHistoryCheckStarted(scopeKey, scanStartedAt);
            // Do not stat every historical NAS asset on each incremental sync.
            // Metadata skip keys reference committed index entries; physical
            // files are checked only when rediscovered or present in retries.
            const pendingProofKeys = new Set(Object.values(scope.pendingPosts).flatMap((post) =>
              Array.isArray(post.mediaExpectedKeys) ? post.mediaExpectedKeys : []));
            const pendingPostIds = new Set(Object.values(scope.pendingPosts).map((post) => post.postId || post.postKey));
            const knownMediaKeys = [];
            if (!policyChanged) for (const [key, record] of Object.entries(scope.media)) {
              if (Object.hasOwn(scope.pendingMedia, key) || !record?.mediaId || !mediaIndex.get(record.mediaId)) continue;
              // Verify only assets being used to resolve a pending post, not
              // every historical NAS file. A deleted file is not coverage proof.
              if ((pendingProofKeys.has(key) || pendingPostIds.has(record.postId)) && !await assetPresent(record.mediaId)) continue;
              knownMediaKeys.push(key);
            }
            const discoveryOptions = {
              linkedAccount,
              knownPosts: scope.knownPosts,
              // A known post may still contain unvisited album items or failed
              // downloads. Only successfully indexed media can be omitted from
              // a custom extractor's metadata budget; retries must refresh URLs.
              knownMediaKeys,
              knownPostCoverage: scope.pendingPosts,
              // This flag enables a recent-range boundary, not a claim that
              // older history is complete. Missing older attachments are
              // retried separately and cannot force endless full scans.
              initialComplete: scanPlan.allowKnownBoundary,
              scanMode: scanPlan.mode,
              since: scanPlan.since,
              retryPosts: [...new Set([...Object.values(scope.pendingMedia)
                .filter((item) => item.lastError && mediaEnabled(account, item.kind)), ...Object.values(scope.pendingPosts)]
                .sort((a, b) => String(a.lastAttemptAt || "").localeCompare(String(b.lastAttemptAt || "")))
                .map((item) => item.postUrl).filter(Boolean))].slice(0, 50),
              signal: job.controller.signal,
              onProgress(progress) {
                job.message = `正在读取 ${targetLabel}：已发现 ${progress.media} 个媒体文件。`;
              },
            };
            const reportProgress = discoveryOptions.onProgress;
            discoveryOptions.onProgress = report => {
              const count = Number.isFinite(report.media) ? Math.max(0, report.media) : progress.discovered;
              job.counters.discovered += count - progress.discovered;
              progress.discovered = count;
              reportProgress(report);
            };
            await this.store.markPostRefreshAttempts(scopeKey, discoveryOptions.retryPosts);
            if (customPlatform) {
              targetLabel = account.label;
              job.message = `正在读取 ${targetLabel} 的 ${platform.label} 媒体。`;
              discovery = await this.discoverers.custom({ ...discoveryOptions, platform: customPlatform, account });
            } else if (platform.id === "x") {
              const handle = resolveXHandle(account);
              if (!handle) throw new XDiscoveryError("invalid-handle", "无法从账号名称或主页链接识别有效的 X 用户名。");
              targetLabel = `@${handle}`;
              job.message = `正在读取 ${targetLabel} 的 X 时间线。`;
              discovery = await this.discoverers.x({ ...discoveryOptions, handle });
            } else if (platform.id === "instagram") {
              const handle = resolveInstagramHandle(account);
              if (!handle) throw new InstagramDiscoveryError("invalid-handle", "无法从账号名称或主页链接识别有效的 Instagram 用户名。");
              targetLabel = `@${handle}`;
              job.message = `正在读取 ${targetLabel} 的 Instagram 时间线。`;
              discovery = await this.discoverers.instagram({ ...discoveryOptions, handle });
            } else if (platform.id === "tiktok") {
              const handle = resolveTikTokHandle(account);
              if (!handle) throw new TikTokDiscoveryError("invalid-handle", "无法识别有效的 TikTok 用户名。");
              targetLabel = `@${handle}`;
              job.message = `正在读取 ${targetLabel} 的 TikTok 时间线。`;
              discovery = await this.discoverers.tiktok({ ...discoveryOptions, handle });
            } else {
              const profile = resolveFacebookProfile(account);
              if (!profile) throw new FacebookDiscoveryError("invalid-profile", "无法识别有效的 Facebook 个人主页链接。");
              targetLabel = account.label;
              job.message = `正在读取 ${targetLabel} 的 Facebook 时间线。`;
              discovery = await this.discoverers.facebook({ ...discoveryOptions, ...profile });
            }
            // URL-only adapters close their browser before returning. Runtime
            // sessions (especially TikTok images) retain exclusive access until
            // every download and dispose completes. Never duplicate profiles.
            if (platform.id !== "tiktok" && typeof discovery.dispose !== "function") {
              releaseSession(); releaseSession = null;
            }
            job.counters.discovered += discovery.media.length - progress.discovered;
            progress.discovered = discovery.media.length;
            const selectedNew = discovery.media.filter((item) => mediaEnabled(account, item.kind));
            discovery = { ...discovery, complete: discovery.complete === true && !discovery.unresolvedMedia?.length && !discovery.parseIssues?.length };
            const rangeComplete = discovery.complete || (discovery.rangeComplete === true
              && !(discovery.parseIssues || []).some((issue) => typeof issue === "string" || !issue?.postKey));
            const historyComplete = discovery.complete
              && (discovery.completionReason !== "known-boundary" || scanPlan.historyVerified);
            await this.store.recordDiscovery(scopeKey, { posts: discovery.posts, media: selectedNew, complete: historyComplete,
              startedAt: scanStartedAt, mediaPolicy, unresolvedMedia: discovery.unresolvedMedia || [],
              availableMediaKeys: discoveryOptions.knownMediaKeys,
              completionVersion: SYNC_COMPLETION_VERSION, completionReason: discovery.completionReason || null,
              rangeComplete, headCaptured: discovery.headCaptured === true, scanMode: scanPlan.mode,
              rangeCompletionReason: discovery.rangeCompletionReason || discovery.completionReason || null,
              diagnostics: { ...discovery, rangeComplete }, unavailablePosts: discovery.unavailablePosts || [] });
            // A parser omission from an earlier scan must be explicitly resolved,
            // not erased merely because this response omitted that old post.
            if (Object.keys(scope.pendingPosts).length) discovery = { ...discovery, complete: false,
              incompleteReason: discovery.incompleteReason || "仍有帖子附件未确认完整，已保留补查记录；不会因下一次响应遗漏该帖子而清除。" };
            // Refresh failed items with newly captured URLs, then retry them even beyond the time boundary.
            const selected = [...new Map([
              ...Object.values(scope.pendingMedia).filter((item) => mediaEnabled(account, item.kind)).map((item) => [item.logicalKey, item]),
              ...selectedNew.map((item) => [item.logicalKey, item]),
            ]).values()];
            job.counters.selected += selected.length;
            job.counters.skippedByPolicy += discovery.media.length - selectedNew.length;
            job.phase = "downloading";
            progress.phase = "downloading";
            for (const item of selected) {
              if (job.controller.signal.aborted) throw new DOMException("同步已取消。", "AbortError");
              const existingRecord = scope.media[item.logicalKey];
              const source = mediaSource(platform, account, item);
              job.currentFile = `${item.postId} · ${item.kind}`;
              progress.currentBytes = 0;
              updateActivity();
              job.message = `正在保存 ${targetLabel} 的 ${item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : "动图"}。`;
              try {
                if (existingRecord?.mediaId && await assetPresent(existingRecord.mediaId)) {
                  const originMediaId = existingRecord.originMediaId || existingRecord.mediaId;
                  await mediaIndex.addSource(originMediaId, source);
                  await this.store.markMedia(scopeKey, item, { ...mediaIndex.get(existingRecord.mediaId, { includeFingerprint: false }),
                    originMediaId, status: "content-duplicate", bytes: 0 });
                  job.counters.logicalDuplicates += 1;
                  continue;
                }
                await this.store.markPending(scopeKey, item);
                const result = await this.download(item, root, scope, {
                  signal: job.controller.signal,
                  fetchMedia: discovery.fetchMedia,
                  mediaIndex, source,
                  onProgress(bytes) { progress.currentBytes = bytes; updateActivity(); },
                });
                if (!result.mediaId || !await mediaIndex.has(result.mediaId)) {
                  throw adapterError("media-index-uncommitted", "媒体未完整写入人物索引，本次不确认同步成功。");
                }
                validAssets.set(result.mediaId, Promise.resolve(true));
                await this.store.markMedia(scopeKey, item, result);
                job.counters.bytes += result.bytes;
                if (result.status === "downloaded") {
                  job.counters.downloaded += 1;
                  job.newFiles.push({
                    id: randomUUID(),
                    mediaId: result.mediaId,
                    platformId: platform.id,
                    platformLabel: platform.label,
                    accountId: account.id,
                    accountLabel: account.label,
                    kind: result.kind,
                    filename: path.basename(result.relativePath),
                    relativePath: result.relativePath,
                  });
                } else {
                  job.counters.contentDuplicates += 1;
                }
              } catch (error) {
                if (error?.name === "AbortError") throw error;
                await this.store.markPending(scopeKey, item, errorMessage(error));
                accountFailed = true;
                // Stop this target on an explicit refusal, rate limit or
                // challenge. Leave the checkpoint and pending media intact;
                // only a later user-started run may try again.
                if (isAccessRestriction(error)) throw error;
                this.addError(job, platform, account, error);
              }
            }
            const blockingFailure = blockingDiscoveryFailure(discovery);
            if (!discovery.complete) {
              const pending = Object.keys(scope.pendingPosts).length;
              if (pending) job.counters.pendingAccounts += 1;
              if (blockingFailure) {
                accountFailed = true;
                this.addError(job, platform, account, adapterError("timeline-read-failed",
                  discoveryFailureMessage(discovery, blockingFailure)));
              } else this.addWarning(job, platform, account, "timeline-incomplete", incompleteDiscoveryMessage(discovery),
                pending ? scope.lastDiscovery.attachmentGapCount ? "attachments" : "posts" : "verification");
            }
            const historyPending = !(scope.initialComplete && scope.completionVersion === SYNC_COMPLETION_VERSION);
            if (historyPending) {
              job.counters.historyPendingAccounts += 1;
              if (rangeComplete) this.addWarning(job, platform, account, "history-verification-pending",
                "近期增量已读取；历史完整性诊断保留在索引中，普通同步不会为此重新遍历全部历史。", "history");
            }
            job.accountResults.push({ platform: platform.label, account: account.label, platformId: platform.id, accountId: account.id, scanMode: scanPlan.mode,
              scanReason: scanPlan.reason, since: scanPlan.since,
              operationStatus: accountFailed ? selectedNew.length ? "partial" : "failed" : "synced",
              rangeComplete, historyVerified: !historyPending, pendingPostCount: Object.keys(scope.pendingPosts).length,
              diagnostics: scope.lastDiscovery });
            if (!accountFailed) await mediaIndex.compact();
            await this.store.finishScope(scopeKey, {
              complete: historyComplete && !Object.keys(scope.pendingPosts).length,
              successful: rangeComplete && !accountFailed && !blockingFailure,
            });
            accountSuccessful = rangeComplete && !accountFailed && !blockingFailure;
            progress.status = accountFailed ? "failed" : "synced";
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            accountFailed = true;
            progress.status = "failed";
            this.addError(job, platform, account, error);
            await this.store.finishScope(scopeKey, { complete: false, successful: false });
          } finally {
            // Runtime download sessions are not part of the persistent index.
            // Release them on completion, errors and cancellation alike without
            // replacing the original job outcome if a closed tab cannot detach.
            try { await discovery?.dispose?.(); } catch {
              if (cacheCandidate) cacheCandidate.unsafeReason = "resource-release-failed";
            }
            if (cacheCandidate) {
              cacheCandidate.successful ||= accountSuccessful;
              if (!accountSuccessful) cacheCandidate.unsafeReason ||= "sync-not-successful";
            }
          }
        } catch (error) {
          progress.status = error?.name === "AbortError" || job.controller.signal.aborted ? "cancelled" : "failed";
          throw error;
        } finally {
          // Promise.allSettled below must observe disposal before finalizing the
          // person. Cancelling queued leases rejects immediately without opening.
          releaseSession?.();
          if (job.controller.signal.aborted) progress.status = "cancelled";
          progress.phase = "finished";
          progress.currentBytes = 0;
          progress.waiting = [];
          job.counters.accountsFinished += 1;
          updateActivity();
        }
      });
      const outcomes = await Promise.allSettled(accountRuns);
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected) throw rejected.reason;

      // A cancellation arriving during the final download/dispose must not
      // turn into a successful job or allow cache removal.
      if (job.controller.signal.aborted) throw new DOMException("同步已取消。", "AbortError");
      if (this.deduplicate && job.newFiles.length) {
        job.phase = "deduplicating";
        job.message = "正在本地比对新图片和视频，保留质量较好的相同内容版本。";
        try {
          if (this.checkDedupTools) await this.checkDedupTools({ signal: job.controller.signal });
          job.deduplication = await this.deduplicate(person, mediaIndex, {
            mediaIds: job.newFiles.map((file) => file.mediaId), signal: job.controller.signal,
            onProgress(report) {
              job.deduplication = { scanned: report.scanned, total: report.total, merged: report.merged,
                review: report.review, archivedBytes: report.archivedBytes };
              job.message = `正在本地去重：${report.scanned}/${report.total}，合并 ${report.merged} 份，差异版本保留 ${report.review} 项。`;
            },
          });
          if (job.deduplication.errors?.length) this.addWarning(job, { label: "本地去重" }, { label: person.name },
            "similarity-check-pending", "部分本地去重检查未完成，媒体和来源保留；可用一键去重再次检查。", "verification");
        } catch (error) {
          if (error?.name === "AbortError" || job.controller.signal.aborted) throw error;
          if (["similarity-tools-unavailable", "similarity-tools-check-failed", "similarity-tools-path-invalid", "dedup-feature-unavailable"].includes(error?.code)) {
            job.deduplication = { skipped: true, reason: error?.code === "dedup-feature-unavailable" ? "feature-unavailable" : "tools-unavailable",
              message: "媒体采集及精确去重已完成；相似去重组件未就绪，可点击去重安装组件或指定工具路径。" };
          } else this.addWarning(job, { label: "本地去重" }, { label: person.name }, "similarity-check-pending",
            "本地去重未完成，已保存媒体和来源保留；可用一键去重重试，不需要重新下载。", "verification");
        }
      }
      job.phase = "organizing";
      job.message = "正在按发布日期整理当天图片和视频序号。";
      try {
        if (mediaIndex.finalizeNaming) await mediaIndex.finalizeNaming({ signal: job.controller.signal });
        // An account-level snapshot failure is already reported and blocks
        // its checkpoint. Do not retry it immediately and report the same
        // failure twice; rename/source commits are durable in the journal.
        if (job.counters.failed === 0) await mediaIndex.compact();
        job.namingStatus = "complete";
        // Receipts keep their IDs. Resolve current names only after the batch
        // commits, so a later earlier-post discovery cannot leave stale paths.
        for (const file of job.newFiles) {
          const asset = mediaIndex.get(file.mediaId, { includeFingerprint: false });
          if (asset) {
            file.relativePath = asset.relativePath;
            file.filename = path.basename(asset.relativePath);
          }
        }
      } catch (error) {
        if (error?.name === "AbortError" || job.controller.signal.aborted) throw error;
        job.namingStatus = "pending";
        this.addError(job, { label: "文件整理" }, { label: person.name },
          adapterError("media-naming-incomplete", `命名整理未完成；已保存文件和来源保留，下次继续整理，不会为此重新下载。${errorMessage(error)}`));
        for (const candidate of cacheCandidates.values()) candidate.unsafeReason ||= "sync-not-successful";
      }
      if (job.controller.signal.aborted) throw new DOMException("同步已取消。", "AbortError");
      job.status = "completed";
      job.phase = "completed";
      job.operationStatus = job.counters.failed || job.errors.length ? "partial" : "synced";
      job.message = job.counters.failed || job.errors.length
        ? `同步完成，但有 ${Math.max(job.counters.failed, job.errors.length)} 项失败，可再次同步重试。`
        : "本轮可读取媒体已同步，后续按已保存增量节点继续。";

      // Browser leases were released at their safe account-stage boundary.
      // Reacquire synchronously for best-effort cache maintenance; a currently
      // busy profile is skipped, never cleaned beneath another reader/download.
      // Other profiles may succeed even if an unrelated account had an error.
      for (const candidate of cacheCandidates.values()) {
        if (!candidate.successful || candidate.unsafeReason) {
          job.cacheCleanup.push(cacheCleanupReport(candidate, {
            status: "skipped", reason: candidate.unsafeReason || "sync-not-successful",
          }));
          continue;
        }
        const cleanupKeys = this.accountResourceKeys({ id: candidate.platformId },
          { linkedAccountId: candidate.linkedAccount.id }, candidate.linkedAccount);
        if (this.shuttingDown || cleanupKeys.some(key => this.activeResourceKeys.has(key))) {
          job.cacheCleanup.push(cacheCleanupReport(candidate, { status: "skipped",
            reason: this.shuttingDown ? "cancelled" : "profile-busy" }));
          continue;
        }
        for (const key of cleanupKeys) this.activeResourceKeys.add(key);
        try {
          const report = await this.cleanupAccountCache({ linkedAccount: candidate.linkedAccount, platformId: candidate.platformId });
          job.cacheCleanup.push(cacheCleanupReport(candidate, report));
        } catch {
          job.cacheCleanup.push(cacheCleanupReport(candidate, { status: "failed", reason: "cleanup-failed" }));
        } finally {
          for (const key of cleanupKeys) this.activeResourceKeys.delete(key);
          this.accountScheduler.drain();
        }
      }
    } catch (error) {
      if (error?.name === "AbortError" || job.controller.signal.aborted) {
        job.status = "cancelled";
        job.phase = "cancelled";
        job.operationStatus = "cancelled";
        job.message = "同步已取消；已完成的文件和索引会保留。";
      } else {
        job.status = "failed";
        job.phase = "failed";
        job.operationStatus = "failed";
        job.message = errorMessage(error);
        job.errors.push({ platform: "", account: "", code: "job-error", message: job.message });
      }
    } finally {
      job.currentAccount = "";
      job.currentFile = "";
      job.currentBytes = 0;
      job.finishedAt = new Date().toISOString();
      await this.store.saveSummary(job.personId, publicJob(job), job.newFiles);
    }
  }
}
