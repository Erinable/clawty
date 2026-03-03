import {
  attachIndexRetrievalProtocol,
  attachSemanticRetrievalProtocol,
  attachSyntaxRetrievalProtocol
} from "./retrieval-adapters.js";

export function createQueryToolHandlers(deps = {}) {
  const {
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
    metricsSubdir,
    hybridQueryMetricsFile
  } = deps;

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
    const result = await queryCodeIndex(context.workspaceRoot, args);
    return attachIndexRetrievalProtocol(result);
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
    const result = await querySemanticGraphWithFallback(context.workspaceRoot, args);
    return attachSemanticRetrievalProtocol(result);
  }

  async function queryHybridIndexTool(args, context) {
    return runHybridQueryPipeline({
      args,
      context,
      resolveSafePath,
      metricsSubdir: metricsSubdir,
      metricsFileName: hybridQueryMetricsFile
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
    const result = await querySyntaxIndex(context.workspaceRoot, args);
    return attachSyntaxRetrievalProtocol(result);
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

  return {
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
}
