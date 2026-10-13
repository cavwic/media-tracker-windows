import { performance } from "node:perf_hooks";

const STAGE = /^[a-z][a-z0-9.-]{0,79}$/;

/** Numeric component timings only: never record account, URL or profile data. */
export function createStartupTiming({ launchStartedAt = process.env.MEDIA_TRACKER_LAUNCH_STARTED_AT_MS,
  now = () => Date.now(), nodeElapsed = () => performance.now(), write = (line) => console.log(line) } = {}) {
  const launch = Number(launchStartedAt);
  return (stage, phaseElapsed) => {
    // A diagnostic sink must never make opening the actual application fail.
    try {
      if (typeof stage !== "string" || !STAGE.test(stage)) return;
      const nodeMs = nodeElapsed();
      const launchMs = now() - launch;
      const fields = ["[startup]", stage];
      if (Number.isFinite(nodeMs) && nodeMs >= 0) fields.push(`node=${Math.round(nodeMs)}ms`);
      if (Number.isFinite(launch) && launch > 0 && launchMs >= 0 && launchMs < 3_600_000) {
        fields.push(`launch=${Math.round(launchMs)}ms`);
      }
      if (Number.isFinite(phaseElapsed) && phaseElapsed >= 0) fields.push(`phase=${Math.round(phaseElapsed)}ms`);
      const result = write(fields.join(" "));
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  };
}
