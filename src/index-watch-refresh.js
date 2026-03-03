export async function refreshCodeIndexInBatchesWithDeps(
  workspaceRoot,
  changedPaths,
  deletedPaths,
  maxBatchSize,
  deps = {}
) {
  const { chunkArray, refreshCodeIndex } = deps;
  const changedChunks = chunkArray(changedPaths, maxBatchSize);
  const deletedChunks = chunkArray(deletedPaths, maxBatchSize);
  const chunkCount = Math.max(changedChunks.length, deletedChunks.length, 1);
  const details = [];

  for (let idx = 0; idx < chunkCount; idx += 1) {
    const changedBatch = changedChunks[idx] || [];
    const deletedBatch = deletedChunks[idx] || [];
    if (changedBatch.length === 0 && deletedBatch.length === 0) {
      continue;
    }
    const refreshed = await refreshCodeIndex(workspaceRoot, {
      changed_paths: changedBatch,
      deleted_paths: deletedBatch
    });
    details.push(refreshed);
    if (!refreshed?.ok) {
      return {
        ok: false,
        details
      };
    }
  }

  return {
    ok: true,
    details
  };
}

export async function ensureIndexesWithDeps(workspaceRoot, config, deps = {}) {
  const { buildCodeIndex, buildSyntaxIndex, buildSemanticGraph, buildVectorIndex } = deps;
  const codeIndex = await buildCodeIndex(workspaceRoot, {});
  if (!codeIndex?.ok) {
    return {
      ok: false,
      stage: "build_code_index",
      result: codeIndex
    };
  }

  let syntaxIndex = null;
  if (config.include_syntax) {
    syntaxIndex = await buildSyntaxIndex(workspaceRoot, {
      parser_provider: "auto"
    });
    if (!syntaxIndex?.ok) {
      return {
        ok: false,
        stage: "build_syntax_index",
        result: syntaxIndex
      };
    }
  }

  let semanticGraph = null;
  if (config.include_semantic) {
    semanticGraph = await buildSemanticGraph(
      workspaceRoot,
      {
        include_syntax: config.include_syntax,
        include_definitions: config.semantic_include_definitions,
        include_references: config.semantic_include_references
      },
      { enabled: false }
    );
    if (!semanticGraph?.ok) {
      return {
        ok: false,
        stage: "build_semantic_graph",
        result: semanticGraph
      };
    }
  }

  let vectorIndex = null;
  if (config.include_vector) {
    vectorIndex = await buildVectorIndex(
      workspaceRoot,
      {
        layer: "base"
      },
      {
        embedding: config.embedding || {}
      }
    );
    if (!vectorIndex?.ok) {
      return {
        ok: false,
        stage: "build_vector_index",
        result: vectorIndex
      };
    }
  }

  return {
    ok: true,
    code_index: codeIndex,
    syntax_index: syntaxIndex,
    semantic_graph: semanticGraph,
    vector_index: vectorIndex
  };
}

export async function refreshIndexesForChangesWithDeps(workspaceRoot, args = {}, deps = {}) {
  const {
    resolveWatchConfig,
    parseString,
    refreshCodeIndexInBatches,
    refreshSyntaxIndex,
    refreshSemanticGraph,
    refreshVectorIndex
  } = deps;
  const config = resolveWatchConfig(args);
  const changedPaths = Array.isArray(args.changed_paths)
    ? args.changed_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const deletedPaths = Array.isArray(args.deleted_paths)
    ? args.deleted_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];

  if (changedPaths.length === 0 && deletedPaths.length === 0) {
    return {
      ok: true,
      skipped: true,
      changed_paths: [],
      deleted_paths: []
    };
  }

  const codeRefresh = await refreshCodeIndexInBatches(
    workspaceRoot,
    changedPaths,
    deletedPaths,
    config.max_batch_size
  );
  if (!codeRefresh.ok) {
    const failed = codeRefresh.details[codeRefresh.details.length - 1] || null;
    return {
      ok: false,
      stage: "refresh_code_index",
      changed_paths: changedPaths,
      deleted_paths: deletedPaths,
      error: failed?.error || "refresh_code_index failed",
      code_index: codeRefresh
    };
  }

  let syntaxRefresh = null;
  if (config.include_syntax) {
    syntaxRefresh = await refreshSyntaxIndex(workspaceRoot, {
      changed_paths: changedPaths,
      deleted_paths: deletedPaths,
      parser_provider: "auto"
    });
    if (!syntaxRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_syntax_index",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: syntaxRefresh?.error || "refresh_syntax_index failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh
      };
    }
  }

  let semanticRefresh = null;
  if (config.include_semantic) {
    semanticRefresh = await refreshSemanticGraph(
      workspaceRoot,
      {
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        include_syntax: config.include_syntax,
        include_definitions: config.semantic_include_definitions,
        include_references: config.semantic_include_references,
        precise_preferred: false
      },
      { enabled: false }
    );
    if (!semanticRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_semantic_graph",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: semanticRefresh?.error || "refresh_semantic_graph failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        semantic_graph: semanticRefresh
      };
    }
  }

  let vectorRefresh = null;
  if (config.include_vector) {
    vectorRefresh = await refreshVectorIndex(
      workspaceRoot,
      {
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        layer: parseString(config.vector_layer, "delta")
      },
      {
        embedding: config.embedding || {}
      }
    );
    if (!vectorRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_vector_index",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: vectorRefresh?.error || "refresh_vector_index failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        semantic_graph: semanticRefresh,
        vector_index: vectorRefresh
      };
    }
  }

  return {
    ok: true,
    skipped: false,
    changed_paths: changedPaths,
    deleted_paths: deletedPaths,
    code_index: codeRefresh,
    syntax_index: syntaxRefresh,
    semantic_graph: semanticRefresh,
    vector_index: vectorRefresh
  };
}
