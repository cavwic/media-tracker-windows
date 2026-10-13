import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_TITLEBAR_BINDING = "__mediaTrackerSetTitlebarTheme";
export const APP_TITLEBAR_THEMES = Object.freeze({
  light: path.join(fileURLToPath(new URL("./app-themes/", import.meta.url)), "light"),
  dark: path.join(fileURLToPath(new URL("./app-themes/", import.meta.url)), "dark"),
});

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// This runs only in the owned app page. Native frame colors are taken from
// fixed, bundled permission-free themes; renderer input can never supply a
// file path, extension id, arbitrary color, process id or command.
export function watchAppTitlebarTheme({ binding, origin }) {
  if (window !== window.top || window.location.origin !== origin) return;
  if (window.__mediaTrackerTitlebarObserver) return;
  const fallback = { light: "#f4f7fb", dark: "#0d1420" };
  let previous;
  const update = () => {
    const root = document.documentElement;
    if (!root) return;
    const theme = root.dataset.theme;
    if (theme !== "light" && theme !== "dark") return;
    // Also provide the conventional browser/PWA color hint. Chromium --app
    // on Windows 10 draws its own frame and needs the local theme as well.
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      (document.head || root).append(meta);
    }
    meta.content = getComputedStyle(root).getPropertyValue("--frost").trim() || fallback[theme];
    if (previous === theme || typeof window[binding] !== "function") return;
    previous = theme;
    Promise.resolve(window[binding](theme)).catch(() => { previous = undefined; });
  };
  const install = () => {
    const root = document.documentElement;
    if (!root || window.__mediaTrackerTitlebarObserver) return;
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    window.__mediaTrackerTitlebarObserver = observer;
    update();
  };
  install();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { install(); update(); }, { once: true });
  // A live evaluation attaches the same observer to an already loaded page;
  // addInitScript attaches it again to the next document after a reload.
  if (document.readyState !== "loading") update();
}

export async function attachAppTitlebarTheme({ context, page, url, onError = console.error } = {}) {
  const origin = new URL(url).origin;
  let session;
  let closed = false;
  let desired;
  let applied;
  let pending = Promise.resolve();
  let failed = false;
  const report = (error) => {
    if (failed || closed) return;
    failed = true;
    const diagnostic = new Error(`Native titlebar theme could not be updated; the tool can still run. ${error?.message || error}`);
    try { Promise.resolve(onError(diagnostic)).catch(() => {}); } catch {}
  };
  const request = (theme) => {
    if (closed || failed || !["light", "dark"].includes(theme)) return Promise.resolve(false);
    desired = theme;
    // Append a drain for every request rather than using an active/finally
    // flag. A request arriving at a microtask boundary therefore cannot leave
    // the last desired theme stranded. Adjacent requests still coalesce to the
    // latest value, and protocol calls always remain serial.
    pending = pending.then(async () => {
      const next = desired;
      desired = undefined;
      if (closed || failed || !next || next === applied) return;
      try {
        await bounded(session.send("Extensions.loadUnpacked", { path: APP_TITLEBAR_THEMES[next] }), 2500, "Titlebar theme command timed out.");
        if (!closed) applied = next;
      } catch (error) { report(error); }
    });
    return pending.then(() => !failed && !closed);
  };
  const controller = {
    get theme() { return applied; },
    async close() {
      if (closed) return;
      closed = true;
      desired = undefined;
      // Detach first to cancel outstanding protocol commands. Frame styling
      // may never keep the owning browser/service alive during shutdown.
      if (session) await bounded(session.detach(), 200, "Titlebar session detach timed out.").catch(() => {});
      await bounded(pending, 100, "Titlebar shutdown timed out.").catch(() => {});
    },
  };
  try {
    session = await bounded(context.browser().newBrowserCDPSession(), 1500, "Titlebar session setup timed out.");
    await page.exposeBinding(APP_TITLEBAR_BINDING, (source, theme) => {
      // Exposed bindings are available in subframes, too. Require the exact
      // primary top frame and the service origin on every call, including
      // after navigation, before touching even our own private browser theme.
      if (source.page !== page || source.frame !== page.mainFrame() || closed) return false;
      let currentOrigin;
      try { currentOrigin = new URL(source.frame.url()).origin; } catch { return false; }
      if (currentOrigin !== origin || typeof theme !== "string" || !["light", "dark"].includes(theme)) return false;
      return request(theme);
    });
    const settings = { binding: APP_TITLEBAR_BINDING, origin };
    await page.addInitScript(watchAppTitlebarTheme, settings);
    await page.evaluate(watchAppTitlebarTheme, settings);
  } catch (error) { report(error); }
  return controller;
}
