export async function callCodeContextFacadeWithDeps(args, deps = {}) {
  const {
    isPlainObject,
    toFiniteInteger,
    callSearchCodeFacade,
    callLowLevelCodeTool,
    serverOptions
  } = deps;
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("get_code_context requires non-empty string argument: query");
  }

  const query = args.query.trim();
  const topK = toFiniteInteger(args.top_k, 8, 1, 30);
  const search = await callSearchCodeFacade(
    {
      workspace: args.workspace,
      query,
      top_k: topK,
      path_prefix: args.path_prefix,
      language: args.language,
      strategy: "auto"
    },
    serverOptions
  );

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: args.workspace,
        query,
        top_k: Math.min(topK, 10),
        max_neighbors: 20
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  return {
    ok: search.ok === true,
    query,
    strategy_used: search.strategy_used,
    search_hits: search.results,
    search,
    semantic
  };
}

export async function callExplainCodeFacadeWithDeps(args, deps = {}) {
  const {
    isPlainObject,
    toFiniteInteger,
    callSearchCodeFacade,
    callLowLevelCodeTool,
    serverOptions
  } = deps;
  const safeArgs = isPlainObject(args) ? args : {};
  let targetPath =
    typeof safeArgs.path === "string" && safeArgs.path.trim() ? safeArgs.path.trim() : null;
  let search = null;

  if (!targetPath) {
    if (typeof safeArgs.query !== "string" || !safeArgs.query.trim()) {
      throw new Error("explain_code requires path or query");
    }
    search = await callSearchCodeFacade(
      {
        workspace: safeArgs.workspace,
        query: safeArgs.query.trim(),
        top_k: 1,
        path_prefix: safeArgs.path_prefix,
        language: safeArgs.language,
        strategy: "auto"
      },
      serverOptions
    );
    targetPath = Array.isArray(search.results) ? search.results[0]?.path || null : null;
    if (!targetPath) {
      return {
        ok: false,
        error: "no matching file found for query",
        query: safeArgs.query.trim(),
        search
      };
    }
  }

  const maxChars = toFiniteInteger(safeArgs.max_chars, 2400, 200, 100_000);
  const file = await callLowLevelCodeTool(
    "read_file",
    {
      workspace: safeArgs.workspace,
      path: targetPath,
      max_chars: maxChars
    },
    serverOptions
  );

  const content = typeof file?.content === "string" ? file.content : "";
  return {
    ok: file?.ok === true,
    path: targetPath,
    max_chars: maxChars,
    content,
    content_preview: content.slice(0, Math.min(content.length, 1200)),
    search
  };
}

export async function callTraceCallChainFacadeWithDeps(args, deps = {}) {
  const { isPlainObject, toFiniteInteger, callLowLevelCodeTool, serverOptions } = deps;
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("trace_call_chain requires non-empty string argument: query");
  }

  const query = args.query.trim();
  const topK = toFiniteInteger(args.top_k, 5, 1, 20);
  const maxHops = toFiniteInteger(args.max_hops, 2, 1, 4);
  const pathPrefix = typeof args.path_prefix === "string" ? args.path_prefix : undefined;

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: args.workspace,
        query,
        top_k: topK,
        max_neighbors: 30,
        max_hops: maxHops,
        path_prefix: pathPrefix
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  let syntax = null;
  try {
    syntax = await callLowLevelCodeTool(
      "query_syntax_index",
      {
        workspace: args.workspace,
        query,
        top_k: topK,
        max_neighbors: 30,
        path_prefix: pathPrefix
      },
      serverOptions
    );
  } catch (error) {
    syntax = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  return {
    ok: semantic?.ok === true || syntax?.ok === true,
    query,
    semantic,
    syntax,
    summary: {
      semantic_seed_count: Array.isArray(semantic?.seeds) ? semantic.seeds.length : 0,
      syntax_seed_count: Array.isArray(syntax?.seeds) ? syntax.seeds.length : 0
    }
  };
}

export async function callImpactAnalysisFacadeWithDeps(args, deps = {}) {
  const {
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
  } = deps;
  const safeArgs = isPlainObject(args) ? args : {};
  const maxPaths = toFiniteInteger(safeArgs.max_paths, 60, 1, 200);

  if (hasLocationArgs(safeArgs)) {
    const line = toFiniteInteger(safeArgs.line, 1, 1, 1_000_000);
    const column = toFiniteInteger(safeArgs.column, 1, 1, 1_000_000);
    const baseArgs = {
      workspace: safeArgs.workspace,
      path: safeArgs.path.trim(),
      line,
      column,
      max_results: toFiniteInteger(safeArgs.max_results, 200, 1, 1000),
      include_declaration: safeArgs.include_declaration === true
    };

    const [definition, references] = await Promise.all([
      callGoToDefinitionFacade(baseArgs, serverOptions).catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      })),
      callFindReferencesFacade(baseArgs, serverOptions).catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      }))
    ]);

    const impactedPaths = dedupePaths(
      [...collectReferencePaths(definition), ...collectReferencePaths(references)],
      maxPaths
    );

    return {
      ok: definition?.ok === true || references?.ok === true,
      mode: "location",
      input: {
        path: baseArgs.path,
        line,
        column
      },
      impacted_paths: impactedPaths,
      definition,
      references
    };
  }

  if (typeof safeArgs.query !== "string" || !safeArgs.query.trim()) {
    throw new Error("impact_analysis requires query or location(path+line+column)");
  }

  const query = safeArgs.query.trim();
  const topK = toFiniteInteger(safeArgs.top_k, 10, 1, 30);
  const search = await callSearchCodeFacade(
    {
      workspace: safeArgs.workspace,
      query,
      top_k: topK,
      path_prefix: safeArgs.path_prefix,
      language: safeArgs.language,
      strategy: "auto"
    },
    serverOptions
  );

  let semantic = null;
  try {
    semantic = await callLowLevelCodeTool(
      "query_semantic_graph",
      {
        workspace: safeArgs.workspace,
        query,
        top_k: Math.min(topK, 12),
        max_neighbors: 25,
        max_hops: 2,
        path_prefix: safeArgs.path_prefix
      },
      serverOptions
    );
  } catch (error) {
    semantic = {
      ok: false,
      error: error?.message || String(error)
    };
  }

  const impactedPaths = dedupePaths(
    [...collectPathsFromSearchResult(search), ...collectPathsFromSemanticResult(semantic)],
    maxPaths
  );

  return {
    ok: search?.ok === true || semantic?.ok === true,
    mode: "query",
    query,
    strategy_used: search?.strategy_used || null,
    impacted_paths: impactedPaths,
    search,
    semantic
  };
}
