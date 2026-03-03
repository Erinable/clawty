import fs from "node:fs/promises";
import path from "node:path";
import {
  METRICS_SUBDIR,
  WATCH_FLUSH_METRICS_FILE,
  WATCH_RUN_METRICS_FILE
} from "./metrics-event-types.js";

export { METRICS_SUBDIR, WATCH_FLUSH_METRICS_FILE, WATCH_RUN_METRICS_FILE };

export function roundWatchMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(3));
}

export async function appendWatchMetricEvent(workspaceRoot, config, fileName, event) {
  const metrics = config?.metrics || {};
  if (!metrics.enabled || !metrics.persist_watch) {
    return;
  }

  try {
    const metricsDir = path.join(workspaceRoot, METRICS_SUBDIR);
    await fs.mkdir(metricsDir, { recursive: true });
    await fs.appendFile(path.join(metricsDir, fileName), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Metrics persistence is best-effort and must not block indexing.
  }
}
