import path from "node:path";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { lstat, realpath, open, rename, readFile, unlink, chmod } from "node:fs/promises";
import { lstatSync, readFileSync, unlinkSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN = /^[a-f0-9]{64}$/;
export const SESSION_HEADER = "X-Media-Tracker-Token";
export const PUBLIC_APPLICATION_ID = "media-tracker-public";
export const SESSION_FILENAME = ".runtime-session.json";
const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const reject = (message, code = "local-api-forbidden") => Object.assign(new Error(message), { status: 403, code });

/** Browser-origin protection is additional to, not a replacement for, loopback binding. */
export class LocalApiSecurity {
  constructor({ token = randomBytes(32).toString("hex"), host = "127.0.0.1" } = {}) {
    if (!TOKEN.test(token) || host !== "127.0.0.1") throw new TypeError("Invalid local service security settings.");
    this.token = token;
    this.host = host;
  }

  assertLocalRequest(request, port) {
    const expectedHost = `${this.host}:${port}`;
    if (request.headers?.host !== expectedHost) throw reject("已拒绝不属于本工具的本地服务地址。");
    if (Array.isArray(request.rawHeaders)
      && request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length !== 1) {
      throw reject("已拒绝重复或缺失的本地服务地址。");
    }
    const origin = request.headers?.origin;
    if (origin !== undefined && origin !== `http://${expectedHost}`) {
      throw reject("已拒绝来自其他网页的本地操作请求。");
    }
    // Browsers supply this header themselves. CLI callers may omit it; an
    // installed program under the same OS user is outside the web-origin boundary.
    const site = request.headers?.["sec-fetch-site"];
    if (site !== undefined && !["same-origin", "none"].includes(site)) {
      throw reject("已拒绝其他网站或本地应用页面的跨源请求。");
    }
    if (request.headers?.["sec-fetch-dest"] === "iframe" || request.headers?.["sec-fetch-dest"] === "frame") {
      throw reject("本工具不能嵌入其他页面。");
    }
    if (/^https?:\/\//i.test(request.url || "")) {
      const url = new URL(request.url);
      if (url.origin !== `http://${expectedHost}`) throw reject("已拒绝外部服务请求地址。");
    }
  }

  assertAuthenticated(request, port) {
    this.assertLocalRequest(request, port);
    const supplied = request.headers?.[SESSION_HEADER.toLowerCase()];
    if (typeof supplied !== "string" || !TOKEN.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(this.token, "hex"))) {
      throw reject("本地会话已失效，请重新打开工具页面。", "local-session-required");
    }
  }

  bootstrap(request, port) {
    this.assertLocalRequest(request, port);
    if (request.method !== "GET" || new URL(request.url, `http://${this.host}:${port}`).search) {
      throw reject("本地会话初始化不接受操作或参数。");
    }
    return { token: this.token, header: SESSION_HEADER, applicationId: PUBLIC_APPLICATION_ID };
  }
}

/** No portable environment override may point a copied public service at another app's data. */
export function assertPublicPortableRoot(root, paths) {
  if (!paths.portable) return;
  if (![key(paths.portableRoot), key(path.join(paths.portableRoot, "app"))].includes(key(root))
    || key(paths.dataDirectory) !== key(path.join(paths.portableRoot, "data"))) {
    throw Object.assign(new Error("公开版便携数据目录必须位于本软件目录；未读取其他工具的账号或登录资料。"), { code: "PUBLIC_DATA_ROOT_INVALID" });
  }
}

async function assertOrdinary(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || key(await realpath(file)) !== key(file)) {
    throw reject("本地会话文件路径无效，未读取其他文件。", "local-session-path-invalid");
  }
  return info;
}

async function protectSessionFile(file, { platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== "win32") { await chmod(file, 0o600); return; }
  const systemDirectory = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const { stdout } = await exec(path.join(systemDirectory, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
  });
  const sid = String(stdout).match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw reject("无法保护本地会话文件，工具未启动。", "local-session-permissions");
  await exec(path.join(systemDirectory, "icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:F`], {
    windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
  });
}

/** Protect an empty temporary file before writing any secret; then atomically publish it. */
export async function writeLocalSession(directory, record, { protectFile = protectSessionFile } = {}) {
  if (!TOKEN.test(record?.token || "") || !TOKEN.test(record?.instanceKey || "")
    || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || record.applicationId !== PUBLIC_APPLICATION_ID) throw new TypeError("Invalid session record.");
  await assertOrdinary(directory, true);
  const destination = path.join(directory, SESSION_FILENAME);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await protectFile(temporary);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close(); handle = null;
    try { await assertOrdinary(destination); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readLocalSession(directory, { instanceKey, port } = {}) {
  await assertOrdinary(directory, true);
  const file = path.join(directory, SESSION_FILENAME);
  const info = await assertOrdinary(file);
  if (info.size > 4096 || (process.platform !== "win32" && (info.mode & 0o077))) throw reject("本地会话文件权限无效。");
  const record = JSON.parse(await readFile(file, "utf8"));
  if (record.applicationId !== PUBLIC_APPLICATION_ID || record.instanceKey !== instanceKey || record.port !== port
    || !TOKEN.test(record.token || "")) throw reject("现有窗口与本地会话身份不匹配，请完整退出后重试。");
  return record;
}

/** Only remove this process's own published secret; never follow links or remove a replacement. */
export function removeLocalSessionSync(directory, token) {
  const file = path.join(directory, SESSION_FILENAME);
  try {
    const parent = lstatSync(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory() || key(realpathSync(directory)) !== key(directory)) return false;
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) return false;
    if (JSON.parse(readFileSync(file, "utf8")).token !== token) return false;
    unlinkSync(file); return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
