import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WINDOW_HOURS = 24;
const METRICS_DIR_RELATIVE = path.join(".clawty", "metrics");
const DEFAULT_HYBRID_FILE = "hybrid-query.jsonl";
const DEFAULT_WATCH_FLUSH_FILE = "watch-flush.jsonl";

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    windowHours: DEFAULT_WINDOW_HOURS,
    format: "text"
  };

  for (const arg of argv) {
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      options.format = "text";
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim();
      if (!value) {
        throw new Error("Invalid --workspace argument");
      }
      options.workspaceRoot = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--window-hours=")) {
      const value = Number(arg.slice("--window-hours=".length));
      if (!Number.isFinite(value) || value <= 0 || value > 24 * 30) {
        throw new Error("Invalid --window-hours argument");
      }
      options.windowHours = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function roundMetric(value, digits = 3) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content.trim()) {
    return [];
  }
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines to keep report robust.
    }
  }
  return rows;
}

function parseEventTimestampMs(event) {
  const raw = typeof event?.timestamp === "string" ? event.timestamp : null;
  if (!raw) {
    return null;
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    return null;
  }
  return ts;
}

function filterByWindow(events, windowStartMs) {
  return events.filter((event) => {
    const ts = parseEventTimestampMs(event);
    return ts !== null && ts >= windowStartMs;
  });
}

function computeHybridKpis(hybridEvents) {
  const queryDurations = [];
  const staleRates = [];
  let degradedCount = 0;

  for (const event of hybridEvents) {
    const queryMs = Number(event?.query_total_ms);
    if (Number.isFinite(queryMs) && queryMs >= 0) {
      queryDurations.push(queryMs);
    }

    const staleRate = Number(event?.sources?.freshness?.stale_hit_rate);
    if (Number.isFinite(staleRate) && staleRate >= 0) {
      staleRates.push(staleRate);
    }

    if (event?.degradation?.degraded === true) {
      degradedCount += 1;
    }
  }

  return {
    query_hybrid_count: hybridEvents.length,
    query_hybrid_p95_ms: queryDurations.length > 0 ? roundMetric(percentile(queryDurations, 95)) : null,
    stale_hit_rate_avg:
      staleRates.length > 0
        ? roundMetric(staleRates.reduce((sum, value) => sum + value, 0) / staleRates.length, 4)
        : null,
    degrade_rate:
      hybridEvents.length > 0 ? roundMetric(degradedCount / hybridEvents.length, 4) : null,
    sample_sizes: {
      query_duration_samples: queryDurations.length,
      stale_rate_samples: staleRates.length,
      degradation_samples: hybridEvents.length
    }
  };
}

function computeWatchKpis(watchFlushEvents) {
  const lagValues = [];
  for (const event of watchFlushEvents) {
    const lag = Number(event?.index_lag_ms);
    if (Number.isFinite(lag) && lag >= 0) {
      lagValues.push(lag);
    }
  }
  return {
    watch_flush_count: watchFlushEvents.length,
    code_index_lag_p95_ms: lagValues.length > 0 ? roundMetric(percentile(lagValues, 95)) : null,
    sample_sizes: {
      index_lag_samples: lagValues.length
    }
  };
}

function formatMetricValue(value, unit = "") {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "number") {
    return unit ? `${value}${unit}` : String(value);
  }
  return String(value);
}

function printTextReport(report) {
  console.log("Metrics Report");
  console.log(`- workspace: ${report.workspace_root}`);
  console.log(`- window: last ${report.window_hours}h`);
  console.log(`- generated_at: ${report.generated_at}`);
  console.log(
    `- files: hybrid=${report.inputs.hybrid_file.exists ? "present" : "missing"}, watch_flush=${report.inputs.watch_flush_file.exists ? "present" : "missing"}`
  );
  console.log("");
  console.log("Core KPI");
  console.log(`- code_index_lag_p95_ms: ${formatMetricValue(report.kpi.code_index_lag_p95_ms, "ms")}`);
  console.log(`- stale_hit_rate_avg: ${formatMetricValue(report.kpi.stale_hit_rate_avg)}`);
  console.log(`- query_hybrid_p95_ms: ${formatMetricValue(report.kpi.query_hybrid_p95_ms, "ms")}`);
  console.log(`- degrade_rate: ${formatMetricValue(report.kpi.degrade_rate)}`);
  console.log("");
  console.log("Sample Sizes");
  console.log(`- hybrid_events: ${report.sample_sizes.hybrid_events}`);
  console.log(`- watch_flush_events: ${report.sample_sizes.watch_flush_events}`);
  console.log(`- query_duration_samples: ${report.sample_sizes.query_duration_samples}`);
  console.log(`- stale_rate_samples: ${report.sample_sizes.stale_rate_samples}`);
  console.log(`- index_lag_samples: ${report.sample_sizes.index_lag_samples}`);
}

async function buildReport(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const metricsDir = path.join(workspaceRoot, METRICS_DIR_RELATIVE);
  const hybridFilePath = path.join(metricsDir, DEFAULT_HYBRID_FILE);
  const watchFlushFilePath = path.join(metricsDir, DEFAULT_WATCH_FLUSH_FILE);

  const nowMs = Date.now();
  const windowStartMs = nowMs - options.windowHours * 60 * 60 * 1000;

  const [hybridRows, watchFlushRows] = await Promise.all([
    readJsonl(hybridFilePath),
    readJsonl(watchFlushFilePath)
  ]);

  const hybridEvents = filterByWindow(
    hybridRows.filter((row) => row?.event_type === "hybrid_query"),
    windowStartMs
  );
  const watchFlushEvents = filterByWindow(
    watchFlushRows.filter((row) => row?.event_type === "watch_flush"),
    windowStartMs
  );

  const hybridKpis = computeHybridKpis(hybridEvents);
  const watchKpis = computeWatchKpis(watchFlushEvents);

  return {
    generated_at: new Date(nowMs).toISOString(),
    workspace_root: workspaceRoot,
    window_hours: options.windowHours,
    window_start: new Date(windowStartMs).toISOString(),
    inputs: {
      hybrid_file: {
        path: path.relative(workspaceRoot, hybridFilePath),
        exists: hybridRows.length > 0
      },
      watch_flush_file: {
        path: path.relative(workspaceRoot, watchFlushFilePath),
        exists: watchFlushRows.length > 0
      }
    },
    kpi: {
      code_index_lag_p95_ms: watchKpis.code_index_lag_p95_ms,
      stale_hit_rate_avg: hybridKpis.stale_hit_rate_avg,
      query_hybrid_p95_ms: hybridKpis.query_hybrid_p95_ms,
      degrade_rate: hybridKpis.degrade_rate
    },
    sample_sizes: {
      hybrid_events: hybridKpis.query_hybrid_count,
      watch_flush_events: watchKpis.watch_flush_count,
      query_duration_samples: hybridKpis.sample_sizes.query_duration_samples,
      stale_rate_samples: hybridKpis.sample_sizes.stale_rate_samples,
      index_lag_samples: watchKpis.sample_sizes.index_lag_samples
    }
  };
}

export { buildReport };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport(options);
  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTextReport(report);
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(`metrics-report failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
