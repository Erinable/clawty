import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRuntimeLogger } from "./logger.js";
import {
  callMonitorTool as callMonitorToolModule,
  MONITOR_TOOL_DEFINITIONS,
  MONITOR_TOOL_NAME_SET
} from "./mcp-monitor-tools.js";
import {
  parseMcpServerArgsWithDeps,
  resolveMcpServerRuntimeOptionsWithDeps
} from "./mcp-server-options.js";
import { buildRpcError, handleRpcRequestWithDeps } from "./mcp-server-rpc.js";
import {
  normalizeHost,
  normalizePort,
  normalizeServerOptionsWithDeps,
  normalizeTransport
} from "./mcp-server-runtime-options.js";
import {
  findHeaderTerminator,
  parseContentLength,
  readHttpRequestBody,
  writeJsonResponse,
  writeMessage,
  writeNoContent
} from "./mcp-transport-utils.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

const MCP_SERVER_NAME = "clawty-mcp";
const MCP_SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const TOOLSET_ANALYSIS = "analysis";
const TOOLSET_EDIT_SAFE = "edit-safe";
const TOOLSET_OPS = "ops";
const TOOLSET_ALL = "all";
const DEFAULT_TOOLSETS = [TOOLSET_ANALYSIS, TOOLSET_OPS];

const FACADE_TOOL_DEFINITIONS = [
  {
    name: "search_code",
    description:
      "Search code with strategy routing (hybrid/index/vector) and automatic fallback.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Search query."
        },
        top_k: {
          type: "integer",
          description: "Maximum result count.",
          minimum: 1,
          maximum: 50
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        },
        strategy: {
          type: "string",
          description: "Routing strategy: auto|hybrid|keyword|vector.",
          enum: ["auto", "hybrid", "keyword", "vector"]
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "go_to_definition",
    description: "Find symbol definition using LSP-first navigation.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Workspace-relative file path."
        },
        line: {
          type: "integer",
          description: "1-based line number.",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "1-based column number.",
          minimum: 1
        },
        max_results: {
          type: "integer",
          description: "Maximum locations returned.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    name: "find_references",
    description: "Find symbol references using LSP-first navigation.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Workspace-relative file path."
        },
        line: {
          type: "integer",
          description: "1-based line number.",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "1-based column number.",
          minimum: 1
        },
        include_declaration: {
          type: "boolean",
          description: "Include declaration in reference results."
        },
        max_results: {
          type: "integer",
          description: "Maximum locations returned.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    name: "get_code_context",
    description:
      "Return combined code context for a query (search hits + semantic neighbors).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Context query."
        },
        top_k: {
          type: "integer",
          description: "Maximum context hits returned.",
          minimum: 1,
          maximum: 30
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "reindex_codebase",
    description:
      "Run code-intelligence refresh pipeline (code index + syntax index + semantic graph).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        force_full: {
          type: "boolean",
          description: "When true, run full rebuild instead of incremental refresh."
        },
        changed_paths: {
          type: "array",
          description: "Changed file paths (workspace-relative).",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Deleted file paths (workspace-relative).",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "monitor_system",
    description: "Return combined runtime monitoring report (metrics + tuner).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        window_hours: {
          type: "number",
          description: "Optional report window in hours."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "explain_code",
    description:
      "Read and explain a target file context by path or query (auto-locates best matching file).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file path."
        },
        query: {
          type: "string",
          description: "Optional query used to locate target file when path is not provided."
        },
        max_chars: {
          type: "integer",
          description: "Maximum file chars to return.",
          minimum: 200,
          maximum: 100000
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "trace_call_chain",
    description:
      "Trace call relationships using semantic graph + syntax index for a symbol/query.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Symbol or keyword to trace."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed nodes/files returned.",
          minimum: 1,
          maximum: 20
        },
        max_hops: {
          type: "integer",
          description: "Maximum semantic traversal hops.",
          minimum: 1,
          maximum: 4
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "impact_analysis",
    description:
      "Estimate change impact from a location (path+line+column) or query across references and semantic neighbors.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Optional symbol/keyword when location is not provided."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file path."
        },
        line: {
          type: "integer",
          description: "Optional 1-based line number (with path+column).",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "Optional 1-based column number (with path+line).",
          minimum: 1
        },
        top_k: {
          type: "integer",
          description: "Maximum search hits.",
          minimum: 1,
          maximum: 30
        },
        max_paths: {
          type: "integer",
          description: "Maximum impacted paths returned.",
          minimum: 1,
          maximum: 200
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        }
      },
      additionalProperties: false
    }
  }
];

const FACADE_TOOL_NAME_SET = new Set(FACADE_TOOL_DEFINITIONS.map((tool) => tool.name));
const FACADE_TOOLSET_MAP = {
  [TOOLSET_ANALYSIS]: new Set([
    "search_code",
    "go_to_definition",
    "find_references",
    "get_code_context",
    "explain_code",
    "trace_call_chain",
    "impact_analysis"
  ]),
  [TOOLSET_EDIT_SAFE]: new Set(["reindex_codebase"]),
  [TOOLSET_OPS]: new Set(["monitor_system"])
};
const VALID_TOOLSETS = new Set([
  TOOLSET_ANALYSIS,
  TOOLSET_EDIT_SAFE,
  TOOLSET_OPS,
  TOOLSET_ALL
]);

const LOW_LEVEL_CODE_TOOL_NAMES = new Set([
  "read_file",
  "build_code_index",
  "refresh_code_index",
  "query_code_index",
  "get_index_stats",
  "build_semantic_graph",
  "refresh_semantic_graph",
  "import_precise_index",
  "query_semantic_graph",
  "get_semantic_graph_stats",
  "build_syntax_index",
  "refresh_syntax_index",
  "query_syntax_index",
  "get_syntax_index_stats",
  "build_vector_index",
  "refresh_vector_index",
  "query_vector_index",
  "get_vector_index_stats",
  "merge_vector_delta",
  "query_hybrid_index",
  "lsp_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_health"
]);

const LOW_LEVEL_CODE_TOOL_DEFINITIONS = TOOL_DEFINITIONS
  .filter((tool) => tool?.type === "function" && LOW_LEVEL_CODE_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters
  }));

const LOW_LEVEL_CODE_TOOL_NAME_SET = new Set(
  LOW_LEVEL_CODE_TOOL_DEFINITIONS.map((tool) => tool.name)
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logWith(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, fields);
}

function parseToolsetTokens(input) {
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => parseToolsetTokens(item))
      .filter((item) => typeof item === "string");
  }
  if (typeof input !== "string") {
    return [];
  }
  return input
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveEnabledToolsets(toolsetsInput) {
  const requested = new Set(parseToolsetTokens(toolsetsInput));
  if (requested.size === 0) {
    return new Set(DEFAULT_TOOLSETS);
  }
  if (requested.has(TOOLSET_ALL)) {
    return new Set([TOOLSET_ANALYSIS, TOOLSET_EDIT_SAFE, TOOLSET_OPS]);
  }
  const enabled = new Set();
  for (const token of requested) {
    if (!VALID_TOOLSETS.has(token)) {
      throw new Error(`Unknown toolset: ${token}. Expected one of: analysis, edit-safe, ops, all`);
    }
    enabled.add(token);
  }
  if (enabled.size === 0) {
    return new Set(DEFAULT_TOOLSETS);
  }
  return enabled;
}

function resolveFacadeToolNamesForToolsets(toolsets) {
  const enabledToolsets = toolsets instanceof Set ? toolsets : new Set(DEFAULT_TOOLSETS);
  const names = new Set();
  for (const toolsetName of enabledToolsets) {
    const mapping = FACADE_TOOLSET_MAP[toolsetName];
    if (!mapping) {
      continue;
    }
    for (const toolName of mapping) {
      names.add(toolName);
    }
  }
  return names;
}

function buildToolDefinitions(serverOptions = {}) {
  const exposedFacadeToolNames =
    serverOptions.exposedFacadeToolNames instanceof Set
      ? serverOptions.exposedFacadeToolNames
      : resolveFacadeToolNamesForToolsets(new Set(DEFAULT_TOOLSETS));
  const exposedFacadeTools = FACADE_TOOL_DEFINITIONS.filter((tool) =>
    exposedFacadeToolNames.has(tool.name)
  );
  if (serverOptions.exposeLowLevel) {
    return [
      ...exposedFacadeTools,
      ...MONITOR_TOOL_DEFINITIONS,
      ...LOW_LEVEL_CODE_TOOL_DEFINITIONS
    ];
  }
  return exposedFacadeTools;
}

function splitWorkspaceArg(args, fallbackWorkspace) {
  const normalizedArgs = isPlainObject(args) ? { ...args } : {};
  let workspaceRoot = path.resolve(fallbackWorkspace || process.cwd());
  if (typeof normalizedArgs.workspace === "string" && normalizedArgs.workspace.trim().length > 0) {
    workspaceRoot = path.resolve(normalizedArgs.workspace.trim());
  }
  delete normalizedArgs.workspace;
  return {
    workspaceRoot,
    toolArgs: normalizedArgs
  };
}

function createToolContext(workspaceRoot, serverOptions = {}) {
  return {
    workspaceRoot,
    toolTimeoutMs: serverOptions.toolTimeoutMs,
    lsp: serverOptions.lsp || {},
    embedding: serverOptions.embedding || {},
    metrics: serverOptions.metrics || {},
    onlineTuner: serverOptions.onlineTuner || {}
  };
}

function toFiniteInteger(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const rounded = Math.trunc(number);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function normalizeSearchStrategy(value) {
  if (typeof value !== "string") {
    return "auto";
  }
  const normalized = value.trim().toLowerCase();
  if (["auto", "hybrid", "keyword", "vector"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function looksLikeSymbolQuery(query) {
  if (typeof query !== "string") {
    return false;
  }
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z_$][\w.$:/-]*$/.test(trimmed);
}

function pickAutoSearchStrategy(query) {
  if (looksLikeSymbolQuery(query)) {
    return "keyword";
  }
  return "hybrid";
}

function countResultItems(payload) {
  if (!isPlainObject(payload)) {
    return 0;
  }
  if (Array.isArray(payload.results)) {
    return payload.results.length;
  }
  if (Array.isArray(payload.locations)) {
    return payload.locations.length;
  }
  return 0;
}

function isArrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function callLowLevelCodeTool(name, args, serverOptions = {}) {
  const { workspaceRoot, toolArgs } = splitWorkspaceArg(args, serverOptions.workspaceRoot);
  const toolContext = createToolContext(workspaceRoot, serverOptions);
  return runTool(name, toolArgs, toolContext);
}

async function runSearchStrategy(strategy, args, serverOptions = {}) {
  if (strategy === "keyword") {
    return callLowLevelCodeTool(
      "query_code_index",
      {
        ...args,
        explain: true
      },
      serverOptions
    );
  }
  if (strategy === "vector") {
    return callLowLevelCodeTool("query_vector_index", args, serverOptions);
  }
  return callLowLevelCodeTool(
    "query_hybrid_index",
    {
      ...args,
      explain: true
    },
    serverOptions
  );
}

function buildSearchPlan(strategy, query) {
  const requested = normalizeSearchStrategy(strategy);
  if (requested === "auto") {
    const selected = pickAutoSearchStrategy(query);
    if (selected === "keyword") {
      return ["keyword", "hybrid"];
    }
    return ["hybrid", "keyword"];
  }
  if (requested === "keyword") {
    return ["keyword", "hybrid"];
  }
  if (requested === "vector") {
    return ["vector", "hybrid", "keyword"];
  }
  return ["hybrid", "keyword"];
}

async function callSearchCodeFacade(args, serverOptions = {}) {
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("search_code requires non-empty string argument: query");
  }

  const searchArgs = {
    workspace: args.workspace,
    query: args.query.trim(),
    top_k: toFiniteInteger(args.top_k, 10, 1, 50),
    path_prefix: typeof args.path_prefix === "string" ? args.path_prefix : undefined,
    language: typeof args.language === "string" ? args.language : undefined
  };
  const plannedStrategies = buildSearchPlan(args.strategy, searchArgs.query);
  const attempted = [];
  let selected = null;

  for (const strategy of plannedStrategies) {
    const attempt = {
      strategy,
      ok: false,
      result_count: 0
    };
    try {
      const payload = await runSearchStrategy(strategy, searchArgs, serverOptions);
      attempt.ok = payload?.ok === true;
      attempt.result_count = countResultItems(payload);
      if (attempt.ok && selected === null) {
        selected = {
          strategy,
          payload
        };
      }
      if (attempt.ok && attempt.result_count > 0) {
        selected = {
          strategy,
          payload
        };
        attempted.push(attempt);
        break;
      }
    } catch (error) {
      attempt.error = error?.message || String(error);
    }
    attempted.push(attempt);
  }

  if (!selected) {
    return {
      ok: false,
      query: searchArgs.query,
      strategy_requested: normalizeSearchStrategy(args.strategy),
      strategy_used: null,
      attempted_strategies: attempted,
      error: "no strategy produced a successful result"
    };
  }

  const payload = selected.payload;
  return {
    ok: payload?.ok === true,
    query: searchArgs.query,
    strategy_requested: normalizeSearchStrategy(args.strategy),
    strategy_used: selected.strategy,
    attempted_strategies: attempted,
    provider: payload?.provider || null,
    fallback: payload?.fallback === true,
    results: Array.isArray(payload?.results) ? payload.results : [],
    raw: payload
  };
}

async function callGoToDefinitionFacade(args, serverOptions = {}) {
  return callLowLevelCodeTool("lsp_definition", args, serverOptions);
}

async function callFindReferencesFacade(args, serverOptions = {}) {
  return callLowLevelCodeTool("lsp_references", args, serverOptions);
}

async function callCodeContextFacade(args, serverOptions = {}) {
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("get_code_context requires non-empty string argument: query");
  }

  const query = args.query.trim();
  const topK = toFiniteInteger(args.top_k, 8, 1, 30);
  const search = await callSearchCodeFacade(
    {
      workspace: args.workspace,
      query,
      top_k: topK,
      path_prefix: args.path_prefix,
      language: args.language,
      strategy: "auto"
    },
    serverOptions
  );

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: args.workspace,
        query,
        top_k: Math.min(topK, 10),
        max_neighbors: 20
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  return {
    ok: search.ok === true,
    query,
    strategy_used: search.strategy_used,
    search_hits: search.results,
    search,
    semantic
  };
}

async function callReindexCodebaseFacade(args, serverOptions = {}) {
  const safeArgs = isPlainObject(args) ? args : {};
  const changedPaths = isArrayOfStrings(safeArgs.changed_paths) ? safeArgs.changed_paths : undefined;
  const deletedPaths = isArrayOfStrings(safeArgs.deleted_paths) ? safeArgs.deleted_paths : undefined;
  const forceFull = safeArgs.force_full === true;
  const baseArgs = {
    workspace: safeArgs.workspace
  };

  const steps = [];
  if (forceFull) {
    steps.push(["build_code_index", {}]);
    steps.push(["build_syntax_index", {}]);
    steps.push(["build_semantic_graph", {}]);
  } else {
    const refreshArgs = {};
    if (changedPaths) {
      refreshArgs.changed_paths = changedPaths;
    }
    if (deletedPaths) {
      refreshArgs.deleted_paths = deletedPaths;
    }
    steps.push(["refresh_code_index", refreshArgs]);
    steps.push(["refresh_syntax_index", refreshArgs]);
    steps.push(["refresh_semantic_graph", refreshArgs]);
  }

  const results = [];
  let ok = true;
  for (const [name, toolArgs] of steps) {
    try {
      const payload = await callLowLevelCodeTool(name, { ...baseArgs, ...toolArgs }, serverOptions);
      const stepOk = payload?.ok === true;
      results.push({
        tool: name,
        ok: stepOk,
        result: payload
      });
      if (!stepOk) {
        ok = false;
      }
    } catch (error) {
      ok = false;
      results.push({
        tool: name,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  return {
    ok,
    mode: forceFull ? "full" : "refresh",
    steps: results
  };
}

function collectPathsFromSearchResult(payload) {
  const paths = [];
  if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
    return paths;
  }
  for (const item of payload.results) {
    if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
      paths.push(item.path.trim());
    }
  }
  return paths;
}

function collectPathsFromSemanticResult(payload) {
  const paths = [];
  if (!isPlainObject(payload) || !Array.isArray(payload.seeds)) {
    return paths;
  }

  for (const seed of payload.seeds) {
    if (isPlainObject(seed) && typeof seed.path === "string" && seed.path.trim()) {
      paths.push(seed.path.trim());
    }
    const outgoing = Array.isArray(seed?.outgoing) ? seed.outgoing : [];
    for (const item of outgoing) {
      if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
        paths.push(item.path.trim());
      }
    }
    const incoming = Array.isArray(seed?.incoming) ? seed.incoming : [];
    for (const item of incoming) {
      if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
        paths.push(item.path.trim());
      }
    }
  }

  return paths;
}

function dedupePaths(paths, maxPaths = 100) {
  const deduped = [];
  const seen = new Set();
  for (const rawPath of paths) {
    if (typeof rawPath !== "string") {
      continue;
    }
    const normalized = rawPath.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= maxPaths) {
      break;
    }
  }
  return deduped;
}

async function callExplainCodeFacade(args, serverOptions = {}) {
  const safeArgs = isPlainObject(args) ? args : {};
  let targetPath =
    typeof safeArgs.path === "string" && safeArgs.path.trim() ? safeArgs.path.trim() : null;
  let search = null;

  if (!targetPath) {
    if (typeof safeArgs.query !== "string" || !safeArgs.query.trim()) {
      throw new Error("explain_code requires path or query");
    }
    search = await callSearchCodeFacade(
      {
        workspace: safeArgs.workspace,
        query: safeArgs.query.trim(),
        top_k: 1,
        path_prefix: safeArgs.path_prefix,
        language: safeArgs.language,
        strategy: "auto"
      },
      serverOptions
    );
    targetPath = Array.isArray(search.results) ? search.results[0]?.path || null : null;
    if (!targetPath) {
      return {
        ok: false,
        error: "no matching file found for query",
        query: safeArgs.query.trim(),
        search
      };
    }
  }

  const maxChars = toFiniteInteger(safeArgs.max_chars, 2400, 200, 100_000);
  const file = await callLowLevelCodeTool(
    "read_file",
    {
      workspace: safeArgs.workspace,
      path: targetPath,
      max_chars: maxChars
    },
    serverOptions
  );

  const content = typeof file?.content === "string" ? file.content : "";
  return {
    ok: file?.ok === true,
    path: targetPath,
    max_chars: maxChars,
    content,
    content_preview: content.slice(0, Math.min(content.length, 1200)),
    search
  };
}

async function callTraceCallChainFacade(args, serverOptions = {}) {
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("trace_call_chain requires non-empty string argument: query");
  }

  const query = args.query.trim();
  const topK = toFiniteInteger(args.top_k, 5, 1, 20);
  const maxHops = toFiniteInteger(args.max_hops, 2, 1, 4);
  const pathPrefix = typeof args.path_prefix === "string" ? args.path_prefix : undefined;

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: args.workspace,
        query,
        top_k: topK,
        max_neighbors: 30,
        max_hops: maxHops,
        path_prefix: pathPrefix
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  let syntax = null;
  try {
    syntax = await callLowLevelCodeTool(
      "query_syntax_index",
      {
        workspace: args.workspace,
        query,
        top_k: topK,
        max_neighbors: 30,
        path_prefix: pathPrefix
      },
      serverOptions
    );
  } catch (error) {
    syntax = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  return {
    ok: semantic?.ok === true || syntax?.ok === true,
    query,
    semantic,
    syntax,
    summary: {
      semantic_seed_count: Array.isArray(semantic?.seeds) ? semantic.seeds.length : 0,
      syntax_seed_count: Array.isArray(syntax?.seeds) ? syntax.seeds.length : 0
    }
  };
}

function hasLocationArgs(args) {
  if (!isPlainObject(args)) {
    return false;
  }
  return (
    typeof args.path === "string" &&
    args.path.trim() &&
    Number.isFinite(Number(args.line)) &&
    Number(args.line) > 0 &&
    Number.isFinite(Number(args.column)) &&
    Number(args.column) > 0
  );
}

function collectReferencePaths(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.locations)) {
    return [];
  }
  const paths = [];
  for (const location of payload.locations) {
    if (isPlainObject(location) && typeof location.path === "string" && location.path.trim()) {
      paths.push(location.path.trim());
    }
  }
  return paths;
}

async function callImpactAnalysisFacade(args, serverOptions = {}) {
  const safeArgs = isPlainObject(args) ? args : {};
  const maxPaths = toFiniteInteger(safeArgs.max_paths, 60, 1, 200);

  if (hasLocationArgs(safeArgs)) {
    const line = toFiniteInteger(safeArgs.line, 1, 1, 1_000_000);
    const column = toFiniteInteger(safeArgs.column, 1, 1, 1_000_000);
    const baseArgs = {
      workspace: safeArgs.workspace,
      path: safeArgs.path.trim(),
      line,
      column,
      max_results: toFiniteInteger(safeArgs.max_results, 200, 1, 1000),
      include_declaration: safeArgs.include_declaration === true
    };

    const [definition, references] = await Promise.all([
      callGoToDefinitionFacade(baseArgs, serverOptions).catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      })),
      callFindReferencesFacade(baseArgs, serverOptions).catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      }))
    ]);

    const impactedPaths = dedupePaths(
      [...collectReferencePaths(definition), ...collectReferencePaths(references)],
      maxPaths
    );

    return {
      ok: definition?.ok === true || references?.ok === true,
      mode: "location",
      input: {
        path: baseArgs.path,
        line,
        column
      },
      impacted_paths: impactedPaths,
      definition,
      references
    };
  }

  if (typeof safeArgs.query !== "string" || !safeArgs.query.trim()) {
    throw new Error("impact_analysis requires query or location(path+line+column)");
  }

  const query = safeArgs.query.trim();
  const topK = toFiniteInteger(safeArgs.top_k, 10, 1, 30);
  const search = await callSearchCodeFacade(
    {
      workspace: safeArgs.workspace,
      query,
      top_k: topK,
      path_prefix: safeArgs.path_prefix,
      language: safeArgs.language,
      strategy: "auto"
    },
    serverOptions
  );

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: safeArgs.workspace,
        query,
        top_k: Math.min(topK, 12),
        max_neighbors: 25,
        max_hops: 2,
        path_prefix: safeArgs.path_prefix
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  const impactedPaths = dedupePaths(
    [...collectPathsFromSearchResult(search), ...collectPathsFromSemanticResult(semantic)],
    maxPaths
  );

  return {
    ok: search?.ok === true || semantic?.ok === true,
    mode: "query",
    query,
    strategy_used: search?.strategy_used || null,
    impacted_paths: impactedPaths,
    search,
    semantic
  };
}

async function callMonitorTool(name, args, serverOptions = {}) {
  return callMonitorToolModule(
    name,
    args,
    serverOptions.workspaceRoot
  );
}

const FACADE_TOOL_HANDLERS = {
  monitor_system: (args, serverOptions) => callMonitorTool("monitor_report", args, serverOptions),
  search_code: callSearchCodeFacade,
  go_to_definition: callGoToDefinitionFacade,
  find_references: callFindReferencesFacade,
  get_code_context: callCodeContextFacade,
  reindex_codebase: callReindexCodebaseFacade,
  explain_code: callExplainCodeFacade,
  trace_call_chain: callTraceCallChainFacade,
  impact_analysis: callImpactAnalysisFacade
};

async function callTool(name, args, serverOptions = {}) {
  const exposedFacadeToolNames =
    serverOptions.exposedFacadeToolNames instanceof Set
      ? serverOptions.exposedFacadeToolNames
      : resolveFacadeToolNamesForToolsets(new Set(DEFAULT_TOOLSETS));
  if (FACADE_TOOL_NAME_SET.has(name) && !exposedFacadeToolNames.has(name)) {
    throw new Error(`Tool not exposed by current policy: ${name}`);
  }

  const facadeHandler = FACADE_TOOL_HANDLERS[name];
  if (typeof facadeHandler === "function") {
    return facadeHandler(args, serverOptions);
  }

  if (MONITOR_TOOL_NAME_SET.has(name)) {
    if (!serverOptions.exposeLowLevel) {
      throw new Error(`Tool not exposed by current policy: ${name}`);
    }
    return callMonitorTool(name, args, serverOptions);
  }

  if (LOW_LEVEL_CODE_TOOL_NAME_SET.has(name)) {
    if (!serverOptions.exposeLowLevel) {
      throw new Error(`Tool not exposed by current policy: ${name}`);
    }
    return callLowLevelCodeTool(name, args, serverOptions);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function normalizeServerOptions(options = {}) {
  return normalizeServerOptionsWithDeps(options, {
    resolvePath: path.resolve,
    resolveEnabledToolsets,
    resolveFacadeToolNamesForToolsets,
    isPlainObject
  });
}

async function handleRpcRequest(request, serverOptions, tools, logger) {
  return handleRpcRequestWithDeps(
    request,
    {
      serverOptions,
      tools,
      logger
    },
    {
      callTool,
      logWith,
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverName: MCP_SERVER_NAME,
      serverVersion: MCP_SERVER_VERSION,
      buildRpcError
    }
  );
}

async function runStdioTransport(serverOptions, tools, logger) {
  let rawBuffer = Buffer.alloc(0);
  let shouldExit = false;

  const handlePayload = async (payloadText) => {
    const payload = payloadText.trim();
    if (!payload) {
      return;
    }

    let request;
    try {
      request = JSON.parse(payload);
    } catch {
      writeMessage(buildRpcError(null, -32700, "Parse error"));
      logWith(logger, "warn", "mcp.parse_error");
      return;
    }

    const { response, shouldExit: shouldClose } = await handleRpcRequest(
      request,
      serverOptions,
      tools,
      logger
    );
    if (response) {
      writeMessage(response);
    }
    if (shouldClose) {
      shouldExit = true;
    }
  };

  const parseNextPayload = () => {
    if (rawBuffer.length === 0) {
      return null;
    }

    let skip = 0;
    while (skip < rawBuffer.length) {
      const code = rawBuffer[skip];
      if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) {
        break;
      }
      skip += 1;
    }
    if (skip > 0) {
      rawBuffer = rawBuffer.slice(skip);
    }
    if (rawBuffer.length === 0) {
      return null;
    }

    const firstByte = rawBuffer[0];
    if (firstByte === 0x7b || firstByte === 0x5b) {
      const newlineIndex = rawBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return null;
      }
      const payload = rawBuffer.slice(0, newlineIndex).toString("utf8");
      rawBuffer = rawBuffer.slice(newlineIndex + 1);
      return payload;
    }

    const headerTerminator = findHeaderTerminator(rawBuffer);
    if (!headerTerminator) {
      return null;
    }
    const headerEnd = headerTerminator.index;
    const headerBlock = rawBuffer.slice(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headerBlock);
    if (contentLength === null) {
      rawBuffer = rawBuffer.slice(headerEnd + headerTerminator.delimiterLength);
      writeMessage(buildRpcError(null, -32600, "Invalid Content-Length header"));
      return "";
    }

    const bodyStart = headerEnd + headerTerminator.delimiterLength;
    const bodyEnd = bodyStart + contentLength;
    if (rawBuffer.length < bodyEnd) {
      return null;
    }
    const payload = rawBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    rawBuffer = rawBuffer.slice(bodyEnd);
    return payload;
  };

  for await (const chunk of process.stdin) {
    rawBuffer = Buffer.concat([rawBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      const payload = parseNextPayload();
      if (payload === null) {
        break;
      }
      await handlePayload(payload);
      if (shouldExit) {
        logWith(logger, "info", "mcp.server_stop", { transport: "stdio" });
        return;
      }
    }
  }
}

async function runHttpTransport(serverOptions, tools, logger) {
  const host = serverOptions.host;
  const port = serverOptions.port;
  let serverRef = null;
  let closing = false;

  await new Promise((resolve, reject) => {
    const cleanupHandlers = [];
    const registerCleanup = (fn) => {
      cleanupHandlers.push(fn);
    };
    const runCleanup = () => {
      for (const fn of cleanupHandlers.splice(0)) {
        try {
          fn();
        } catch {
          // Best-effort cleanup.
        }
      }
    };
    const closeServer = () => {
      if (closing || !serverRef) {
        return;
      }
      closing = true;
      serverRef.close((error) => {
        runCleanup();
        if (error) {
          reject(error);
          return;
        }
        logWith(logger, "info", "mcp.server_stop", { transport: "http" });
        resolve();
      });
    };

    const handleSignal = () => {
      closeServer();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    registerCleanup(() => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    });

    const server = http.createServer(async (req, res) => {
      try {
        const method = String(req.method || "").toUpperCase();
        if (method === "GET" && (req.url === "/" || req.url === "/healthz")) {
          writeJsonResponse(res, 200, {
            ok: true,
            transport: "http",
            host,
            port
          });
          return;
        }
        if (method !== "POST") {
          writeJsonResponse(res, 405, {
            ok: false,
            error: "Method not allowed. Use POST for JSON-RPC payloads."
          });
          return;
        }

        const rawBody = await readHttpRequestBody(req);
        let request;
        try {
          request = JSON.parse(rawBody || "");
        } catch {
          logWith(logger, "warn", "mcp.parse_error");
          writeJsonResponse(res, 400, buildRpcError(null, -32700, "Parse error"));
          return;
        }

        const { response, shouldExit } = await handleRpcRequest(request, serverOptions, tools, logger);
        if (response) {
          writeJsonResponse(res, 200, response);
        } else {
          writeNoContent(res);
        }
        if (shouldExit) {
          setTimeout(closeServer, 0);
        }
      } catch (error) {
        logWith(logger, "error", "mcp.http_request_failed", { error });
        if (!res.headersSent) {
          writeJsonResponse(res, 500, buildRpcError(null, -32603, "Internal error"));
        } else {
          res.end();
        }
      }
    });

    serverRef = server;
    server.on("error", (error) => {
      runCleanup();
      reject(error);
    });
    server.listen(port, host, () => {
      logWith(logger, "info", "mcp.http_listening", { host, port });
    });
  });
}

export async function runMcpServer(options = {}) {
  const serverOptions = normalizeServerOptions(options);
  const logger = serverOptions.logger?.child
    ? serverOptions.logger.child({
        component: "mcp-server",
        context: {
          workspace_root: serverOptions.workspaceRoot
        }
      })
    : serverOptions.logger;
  const tools = buildToolDefinitions(serverOptions);
  logWith(logger, "info", "mcp.server_start", {
    transport: serverOptions.transport,
    host: serverOptions.transport === "http" ? serverOptions.host : null,
    port: serverOptions.transport === "http" ? serverOptions.port : null,
    expose_low_level: serverOptions.exposeLowLevel,
    toolsets: Array.from(serverOptions.enabledToolsets || [])
  });

  if (serverOptions.transport === "http") {
    await runHttpTransport(serverOptions, tools, logger);
    return;
  }
  await runStdioTransport(serverOptions, tools, logger);
}

export function parseMcpServerArgs(argv = []) {
  return parseMcpServerArgsWithDeps(argv, {
    resolvePath: path.resolve,
    parseToolsetTokens,
    validToolsets: VALID_TOOLSETS,
    normalizePort
  });
}

export function resolveMcpServerRuntimeOptions(args = {}, config = {}) {
  return resolveMcpServerRuntimeOptionsWithDeps(args, config, {
    isPlainObject,
    parseToolsetTokens,
    normalizeTransport,
    normalizeHost,
    normalizePort,
    resolvePath: path.resolve,
    joinPath: path.join
  });
}

function printMcpHelp() {
  console.log(
    "Usage: clawty mcp-server [--workspace <path>] [--toolset <name>] [--expose-low-level] [--transport <stdio|http>] [--host <host>] [--port <n>] [--log-path <path>]"
  );
  console.log("");
  console.log("Quick start:");
  console.log("- clawty mcp-server                       # use config defaults (recommended)");
  console.log("- clawty mcp-server --port 8765           # quick HTTP mode on 127.0.0.1:8765");
  console.log("");
  console.log("Toolsets:");
  console.log("- analysis: search/explain/trace/impact/read-only code navigation");
  console.log("- ops: monitor_system");
  console.log("- edit-safe: reindex_codebase");
  console.log("- all: enable all facade toolsets");
  console.log("- default: analysis + ops");
  console.log("");
  console.log("Default exposed facade tools:");
  console.log("- search_code / go_to_definition / find_references");
  console.log("- get_code_context / explain_code / trace_call_chain / impact_analysis");
  console.log("- monitor_system");
  console.log("- reindex_codebase requires --toolset edit-safe (or --toolset all)");
  console.log("");
  console.log("Optional:");
  console.log("- --transport supports stdio (default) or http.");
  console.log("- --port implies http transport if --transport is omitted.");
  console.log("- --log-path overrides log file (default .clawty/logs/mcp-server.log).");
  console.log("- --expose-low-level exposes raw monitoring/index/LSP tools for debugging.");
}

async function main() {
  const args = parseMcpServerArgs(process.argv.slice(2));
  if (args.help) {
    printMcpHelp();
    return;
  }
  const config = loadConfig({ allowMissingApiKey: true });
  const runtimeOptions = resolveMcpServerRuntimeOptions(args, config);
  const mcpLogFilePath = path.isAbsolute(runtimeOptions.logPath)
    ? runtimeOptions.logPath
    : path.resolve(runtimeOptions.workspaceRoot, runtimeOptions.logPath);
  const logger = createRuntimeLogger(config, {
    component: "mcp-server",
    consoleStream: process.stderr,
    filePath: mcpLogFilePath,
    context: {
      entrypoint: "mcp-server"
    }
  });
  await runMcpServer({
    workspaceRoot: runtimeOptions.workspaceRoot,
    exposeLowLevel: runtimeOptions.exposeLowLevel,
    toolsets: runtimeOptions.toolsets,
    transport: runtimeOptions.transport,
    host: runtimeOptions.host,
    port: runtimeOptions.port,
    toolTimeoutMs: config.toolTimeoutMs,
    logger,
    lsp: config.lsp,
    embedding: config.embedding,
    metrics: config.metrics,
    onlineTuner: config.onlineTuner
  });
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(`mcp-server failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
