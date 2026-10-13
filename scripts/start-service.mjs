import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_EXIT_CODES = Object.freeze({ nodeVersion: 20, dependencies: 21, chromium: 22 });
const FAILURE_REASONS = Object.freeze({ nodeVersion: "unsupported-node", dependencies: "missing-dependencies", chromium: "missing-chromium" });
const STATUS_TOKEN = /^[a-f0-9]{32}$/;

export class BootstrapPreflightError extends Error {
  constructor(kind, message) {
    super(message);
    this.reason = FAILURE_REASONS[kind];
    this.exitCode = BOOTSTRAP_EXIT_CODES[kind];
  }
}

export function startupStage(name, environment = process.env, log = console.log) {
  const supplied = Number(environment.MEDIA_TRACKER_LAUNCH_STARTED_AT_MS);
  const started = Number.isSafeInteger(supplied) && supplied > 0 ? supplied : Date.now();
  log("[startup] " + name + " elapsed=" + Math.max(0, Date.now() - started) + "ms");
}

export async function writeBootstrapStatus(error, environment = process.env) {
  if (!(error instanceof BootstrapPreflightError)) return false;
  const filename = environment.MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE;
  const token = environment.MEDIA_TRACKER_BOOTSTRAP_TOKEN;
  if (!filename || !path.isAbsolute(filename) || !STATUS_TOKEN.test(token || "")) return false;
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, token, reason: error.reason, exitCode: error.exitCode }),
    { flag: "wx", mode: 0o600 });
  return true;
}

/** Validate and start in one Node process; server imports reuse Playwright's module. */
export async function runServiceBootstrap({
  nodeVersion = process.versions.node, environment = process.env,
  loadPlaywright = () => import("playwright"), executableExists = existsSync,
  loadService = () => import("../server.mjs"),
  stage = (name) => startupStage(name, environment),
} = {}) {
  stage("bootstrap-start");
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new BootstrapPreflightError("nodeVersion", "Node.js 20 or newer is required. Install the official Node.js LTS release.");
  }
  let runtime;
  try { runtime = await loadPlaywright(); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
      throw new BootstrapPreflightError("dependencies", "The local Playwright runtime is missing.");
    }
    throw error;
  }
  if (!runtime.chromium || !executableExists(runtime.chromium.executablePath())) {
    throw new BootstrapPreflightError("chromium", "The private Chromium runtime is missing.");
  }
  stage("runtime-ready");
  // Application exits with these numeric codes cannot impersonate preparation
  // failures. Only preflight writes an authenticated per-attempt status file.
  delete environment.MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE;
  delete environment.MEDIA_TRACKER_BOOTSTRAP_TOKEN;
  const service = await loadService();
  stage("service-imported");
  return service;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runServiceBootstrap(); }
  catch (error) {
    try {
      if (await writeBootstrapStatus(error)) process.exitCode = error.exitCode;
      else process.exitCode = 1;
    } catch (statusError) {
      console.error("The startup status could not be written: " + statusError.message);
      process.exitCode = 1;
    }
    console.error(error instanceof BootstrapPreflightError ? error.message : error.stack || error.message);
  }
}
