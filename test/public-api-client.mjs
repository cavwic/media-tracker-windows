import path from "node:path";
import { cp, mkdir, symlink } from "node:fs/promises";
import { requiresPublicUseAcknowledgement } from "../lib/public-release-policy.mjs";

// Fixture-only client. Never contacts an author account or a non-loopback URL.
const nativeFetch = globalThis.fetch;
const sessions = new Map();

async function sessionToken(origin, signal) {
  if (sessions.has(origin)) return sessions.get(origin);
  const response = await nativeFetch(`${origin}/api/session`, { headers: { Origin: origin, Connection: "close" }, signal, redirect: "error" });
  if (response.ok) {
    const payload = await response.json();
    if (payload.applicationId === "media-tracker-public" && /^[a-f0-9]{64}$/.test(payload.token || "")) {
      sessions.set(origin, payload.token); return payload.token;
    }
  } else await response.body?.cancel();
  return null;
}

export async function publicApiFetch(input, options = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(options.headers);
  headers.set("Connection", "close");
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname.startsWith("/api/")
    && !["/api/session", "/api/runtime/status"].includes(url.pathname)
    && !headers.has("X-Media-Tracker-Token")) {
    const token = await sessionToken(url.origin, options.signal);
    if (token) headers.set("X-Media-Tracker-Token", token);
  }
  // Old collector fixtures have explicit consent by test setup. Negative
  // policy/security tests use native fetch instead and never auto-confirm.
  if (headers.has("X-Media-Tracker-Token") && requiresPublicUseAcknowledgement(options.method || "GET", url.pathname)) {
    const statusResponse = await nativeFetch(`${url.origin}/api/release-policy`, { headers, signal: options.signal });
    if (statusResponse.ok && !(await statusResponse.json()).acknowledged) {
      const acknowledgementHeaders = new Headers(headers);
      acknowledgementHeaders.set("Origin", url.origin); acknowledgementHeaders.set("Content-Type", "application/json");
      const accepted = await nativeFetch(`${url.origin}/api/release-policy`, { method: "POST", headers: acknowledgementHeaders,
        body: JSON.stringify({ acknowledged: true, version: 1 }), signal: options.signal });
      await accepted.body?.cancel();
      if (!accepted.ok) throw new Error("Fixture acknowledgement failed");
    } else if (!statusResponse.ok) await statusResponse.body?.cancel();
  }
  const response = await nativeFetch(input, { ...options, headers }).catch((error) => {
    throw new Error(`Fixture fetch failed: ${url.pathname}`, { cause: error });
  });
  if (response.status === 403 && !new Headers(options.headers).has("X-Media-Tracker-Token")
    && (await response.clone().json().catch(() => ({}))).code === "local-session-required") {
    sessions.delete(url.origin);
    const token = await sessionToken(url.origin, options.signal);
    if (token) {
      await response.body?.cancel();
      headers.set("X-Media-Tracker-Token", token);
      return nativeFetch(input, { ...options, headers });
    }
  }
  return response;
}

/** An actual portable service must execute from its own package, not a remote source checkout. */
export async function copyPublicApplicationFixture(packageRoot, sourceRoot = path.resolve(import.meta.dirname, "..")) {
  const appRoot = path.join(packageRoot, "app");
  await mkdir(appRoot, { recursive: true });
  for (const entry of ["server.mjs", "lib", "public", "scripts", "packaging", "package.json"]) {
    await cp(path.join(sourceRoot, entry), path.join(appRoot, entry), { recursive: true,
      filter: (file) => !file.includes(`${path.sep}.cache${path.sep}`) && !file.includes(`${path.sep}verification${path.sep}`) });
  }
  await symlink(path.join(sourceRoot, "node_modules"), path.join(appRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return appRoot;
}
