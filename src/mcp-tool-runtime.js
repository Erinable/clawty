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
import { callReindexCodebaseFacadeWithDeps } from "./mcp-reindex-facade.js";
import { callSearchCodeFacadeWithDeps } from "./mcp-search-facade.js";
import { isPlainObject, toFiniteInteger } from "./mcp-server-utils.js";
import { callToolWithDeps } from "./mcp-tool-dispatch.js";
import { DEFAULT_TOOLSETS } from "./mcp-toolset-policy.js";

export function createMcpToolRuntime(deps = {}) {
  const {
    runTool,
    resolvePath,
    facadeToolNameSet,
    monitorToolNameSet,
    lowLevelCodeToolNameSet,
    resolveFacadeToolNamesForToolsets,
    callMonitorToolBase
  } = deps;

  const callLowLevelCodeTool = createCallLowLevelCodeTool({
    runTool,
    resolvePath,
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
    return callMonitorToolBase(name, args, serverOptions.workspaceRoot);
  }

  const facadeToolHandlers = createFacadeToolHandlers({
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
      facadeToolNameSet,
      facadeToolHandlers,
      monitorToolNameSet,
      lowLevelCodeToolNameSet,
      resolveDefaultFacadeToolNames: () =>
        resolveFacadeToolNamesForToolsets(new Set(DEFAULT_TOOLSETS)),
      callMonitorTool,
      callLowLevelCodeTool
    });
  }

  return {
    callTool
  };
}
