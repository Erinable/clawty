import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { runTool } from "../../src/tools.js";
import { EmbeddingError } from "../../src/embedding-client.js";
import {
  aggregateHybridReplayByBucket,
  aggregateHybridReplayMetrics,
  extractHybridReplayFailures,
  mergeHybridReplayArgs,
  scoreHybridReplayPreset,
  sortHybridReplaySummaries,
  summarizeHybridReplayTask
} from "../../src/hybrid-replay.js";

const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_CASES_PATH = path.resolve(process.cwd(), "tests/fixtures/hybrid-cases/expected.json");
const DEFAULT_PRESETS_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/hybrid-cases/replay-presets.json"
);
const DEFAULT_BASELINE_PATH = path.resolve(process.cwd(), "tests/bench/hybrid-replay.baseline.json");
const INPUT_ROOT = path.resolve(process.cwd(), "tests/fixtures/hybrid-cases/input");
const DEFAULT_FAILURES_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/hybrid-cases/failure-samples.json"
);

function parseArgs(argv) {
  const options = {
    casesPath: DEFAULT_CASES_PATH,
    presetsPath: DEFAULT_PRESETS_PATH,
    baselinePath: DEFAULT_BASELINE_PATH,
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    writeBaseline: false,
    checkBaseline: false,
    json: false,
    presetFilter: null,
    queryPatternFilter: null,
    intentFilter: null,
    writeFailures: false,
    failuresOutputPath: DEFAULT_FAILURES_OUTPUT_PATH
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
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--cases=")) {
      options.casesPath = path.resolve(process.cwd(), arg.slice("--cases=".length));
      continue;
    }
    if (arg.startsWith("--presets=")) {
      options.presetsPath = path.resolve(process.cwd(), arg.slice("--presets=".length));
      continue;
    }
    if (arg.startsWith("--baseline=")) {
      options.baselinePath = path.resolve(process.cwd(), arg.slice("--baseline=".length));
      continue;
    }
    if (arg.startsWith("--failures-output=")) {
      options.failuresOutputPath = path.resolve(
        process.cwd(),
        arg.slice("--failures-output=".length)
      );
      continue;
    }
    if (arg.startsWith("--preset=")) {
      const raw = arg.slice("--preset=".length);
      options.presetFilter = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith("--query-pattern=")) {
      const raw = arg.slice("--query-pattern=".length);
      options.queryPatternFilter = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith("--intent=")) {
      const raw = arg.slice("--intent=".length);
      options.intentFilter = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
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
    if (arg === "--write-failures") {
      options.writeFailures = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function createWorkspace(prefix = "clawty-hybrid-replay-") {
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

async function loadCases(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (cases.length === 0) {
    throw new Error(`Hybrid replay cases are empty: ${filePath}`);
  }
  return cases;
}

function normalizeLabel(value, fallback = "unknown") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function resolveCaseQueryPattern(caseDef) {
  if (typeof caseDef?.query_pattern === "string" && caseDef.query_pattern.trim()) {
    return caseDef.query_pattern.trim();
  }
  if (Array.isArray(caseDef?.query_patterns)) {
    const first = caseDef.query_patterns.find((item) => typeof item === "string" && item.trim());
    if (first) {
      return first.trim();
    }
  }
  if (Array.isArray(caseDef?.tags)) {
    const first = caseDef.tags.find((item) => typeof item === "string" && item.trim());
    if (first) {
      return first.trim();
    }
  }
  return "unknown";
}

function normalizePreset(preset) {
  return {
    name: String(preset?.name || "").trim(),
    description: typeof preset?.description === "string" ? preset.description : null,
    args: preset?.args && typeof preset.args === "object" ? preset.args : {},
    case_overrides:
      preset?.case_overrides && typeof preset.case_overrides === "object" ? preset.case_overrides : {}
  };
}

async function loadPresets(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  const presetsRaw = Array.isArray(parsed?.presets) ? parsed.presets : [];
  const presets = presetsRaw.map(normalizePreset).filter((item) => item.name.length > 0);
  if (presets.length === 0) {
    throw new Error(`Hybrid replay presets are empty: ${filePath}`);
  }
  return presets;
}

function createEmbeddingConfig(mode) {
  if (mode === "ok") {
    return {
      enabled: true,
      model: "mock-embedding-replay",
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
      model: "mock-timeout-replay",
      topK: 10,
      weight: 0.5,
      client: async () => {
        throw new EmbeddingError("EMBEDDING_REQUEST_TIMEOUT", "replay timeout", {
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

async function buildIndexes(workspaceRoot) {
  const context = createContext(workspaceRoot, "disabled");
  const buildStart = performance.now();
  const codeBuild = await runTool("build_code_index", {}, context);
  if (!codeBuild?.ok) {
    throw new Error(`build_code_index failed: ${JSON.stringify(codeBuild)}`);
  }
  const syntaxBuild = await runTool("build_syntax_index", {}, context);
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
    context
  );
  if (!graphBuild?.ok) {
    throw new Error(`build_semantic_graph failed: ${JSON.stringify(graphBuild)}`);
  }

  return Number((performance.now() - buildStart).toFixed(6));
}

async function runPresetReplay(workspaceRoot, cases, preset) {
  const taskRows = [];
  for (const caseDef of cases) {
    const caseOverride =
      preset.case_overrides &&
      typeof preset.case_overrides[caseDef.name] === "object" &&
      preset.case_overrides[caseDef.name] !== null
        ? preset.case_overrides[caseDef.name]
        : {};
    const replayArgs = mergeHybridReplayArgs(
      mergeHybridReplayArgs(caseDef.args || {}, preset.args || {}),
      caseOverride
    );

    const context = createContext(workspaceRoot, caseDef.embedding_mode || "disabled");
    const queryStart = performance.now();
    let queryResult;
    try {
      queryResult = await runTool("query_hybrid_index", replayArgs, context);
    } catch (error) {
      queryResult = {
        ok: false,
        error: error?.message || String(error),
        sources: {
          embedding: {
            status_code: "REPLAY_RUNTIME_ERROR",
            attempted: false
          }
        },
        degradation: {
          degraded: false
        }
      };
    }
    const queryMs = performance.now() - queryStart;
    taskRows.push(summarizeHybridReplayTask(caseDef, queryResult, queryMs));
  }

  const metrics = aggregateHybridReplayMetrics(taskRows);
  return {
    name: preset.name,
    description: preset.description,
    score: scoreHybridReplayPreset(metrics),
    metrics,
    bucket_metrics: aggregateHybridReplayByBucket(taskRows),
    failure_samples: extractHybridReplayFailures(taskRows),
    tasks: taskRows
  };
}

async function runReplayBenchmark(options) {
  let cases = await loadCases(options.casesPath);
  const queryPatternFilter = Array.isArray(options.queryPatternFilter)
    ? options.queryPatternFilter
    : [];
  if (queryPatternFilter.length > 0) {
    const filterSet = new Set(queryPatternFilter);
    cases = cases.filter((item) => filterSet.has(resolveCaseQueryPattern(item)));
  }
  const intentFilter = Array.isArray(options.intentFilter) ? options.intentFilter : [];
  if (intentFilter.length > 0) {
    const filterSet = new Set(intentFilter);
    cases = cases.filter((item) => filterSet.has(normalizeLabel(item?.intent, "unknown")));
  }
  if (cases.length === 0) {
    throw new Error(
      "No replay cases remained after applying --query-pattern/--intent filters"
    );
  }
  let presets = await loadPresets(options.presetsPath);
  if (Array.isArray(options.presetFilter) && options.presetFilter.length > 0) {
    const filterSet = new Set(options.presetFilter);
    presets = presets.filter((item) => filterSet.has(item.name));
    if (presets.length === 0) {
      throw new Error(`No presets matched --preset filter: ${options.presetFilter.join(",")}`);
    }
  }

  const workspaceRoot = await createWorkspace();
  try {
    await copyDirContents(INPUT_ROOT, workspaceRoot);
    const buildMs = await buildIndexes(workspaceRoot);
    const presetRuns = [];
    for (const preset of presets) {
      presetRuns.push(await runPresetReplay(workspaceRoot, cases, preset));
    }
    const ranked = sortHybridReplaySummaries(presetRuns);
    return {
      generated_at: new Date().toISOString(),
      dataset: {
        case_count: cases.length,
        preset_count: presets.length,
        cases_path: path.relative(process.cwd(), options.casesPath),
        presets_path: path.relative(process.cwd(), options.presetsPath),
        query_pattern_filter: queryPatternFilter,
        intent_filter: intentFilter
      },
      build_ms: buildMs,
      presets: presetRuns,
      ranked_presets: ranked.map((item) => item.name),
      best_preset: ranked[0]?.name || null
    };
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

function printBenchmark(benchmark) {
  console.log("Hybrid Replay Benchmark");
  console.log(`- cases: ${benchmark.dataset.case_count}`);
  console.log(`- presets: ${benchmark.dataset.preset_count}`);
  if (Array.isArray(benchmark.dataset.query_pattern_filter) && benchmark.dataset.query_pattern_filter.length > 0) {
    console.log(`- query patterns: ${benchmark.dataset.query_pattern_filter.join(", ")}`);
  }
  if (Array.isArray(benchmark.dataset.intent_filter) && benchmark.dataset.intent_filter.length > 0) {
    console.log(`- intents: ${benchmark.dataset.intent_filter.join(", ")}`);
  }
  console.log(`- build: ${benchmark.build_ms.toFixed(3)}ms`);
  console.log(`- best preset: ${benchmark.best_preset || "n/a"}`);
  console.log("");

  const sortedByRank = sortHybridReplaySummaries(benchmark.presets).map((item, index) => ({
    rank: index + 1,
    ...item
  }));
  for (const item of sortedByRank) {
    console.log(
      `#${item.rank} ${item.name}: score=${item.score.toFixed(4)} top1=${(
        item.metrics.primary_top1_rate * 100
      ).toFixed(2)}% mrr=${item.metrics.mean_reciprocal_rank.toFixed(4)} success=${(
        item.metrics.task_success_rate * 100
      ).toFixed(2)}% p95=${item.metrics.query_p95_ms.toFixed(3)}ms`
    );
  }
}

async function writeBaseline(filePath, benchmark, thresholdPercent) {
  const metricsByPreset = {};
  for (const preset of benchmark.presets) {
    metricsByPreset[preset.name] = {
      score: Number(preset.score || 0),
      task_success_rate: Number(preset.metrics.task_success_rate || 0),
      primary_top1_rate: Number(preset.metrics.primary_top1_rate || 0),
      mean_reciprocal_rank: Number(preset.metrics.mean_reciprocal_rank || 0)
    };
  }

  const payload = {
    generated_at: new Date().toISOString(),
    threshold_percent: thresholdPercent,
    metrics: metricsByPreset
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeFailureSamples(filePath, benchmark) {
  const payload = {
    source: {
      cases_path: benchmark?.dataset?.cases_path || null,
      presets_path: benchmark?.dataset?.presets_path || null,
      case_count: Number(benchmark?.dataset?.case_count || 0),
      preset_count: Number(benchmark?.dataset?.preset_count || 0),
      query_pattern_filter: Array.isArray(benchmark?.dataset?.query_pattern_filter)
        ? benchmark.dataset.query_pattern_filter
        : [],
      intent_filter: Array.isArray(benchmark?.dataset?.intent_filter)
        ? benchmark.dataset.intent_filter
        : []
    },
    presets: (Array.isArray(benchmark?.presets) ? benchmark.presets : []).map((preset) => ({
      name: preset?.name || "unknown_preset",
      failure_count: Array.isArray(preset?.failure_samples) ? preset.failure_samples.length : 0,
      failure_samples: Array.isArray(preset?.failure_samples) ? preset.failure_samples : []
    }))
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readBaseline(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function compareWithBaseline(benchmark, baseline, thresholdPercent) {
  const baselineMetrics = baseline?.metrics && typeof baseline.metrics === "object" ? baseline.metrics : {};
  const currentByName = new Map(benchmark.presets.map((item) => [item.name, item]));
  const metricKeys = ["score", "task_success_rate", "primary_top1_rate", "mean_reciprocal_rank"];
  const results = [];

  for (const [presetName, expected] of Object.entries(baselineMetrics)) {
    const current = currentByName.get(presetName);
    if (!current) {
      results.push({
        preset: presetName,
        metric: "*",
        ok: false,
        reason: "missing preset in current run"
      });
      continue;
    }
    for (const key of metricKeys) {
      const currentValue = Number(key === "score" ? current.score : current.metrics[key]);
      const baselineValue = Number(expected?.[key]);
      if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) {
        results.push({
          preset: presetName,
          metric: key,
          ok: false,
          reason: "invalid metric value"
        });
        continue;
      }
      const allowedMin = baselineValue * (1 - thresholdPercent / 100);
      results.push({
        preset: presetName,
        metric: key,
        ok: currentValue >= allowedMin,
        current: currentValue,
        baseline: baselineValue,
        allowed_min: allowedMin
      });
    }
  }

  return {
    ok: results.every((item) => item.ok),
    results
  };
}

function printComparison(comparison, thresholdPercent) {
  console.log(`Hybrid replay gate: threshold ${thresholdPercent}%`);
  for (const item of comparison.results) {
    if (item.reason) {
      console.log(`- REGRESSION ${item.preset}/${item.metric}: ${item.reason}`);
      continue;
    }
    const delta =
      item.baseline === 0
        ? "n/a"
        : `${(((item.current - item.baseline) / item.baseline) * 100).toFixed(2)}%`;
    const label = item.ok ? "OK" : "REGRESSION";
    console.log(
      `- ${label} ${item.preset}/${item.metric}: current=${item.current.toFixed(6)}, baseline=${item.baseline.toFixed(6)}, allowed>=${item.allowed_min.toFixed(6)} (${delta})`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const benchmark = await runReplayBenchmark(options);

  if (options.json) {
    console.log(JSON.stringify(benchmark, null, 2));
  } else {
    printBenchmark(benchmark);
  }

  if (options.writeBaseline) {
    await writeBaseline(options.baselinePath, benchmark, options.thresholdPercent);
    console.log(`Wrote replay baseline: ${path.relative(process.cwd(), options.baselinePath)}`);
  }

  if (options.writeFailures) {
    await writeFailureSamples(options.failuresOutputPath, benchmark);
    console.log(
      `Wrote replay failure samples: ${path.relative(process.cwd(), options.failuresOutputPath)}`
    );
  }

  if (options.checkBaseline) {
    const baseline = await readBaseline(options.baselinePath);
    const threshold = Number(baseline.threshold_percent || options.thresholdPercent);
    const comparison = compareWithBaseline(benchmark, baseline, threshold);
    printComparison(comparison, threshold);
    if (!comparison.ok) {
      throw new Error("Hybrid replay regression detected");
    }
  }
}

main().catch((error) => {
  console.error(`Hybrid replay failed: ${error.message}`);
  process.exitCode = 1;
});
