// Filename days use a fixed Beijing timezone, independent of the host/session.
// A missing instant falls back to a genuine calendar-only
// platform value, then the source's persisted first collection day (never now).
export const FILENAME_TIME_ZONE = "Asia/Shanghai";
const UNKNOWN = Object.freeze({ publicationDate: null, dateBasis: "unknown", displayTimeZone: null });
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function validPublicationDate(value) {
  const match = String(value ?? "").trim().match(/^(\d{4})(?:(\d{2})(\d{2})|[-/.年](\d{1,2})[-/.月](\d{1,2})日?)$/);
  if (!match) return null;
  const [, yearText, compactMonth, compactDay, separateMonth, separateDay] = match;
  const monthText = compactMonth || separateMonth, dayText = compactDay || separateDay;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

export function validDisplayTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 100) return null;
  // Reject bare offsets and guessed labels. The browser's actual resolved IANA
  // name (including UTC, if confirmed by display evidence) is the input here.
  if (!/^(?:[A-Za-z0-9_+-]+\/)*[A-Za-z0-9_+-]+$/.test(value)) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function dateInTimeZone(createdAt, timeZone) {
  const timestamp = validTimestamp(createdAt);
  if (timestamp === null || !timeZone) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return validPublicationDate(`${value.year}-${value.month}-${value.day}`);
}

export function normalizePublicationDate(source = {}) {
  const publishedBeijing = dateInTimeZone(source.createdAt, FILENAME_TIME_ZONE);
  if (publishedBeijing) return { publicationDate: publishedBeijing, dateBasis: "created-at-beijing", displayTimeZone: FILENAME_TIME_ZONE };
  const explicit = validPublicationDate(source.publicationDate);
  const timeZone = validDisplayTimeZone(source.displayTimeZone);
  if (explicit && source.dateBasis === "platform") return { publicationDate: explicit, dateBasis: "platform", displayTimeZone: timeZone };
  // Preserve confirmed older calendar metadata if its publication instant is
  // no longer available; any available instant above always uses Beijing.
  if (explicit && source.dateBasis === "session-timezone" && timeZone) return { publicationDate: explicit, dateBasis: "session-timezone", displayTimeZone: timeZone };
  // A legacy filename is historical UTC-day evidence, not a confirmed platform
  // display date. Import time must never be substituted for its publication.
  if (source.dateBasis === "legacy-filename") return explicit
    ? { publicationDate: explicit, dateBasis: "legacy-filename", displayTimeZone: "UTC" } : { ...UNKNOWN };
  if (Array.isArray(source.backupImports) && source.backupImports.length) return { ...UNKNOWN };
  const firstCollectedBeijing = dateInTimeZone(source.firstSeenAt, FILENAME_TIME_ZONE);
  if (firstCollectedBeijing) return { publicationDate: firstCollectedBeijing, dateBasis: "first-collected-beijing", displayTimeZone: FILENAME_TIME_ZONE };
  return { ...UNKNOWN };
}

export function parseDisplayedPublicationDate(value) {
  const text = String(value || "").replace(/[\u200e\u200f\u202a-\u202e]/g, " ").trim();
  const numeric = text.match(/(?:^|[^\d])(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?:日)?(?:$|[^\d])/);
  if (numeric) return validPublicationDate(`${numeric[1]}-${numeric[2]}-${numeric[3]}`);
  // Only year-bearing, unambiguous absolute dates. Relative dates and numeric
  // month/day ordering without a year deliberately remain unknown.
  const names = MONTHS.map((month) => `${month}|${month.slice(0, 3)}`).join("|");
  const monthFirst = text.match(new RegExp(`\\b(${names})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`, "i"));
  const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})\\.?[,]?\\s+(\\d{4})\\b`, "i"));
  const match = monthFirst || dayFirst;
  if (!match) return null;
  const monthName = (monthFirst ? match[1] : match[2]).toLowerCase();
  const month = MONTHS.findIndex((name) => name === monthName || name.slice(0, 3) === monthName) + 1;
  return validPublicationDate(`${match[3]}-${month}-${monthFirst ? match[2] : match[1]}`);
}

function displayedClock(value) {
  const text = String(value || "");
  const match = text.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|上午|下午)?\b/i)
    || text.match(/(上午|下午)\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const chineseFirst = /^(上午|下午)$/.test(match[1]);
  let hour = Number(chineseFirst ? match[2] : match[1]);
  const minute = Number(chineseFirst ? match[3] : match[2]);
  const meridiem = String(chineseFirst ? match[1] : match[3] || "").toLowerCase();
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (["pm", "下午"].includes(meridiem) ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizedPostUrl(value) {
  try { const url = new URL(value); return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/$/, "")}${url.searchParams.has("story_fbid") ? `?story_fbid=${url.searchParams.get("story_fbid")}` : ""}`; } catch { return null; }
}

export function createPublicationDateCollector(platformId) {
  const byPost = new Map(), byTimestamp = new Map();
  let confirmedTimeZone = null;
  let conflictingTimeZone = false;

  const observe = ({ timeZone, records = [] } = {}) => {
    const candidateZone = validDisplayTimeZone(timeZone);
    for (const record of records) {
      const text = String(record.text || "");
      const publicationDate = parseDisplayedPublicationDate(text);
      if (!publicationDate) continue;
      const timestamp = validTimestamp(record.createdAt);
      const postUrl = normalizedPostUrl(record.postUrl);
      if (postUrl) byPost.set(postUrl, { publicationDate, timestamp });
      if (timestamp !== null) byTimestamp.set(timestamp, publicationDate);
      const clock = displayedClock(text);
      if (timestamp !== null && candidateZone && clock) {
        const localClock = new Intl.DateTimeFormat("en-GB", { timeZone: candidateZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(timestamp);
        if (dateInTimeZone(record.createdAt, candidateZone) === publicationDate && localClock === clock) {
          if (confirmedTimeZone && confirmedTimeZone !== candidateZone) conflictingTimeZone = true;
          else confirmedTimeZone = candidateZone;
        } else conflictingTimeZone = true;
      }
    }
  };

  const capture = async (page) => {
    // Inspect only the existing page: no navigation, hover-triggered request,
    // hidden browser window, cookie read, or per-post network request.
    try {
      observe(await page.evaluate((platform) => {
        const selectors = 'time[datetime], abbr[data-utime], [data-utime], [data-e2e="video-create-time"], [data-e2e="video-publish-time"], [data-e2e="browser-nickname"] span';
        const records = [];
        const postPath = platform === "x" ? /\/status\/\d+/ : platform === "instagram" ? /\/(?:p|reel)\/[^/]+/ : platform === "tiktok" ? /\/@[^/]+\/(?:video|photo)\/\d+/ : /\/(?:posts|videos)\/|story_fbid=|\/permalink\.php/;
        for (const element of [...document.querySelectorAll(selectors)].slice(0, 200)) {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const utime = Number(element.getAttribute("data-utime"));
          const datetime = element.getAttribute("datetime");
          const createdAt = datetime || (utime > 0 ? new Date(utime * 1000).toISOString() : null);
          const ancestorLink = element.closest("a[href]");
          const container = element.closest('article, [role="article"], [data-e2e="user-post-item"], [data-e2e="browse-video"]');
          const postLink = ancestorLink && postPath.test(ancestorLink.href) ? ancestorLink : [...(container?.querySelectorAll("a[href]") || [])].find((link) => postPath.test(link.href));
          const postUrl = postLink?.href || (postPath.test(location.href) ? location.href : null);
          const text = [element.innerText, element.getAttribute("title"), element.getAttribute("aria-label"), ancestorLink?.getAttribute("title"), ancestorLink?.getAttribute("aria-label")].filter(Boolean).join(" ").slice(0, 600);
          records.push({ createdAt, postUrl, text });
        }
        return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, records };
      }, platformId));
    } catch { /* Date evidence is optional; discovery errors retain their own handling. */ }
  };

  const apply = (items) => items.map((item) => {
    const existing = normalizePublicationDate(item);
    if (existing.publicationDate) return { ...item, ...existing };
    const timestamp = validTimestamp(item.createdAt);
    const postDate = byPost.get(normalizedPostUrl(item.postUrl));
    // A comment's <time> can live inside the same article as its original post.
    // Its timestamp must not change the post's displayed publication date.
    const date = (postDate && (postDate.timestamp === null || postDate.timestamp === timestamp) ? postDate.publicationDate : null) || byTimestamp.get(timestamp);
    if (date) return { ...item, publicationDate: date, dateBasis: "platform", displayTimeZone: conflictingTimeZone ? null : confirmedTimeZone };
    return { ...item, ...normalizePublicationDate({ ...item, dateBasis: conflictingTimeZone ? "unknown" : "session-timezone", displayTimeZone: confirmedTimeZone }) };
  });

  return { observe, capture, apply };
}
