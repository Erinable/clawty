import path from "node:path";
import { buildReport } from "./metrics-report.mjs";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_THRESHOLDS = {
  codeIndexLagP95Ms: 2000,
  staleHitRateAvg: 0.05,
  queryHybridP95Ms: 2000,
  degradeRate: 0.1
};

const DEFAULT_MIN_SAMPLES = {
  hybridEvents: 1,
  watchFlushEvents: 1
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

function evaluateReport(report, options) {
  const failures = [];
  const sampleSizes = report?.sample_sizes || {};
  const hybridEvents = Number(sampleSizes.hybrid_events || 0);
  const watchFlushEvents = Number(sampleSizes.watch_flush_events || 0);

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
    )
  ];

  return {
    pass: failures.length === 0,
    failures,
    checks,
    sample_sizes: {
      hybrid_events: hybridEvents,
      watch_flush_events: watchFlushEvents
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
    `- thresholds: code_index_lag_p95_ms<=${thresholds.codeIndexLagP95Ms}, stale_hit_rate_avg<=${thresholds.staleHitRateAvg}, query_hybrid_p95_ms<=${thresholds.queryHybridP95Ms}, degrade_rate<=${thresholds.degradeRate}`
  );
  console.log(
    `- sample_sizes: hybrid_events=${evaluation.sample_sizes.hybrid_events}, watch_flush_events=${evaluation.sample_sizes.watch_flush_events}`
  );
  console.log("");

  for (const check of evaluation.checks) {
    if (check.missing) {
      console.log(`- [skip] ${check.name}: missing`);
      continue;
    }
    const status = check.ok ? "ok" : "fail";
    console.log(`- [${status}] ${check.name}: value=${roundMetric(check.value)} max=${check.max}`);
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
