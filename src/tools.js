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
import { createLocalToolHandlers } from "./tool-local-handlers.js";
import { createQueryToolHandlers } from "./tool-query-handlers.js";

export { TOOL_DEFINITIONS };
export { resolveRunShellExecutable };

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_TEXT = DEFAULT_MAX_TOOL_TEXT;
const METRICS_SUBDIR = path.join(".clawty", "metrics");
const HYBRID_QUERY_METRICS_FILE = "hybrid-query.jsonl";
const LOCAL_TOOL_HANDLERS = createLocalToolHandlers({
  path,
  fs,
  os,
  execAsync,
  execFileAsync,
  maxToolText: MAX_TOOL_TEXT,
  resolveSafePath,
  truncate,
  isBlockedCommand,
  resolveRunShellExecutable,
  extractPatchedFiles
});

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
  ...LOCAL_TOOL_HANDLERS,
  ...QUERY_TOOL_HANDLERS
};

export async function runTool(name, args, context) {
  const handler = TOOL_HANDLERS[name];
  if (typeof handler === "function") {
    return handler(args, context);
  }
  throw new Error(`Unknown tool: ${name}`);
}
