import path from "node:path";
import { getIndexStats } from "./code-index.js";
import { getSyntaxIndexStats } from "./syntax-index.js";
import { getSemanticGraphStats } from "./semantic-graph.js";
import { getVectorIndexStats } from "./vector-index.js";
import { getMemoryStats } from "./memory.js";
import { loadConfig } from "./config.js";

const MCP_SERVER_VERSION = "0.1.0";

function safeAsync(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

function redactConfig(config) {
  const redacted = { ...config };
  if (redacted.apiKey) {
    redacted.apiKey = `${redacted.apiKey.slice(0, 6)}***`;
  }
  if (redacted.embedding && typeof redacted.embedding === "object") {
    redacted.embedding = { ...redacted.embedding };
    if (redacted.embedding.apiKey) {
      redacted.embedding.apiKey = `${redacted.embedding.apiKey.slice(0, 6)}***`;
    }
  }
  return redacted;
}

function flattenCodeIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_files: counts.files ?? 0,
    total_chunks: counts.chunks ?? 0,
    total_symbols: counts.symbols ?? 0,
    total_symbol_terms: counts.symbol_terms ?? 0,
    unique_tokens: counts.unique_tokens ?? 0
  };
}

function flattenSyntaxIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_files: counts.files ?? 0,
    total_imports: counts.import_edges ?? 0,
    total_calls: counts.call_edges ?? 0
  };
}

function flattenSemanticGraphStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_nodes: counts.nodes ?? 0,
    total_edges: counts.edges ?? 0
  };
}

function flattenVectorIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  const chunks = counts.chunks || {};
  const files = counts.files || {};
  return {
    ...raw,
    total_chunks: chunks.total ?? 0,
    layers: { base: chunks.base ?? 0, delta: chunks.delta ?? 0 },
    total_files_base: files.base ?? 0,
    total_files_delta: files.delta ?? 0
  };
}

async function collectIndexSummary(workspaceRoot) {
  const [code, syntax, semantic, vector] = await Promise.allSettled([
    getIndexStats(workspaceRoot),
    getSyntaxIndexStats(workspaceRoot),
    getSemanticGraphStats(workspaceRoot),
    getVectorIndexStats(workspaceRoot)
  ]);
  const codeVal = code.status === "fulfilled" ? flattenCodeIndexStats(code.value) : null;
  const syntaxVal = syntax.status === "fulfilled" ? flattenSyntaxIndexStats(syntax.value) : null;
  const semanticVal = semantic.status === "fulfilled" ? flattenSemanticGraphStats(semantic.value) : null;
  const vectorVal = vector.status === "fulfilled" ? flattenVectorIndexStats(vector.value) : null;
  return {
    code_files: codeVal?.ok !== false ? (codeVal?.total_files ?? null) : null,
    syntax_files: syntaxVal?.ok !== false ? (syntaxVal?.total_files ?? null) : null,
    semantic_nodes: semanticVal?.ok !== false ? (semanticVal?.total_nodes ?? null) : null,
    vector_chunks: vectorVal?.ok !== false ? (vectorVal?.total_chunks ?? null) : null
  };
}

function flattenMemoryStats(stats) {
  const counts = stats?.counts || {};
  return {
    ok: stats?.ok ?? false,
    db_path: stats?.db_path ?? null,
    scope: stats?.scope ?? null,
    workspace_root: stats?.workspace_root ?? null,
    total_lessons: counts.lessons ?? 0,
    quarantined: counts.quarantined_lessons ?? 0,
    total_episodes: counts.episodes ?? 0,
    total_feedback: counts.feedback ?? 0,
    top_lessons: stats?.top_lessons ?? [],
    top_tags: stats?.top_tags ?? []
  };
}

async function collectMemorySummary(workspaceRoot, options) {
  try {
    const stats = await getMemoryStats(workspaceRoot, options);
    const flat = flattenMemoryStats(stats);
    return {
      ok: true,
      total_lessons: flat.total_lessons
    };
  } catch {
    return { ok: false, total_lessons: 0 };
  }
}

export function createDashboardRouter(serverOptions, tools, logger) {
  const workspaceRoot = serverOptions.workspaceRoot || process.cwd();
  const memoryOptions = {
    homeDir: undefined,
    scope: "project+global"
  };

  const handlers = {
    overview: safeAsync(async () => {
      const [indexes, memory] = await Promise.all([
        collectIndexSummary(workspaceRoot),
        collectMemorySummary(workspaceRoot, memoryOptions)
      ]);
      return {
        server: {
          version: MCP_SERVER_VERSION,
          transport: serverOptions.transport,
          host: serverOptions.host,
          port: serverOptions.port,
          workspace_root: workspaceRoot,
          toolsets: Array.from(serverOptions.enabledToolsets || []),
          expose_low_level: serverOptions.exposeLowLevel || false
        },
        indexes,
        memory
      };
    }),

    "index-stats": safeAsync(async () => {
      const [code, syntax, semantic, vector] = await Promise.allSettled([
        getIndexStats(workspaceRoot),
        getSyntaxIndexStats(workspaceRoot),
        getSemanticGraphStats(workspaceRoot),
        getVectorIndexStats(workspaceRoot)
      ]);
      return {
        code: code.status === "fulfilled" ? flattenCodeIndexStats(code.value) : { ok: false, error: code.reason?.message },
        syntax: syntax.status === "fulfilled" ? flattenSyntaxIndexStats(syntax.value) : { ok: false, error: syntax.reason?.message },
        semantic: semantic.status === "fulfilled" ? flattenSemanticGraphStats(semantic.value) : { ok: false, error: semantic.reason?.message },
        vector: vector.status === "fulfilled" ? flattenVectorIndexStats(vector.value) : { ok: false, error: vector.reason?.message }
      };
    }),

    "memory-stats": safeAsync(async () => {
      const raw = await getMemoryStats(workspaceRoot, memoryOptions);
      return flattenMemoryStats(raw);
    }),

    metrics: safeAsync(async () => {
      const { buildReport } = await import("../scripts/metrics-report.mjs");
      const { buildTunerReport } = await import("../scripts/tuner-report.mjs");
      const [metrics, tuner] = await Promise.allSettled([
        buildReport({ workspaceRoot, windowHours: 24, format: "json" }),
        buildTunerReport({ workspaceRoot, windowHours: 24, format: "json" })
      ]);
      return {
        metrics: metrics.status === "fulfilled" ? metrics.value : null,
        tuner: tuner.status === "fulfilled" ? tuner.value : null
      };
    }),

    config: safeAsync(async () => {
      const config = loadConfig({ allowMissingApiKey: true });
      return redactConfig(config);
    }),

    tools: safeAsync(async () => {
      return {
        tools: (tools || []).map((t) => ({
          name: t.name,
          description: t.description || "",
          category: categorize(t.name)
        }))
      };
    })
  };

  function categorize(name) {
    if (name.startsWith("search_") || name.startsWith("get_code") || name.startsWith("explain_") || name.startsWith("go_to_") || name.startsWith("find_") || name.startsWith("trace_") || name.startsWith("impact_")) return "analysis";
    if (name.startsWith("monitor_") || name.startsWith("metrics_") || name.startsWith("tuner_")) return "monitoring";
    if (name.startsWith("reindex_")) return "operations";
    if (name.startsWith("lsp_") || name.startsWith("build_") || name.startsWith("refresh_") || name.startsWith("query_")) return "low-level";
    return "general";
  }

  return async function handleDashboardApi(pathname) {
    const route = pathname.replace(/^\/api\/dashboard\/?/, "").replace(/\/$/, "") || "overview";
    const handler = handlers[route];
    if (!handler) {
      return {
        statusCode: 404,
        body: { ok: false, error: `Unknown dashboard API route: ${route}` }
      };
    }
    const result = await handler();
    return { statusCode: 200, body: result };
  };
}
