import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
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
  getSemanticGraphStats
} from "./semantic-graph.js";
import {
  buildSyntaxIndex,
  querySyntaxIndex,
  refreshSyntaxIndex,
  getSyntaxIndexStats
} from "./syntax-index.js";
import {
  querySemanticGraphWithFallback
} from "./semantic-fallback.js";
import {
  buildVectorIndex,
  refreshVectorIndex,
  queryVectorIndex,
  getVectorIndexStats,
  mergeVectorDelta
} from "./vector-index.js";
import { runHybridQueryPipeline } from "./hybrid-query-pipeline.js";
import {
  lspDefinition,
  lspHealth,
  lspReferences,
  lspWorkspaceSymbols
} from "./lsp-manager.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";
import {
  DEFAULT_MAX_TOOL_TEXT,
  extractPatchedFiles,
  isBlockedCommand,
  isPlainObject,
  resolveRunShellExecutable,
  resolveSafePath,
  truncate
} from "./tool-guards.js";

export { TOOL_DEFINITIONS };
export { resolveRunShellExecutable };

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_TEXT = DEFAULT_MAX_TOOL_TEXT;
const METRICS_SUBDIR = path.join(".clawty", "metrics");
const HYBRID_QUERY_METRICS_FILE = "hybrid-query.jsonl";

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

async function querySemanticGraphTool(args, context) {
  return querySemanticGraphWithFallback(context.workspaceRoot, args);
}

async function queryHybridIndexTool(args, context) {
  return runHybridQueryPipeline({
    args,
    context,
    resolveSafePath,
    metricsSubdir: METRICS_SUBDIR,
    metricsFileName: HYBRID_QUERY_METRICS_FILE
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
