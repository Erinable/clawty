import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import {
  buildCodeIndex,
  getIndexStats,
  queryCodeIndex,
  refreshCodeIndex
} from "./code-index.js";
import {
  buildSemanticGraph,
  refreshSemanticGraph,
  importPreciseIndex,
  getSemanticGraphStats,
  querySemanticGraph
} from "./semantic-graph.js";
import {
  buildSyntaxIndex,
  querySyntaxIndex,
  refreshSyntaxIndex,
  getSyntaxIndexStats
} from "./syntax-index.js";
import {
  buildVectorIndex,
  refreshVectorIndex,
  queryVectorIndex,
  getVectorIndexStats,
  mergeVectorDelta
} from "./vector-index.js";
import {
  collectAndRankHybridCandidates,
  queryHybridRetrievalSources
} from "./retrieval-orchestrator.js";
import {
  attachHybridRetrievalProtocol
} from "./hybrid-ranking.js";
import {
  rerankHybridCandidatesWithEmbedding,
  rerankHybridCandidatesWithFreshness
} from "./hybrid-rerank.js";
import {
  appendHybridQueryMetricEvent,
  buildHybridDegradationSummary,
  buildHybridMetricEvent,
  buildHybridQueryResponse,
  roundHybridMs
} from "./hybrid-query-output.js";
import {
  DEFAULT_HYBRID_EMBEDDING_MODEL,
  DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
  DEFAULT_HYBRID_EMBEDDING_TOP_K,
  DEFAULT_HYBRID_EMBEDDING_WEIGHT,
  DEFAULT_HYBRID_FRESHNESS_MAX_PATHS,
  DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
  DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
  DEFAULT_HYBRID_FRESHNESS_WEIGHT,
  parseHybridBoolean,
  resolveHybridEmbeddingConfig,
  resolveHybridFreshnessConfig,
  resolveMetricsConfig
} from "./hybrid-config.js";
import {
  lspDefinition,
  lspHealth,
  lspReferences,
  lspWorkspaceSymbols
} from "./lsp-manager.js";
import { prepareHybridTunerDecision, recordHybridTunerOutcome } from "./online-tuner.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_TEXT = 100_000;
const METRICS_SUBDIR = path.join(".clawty", "metrics");
const HYBRID_QUERY_METRICS_FILE = "hybrid-query.jsonl";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/i
];

function truncate(text, maxChars = MAX_TOOL_TEXT) {
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function isBlockedCommand(command) {
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function resolveRunShellExecutable({
  platform = process.platform,
  env = process.env,
  pathExists = existsSync
} = {}) {
  if (platform === "win32") {
    const comSpec = typeof env?.ComSpec === "string" ? env.ComSpec.trim() : "";
    return comSpec || "cmd.exe";
  }

  const candidateShells = [];
  if (typeof env?.SHELL === "string" && env.SHELL.trim().length > 0) {
    candidateShells.push(env.SHELL.trim());
  }
  candidateShells.push("/bin/zsh", "/bin/bash", "/bin/sh");

  for (const shellPath of candidateShells) {
    if (!shellPath) {
      continue;
    }
    if (!path.isAbsolute(shellPath)) {
      return shellPath;
    }
    if (pathExists(shellPath)) {
      return shellPath;
    }
  }

  return "/bin/sh";
}

function normalizePatchPath(rawPath) {
  if (!rawPath || rawPath === "/dev/null") {
    return null;
  }
  let clean = rawPath.trim().split(/\s+/)[0];
  if (clean.startsWith("a/") || clean.startsWith("b/")) {
    clean = clean.slice(2);
  }
  return clean;
}

function assertSafePatchPath(filePath) {
  if (!filePath) {
    return;
  }
  if (filePath.includes("\0")) {
    throw new Error(`Invalid patch path: ${filePath}`);
  }
  if (path.isAbsolute(filePath) || filePath.startsWith("~")) {
    throw new Error(`Patch path must be workspace-relative: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Patch path escapes workspace root: ${filePath}`);
  }
}

function extractPatchedFiles(patch) {
  const files = new Set();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }
    const filePath = normalizePatchPath(line.slice(4));
    if (!filePath) {
      continue;
    }
    assertSafePatchPath(filePath);
    files.add(filePath);
  }
  return Array.from(files);
}

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        max_chars: {
          type: "integer",
          description: "Optional max chars in output.",
          minimum: 100,
          maximum: 200000
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 text file to workspace (overwrite if exists).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        content: { type: "string", description: "Full file content." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_shell",
    description: "Run a shell command in workspace root with timeout and output capture.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
          minimum: 1000,
          maximum: 300000
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "apply_patch",
    description: "Apply a unified diff patch to workspace files.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff content." },
        check: {
          type: "boolean",
          description: "Only validate patch without applying changes."
        },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
          minimum: 1000,
          maximum: 300000
        }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_code_index",
    description:
      "Scan workspace code files and build a searchable SQLite index at .clawty/index.db.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap indexed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_file_size_kb: {
          type: "integer",
          description: "Optional max file size (KB) included in index.",
          minimum: 1,
          maximum: 8192
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_code_index",
    description: "Search the code index by keywords and return ranked file matches.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query such as symbol, module name, or feature keyword."
        },
        top_k: {
          type: "integer",
          description: "Optional number of top results to return.",
          minimum: 1,
          maximum: 50
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/ or tests/."
        },
        language: {
          type: "string",
          description: "Optional language filter, e.g. javascript, python, text."
        },
        explain: {
          type: "boolean",
          description: "Include score breakdown for each result."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_code_index",
    description:
      "Incrementally refresh SQLite code index. Optionally pass changed_paths/deleted_paths for event-driven updates.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap indexed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_file_size_kb: {
          type: "integer",
          description: "Optional max file size (KB) included in index.",
          minimum: 1,
          maximum: 8192
        },
        force_rebuild: {
          type: "boolean",
          description: "If true, bypass incremental mode and do a full rebuild."
        },
        changed_paths: {
          type: "array",
          description:
            "Optional changed file paths (workspace-relative). When provided, refresh runs in event mode.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description:
            "Optional deleted file paths (workspace-relative). Only used when event mode is enabled.",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_index_stats",
    description: "Return index health and coverage statistics from SQLite index.",
    parameters: {
      type: "object",
      properties: {
        top_files: {
          type: "integer",
          description: "Optional number of largest files to include.",
          minimum: 1,
          maximum: 50
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_semantic_graph",
    description:
      "Build semantic graph nodes/edges in SQLite from index symbols and optional LSP facts.",
    parameters: {
      type: "object",
      properties: {
        max_symbols: {
          type: "integer",
          description: "Maximum number of seed symbols loaded from code index.",
          minimum: 1,
          maximum: 5000
        },
        semantic_seed_lang_filter: {
          type: "string",
          description:
            "Optional seed language filter. Use '*' for all (default) or comma-separated values like 'javascript,python,go'."
        },
        max_references_per_symbol: {
          type: "integer",
          description: "Maximum reference locations collected per seed symbol.",
          minimum: 1,
          maximum: 200
        },
        include_definitions: {
          type: "boolean",
          description: "Collect definition edges from LSP."
        },
        include_references: {
          type: "boolean",
          description: "Collect reference edges from LSP."
        },
        include_syntax: {
          type: "boolean",
          description: "Ingest syntax index import/call edges as structural priors."
        },
        lsp_required: {
          type: "boolean",
          description: "Fail build if LSP is unavailable."
        },
        max_syntax_import_edges: {
          type: "integer",
          description: "Maximum syntax import edges ingested per build.",
          minimum: 1,
          maximum: 200000
        },
        max_syntax_call_edges: {
          type: "integer",
          description: "Maximum syntax call edges ingested per build.",
          minimum: 1,
          maximum: 200000
        },
        precise_preferred: {
          type: "boolean",
          description: "Prefer precise index import (SCIP) before LSP/index graph build."
        },
        precise_required: {
          type: "boolean",
          description: "Fail build when precise index is unavailable or import fails."
        },
        precise_index_path: {
          type: "string",
          description: "Optional primary precise index path."
        },
        precise_index_paths: {
          type: "array",
          description: "Optional precise index candidate paths, checked in order.",
          items: { type: "string" }
        },
        precise_mode: {
          type: "string",
          description: "Precise import mode when precise index is found.",
          enum: ["merge", "replace"]
        },
        precise_source: {
          type: "string",
          description: "Precise source label, default scip."
        },
        precise_max_nodes: {
          type: "integer",
          description: "Maximum precise nodes imported in preferred mode.",
          minimum: 1,
          maximum: 500000
        },
        precise_max_edges: {
          type: "integer",
          description: "Maximum precise edges imported in preferred mode.",
          minimum: 1,
          maximum: 1000000
        },
        max_lsp_errors: {
          type: "integer",
          description: "Abort LSP enrichment after this many request errors.",
          minimum: 1,
          maximum: 200
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_semantic_graph",
    description:
      "Refresh semantic graph incrementally using changed_paths/deleted_paths. Falls back to full build when event paths are not provided.",
    parameters: {
      type: "object",
      properties: {
        changed_paths: {
          type: "array",
          description: "Optional changed file paths relative to workspace root.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Optional deleted file paths relative to workspace root.",
          items: { type: "string" }
        },
        max_symbols: {
          type: "integer",
          description: "Maximum number of changed-path seed symbols loaded from code index.",
          minimum: 1,
          maximum: 5000
        },
        semantic_seed_lang_filter: {
          type: "string",
          description:
            "Optional seed language filter. Use '*' for all (default) or comma-separated values like 'javascript,python,go'."
        },
        max_references_per_symbol: {
          type: "integer",
          description: "Maximum reference locations collected per changed seed symbol.",
          minimum: 1,
          maximum: 200
        },
        include_definitions: {
          type: "boolean",
          description: "Collect definition edges from LSP."
        },
        include_references: {
          type: "boolean",
          description: "Collect reference edges from LSP."
        },
        include_syntax: {
          type: "boolean",
          description: "Rebuild syntax-derived semantic edges."
        },
        lsp_required: {
          type: "boolean",
          description: "Fail refresh if LSP is unavailable."
        },
        max_syntax_import_edges: {
          type: "integer",
          description: "Maximum syntax import edges ingested per refresh.",
          minimum: 1,
          maximum: 200000
        },
        max_syntax_call_edges: {
          type: "integer",
          description: "Maximum syntax call edges ingested per refresh.",
          minimum: 1,
          maximum: 200000
        },
        precise_preferred: {
          type: "boolean",
          description: "When true, refresh may fallback to full precise build."
        },
        precise_required: {
          type: "boolean",
          description: "Require precise import; refresh falls back to full precise mode."
        },
        precise_index_path: {
          type: "string",
          description: "Optional primary precise index path."
        },
        precise_index_paths: {
          type: "array",
          description: "Optional precise index candidate paths, checked in order.",
          items: { type: "string" }
        },
        precise_mode: {
          type: "string",
          description: "Precise import mode when precise index is found.",
          enum: ["merge", "replace"]
        },
        precise_source: {
          type: "string",
          description: "Precise source label, default scip."
        },
        precise_max_nodes: {
          type: "integer",
          description: "Maximum precise nodes imported in fallback precise mode.",
          minimum: 1,
          maximum: 500000
        },
        precise_max_edges: {
          type: "integer",
          description: "Maximum precise edges imported in fallback precise mode.",
          minimum: 1,
          maximum: 1000000
        },
        max_lsp_errors: {
          type: "integer",
          description: "Abort LSP enrichment after this many request errors.",
          minimum: 1,
          maximum: 200
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "import_precise_index",
    description:
      "Import precise index facts (SCIP-normalized JSON) into semantic graph as semantic nodes/edges.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to precise index JSON file."
        },
        mode: {
          type: "string",
          description: "Import mode: merge (default) or replace existing semantic graph.",
          enum: ["merge", "replace"]
        },
        source: {
          type: "string",
          description: "Fact source label, default scip."
        },
        max_nodes: {
          type: "integer",
          description: "Maximum nodes loaded from import payload.",
          minimum: 1,
          maximum: 500000
        },
        max_edges: {
          type: "integer",
          description: "Maximum edges loaded from import payload.",
          minimum: 1,
          maximum: 1000000
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_semantic_graph",
    description:
      "Query semantic graph seeds and return incoming/outgoing neighbors. Falls back to syntax index, then code index when graph is empty.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or file keyword to locate graph seeds."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed nodes returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum incoming/outgoing neighbors per seed.",
          minimum: 1,
          maximum: 100
        },
        max_hops: {
          type: "integer",
          description: "Optional max traversal hops per seed (default 1, max 4).",
          minimum: 1,
          maximum: 4
        },
        per_hop_limit: {
          type: "integer",
          description: "Optional edge expansion cap per hop during multi-hop traversal.",
          minimum: 1,
          maximum: 50
        },
        edge_type: {
          type: "string",
          description: "Optional edge type filter, e.g. definition or reference."
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_hybrid_index",
    description:
      "Hybrid retrieval across semantic graph, syntax index, and code index with lightweight re-ranking.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or file keyword to retrieve hybrid candidates."
        },
        top_k: {
          type: "integer",
          description: "Maximum merged candidates returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum neighbors requested from semantic graph per seed.",
          minimum: 1,
          maximum: 100
        },
        max_hops: {
          type: "integer",
          description: "Optional max traversal hops for semantic graph query.",
          minimum: 1,
          maximum: 4
        },
        per_hop_limit: {
          type: "integer",
          description: "Optional edge expansion cap per hop for semantic graph query.",
          minimum: 1,
          maximum: 50
        },
        edge_type: {
          type: "string",
          description: "Optional edge type filter for semantic graph query."
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix preference during fusion ranking."
        },
        language: {
          type: "string",
          description: "Optional language filter shared by index/vector retrieval."
        },
        include_vector: {
          type: "boolean",
          description: "Enable offline vector source during hybrid retrieval."
        },
        vector_max_candidates: {
          type: "integer",
          description: "Maximum vector chunk candidates scanned before ranking.",
          minimum: 1,
          maximum: 20000
        },
        vector_layers: {
          type: "array",
          description: "Vector layers included in retrieval (base and/or delta).",
          items: { type: "string", enum: ["base", "delta"] }
        },
        explain: {
          type: "boolean",
          description: "Include score feature breakdown for each returned candidate."
        },
        enable_embedding: {
          type: "boolean",
          description:
            "Enable optional embedding rerank for top hybrid candidates. Defaults to CLAWTY_EMBEDDING_ENABLED."
        },
        embedding_top_k: {
          type: "integer",
          description: "Maximum candidates to rerank with embeddings.",
          minimum: 1,
          maximum: 200
        },
        embedding_weight: {
          type: "number",
          description: "Blend weight for embedding score in final hybrid ranking (0-1).",
          minimum: 0,
          maximum: 1
        },
        embedding_model: {
          type: "string",
          description: "Optional embedding model override, e.g. text-embedding-3-small."
        },
        embedding_timeout_ms: {
          type: "integer",
          description: "Optional embedding request timeout override in milliseconds.",
          minimum: 1000,
          maximum: 120000
        },
        enable_freshness: {
          type: "boolean",
          description:
            "Enable freshness-based rerank using file mtime metadata. Defaults to CLAWTY_INDEX_FRESHNESS_ENABLED."
        },
        freshness_stale_after_ms: {
          type: "integer",
          description: "Age threshold in milliseconds after which candidates are treated as stale.",
          minimum: 1000,
          maximum: 86_400_000
        },
        freshness_weight: {
          type: "number",
          description: "Blend weight for freshness score in final hybrid ranking (0-1).",
          minimum: 0,
          maximum: 1
        },
        freshness_vector_stale_penalty: {
          type: "number",
          description:
            "Additional downweight factor for stale candidates supported by vector retrieval (0-1).",
          minimum: 0,
          maximum: 1
        },
        freshness_max_paths: {
          type: "integer",
          description: "Maximum unique candidate paths sampled for freshness metadata lookup.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_semantic_graph_stats",
    description:
      "Return semantic graph stats, including source mix and precise freshness metadata.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_syntax_index",
    description:
      "Build syntax index from indexed files and extract import/call edges for structural analysis.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap parsed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_calls_per_file: {
          type: "integer",
          description: "Optional per-file cap for extracted call edges.",
          minimum: 1,
          maximum: 2000
        },
        max_errors: {
          type: "integer",
          description: "Abort build after this many file parse errors.",
          minimum: 1,
          maximum: 1000
        },
        parser_provider: {
          type: "string",
          description: "Parser provider mode: auto (default), skeleton, or tree-sitter.",
          enum: ["skeleton", "tree-sitter", "auto"]
        },
        parser_strict: {
          type: "boolean",
          description: "When true with tree-sitter provider, fail instead of falling back."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_syntax_index",
    description:
      "Incrementally refresh syntax index. Optionally pass changed_paths/deleted_paths for event-driven updates.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap parsed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_calls_per_file: {
          type: "integer",
          description: "Optional per-file cap for extracted call edges.",
          minimum: 1,
          maximum: 2000
        },
        max_errors: {
          type: "integer",
          description: "Abort refresh after this many file parse errors.",
          minimum: 1,
          maximum: 1000
        },
        parser_provider: {
          type: "string",
          description: "Parser provider mode: auto (default), skeleton, or tree-sitter.",
          enum: ["skeleton", "tree-sitter", "auto"]
        },
        parser_strict: {
          type: "boolean",
          description: "When true with tree-sitter provider, fail instead of falling back."
        },
        changed_paths: {
          type: "array",
          description:
            "Optional changed file paths (workspace-relative). When provided, refresh runs in event mode.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description:
            "Optional deleted file paths (workspace-relative). Only used when event mode is enabled.",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_syntax_index",
    description:
      "Query syntax index by symbol/path keyword and return structural neighbors (imports/calls).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or path keyword to locate syntax seed files."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed files returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum outgoing/incoming neighbors per seed.",
          minimum: 1,
          maximum: 100
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_syntax_index_stats",
    description: "Return syntax index coverage and structural edge statistics.",
    parameters: {
      type: "object",
      properties: {
        top_files: {
          type: "integer",
          description: "Optional number of top callers/imported targets to include.",
          minimum: 1,
          maximum: 50
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_vector_index",
    description:
      "Build offline vector index from code chunks. Writes vectors into base or delta layer in SQLite.",
    parameters: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description: "Target layer: base (default) or delta.",
          enum: ["base", "delta"]
        },
        max_chunks: {
          type: "integer",
          description: "Maximum chunk rows embedded per build run.",
          minimum: 1,
          maximum: 20000
        },
        batch_size: {
          type: "integer",
          description: "Embedding batch size.",
          minimum: 1,
          maximum: 128
        },
        model: {
          type: "string",
          description: "Embedding model override, e.g. text-embedding-3-small."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        },
        source_revision: {
          type: "string",
          description: "Optional source revision label for traceability."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_vector_index",
    description:
      "Incrementally refresh vector index for changed/deleted paths. Falls back to full build if event paths are missing.",
    parameters: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description: "Target layer for refresh. Defaults to delta.",
          enum: ["base", "delta"]
        },
        changed_paths: {
          type: "array",
          description: "Changed file paths relative to workspace root.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Deleted file paths relative to workspace root.",
          items: { type: "string" }
        },
        max_chunks: {
          type: "integer",
          description: "Maximum changed chunk rows embedded per refresh run.",
          minimum: 1,
          maximum: 20000
        },
        batch_size: {
          type: "integer",
          description: "Embedding batch size.",
          minimum: 1,
          maximum: 128
        },
        model: {
          type: "string",
          description: "Embedding model override."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        },
        source_revision: {
          type: "string",
          description: "Optional source revision label for traceability."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_vector_index",
    description:
      "Query offline vector index using semantic similarity against chunk embeddings.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language or code query."
        },
        top_k: {
          type: "integer",
          description: "Maximum vector hits returned.",
          minimum: 1,
          maximum: 100
        },
        max_candidates: {
          type: "integer",
          description: "Maximum candidate chunk vectors scanned before ranking.",
          minimum: 1,
          maximum: 20000
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        },
        layers: {
          type: "array",
          description: "Layer filter. Defaults to [base, delta].",
          items: { type: "string", enum: ["base", "delta"] }
        },
        model: {
          type: "string",
          description: "Embedding model override."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_vector_index_stats",
    description: "Return offline vector index coverage and latest run stats.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "merge_vector_delta",
    description:
      "Merge delta layer vectors into base layer and clear merged delta rows.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_definition",
    description:
      "Find symbol definition using LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root."
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
          description: "Optional maximum number of returned locations.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_references",
    description:
      "Find symbol references using LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root."
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
          description: "Include declaration sites in references."
        },
        max_results: {
          type: "integer",
          description: "Optional maximum number of returned locations.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_workspace_symbols",
    description:
      "Search workspace symbols via LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol query text."
        },
        max_results: {
          type: "integer",
          description: "Optional maximum number of returned symbols.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_health",
    description: "Return LSP service health, lifecycle status, and recent errors.",
    parameters: {
      type: "object",
      properties: {
        startup_check: {
          type: "boolean",
          description: "When true, try to start LSP server before reporting health."
        }
      },
      additionalProperties: false
    }
  }
];

async function readFileTool(args, context) {
  const maxChars = Number.isFinite(args.max_chars) ? args.max_chars : MAX_TOOL_TEXT;
  const filePath = resolveSafePath(context.workspaceRoot, args.path);
  const content = await fs.readFile(filePath, "utf8");
  return {
    ok: true,
    path: path.relative(context.workspaceRoot, filePath),
    content: truncate(content, maxChars)
  };
}

async function writeFileTool(args, context) {
  const filePath = resolveSafePath(context.workspaceRoot, args.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, args.content, "utf8");
  return {
    ok: true,
    path: path.relative(context.workspaceRoot, filePath),
    bytes: Buffer.byteLength(args.content, "utf8")
  };
}

async function runShellTool(args, context) {
  if (isBlockedCommand(args.command)) {
    return {
      ok: false,
      blocked: true,
      reason: "Blocked potentially destructive command by policy."
    };
  }

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: context.workspaceRoot,
      timeout: args.timeout_ms || context.defaultTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: resolveRunShellExecutable()
    });
    return {
      ok: true,
      exit_code: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: Number.isInteger(error.code) ? error.code : 1,
      stdout: truncate(error.stdout || ""),
      stderr: truncate(error.stderr || error.message || "")
    };
  }
}

async function applyPatchTool(args, context) {
  if (typeof args.patch !== "string" || args.patch.trim().length === 0) {
    return { ok: false, error: "patch must be a non-empty string" };
  }

  const patchedFiles = extractPatchedFiles(args.patch);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawty-patch-"));
  const patchPath = path.join(tempDir, "change.patch");
  await fs.writeFile(patchPath, args.patch, "utf8");

  const gitArgs = ["apply", "--whitespace=nowarn"];
  if (args.check) {
    gitArgs.push("--check");
  }
  gitArgs.push(patchPath);

  try {
    const { stdout, stderr } = await execFileAsync("git", gitArgs, {
      cwd: context.workspaceRoot,
      timeout: args.timeout_ms || context.defaultTimeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });

    return {
      ok: true,
      checked: Boolean(args.check),
      files: patchedFiles,
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    };
  } catch (error) {
    return {
      ok: false,
      checked: Boolean(args.check),
      files: patchedFiles,
      exit_code: Number.isInteger(error.code) ? error.code : 1,
      stdout: truncate(error.stdout || ""),
      stderr: truncate(error.stderr || error.message || "")
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function buildCodeIndexTool(args, context) {
  const mergedArgs = { ...(args || {}) };
  if (mergedArgs.max_files === undefined && Number.isFinite(context?.index?.maxFiles)) {
    mergedArgs.max_files = context.index.maxFiles;
  }
  if (
    mergedArgs.max_file_size_kb === undefined &&
    Number.isFinite(context?.index?.maxFileSizeKb)
  ) {
    mergedArgs.max_file_size_kb = context.index.maxFileSizeKb;
  }
  return buildCodeIndex(context.workspaceRoot, mergedArgs);
}

async function queryCodeIndexTool(args, context) {
  return queryCodeIndex(context.workspaceRoot, args);
}

async function refreshCodeIndexTool(args, context) {
  const mergedArgs = { ...(args || {}) };
  if (mergedArgs.max_files === undefined && Number.isFinite(context?.index?.maxFiles)) {
    mergedArgs.max_files = context.index.maxFiles;
  }
  if (
    mergedArgs.max_file_size_kb === undefined &&
    Number.isFinite(context?.index?.maxFileSizeKb)
  ) {
    mergedArgs.max_file_size_kb = context.index.maxFileSizeKb;
  }
  return refreshCodeIndex(context.workspaceRoot, mergedArgs);
}

async function getIndexStatsTool(args, context) {
  return getIndexStats(context.workspaceRoot, args);
}

async function buildSemanticGraphTool(args, context) {
  return buildSemanticGraph(context.workspaceRoot, args, context.lsp || {});
}

async function refreshSemanticGraphTool(args, context) {
  return refreshSemanticGraph(context.workspaceRoot, args, context.lsp || {});
}

async function importPreciseIndexTool(args, context) {
  return importPreciseIndex(context.workspaceRoot, args);
}

function mapSyntaxSeedToSemanticSeed(seed, edgeType = null) {
  const outgoing = [];
  const incoming = [];

  for (const item of seed.outgoing_imports || []) {
    outgoing.push({
      edge_type: "import",
      edge_source: "syntax",
      weight: 1.5,
      node: {
        path: item.imported_path,
        name: path.basename(String(item.imported_path || "").replace(/^pkg:/, "")),
        kind: item.external ? "package" : "module",
        line: Number(item.line || 1),
        column: 1,
        lang: null,
        source: "syntax"
      }
    });
  }
  for (const item of seed.outgoing_calls || []) {
    outgoing.push({
      edge_type: "call",
      edge_source: "syntax",
      weight: 1,
      node: {
        path: seed.path,
        name: item.callee,
        kind: "symbol",
        line: Number(item.line || 1),
        column: 1,
        lang: seed.lang || null,
        source: "syntax"
      }
    });
  }

  for (const item of seed.incoming_importers || []) {
    incoming.push({
      edge_type: "import",
      edge_source: "syntax",
      weight: 1.5,
      node: {
        path: item.file_path,
        name: path.basename(String(item.file_path || "")),
        kind: "file",
        line: Number(item.line || 1),
        column: 1,
        lang: null,
        source: "syntax"
      }
    });
  }
  for (const item of seed.incoming_callers || []) {
    incoming.push({
      edge_type: "call",
      edge_source: "syntax",
      weight: 1,
      node: {
        path: item.file_path,
        name: path.basename(String(item.file_path || "")),
        kind: "file",
        line: Number(item.line || 1),
        column: 1,
        lang: null,
        source: "syntax"
      }
    });
  }

  const filteredOutgoing = edgeType
    ? outgoing.filter((item) => item.edge_type === edgeType)
    : outgoing;
  const filteredIncoming = edgeType
    ? incoming.filter((item) => item.edge_type === edgeType)
    : incoming;

  return {
    path: seed.path,
    name: seed.path,
    kind: "file",
    line: 1,
    column: 1,
    lang: seed.lang || null,
    source: "syntax_fallback",
    outgoing: filteredOutgoing,
    incoming: filteredIncoming
  };
}

function summarizeFallbackSeedLanguages(seeds) {
  const rows = Array.isArray(seeds) ? seeds : [];
  const counts = new Map();
  for (const seed of rows) {
    const raw = typeof seed?.lang === "string" ? seed.lang.trim().toLowerCase() : "";
    const lang = raw && raw !== "*" ? raw : "unknown";
    counts.set(lang, Number(counts.get(lang) || 0) + 1);
  }
  const total = rows.length;
  return {
    total,
    breakdown: Array.from(counts.entries())
      .map(([lang, count]) => ({
        lang,
        count,
        ratio: total > 0 ? Number((count / total).toFixed(4)) : 0
      }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.lang.localeCompare(b.lang);
      })
  };
}

async function querySemanticGraphTool(args, context) {
  const semanticResult = await querySemanticGraph(context.workspaceRoot, args);
  if (semanticResult.ok) {
    return semanticResult;
  }

  if (!/semantic graph is empty/i.test(String(semanticResult.error || ""))) {
    return semanticResult;
  }

  const syntaxResult = await querySyntaxIndex(context.workspaceRoot, {
    query: args?.query,
    top_k: args?.top_k,
    max_neighbors: args?.max_neighbors,
    path_prefix: args?.path_prefix
  });
  if (syntaxResult.ok && Array.isArray(syntaxResult.seeds) && syntaxResult.seeds.length > 0) {
    const fallbackSeeds = syntaxResult.seeds.map((seed) =>
      mapSyntaxSeedToSemanticSeed(seed, args?.edge_type || null)
    );
    return {
      ok: true,
      provider: "syntax",
      fallback: true,
      warning: "semantic graph is empty, returned syntax-index fallback results",
      query: syntaxResult.query,
      filters: {
        edge_type: args?.edge_type || null,
        path_prefix: args?.path_prefix || null,
        max_hops: Number.isFinite(Number(args?.max_hops))
          ? Math.max(1, Math.floor(Number(args.max_hops)))
          : 1,
        per_hop_limit: Number.isFinite(Number(args?.per_hop_limit))
          ? Math.max(1, Math.floor(Number(args.per_hop_limit)))
          : null
      },
      priority_policy: ["syntax", "index_fallback"],
      total_seeds: fallbackSeeds.length,
      scanned_candidates: Number(syntaxResult.scanned_candidates || fallbackSeeds.length),
      deduped_candidates: fallbackSeeds.length,
      language_distribution: {
        scanned_candidates: null,
        deduped_candidates: summarizeFallbackSeedLanguages(fallbackSeeds),
        returned_seeds: summarizeFallbackSeedLanguages(fallbackSeeds)
      },
      seeds: fallbackSeeds
    };
  }

  const indexResult = await queryCodeIndex(context.workspaceRoot, {
    query: args?.query,
    top_k: args?.top_k
  });
  if (!indexResult.ok) {
    return semanticResult;
  }

  const fallbackSeeds = (indexResult.results || []).map((item) => ({
    path: item.path,
    name: item.path,
    kind: "file",
    line: Number(item.hit_line || 1),
    column: 1,
    lang: null,
    source: "index_fallback",
    outgoing: [],
    incoming: []
  }));

  return {
    ok: true,
    provider: "index",
    fallback: true,
    warning: "semantic graph is empty, returned index-based fallback results",
    query: indexResult.query,
    filters: {
      edge_type: args?.edge_type || null,
      path_prefix: args?.path_prefix || null,
      max_hops: Number.isFinite(Number(args?.max_hops))
        ? Math.max(1, Math.floor(Number(args.max_hops)))
        : 1,
      per_hop_limit: Number.isFinite(Number(args?.per_hop_limit))
        ? Math.max(1, Math.floor(Number(args.per_hop_limit)))
        : null
    },
    priority_policy: ["index_fallback"],
    total_seeds: fallbackSeeds.length,
    scanned_candidates: Number(indexResult.total_hits || fallbackSeeds.length),
    deduped_candidates: fallbackSeeds.length,
    language_distribution: {
      scanned_candidates: null,
      deduped_candidates: summarizeFallbackSeedLanguages(fallbackSeeds),
      returned_seeds: summarizeFallbackSeedLanguages(fallbackSeeds)
    },
    seeds: fallbackSeeds
  };
}

async function queryHybridIndexTool(args, context) {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      ok: false,
      error: "query must be a non-empty string"
    };
  }
  const queryStartedAt = performance.now();

  let tunerDecision = {
    enabled: false,
    mode: "off",
    decision_id: null,
    arm_id: null,
    effective_args: isPlainObject(args) ? { ...args } : {},
    applied_params: {},
    explicit_override: false,
    selection: {
      strategy: "disabled",
      candidates: [],
      blocked: []
    }
  };
  try {
    tunerDecision = await prepareHybridTunerDecision(context.workspaceRoot, args, context);
  } catch (error) {
    tunerDecision = {
      ...tunerDecision,
      selection: {
        strategy: "decision_failed",
        candidates: [],
        blocked: []
      },
      error: error.message || String(error)
    };
  }
  const effectiveArgs = isPlainObject(tunerDecision?.effective_args)
    ? tunerDecision.effective_args
    : isPlainObject(args)
      ? { ...args }
      : {};

  const topK = Number.isFinite(Number(effectiveArgs?.top_k))
    ? Math.max(1, Math.min(30, Math.floor(Number(effectiveArgs.top_k))))
    : 5;
  const scanTopK = Math.max(topK * 3, 10);
  const vectorEnabled = parseHybridBoolean(effectiveArgs?.include_vector, true);
  const { semanticResult, syntaxResult, indexResult, vectorResult } =
    await queryHybridRetrievalSources({
      workspaceRoot: context.workspaceRoot,
      query,
      scanTopK,
      topK,
      effectiveArgs,
      vectorEnabled,
      embedding: context.embedding || {}
    });

  const { scannedCandidates, deduped, ranked } = collectAndRankHybridCandidates({
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult,
    edgeType: effectiveArgs?.edge_type,
    query,
    pathPrefix: effectiveArgs?.path_prefix,
    explain: effectiveArgs?.explain,
    mapSyntaxSeedToSemanticSeed
  });
  const embeddingRerank = await rerankHybridCandidatesWithEmbedding({
    ranked,
    args: {
      ...effectiveArgs,
      query
    },
    config: resolveHybridEmbeddingConfig(effectiveArgs, context)
  });
  const finalRanked = Array.isArray(embeddingRerank?.ranked) ? embeddingRerank.ranked : ranked;
  const freshnessRerank = await rerankHybridCandidatesWithFreshness({
    ranked: finalRanked,
    args: {
      ...effectiveArgs,
      query
    },
    config: resolveHybridFreshnessConfig(effectiveArgs, context),
    workspaceRoot: context.workspaceRoot,
    resolveSafePath
  });
  const freshnessRanked = Array.isArray(freshnessRerank?.ranked)
    ? freshnessRerank.ranked
    : finalRanked;
  const seeds = attachHybridRetrievalProtocol(freshnessRanked.slice(0, topK));
  const embeddingSource = embeddingRerank?.source || {
    enabled: false,
    attempted: false,
    ok: false,
    model: DEFAULT_HYBRID_EMBEDDING_MODEL,
    top_k: DEFAULT_HYBRID_EMBEDDING_TOP_K,
    weight: DEFAULT_HYBRID_EMBEDDING_WEIGHT,
    timeout_ms: DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
    reranked_candidates: 0,
    latency_ms: 0,
    status_code: "EMBEDDING_DISABLED",
    error_code: null,
    retryable: false,
    rank_shift_count: 0,
    top1_changed: false,
    score_delta_mean: 0,
    error: null
  };
  const freshnessSource = freshnessRerank?.source || {
    enabled: false,
    attempted: false,
    ok: false,
    stale_after_ms: DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
    weight: DEFAULT_HYBRID_FRESHNESS_WEIGHT,
    vector_stale_penalty: DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
    sampled_paths: 0,
    sampled_paths_limit: DEFAULT_HYBRID_FRESHNESS_MAX_PATHS,
    sampled_paths_with_stat: 0,
    missing_paths: 0,
    candidates_with_freshness: 0,
    stale_candidates: 0,
    stale_vector_candidates: 0,
    stale_hit_rate: 0,
    status_code: "FRESHNESS_DISABLED",
    error: null
  };
  const priorityPolicy = ["semantic", "vector", "syntax", "index"];
  if (embeddingSource.ok) {
    priorityPolicy.push("embedding_rerank");
  }
  if (freshnessSource.attempted) {
    priorityPolicy.push("freshness_rerank");
  }
  const degradation = buildHybridDegradationSummary(
    embeddingSource,
    freshnessSource
  );
  const queryTotalMs = roundHybridMs(performance.now() - queryStartedAt);
  let tunerOutcome = {
    recorded: false,
    reason: "not_recorded"
  };
  try {
    tunerOutcome = await recordHybridTunerOutcome(
      context.workspaceRoot,
      tunerDecision,
      {
        query_total_ms: queryTotalMs,
        seeds,
        sources: {
          embedding: {
            status_code: embeddingSource.status_code || null
          }
        },
        degradation
      },
      context
    );
  } catch (error) {
    tunerOutcome = {
      recorded: false,
      reason: "record_failed",
      error: error.message || String(error)
    };
  }
  const metricsConfig = resolveMetricsConfig(context);
  const metricsEvent = buildHybridMetricEvent({
    query,
    queryTotalMs,
    topK,
    scannedCandidates,
    dedupedCandidates: deduped,
    seeds,
    effectiveArgs,
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult,
    vectorEnabled,
    embeddingSource,
    freshnessSource,
    degradation,
    tunerDecision,
    tunerOutcome,
    queryPreviewChars: metricsConfig.query_preview_chars
  });
  const metricsWrite = await appendHybridQueryMetricEvent({
    workspaceRoot: context.workspaceRoot,
    event: metricsEvent,
    metricsConfig,
    resolveSafePath,
    metricsSubdir: METRICS_SUBDIR,
    metricsFileName: HYBRID_QUERY_METRICS_FILE
  });

  const languageDistribution = {
    scanned_candidates: summarizeFallbackSeedLanguages(scannedCandidates),
    deduped_candidates: summarizeFallbackSeedLanguages(
      Array.from(deduped.values()).map((entry) => entry.candidate)
    ),
    returned_seeds: summarizeFallbackSeedLanguages(seeds)
  };

  return buildHybridQueryResponse({
    query,
    queryTotalMs,
    effectiveArgs,
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult,
    vectorEnabled,
    embeddingSource,
    freshnessSource,
    degradation,
    metricsWrite,
    tunerDecision,
    tunerOutcome,
    priorityPolicy,
    scannedCandidates,
    dedupedCandidates: deduped,
    languageDistribution,
    seeds
  });
}

async function getSemanticGraphStatsTool(args, context) {
  return getSemanticGraphStats(context.workspaceRoot);
}

async function buildSyntaxIndexTool(args, context) {
  return buildSyntaxIndex(context.workspaceRoot, args);
}

async function refreshSyntaxIndexTool(args, context) {
  return refreshSyntaxIndex(context.workspaceRoot, args);
}

async function querySyntaxIndexTool(args, context) {
  return querySyntaxIndex(context.workspaceRoot, args);
}

async function getSyntaxIndexStatsTool(args, context) {
  return getSyntaxIndexStats(context.workspaceRoot, args);
}

async function buildVectorIndexTool(args, context) {
  return buildVectorIndex(context.workspaceRoot, args, {
    embedding: context.embedding || {}
  });
}

async function refreshVectorIndexTool(args, context) {
  return refreshVectorIndex(context.workspaceRoot, args, {
    embedding: context.embedding || {}
  });
}

async function queryVectorIndexTool(args, context) {
  return queryVectorIndex(context.workspaceRoot, args, {
    embedding: context.embedding || {}
  });
}

async function getVectorIndexStatsTool(args, context) {
  return getVectorIndexStats(context.workspaceRoot);
}

async function mergeVectorDeltaTool(args, context) {
  return mergeVectorDelta(context.workspaceRoot);
}

async function lspDefinitionTool(args, context) {
  return lspDefinition(context.workspaceRoot, args, context.lsp || {});
}

async function lspReferencesTool(args, context) {
  return lspReferences(context.workspaceRoot, args, context.lsp || {});
}

async function lspWorkspaceSymbolsTool(args, context) {
  return lspWorkspaceSymbols(context.workspaceRoot, args, context.lsp || {});
}

async function lspHealthTool(args, context) {
  return lspHealth(context.workspaceRoot, args, context.lsp || {});
}

const TOOL_HANDLERS = {
  read_file: readFileTool,
  write_file: writeFileTool,
  run_shell: runShellTool,
  apply_patch: applyPatchTool,
  build_code_index: buildCodeIndexTool,
  query_code_index: queryCodeIndexTool,
  refresh_code_index: refreshCodeIndexTool,
  get_index_stats: getIndexStatsTool,
  build_semantic_graph: buildSemanticGraphTool,
  refresh_semantic_graph: refreshSemanticGraphTool,
  import_precise_index: importPreciseIndexTool,
  query_semantic_graph: querySemanticGraphTool,
  query_hybrid_index: queryHybridIndexTool,
  get_semantic_graph_stats: getSemanticGraphStatsTool,
  build_syntax_index: buildSyntaxIndexTool,
  refresh_syntax_index: refreshSyntaxIndexTool,
  query_syntax_index: querySyntaxIndexTool,
  get_syntax_index_stats: getSyntaxIndexStatsTool,
  build_vector_index: buildVectorIndexTool,
  refresh_vector_index: refreshVectorIndexTool,
  query_vector_index: queryVectorIndexTool,
  get_vector_index_stats: getVectorIndexStatsTool,
  merge_vector_delta: mergeVectorDeltaTool,
  lsp_definition: lspDefinitionTool,
  lsp_references: lspReferencesTool,
  lsp_workspace_symbols: lspWorkspaceSymbolsTool,
  lsp_health: lspHealthTool
};

export async function runTool(name, args, context) {
  const handler = TOOL_HANDLERS[name];
  if (typeof handler === "function") {
    return handler(args, context);
  }
  throw new Error(`Unknown tool: ${name}`);
}
