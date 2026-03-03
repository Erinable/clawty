function normalizeSearchStrategy(value) {
  if (typeof value !== "string") {
    return "auto";
  }
  const normalized = value.trim().toLowerCase();
  if (["auto", "hybrid", "keyword", "vector"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function looksLikeSymbolQuery(query) {
  if (typeof query !== "string") {
    return false;
  }
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z_$][\w.$:/-]*$/.test(trimmed);
}

function pickAutoSearchStrategy(query) {
  if (looksLikeSymbolQuery(query)) {
    return "keyword";
  }
  return "hybrid";
}

function countResultItems(payload, isPlainObject) {
  if (!isPlainObject(payload)) {
    return 0;
  }
  if (Array.isArray(payload.results)) {
    return payload.results.length;
  }
  if (Array.isArray(payload.locations)) {
    return payload.locations.length;
  }
  return 0;
}

async function runSearchStrategyWithDeps(strategy, args, deps = {}) {
  const { callLowLevelCodeTool } = deps;
  if (strategy === "keyword") {
    return callLowLevelCodeTool(
      "query_code_index",
      {
        ...args,
        explain: true
      },
      deps.serverOptions
    );
  }
  if (strategy === "vector") {
    return callLowLevelCodeTool("query_vector_index", args, deps.serverOptions);
  }
  return callLowLevelCodeTool(
    "query_hybrid_index",
    {
      ...args,
      explain: true
    },
    deps.serverOptions
  );
}

function buildSearchPlan(strategy, query) {
  const requested = normalizeSearchStrategy(strategy);
  if (requested === "auto") {
    const selected = pickAutoSearchStrategy(query);
    if (selected === "keyword") {
      return ["keyword", "hybrid"];
    }
    return ["hybrid", "keyword"];
  }
  if (requested === "keyword") {
    return ["keyword", "hybrid"];
  }
  if (requested === "vector") {
    return ["vector", "hybrid", "keyword"];
  }
  return ["hybrid", "keyword"];
}

export async function callSearchCodeFacadeWithDeps(args, deps = {}) {
  const { isPlainObject, toFiniteInteger, callLowLevelCodeTool, serverOptions } = deps;
  if (!isPlainObject(args) || typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("search_code requires non-empty string argument: query");
  }

  const searchArgs = {
    workspace: args.workspace,
    query: args.query.trim(),
    top_k: toFiniteInteger(args.top_k, 10, 1, 50),
    path_prefix: typeof args.path_prefix === "string" ? args.path_prefix : undefined,
    language: typeof args.language === "string" ? args.language : undefined
  };
  const plannedStrategies = buildSearchPlan(args.strategy, searchArgs.query);
  const attempted = [];
  let selected = null;

  for (const strategy of plannedStrategies) {
    const attempt = {
      strategy,
      ok: false,
      result_count: 0
    };
    try {
      const payload = await runSearchStrategyWithDeps(strategy, searchArgs, {
        callLowLevelCodeTool,
        serverOptions
      });
      attempt.ok = payload?.ok === true;
      attempt.result_count = countResultItems(payload, isPlainObject);
      if (attempt.ok && selected === null) {
        selected = {
          strategy,
          payload
        };
      }
      if (attempt.ok && attempt.result_count > 0) {
        selected = {
          strategy,
          payload
        };
        attempted.push(attempt);
        break;
      }
    } catch (error) {
      attempt.error = error?.message || String(error);
    }
    attempted.push(attempt);
  }

  if (!selected) {
    return {
      ok: false,
      query: searchArgs.query,
      strategy_requested: normalizeSearchStrategy(args.strategy),
      strategy_used: null,
      attempted_strategies: attempted,
      error: "no strategy produced a successful result"
    };
  }

  const payload = selected.payload;
  return {
    ok: payload?.ok === true,
    query: searchArgs.query,
    strategy_requested: normalizeSearchStrategy(args.strategy),
    strategy_used: selected.strategy,
    attempted_strategies: attempted,
    provider: payload?.provider || null,
    fallback: payload?.fallback === true,
    results: Array.isArray(payload?.results) ? payload.results : [],
    raw: payload
  };
}
