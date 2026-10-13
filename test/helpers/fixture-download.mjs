import { downloadMediaItem } from "../../lib/downloader.mjs";

// Real local hashing/index commits, with only an in-memory fixture transport.
// Never access the fixture URLs or a user's platform account.
export async function fixtureDownload(item, root, scope, options = {}, payload = item.postId) {
  const contentType = item.kind === "video" || item.extension === ".mp4" ? "video/mp4"
    : item.extension === ".gif" ? "image/gif" : "image/jpeg";
  return downloadMediaItem(item, root, scope, {
    ...options,
    fetchMedia: async () => new Response(payload, { headers: { "Content-Type": contentType } }),
  });
}
