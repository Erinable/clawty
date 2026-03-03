import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyEmbeddingStatus } from "./hybrid-degrade-runbook.mjs";
import {
  HYBRID_QUERY_EVENT_TYPE,
  HYBRID_QUERY_METRICS_FILE,
  MEMORY_SEARCH_EVENT_TYPE,
  MEMORY_SEARCH_METRICS_FILE,
  METRICS_SUBDIR,
  WATCH_FLUSH_EVENT_TYPE,
  WATCH_FLUSH_METRICS_FILE
} from "../src/metrics-event-types.js";

const DEFAULT_WINDOW_HOURS = 24;

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
  let embeddingAttemptCount = 0;
  let embeddingFailureCount = 0;
  const embeddingBucketCounts = {
    timeout: 0,
    network: 0,
    api: 0,
    unknown: 0
  };
  const embeddingUnmappedStatusCounts = new Map();

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

    if (event?.sources?.embedding?.attempted === true) {
      embeddingAttemptCount += 1;
      const classified = classifyEmbeddingStatus(event?.sources?.embedding?.status_code);
      if (classified.failure) {
        embeddingFailureCount += 1;
      }
      if (classified.kpi_bucket && Object.hasOwn(embeddingBucketCounts, classified.kpi_bucket)) {
        embeddingBucketCounts[classified.kpi_bucket] += 1;
      }
      if (classified.failure && !classified.mapped) {
        const statusCode = classified.status_code || "UNKNOWN_STATUS";
        embeddingUnmappedStatusCounts.set(
          statusCode,
          Number(embeddingUnmappedStatusCounts.get(statusCode) || 0) + 1
        );
      }
    }
  }

  const embeddingUnmappedStatusCodes = Array.from(embeddingUnmappedStatusCounts.entries())
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) {
        return countDiff;
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([statusCode]) => statusCode);
  const embeddingUnmappedStatusSampleCount = Array.from(
    embeddingUnmappedStatusCounts.values()
  ).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    query_hybrid_count: hybridEvents.length,
    query_hybrid_p95_ms: queryDurations.length > 0 ? roundMetric(percentile(queryDurations, 95)) : null,
    stale_hit_rate_avg:
      staleRates.length > 0
        ? roundMetric(staleRates.reduce((sum, value) => sum + value, 0) / staleRates.length, 4)
        : null,
    degrade_rate:
      hybridEvents.length > 0 ? roundMetric(degradedCount / hybridEvents.length, 4) : null,
    embedding_timeout_rate:
      embeddingAttemptCount > 0
        ? roundMetric(embeddingBucketCounts.timeout / embeddingAttemptCount, 4)
        : null,
    embedding_network_rate:
      embeddingAttemptCount > 0
        ? roundMetric(embeddingBucketCounts.network / embeddingAttemptCount, 4)
        : null,
    embedding_api_rate:
      embeddingAttemptCount > 0
        ? roundMetric(embeddingBucketCounts.api / embeddingAttemptCount, 4)
        : null,
    embedding_unknown_rate:
      embeddingAttemptCount > 0
        ? roundMetric(embeddingBucketCounts.unknown / embeddingAttemptCount, 4)
        : null,
    embedding_failure_rate:
      embeddingAttemptCount > 0
        ? roundMetric(embeddingFailureCount / embeddingAttemptCount, 4)
        : null,
    runbook: {
      embedding_unmapped_status_codes: embeddingUnmappedStatusCodes
    },
    sample_sizes: {
      query_duration_samples: queryDurations.length,
      stale_rate_samples: staleRates.length,
      degradation_samples: hybridEvents.length,
      embedding_attempt_samples: embeddingAttemptCount,
      embedding_failure_samples: embeddingFailureCount,
      embedding_timeout_samples: embeddingBucketCounts.timeout,
      embedding_network_samples: embeddingBucketCounts.network,
      embedding_api_samples: embeddingBucketCounts.api,
      embedding_unknown_samples: embeddingBucketCounts.unknown,
      embedding_unmapped_status_samples: embeddingUnmappedStatusSampleCount
    }
  };
}

function computeWatchKpis(watchFlushEvents) {
  const lagValues = [];
  const effectiveDebounceValues = [];
  let backpressureFlushCount = 0;
  for (const event of watchFlushEvents) {
    const lag = Number(event?.index_lag_ms);
    if (Number.isFinite(lag) && lag >= 0) {
      lagValues.push(lag);
    }
    const effectiveDebounce = Number(event?.effective_debounce_ms);
    if (Number.isFinite(effectiveDebounce) && effectiveDebounce >= 0) {
      effectiveDebounceValues.push(effectiveDebounce);
    }
    if (event?.backpressure_active === true) {
      backpressureFlushCount += 1;
    }
  }
  return {
    watch_flush_count: watchFlushEvents.length,
    code_index_lag_p95_ms: lagValues.length > 0 ? roundMetric(percentile(lagValues, 95)) : null,
    watch_backpressure_flush_rate:
      watchFlushEvents.length > 0
        ? roundMetric(backpressureFlushCount / watchFlushEvents.length, 4)
        : null,
    watch_effective_debounce_avg_ms:
      effectiveDebounceValues.length > 0
        ? roundMetric(
            effectiveDebounceValues.reduce((sum, value) => sum + value, 0) /
              effectiveDebounceValues.length
          )
        : null,
    watch_effective_debounce_p95_ms:
      effectiveDebounceValues.length > 0
        ? roundMetric(percentile(effectiveDebounceValues, 95))
        : null,
    sample_sizes: {
      index_lag_samples: lagValues.length,
      backpressure_flush_samples: backpressureFlushCount,
      effective_debounce_samples: effectiveDebounceValues.length
    }
  };
}

function computeMemoryKpis(memoryEvents) {
  const queryDurations = [];
  let hitCount = 0;
  let fallbackCount = 0;

  for (const event of memoryEvents) {
    const queryMs = Number(event?.query_total_ms);
    if (Number.isFinite(queryMs) && queryMs >= 0) {
      queryDurations.push(queryMs);
    }

    const returnedCount = Number(event?.returned_count);
    if (Number.isFinite(returnedCount) && returnedCount > 0) {
      hitCount += 1;
    }

    if (event?.fallback_used === true) {
      fallbackCount += 1;
    }
  }

  return {
    memory_query_count: memoryEvents.length,
    memory_query_p95_ms: queryDurations.length > 0 ? roundMetric(percentile(queryDurations, 95)) : null,
    memory_hit_rate:
      memoryEvents.length > 0 ? roundMetric(hitCount / memoryEvents.length, 4) : null,
    memory_fallback_rate:
      memoryEvents.length > 0 ? roundMetric(fallbackCount / memoryEvents.length, 4) : null,
    sample_sizes: {
      memory_query_duration_samples: queryDurations.length,
      memory_hit_samples: memoryEvents.length
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
    `- files: hybrid=${report.inputs.hybrid_file.exists ? "present" : "missing"}, watch_flush=${report.inputs.watch_flush_file.exists ? "present" : "missing"}, memory=${report.inputs.memory_file.exists ? "present" : "missing"}`
  );
  console.log("");
  console.log("Core KPI");
  console.log(`- code_index_lag_p95_ms: ${formatMetricValue(report.kpi.code_index_lag_p95_ms, "ms")}`);
  console.log(
    `- watch_backpressure_flush_rate: ${formatMetricValue(report.kpi.watch_backpressure_flush_rate)}`
  );
  console.log(
    `- watch_effective_debounce_avg_ms: ${formatMetricValue(
      report.kpi.watch_effective_debounce_avg_ms,
      "ms"
    )}`
  );
  console.log(
    `- watch_effective_debounce_p95_ms: ${formatMetricValue(
      report.kpi.watch_effective_debounce_p95_ms,
      "ms"
    )}`
  );
  console.log(`- stale_hit_rate_avg: ${formatMetricValue(report.kpi.stale_hit_rate_avg)}`);
  console.log(`- query_hybrid_p95_ms: ${formatMetricValue(report.kpi.query_hybrid_p95_ms, "ms")}`);
  console.log(`- degrade_rate: ${formatMetricValue(report.kpi.degrade_rate)}`);
  console.log(`- embedding_timeout_rate: ${formatMetricValue(report.kpi.embedding_timeout_rate)}`);
  console.log(`- embedding_network_rate: ${formatMetricValue(report.kpi.embedding_network_rate)}`);
  console.log(`- embedding_api_rate: ${formatMetricValue(report.kpi.embedding_api_rate)}`);
  console.log(`- embedding_unknown_rate: ${formatMetricValue(report.kpi.embedding_unknown_rate)}`);
  console.log(`- memory_query_p95_ms: ${formatMetricValue(report.kpi.memory_query_p95_ms, "ms")}`);
  console.log(`- memory_hit_rate: ${formatMetricValue(report.kpi.memory_hit_rate)}`);
  console.log(`- memory_fallback_rate: ${formatMetricValue(report.kpi.memory_fallback_rate)}`);
  console.log("");
  console.log("Sample Sizes");
  console.log(`- hybrid_events: ${report.sample_sizes.hybrid_events}`);
  console.log(`- watch_flush_events: ${report.sample_sizes.watch_flush_events}`);
  console.log(`- memory_events: ${report.sample_sizes.memory_events}`);
  console.log(`- query_duration_samples: ${report.sample_sizes.query_duration_samples}`);
  console.log(`- stale_rate_samples: ${report.sample_sizes.stale_rate_samples}`);
  console.log(`- embedding_attempt_samples: ${report.sample_sizes.embedding_attempt_samples}`);
  console.log(`- embedding_failure_samples: ${report.sample_sizes.embedding_failure_samples}`);
  console.log(`- embedding_timeout_samples: ${report.sample_sizes.embedding_timeout_samples}`);
  console.log(`- embedding_network_samples: ${report.sample_sizes.embedding_network_samples}`);
  console.log(`- embedding_api_samples: ${report.sample_sizes.embedding_api_samples}`);
  console.log(`- embedding_unknown_samples: ${report.sample_sizes.embedding_unknown_samples}`);
  console.log(
    `- embedding_unmapped_status_samples: ${report.sample_sizes.embedding_unmapped_status_samples}`
  );
  console.log(`- index_lag_samples: ${report.sample_sizes.index_lag_samples}`);
  console.log(`- backpressure_flush_samples: ${report.sample_sizes.backpressure_flush_samples}`);
  console.log(`- effective_debounce_samples: ${report.sample_sizes.effective_debounce_samples}`);
  console.log(`- memory_query_duration_samples: ${report.sample_sizes.memory_query_duration_samples}`);
  if (Array.isArray(report.runbook.embedding_unmapped_status_codes)) {
    console.log(
      `- embedding_unmapped_status_codes: ${
        report.runbook.embedding_unmapped_status_codes.length > 0
          ? report.runbook.embedding_unmapped_status_codes.join(",")
          : "none"
      }`
    );
  }
}

async function buildReport(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const metricsDir = path.join(workspaceRoot, METRICS_SUBDIR);
  const hybridFilePath = path.join(metricsDir, HYBRID_QUERY_METRICS_FILE);
  const watchFlushFilePath = path.join(metricsDir, WATCH_FLUSH_METRICS_FILE);
  const memoryFilePath = path.join(metricsDir, MEMORY_SEARCH_METRICS_FILE);

  const nowMs = Date.now();
  const windowStartMs = nowMs - options.windowHours * 60 * 60 * 1000;

  const [hybridRows, watchFlushRows, memoryRows] = await Promise.all([
    readJsonl(hybridFilePath),
    readJsonl(watchFlushFilePath),
    readJsonl(memoryFilePath)
  ]);

  const hybridEvents = filterByWindow(
    hybridRows.filter((row) => row?.event_type === HYBRID_QUERY_EVENT_TYPE),
    windowStartMs
  );
  const watchFlushEvents = filterByWindow(
    watchFlushRows.filter((row) => row?.event_type === WATCH_FLUSH_EVENT_TYPE),
    windowStartMs
  );
  const memoryEvents = filterByWindow(
    memoryRows.filter((row) => row?.event_type === MEMORY_SEARCH_EVENT_TYPE),
    windowStartMs
  );

  const hybridKpis = computeHybridKpis(hybridEvents);
  const watchKpis = computeWatchKpis(watchFlushEvents);
  const memoryKpis = computeMemoryKpis(memoryEvents);

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
      },
      memory_file: {
        path: path.relative(workspaceRoot, memoryFilePath),
        exists: memoryRows.length > 0
      }
    },
    kpi: {
      code_index_lag_p95_ms: watchKpis.code_index_lag_p95_ms,
      watch_backpressure_flush_rate: watchKpis.watch_backpressure_flush_rate,
      watch_effective_debounce_avg_ms: watchKpis.watch_effective_debounce_avg_ms,
      watch_effective_debounce_p95_ms: watchKpis.watch_effective_debounce_p95_ms,
      stale_hit_rate_avg: hybridKpis.stale_hit_rate_avg,
      query_hybrid_p95_ms: hybridKpis.query_hybrid_p95_ms,
      degrade_rate: hybridKpis.degrade_rate,
      embedding_timeout_rate: hybridKpis.embedding_timeout_rate,
      embedding_network_rate: hybridKpis.embedding_network_rate,
      embedding_api_rate: hybridKpis.embedding_api_rate,
      embedding_unknown_rate: hybridKpis.embedding_unknown_rate,
      embedding_failure_rate: hybridKpis.embedding_failure_rate,
      memory_query_p95_ms: memoryKpis.memory_query_p95_ms,
      memory_hit_rate: memoryKpis.memory_hit_rate,
      memory_fallback_rate: memoryKpis.memory_fallback_rate
    },
    runbook: {
      embedding_unmapped_status_codes: hybridKpis.runbook.embedding_unmapped_status_codes
    },
    sample_sizes: {
      hybrid_events: hybridKpis.query_hybrid_count,
      watch_flush_events: watchKpis.watch_flush_count,
      memory_events: memoryKpis.memory_query_count,
      query_duration_samples: hybridKpis.sample_sizes.query_duration_samples,
      stale_rate_samples: hybridKpis.sample_sizes.stale_rate_samples,
      embedding_attempt_samples: hybridKpis.sample_sizes.embedding_attempt_samples,
      embedding_failure_samples: hybridKpis.sample_sizes.embedding_failure_samples,
      embedding_timeout_samples: hybridKpis.sample_sizes.embedding_timeout_samples,
      embedding_network_samples: hybridKpis.sample_sizes.embedding_network_samples,
      embedding_api_samples: hybridKpis.sample_sizes.embedding_api_samples,
      embedding_unknown_samples: hybridKpis.sample_sizes.embedding_unknown_samples,
      embedding_unmapped_status_samples:
        hybridKpis.sample_sizes.embedding_unmapped_status_samples,
      index_lag_samples: watchKpis.sample_sizes.index_lag_samples,
      backpressure_flush_samples: watchKpis.sample_sizes.backpressure_flush_samples,
      effective_debounce_samples: watchKpis.sample_sizes.effective_debounce_samples,
      memory_query_duration_samples: memoryKpis.sample_sizes.memory_query_duration_samples
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
