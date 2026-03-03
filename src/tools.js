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
  lspDefinition,
  lspHealth,
  lspReferences,
  lspWorkspaceSymbols
} from "./lsp-manager.js";
import { createEmbeddings, EmbeddingError } from "./embedding-client.js";
import { prepareHybridTunerDecision, recordHybridTunerOutcome } from "./online-tuner.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_TEXT = 100_000;
const METRICS_SUBDIR = path.join(".clawty", "metrics");
const HYBRID_QUERY_METRICS_FILE = "hybrid-query.jsonl";
const DEFAULT_METRICS_ENABLED = true;
const DEFAULT_METRICS_PERSIST_HYBRID = true;
const DEFAULT_METRICS_QUERY_PREVIEW_CHARS = 160;

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

const HYBRID_SOURCE_SCORE = Object.freeze({
  scip: 1,
  lsif: 0.96,
  lsp: 0.88,
  vector: 0.84,
  syntax: 0.78,
  index_seed: 0.7,
  lsp_anchor: 0.62,
  syntax_fallback: 0.6,
  index: 0.5,
  index_fallback: 0.46,
  unknown: 0.4
});

const DEFAULT_HYBRID_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_HYBRID_EMBEDDING_TOP_K = 15;
const DEFAULT_HYBRID_EMBEDDING_WEIGHT = 0.25;
const DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS = 15_000;
const DEFAULT_HYBRID_FRESHNESS_ENABLED = true;
const DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS = 300_000;
const DEFAULT_HYBRID_FRESHNESS_WEIGHT = 0.12;
const DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY = 0.25;
const DEFAULT_HYBRID_FRESHNESS_MAX_PATHS = 200;

function roundHybridMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(4));
}

function parseHybridBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseHybridInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseHybridFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

function resolveHybridEmbeddingConfig(args, context) {
  const embedding = context?.embedding || {};
  const enabled = parseHybridBoolean(args?.enable_embedding, Boolean(embedding.enabled));
  const topK = parseHybridInt(
    args?.embedding_top_k,
    parseHybridInt(embedding.topK, DEFAULT_HYBRID_EMBEDDING_TOP_K, 1, 200),
    1,
    200
  );
  const weight = parseHybridFloat(
    args?.embedding_weight,
    parseHybridFloat(embedding.weight, DEFAULT_HYBRID_EMBEDDING_WEIGHT, 0, 1),
    0,
    1
  );
  const timeoutMs = parseHybridInt(
    args?.embedding_timeout_ms,
    parseHybridInt(
      embedding.timeoutMs,
      DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
      1000,
      120_000
    ),
    1000,
    120_000
  );
  const model =
    typeof args?.embedding_model === "string" && args.embedding_model.trim().length > 0
      ? args.embedding_model.trim()
      : typeof embedding.model === "string" && embedding.model.trim().length > 0
        ? embedding.model.trim()
        : DEFAULT_HYBRID_EMBEDDING_MODEL;

  return {
    enabled,
    top_k: topK,
    weight,
    timeout_ms: timeoutMs,
    model,
    api_key:
      typeof embedding.apiKey === "string" && embedding.apiKey.trim().length > 0
        ? embedding.apiKey.trim()
        : null,
    base_url:
      typeof embedding.baseUrl === "string" && embedding.baseUrl.trim().length > 0
        ? embedding.baseUrl.trim()
        : "https://api.openai.com/v1",
    client: typeof embedding.client === "function" ? embedding.client : null
  };
}

function resolveHybridFreshnessConfig(args, context) {
  const index = context?.index || {};
  const enabled = parseHybridBoolean(
    args?.enable_freshness,
    parseHybridBoolean(index.freshnessEnabled, DEFAULT_HYBRID_FRESHNESS_ENABLED)
  );
  return {
    enabled,
    stale_after_ms: parseHybridInt(
      args?.freshness_stale_after_ms,
      parseHybridInt(
        index.freshnessStaleAfterMs,
        DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
        1000,
        86_400_000
      ),
      1000,
      86_400_000
    ),
    weight: parseHybridFloat(
      args?.freshness_weight,
      parseHybridFloat(index.freshnessWeight, DEFAULT_HYBRID_FRESHNESS_WEIGHT, 0, 1),
      0,
      1
    ),
    vector_stale_penalty: parseHybridFloat(
      args?.freshness_vector_stale_penalty,
      parseHybridFloat(
        index.freshnessVectorStalePenalty,
        DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
        0,
        1
      ),
      0,
      1
    ),
    max_paths: parseHybridInt(
      args?.freshness_max_paths,
      parseHybridInt(index.freshnessMaxPaths, DEFAULT_HYBRID_FRESHNESS_MAX_PATHS, 1, 1000),
      1,
      1000
    )
  };
}

function resolveMetricsConfig(context = {}) {
  const metrics = context?.metrics || {};
  return {
    enabled: parseHybridBoolean(
      metrics.enabled ?? process.env.CLAWTY_METRICS_ENABLED,
      DEFAULT_METRICS_ENABLED
    ),
    persist_hybrid: parseHybridBoolean(
      metrics.persistHybrid ?? process.env.CLAWTY_METRICS_PERSIST_HYBRID,
      DEFAULT_METRICS_PERSIST_HYBRID
    ),
    query_preview_chars: parseHybridInt(
      metrics.queryPreviewChars ?? process.env.CLAWTY_METRICS_QUERY_PREVIEW_CHARS,
      DEFAULT_METRICS_QUERY_PREVIEW_CHARS,
      32,
      1000
    )
  };
}

function buildQueryPreview(query, maxChars) {
  const source = typeof query === "string" ? query.trim() : "";
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 3))}...`;
}

function roundHybridMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(3));
}

function buildHybridDegradationSummary(embeddingSource, freshnessSource) {
  const attemptedSources = [];
  const failedSources = [];
  if (embeddingSource?.attempted) {
    attemptedSources.push("embedding");
    if (!embeddingSource?.ok) {
      failedSources.push("embedding");
    }
  }
  if (freshnessSource?.attempted) {
    attemptedSources.push("freshness");
    if (!freshnessSource?.ok) {
      failedSources.push("freshness");
    }
  }
  const degraded = failedSources.length > 0;
  return {
    attempted_sources: attemptedSources,
    failed_sources: failedSources,
    degraded,
    degrade_rate_sample: degraded ? 1 : 0
  };
}

async function appendHybridQueryMetricEvent(workspaceRoot, event, context = {}) {
  const metricsConfig = resolveMetricsConfig(context);
  if (!metricsConfig.enabled || !metricsConfig.persist_hybrid) {
    return {
      logged: false,
      reason: "metrics_disabled"
    };
  }

  try {
    const metricsDir = resolveSafePath(workspaceRoot, METRICS_SUBDIR);
    await fs.mkdir(metricsDir, { recursive: true });
    const outputPath = path.join(metricsDir, HYBRID_QUERY_METRICS_FILE);
    await fs.appendFile(outputPath, `${JSON.stringify(event)}\n`, "utf8");
    return {
      logged: true,
      reason: null
    };
  } catch (error) {
    return {
      logged: false,
      reason: "metrics_write_failed",
      error: error.message || String(error)
    };
  }
}

function normalizeHybridSource(source) {
  if (typeof source !== "string") {
    return "unknown";
  }
  const normalized = source.trim().toLowerCase();
  return normalized || "unknown";
}

function hybridSourceScore(source) {
  const normalized = normalizeHybridSource(source);
  return HYBRID_SOURCE_SCORE[normalized] ?? HYBRID_SOURCE_SCORE.unknown;
}

function tokenizeHybridQuery(raw) {
  if (typeof raw !== "string") {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ).slice(0, 16);
}

function normalizeHybridPathPrefix(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) {
    return null;
  }
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function hybridPathScore(pathValue, pathPrefix) {
  if (!pathPrefix) {
    return 0.5;
  }
  const candidatePath = typeof pathValue === "string" ? pathValue : "";
  if (!candidatePath) {
    return 0;
  }
  if (candidatePath.startsWith(pathPrefix)) {
    return 1;
  }
  if (candidatePath.includes(pathPrefix)) {
    return 0.65;
  }
  return 0.05;
}

function hybridOverlapScore(queryTokens, candidate) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
    return 0;
  }
  const haystack = [
    String(candidate?.name || ""),
    String(candidate?.path || ""),
    String(candidate?.kind || "")
  ]
    .join(" ")
    .toLowerCase();
  let hitCount = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      hitCount += 1;
    }
  }
  return hitCount / queryTokens.length;
}

function hybridHopPenalty(candidate) {
  const source = normalizeHybridSource(candidate?.source);
  if (source === "lsp_anchor") {
    return 0.15;
  }
  return 0;
}

function hybridCandidateKey(candidate) {
  const candidatePath = String(candidate?.path || "").trim();
  if (candidatePath) {
    return `path:${candidatePath}`;
  }
  return [
    "fallback",
    String(candidate?.kind || ""),
    String(candidate?.name || "").toLowerCase()
  ].join("::");
}

function buildHybridEmbeddingText(candidate) {
  const outgoingNames = (candidate?.outgoing || [])
    .slice(0, 4)
    .map((item) => String(item?.node?.name || "").trim())
    .filter(Boolean)
    .join(" ");
  const incomingNames = (candidate?.incoming || [])
    .slice(0, 4)
    .map((item) => String(item?.node?.name || "").trim())
    .filter(Boolean)
    .join(" ");
  const providers = (candidate?.supporting_providers || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ");

  return [
    `path: ${String(candidate?.path || "")}`,
    `name: ${String(candidate?.name || "")}`,
    `kind: ${String(candidate?.kind || "")}`,
    `source: ${String(candidate?.source || "")}`,
    outgoingNames ? `outgoing: ${outgoingNames}` : "",
    incomingNames ? `incoming: ${incomingNames}` : "",
    providers ? `providers: ${providers}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let idx = 0; idx < size; idx += 1) {
    const av = Number(a[idx] || 0);
    const bv = Number(b[idx] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizedCosineScore(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const clipped = Math.max(-1, Math.min(1, numeric));
  return roundHybridMetric((clipped + 1) / 2);
}

function sortHybridCandidates(a, b) {
  if (b.hybrid_score !== a.hybrid_score) {
    return b.hybrid_score - a.hybrid_score;
  }
  const sourceDiff = hybridSourceScore(b.source) - hybridSourceScore(a.source);
  if (sourceDiff !== 0) {
    return sourceDiff;
  }
  const pathDiff = String(a.path || "").localeCompare(String(b.path || ""));
  if (pathDiff !== 0) {
    return pathDiff;
  }
  return Number(a.line || 1) - Number(b.line || 1);
}

function mapIndexResultToHybridSeed(item) {
  const filePath = String(item?.path || "");
  return {
    path: filePath,
    name: path.basename(filePath || ""),
    kind: "file",
    line: Number(item?.hit_line || 1),
    column: 1,
    lang: item?.language || null,
    source: "index",
    outgoing: [],
    incoming: []
  };
}

function mapVectorResultToHybridSeed(item) {
  const filePath = String(item?.path || "");
  return {
    path: filePath,
    name: path.basename(filePath || ""),
    kind: "chunk",
    line: Number(item?.start_line || 1),
    column: 1,
    lang: item?.language || null,
    source: "vector",
    outgoing: [],
    incoming: [],
    vector_score: Number(item?.score || 0),
    vector_layer: item?.layer || null
  };
}

function addHybridCandidate(map, candidate, provider) {
  const key = hybridCandidateKey(candidate);
  if (!key || key === "::") {
    return;
  }

  const source = normalizeHybridSource(candidate?.source);
  const providerToken = typeof provider === "string" && provider ? provider : "unknown";
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      candidate,
      providers: new Set([providerToken]),
      source_score: hybridSourceScore(source)
    });
    return;
  }

  existing.providers.add(providerToken);
  const currentSourceScore = hybridSourceScore(source);
  if (currentSourceScore > existing.source_score) {
    existing.candidate = candidate;
    existing.source_score = currentSourceScore;
  }
}

function rankHybridCandidates(entries, options) {
  const queryTokens = tokenizeHybridQuery(options?.query || "");
  const pathPrefix = normalizeHybridPathPrefix(options?.path_prefix || null);
  const explain = Boolean(options?.explain);

  const ranked = entries.map((entry) => {
    const candidate = entry.candidate;
    const sourceScore = entry.source_score;
    const overlapScore = hybridOverlapScore(queryTokens, candidate);
    const pathScore = hybridPathScore(candidate?.path, pathPrefix);
    const supportScore = Math.min(1, Math.max(0, (entry.providers.size - 1) / 2));
    const hopPenalty = hybridHopPenalty(candidate);
    const finalScore = roundHybridMetric(
      sourceScore * 0.42 + overlapScore * 0.33 + pathScore * 0.15 + supportScore * 0.1 - hopPenalty
    );

    const merged = {
      ...candidate,
      hybrid_score: finalScore,
      supporting_providers: Array.from(entry.providers.values()).sort()
    };
    if (explain) {
      merged.hybrid_explain = {
        source_score: roundHybridMetric(sourceScore),
        overlap_score: roundHybridMetric(overlapScore),
        path_score: roundHybridMetric(pathScore),
        support_score: roundHybridMetric(supportScore),
        hop_penalty: roundHybridMetric(hopPenalty),
        final_score: finalScore
      };
    }
    return merged;
  });

  ranked.sort(sortHybridCandidates);

  return ranked;
}

function classifyEmbeddingFailure(error) {
  const code = String(error?.code || "").trim();
  if (code === "EMBEDDING_REQUEST_TIMEOUT") {
    return {
      status_code: "EMBEDDING_ERROR_TIMEOUT",
      error_code: code,
      retryable: true
    };
  }
  if (code === "EMBEDDING_REQUEST_NETWORK") {
    return {
      status_code: "EMBEDDING_ERROR_NETWORK",
      error_code: code,
      retryable: true
    };
  }
  if (code === "EMBEDDING_API_HTTP_ERROR") {
    return {
      status_code: "EMBEDDING_ERROR_API",
      error_code: code,
      retryable: Boolean(error?.retryable)
    };
  }
  if (code === "EMBEDDING_RESPONSE_INVALID") {
    return {
      status_code: "EMBEDDING_ERROR_RESPONSE",
      error_code: code,
      retryable: false
    };
  }
  if (code === "EMBEDDING_INPUT_INVALID") {
    return {
      status_code: "EMBEDDING_ERROR_INPUT",
      error_code: code,
      retryable: false
    };
  }
  if (code === "EMBEDDING_API_KEY_MISSING") {
    return {
      status_code: "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY",
      error_code: code,
      retryable: false
    };
  }
  return {
    status_code: "EMBEDDING_ERROR_UNKNOWN",
    error_code: code || "EMBEDDING_UNKNOWN",
    retryable: false
  };
}

function buildEmbeddingSourceBase(config) {
  return {
    enabled: Boolean(config.enabled),
    attempted: false,
    ok: false,
    model: config.model,
    top_k: config.top_k,
    weight: config.weight,
    timeout_ms: Number(config.timeout_ms || 0),
    reranked_candidates: 0,
    latency_ms: 0,
    status_code: config.enabled ? "EMBEDDING_PENDING" : "EMBEDDING_DISABLED",
    error_code: null,
    retryable: false,
    error: null,
    rank_shift_count: 0,
    top1_changed: false,
    score_delta_mean: 0
  };
}

function buildFreshnessSourceBase(config) {
  return {
    enabled: Boolean(config.enabled),
    attempted: false,
    ok: false,
    stale_after_ms: Number(config.stale_after_ms || 0),
    weight: Number(config.weight || 0),
    vector_stale_penalty: Number(config.vector_stale_penalty || 0),
    sampled_paths: 0,
    sampled_paths_limit: Number(config.max_paths || 0),
    sampled_paths_with_stat: 0,
    missing_paths: 0,
    candidates_with_freshness: 0,
    stale_candidates: 0,
    stale_vector_candidates: 0,
    stale_hit_rate: 0,
    status_code: config.enabled ? "FRESHNESS_PENDING" : "FRESHNESS_DISABLED",
    error: null
  };
}

function normalizeCandidatePath(pathValue) {
  if (typeof pathValue !== "string") {
    return null;
  }
  const trimmed = pathValue.trim().replace(/\\/g, "/");
  return trimmed.length > 0 ? trimmed : null;
}

function freshnessScoreFromAge(ageMs, staleAfterMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return null;
  }
  const threshold = Math.max(1000, Number(staleAfterMs || DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS));
  const ratio = Math.min(1, ageMs / threshold);
  return roundHybridMetric(1 - ratio);
}

async function collectFreshnessByPath(workspaceRoot, paths) {
  const nowMs = Date.now();
  const map = new Map();
  await Promise.all(
    paths.map(async (relativePath) => {
      try {
        const fullPath = resolveSafePath(workspaceRoot, relativePath);
        const stat = await fs.stat(fullPath);
        const mtimeMs = Number(stat.mtimeMs || 0);
        map.set(relativePath, {
          exists: true,
          mtime_ms: mtimeMs,
          age_ms: Number.isFinite(mtimeMs) && mtimeMs > 0 ? Math.max(0, nowMs - mtimeMs) : null
        });
      } catch {
        map.set(relativePath, {
          exists: false,
          mtime_ms: null,
          age_ms: null
        });
      }
    })
  );
  return map;
}

async function rerankHybridCandidatesWithFreshness(ranked, args, context) {
  const config = resolveHybridFreshnessConfig(args, context);
  const base = buildFreshnessSourceBase(config);
  if (!config.enabled) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "FRESHNESS_DISABLED"
      }
    };
  }

  if (!Array.isArray(ranked) || ranked.length === 0) {
    return {
      ranked,
      source: {
        ...base,
        attempted: false,
        ok: true,
        status_code: "FRESHNESS_NOT_ATTEMPTED_NO_CANDIDATES"
      }
    };
  }

  const uniquePaths = [];
  const seenPaths = new Set();
  for (const candidate of ranked) {
    const candidatePath = normalizeCandidatePath(candidate?.path);
    if (!candidatePath || seenPaths.has(candidatePath)) {
      continue;
    }
    seenPaths.add(candidatePath);
    uniquePaths.push(candidatePath);
    if (uniquePaths.length >= config.max_paths) {
      break;
    }
  }

  if (uniquePaths.length === 0) {
    return {
      ranked,
      source: {
        ...base,
        attempted: false,
        ok: true,
        sampled_paths: 0,
        status_code: "FRESHNESS_NOT_ATTEMPTED_NO_PATHS"
      }
    };
  }

  const freshnessByPath = await collectFreshnessByPath(context.workspaceRoot, uniquePaths);
  const explain = Boolean(args?.explain);
  let withFreshness = 0;
  let staleCandidates = 0;
  let staleVectorCandidates = 0;
  let sampledWithStat = 0;

  for (const value of freshnessByPath.values()) {
    if (value?.exists) {
      sampledWithStat += 1;
    }
  }

  const reranked = ranked.map((candidate) => {
    const pathValue = normalizeCandidatePath(candidate?.path);
    const freshnessMeta = pathValue ? freshnessByPath.get(pathValue) : null;
    const ageMs = Number(freshnessMeta?.age_ms);
    const freshnessScore = freshnessScoreFromAge(ageMs, config.stale_after_ms);
    const isStale = Number.isFinite(ageMs) && ageMs > config.stale_after_ms;

    const providers = new Set(
      [candidate?.source, ...(Array.isArray(candidate?.supporting_providers) ? candidate.supporting_providers : [])]
        .map((item) => normalizeHybridSource(item))
        .filter(Boolean)
    );
    const hasVectorSupport = providers.has("vector");

    let nextScore = roundHybridMetric(candidate.hybrid_score);
    let vectorPenaltyApplied = 0;
    if (freshnessScore !== null) {
      withFreshness += 1;
      if (isStale) {
        staleCandidates += 1;
      }
      nextScore = roundHybridMetric(
        nextScore * (1 - config.weight) + freshnessScore * config.weight
      );
      if (hasVectorSupport && isStale) {
        staleVectorCandidates += 1;
        const staleOverMs = Math.max(0, ageMs - config.stale_after_ms);
        const staleRatio = Math.min(1, staleOverMs / config.stale_after_ms);
        vectorPenaltyApplied = roundHybridMetric(
          config.vector_stale_penalty * (0.5 + staleRatio * 0.5)
        );
        nextScore = roundHybridMetric(nextScore * (1 - vectorPenaltyApplied));
      }
    }

    const merged = {
      ...candidate,
      hybrid_score: nextScore,
      freshness_score: freshnessScore,
      freshness_age_ms: Number.isFinite(ageMs) ? Math.floor(ageMs) : null,
      freshness_mtime_ms: Number.isFinite(Number(freshnessMeta?.mtime_ms))
        ? Math.floor(Number(freshnessMeta?.mtime_ms))
        : null,
      freshness_stale: Boolean(isStale)
    };
    if (explain) {
      merged.hybrid_explain = {
        ...(candidate.hybrid_explain || {}),
        freshness_score: freshnessScore,
        freshness_age_ms: Number.isFinite(ageMs) ? Math.floor(ageMs) : null,
        freshness_weight: roundHybridMetric(config.weight),
        freshness_vector_penalty: vectorPenaltyApplied,
        final_score: nextScore
      };
    }
    return merged;
  });

  reranked.sort(sortHybridCandidates);

  const missingPaths = uniquePaths.length - sampledWithStat;
  return {
    ranked: reranked,
    source: {
      ...base,
      attempted: true,
      ok: true,
      sampled_paths: uniquePaths.length,
      sampled_paths_with_stat: sampledWithStat,
      missing_paths: missingPaths,
      candidates_with_freshness: withFreshness,
      stale_candidates: staleCandidates,
      stale_vector_candidates: staleVectorCandidates,
      stale_hit_rate:
        withFreshness > 0 ? roundHybridMetric(staleCandidates / withFreshness) : 0,
      status_code: "FRESHNESS_OK"
    }
  };
}

async function rerankHybridCandidatesWithEmbedding(ranked, args, context) {
  const config = resolveHybridEmbeddingConfig(args, context);
  const base = buildEmbeddingSourceBase(config);
  if (!config.enabled) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_DISABLED"
      }
    };
  }

  if (!config.client && !config.api_key) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY",
        error_code: "EMBEDDING_API_KEY_MISSING",
        error: "embedding api key is missing"
      }
    };
  }

  const rerankCount = Math.min(ranked.length, Math.max(1, config.top_k));
  if (rerankCount === 0) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_NOT_ATTEMPTED_NO_CANDIDATES",
        error_code: "EMBEDDING_NO_CANDIDATES",
        error: "no hybrid candidates available"
      }
    };
  }

  const explain = Boolean(args?.explain);
  const pool = ranked.slice(0, rerankCount);
  const rest = ranked.slice(rerankCount);

  const input = [
    String(args?.query || ""),
    ...pool.map((candidate) => buildHybridEmbeddingText(candidate))
  ];

  const startedAt = Date.now();
  let vectors;
  try {
    vectors = await createEmbeddings({
      apiKey: config.api_key,
      baseUrl: config.base_url,
      model: config.model,
      input,
      timeoutMs: config.timeout_ms,
      client: config.client
    });
  } catch (error) {
    const classified = classifyEmbeddingFailure(
      error instanceof EmbeddingError ? error : error
    );
    return {
      ranked,
      source: {
        ...base,
        attempted: true,
        latency_ms: Math.max(0, Date.now() - startedAt),
        status_code: classified.status_code,
        error_code: classified.error_code,
        retryable: classified.retryable,
        error: error.message || String(error)
      }
    };
  }

  const queryVector = vectors[0];
  let scoreDeltaTotal = 0;
  const rerankedPool = pool.map((candidate, idx) => {
    const baseScore = roundHybridMetric(candidate.hybrid_score);
    const candidateVector = vectors[idx + 1];
    const embeddingScore = normalizedCosineScore(cosineSimilarity(queryVector, candidateVector));
    const finalScore = roundHybridMetric(baseScore * (1 - config.weight) + embeddingScore * config.weight);
    scoreDeltaTotal += Math.abs(finalScore - baseScore);
    const next = {
      ...candidate,
      hybrid_score: finalScore
    };
    if (explain) {
      next.hybrid_explain = {
        ...(candidate.hybrid_explain || {}),
        base_score: baseScore,
        embedding_score: embeddingScore,
        embedding_weight: roundHybridMetric(config.weight),
        final_score: finalScore
      };
    }
    return next;
  });

  const merged = [...rerankedPool, ...rest];
  merged.sort(sortHybridCandidates);
  const beforeOrder = pool.map((candidate) => hybridCandidateKey(candidate));
  const afterPosition = new Map(
    merged.map((candidate, idx) => [hybridCandidateKey(candidate), idx])
  );
  let rankShiftCount = 0;
  for (let idx = 0; idx < beforeOrder.length; idx += 1) {
    const key = beforeOrder[idx];
    if (!afterPosition.has(key)) {
      continue;
    }
    if (afterPosition.get(key) !== idx) {
      rankShiftCount += 1;
    }
  }
  const top1Changed =
    beforeOrder.length > 0 &&
    merged.length > 0 &&
    beforeOrder[0] !== hybridCandidateKey(merged[0]);

  return {
    ranked: merged,
    source: {
      ...base,
      attempted: true,
      ok: true,
      latency_ms: Math.max(0, Date.now() - startedAt),
      status_code: "EMBEDDING_OK",
      error_code: null,
      retryable: false,
      reranked_candidates: rerankCount,
      rank_shift_count: rankShiftCount,
      top1_changed: top1Changed,
      score_delta_mean: rerankCount > 0 ? roundHybridMetric(scoreDeltaTotal / rerankCount) : 0,
      error: null
    }
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
  const semanticArgs = {
    query,
    top_k: Math.min(30, scanTopK),
    max_neighbors: effectiveArgs?.max_neighbors,
    max_hops: effectiveArgs?.max_hops,
    per_hop_limit: effectiveArgs?.per_hop_limit,
    edge_type: effectiveArgs?.edge_type,
    path_prefix: effectiveArgs?.path_prefix
  };

  const vectorQueryPromise = vectorEnabled
    ? queryVectorIndex(
        context.workspaceRoot,
        {
          query,
          top_k: Math.min(100, Math.max(scanTopK, topK * 4)),
          max_candidates: effectiveArgs?.vector_max_candidates,
          path_prefix: effectiveArgs?.path_prefix,
          language: effectiveArgs?.language,
          layers: effectiveArgs?.vector_layers,
          model: effectiveArgs?.embedding_model
        },
        {
          embedding: context.embedding || {}
        }
      ).catch((error) => ({
        ok: false,
        skipped: false,
        error: error?.message || String(error),
        error_code:
          /embedding api key is missing/i.test(String(error?.message || "")) ||
          /EMBEDDING_API_KEY_MISSING/i.test(String(error?.code || ""))
            ? "EMBEDDING_API_KEY_MISSING"
            : "VECTOR_QUERY_FAILED"
      }))
    : Promise.resolve({
        ok: false,
        skipped: true,
        error: "vector source disabled"
      });

  const [semanticResult, syntaxResult, indexResult, vectorResult] = await Promise.all([
    querySemanticGraph(context.workspaceRoot, semanticArgs),
    querySyntaxIndex(context.workspaceRoot, {
      query,
      top_k: Math.min(30, scanTopK),
      max_neighbors: effectiveArgs?.max_neighbors,
      path_prefix: effectiveArgs?.path_prefix
    }),
    queryCodeIndex(context.workspaceRoot, {
      query,
      top_k: Math.min(50, Math.max(scanTopK, 20)),
      path_prefix: effectiveArgs?.path_prefix,
      language: effectiveArgs?.language
    }),
    vectorQueryPromise
  ]);

  const scannedCandidates = [];
  const deduped = new Map();

  if (semanticResult?.ok && Array.isArray(semanticResult.seeds)) {
    for (const seed of semanticResult.seeds) {
      scannedCandidates.push(seed);
      addHybridCandidate(deduped, seed, "semantic");
    }
  }

  if (syntaxResult?.ok && Array.isArray(syntaxResult.seeds)) {
    for (const seed of syntaxResult.seeds) {
      const mapped = mapSyntaxSeedToSemanticSeed(seed, effectiveArgs?.edge_type || null);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "syntax");
    }
  }

  if (indexResult?.ok && Array.isArray(indexResult.results)) {
    for (const item of indexResult.results) {
      const mapped = mapIndexResultToHybridSeed(item);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "index");
    }
  }

  if (vectorResult?.ok && Array.isArray(vectorResult.results)) {
    for (const item of vectorResult.results) {
      const mapped = mapVectorResultToHybridSeed(item);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "vector");
    }
  }

  const ranked = rankHybridCandidates(Array.from(deduped.values()), {
    query,
    path_prefix: effectiveArgs?.path_prefix,
    explain: effectiveArgs?.explain
  });
  const embeddingRerank = await rerankHybridCandidatesWithEmbedding(
    ranked,
    {
      ...effectiveArgs,
      query
    },
    context
  );
  const finalRanked = Array.isArray(embeddingRerank?.ranked) ? embeddingRerank.ranked : ranked;
  const freshnessRerank = await rerankHybridCandidatesWithFreshness(
    finalRanked,
    {
      ...effectiveArgs,
      query
    },
    context
  );
  const freshnessRanked = Array.isArray(freshnessRerank?.ranked)
    ? freshnessRerank.ranked
    : finalRanked;
  const seeds = freshnessRanked.slice(0, topK);
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
  const metricsWrite = await appendHybridQueryMetricEvent(
    context.workspaceRoot,
    {
      timestamp: new Date().toISOString(),
      event_type: "hybrid_query",
      query_preview: buildQueryPreview(query, metricsConfig.query_preview_chars),
      query_chars: query.length,
      query_total_ms: queryTotalMs,
      top_k: topK,
      scanned_candidates: scannedCandidates.length,
      deduped_candidates: deduped.size,
      total_seeds: seeds.length,
      filters: {
        path_prefix: effectiveArgs?.path_prefix || null,
        language: effectiveArgs?.language || null
      },
      sources: {
        semantic_ok: Boolean(semanticResult?.ok),
        syntax_ok: Boolean(syntaxResult?.ok),
        index_ok: Boolean(indexResult?.ok),
        vector: {
          enabled: vectorEnabled,
          ok: Boolean(vectorResult?.ok),
          candidates: Array.isArray(vectorResult?.results)
            ? vectorResult.results.length
            : 0
        },
        embedding: {
          enabled: Boolean(embeddingSource.enabled),
          attempted: Boolean(embeddingSource.attempted),
          ok: Boolean(embeddingSource.ok),
          status_code: embeddingSource.status_code || null,
          error_code: embeddingSource.error_code || null,
          retryable: Boolean(embeddingSource.retryable),
          reranked_candidates: Number(embeddingSource.reranked_candidates || 0),
          timeout_ms: Number(embeddingSource.timeout_ms || 0),
          latency_ms: Number(embeddingSource.latency_ms || 0)
        },
        freshness: {
          enabled: Boolean(freshnessSource.enabled),
          attempted: Boolean(freshnessSource.attempted),
          ok: Boolean(freshnessSource.ok),
          status_code: freshnessSource.status_code || null,
          stale_hit_rate: Number(freshnessSource.stale_hit_rate || 0),
          stale_vector_candidates: Number(
            freshnessSource.stale_vector_candidates || 0
          )
        }
      },
      degradation,
      tuner: {
        enabled: Boolean(tunerDecision?.enabled),
        mode: tunerDecision?.mode || "off",
        decision_id: tunerDecision?.decision_id || null,
        arm_id: tunerDecision?.arm_id || null,
        explicit_override: Boolean(tunerDecision?.explicit_override),
        params_applied: tunerDecision?.applied_params || {},
        selection_strategy: tunerDecision?.selection?.strategy || null,
        reward: Number(tunerOutcome?.reward || 0),
        success: Boolean(tunerOutcome?.success),
        outcome_recorded: Boolean(tunerOutcome?.recorded)
      }
    },
    context
  );

  return {
    ok: true,
    provider: "hybrid",
    query,
    query_total_ms: queryTotalMs,
    filters: {
      edge_type: effectiveArgs?.edge_type || null,
      path_prefix: effectiveArgs?.path_prefix || null,
      language: effectiveArgs?.language || null,
      max_hops: Number.isFinite(Number(effectiveArgs?.max_hops))
        ? Math.max(1, Math.floor(Number(effectiveArgs.max_hops)))
        : 1,
      per_hop_limit: Number.isFinite(Number(effectiveArgs?.per_hop_limit))
        ? Math.max(1, Math.floor(Number(effectiveArgs.per_hop_limit)))
        : null,
      explain: Boolean(effectiveArgs?.explain),
      embedding: {
        enabled: Boolean(embeddingSource.enabled),
        attempted: Boolean(embeddingSource.attempted),
        model: embeddingSource.model,
        top_k: Number(embeddingSource.top_k || 0),
        weight: Number(embeddingSource.weight || 0),
        timeout_ms: Number(embeddingSource.timeout_ms || 0),
        status_code: embeddingSource.status_code || null
      },
      freshness: {
        enabled: Boolean(freshnessSource.enabled),
        attempted: Boolean(freshnessSource.attempted),
        stale_after_ms: Number(freshnessSource.stale_after_ms || 0),
        weight: Number(freshnessSource.weight || 0),
        vector_stale_penalty: Number(freshnessSource.vector_stale_penalty || 0),
        status_code: freshnessSource.status_code || null
      }
    },
    sources: {
      semantic: {
        ok: Boolean(semanticResult?.ok),
        candidates: Array.isArray(semanticResult?.seeds) ? semanticResult.seeds.length : 0,
        fallback: Boolean(semanticResult?.fallback),
        error: semanticResult?.ok ? null : semanticResult?.error || null
      },
      syntax: {
        ok: Boolean(syntaxResult?.ok),
        candidates: Array.isArray(syntaxResult?.seeds) ? syntaxResult.seeds.length : 0,
        error: syntaxResult?.ok ? null : syntaxResult?.error || null
      },
      index: {
        ok: Boolean(indexResult?.ok),
        candidates: Array.isArray(indexResult?.results) ? indexResult.results.length : 0,
        error: indexResult?.ok ? null : indexResult?.error || null
      },
      vector: {
        enabled: vectorEnabled,
        ok: Boolean(vectorResult?.ok),
        candidates: Array.isArray(vectorResult?.results) ? vectorResult.results.length : 0,
        skipped: Boolean(vectorResult?.skipped),
        error: vectorResult?.ok ? null : vectorResult?.error || null
      },
      embedding: {
        enabled: Boolean(embeddingSource.enabled),
        attempted: Boolean(embeddingSource.attempted),
        ok: Boolean(embeddingSource.ok),
        model: embeddingSource.model || null,
        reranked_candidates: Number(embeddingSource.reranked_candidates || 0),
        timeout_ms: Number(embeddingSource.timeout_ms || 0),
        latency_ms: Number(embeddingSource.latency_ms || 0),
        status_code: embeddingSource.status_code || null,
        error_code: embeddingSource.error_code || null,
        retryable: Boolean(embeddingSource.retryable),
        rank_shift_count: Number(embeddingSource.rank_shift_count || 0),
        top1_changed: Boolean(embeddingSource.top1_changed),
        score_delta_mean: Number(embeddingSource.score_delta_mean || 0),
        error: embeddingSource.error || null
      },
      freshness: {
        enabled: Boolean(freshnessSource.enabled),
        attempted: Boolean(freshnessSource.attempted),
        ok: Boolean(freshnessSource.ok),
        stale_after_ms: Number(freshnessSource.stale_after_ms || 0),
        weight: Number(freshnessSource.weight || 0),
        vector_stale_penalty: Number(freshnessSource.vector_stale_penalty || 0),
        sampled_paths: Number(freshnessSource.sampled_paths || 0),
        sampled_paths_limit: Number(freshnessSource.sampled_paths_limit || 0),
        sampled_paths_with_stat: Number(freshnessSource.sampled_paths_with_stat || 0),
        missing_paths: Number(freshnessSource.missing_paths || 0),
        candidates_with_freshness: Number(freshnessSource.candidates_with_freshness || 0),
        stale_candidates: Number(freshnessSource.stale_candidates || 0),
        stale_vector_candidates: Number(freshnessSource.stale_vector_candidates || 0),
        stale_hit_rate: Number(freshnessSource.stale_hit_rate || 0),
        status_code: freshnessSource.status_code || null,
        error: freshnessSource.error || null
      }
    },
    degradation,
    observability: {
      metrics_logged: Boolean(metricsWrite.logged),
      metrics_reason: metricsWrite.reason || null,
      metrics_error: metricsWrite.error || null,
      online_tuner: {
        enabled: Boolean(tunerDecision?.enabled),
        mode: tunerDecision?.mode || "off",
        decision_id: tunerDecision?.decision_id || null,
        arm_id: tunerDecision?.arm_id || null,
        explicit_override: Boolean(tunerDecision?.explicit_override),
        params_applied: tunerDecision?.applied_params || {},
        selection_strategy: tunerDecision?.selection?.strategy || null,
        selection_candidates: Array.isArray(tunerDecision?.selection?.candidates)
          ? tunerDecision.selection.candidates.length
          : 0,
        selection_blocked: Array.isArray(tunerDecision?.selection?.blocked)
          ? tunerDecision.selection.blocked.length
          : 0,
        reward: Number(tunerOutcome?.reward || 0),
        success: Boolean(tunerOutcome?.success),
        outcome_recorded: Boolean(tunerOutcome?.recorded),
        outcome_reason: tunerOutcome?.reason || null,
        outcome_error: tunerOutcome?.error || null
      }
    },
    priority_policy: priorityPolicy,
    total_seeds: seeds.length,
    scanned_candidates: scannedCandidates.length,
    deduped_candidates: deduped.size,
    language_distribution: {
      scanned_candidates: summarizeFallbackSeedLanguages(scannedCandidates),
      deduped_candidates: summarizeFallbackSeedLanguages(
        Array.from(deduped.values()).map((entry) => entry.candidate)
      ),
      returned_seeds: summarizeFallbackSeedLanguages(seeds)
    },
    seeds
  };
}

async function getSemanticGraphStatsTool(context) {
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

async function getVectorIndexStatsTool(context) {
  return getVectorIndexStats(context.workspaceRoot);
}

async function mergeVectorDeltaTool(context) {
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

export async function runTool(name, args, context) {
  if (name === "read_file") {
    return readFileTool(args, context);
  }
  if (name === "write_file") {
    return writeFileTool(args, context);
  }
  if (name === "run_shell") {
    return runShellTool(args, context);
  }
  if (name === "apply_patch") {
    return applyPatchTool(args, context);
  }
  if (name === "build_code_index") {
    return buildCodeIndexTool(args, context);
  }
  if (name === "query_code_index") {
    return queryCodeIndexTool(args, context);
  }
  if (name === "refresh_code_index") {
    return refreshCodeIndexTool(args, context);
  }
  if (name === "get_index_stats") {
    return getIndexStatsTool(args, context);
  }
  if (name === "build_semantic_graph") {
    return buildSemanticGraphTool(args, context);
  }
  if (name === "refresh_semantic_graph") {
    return refreshSemanticGraphTool(args, context);
  }
  if (name === "import_precise_index") {
    return importPreciseIndexTool(args, context);
  }
  if (name === "query_semantic_graph") {
    return querySemanticGraphTool(args, context);
  }
  if (name === "query_hybrid_index") {
    return queryHybridIndexTool(args, context);
  }
  if (name === "get_semantic_graph_stats") {
    return getSemanticGraphStatsTool(context);
  }
  if (name === "build_syntax_index") {
    return buildSyntaxIndexTool(args, context);
  }
  if (name === "refresh_syntax_index") {
    return refreshSyntaxIndexTool(args, context);
  }
  if (name === "query_syntax_index") {
    return querySyntaxIndexTool(args, context);
  }
  if (name === "get_syntax_index_stats") {
    return getSyntaxIndexStatsTool(args, context);
  }
  if (name === "build_vector_index") {
    return buildVectorIndexTool(args, context);
  }
  if (name === "refresh_vector_index") {
    return refreshVectorIndexTool(args, context);
  }
  if (name === "query_vector_index") {
    return queryVectorIndexTool(args, context);
  }
  if (name === "get_vector_index_stats") {
    return getVectorIndexStatsTool(context);
  }
  if (name === "merge_vector_delta") {
    return mergeVectorDeltaTool(context);
  }
  if (name === "lsp_definition") {
    return lspDefinitionTool(args, context);
  }
  if (name === "lsp_references") {
    return lspReferencesTool(args, context);
  }
  if (name === "lsp_workspace_symbols") {
    return lspWorkspaceSymbolsTool(args, context);
  }
  if (name === "lsp_health") {
    return lspHealthTool(args, context);
  }
  throw new Error(`Unknown tool: ${name}`);
}
