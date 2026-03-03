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
import { createQueryToolHandlers } from "./tool-query-handlers.js";

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

const QUERY_TOOL_HANDLERS = createQueryToolHandlers({
  buildCodeIndex,
  getIndexStats,
  queryCodeIndex,
  refreshCodeIndex,
  buildSemanticGraph,
  refreshSemanticGraph,
  importPreciseIndex,
  getSemanticGraphStats,
  buildSyntaxIndex,
  querySyntaxIndex,
  refreshSyntaxIndex,
  getSyntaxIndexStats,
  querySemanticGraphWithFallback,
  buildVectorIndex,
  refreshVectorIndex,
  queryVectorIndex,
  getVectorIndexStats,
  mergeVectorDelta,
  runHybridQueryPipeline,
  lspDefinition,
  lspHealth,
  lspReferences,
  lspWorkspaceSymbols,
  resolveSafePath,
  metricsSubdir: METRICS_SUBDIR,
  hybridQueryMetricsFile: HYBRID_QUERY_METRICS_FILE
});

const TOOL_HANDLERS = {
  read_file: readFileTool,
  write_file: writeFileTool,
  run_shell: runShellTool,
  apply_patch: applyPatchTool,
  ...QUERY_TOOL_HANDLERS
};

export async function runTool(name, args, context) {
  const handler = TOOL_HANDLERS[name];
  if (typeof handler === "function") {
    return handler(args, context);
  }
  throw new Error(`Unknown tool: ${name}`);
}
