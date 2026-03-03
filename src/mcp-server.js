import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRuntimeLogger } from "./logger.js";
import {
  callCodeContextFacadeWithDeps,
  callExplainCodeFacadeWithDeps,
  callImpactAnalysisFacadeWithDeps,
  callTraceCallChainFacadeWithDeps
} from "./mcp-analysis-facades.js";
import { createFacadeToolHandlers } from "./mcp-facade-handlers.js";
import {
  collectPathsFromSearchResult,
  collectPathsFromSemanticResult,
  collectReferencePaths,
  dedupePaths,
  hasLocationArgs
} from "./mcp-impact-utils.js";
import { createCallLowLevelCodeTool } from "./mcp-low-level-tools.js";
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
import { callSearchCodeFacadeWithDeps } from "./mcp-search-facade.js";
import { callReindexCodebaseFacadeWithDeps } from "./mcp-reindex-facade.js";
import { callToolWithDeps } from "./mcp-tool-dispatch.js";
import {
  DEFAULT_TOOLSETS,
  parseToolsetTokens,
  resolveEnabledToolsets,
  resolveFacadeToolNamesForToolsets,
  VALID_TOOLSETS
} from "./mcp-toolset-policy.js";
import {
  buildLowLevelCodeToolDefinitions,
  buildToolDefinitionsWithDeps,
  FACADE_TOOL_NAME_SET
} from "./mcp-tool-definitions.js";
import {
  findHeaderTerminator,
  parseContentLength,
  readHttpRequestBody,
  writeJsonResponse,
  writeMessage,
  writeNoContent
} from "./mcp-transport-utils.js";
import { runHttpTransportWithDeps, runStdioTransportWithDeps } from "./mcp-transport-runners.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

const MCP_SERVER_NAME = "clawty-mcp";
const MCP_SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const LOW_LEVEL_CODE_TOOL_DEFINITIONS = buildLowLevelCodeToolDefinitions(TOOL_DEFINITIONS);
const LOW_LEVEL_CODE_TOOL_NAME_SET = new Set(LOW_LEVEL_CODE_TOOL_DEFINITIONS.map((tool) => tool.name));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logWith(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, fields);
}

function buildToolDefinitions(serverOptions = {}) {
  return buildToolDefinitionsWithDeps(serverOptions, {
    resolveFacadeToolNamesForToolsets,
    monitorToolDefinitions: MONITOR_TOOL_DEFINITIONS,
    lowLevelCodeToolDefinitions: LOW_LEVEL_CODE_TOOL_DEFINITIONS
  });
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

const callLowLevelCodeTool = createCallLowLevelCodeTool({
  runTool,
  resolvePath: path.resolve,
  isPlainObject
});

async function callSearchCodeFacade(args, serverOptions = {}) {
  return callSearchCodeFacadeWithDeps(args, {
    isPlainObject,
    toFiniteInteger,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callGoToDefinitionFacade(args, serverOptions = {}) {
  return callLowLevelCodeTool("lsp_definition", args, serverOptions);
}

async function callFindReferencesFacade(args, serverOptions = {}) {
  return callLowLevelCodeTool("lsp_references", args, serverOptions);
}

async function callCodeContextFacade(args, serverOptions = {}) {
  return callCodeContextFacadeWithDeps(args, {
    isPlainObject,
    toFiniteInteger,
    callSearchCodeFacade,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callReindexCodebaseFacade(args, serverOptions = {}) {
  return callReindexCodebaseFacadeWithDeps(args, {
    isPlainObject,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callExplainCodeFacade(args, serverOptions = {}) {
  return callExplainCodeFacadeWithDeps(args, {
    isPlainObject,
    toFiniteInteger,
    callSearchCodeFacade,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callTraceCallChainFacade(args, serverOptions = {}) {
  return callTraceCallChainFacadeWithDeps(args, {
    isPlainObject,
    toFiniteInteger,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callImpactAnalysisFacade(args, serverOptions = {}) {
  return callImpactAnalysisFacadeWithDeps(args, {
    isPlainObject,
    toFiniteInteger,
    hasLocationArgs,
    dedupePaths,
    collectReferencePaths,
    collectPathsFromSearchResult,
    collectPathsFromSemanticResult,
    callGoToDefinitionFacade,
    callFindReferencesFacade,
    callSearchCodeFacade,
    callLowLevelCodeTool,
    serverOptions
  });
}

async function callMonitorTool(name, args, serverOptions = {}) {
  return callMonitorToolModule(
    name,
    args,
    serverOptions.workspaceRoot
  );
}

const FACADE_TOOL_HANDLERS = createFacadeToolHandlers({
  callMonitorTool,
  callSearchCodeFacade,
  callGoToDefinitionFacade,
  callFindReferencesFacade,
  callCodeContextFacade,
  callReindexCodebaseFacade,
  callExplainCodeFacade,
  callTraceCallChainFacade,
  callImpactAnalysisFacade
});

async function callTool(name, args, serverOptions = {}) {
  return callToolWithDeps(name, args, serverOptions, {
    facadeToolNameSet: FACADE_TOOL_NAME_SET,
    facadeToolHandlers: FACADE_TOOL_HANDLERS,
    monitorToolNameSet: MONITOR_TOOL_NAME_SET,
    lowLevelCodeToolNameSet: LOW_LEVEL_CODE_TOOL_NAME_SET,
    resolveDefaultFacadeToolNames: () => resolveFacadeToolNamesForToolsets(new Set(DEFAULT_TOOLSETS)),
    callMonitorTool,
    callLowLevelCodeTool
  });
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
  return runStdioTransportWithDeps(serverOptions, tools, logger, {
    handleRpcRequest,
    buildRpcError,
    writeMessage,
    logWith,
    findHeaderTerminator,
    parseContentLength
  });
}

async function runHttpTransport(serverOptions, tools, logger) {
  return runHttpTransportWithDeps(serverOptions, tools, logger, {
    handleRpcRequest,
    buildRpcError,
    readHttpRequestBody,
    writeJsonResponse,
    writeNoContent,
    logWith
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
