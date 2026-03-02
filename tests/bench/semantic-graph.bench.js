import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { buildCodeIndex } from "../../src/code-index.js";
import { buildSyntaxIndex } from "../../src/syntax-index.js";
import { buildSemanticGraph, querySemanticGraph } from "../../src/semantic-graph.js";

const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_BASELINE_PATH = path.resolve(
  process.cwd(),
  "tests/bench/semantic-graph.baseline.json"
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

async function createWorkspace(prefix = "clawty-semantic-graph-bench-") {
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

function collectRankedPaths(queryResult) {
  const ranked = [];
  const seen = new Set();

  const pushPath = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return;
    }
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    ranked.push(candidate);
  };

  for (const seed of queryResult?.seeds || []) {
    pushPath(seed?.path);

    for (const neighbor of seed?.outgoing || []) {
      pushPath(neighbor?.node?.path);
    }
    for (const neighbor of seed?.incoming || []) {
      pushPath(neighbor?.node?.path);
    }

    for (const item of seed?.multi_hop?.outgoing || []) {
      pushPath(item?.node?.path);
    }
    for (const item of seed?.multi_hop?.incoming || []) {
      pushPath(item?.node?.path);
    }
  }

  return ranked;
}

function tokenizeQuery(rawQuery) {
  if (typeof rawQuery !== "string") {
    return [];
  }
  const tokens = rawQuery
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
  const unique = [];
  for (const token of tokens) {
    if (!unique.includes(token)) {
      unique.push(token);
    }
  }
  return unique.slice(0, 8);
}

function mergeRankedPaths(rankedPathRuns) {
  const merged = new Map();
  for (let runIndex = 0; runIndex < rankedPathRuns.length; runIndex += 1) {
    const run = rankedPathRuns[runIndex];
    for (let rank = 0; rank < run.paths.length; rank += 1) {
      const candidatePath = run.paths[rank];
      const score = rank + 1 + runIndex * 0.2;
      const existing = merged.get(candidatePath);
      if (typeof existing !== "number" || score < existing) {
        merged.set(candidatePath, score);
      }
    }
  }
  return Array.from(merged.entries())
    .sort((a, b) => a[1] - b[1])
    .map((entry) => entry[0]);
}

async function runCaseSemanticQuery(workspaceRoot, caseDef) {
  const rawQuery = typeof caseDef.args?.query === "string" ? caseDef.args.query.trim() : "";
  const candidates = [];
  if (rawQuery) {
    candidates.push(rawQuery);
  }
  for (const token of tokenizeQuery(rawQuery)) {
    if (!candidates.includes(token)) {
      candidates.push(token);
    }
  }

  const rankedPathRuns = [];
  const providers = new Set();
  let fallback = false;
  let queryMsTotal = 0;

  for (const candidate of candidates.slice(0, 6)) {
    const queryStart = performance.now();
    const queryResult = await querySemanticGraph(workspaceRoot, {
      query: candidate,
      top_k: Number(caseDef.args?.top_k || 5),
      max_neighbors: 8,
      max_hops: 2,
      per_hop_limit: 8
    });
    queryMsTotal += performance.now() - queryStart;

    if (!queryResult.ok) {
      continue;
    }
    providers.add(queryResult.provider || "semantic_graph");
    fallback = fallback || Boolean(queryResult.fallback);
    rankedPathRuns.push({
      query: candidate,
      paths: collectRankedPaths(queryResult)
    });

    if (candidate === rawQuery && Array.isArray(queryResult.seeds) && queryResult.seeds.length > 0) {
      // Full query already has strong signal; no need to fan out further.
      break;
    }
  }

  return {
    ranked_paths: mergeRankedPaths(rankedPathRuns),
    provider: providers.size > 0 ? Array.from(providers).join("+") : "semantic_graph",
    fallback,
    query_ms: queryMsTotal
  };
}

function summarizeTaskResult(caseDef, queryOutput) {
  const expectedPaths = Array.isArray(caseDef.expected_paths)
    ? caseDef.expected_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const resultPaths = Array.isArray(queryOutput?.ranked_paths) ? queryOutput.ranked_paths : [];
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
    query_ms: roundMetric(Number(queryOutput?.query_ms || 0)),
    provider: queryOutput?.provider || "semantic_graph",
    fallback: Boolean(queryOutput?.fallback),
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
  const fallbackCount = taskResults.filter((item) => item.fallback).length;
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
    fallback_rate: taskCount > 0 ? roundMetric(fallbackCount / taskCount) : 0,
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

    const indexStart = performance.now();
    const buildIndexResult = await buildCodeIndex(workspaceRoot, {});
    const indexBuildMs = performance.now() - indexStart;
    if (!buildIndexResult.ok) {
      throw new Error(`buildCodeIndex failed: ${JSON.stringify(buildIndexResult)}`);
    }

    const syntaxStart = performance.now();
    const buildSyntaxResult = await buildSyntaxIndex(workspaceRoot, {
      parser_provider: "auto"
    });
    const syntaxBuildMs = performance.now() - syntaxStart;
    if (!buildSyntaxResult.ok) {
      throw new Error(`buildSyntaxIndex failed: ${JSON.stringify(buildSyntaxResult)}`);
    }

    const graphStart = performance.now();
    const buildGraphResult = await buildSemanticGraph(
      workspaceRoot,
      {
        max_symbols: 400,
        include_definitions: false,
        include_references: false,
        include_syntax: true,
        precise_preferred: false
      },
      { enabled: false }
    );
    const graphBuildMs = performance.now() - graphStart;
    if (!buildGraphResult.ok) {
      throw new Error(`buildSemanticGraph failed: ${JSON.stringify(buildGraphResult)}`);
    }

    const taskResults = [];
    for (const caseDef of cases) {
      const queryOutput = await runCaseSemanticQuery(workspaceRoot, caseDef);
      taskResults.push(summarizeTaskResult(caseDef, queryOutput));
    }

    const metrics = aggregateMetrics(taskResults);
    return {
      generated_at: new Date().toISOString(),
      dataset: {
        case_count: cases.length,
        fixture_root: path.relative(process.cwd(), FIXTURE_ROOT)
      },
      build_ms: roundMetric(indexBuildMs + syntaxBuildMs + graphBuildMs),
      build_breakdown_ms: {
        code_index: roundMetric(indexBuildMs),
        syntax_index: roundMetric(syntaxBuildMs),
        semantic_graph: roundMetric(graphBuildMs)
      },
      metrics,
      tasks: taskResults
    };
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

function printBenchmark(benchmark) {
  console.log("Semantic Graph Benchmark");
  console.log(`- cases: ${benchmark.dataset.case_count}`);
  console.log(`- build total: ${benchmark.build_ms.toFixed(3)}ms`);
  console.log(`  - code index: ${benchmark.build_breakdown_ms.code_index.toFixed(3)}ms`);
  console.log(`  - syntax index: ${benchmark.build_breakdown_ms.syntax_index.toFixed(3)}ms`);
  console.log(`  - semantic graph: ${benchmark.build_breakdown_ms.semantic_graph.toFixed(3)}ms`);
  console.log(`- task success: ${(benchmark.metrics.task_success_rate * 100).toFixed(2)}%`);
  console.log(`- primary top1: ${(benchmark.metrics.primary_top1_rate * 100).toFixed(2)}%`);
  console.log(`- primary top3: ${(benchmark.metrics.primary_top3_rate * 100).toFixed(2)}%`);
  console.log(`- MRR: ${benchmark.metrics.mean_reciprocal_rank.toFixed(4)}`);
  console.log(`- evidence recall@k: ${benchmark.metrics.evidence_recall_at_k.toFixed(4)}`);
  console.log(`- fallback rate: ${(benchmark.metrics.fallback_rate * 100).toFixed(2)}%`);
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
  return JSON.parse(raw);
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
  console.log(`Semantic graph quality gate: threshold ${thresholdPercent}%`);
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
    console.log(`Wrote semantic graph baseline: ${path.relative(process.cwd(), options.baselinePath)}`);
  }

  if (options.checkBaseline) {
    const baseline = await readBaseline(options.baselinePath);
    const threshold = Number(baseline.threshold_percent || options.thresholdPercent);
    const comparison = compareWithBaseline(benchmark.metrics, baseline.metrics || {}, threshold);
    printComparison(comparison, threshold);
    if (!comparison.ok) {
      throw new Error("Semantic graph benchmark regression detected");
    }
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
