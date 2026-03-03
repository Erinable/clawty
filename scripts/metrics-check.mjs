import path from "node:path";
import { buildReport } from "./metrics-report.mjs";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_THRESHOLDS = {
  codeIndexLagP95Ms: 2000,
  watchBackpressureFlushRate: null,
  watchEffectiveDebounceP95Ms: null,
  watchDbRetryExhaustedRate: null,
  watchSlowFlushRate: null,
  staleHitRateAvg: 0.05,
  queryHybridP95Ms: 2000,
  degradeRate: 0.1,
  embeddingTimeoutRate: null,
  embeddingNetworkRate: null,
  memoryQueryP95Ms: null,
  minMemoryHitRate: null,
  maxMemoryFallbackRate: null
};

const DEFAULT_MIN_SAMPLES = {
  hybridEvents: 1,
  watchFlushEvents: 1,
  memoryEvents: 0,
  embeddingAttempts: 0
};

function parsePositiveNumber(raw, argName, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${argName} argument`);
  }
  return value;
}

function parseNonNegativeInt(raw, argName, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`Invalid ${argName} argument`);
  }
  return Math.floor(value);
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    windowHours: DEFAULT_WINDOW_HOURS,
    format: "text",
    allowMissing: false,
    runbookEnforce: false,
    thresholds: { ...DEFAULT_THRESHOLDS },
    minSamples: { ...DEFAULT_MIN_SAMPLES }
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
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    if (arg === "--runbook-enforce") {
      options.runbookEnforce = true;
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
      options.windowHours = parsePositiveNumber(
        arg.slice("--window-hours=".length),
        "--window-hours",
        0.001,
        24 * 30
      );
      continue;
    }
    if (arg.startsWith("--max-code-index-lag-ms=")) {
      options.thresholds.codeIndexLagP95Ms = parsePositiveNumber(
        arg.slice("--max-code-index-lag-ms=".length),
        "--max-code-index-lag-ms",
        1,
        86_400_000
      );
      continue;
    }
    if (arg.startsWith("--max-watch-backpressure-flush-rate=")) {
      options.thresholds.watchBackpressureFlushRate = parsePositiveNumber(
        arg.slice("--max-watch-backpressure-flush-rate=".length),
        "--max-watch-backpressure-flush-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-watch-effective-debounce-p95-ms=")) {
      options.thresholds.watchEffectiveDebounceP95Ms = parsePositiveNumber(
        arg.slice("--max-watch-effective-debounce-p95-ms=".length),
        "--max-watch-effective-debounce-p95-ms",
        1,
        86_400_000
      );
      continue;
    }
    if (arg.startsWith("--max-watch-db-retry-exhausted-rate=")) {
      options.thresholds.watchDbRetryExhaustedRate = parsePositiveNumber(
        arg.slice("--max-watch-db-retry-exhausted-rate=".length),
        "--max-watch-db-retry-exhausted-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-watch-slow-flush-rate=")) {
      options.thresholds.watchSlowFlushRate = parsePositiveNumber(
        arg.slice("--max-watch-slow-flush-rate=".length),
        "--max-watch-slow-flush-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-stale-hit-rate=")) {
      options.thresholds.staleHitRateAvg = parsePositiveNumber(
        arg.slice("--max-stale-hit-rate=".length),
        "--max-stale-hit-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-query-hybrid-p95-ms=")) {
      options.thresholds.queryHybridP95Ms = parsePositiveNumber(
        arg.slice("--max-query-hybrid-p95-ms=".length),
        "--max-query-hybrid-p95-ms",
        1,
        86_400_000
      );
      continue;
    }
    if (arg.startsWith("--max-degrade-rate=")) {
      options.thresholds.degradeRate = parsePositiveNumber(
        arg.slice("--max-degrade-rate=".length),
        "--max-degrade-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-memory-query-p95-ms=")) {
      options.thresholds.memoryQueryP95Ms = parsePositiveNumber(
        arg.slice("--max-memory-query-p95-ms=".length),
        "--max-memory-query-p95-ms",
        1,
        86_400_000
      );
      continue;
    }
    if (arg.startsWith("--max-embedding-timeout-rate=")) {
      options.thresholds.embeddingTimeoutRate = parsePositiveNumber(
        arg.slice("--max-embedding-timeout-rate=".length),
        "--max-embedding-timeout-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-embedding-network-rate=")) {
      options.thresholds.embeddingNetworkRate = parsePositiveNumber(
        arg.slice("--max-embedding-network-rate=".length),
        "--max-embedding-network-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--min-memory-hit-rate=")) {
      options.thresholds.minMemoryHitRate = parsePositiveNumber(
        arg.slice("--min-memory-hit-rate=".length),
        "--min-memory-hit-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--max-memory-fallback-rate=")) {
      options.thresholds.maxMemoryFallbackRate = parsePositiveNumber(
        arg.slice("--max-memory-fallback-rate=".length),
        "--max-memory-fallback-rate",
        0,
        1
      );
      continue;
    }
    if (arg.startsWith("--min-hybrid-events=")) {
      options.minSamples.hybridEvents = parseNonNegativeInt(
        arg.slice("--min-hybrid-events=".length),
        "--min-hybrid-events"
      );
      continue;
    }
    if (arg.startsWith("--min-watch-flush-events=")) {
      options.minSamples.watchFlushEvents = parseNonNegativeInt(
        arg.slice("--min-watch-flush-events=".length),
        "--min-watch-flush-events"
      );
      continue;
    }
    if (arg.startsWith("--min-memory-events=")) {
      options.minSamples.memoryEvents = parseNonNegativeInt(
        arg.slice("--min-memory-events=".length),
        "--min-memory-events"
      );
      continue;
    }
    if (arg.startsWith("--min-embedding-attempts=")) {
      options.minSamples.embeddingAttempts = parseNonNegativeInt(
        arg.slice("--min-embedding-attempts=".length),
        "--min-embedding-attempts"
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function roundMetric(value, digits = 4) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

function evaluateMaxMetric(name, value, max, allowMissing, failures) {
  if (max === null || max === undefined) {
    return { name, ok: true, value: value ?? null, max: null, missing: value == null, skipped: true };
  }
  if (value === null || value === undefined) {
    if (!allowMissing) {
      failures.push(`${name} is missing`);
      return { name, ok: false, value: null, max, missing: true };
    }
    return { name, ok: true, value: null, max, missing: true };
  }
  if (value > max) {
    failures.push(`${name}=${value} exceeds max=${max}`);
    return { name, ok: false, value, max, missing: false };
  }
  return { name, ok: true, value, max, missing: false };
}

function evaluateMinMetric(name, value, min, allowMissing, failures) {
  if (min === null || min === undefined) {
    return { name, ok: true, value: value ?? null, min: null, missing: value == null, skipped: true };
  }
  if (value === null || value === undefined) {
    if (!allowMissing) {
      failures.push(`${name} is missing`);
      return { name, ok: false, value: null, min, missing: true };
    }
    return { name, ok: true, value: null, min, missing: true };
  }
  if (value < min) {
    failures.push(`${name}=${value} below min=${min}`);
    return { name, ok: false, value, min, missing: false };
  }
  return { name, ok: true, value, min, missing: false };
}

function evaluateReport(report, options) {
  const failures = [];
  const sampleSizes = report?.sample_sizes || {};
  const hybridEvents = Number(sampleSizes.hybrid_events || 0);
  const watchFlushEvents = Number(sampleSizes.watch_flush_events || 0);
  const memoryEvents = Number(sampleSizes.memory_events || 0);
  const embeddingAttempts = Number(sampleSizes.embedding_attempt_samples || 0);
  const embeddingUnmappedStatusSamples = Number(
    sampleSizes.embedding_unmapped_status_samples || 0
  );
  const embeddingUnmappedStatusCodes = Array.isArray(
    report?.runbook?.embedding_unmapped_status_codes
  )
    ? report.runbook.embedding_unmapped_status_codes
    : [];

  if (!(options.allowMissing && hybridEvents === 0)) {
    if (hybridEvents < options.minSamples.hybridEvents) {
      failures.push(
        `hybrid_events=${hybridEvents} below min_hybrid_events=${options.minSamples.hybridEvents}`
      );
    }
  }
  if (!(options.allowMissing && watchFlushEvents === 0)) {
    if (watchFlushEvents < options.minSamples.watchFlushEvents) {
      failures.push(
        `watch_flush_events=${watchFlushEvents} below min_watch_flush_events=${options.minSamples.watchFlushEvents}`
      );
    }
  }
  if (!(options.allowMissing && memoryEvents === 0)) {
    if (memoryEvents < options.minSamples.memoryEvents) {
      failures.push(
        `memory_events=${memoryEvents} below min_memory_events=${options.minSamples.memoryEvents}`
      );
    }
  }
  if (!(options.allowMissing && embeddingAttempts === 0)) {
    if (embeddingAttempts < options.minSamples.embeddingAttempts) {
      failures.push(
        `embedding_attempt_samples=${embeddingAttempts} below min_embedding_attempts=${options.minSamples.embeddingAttempts}`
      );
    }
  }

  const checks = [
    evaluateMaxMetric(
      "code_index_lag_p95_ms",
      report?.kpi?.code_index_lag_p95_ms,
      options.thresholds.codeIndexLagP95Ms,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "stale_hit_rate_avg",
      report?.kpi?.stale_hit_rate_avg,
      options.thresholds.staleHitRateAvg,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "watch_backpressure_flush_rate",
      report?.kpi?.watch_backpressure_flush_rate,
      options.thresholds.watchBackpressureFlushRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "watch_effective_debounce_p95_ms",
      report?.kpi?.watch_effective_debounce_p95_ms,
      options.thresholds.watchEffectiveDebounceP95Ms,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "watch_db_retry_exhausted_rate",
      report?.kpi?.watch_db_retry_exhausted_rate,
      options.thresholds.watchDbRetryExhaustedRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "watch_slow_flush_rate",
      report?.kpi?.watch_slow_flush_rate,
      options.thresholds.watchSlowFlushRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "query_hybrid_p95_ms",
      report?.kpi?.query_hybrid_p95_ms,
      options.thresholds.queryHybridP95Ms,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "degrade_rate",
      report?.kpi?.degrade_rate,
      options.thresholds.degradeRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "embedding_timeout_rate",
      report?.kpi?.embedding_timeout_rate,
      options.thresholds.embeddingTimeoutRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "embedding_network_rate",
      report?.kpi?.embedding_network_rate,
      options.thresholds.embeddingNetworkRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "memory_query_p95_ms",
      report?.kpi?.memory_query_p95_ms,
      options.thresholds.memoryQueryP95Ms,
      options.allowMissing,
      failures
    ),
    evaluateMinMetric(
      "memory_hit_rate",
      report?.kpi?.memory_hit_rate,
      options.thresholds.minMemoryHitRate,
      options.allowMissing,
      failures
    ),
    evaluateMaxMetric(
      "memory_fallback_rate",
      report?.kpi?.memory_fallback_rate,
      options.thresholds.maxMemoryFallbackRate,
      options.allowMissing,
      failures
    )
  ];

  if (options.runbookEnforce && embeddingUnmappedStatusSamples > 0) {
    failures.push(
      `runbook enforcement failed: unmapped embedding status codes detected (${embeddingUnmappedStatusCodes.join(", ")})`
    );
  }

  return {
    pass: failures.length === 0,
    failures,
    checks,
    sample_sizes: {
      hybrid_events: hybridEvents,
      watch_flush_events: watchFlushEvents,
      memory_events: memoryEvents,
      embedding_attempt_samples: embeddingAttempts,
      embedding_unmapped_status_samples: embeddingUnmappedStatusSamples
    },
    runbook: {
      enforced: Boolean(options.runbookEnforce),
      embedding_unmapped_status_samples: embeddingUnmappedStatusSamples,
      embedding_unmapped_status_codes: embeddingUnmappedStatusCodes
    }
  };
}

function printTextResult(payload) {
  const report = payload.report;
  const evaluation = payload.evaluation;
  const thresholds = payload.thresholds;

  console.log("Metrics Check");
  console.log(`- workspace: ${report.workspace_root}`);
  console.log(`- window: last ${report.window_hours}h`);
  console.log(`- generated_at: ${report.generated_at}`);
  console.log(
    `- thresholds: code_index_lag_p95_ms<=${thresholds.codeIndexLagP95Ms}, watch_backpressure_flush_rate<=${thresholds.watchBackpressureFlushRate ?? "off"}, watch_effective_debounce_p95_ms<=${thresholds.watchEffectiveDebounceP95Ms ?? "off"}, stale_hit_rate_avg<=${thresholds.staleHitRateAvg}, query_hybrid_p95_ms<=${thresholds.queryHybridP95Ms}, degrade_rate<=${thresholds.degradeRate}, embedding_timeout_rate<=${thresholds.embeddingTimeoutRate ?? "off"}, embedding_network_rate<=${thresholds.embeddingNetworkRate ?? "off"}, memory_query_p95_ms<=${thresholds.memoryQueryP95Ms ?? "off"}, memory_hit_rate>=${thresholds.minMemoryHitRate ?? "off"}, memory_fallback_rate<=${thresholds.maxMemoryFallbackRate ?? "off"}`
  );
  console.log(
    `- sample_sizes: hybrid_events=${evaluation.sample_sizes.hybrid_events}, watch_flush_events=${evaluation.sample_sizes.watch_flush_events}, memory_events=${evaluation.sample_sizes.memory_events}, embedding_attempt_samples=${evaluation.sample_sizes.embedding_attempt_samples}`
  );
  console.log(`- runbook_enforce: ${evaluation.runbook.enforced}`);
  if (evaluation.runbook.enforced) {
    console.log(
      `- runbook_unmapped_status_samples: ${evaluation.runbook.embedding_unmapped_status_samples}`
    );
  }
  console.log("");

  for (const check of evaluation.checks) {
    if (check.skipped) {
      console.log(`- [skip] ${check.name}: threshold disabled`);
      continue;
    }
    if (check.missing) {
      console.log(`- [skip] ${check.name}: missing`);
      continue;
    }
    const status = check.ok ? "ok" : "fail";
    if (check.max !== undefined) {
      console.log(`- [${status}] ${check.name}: value=${roundMetric(check.value)} max=${check.max}`);
      continue;
    }
    console.log(`- [${status}] ${check.name}: value=${roundMetric(check.value)} min=${check.min}`);
  }

  if (!evaluation.pass) {
    console.error("");
    console.error("Metrics gate failed:");
    for (const failure of evaluation.failures) {
      console.error(`- ${failure}`);
    }
    return;
  }
  console.log("");
  console.log("Metrics gate passed.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport({
    workspaceRoot: options.workspaceRoot,
    windowHours: options.windowHours,
    format: "json"
  });
  const evaluation = evaluateReport(report, options);
  const payload = {
    generated_at: new Date().toISOString(),
    report,
    thresholds: options.thresholds,
    min_samples: options.minSamples,
    allow_missing: options.allowMissing,
    runbook_enforce: options.runbookEnforce,
    evaluation
  };

  if (options.format === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printTextResult(payload);
  }

  if (!evaluation.pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`metrics-check failed: ${error.message || String(error)}`);
  process.exitCode = 1;
});
