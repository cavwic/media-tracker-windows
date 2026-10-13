import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { openPersonMediaIndex } from "./person-media-index.mjs";
import { inspectMedia, candidateMatch, compareMedia, choosePreferred, verifyMediaPair } from "./media-similarity.mjs";

const HASH = /^[a-f0-9]{64}$/;
const MAX_DETAILS = 100;
const abort = (signal) => signal?.throwIfAborted();
const pause = () => new Promise((resolve) => setImmediate(resolve));
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function unchanged(fingerprint, asset, info) {
  const stamp = fingerprint?.fileStamp;
  return fingerprint?.version === 1 && stamp?.sha256 === asset.sha256 && stamp.bytes === asset.bytes
    && stamp.mtimeMs === info.mtimeMs && stamp.ctimeMs === info.ctimeMs;
}

function safeMessage(error) {
  // Neither file paths nor the decoder stderr belong in a public receipt.
  if (error?.name === "AbortError") return "已停止；已提交的合并和原始版本隔离副本保留。";
  if (["ENOENT", "ENOTFOUND", "ENETUNREACH", "EIO"].includes(error?.code)) return "媒体或共享目录不可访问；文件和索引未重置。";
  if (["EACCES", "EPERM", "EBUSY"].includes(error?.code)) return "文件被占用或没有访问权限；已保留，稍后可重试。";
  if (String(error?.code || "").startsWith("media-") || String(error?.code || "").startsWith("similarity-")) {
    return String(error.message || "本地媒体检查失败；已保留。").slice(0, 400);
  }
  return "本地媒体检查未完成；已保存文件和来源保留，下次可重试。";
}

function reviewReason(reason) {
  if (String(reason).includes("audio")) return "画面接近，但音轨不同或无法确认一致，已同时保留。";
  if (/timing|frame-count|fps|duration/.test(reason || "")) return "帧率、时长或完整帧序列存在差异，已同时保留。";
  if (/crop|aspect/.test(reason || "")) return "画面裁剪或比例存在差异，已同时保留。";
  if (/static-video/.test(reason || "")) return "静态视频无法可靠确认是否同一完整内容，已同时保留。";
  if (/complete|invalid|incompatible|limit/.test(reason || "")) return "未取得完整、可靠的比对依据，已保留，未自动合并。";
  return "存在局部画面或质量差异，无法可靠自动合并，已同时保留。";
}

function preservedFingerprintReason(fingerprint) {
  if (fingerprint.reason === "fingerprint-size-limit") return "媒体已完整解码，但超过本地指纹缓存上限，本次不自动合并；原文件保留，并非下载缺失。";
  if (fingerprint.reason === "animated-image-review") return "动态图按安全规则直接保留，本次不自动合并，无需人工处理也可继续同步。";
  if (fingerprint.reason === "full-sequence-limit") return "视频的时长、帧率或音轨超过当前安全比对范围，本次不自动合并；原文件保留。";
  return "未取得完整比对依据，本次不自动合并；原文件保留，不影响继续同步。";
}

/** No extractor, HTTP client, inference API or model is used by this workflow. */
export async function deduplicatePerson(person, index, { signal, mediaIds = null, onProgress = () => {},
  inspect = inspectMedia, candidate = candidateMatch, compare = compareMedia, prefer = choosePreferred,
  verify = verifyMediaPair } = {}) {
  abort(signal);
  const ids = [];
  for (let offset = 0;; offset += 200) {
    const page = index.list({ offset, limit: 200 });
    ids.push(...page.items.map((asset) => asset.mediaId));
    if (offset + page.items.length >= page.total) break;
  }
  const wanted = mediaIds === null ? null : new Set(mediaIds.filter((id) => HASH.test(id)));
  const result = { personId: person.id, personName: person.name, total: ids.length, scanned: 0,
    compared: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], reviewItems: [], merges: [] };
  const update = () => onProgress(structuredClone(result));
  if (wanted?.size === 0) return result;
  const fingerprints = new Map();
  for (const id of ids) {
    abort(signal);
    const asset = index.get(id);
    if (!asset || asset.mediaId !== id) continue;
    try {
      const snapshot = await index.withAssetPath(id, async (filePath) => ({ filePath, info: await lstat(filePath) }));
      let fingerprint = asset.similarityFingerprint;
      if (!unchanged(fingerprint, asset, snapshot.info)) {
        fingerprint = await inspect(snapshot.filePath, { kind: asset.kind, signal });
        abort(signal);
        fingerprint = { ...fingerprint, fileStamp: { sha256: asset.sha256, bytes: asset.bytes,
          mtimeMs: snapshot.info.mtimeMs, ctimeMs: snapshot.info.ctimeMs } };
        await index.setSimilarityFingerprint(id, fingerprint, { signal });
      }
      fingerprints.set(id, fingerprint);
      if (fingerprint.complete === false) {
        result.review++;
        if (result.reviewItems.length < MAX_DETAILS) result.reviewItems.push({ mediaIds: [id],
          filenames: [path.basename(asset.relativePath)], reason: preservedFingerprintReason(fingerprint) });
      }
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      result.errors.push({ mediaId: id, filename: path.basename(asset.relativePath), message: safeMessage(error) });
      if (result.errors.length >= MAX_DETAILS) break;
    }
    result.scanned++;
    update();
    await pause();
  }
  const available = [...fingerprints.keys()];
  let visited = 0;
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      abort(signal);
      const leftId = available[i], rightId = available[j];
      if (wanted && !wanted.has(leftId) && !wanted.has(rightId)) continue;
      const leftAsset = index.get(leftId), rightAsset = index.get(rightId);
      // Do not use transitive visual similarity. Each merge must directly match
      // the actual survivor; an already archived variant is no longer a candidate.
      if (!leftAsset || !rightAsset || leftAsset.mediaId !== leftId || rightAsset.mediaId !== rightId) continue;
      const left = fingerprints.get(leftId), right = fingerprints.get(rightId);
      if (++visited % 200 === 0) await pause();
      if (!candidate(left, right)) continue;
      result.compared++;
      const comparison = compare(left, right);
      if (comparison.decision === "different") continue;
      let preference = comparison.decision === "merge" ? prefer(left, right) : null;
      if (comparison.decision !== "merge" || !["left", "right"].includes(preference?.preferred)) {
        result.review++;
        if (result.reviewItems.length < MAX_DETAILS) result.reviewItems.push({ mediaIds: [leftId, rightId],
          filenames: [path.basename(leftAsset.relativePath), path.basename(rightAsset.relativePath)],
          reason: comparison.decision === "merge" ? "画面相同，但质量没有可靠优劣，已同时保留。" : reviewReason(comparison.reason) });
        update();
        continue;
      }
      if (preference.reason === "indistinguishable-quality-preserve-canonical") {
        // List pagination is newest-first. A quality tie must not replace an
        // established canonical asset merely because the new file appears first.
        const earlier = Date.parse(leftAsset.savedAt) - Date.parse(rightAsset.savedAt);
        preference = { ...preference, preferred: earlier < 0 || (earlier === 0 && leftId < rightId) ? "left" : "right" };
      }
      const winner = preference.preferred === "left" ? leftAsset : rightAsset;
      const loser = preference.preferred === "left" ? rightAsset : leftAsset;
      try {
        const leftPath = await index.withAssetPath(leftId, (filePath) => filePath);
        const rightPath = await index.withAssetPath(rightId, (filePath) => filePath);
        const verification = await verify(leftPath, rightPath, { kind: leftAsset.kind, signal });
        if (verification.decision !== "merge") {
          result.review++;
          if (result.reviewItems.length < MAX_DETAILS) result.reviewItems.push({ mediaIds: [leftId, rightId],
            filenames: [path.basename(leftAsset.relativePath), path.basename(rightAsset.relativePath)], reason: reviewReason(verification.reason) });
          update();
          continue;
        }
        await index.mergeVariants(winner.mediaId, [loser.mediaId], { signal,
          evidence: { algorithmVersion: 1, method: "local-full-content-quality-proxy", comparison, verification, preference,
            trainingValidated: false, comparedAt: new Date().toISOString() } });
        result.merged++;
        result.archivedBytes += loser.bytes;
        if (result.merges.length < MAX_DETAILS) result.merges.push({ winnerId: winner.mediaId, loserId: loser.mediaId,
          filename: path.basename(winner.relativePath), reason: preference.reason });
        // A new item can replace an old inferior version. Continue checking the
        // survivor against old candidates in the incremental pass as well.
        if (wanted && (wanted.has(leftId) || wanted.has(rightId))) wanted.add(winner.mediaId);
        update();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        result.errors.push({ mediaId: loser.mediaId, filename: path.basename(loser.relativePath), message: safeMessage(error) });
        // An unfinished durable merge must be recovered before another merge.
        // Stop this person instead of making speculative changes after a fault.
        return result;
      }
    }
  }
  abort(signal);
  if (result.merged) await index.finalizeNaming({ signal });
  await index.compact();
  update();
  return result;
}

async function writeReport(filePath, job) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(job)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, filePath); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export class DedupManager {
  constructor({ loadState, reportFile, acquireMaintenance, releaseMaintenance,
    openMediaIndex = openPersonMediaIndex, deduplicate = deduplicatePerson }) {
    Object.assign(this, { loadState, reportFile, acquireMaintenance, releaseMaintenance, openMediaIndex, deduplicate });
    this.job = { status: "idle", phase: "idle", scope: "all", personId: null, scanned: 0, total: 0, merged: 0, review: 0, archivedBytes: 0, errors: [], results: [], dismissed: false };
    this.controller = null;
    this.running = null;
    this.dismissing = null;
    this.closeWhenStopped = false;
    this.closing = false;
    this.ready = this.loadReport();
  }

  async loadReport() {
    if (!this.reportFile) return;
    try {
      const info = await lstat(this.reportFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("去重回执文件异常。");
      const report = JSON.parse(await readFile(this.reportFile, "utf8"));
      if (!["completed", "cancelled", "failed"].includes(report.status) || !Array.isArray(report.results)) throw new Error("去重回执无效。");
      this.job = { scope: "all", personId: null, ...report, dismissed: report.dismissed === true };
    } catch (error) {
      if (error.code !== "ENOENT") this.job.message = "上一轮去重回执无法读取；媒体索引不会重置。";
    }
  }

  status() { return structuredClone(this.job); }

  async start({ personId } = {}) {
    await this.ready;
    if (personId !== undefined && (typeof personId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(personId))) {
      throw failure("dedup-person-invalid", "请选择有效的采集账号。", 400);
    }
    if (this.closing) throw failure("dedup-closing", "工具正在退出，不能开始去重。");
    if (this.running) throw failure("dedup-busy", "去重正在进行，请等待结束。无需重复点击。");
    if (this.dismissing) throw failure("dedup-receipt-busy", "正在关闭去重结果，请稍后重试。");
    const token = this.acquireMaintenance();
    try {
      const state = await this.loadState();
      const selected = personId === undefined ? null : state.persons.find((person) => person.id === personId);
      if (personId !== undefined && !selected) throw failure("dedup-person-not-found", "采集账号不存在，请刷新列表后重试。", 404);
      const persons = selected ? [selected] : state.persons;
      if (!persons.length) throw failure("dedup-empty", "请先新建人物。");
      if (this.closing) throw failure("dedup-closing", "工具正在退出，不能开始去重。");
      if (this.dismissing) throw failure("dedup-receipt-busy", "正在关闭去重结果，请稍后重试。");
      this.controller = new AbortController();
      this.closeWhenStopped = false;
      this.job = { id: randomUUID(), status: "running", phase: "inspecting", scope: selected ? "person" : "all",
        personId: selected?.id || null, personName: selected?.name || null, scanned: 0, total: 0, merged: 0,
        review: 0, archivedBytes: 0, errors: [], results: [], cancelRequested: false, dismissed: false, createdAt: new Date().toISOString(),
        message: `正在本地检查${selected ? ` ${selected.name} ` : "所有人物"}的图片和视频；冗余版本仅隔离保留。` };
      const run = this.run(persons, token);
      this.running = run;
      void run.finally(() => { if (this.running === run) this.running = null; }).catch(() => {});
      return this.status();
    } catch (error) {
      this.releaseMaintenance(token);
      throw error;
    }
  }

  cancel({ closeResults = false } = {}) {
    if (typeof closeResults !== "boolean") throw failure("dedup-close-invalid", "关闭结果选项无效。", 400);
    // A request arriving while the final receipt is being written still closes
    // that same job, but never hides it before its durable work has settled.
    if (closeResults && this.running) this.closeWhenStopped = true;
    if (this.job.status === "running") {
      this.job.cancelRequested = true;
      this.job.message = "正在停止去重；已提交的合并、来源和隔离副本保留。";
      this.controller?.abort();
    }
    return this.status();
  }

  async dismiss({ jobId } = {}) {
    await this.ready;
    if (typeof jobId !== "string" || !jobId || jobId.length > 200) {
      throw failure("dedup-job-invalid", "请选择要关闭的去重结果。", 400);
    }
    if (jobId !== this.job.id) throw failure("dedup-result-stale", "去重结果已经更新，请刷新后再关闭。");
    if (this.running) throw failure("dedup-busy", "去重尚未停止，请等待文件和索引处理结束。");
    if (this.dismissing) throw failure("dedup-receipt-busy", "正在关闭去重结果，请稍后重试。");
    if (!["completed", "cancelled", "failed"].includes(this.job.status)) {
      throw failure("dedup-result-unavailable", "当前没有可关闭的去重结果。");
    }
    if (this.job.dismissed) return this.status();
    const dismissed = { ...this.status(), dismissed: true };
    const transition = (async () => {
      if (this.reportFile) await writeReport(this.reportFile, dismissed);
      this.job = dismissed;
      return this.status();
    })();
    this.dismissing = transition;
    try { return await transition; }
    finally { if (this.dismissing === transition) this.dismissing = null; }
  }

  async run(persons, token) {
    try {
      for (const person of persons) {
        abort(this.controller.signal);
        this.job.currentPersonId = person.id;
        this.job.personName = person.name;
        const base = Object.fromEntries(["scanned", "total", "merged", "review", "archivedBytes"].map((key) => [key, this.job[key]]));
        try {
          // A missing/changed NAS index is not permission to initialize a blank one.
          const index = await this.openMediaIndex(person, { requireExisting: true, writable: true, signal: this.controller.signal });
          const report = await this.deduplicate(person, index, { signal: this.controller.signal, onProgress: (current) => {
            for (const key of Object.keys(base)) this.job[key] = base[key] + current[key];
            this.job.message = `正在检查 ${person.name}：${current.scanned}/${current.total}，已合并 ${current.merged} 份，差异版本保留 ${current.review} 项。`;
          } });
          this.job.results.push(report);
          for (const key of Object.keys(base)) this.job[key] = base[key] + report[key];
          this.job.errors.push(...report.errors.map((item) => ({ ...item, personName: person.name })));
        } catch (error) {
          if (error?.name === "AbortError" || this.controller.signal.aborted) throw error;
          this.job.errors.push({ personName: person.name, message: safeMessage(error) });
        }
      }
      this.job.status = this.job.errors.length ? "failed" : "completed";
      this.job.phase = this.job.status;
      this.job.message = `本地去重结束：合并 ${this.job.merged} 份，差异版本保留 ${this.job.review} 项${this.job.errors.length ? `，${this.job.errors.length} 项检查未完成` : ""}。差异版本已按保守规则自动保留，不是漏下载，也不要求手动检查。冗余原文件保存在 Index/DedupArchive，全部发布来源保留；尚未释放总磁盘空间。`;
    } catch (error) {
      this.job.status = this.controller.signal.aborted ? "cancelled" : "failed";
      this.job.phase = this.job.status;
      this.job.message = safeMessage(error);
    } finally {
      this.job.finishedAt = new Date().toISOString();
      try {
        let dismissAfterSettlement = this.closeWhenStopped;
        if (this.reportFile) await writeReport(this.reportFile, { ...this.status(), dismissed: dismissAfterSettlement });
        // A stop-and-close request can arrive during the first atomic write.
        // Persist its close state before publishing a hidden terminal receipt.
        if (!dismissAfterSettlement && this.closeWhenStopped) {
          dismissAfterSettlement = true;
          if (this.reportFile) await writeReport(this.reportFile, { ...this.status(), dismissed: true });
        }
        this.job.dismissed = dismissAfterSettlement;
      } catch {
        this.job.errors.push({ message: "去重回执保存失败；已持久化的人物索引与隔离副本保留。" });
        this.job.status = "failed";
        this.job.phase = "failed";
        this.job.dismissed = false;
      }
      this.releaseMaintenance(token);
    }
    return this.status();
  }

  async shutdown() {
    this.closing = true;
    this.cancel();
    await this.running;
    await this.dismissing;
  }
}
