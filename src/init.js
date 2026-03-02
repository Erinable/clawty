import path from "node:path";
import { runDoctor } from "./doctor.js";
import { buildCodeIndex } from "./code-index.js";
import { buildSyntaxIndex } from "./syntax-index.js";
import { buildSemanticGraph } from "./semantic-graph.js";
import { buildVectorIndex } from "./vector-index.js";
import { getMemoryStats } from "./memory.js";

const STATUS = {
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  SKIP: "skip"
};

const STATUS_ICON = {
  [STATUS.PASS]: "✓",
  [STATUS.FAIL]: "✗",
  [STATUS.WARN]: "⚠",
  [STATUS.SKIP]: "○"
};

const SECTION_SEPARATOR = "────────────────────────────────────────";

function parsePositiveInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid ${name}: expected integer >= ${min}`);
  }
  return Math.min(max, Math.floor(n));
}

function summarizeSteps(steps) {
  const summary = {
    pass: 0,
    fail: 0,
    warn: 0,
    skip: 0,
    total: steps.length
  };
  for (const step of steps) {
    if (step.status === STATUS.PASS) {
      summary.pass += 1;
      continue;
    }
    if (step.status === STATUS.FAIL) {
      summary.fail += 1;
      continue;
    }
    if (step.status === STATUS.WARN) {
      summary.warn += 1;
      continue;
    }
    summary.skip += 1;
  }
  return summary;
}

function buildStepMessage(stepId, result) {
  if (stepId === "doctor") {
    const summary = result?.summary || {};
    return `${Number(summary.pass || 0)} passed, ${Number(summary.fail || 0)} failed, ${Number(summary.warn || 0)} warnings`;
  }
  if (stepId === "code_index") {
    return [
      `indexed ${Number(result?.indexed_files || 0)} files`,
      `chunks ${Number(result?.chunk_count || 0)}`,
      `symbols ${Number(result?.symbol_count || 0)}`
    ].join(", ");
  }
  if (stepId === "syntax_index") {
    return [
      `parsed ${Number(result?.parsed_files || 0)} files`,
      `imports ${Number(result?.total_import_edges || 0)}`,
      `calls ${Number(result?.total_call_edges || 0)}`
    ].join(", ");
  }
  if (stepId === "semantic_graph") {
    const lspAvailable = result?.lsp?.available;
    const lspLabel = lspAvailable === true ? "on" : "off";
    return [
      `nodes ${Number(result?.total_nodes || 0)}`,
      `edges ${Number(result?.total_edges || 0)}`,
      `lsp ${lspLabel}`
    ].join(", ");
  }
  if (stepId === "vector_index") {
    return [
      `layer ${result?.layer || "base"}`,
      `processed_files ${Number(result?.processed_files || 0)}`,
      `processed_chunks ${Number(result?.processed_chunks || 0)}`
    ].join(", ");
  }
  if (stepId === "memory_status") {
    return [
      `scope ${result?.scope || "project+global"}`,
      `lessons ${Number(result?.counts?.lessons || 0)}`,
      `episodes ${Number(result?.counts?.episodes || 0)}`
    ].join(", ");
  }
  return "completed";
}

async function executeStep(definition) {
  const startedAt = Date.now();
  const base = {
    id: definition.id,
    title: definition.title,
    required: Boolean(definition.required),
    elapsed_ms: 0,
    result: null
  };

  if (!definition.enabled) {
    return {
      ...base,
      status: STATUS.SKIP,
      message: definition.skipMessage || "disabled",
      elapsed_ms: 0
    };
  }

  try {
    const result = await definition.run();
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const success = !(result && typeof result === "object" && result.ok === false);
    if (success) {
      return {
        ...base,
        status: STATUS.PASS,
        message: buildStepMessage(definition.id, result),
        elapsed_ms: elapsedMs,
        result
      };
    }
    return {
      ...base,
      status: definition.required ? STATUS.FAIL : STATUS.WARN,
      message: result?.error || "step returned not ok",
      elapsed_ms: elapsedMs,
      result
    };
  } catch (error) {
    return {
      ...base,
      status: definition.required ? STATUS.FAIL : STATUS.WARN,
      message: error.message || String(error),
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      result: null
    };
  }
}

export function parseInitCliArgs(argv = []) {
  const options = {
    help: false,
    format: "text",
    includeDoctor: true,
    includeSyntax: true,
    includeSemantic: true,
    includeVector: false,
    vectorLayer: "base",
    maxFiles: null,
    maxFileSizeKb: null,
    semanticSeedLangFilter: null
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      options.format = "text";
      continue;
    }
    if (arg === "--no-doctor") {
      options.includeDoctor = false;
      continue;
    }
    if (arg === "--no-syntax") {
      options.includeSyntax = false;
      continue;
    }
    if (arg === "--no-semantic") {
      options.includeSemantic = false;
      continue;
    }
    if (arg === "--include-vector" || arg === "--with-vector" || arg === "--vector") {
      options.includeVector = true;
      continue;
    }
    if (arg === "--no-vector") {
      options.includeVector = false;
      continue;
    }
    if (arg.startsWith("--vector-layer=")) {
      options.vectorLayer = arg.slice("--vector-layer=".length).trim();
      continue;
    }
    if (arg === "--vector-layer") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --vector-layer");
      }
      options.vectorLayer = raw.trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--max-files=")) {
      options.maxFiles = parsePositiveInt(
        arg.slice("--max-files=".length),
        "max-files",
        1,
        20_000
      );
      continue;
    }
    if (arg === "--max-files") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --max-files");
      }
      options.maxFiles = parsePositiveInt(raw, "max-files", 1, 20_000);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--max-file-size-kb=")) {
      options.maxFileSizeKb = parsePositiveInt(
        arg.slice("--max-file-size-kb=".length),
        "max-file-size-kb",
        1,
        8192
      );
      continue;
    }
    if (arg === "--max-file-size-kb") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --max-file-size-kb");
      }
      options.maxFileSizeKb = parsePositiveInt(raw, "max-file-size-kb", 1, 8192);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--semantic-seed-lang-filter=")) {
      const value = arg.slice("--semantic-seed-lang-filter=".length).trim();
      options.semanticSeedLangFilter = value || null;
      continue;
    }
    if (arg === "--semantic-seed-lang-filter") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --semantic-seed-lang-filter");
      }
      options.semanticSeedLangFilter = raw.trim() || null;
      idx += 1;
      continue;
    }
    throw new Error(
      `Unknown init argument: ${arg}. Use: node src/index.js init [--no-doctor] [--no-syntax] [--no-semantic] [--include-vector] [--json]`
    );
  }

  if (!["base", "delta"].includes(options.vectorLayer)) {
    throw new Error("Invalid --vector-layer: expected base or delta");
  }
  return options;
}

export function printInitHelp() {
  console.log(
    [
      "init: one-command onboarding for a new codebase (doctor + index bootstrap)",
      "",
      "Usage:",
      "  node src/index.js init",
      "  node src/index.js init --include-vector",
      "  node src/index.js init --no-doctor --no-semantic",
      "  node src/index.js init --json",
      "",
      "Options:",
      "  --no-doctor                     Skip doctor preflight checks",
      "  --no-syntax                     Skip syntax index build",
      "  --no-semantic                   Skip semantic graph build",
      "  --include-vector                Build vector index (optional)",
      "  --vector-layer <base|delta>     Vector target layer (default: base)",
      "  --max-files <n>                 Max files for code index build",
      "  --max-file-size-kb <n>          Max file size for code index build",
      "  --semantic-seed-lang-filter <v> Semantic seed language filter",
      "  --json                          Output structured JSON report",
      "  -h, --help                      Show this help"
    ].join("\n")
  );
}

function renderSummaryConclusion(summary) {
  if (summary.fail > 0) {
    return "✗ Init failed due to required step errors.";
  }
  if (summary.warn > 0) {
    return "⚠ Init completed with warnings.";
  }
  return "✓ Init completed successfully.";
}

export function formatInitReportText(report) {
  const lines = [];
  lines.push(" Clawty... Init");
  lines.push("");

  lines.push("Bootstrap");
  lines.push(SECTION_SEPARATOR);
  for (const step of report.steps || []) {
    const icon = STATUS_ICON[step.status] || step.status;
    lines.push(`  ${icon} ${step.title} -> ${step.message}`);
  }
  lines.push("");

  lines.push("Summary");
  lines.push(SECTION_SEPARATOR);
  lines.push(
    `  ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.skip} skipped`
  );
  lines.push(`  Total: ${report.summary.total} steps in ${report.elapsed_ms}ms`);
  lines.push("");
  lines.push(renderSummaryConclusion(report.summary));
  return lines.join("\n");
}

export async function runInit(config, options = {}, internal = {}) {
  const startedAt = Date.now();
  const runDoctorImpl = internal.runDoctor || runDoctor;
  const buildCodeIndexImpl = internal.buildCodeIndex || buildCodeIndex;
  const buildSyntaxIndexImpl = internal.buildSyntaxIndex || buildSyntaxIndex;
  const buildSemanticGraphImpl = internal.buildSemanticGraph || buildSemanticGraph;
  const buildVectorIndexImpl = internal.buildVectorIndex || buildVectorIndex;
  const getMemoryStatsImpl = internal.getMemoryStats || getMemoryStats;

  const root = path.resolve(config.workspaceRoot);
  const steps = [];
  let codeStepFailed = false;

  const commonCodeArgs = {};
  if (Number.isFinite(options.maxFiles)) {
    commonCodeArgs.max_files = options.maxFiles;
  }
  if (Number.isFinite(options.maxFileSizeKb)) {
    commonCodeArgs.max_file_size_kb = options.maxFileSizeKb;
  }

  const doctorStep = await executeStep(
    {
      id: "doctor",
      title: "Doctor preflight",
      enabled: options.includeDoctor !== false,
      required: false,
      skipMessage: "disabled",
      run: async () => runDoctorImpl(config)
    }
  );
  steps.push(doctorStep);

  const codeStep = await executeStep(
    {
      id: "code_index",
      title: "Build code index",
      enabled: true,
      required: true,
      run: async () => buildCodeIndexImpl(root, commonCodeArgs)
    }
  );
  steps.push(codeStep);
  if (codeStep.status === STATUS.FAIL) {
    codeStepFailed = true;
  }

  const syntaxStep = await executeStep(
    {
      id: "syntax_index",
      title: "Build syntax index",
      enabled: options.includeSyntax !== false && !codeStepFailed,
      required: true,
      skipMessage: codeStepFailed ? "blocked: code index failed" : "disabled",
      run: async () =>
        buildSyntaxIndexImpl(root, {
          ...(Number.isFinite(options.maxFiles) ? { max_files: options.maxFiles } : {})
        })
    }
  );
  steps.push(syntaxStep);

  const semanticArgs = {};
  if (typeof options.semanticSeedLangFilter === "string" && options.semanticSeedLangFilter) {
    semanticArgs.semantic_seed_lang_filter = options.semanticSeedLangFilter;
  }
  const semanticStep = await executeStep(
    {
      id: "semantic_graph",
      title: "Build semantic graph",
      enabled: options.includeSemantic !== false && !codeStepFailed,
      required: true,
      skipMessage: codeStepFailed ? "blocked: code index failed" : "disabled",
      run: async () => buildSemanticGraphImpl(root, semanticArgs, config.lsp || {})
    }
  );
  steps.push(semanticStep);

  const vectorStep = await executeStep(
    {
      id: "vector_index",
      title: "Build vector index",
      enabled: options.includeVector === true && !codeStepFailed,
      required: false,
      skipMessage: options.includeVector === true ? "blocked: code index failed" : "disabled",
      run: async () =>
        buildVectorIndexImpl(
          root,
          {
            layer: options.vectorLayer || "base"
          },
          {
            embedding: config.embedding || {}
          }
        )
    }
  );
  steps.push(vectorStep);

  if (config?.memory?.enabled === true) {
    const memoryStep = await executeStep({
      id: "memory_status",
      title: "Memory status",
      enabled: true,
      required: false,
      run: async () =>
        getMemoryStatsImpl(root, {
          homeDir: config?.sources?.homeDir,
          scope: config?.memory?.scope || "project+global"
        })
    });
    steps.push(memoryStep);
  }

  const summary = summarizeSteps(steps);
  return {
    ok: summary.fail === 0,
    generated_at: new Date().toISOString(),
    workspace_root: root,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    options: {
      include_doctor: options.includeDoctor !== false,
      include_syntax: options.includeSyntax !== false,
      include_semantic: options.includeSemantic !== false,
      include_vector: options.includeVector === true,
      vector_layer: options.vectorLayer || "base",
      max_files: Number.isFinite(options.maxFiles) ? options.maxFiles : null,
      max_file_size_kb: Number.isFinite(options.maxFileSizeKb) ? options.maxFileSizeKb : null,
      semantic_seed_lang_filter: options.semanticSeedLangFilter || null
    },
    summary,
    steps
  };
}
