import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyCustomLogin, inspectCustomLogin, readCustomLoginSnapshot } from "../lib/custom-login.mjs";

const platform = { homepageUrl: "https://example.com/", loginMarker: "#account-menu", logoutMarker: "#sign-in" };
const anonymous = { url: "https://example.com/login", status: 200, loggedIn: false, hasCredentialForm: true };
const success = { url: "https://example.com/settings", status: 200, loggedIn: true, anonymous };

test("generic login requires configured online evidence, not cookies or HTTP 200", () => {
  assert.equal(classifyCustomLogin(platform, success).verified, true);
  assert.equal(classifyCustomLogin({ ...platform, loginMarker: "" }, success).code, "login-rule-required");
  for (const patch of [{ status: 403 }, { status: 0 }, { url: "https://google.com/" }, { url: "https://example.com/login" },
    { url: "https://example.com/captcha" }, { loggedIn: false }, { challenge: true }, { loggedOut: true },
    { hasCredentialForm: true }, { invalidSelector: true }, { rootMarker: true }]) {
    assert.equal(classifyCustomLogin(platform, { ...success, ...patch }).verified, false, JSON.stringify(patch));
  }
  assert.equal(classifyCustomLogin(platform, { url: success.url, status: 200, cookies: [{}] }).verified, false);
});

test("missing login rule does not launch a browser or inspect a user's profile", async () => {
  const result = await inspectCustomLogin({ ...platform, loginMarker: "" }, {}, { browserType: {
    launchPersistentContext() { assert.fail("No rule must not open a browser"); },
  }, checkUrl() { assert.fail("No rule must not fetch a site"); } });
  assert.equal(result.verified, false);
});

test("login check uses only specified profile headlessly, blocks unsafe redirects and closes context", async () => {
  let closed = false;
  let anonymousClosed = false;
  let routeHandler;
  const page = { goto: async () => ({ status: () => 200 }), waitForTimeout: async () => {}, evaluate: async () => success };
  const anonymousContext = { route: async (_, fn) => { routeHandler = fn; }, newPage: async () => ({ ...page, evaluate: async () => anonymous }), close: async () => { anonymousClosed = true; } };
  const context = { pages: () => [page], route: async (_, fn) => { routeHandler = fn; }, close: async () => { closed = true; },
    browser: () => ({ newContext: async (options) => {
      assert.equal(options.storageState, undefined); assert.equal(options.httpCredentials, undefined);
      return anonymousContext;
    } }),
  };
  const result = await inspectCustomLogin(platform, { profileDirectory: "isolated-test-profile" }, {
    browserType: { launchPersistentContext: async (directory, options) => {
      assert.equal(directory, "isolated-test-profile"); assert.equal(options.headless, true); return context;
    } }, checkUrl: async (url) => { if (url.includes("127.0.0.1")) throw new Error("private"); },
  });
  assert.equal(result.verified, true);
  assert.equal(closed, true);
  assert.equal(anonymousClosed, true);
  let aborted = false;
  await routeHandler({ request: () => ({ url: () => "https://127.0.0.1" }), abort: async () => { aborted = true; }, continue: () => assert.fail("unsafe request") });
  assert.equal(aborted, true);
});

test("anonymous comparison rejects public markers and uncertain guest pages", () => {
  assert.equal(classifyCustomLogin(platform, { ...success, anonymous: undefined }).code, "login-comparison-inconclusive");
  assert.equal(classifyCustomLogin(platform, { ...success, anonymous: { ...anonymous, loggedIn: true } }).code, "login-marker-public");
  for (const patch of [{ status: 403 }, { status: 0 }, { challenge: true }, { invalidSelector: true }, { url: "https://other.example.com/" },
    { url: "https://example.com/public", hasCredentialForm: false, loggedOut: false }]) {
    const result = classifyCustomLogin(platform, { ...success, anonymous: { ...anonymous, ...patch } });
    assert.equal(result.verified, false, JSON.stringify(patch));
    assert.equal(result.code, "login-comparison-inconclusive");
  }
  assert.equal(classifyCustomLogin(platform, { ...success, anonymous: { url: "https://example.com/", status: 200, loggedIn: false, loggedOut: true } }).verified, true);
});

test("anonymous navigation failure cannot turn a candidate marker into success and closes both contexts", async () => {
  const closed = [];
  const context = {
    route: async () => {}, pages: () => [{ goto: async () => ({ status: () => 200 }), waitForTimeout: async () => {}, evaluate: async () => success }],
    browser: () => ({ newContext: async () => ({ route: async () => {},
      newPage: async () => ({ goto: async () => { throw new Error("Fixture timeout"); } }),
      close: async () => { closed.push("anonymous"); },
    }) }), close: async () => { closed.push("authenticated"); },
  };
  const result = await inspectCustomLogin(platform, { profileDirectory: "isolated" }, {
    browserType: { launchPersistentContext: async () => context }, checkUrl: async () => {},
  });
  assert.equal(result.verified, false);
  assert.equal(result.code, "login-comparison-inconclusive");
  assert.deepEqual(closed, ["anonymous", "authenticated"]);
});

test("online login failure never returns success and always releases context", async () => {
  let closed = false;
  const result = await inspectCustomLogin(platform, { profileDirectory: "isolated" }, {
    browserType: { launchPersistentContext: async () => ({ route: async () => {}, pages: () => [{ goto: async () => { throw new Error("timeout"); } }], close: async () => { closed = true; } }) },
    checkUrl: async () => {},
  });
  assert.equal(result.verified, false); assert.equal(closed, true);
});

test("DOM verification ignores hidden login forms but sees visible challenge and invalid selectors", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="account-menu">Me</button><input type="password" hidden><div id="captcha" hidden>challenge</div>');
    let snapshot = await readCustomLoginSnapshot(page, platform);
    assert.equal(snapshot.loggedIn, true);
    assert.equal(snapshot.hasCredentialForm, false);
    assert.equal(snapshot.challenge, false);
    await page.locator("#captcha").evaluate((element) => { element.hidden = false; });
    snapshot = await readCustomLoginSnapshot(page, platform);
    assert.equal(snapshot.challenge, true);
    assert.equal((await readCustomLoginSnapshot(page, { ...platform, loginMarker: "##broken" })).invalidSelector, true);
    await page.locator("#account-menu").evaluate((element) => { element.hidden = true; });
    assert.equal((await readCustomLoginSnapshot(page, platform)).loggedIn, false);
    await page.setContent('<body data-theme="light"><nav id="site-nav">Public navigation</nav></body>');
    for (const loginMarker of ["body[data-theme]", "html:not(#never)", "*[data-theme]", "#site-nav, body"]) {
      const rules = { ...platform, loginMarker };
      const snapshot = await readCustomLoginSnapshot(page, rules);
      assert.equal(snapshot.rootMarker, true, loginMarker);
      assert.equal(classifyCustomLogin(rules, { ...snapshot, url: success.url, status: 200, anonymous }).verified, false);
    }
  } finally { await browser.close(); }
});

test("real persistent-profile verification uses a cookie-free temporary comparison context", async () => {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "media-tracker-custom-login-fixture-"));
  let authenticatedContext;
  const closed = [];
  const observed = [];
  try {
    authenticatedContext = await chromium.launchPersistentContext(directory, { headless: true });
    const browser = authenticatedContext.browser();
    assert.ok(browser);
    const createAnonymousContext = browser.newContext.bind(browser);
    await authenticatedContext.addCookies([{ name: "fixture-session", value: "test-only", domain: "example.com", path: "/" }]);
    const installFixtureRoute = (context, kind) => {
      const route = context.route.bind(context);
      context.route = async (pattern, guard) => route(pattern, async (requestRoute) => {
        const cookies = await context.cookies();
        observed.push({ kind, cookies: cookies.length });
        await guard({ request: () => requestRoute.request(), abort: () => requestRoute.abort(),
          continue: () => requestRoute.fulfill({ status: 200, contentType: "text/html", body: kind === "authenticated"
            ? '<button id="account-menu">Fixture account</button>' : '<a id="sign-in" href="/login">Sign in</a>' }),
        });
      });
      context.on("close", () => closed.push(kind));
      return context;
    };
    installFixtureRoute(authenticatedContext, "authenticated");
    browser.newContext = async (options) => {
      assert.equal(options.storageState, undefined);
      const context = await createAnonymousContext(options);
      assert.equal((await context.cookies()).length, 0);
      return installFixtureRoute(context, "anonymous");
    };
    const result = await inspectCustomLogin(platform, { profileDirectory: directory }, {
      browserType: { launchPersistentContext: async (profile, options) => {
        assert.equal(profile, directory); assert.equal(options.headless, true); return authenticatedContext;
      } }, checkUrl: async (url) => { assert.equal(new URL(url).hostname, "example.com"); },
    });
    assert.equal(result.verified, true);
    assert.ok(observed.some((item) => item.kind === "authenticated" && item.cookies === 1));
    assert.ok(observed.some((item) => item.kind === "anonymous" && item.cookies === 0));
    assert.deepEqual(closed, ["anonymous", "authenticated"]);
  } finally {
    await authenticatedContext?.close().catch(() => {});
    const exact = await realpath(directory);
    assert.equal(path.dirname(exact), temporaryRoot);
    assert.ok(path.basename(exact).startsWith("media-tracker-custom-login-fixture-"));
    await rm(exact, { recursive: true, force: true });
  }
});
