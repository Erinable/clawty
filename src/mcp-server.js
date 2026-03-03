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
import { isPlainObject, logWith, toFiniteInteger } from "./mcp-server-utils.js";
import { runMcpServerCliWithDeps } from "./mcp-server-cli.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

const MCP_SERVER_NAME = "clawty-mcp";
const MCP_SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const LOW_LEVEL_CODE_TOOL_DEFINITIONS = buildLowLevelCodeToolDefinitions(TOOL_DEFINITIONS);
const LOW_LEVEL_CODE_TOOL_NAME_SET = new Set(LOW_LEVEL_CODE_TOOL_DEFINITIONS.map((tool) => tool.name));

function buildToolDefinitions(serverOptions = {}) {
  return buildToolDefinitionsWithDeps(serverOptions, {
    resolveFacadeToolNamesForToolsets,
    monitorToolDefinitions: MONITOR_TOOL_DEFINITIONS,
    lowLevelCodeToolDefinitions: LOW_LEVEL_CODE_TOOL_DEFINITIONS
  });
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

async function main() {
  return runMcpServerCliWithDeps(process.argv.slice(2), {
    parseMcpServerArgs,
    resolveMcpServerRuntimeOptions,
    loadConfig,
    createRuntimeLogger,
    runMcpServer,
    isAbsolutePath: path.isAbsolute,
    resolvePath: path.resolve,
    stderr: process.stderr
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
