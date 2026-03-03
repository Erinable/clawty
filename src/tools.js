import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
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

export { TOOL_DEFINITIONS };

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
