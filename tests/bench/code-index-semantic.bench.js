import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { buildCodeIndex, queryCodeIndex } from "../../src/code-index.js";

const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_BASELINE_PATH = path.resolve(
  process.cwd(),
  "tests/bench/code-index-semantic.baseline.json"
);
const FIXTURE_ROOT = path.resolve(process.cwd(), "tests/fixtures/semantic-cases");
const INPUT_ROOT = path.join(FIXTURE_ROOT, "input");
const EXPECTED_FILE = path.join(FIXTURE_ROOT, "expected.json");

function parseArgs(argv) {
  const options = {
    writeBaseline: false,
    checkBaseline: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT
  };

  for (const arg of argv) {
    if (arg === "--write-baseline") {
      options.writeBaseline = true;
      continue;
    }
    if (arg === "--check-baseline") {
      options.checkBaseline = true;
      continue;
    }
    if (arg.startsWith("--baseline=")) {
      options.baselinePath = path.resolve(process.cwd(), arg.slice("--baseline=".length));
      continue;
    }
    if (arg.startsWith("--threshold=")) {
      const value = Number(arg.slice("--threshold=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --threshold value: ${arg}`);
      }
      options.thresholdPercent = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function createWorkspace(prefix = "clawty-semantic-bench-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeWorkspace(workspaceRoot) {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}

async function copyDirContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function roundMetric(value) {
  return Number(value.toFixed(6));
}

function summarizeTaskResult(caseDef, queryResult, queryMs) {
  const expectedPaths = Array.isArray(caseDef.expected_paths)
    ? caseDef.expected_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const resultPaths = Array.isArray(queryResult?.results)
    ? queryResult.results.map((item) => item.path).filter((item) => typeof item === "string")
    : [];
  const rankByPath = new Map();
  for (let i = 0; i < resultPaths.length; i += 1) {
    rankByPath.set(resultPaths[i], i + 1);
  }

  const primaryPath = typeof caseDef.expected_primary_path === "string"
    ? caseDef.expected_primary_path
    : null;
  const primaryRank = primaryPath ? rankByPath.get(primaryPath) ?? null : null;
  const matchedPaths = expectedPaths.filter((item) => rankByPath.has(item));
  const expectedRecall =
    expectedPaths.length > 0 ? matchedPaths.length / expectedPaths.length : 0;
  const taskSuccess = Boolean(primaryRank && primaryRank <= 3 && expectedRecall >= 0.5);

  return {
    name: caseDef.name,
    query: caseDef.args?.query || "",
    query_ms: roundMetric(queryMs),
    primary_path: primaryPath,
    primary_rank: primaryRank,
    top1: primaryRank === 1,
    top3: Boolean(primaryRank && primaryRank <= 3),
    expected_paths: expectedPaths,
    matched_paths: matchedPaths,
    expected_recall_at_k: roundMetric(expectedRecall),
    success: taskSuccess
  };
}

function aggregateMetrics(taskResults) {
  const taskCount = taskResults.length;
  const successCount = taskResults.filter((item) => item.success).length;
  const top1Count = taskResults.filter((item) => item.top1).length;
  const top3Count = taskResults.filter((item) => item.top3).length;
  const mrrSum = taskResults.reduce((sum, item) => {
    if (!item.primary_rank) {
      return sum;
    }
    return sum + 1 / item.primary_rank;
  }, 0);
  const recallSum = taskResults.reduce((sum, item) => sum + item.expected_recall_at_k, 0);
  const queryMsValues = taskResults.map((item) => item.query_ms);

  return {
    task_count: taskCount,
    task_success_rate: taskCount > 0 ? roundMetric(successCount / taskCount) : 0,
    primary_top1_rate: taskCount > 0 ? roundMetric(top1Count / taskCount) : 0,
    primary_top3_rate: taskCount > 0 ? roundMetric(top3Count / taskCount) : 0,
    mean_reciprocal_rank: taskCount > 0 ? roundMetric(mrrSum / taskCount) : 0,
    evidence_recall_at_k: taskCount > 0 ? roundMetric(recallSum / taskCount) : 0,
    query_avg_ms: taskCount > 0 ? roundMetric(queryMsValues.reduce((a, b) => a + b, 0) / taskCount) : 0,
    query_p95_ms: roundMetric(percentile(queryMsValues, 95))
  };
}

async function runBenchmark() {
  const workspaceRoot = await createWorkspace();
  try {
    await copyDirContents(INPUT_ROOT, workspaceRoot);
    const expected = JSON.parse(await fs.readFile(EXPECTED_FILE, "utf8"));
    const cases = Array.isArray(expected.cases) ? expected.cases : [];
    if (cases.length === 0) {
      throw new Error("Semantic benchmark cases are empty");
    }

    const buildStart = performance.now();
    const buildResult = await buildCodeIndex(workspaceRoot, {});
    const buildMs = performance.now() - buildStart;
    if (!buildResult.ok) {
      throw new Error(`buildCodeIndex failed: ${JSON.stringify(buildResult)}`);
    }

    const taskResults = [];
    for (const caseDef of cases) {
      const queryStart = performance.now();
      const queryResult = await queryCodeIndex(workspaceRoot, caseDef.args || {});
      const queryMs = performance.now() - queryStart;
      if (!queryResult.ok) {
        throw new Error(`query failed for ${caseDef.name}: ${JSON.stringify(queryResult)}`);
      }
      taskResults.push(summarizeTaskResult(caseDef, queryResult, queryMs));
    }

    const metrics = aggregateMetrics(taskResults);
    return {
      generated_at: new Date().toISOString(),
      dataset: {
        case_count: cases.length,
        fixture_root: path.relative(process.cwd(), FIXTURE_ROOT)
      },
      build_ms: roundMetric(buildMs),
      metrics,
      tasks: taskResults
    };
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

function printBenchmark(benchmark) {
  console.log("Code Index Semantic Benchmark");
  console.log(`- cases: ${benchmark.dataset.case_count}`);
  console.log(`- build: ${benchmark.build_ms.toFixed(3)}ms`);
  console.log(`- task success: ${(benchmark.metrics.task_success_rate * 100).toFixed(2)}%`);
  console.log(`- primary top1: ${(benchmark.metrics.primary_top1_rate * 100).toFixed(2)}%`);
  console.log(`- primary top3: ${(benchmark.metrics.primary_top3_rate * 100).toFixed(2)}%`);
  console.log(`- MRR: ${benchmark.metrics.mean_reciprocal_rank.toFixed(4)}`);
  console.log(`- evidence recall@k: ${benchmark.metrics.evidence_recall_at_k.toFixed(4)}`);
  console.log(`- query avg: ${benchmark.metrics.query_avg_ms.toFixed(3)}ms`);
  console.log(`- query p95: ${benchmark.metrics.query_p95_ms.toFixed(3)}ms`);
}

async function writeBaseline(filePath, benchmark, thresholdPercent) {
  const payload = {
    generated_at: new Date().toISOString(),
    threshold_percent: thresholdPercent,
    metrics: {
      task_success_rate: benchmark.metrics.task_success_rate,
      primary_top1_rate: benchmark.metrics.primary_top1_rate,
      primary_top3_rate: benchmark.metrics.primary_top3_rate,
      mean_reciprocal_rank: benchmark.metrics.mean_reciprocal_rank,
      evidence_recall_at_k: benchmark.metrics.evidence_recall_at_k
    }
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readBaseline(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  return data;
}

function compareWithBaseline(currentMetrics, baselineMetrics, thresholdPercent) {
  const keys = [
    "task_success_rate",
    "primary_top1_rate",
    "primary_top3_rate",
    "mean_reciprocal_rank",
    "evidence_recall_at_k"
  ];
  const results = [];

  for (const key of keys) {
    const current = Number(currentMetrics[key]);
    const baseline = Number(baselineMetrics[key]);
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) {
      results.push({
        key,
        ok: false,
        reason: "invalid metric"
      });
      continue;
    }
    const allowedMin = baseline * (1 - thresholdPercent / 100);
    const ok = current >= allowedMin;
    results.push({
      key,
      ok,
      current,
      baseline,
      allowed_min: allowedMin
    });
  }

  return {
    ok: results.every((item) => item.ok),
    results
  };
}

function printComparison(comparison, thresholdPercent) {
  console.log(`Semantic quality gate: threshold ${thresholdPercent}%`);
  for (const item of comparison.results) {
    if (!item.current && item.reason) {
      console.log(`- REGRESSION ${item.key}: ${item.reason}`);
      continue;
    }

    const delta = item.baseline === 0
      ? "n/a"
      : `${(((item.current - item.baseline) / item.baseline) * 100).toFixed(2)}%`;
    const label = item.ok ? "OK" : "REGRESSION";
    console.log(
      `- ${label} ${item.key}: current=${item.current.toFixed(6)}, baseline=${item.baseline.toFixed(6)}, allowed>=${item.allowed_min.toFixed(6)} (${delta})`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const benchmark = await runBenchmark();
  printBenchmark(benchmark);

  if (options.writeBaseline) {
    await writeBaseline(options.baselinePath, benchmark, options.thresholdPercent);
    console.log(`Wrote semantic baseline: ${path.relative(process.cwd(), options.baselinePath)}`);
  }

  if (options.checkBaseline) {
    const baseline = await readBaseline(options.baselinePath);
    const threshold = Number(baseline.threshold_percent || options.thresholdPercent);
    const comparison = compareWithBaseline(benchmark.metrics, baseline.metrics || {}, threshold);
    printComparison(comparison, threshold);
    if (!comparison.ok) {
      throw new Error("Code index semantic benchmark regression detected");
    }
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
