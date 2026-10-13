// Stop only on fresh timeline batches, never on repeated idle scrolls or one pinned post.
export function createSyncBoundary({ knownPosts = {}, initialComplete = false, since, overlapMs = 6 * 60 * 60 * 1000 } = {}) {
  const timestamp = Date.parse(since || "");
  const cutoff = Number.isFinite(timestamp) ? timestamp - overlapMs : null;
  const seen = new Set();
  let oldBatches = 0;
  let reached = false;
  const reset = () => { seen.clear(); oldBatches = 0; reached = false; };
  return {
    get reached() { return reached; },
    reset,
    observe(posts = []) {
      if (!initialComplete) return reached;
      const unique = [...new Map(posts.filter((post) => post?.postKey && !post.pinned).map((post) => [post.postKey, post])).values()];
      // Late/out-of-order batches and incomplete album items invalidate a
      // tentative boundary while other response bodies are still being read.
      if (unique.some((post) => !knownPosts[post.postKey] || post.mediaComplete === false)) {
        oldBatches = 0;
        reached = false;
      }
      const fresh = unique.filter((post) => !seen.has(post.postKey));
      for (const post of fresh) seen.add(post.postKey);
      if (!fresh.length) return reached;
      const entirelyKnown = fresh.every((post) => Boolean(knownPosts[post.postKey]) && post.mediaComplete !== false);
      const old = fresh.filter((post) => {
        const created = Date.parse(post.createdAt || "");
        return cutoff === null || (Number.isFinite(created) && created <= cutoff);
      });
      // A batch containing a new post resets the boundary, even if it has an old date.
      oldBatches = entirelyKnown && old.length >= 3 ? oldBatches + 1 : 0;
      reached = oldBatches >= 2;
      return reached;
    },
  };
}
