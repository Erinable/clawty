import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { buildCodeIndex, refreshCodeIndex } from "../../src/code-index.js";
import { buildSyntaxIndex, refreshSyntaxIndex } from "../../src/syntax-index.js";
import {
  buildSemanticGraph,
  refreshSemanticGraph,
  querySemanticGraph
} from "../../src/semantic-graph.js";

const DEFAULT_THRESHOLD_PERCENT = 2;
const DEFAULT_BASELINE_PATH = path.resolve(
  process.cwd(),
  "tests/bench/semantic-graph-refresh.baseline.json"
);

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

function roundMetric(value) {
  return Number(value.toFixed(6));
}

async function createWorkspace(prefix = "clawty-semantic-refresh-bench-") {
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

async function removeWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = path.join(workspaceRoot, relativePath);
  await fs.rm(fullPath, { force: true });
}

async function seedInitialProject(workspaceRoot) {
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/alpha.ts",
    "import { betaToken } from './beta';\nexport function alphaToken() { return betaToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/beta.ts",
    "export function betaToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/consumer.ts",
    "import { alphaToken } from './alpha';\nexport function consumerToken() { return alphaToken(); }\n"
  );
}

async function applyMutation(workspaceRoot) {
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/alpha.ts",
    "import { deltaToken } from './delta';\nexport function alphaNewToken() { return deltaToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/delta.ts",
    "export function deltaToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/domain/consumer.ts",
    "import { alphaNewToken } from './alpha';\nexport function consumerToken() { return alphaNewToken(); }\n"
  );
  await removeWorkspaceFile(workspaceRoot, "src/domain/beta.ts");

  return {
    changed_paths: [
      "src/domain/alpha.ts",
      "src/domain/delta.ts",
      "src/domain/consumer.ts"
    ],
    deleted_paths: ["src/domain/beta.ts"]
  };
}

async function runFullPipeline(workspaceRoot) {
  const codeStart = performance.now();
  const code = await buildCodeIndex(workspaceRoot, {});
  const codeMs = performance.now() - codeStart;
  if (!code.ok) {
    throw new Error(`buildCodeIndex failed: ${JSON.stringify(code)}`);
  }

  const syntaxStart = performance.now();
  const syntax = await buildSyntaxIndex(workspaceRoot, { parser_provider: "auto" });
  const syntaxMs = performance.now() - syntaxStart;
  if (!syntax.ok) {
    throw new Error(`buildSyntaxIndex failed: ${JSON.stringify(syntax)}`);
  }

  const semanticStart = performance.now();
  const semantic = await buildSemanticGraph(
    workspaceRoot,
    {
      include_definitions: false,
      include_references: false,
      include_syntax: true,
      precise_preferred: false
    },
    { enabled: false }
  );
  const semanticMs = performance.now() - semanticStart;
  if (!semantic.ok) {
    throw new Error(`buildSemanticGraph failed: ${JSON.stringify(semantic)}`);
  }

  return {
    code_ms: roundMetric(codeMs),
    syntax_ms: roundMetric(syntaxMs),
    semantic_ms: roundMetric(semanticMs),
    total_ms: roundMetric(codeMs + syntaxMs + semanticMs)
  };
}

async function runEventPipeline(workspaceRoot, eventPaths) {
  const codeStart = performance.now();
  const code = await refreshCodeIndex(workspaceRoot, eventPaths);
  const codeMs = performance.now() - codeStart;
  if (!code.ok) {
    throw new Error(`refreshCodeIndex failed: ${JSON.stringify(code)}`);
  }

  const syntaxStart = performance.now();
  const syntax = await refreshSyntaxIndex(workspaceRoot, {
    ...eventPaths,
    parser_provider: "auto"
  });
  const syntaxMs = performance.now() - syntaxStart;
  if (!syntax.ok) {
    throw new Error(`refreshSyntaxIndex failed: ${JSON.stringify(syntax)}`);
  }

  const semanticStart = performance.now();
  const semantic = await refreshSemanticGraph(
    workspaceRoot,
    {
      ...eventPaths,
      include_definitions: false,
      include_references: false,
      include_syntax: true,
      precise_preferred: false
    },
    { enabled: false }
  );
  const semanticMs = performance.now() - semanticStart;
  if (!semantic.ok) {
    throw new Error(`refreshSemanticGraph failed: ${JSON.stringify(semantic)}`);
  }

  return {
    code_ms: roundMetric(codeMs),
    syntax_ms: roundMetric(syntaxMs),
    semantic_ms: roundMetric(semanticMs),
    total_ms: roundMetric(codeMs + syntaxMs + semanticMs)
  };
}

function collectPaths(result) {
  const set = new Set();
  for (const seed of result?.seeds || []) {
    if (seed?.path) {
      set.add(seed.path);
    }
    for (const neighbor of seed?.outgoing || []) {
      if (neighbor?.node?.path) {
        set.add(neighbor.node.path);
      }
    }
    for (const neighbor of seed?.incoming || []) {
      if (neighbor?.node?.path) {
        set.add(neighbor.node.path);
      }
    }
    for (const hop of seed?.multi_hop?.outgoing || []) {
      if (hop?.node?.path) {
        set.add(hop.node.path);
      }
    }
    for (const hop of seed?.multi_hop?.incoming || []) {
      if (hop?.node?.path) {
        set.add(hop.node.path);
      }
    }
  }
  return set;
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  if (union.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) {
      inter += 1;
    }
  }
  return inter / union.size;
}

function canonicalizeResult(result) {
  const seeds = (result?.seeds || []).map((seed) => ({
    path: seed.path,
    name: seed.name,
    kind: seed.kind,
    line: Number(seed.line || 1),
    source: seed.source || null,
    outgoing: (seed.outgoing || []).map((item) => [
      item.edge_type,
      item.edge_source,
      item.node?.path || null,
      item.node?.name || null,
      Number(item.node?.line || 1)
    ]),
    incoming: (seed.incoming || []).map((item) => [
      item.edge_type,
      item.edge_source,
      item.node?.path || null,
      item.node?.name || null,
      Number(item.node?.line || 1)
    ]),
    multi_hop: {
      outgoing: (seed.multi_hop?.outgoing || []).map((item) => [
        Number(item.hop || 0),
        item.node?.path || null,
        item.node?.name || null,
        Number(item.path_score || 0)
      ]),
      incoming: (seed.multi_hop?.incoming || []).map((item) => [
        Number(item.hop || 0),
        item.node?.path || null,
        item.node?.name || null,
        Number(item.path_score || 0)
      ])
    }
  }));

  return JSON.stringify({
    provider: result?.provider || "semantic_graph",
    fallback: Boolean(result?.fallback),
    filters: result?.filters || {},
    seeds
  });
}

async function runQueryPack(workspaceRoot, queries) {
  const outputs = [];
  for (const query of queries) {
    const result = await querySemanticGraph(workspaceRoot, {
      query,
      top_k: 5,
      max_neighbors: 8,
      max_hops: 2,
      per_hop_limit: 8
    });
    if (!result.ok) {
      throw new Error(`querySemanticGraph failed for ${query}: ${JSON.stringify(result)}`);
    }
    outputs.push({
      query,
      canonical: canonicalizeResult(result),
      path_set: collectPaths(result),
      primary_seed: result.seeds?.[0]
        ? `${result.seeds[0].path}::${result.seeds[0].name}::${result.seeds[0].kind}`
        : null
    });
  }
  return outputs;
}

function compareQueryOutputs(eventOutputs, fullOutputs) {
  const count = Math.min(eventOutputs.length, fullOutputs.length);
  let signatureEqual = 0;
  let primarySeedEqual = 0;
  let jaccardSum = 0;

  const perQuery = [];
  for (let i = 0; i < count; i += 1) {
    const eventItem = eventOutputs[i];
    const fullItem = fullOutputs[i];
    const sigEqual = eventItem.canonical === fullItem.canonical;
    const seedEqual = eventItem.primary_seed === fullItem.primary_seed;
    const jac = jaccard(eventItem.path_set, fullItem.path_set);

    if (sigEqual) {
      signatureEqual += 1;
    }
    if (seedEqual) {
      primarySeedEqual += 1;
    }
    jaccardSum += jac;

    perQuery.push({
      query: eventItem.query,
      signature_equal: sigEqual,
      primary_seed_equal: seedEqual,
      path_jaccard: roundMetric(jac)
    });
  }

  return {
    count,
    signature_match_rate: count > 0 ? roundMetric(signatureEqual / count) : 0,
    primary_seed_match_rate: count > 0 ? roundMetric(primarySeedEqual / count) : 0,
    path_jaccard_avg: count > 0 ? roundMetric(jaccardSum / count) : 0,
    per_query: perQuery
  };
}

async function runBenchmark() {
  const eventWorkspace = await createWorkspace("clawty-semantic-refresh-event-");
  const fullWorkspace = await createWorkspace("clawty-semantic-refresh-full-");

  try {
    await seedInitialProject(eventWorkspace);
    await seedInitialProject(fullWorkspace);

    await runFullPipeline(eventWorkspace);
    const eventPaths = await applyMutation(eventWorkspace);
    await applyMutation(fullWorkspace);

    const eventTiming = await runEventPipeline(eventWorkspace, eventPaths);
    const fullTiming = await runFullPipeline(fullWorkspace);

    const queries = ["alphaNewToken", "deltaToken", "consumerToken"];
    const eventOutputs = await runQueryPack(eventWorkspace, queries);
    const fullOutputs = await runQueryPack(fullWorkspace, queries);
    const quality = compareQueryOutputs(eventOutputs, fullOutputs);

    return {
      generated_at: new Date().toISOString(),
      scenario: {
        queries,
        changed_paths: eventPaths.changed_paths,
        deleted_paths: eventPaths.deleted_paths
      },
      timing: {
        event_pipeline_ms: eventTiming,
        full_pipeline_ms: fullTiming,
        speedup: {
          total: fullTiming.total_ms > 0 ? roundMetric(fullTiming.total_ms / eventTiming.total_ms) : 0,
          semantic_only:
            eventTiming.semantic_ms > 0
              ? roundMetric(fullTiming.semantic_ms / eventTiming.semantic_ms)
              : 0
        }
      },
      metrics: {
        signature_match_rate: quality.signature_match_rate,
        primary_seed_match_rate: quality.primary_seed_match_rate,
        path_jaccard_avg: quality.path_jaccard_avg
      },
      queries: quality.per_query
    };
  } finally {
    await removeWorkspace(eventWorkspace);
    await removeWorkspace(fullWorkspace);
  }
}

function printBenchmark(benchmark) {
  console.log("Semantic Graph Refresh Benchmark");
  console.log(`- queries: ${benchmark.scenario.queries.length}`);
  console.log(
    `- signature match: ${(benchmark.metrics.signature_match_rate * 100).toFixed(2)}%`
  );
  console.log(
    `- primary seed match: ${(benchmark.metrics.primary_seed_match_rate * 100).toFixed(2)}%`
  );
  console.log(`- path jaccard avg: ${benchmark.metrics.path_jaccard_avg.toFixed(4)}`);
  console.log(`- event total: ${benchmark.timing.event_pipeline_ms.total_ms.toFixed(3)}ms`);
  console.log(`- full total: ${benchmark.timing.full_pipeline_ms.total_ms.toFixed(3)}ms`);
  console.log(`- speedup total: ${benchmark.timing.speedup.total.toFixed(3)}x`);
}

async function writeBaseline(filePath, benchmark, thresholdPercent) {
  const payload = {
    generated_at: new Date().toISOString(),
    threshold_percent: thresholdPercent,
    metrics: {
      signature_match_rate: benchmark.metrics.signature_match_rate,
      primary_seed_match_rate: benchmark.metrics.primary_seed_match_rate,
      path_jaccard_avg: benchmark.metrics.path_jaccard_avg
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
  const keys = ["signature_match_rate", "primary_seed_match_rate", "path_jaccard_avg"];
  const results = [];

  for (const key of keys) {
    const current = Number(currentMetrics[key]);
    const baseline = Number(baselineMetrics[key]);
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) {
      results.push({ key, ok: false, reason: "invalid metric" });
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
  console.log(`Semantic graph refresh gate: threshold ${thresholdPercent}%`);
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
    console.log(
      `Wrote semantic graph refresh baseline: ${path.relative(process.cwd(), options.baselinePath)}`
    );
  }

  if (options.checkBaseline) {
    const baseline = await readBaseline(options.baselinePath);
    const threshold = Number(baseline.threshold_percent || options.thresholdPercent);
    const comparison = compareWithBaseline(benchmark.metrics, baseline.metrics || {}, threshold);
    printComparison(comparison, threshold);
    if (!comparison.ok) {
      throw new Error("Semantic graph refresh benchmark regression detected");
    }
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
