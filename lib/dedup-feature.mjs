import path from "node:path";
import { lstat, realpath, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { configureSimilarityTools, checkDedupTools, dedupToolsStatus, installBundledDedupTools,
  portableToolDirectory } from "./dedup-tools.mjs";

const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

/** No edition marker means the existing developer/standard behavior. */
export async function readDedupEdition(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw failure("dedup-edition-invalid", "工具目录必须是绝对路径。", 400);
  const filename = path.join(root, "components", "edition.json");
  let info;
  try { info = await lstat(filename); } catch (error) { if (error.code === "ENOENT") return "standard"; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096
    || path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) {
    throw failure("dedup-edition-invalid", "便携版本标记无效；未读取外部运行设置。");
  }
  let value;
  try { value = JSON.parse(await readFile(filename, "utf8")); } catch { throw failure("dedup-edition-invalid", "便携版本标记损坏。"); }
  if (value.schemaVersion !== 1 || !["standard", "minimal"].includes(value.edition)
    || (value.edition === "minimal" && value.dedup !== "on-demand")) throw failure("dedup-edition-invalid", "便携版本标记不受支持。");
  return value.edition;
}

/** A tiny availability layer: SHA indexing remains in the synchronization core. */
export class DedupFeature {
  constructor({ root, loadState, saveState, acquireMaintenance = () => null, releaseMaintenance = () => {}, signal,
    statusTools = dedupToolsStatus, installTools = installBundledDedupTools,
    configureTools = configureSimilarityTools, checkTools = checkDedupTools, persistTools = null } = {}) {
    Object.assign(this, { root: path.resolve(root), loadState, saveState, acquireMaintenance, releaseMaintenance, signal,
      statusTools, installTools, configureTools, check: checkTools, persistTools });
    this.edition = "standard";
    this.lastAvailable = true;
    this.running = null; this.controller = null; this.closing = false; this.job = null;
    this.preparing = false;
    this.ready = this.initialize();
  }

  async initialize() {
    this.edition = await readDedupEdition(this.root);
    this.lastAvailable = this.edition !== "minimal";
    const state = await this.loadState();
    this.configure(state.settings?.dedupTools);
  }

  configure(settings) {
    this.configureTools(settings, { root: this.root, allowSystemTools: this.edition !== "minimal" });
  }

  toolsOptions(options = {}) {
    return { ...options, root: this.root, allowSystemTools: this.edition !== "minimal" };
  }

  async status({ inspectTools = false } = {}) {
    await this.ready;
    // Standard/developer polling historically did not execute tools. Keep its
    // feature capability static; only explicit feature/settings checks inspect.
    const inspected = this.edition === "minimal" || inspectTools;
    const tools = inspected ? await this.statusTools(this.toolsOptions({ signal: this.signal })) : {};
    const minimal = this.edition === "minimal", available = !minimal || tools.ready === true;
    this.lastAvailable = available;
    return { id: "similarity-dedup", edition: this.edition, version: tools.componentVersion || null,
      available, ready: inspected ? tools.ready === true : null, installed: inspected ? tools.ready === true : null, included: !minimal,
      installAvailable: tools.installAvailable === true, packageAvailable: tools.installAvailable === true,
      importAvailable: false, installing: !!this.running || this.preparing, jobId: this.job?.id || null,
      progress: this.job ? structuredClone(this.job) : null,
      directory: tools.directory || "", defaultInstallDirectory: path.join(this.root, "tools"),
      message: this.running ? this.job.message : this.job?.status === "failed" ? this.job.message
        : minimal && !available ? "最小版尚未启用图片与视频相似去重。确认后可下载 FFmpeg 和 ffprobe 到本软件 tools 目录；媒体同步及 SHA-256 精确去重不受影响。"
          : "本地相似去重入口已启用；只有主动点击去重或完成媒体同步后才会处理本地文件。" };
  }

  async requireAvailable(options = {}) {
    await this.ready;
    if (this.edition === "minimal") {
      const tools = await this.statusTools(this.toolsOptions(options));
      if (!tools.ready) throw failure("dedup-feature-unavailable", "最小版相似去重尚未启用；请先确认下载对应工具。同步与 SHA-256 精确去重不受影响。");
    }
  }

  async checkTools(options = {}) {
    await this.requireAvailable(options);
    return this.check(this.toolsOptions(options));
  }

  /** Explicit user confirmation only; this never starts a deduplication job. */
  async startInstall({ confirmed = false } = {}) {
    if (confirmed !== true) throw failure("dedup-feature-confirm-required", "下载去重工具需要明确确认。", 400);
    await this.ready;
    if (this.closing || this.signal?.aborted) throw failure("dedup-feature-closing", "工具正在退出，不能下载去重组件。");
    if (this.running || this.preparing) throw failure("dedup-feature-install-busy", "去重工具正在下载，请等待或停止，不会重复下载。");
    // Claim before the asynchronous precheck: double clicks cannot overwrite
    // the original controller/job while both await the same tool probe.
    this.preparing = true;
    this.controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, this.controller.signal]) : this.controller.signal;
    try {
    const status = await this.statusTools(this.toolsOptions({ signal }));
    signal.throwIfAborted();
    if (status.ready) return this.status();
    if (!status.installAvailable) throw failure("dedup-feature-package-unavailable", "当前发布包未提供可验证的 FFmpeg 组件来源，未连接网络；请在组件设置中明确指定可信的现有工具位置。", 422);
    const token = this.acquireMaintenance();
    this.job = { id: randomUUID(), status: "running", phase: "downloading", createdAt: new Date().toISOString(),
      message: "正在下载并校验官方固定版本 FFmpeg/ffprobe；安装至本软件 tools 目录，不会开始去重。" };
    const run = (async () => {
      try {
        const installed = await this.installTools({ root: this.root, parentDirectory: path.join(this.root, "tools"), signal,
          check: async (options) => {
            this.job.phase = "verifying"; this.job.message = "正在验证去重工具完整性与运行能力。";
            return this.check(this.toolsOptions(options));
          } });
        signal.throwIfAborted();
        const settings = { directory: portableToolDirectory(installed.directory, this.root) };
        if (this.persistTools) await this.persistTools(settings);
        else {
          const state = await this.loadState();
          state.settings = { ...state.settings, dedupTools: settings };
          await this.saveState(state);
        }
        this.configure(settings);
        await this.check(this.toolsOptions({ signal }));
        this.job.status = "completed"; this.job.phase = "ready";
        this.job.message = "去重工具已启用。请再次主动点击去重；本次没有处理或删除任何媒体。";
      } catch (error) {
        this.job.status = signal.aborted || error?.name === "AbortError" ? "cancelled" : "failed";
        this.job.phase = this.job.status;
        this.job.message = this.job.status === "cancelled" ? "去重工具下载已取消；已完整提交的工具保留，媒体和账号资料未修改。"
          : String(error.message || "去重工具安装失败；媒体和账号资料未修改。").slice(0, 1000);
      } finally {
        this.job.finishedAt = new Date().toISOString(); this.releaseMaintenance(token);
      }
    })();
    this.running = run;
    void run.finally(() => { if (this.running === run) this.running = null; }).catch(() => {});
    return this.status();
    } finally { this.preparing = false; }
  }

  async cancel({ confirmed = false } = {}) {
    if (confirmed !== true) throw failure("dedup-feature-confirm-required", "停止下载需要明确确认。", 400);
    if (this.running || this.preparing) {
      if (this.job) this.job.message = "正在取消去重工具下载并清理本次临时文件；媒体和账号资料保留。";
      this.controller?.abort();
    }
    return this.status();
  }

  async shutdown() {
    this.closing = true; this.controller?.abort();
    await this.running;
  }
}
