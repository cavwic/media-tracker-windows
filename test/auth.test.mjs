import test from "node:test";
import assert from "node:assert/strict";
import { classifyLogin, hasValidTikTokSession } from "../lib/auth.mjs";

test("X login flow is not considered authenticated", () => {
  const result = classifyLogin("x", { url: "https://x.com/i/flow/login", bodyText: "Log in" });
  assert.equal(result.verified, false);
});

test("Facebook credential form is not considered authenticated", () => {
  const result = classifyLogin("facebook", {
    url: "https://www.facebook.com/",
    hasPasswordField: true,
    hasUsernameField: true,
  });
  assert.equal(result.verified, false);
});

test("authenticated home page passes the basic check", () => {
  const result = classifyLogin("instagram", {
    url: "https://www.instagram.com/",
    bodyText: "Home Search Explore Reels Messages Profile",
  });
  assert.equal(result.verified, true);
});

test("an authenticated X navigation marker takes precedence over dormant login markup", () => {
  const result = classifyLogin("x", {
    url: "https://x.com/home",
    hasPasswordField: true,
    hasAuthenticatedMarker: true,
  });
  assert.equal(result.verified, true);
});

test("TikTok login prompt is not considered authenticated", () => {
  const result = classifyLogin("tiktok", {
    url: "https://www.tiktok.com/",
    hasLoginPrompt: true,
  });
  assert.equal(result.verified, false);
});

test("a generic TikTok marker cannot override a visible login prompt", () => {
  const result = classifyLogin("tiktok", {
    url: "https://www.tiktok.com/",
    hasLoginPrompt: true,
    hasAuthenticatedMarker: true,
  });
  assert.equal(result.verified, false);
});

test("TikTok generic markers and an empty page cannot establish an online login", () => {
  assert.equal(classifyLogin("tiktok", {
    url: "https://www.tiktok.com/", hasAuthenticatedMarker: true,
  }).verified, false);
  assert.equal(classifyLogin("tiktok", { url: "https://www.tiktok.com/" }).verified, false);
  assert.equal(classifyLogin("tiktok", {
    url: "https://www.tiktok.com/", status: 403,
    viewer: { uid: "123456", uniqueId: "viewer" },
  }).verified, false);
});

test("TikTok session verification accepts only non-expired authentication cookies", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  assert.equal(hasValidTikTokSession([
    { domain: ".tiktok.com", name: "sessionid", value: "encrypted-session", expires: (now / 1_000) + 3600 },
  ], now), true);
  assert.equal(hasValidTikTokSession([
    { domain: ".tiktok.com", name: "sessionid", value: "expired", expires: (now / 1_000) - 1 },
    { domain: ".tiktok.com", name: "msToken", value: "not-an-auth-session", expires: (now / 1_000) + 3600 },
  ], now), false);
  assert.equal(hasValidTikTokSession([
    { domain: "nottiktok.com", name: "sessionid", value: "unrelated", expires: -1 },
  ], now), false);
});
