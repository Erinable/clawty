function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function isRetryableDbError(input) {
  const text = String(input || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("sqlite_busy") ||
    text.includes("sqlite_locked") ||
    text.includes("database is locked") ||
    text.includes("database table is locked") ||
    text.includes("database schema is locked")
  );
}

function resolveRetryOptions(config = {}) {
  const budget = Number.isFinite(Number(config.db_retry_budget))
    ? Math.max(0, Math.floor(Number(config.db_retry_budget)))
    : 0;
  const backoffMs = Number.isFinite(Number(config.db_retry_backoff_ms))
    ? Math.max(10, Math.floor(Number(config.db_retry_backoff_ms)))
    : 120;
  const backoffMaxMs = Number.isFinite(Number(config.db_retry_backoff_max_ms))
    ? Math.max(backoffMs, Math.floor(Number(config.db_retry_backoff_max_ms)))
    : Math.max(backoffMs, 1200);
  return {
    budget,
    backoff_ms: backoffMs,
    backoff_max_ms: backoffMaxMs
  };
}

function nextRetryBackoffMs(options, attemptIndex) {
  const base = Number(options?.backoff_ms || 120);
  const cap = Number(options?.backoff_max_ms || base);
  const factor = 2 ** Math.max(0, attemptIndex);
  return Math.min(cap, base * factor);
}

async function runWithDbRetry(stage, action, options = {}) {
  const retry = resolveRetryOptions(options);
  let retryCount = 0;
  let exhausted = false;
  while (true) {
    try {
      const result = await action();
      if (result?.ok !== false) {
        return {
          result,
          db_retry: {
            attempts: retryCount,
            exhausted: false,
            stages: retryCount > 0 ? [stage] : []
          }
        };
      }
      if (!isRetryableDbError(result?.error) || retryCount >= retry.budget) {
        exhausted = isRetryableDbError(result?.error) && retryCount >= retry.budget;
        return {
          result,
          db_retry: {
            attempts: retryCount,
            exhausted,
            stages: retryCount > 0 || exhausted ? [stage] : []
          }
        };
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (!isRetryableDbError(message) || retryCount >= retry.budget) {
        exhausted = isRetryableDbError(message) && retryCount >= retry.budget;
        return {
          result: {
            ok: false,
            error: message
          },
          db_retry: {
            attempts: retryCount,
            exhausted,
            stages: retryCount > 0 || exhausted ? [stage] : []
          }
        };
      }
    }

    retryCount += 1;
    await sleep(nextRetryBackoffMs(retry, retryCount - 1));
  }
}

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
  let retryAttempts = 0;
  let retryExhausted = false;
  const retryStages = new Set();

  for (let idx = 0; idx < chunkCount; idx += 1) {
    const changedBatch = changedChunks[idx] || [];
    const deletedBatch = deletedChunks[idx] || [];
    if (changedBatch.length === 0 && deletedBatch.length === 0) {
      continue;
    }
    const { result: refreshed, db_retry: retryInfo } = await runWithDbRetry(
      "refresh_code_index",
      () =>
        refreshCodeIndex(workspaceRoot, {
          changed_paths: changedBatch,
          deleted_paths: deletedBatch
        }),
      deps?.retryOptions || {}
    );
    retryAttempts += Number(retryInfo?.attempts || 0);
    if (retryInfo?.exhausted) {
      retryExhausted = true;
    }
    for (const stage of retryInfo?.stages || []) {
      retryStages.add(stage);
    }
    details.push(refreshed);
    if (!refreshed?.ok) {
      return {
        ok: false,
        details,
        db_retry: {
          attempts: retryAttempts,
          exhausted: retryExhausted,
          stages: Array.from(retryStages.values())
        }
      };
    }
  }

  return {
    ok: true,
    details,
    db_retry: {
      attempts: retryAttempts,
      exhausted: retryExhausted,
      stages: Array.from(retryStages.values())
    }
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
  const retryOptions = resolveRetryOptions(config);
  const retryStages = new Set();
  let retryAttempts = 0;
  let retryExhausted = false;
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
    config.max_batch_size,
    retryOptions
  );
  if (codeRefresh?.db_retry) {
    retryAttempts += Number(codeRefresh.db_retry.attempts || 0);
    if (codeRefresh.db_retry.exhausted) {
      retryExhausted = true;
    }
    for (const stage of codeRefresh.db_retry.stages || []) {
      retryStages.add(stage);
    }
  }
  if (!codeRefresh.ok) {
    const failed = codeRefresh.details[codeRefresh.details.length - 1] || null;
    return {
      ok: false,
      stage: "refresh_code_index",
      changed_paths: changedPaths,
      deleted_paths: deletedPaths,
      error: failed?.error || "refresh_code_index failed",
      code_index: codeRefresh,
      db_retry: {
        attempts: retryAttempts,
        exhausted: retryExhausted,
        stages: Array.from(retryStages.values())
      }
    };
  }

  let syntaxRefresh = null;
  if (config.include_syntax) {
    const syntaxResult = await runWithDbRetry(
      "refresh_syntax_index",
      () =>
        refreshSyntaxIndex(workspaceRoot, {
          changed_paths: changedPaths,
          deleted_paths: deletedPaths,
          parser_provider: "auto"
        }),
      retryOptions
    );
    syntaxRefresh = syntaxResult.result;
    retryAttempts += Number(syntaxResult.db_retry?.attempts || 0);
    if (syntaxResult.db_retry?.exhausted) {
      retryExhausted = true;
    }
    for (const stage of syntaxResult.db_retry?.stages || []) {
      retryStages.add(stage);
    }
    if (!syntaxRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_syntax_index",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: syntaxRefresh?.error || "refresh_syntax_index failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        db_retry: {
          attempts: retryAttempts,
          exhausted: retryExhausted,
          stages: Array.from(retryStages.values())
        }
      };
    }
  }

  let semanticRefresh = null;
  if (config.include_semantic) {
    const semanticResult = await runWithDbRetry(
      "refresh_semantic_graph",
      () =>
        refreshSemanticGraph(
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
        ),
      retryOptions
    );
    semanticRefresh = semanticResult.result;
    retryAttempts += Number(semanticResult.db_retry?.attempts || 0);
    if (semanticResult.db_retry?.exhausted) {
      retryExhausted = true;
    }
    for (const stage of semanticResult.db_retry?.stages || []) {
      retryStages.add(stage);
    }
    if (!semanticRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_semantic_graph",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: semanticRefresh?.error || "refresh_semantic_graph failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        semantic_graph: semanticRefresh,
        db_retry: {
          attempts: retryAttempts,
          exhausted: retryExhausted,
          stages: Array.from(retryStages.values())
        }
      };
    }
  }

  let vectorRefresh = null;
  if (config.include_vector) {
    const vectorResult = await runWithDbRetry(
      "refresh_vector_index",
      () =>
        refreshVectorIndex(
          workspaceRoot,
          {
            changed_paths: changedPaths,
            deleted_paths: deletedPaths,
            layer: parseString(config.vector_layer, "delta")
          },
          {
            embedding: config.embedding || {}
          }
        ),
      retryOptions
    );
    vectorRefresh = vectorResult.result;
    retryAttempts += Number(vectorResult.db_retry?.attempts || 0);
    if (vectorResult.db_retry?.exhausted) {
      retryExhausted = true;
    }
    for (const stage of vectorResult.db_retry?.stages || []) {
      retryStages.add(stage);
    }
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
        vector_index: vectorRefresh,
        db_retry: {
          attempts: retryAttempts,
          exhausted: retryExhausted,
          stages: Array.from(retryStages.values())
        }
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
    vector_index: vectorRefresh,
    db_retry: {
      attempts: retryAttempts,
      exhausted: retryExhausted,
      stages: Array.from(retryStages.values())
    }
  };
}
