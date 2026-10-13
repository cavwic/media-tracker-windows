import { chromium } from "playwright";
import { performance } from "node:perf_hooks";
import { attachAppTitlebarTheme } from "./app-titlebar-theme.mjs";
import { attachAppWindowFrame, prepareAppWindowFrame } from "./app-window-frame.mjs";
import path from "node:path";

// Only this tool's private app profile is owned here. Platform login/sync
// contexts and the user's installed browsers never participate in its lifetime.
export function createAppShell({ profileDirectory, browserType = chromium,
  onLastWindowClosed = async () => {}, onError = console.error, onStartupTiming = () => {}, launchTimeoutMs = 30_000,
  titlebarThemeFactory, windowFrameFactory, prepareWindowFrame = prepareAppWindowFrame, platform = process.platform } = {}) {
  if (typeof profileDirectory !== "string" || !profileDirectory) throw new TypeError("An app profile directory is required.");
  let context;
  let primaryPage;
  let opening;
  let closing;
  let intentionalClose = false;
  let notified = false;
  let ready = false;
  let titlebarTheme;
  let windowFrame;
  const endedContexts = new WeakSet();
  // No themes, CDP or native side effects in fake/offline browser adapters by
  // default. Tests may explicitly inject a factory for the owned context.
  const ownsNativeFrame = platform === "win32" && (browserType === chromium || typeof windowFrameFactory === "function");
  const ownsNativeTitlebar = platform === "win32" && !ownsNativeFrame && typeof titlebarThemeFactory === "function";

  const notifyClosed = (reason) => {
    ready = false;
    if (intentionalClose || notified) return;
    notified = true;
    // Do not await shutdown inside a Playwright event handler: shutdown also
    // closes this context, and context.close must be free to finish its events.
    Promise.resolve().then(() => onLastWindowClosed({ reason })).catch(onError);
  };

  async function closeOwnedContext(ownedContext) {
    if (!ownedContext || endedContexts.has(ownedContext)) return;
    try { await ownedContext.close(); }
    catch (error) {
      // A native frame closes the same owned Chromium window. Its context or
      // browser may finish closing while Playwright's close RPC is in flight.
      // Only the exact observed terminal context plus Playwright's known
      // already-closed error makes that race a successful, idempotent close.
      if (endedContexts.has(ownedContext) && typeof error?.message === "string"
        && /(?:^|:\s*)Target page, context or browser has been closed(?:$|[.\r\n])/.test(error.message)) return;
      throw error;
    }
  }

  async function launch(url) {
    const appUrl = new URL(url);
    if (appUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(appUrl.hostname)) {
      throw new TypeError("The app shell can only open the local tool service.");
    }
    const launchStartedAt = performance.now();
    const reportTimingError = (error) => {
      try { Promise.resolve(onError(error)).catch(() => {}); } catch {}
    };
    const markTiming = (stage) => {
      // Diagnostics are deliberately fire-and-forget and contain no URLs,
      // profile paths or account information. Even a faulty callback must not
      // hold up the tool window or change its shutdown behavior.
      try {
        Promise.resolve(onStartupTiming({ stage, elapsedMs: Math.max(0, performance.now() - launchStartedAt) }))
          .catch(reportTimingError);
      } catch (error) { reportTimingError(error); }
    };
    markTiming("launch-start");
    let launched;
    try {
      // Compile only if this source version has not already been cached. Do it
      // before opening Chromium so a first build cannot leave a full-screen
      // browser waiting in front of the user.
      const frameExecutable = ownsNativeFrame && !windowFrameFactory ? await prepareWindowFrame({cacheDirectory:path.join(path.dirname(profileDirectory),"native-app-frame")}) : undefined;
      launched = await browserType.launchPersistentContext(profileDirectory, {
        headless: false,
        executablePath: browserType.executablePath(),
        viewport: null,
        // Playwright otherwise emulates a light preference, even when Windows
        // is dark. Leave media preferences native so the UI's system mode can
        // observe OS changes; explicit UI themes still use their own CSS data.
        colorScheme: null,
        // Playwright's persistent default adds about:blank; --app already
        // provides our sole startup page. Do not create an extra blank window.
        ignoreDefaultArgs: ["about:blank", "--enable-automation", ...(ownsNativeTitlebar ? ["--disable-extensions"] : [])],
        args: ["--no-first-run", "--disable-background-mode", `--app=${appUrl.href}`,
          // This is the already owned, private Playwright pipe connection, not
          // a public debugging port. Only two bundled color-only themes can
          // be loaded; login/sync contexts and installed browsers are unchanged.
          ...(ownsNativeTitlebar ? ["--enable-unsafe-extension-debugging"] : []),
          // Chromium's --app frame is drawn by Chromium itself. Kiosk removes
          // that frame; the exact owned window is then hosted at normal size in
          // a permission-free Windows wrapper, not kept full-screen or cropped.
          ...(ownsNativeFrame ? ["--kiosk", "--start-minimized"] : [])],
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        timeout: launchTimeoutMs,
      });
      context = launched;
      context.once("close", () => { endedContexts.add(launched); notifyClosed("app-context-closed"); });
      context.browser()?.once("disconnected", () => { endedContexts.add(launched); notifyClosed("app-browser-disconnected"); });
      markTiming("browser-context-ready");
      if (intentionalClose) {
        await closeOwnedContext(context);
        throw new Error("The app shell is shutting down.");
      }
      const pages = context.pages().filter((page) => !page.isClosed());
      primaryPage = pages.find((page) => page.url() === appUrl.href)
        || pages.find((page) => !/^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?)$/.test(page.url()))
        || pages[0];
      if (!primaryPage) throw new Error("The tool app window did not open.");
      primaryPage.once("close", () => notifyClosed("app-window-closed"));
      primaryPage.once("crash", () => notifyClosed("app-window-crashed"));
      // A previously persisted profile may contain an old port. Navigate the
      // primary window only; do not create a replacement page or reload on open.
      if (primaryPage.url() !== appUrl.href) {
        await primaryPage.goto(appUrl.href, { waitUntil: "domcontentloaded", timeout: launchTimeoutMs });
      }
      for (const page of pages) {
        if (page !== primaryPage) await page.close().catch(onError);
      }
      if (intentionalClose || notified || primaryPage.isClosed()) throw new Error("The tool app window closed during startup.");
      if (ownsNativeFrame) {
        // A failed borderless host must fail startup and dispose its own
        // context; falling back to kiosk would strand a full-screen browser.
        windowFrame = await (windowFrameFactory || attachAppWindowFrame)({
          context, page: primaryPage, url: appUrl.href, executable: frameExecutable, onError,
          onClose: () => notifyClosed("app-window-closed"),
        });
      }
      if (ownsNativeTitlebar) {
        // Frame customization is optional. A compatibility/diagnostic failure
        // must never prevent the tool from starting or closing its service.
        try {
          titlebarTheme = await (titlebarThemeFactory || attachAppTitlebarTheme)({ context, page: primaryPage, url: appUrl.href, onError });
        } catch (error) { reportTimingError(error); }
      }
      if (intentionalClose || notified || primaryPage.isClosed()) throw new Error("The tool app window closed during startup.");
      ready = true;
      markTiming("primary-page-ready");
      if (windowFrame) await windowFrame.focus();
      else await primaryPage.bringToFront();
      markTiming("window-focused");
      return primaryPage;
    } catch (error) {
      ready = false;
      // Launch/setup failure must not leave an orphan private Chromium behind.
      // This is intentional cleanup, not a second window-closed notification.
      const priorIntentional = intentionalClose;
      intentionalClose = true;
      await windowFrame?.close().catch(reportTimingError);
      windowFrame = undefined;
      await titlebarTheme?.close().catch(reportTimingError);
      titlebarTheme = undefined;
      await closeOwnedContext(launched).catch(onError);
      intentionalClose = priorIntentional;
      context = undefined;
      primaryPage = undefined;
      throw error;
    }
  }

  return {
    get ready() { return ready; },
    get closing() { return intentionalClose || notified; },
    async open(url) {
      if (intentionalClose || notified) throw new Error("The app shell is shutting down.");
      if (opening) {
        await opening;
        if (intentionalClose || notified) throw new Error("The app shell is shutting down.");
      }
      if (primaryPage && !primaryPage.isClosed()) {
        if (windowFrame) await windowFrame.focus();
        else await primaryPage.bringToFront();
        return primaryPage;
      }
      opening = launch(url);
      try { return await opening; } finally { opening = undefined; }
    },
    close() {
      if (closing) return closing;
      intentionalClose = true;
      ready = false;
      closing = (async () => {
        // A close while Chromium is launching still waits for and disposes that
        // exact launched context. Never kill a process by executable name.
        await opening?.catch(() => {});
        await windowFrame?.close().catch(onError);
        windowFrame = undefined;
        await titlebarTheme?.close().catch(onError);
        titlebarTheme = undefined;
        await closeOwnedContext(context);
        context = undefined;
        primaryPage = undefined;
      })();
      return closing;
    },
  };
}
