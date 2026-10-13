/** Read-only startup probes. Finish every request before forwarding/exiting. */
export async function inspectRunningTracker(port, { fetch = globalThis.fetch, host = "127.0.0.1",
  timeoutMs = 1_500, runtimeId = "builtin-chromium", applicationId } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  // A public edition must never inspect another application's private state
  // as a legacy fallback. Its explicit application identity lives in status.
  for (const endpoint of applicationId ? ["/api/runtime/status"] : ["/api/runtime/status", "/api/state"]) {
    try {
      const response = await fetch(`http://${host}:${port}${endpoint}`, {
        signal, headers: { Accept: "application/json" }, redirect: "error",
      });
      if (!response.ok) {
        // fetch resolves at the headers; close a foreign server's unread body
        // before trying the legacy endpoint or exiting this process.
        await response.body?.cancel();
        continue;
      }
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        // Invalid JSON is an explicit non-status response; a timeout or broken
        // connection is not permission to start another slow network attempt.
        if (error instanceof SyntaxError && !signal.aborted) continue;
        return false;
      }
      const runtime = payload?.runtime || payload;
      if (runtime?.id === runtimeId && (!applicationId || runtime.applicationId === applicationId)) return runtime;
    } catch { return false; }
  }
  return false;
}

export async function findRunningTracker(ports, { instanceKey, ...options } = {}) {
  // A foreign program on one candidate port must not serialize the whole
  // startup behind several deadlines. Await all probes so process.exit cannot
  // abandon pending requests, and retain the configured port preference.
  const inspected = await Promise.allSettled(ports.map((port) => inspectRunningTracker(port, options)));
  for (let index = 0; index < inspected.length; index++) {
    const result = inspected[index];
    if (result.status !== "fulfilled" || !result.value) continue;
    const runtime = result.value;
    if (runtime.instanceKey && runtime.instanceKey !== instanceKey) continue;
    return { port: ports[index], runtime };
  }
  return false;
}
