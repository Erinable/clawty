import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { runTool } from "../../src/tools.js";
import { EmbeddingError } from "../../src/embedding-client.js";

const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_BASELINE_PATH = path.resolve(
  process.cwd(),
  "tests/bench/hybrid-embedding.baseline.json"
);
const FIXTURE_ROOT = path.resolve(process.cwd(), "tests/fixtures/hybrid-cases");
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

async function createWorkspace(prefix = "clawty-hybrid-bench-") {
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

function createEmbeddingConfig(mode) {
  if (mode === "ok") {
    return {
      enabled: true,
      model: "mock-embedding-bench",
      topK: 10,
      weight: 0.95,
      client: async ({ input }) =>
        input.map((text, idx) => {
          if (idx === 0) {
            return [1, 0];
          }
          return String(text).includes("tests/hybrid-embed.spec.ts") ? [1, 0] : [0, 1];
        })
    };
  }
  if (mode === "timeout") {
    return {
      enabled: true,
      model: "mock-timeout-bench",
      topK: 10,
      weight: 0.5,
      client: async () => {
        throw new EmbeddingError("EMBEDDING_REQUEST_TIMEOUT", "benchmark timeout", {
          retryable: true
        });
      }
    };
  }
  return {
    enabled: false
  };
}

function createContext(workspaceRoot, embeddingMode = "disabled") {
  return {
    workspaceRoot,
    lsp: { enabled: false },
    metrics: { enabled: false },
    embedding: createEmbeddingConfig(embeddingMode)
  };
}

function summarizeTaskResult(caseDef, queryResult, queryMs) {
  const resultPaths = Array.isArray(queryResult?.seeds)
    ? queryResult.seeds.map((item) => item.path).filter((item) => typeof item === "string")
    : [];
  const rankByPath = new Map();
  for (let i = 0; i < resultPaths.length; i += 1) {
    rankByPath.set(resultPaths[i], i + 1);
  }

  const primaryPath = typeof caseDef.expected_primary_path === "string"
    ? caseDef.expected_primary_path
    : null;
  const primaryRank = primaryPath ? rankByPath.get(primaryPath) ?? null : null;
  const expectedStatus =
    typeof caseDef.expected_embedding_status === "string" ? caseDef.expected_embedding_status : null;
  const actualStatus = queryResult?.sources?.embedding?.status_code || null;
  const statusMatch = expectedStatus === null ? true : expectedStatus === actualStatus;
  const expectedDegraded =
    typeof caseDef.expected_degraded === "boolean" ? caseDef.expected_degraded : null;
  const actualDegraded = Boolean(queryResult?.degradation?.degraded);
  const degradedMatch = expectedDegraded === null ? true : expectedDegraded === actualDegraded;
  const taskSuccess = Boolean(primaryRank === 1 && statusMatch && degradedMatch);

  return {
    name: caseDef.name,
    query: caseDef?.args?.query || "",
    query_ms: roundMetric(queryMs),
    primary_path: primaryPath,
    primary_rank: primaryRank,
    top1: primaryRank === 1,
    top3: Boolean(primaryRank && primaryRank <= 3),
    expected_embedding_status: expectedStatus,
    actual_embedding_status: actualStatus,
    embedding_status_match: statusMatch,
    expected_degraded: expectedDegraded,
    actual_degraded: actualDegraded,
    degraded_match: degradedMatch,
    embedding_attempted: Boolean(queryResult?.sources?.embedding?.attempted),
    success: taskSuccess
  };
}

function aggregateMetrics(taskResults) {
  const taskCount = taskResults.length;
  const successCount = taskResults.filter((item) => item.success).length;
  const top1Count = taskResults.filter((item) => item.top1).length;
  const top3Count = taskResults.filter((item) => item.top3).length;
  const statusMatchCount = taskResults.filter((item) => item.embedding_status_match).length;
  const degradeMatchCount = taskResults.filter((item) => item.degraded_match).length;
  const attemptedCount = taskResults.filter((item) => item.embedding_attempted).length;
  const degradedCount = taskResults.filter((item) => item.actual_degraded).length;
  const mrrSum = taskResults.reduce((sum, item) => {
    if (!item.primary_rank) {
      return sum;
    }
    return sum + 1 / item.primary_rank;
  }, 0);
  const queryMsValues = taskResults.map((item) => item.query_ms);

  return {
    task_count: taskCount,
    task_success_rate: taskCount > 0 ? roundMetric(successCount / taskCount) : 0,
    primary_top1_rate: taskCount > 0 ? roundMetric(top1Count / taskCount) : 0,
    primary_top3_rate: taskCount > 0 ? roundMetric(top3Count / taskCount) : 0,
    embedding_status_match_rate: taskCount > 0 ? roundMetric(statusMatchCount / taskCount) : 0,
    degrade_match_rate: taskCount > 0 ? roundMetric(degradeMatchCount / taskCount) : 0,
    embedding_attempt_rate: taskCount > 0 ? roundMetric(attemptedCount / taskCount) : 0,
    observed_degrade_rate: taskCount > 0 ? roundMetric(degradedCount / taskCount) : 0,
    mean_reciprocal_rank: taskCount > 0 ? roundMetric(mrrSum / taskCount) : 0,
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
      throw new Error("Hybrid benchmark cases are empty");
    }

    const buildContext = createContext(workspaceRoot, "disabled");
    const buildStart = performance.now();
    const codeBuild = await runTool("build_code_index", {}, buildContext);
    if (!codeBuild?.ok) {
      throw new Error(`build_code_index failed: ${JSON.stringify(codeBuild)}`);
    }
    const syntaxBuild = await runTool("build_syntax_index", {}, buildContext);
    if (!syntaxBuild?.ok) {
      throw new Error(`build_syntax_index failed: ${JSON.stringify(syntaxBuild)}`);
    }
    const graphBuild = await runTool(
      "build_semantic_graph",
      {
        max_symbols: 50,
        include_definitions: false,
        include_references: false,
        include_syntax: true,
        precise_preferred: false
      },
      buildContext
    );
    if (!graphBuild?.ok) {
      throw new Error(`build_semantic_graph failed: ${JSON.stringify(graphBuild)}`);
    }
    const buildMs = performance.now() - buildStart;

    const taskResults = [];
    for (const caseDef of cases) {
      const queryContext = createContext(workspaceRoot, caseDef.embedding_mode || "disabled");
      const queryStart = performance.now();
      const queryResult = await runTool("query_hybrid_index", caseDef.args || {}, queryContext);
      const queryMs = performance.now() - queryStart;
      if (!queryResult?.ok) {
        throw new Error(`query_hybrid_index failed for ${caseDef.name}: ${JSON.stringify(queryResult)}`);
      }
      taskResults.push(summarizeTaskResult(caseDef, queryResult, queryMs));
    }

    return {
      generated_at: new Date().toISOString(),
      dataset: {
        case_count: cases.length,
        fixture_root: path.relative(process.cwd(), FIXTURE_ROOT)
      },
      build_ms: roundMetric(buildMs),
      metrics: aggregateMetrics(taskResults),
      tasks: taskResults
    };
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

function printBenchmark(benchmark) {
  console.log("Hybrid Embedding Benchmark");
  console.log(`- cases: ${benchmark.dataset.case_count}`);
  console.log(`- build: ${benchmark.build_ms.toFixed(3)}ms`);
  console.log(`- task success: ${(benchmark.metrics.task_success_rate * 100).toFixed(2)}%`);
  console.log(`- primary top1: ${(benchmark.metrics.primary_top1_rate * 100).toFixed(2)}%`);
  console.log(
    `- embedding status match: ${(benchmark.metrics.embedding_status_match_rate * 100).toFixed(2)}%`
  );
  console.log(`- degrade match: ${(benchmark.metrics.degrade_match_rate * 100).toFixed(2)}%`);
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
      embedding_status_match_rate: benchmark.metrics.embedding_status_match_rate,
      degrade_match_rate: benchmark.metrics.degrade_match_rate
    }
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readBaseline(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function compareWithBaseline(currentMetrics, baselineMetrics, thresholdPercent) {
  const keys = [
    "task_success_rate",
    "primary_top1_rate",
    "embedding_status_match_rate",
    "degrade_match_rate"
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
  console.log(`Hybrid benchmark gate: threshold ${thresholdPercent}%`);
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
    console.log(`Wrote hybrid baseline: ${path.relative(process.cwd(), options.baselinePath)}`);
  }

  if (options.checkBaseline) {
    const baseline = await readBaseline(options.baselinePath);
    const threshold = Number(baseline.threshold_percent || options.thresholdPercent);
    const comparison = compareWithBaseline(benchmark.metrics, baseline.metrics || {}, threshold);
    printComparison(comparison, threshold);
    if (!comparison.ok) {
      throw new Error("Hybrid embedding benchmark regression detected");
    }
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
