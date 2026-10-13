import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath, lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { portableRuntimeStatus, preparePortableRuntime, assertRuntimeDirectory } from "../lib/portable-runtime.mjs";

// The distributed app/scripts location is the authority. Never consume an
// inherited developer root, system browser, PATH install or arbitrary --root.
const filename = fileURLToPath(import.meta.url), app = path.dirname(path.dirname(filename)), root = path.dirname(app);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const controller = new AbortController();
let reader;
let finished = false;
try {
  if (path.basename(app) !== "app" || path.basename(path.dirname(filename)) !== "scripts"
    || (await lstat(filename)).isSymbolicLink() || path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) {
    throw Object.assign(new Error("请从解压包的 app/scripts 运行组件准备器。"), { code: "runtime-root-invalid" });
  }
  await assertRuntimeDirectory(app);
  const args = process.argv.slice(2), allowed = new Set(["--status", "--json", "--verify", "--install", "--prepare", "--confirmed", "--cancel-on-eof"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) throw new Error("组件准备参数无效。");
  const install = args.includes("--install") || args.includes("--prepare");
  if (args.includes("--install") && args.includes("--prepare") || install && (args.includes("--status") || args.includes("--verify"))) {
    throw new Error("组件准备模式冲突。");
  }
  if (install) {
    if (!args.includes("--confirmed")) throw Object.assign(new Error("未确认下载运行组件，尚未连接网络。"), { code: "runtime-confirmation-required" });
    const cancel = () => controller.abort(new DOMException("运行组件准备已取消，已完成组件保留。", "AbortError"));
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => { if (line.trim() === "cancel") cancel(); else { try { if (JSON.parse(line).type === "cancel") cancel(); } catch {} } });
    // The native GUI owns its redirected input pipe. If that owner vanishes,
    // cooperatively stop downloads instead of leaving an orphan preparation.
    // Standalone CLI callers retain their existing EOF behavior without flag.
    if (args.includes("--cancel-on-eof")) reader.once("close", () => { if (!finished) cancel(); });
    const result = await preparePortableRuntime({ root, confirmed: true, signal: controller.signal, progress: emit });
    finished = true;
    emit({ type: "result", ...result });
    if (!result.ready) process.exitCode = 1;
  } else {
    if (args.includes("--confirmed")) throw new Error("只读状态检查不接受下载确认参数。");
    if (args.includes("--cancel-on-eof")) throw new Error("只读状态检查不接受 GUI 下载取消参数。");
    const result = await portableRuntimeStatus({ root });
    emit(result);
    if (args.includes("--verify") && !result.ready) process.exitCode = 1;
  }
} catch (error) {
  finished = true;
  emit({ type: "error", schemaVersion: 1, ready: false, code: error.code || error.name || "runtime-prepare-failed", message: error.message });
  process.exitCode = controller.signal.aborted || error.name === "AbortError" ? 2 : 1;
} finally { finished = true; reader?.close(); process.stdin.pause(); }
