// MIT. This acknowledgement is a risk notice, not platform permission or a waiver.
export const PUBLIC_USE_VERSION = 1;

export function requiresPublicUseAcknowledgement(method, pathname) {
  if (method !== "POST") return false;
  return ["/api/sync-all", "/api/homepages/analyze", "/api/following-imports"].includes(pathname)
    || /^\/api\/persons\/[^/]+\/(?:sync|recheck|open-post)$/.test(pathname)
    || /^\/api\/linked-accounts\/[^/]+\/(?:open-login|verify-login)$/.test(pathname)
    || /^\/api\/platforms\/[^/]+\/probe$/.test(pathname);
}

export function publicUseStatus(settings = {}) {
  const record = settings.publicReleaseUse;
  return { version: PUBLIC_USE_VERSION,
    acknowledged: record?.version === PUBLIC_USE_VERSION && typeof record.acceptedAt === "string"
      && Number.isFinite(Date.parse(record.acceptedAt)),
    platformAuthorizationVerified: false,
    applicationId: "media-tracker-public" };
}

export function recordPublicUseAcknowledgement(body, now = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.acknowledged !== true
    || body.version !== PUBLIC_USE_VERSION
    || Object.keys(body).some((key) => !["acknowledged", "version"].includes(key))) {
    const error = new Error("请明确确认公开版使用须知；确认不等于获得平台或作品许可。");
    error.status = 400;
    throw error;
  }
  return { version: PUBLIC_USE_VERSION, acceptedAt: now.toISOString() };
}
