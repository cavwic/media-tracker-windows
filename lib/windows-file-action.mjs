const FOREGROUND_REASONS = new Set([
  "foreground", "already-foreground", "target-unconfirmed", "target-ambiguous",
  "user-switched", "foreground-denied", "timeout",
]);

// The helper reports fixed machine codes only. Do not infer success from an
// exception message or pass application window titles back to the browser.
export function parseWindowsFileActionOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim());
  const field = (name) => {
    const values = lines.filter((line) => line.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : null;
  };
  const reason = field("reason");
  return {
    launched: field("launched") === "true",
    foreground: field("foreground") === "true",
    ...(FOREGROUND_REASONS.has(reason) ? { reason } : {}),
  };
}
