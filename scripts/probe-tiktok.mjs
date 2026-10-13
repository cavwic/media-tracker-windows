// Read-only live check: no media files, receipts, or sync checkpoints are written.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { acquireTikTokPage } from "../lib/tiktok-browser.mjs";
import { inspectTikTokPageLogin } from "../lib/tiktok-login.mjs";
import { resolveTikTokHandle } from "../lib/tiktok-media.mjs";
import { discoverTikTokMedia } from "../lib/tiktok-sync.mjs";

const root = path.resolve(import.meta.dirname, "..");
const data = process.env.MEDIA_TRACKER_DATA_DIR || path.join(root, "data");
const state = JSON.parse(await readFile(path.join(data, "state.json"), "utf8"));
const person = state.persons.find((item) => item.name === process.argv[2]);
const target = person?.platforms.find((item) => item.id === "tiktok")?.accounts[0];
const linkedAccount = state.linkedAccounts.find((item) => item.id === target?.linkedAccountId);
if (!target || !linkedAccount) throw new Error("请指定已绑定 TikTok 登录账号的人物名称。");
const handle = resolveTikTokHandle(target);
if (process.argv.includes("--discover")) {
  const result = await discoverTikTokMedia({ handle, linkedAccount, maxScrolls: 0, maxDetailPages: 0 });
  console.log(JSON.stringify({ handle, posts: result.posts.length, media: result.media.length,
    complete: result.complete, timelineResponses: result.timelineResponses,
    reachedEnd: result.reachedEnd, unresolvedPosts: result.unresolvedPosts }));
  await result.dispose?.();
} else {
  const session = await acquireTikTokPage({ profileDirectory: linkedAccount.profileDirectory, purpose: "verify" });
  const pending = new Set(), responses = [];
  session.page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.hostname !== "www.tiktok.com" || url.pathname !== "/api/post/item_list/") return;
    const task = (async () => {
      const text = await response.text().catch(() => "");
      let payload; try { payload = JSON.parse(text); } catch {}
      responses.push({ status: response.status(), bytes: Buffer.byteLength(text),
        platformStatus: payload?.statusCode, itemCount: payload?.itemList?.length, hasMore: payload?.hasMore });
    })().finally(() => pending.delete(task));
    pending.add(task);
  });
  try {
    const response = await session.page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await session.page.waitForTimeout(8000);
    await Promise.allSettled([...pending]);
    const login = await inspectTikTokPageLogin(session.page, { status: response?.status() || 0 });
    const tiles = await session.page.locator('[data-e2e="user-post-item"]').count();
    console.log(JSON.stringify({ handle, login, navigationStatus: response?.status(), tiles, responses }));
  } finally { await session.release(); }
}
