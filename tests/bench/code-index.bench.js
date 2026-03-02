import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  buildCodeIndex,
  queryCodeIndex,
  refreshCodeIndex
} from "../../src/code-index.js";

const DEFAULT_THRESHOLD_PERCENT = 20;
const DEFAULT_BASELINE_PATH = path.resolve(process.cwd(), "tests/bench/code-index.baseline.json");
const METRIC_KEYS = ["build_ms", "refresh_ms", "query_p95_ms", "index_bytes"];

const DATASET = Object.freeze({
  js_modules: 24,
  js_files_per_module: 6,
  ts_modules: 12,
  ts_files_per_module: 4,
  py_files: 24,
  docs_files: 24,
  changed_js_files: 20,
  deleted_js_files: 8,
  added_js_files: 12
});

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

async function createWorkspace(prefix = "clawty-bench-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeWorkspace(workspaceRoot) {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}

async function writeWorkspaceFile(workspaceRoot, relativePath, content) {
  const fullPath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

function makeJsContent(moduleId, fileId, rev = 1) {
  const tokenBase = `token_${pad2(moduleId)}_${pad2(fileId)}`;
  const lines = [
    `const ${tokenBase}_version = ${rev};`,
    `export function feature_handler_${pad2(moduleId)}_${pad2(fileId)}(input) {`,
    `  const local_${tokenBase} = String(input ?? "${tokenBase}");`,
    `  return local_${tokenBase}.toUpperCase();`,
    "}",
    `export const module_marker_${pad2(moduleId)}_${pad2(fileId)} = "${tokenBase}_marker";`
  ];

  for (let i = 0; i < 48; i += 1) {
    lines.push(
      `export function helper_${pad2(moduleId)}_${pad2(fileId)}_${pad2(i)}() { return "${tokenBase}_${pad2(i)}"; }`
    );
  }
  return `${lines.join("\n")}\n`;
}

function makeTsContent(moduleId, fileId) {
  const token = `domain_${pad2(moduleId)}_${pad2(fileId)}`;
  return [
    `export interface ${token}_shape {`,
    "  id: string;",
    "  active: boolean;",
    "}",
    `export class ${token}_entity {`,
    "  constructor(public id: string) {}",
    "  toJSON() {",
    "    return { id: this.id, active: true };",
    "  }",
    "}",
    `export const ${token}_label = "${token}";`
  ].join("\n");
}

function makePyContent(index) {
  const token = `python_worker_${pad2(index)}`;
  return [
    `def ${token}(value):`,
    "    if value is None:",
    '        return "none"',
    "    return str(value)",
    "",
    `class ${token}_service:`,
    "    def __init__(self):",
    `        self.name = "${token}"`,
    "",
    "    def run(self, value):",
    `        return ${token}(value)`
  ].join("\n");
}

function makeDocContent(index) {
  return [
    `# integration_flow_${pad2(index)}`,
    "",
    `This document explains build refresh query pipeline ${pad2(index)}.`,
    `Use module marker token_${pad2(index)}_00 and python_worker_${pad2(index % DATASET.py_files)}.`
  ].join("\n");
}

async function generateFixture(workspaceRoot) {
  const changedCandidates = [];
  const deleteCandidates = [];

  for (let moduleId = 0; moduleId < DATASET.js_modules; moduleId += 1) {
    for (let fileId = 0; fileId < DATASET.js_files_per_module; fileId += 1) {
      const relativePath = `src/module-${pad2(moduleId)}/feature-${pad2(fileId)}.js`;
      await writeWorkspaceFile(workspaceRoot, relativePath, makeJsContent(moduleId, fileId, 1));
      if (fileId < 2) {
        changedCandidates.push(relativePath);
      }
      if (fileId === DATASET.js_files_per_module - 1) {
        deleteCandidates.push(relativePath);
      }
    }
  }

  for (let moduleId = 0; moduleId < DATASET.ts_modules; moduleId += 1) {
    for (let fileId = 0; fileId < DATASET.ts_files_per_module; fileId += 1) {
      const relativePath = `packages/domain-${pad2(moduleId)}/entity-${pad2(fileId)}.ts`;
      await writeWorkspaceFile(workspaceRoot, relativePath, makeTsContent(moduleId, fileId));
    }
  }

  for (let i = 0; i < DATASET.py_files; i += 1) {
    await writeWorkspaceFile(workspaceRoot, `scripts/worker-${pad2(i)}.py`, makePyContent(i));
  }

  for (let i = 0; i < DATASET.docs_files; i += 1) {
    await writeWorkspaceFile(workspaceRoot, `docs/guide-${pad2(i)}.md`, makeDocContent(i));
  }

  await writeWorkspaceFile(workspaceRoot, "node_modules/ignore/index.js", "ignored = true;\n");

  return {
    changedCandidates,
    deleteCandidates
  };
}

async function applyRefreshMutations(workspaceRoot, fixture) {
  const changedPaths = fixture.changedCandidates.slice(0, DATASET.changed_js_files);
  for (const filePath of changedPaths) {
    const match = filePath.match(/module-(\d+)\/feature-(\d+)\.js$/);
    const moduleId = Number(match?.[1] || 0);
    const fileId = Number(match?.[2] || 0);
    await writeWorkspaceFile(workspaceRoot, filePath, makeJsContent(moduleId, fileId, 2));
  }

  const deletedPaths = fixture.deleteCandidates.slice(0, DATASET.deleted_js_files);
  for (const filePath of deletedPaths) {
    await fs.rm(path.join(workspaceRoot, filePath), { force: true });
  }

  for (let i = 0; i < DATASET.added_js_files; i += 1) {
    const relativePath = `src/generated/new-feature-${pad2(i)}.js`;
    await writeWorkspaceFile(
      workspaceRoot,
      relativePath,
      `export const generated_feature_${pad2(i)} = "generated_feature_${pad2(i)}";\n`
    );
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
  return Number(value.toFixed(3));
}

async function measureDuration(asyncFn) {
  const start = performance.now();
  const result = await asyncFn();
  return {
    durationMs: performance.now() - start,
    result
  };
}

async function getIndexDbBytes(workspaceRoot) {
  const indexDir = path.join(workspaceRoot, ".clawty");
  const entries = await fs.readdir(indexDir).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (!entry.startsWith("index.db")) {
      continue;
    }
    const stat = await fs.stat(path.join(indexDir, entry));
    total += stat.size;
  }
  return total;
}

async function runBenchmark() {
  const workspaceRoot = await createWorkspace();
  try {
    const fixture = await generateFixture(workspaceRoot);

    const buildRun = await measureDuration(() => buildCodeIndex(workspaceRoot, {}));
    if (!buildRun.result?.ok) {
      throw new Error(`buildCodeIndex failed: ${JSON.stringify(buildRun.result)}`);
    }

    await applyRefreshMutations(workspaceRoot, fixture);
    const refreshRun = await measureDuration(() => refreshCodeIndex(workspaceRoot, {}));
    if (!refreshRun.result?.ok) {
      throw new Error(`refreshCodeIndex failed: ${JSON.stringify(refreshRun.result)}`);
    }

    const queries = [
      "feature_handler_03_02",
      "module_marker_10_01",
      "domain_05_02_entity",
      "python_worker_11",
      "generated_feature_06",
      "integration_flow_09",
      "token_14_03",
      "feature_handler_21_04",
      "domain_00_00",
      "python_worker_03_service"
    ];

    const queryDurations = [];
    for (const query of queries) {
      const queryRun = await measureDuration(() => queryCodeIndex(workspaceRoot, { query, top_k: 8 }));
      if (!queryRun.result?.ok) {
        throw new Error(`queryCodeIndex failed for "${query}": ${JSON.stringify(queryRun.result)}`);
      }
      queryDurations.push(queryRun.durationMs);
    }

    const indexBytes = await getIndexDbBytes(workspaceRoot);

    return {
      dataset: DATASET,
      counts: {
        indexed_files: Number(refreshRun.result.indexed_files || 0),
        changed_files: DATASET.changed_js_files,
        deleted_files: DATASET.deleted_js_files,
        added_files: DATASET.added_js_files
      },
      metrics: {
        build_ms: roundMetric(buildRun.durationMs),
        refresh_ms: roundMetric(refreshRun.durationMs),
        query_avg_ms: roundMetric(
          queryDurations.reduce((sum, value) => sum + value, 0) / queryDurations.length
        ),
        query_p95_ms: roundMetric(percentile(queryDurations, 95)),
        index_bytes: indexBytes
      }
    };
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

async function readBaseline(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  if (!parsed?.metrics) {
    throw new Error(`Invalid baseline file format: ${filePath}`);
  }
  return parsed;
}

function formatMetricValue(metric, value) {
  if (metric.endsWith("_ms")) {
    return `${Number(value).toFixed(3)}ms`;
  }
  if (metric.endsWith("_bytes")) {
    return `${value}B`;
  }
  return String(value);
}

function compareWithBaseline(currentMetrics, baselineMetrics, thresholdPercent) {
  const rows = [];
  let hasRegression = false;

  for (const metric of METRIC_KEYS) {
    const baselineValue = Number(baselineMetrics[metric]);
    const currentValue = Number(currentMetrics[metric]);
    if (!Number.isFinite(baselineValue) || baselineValue <= 0) {
      throw new Error(`Baseline metric "${metric}" must be a positive number`);
    }
    if (!Number.isFinite(currentValue) || currentValue < 0) {
      throw new Error(`Current metric "${metric}" must be a non-negative number`);
    }

    const maxAllowed = baselineValue * (1 + thresholdPercent / 100);
    const deltaPercent = ((currentValue - baselineValue) / baselineValue) * 100;
    const regressed = currentValue > maxAllowed;
    if (regressed) {
      hasRegression = true;
    }

    rows.push({
      metric,
      baselineValue,
      currentValue,
      maxAllowed,
      deltaPercent,
      regressed
    });
  }

  return {
    hasRegression,
    rows
  };
}

async function writeBaseline(filePath, benchmark, thresholdPercent) {
  const payload = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    threshold_percent: thresholdPercent,
    dataset: benchmark.dataset,
    metrics: {
      build_ms: benchmark.metrics.build_ms,
      refresh_ms: benchmark.metrics.refresh_ms,
      query_p95_ms: benchmark.metrics.query_p95_ms,
      index_bytes: benchmark.metrics.index_bytes
    }
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function printBenchmark(benchmark) {
  console.log("Code Index Benchmark");
  console.log(`- indexed files: ${benchmark.counts.indexed_files}`);
  console.log(`- build: ${benchmark.metrics.build_ms.toFixed(3)}ms`);
  console.log(`- refresh: ${benchmark.metrics.refresh_ms.toFixed(3)}ms`);
  console.log(`- query avg: ${benchmark.metrics.query_avg_ms.toFixed(3)}ms`);
  console.log(`- query p95: ${benchmark.metrics.query_p95_ms.toFixed(3)}ms`);
  console.log(`- index size: ${benchmark.metrics.index_bytes}B`);
}

function printComparison(result, thresholdPercent) {
  console.log(`\nPerformance gate: threshold ${thresholdPercent}%`);
  for (const row of result.rows) {
    const status = row.regressed ? "REGRESSION" : "OK";
    const delta = row.deltaPercent >= 0 ? `+${row.deltaPercent.toFixed(2)}%` : `${row.deltaPercent.toFixed(2)}%`;
    console.log(
      `- ${status} ${row.metric}: current=${formatMetricValue(row.metric, row.currentValue)}, baseline=${formatMetricValue(
        row.metric,
        row.baselineValue
      )}, allowed<=${formatMetricValue(row.metric, row.maxAllowed)} (${delta})`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const benchmark = await runBenchmark();
  printBenchmark(benchmark);

  if (options.writeBaseline) {
    await writeBaseline(options.baselinePath, benchmark, options.thresholdPercent);
    console.log(`\nWrote baseline: ${options.baselinePath}`);
  }

  if (!options.checkBaseline) {
    return;
  }

  const baseline = await readBaseline(options.baselinePath);
  const thresholdPercent = Number(
    Number.isFinite(options.thresholdPercent) ? options.thresholdPercent : baseline.threshold_percent
  );

  const comparison = compareWithBaseline(benchmark.metrics, baseline.metrics, thresholdPercent);
  printComparison(comparison, thresholdPercent);

  if (comparison.hasRegression) {
    throw new Error("Code index benchmark regression detected");
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
