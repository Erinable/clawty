import { queryCodeIndex } from "./code-index.js";
import { querySemanticGraph } from "./semantic-graph.js";
import { querySyntaxIndex } from "./syntax-index.js";

export function mapSyntaxSeedToSemanticSeed(seed, edgeType = null) {
  const outgoing = Array.isArray(seed?.outgoing_imports)
    ? seed.outgoing_imports.map((item) => ({
        edge_type: "import",
        edge_source: "syntax",
        weight: Number(item?.weight || 1),
        node: {
          path: item?.target_path || null,
          name: item?.target_symbol || item?.target_path || null,
          kind: "import_target",
          line: null,
          column: null,
          lang: null,
          source: "syntax"
        }
      }))
    : [];
  const outgoingCalls = Array.isArray(seed?.outgoing_calls)
    ? seed.outgoing_calls.map((item) => ({
        edge_type: "call",
        edge_source: "syntax",
        weight: Number(item?.weight || 1),
        node: {
          path: item?.target_path || null,
          name: item?.target_symbol || null,
          kind: "call_target",
          line: null,
          column: null,
          lang: null,
          source: "syntax"
        }
      }))
    : [];
  const incoming = Array.isArray(seed?.incoming_importers)
    ? seed.incoming_importers.map((item) => ({
        edge_type: "import",
        edge_source: "syntax",
        weight: Number(item?.weight || 1),
        node: {
          path: item?.source_path || null,
          name: item?.source_symbol || item?.source_path || null,
          kind: "importer",
          line: null,
          column: null,
          lang: null,
          source: "syntax"
        }
      }))
    : [];
  const incomingCalls = Array.isArray(seed?.incoming_callers)
    ? seed.incoming_callers.map((item) => ({
        edge_type: "call",
        edge_source: "syntax",
        weight: Number(item?.weight || 1),
        node: {
          path: item?.source_path || null,
          name: item?.source_symbol || null,
          kind: "caller",
          line: null,
          column: null,
          lang: null,
          source: "syntax"
        }
      }))
    : [];

  const includeImport = !edgeType || edgeType === "import";
  const includeCall = !edgeType || edgeType === "call";
  const filteredOutgoing = [
    ...(includeImport ? outgoing : []),
    ...(includeCall ? outgoingCalls : [])
  ];
  const filteredIncoming = [
    ...(includeImport ? incoming : []),
    ...(includeCall ? incomingCalls : [])
  ];

  return {
    path: seed.path,
    name: seed.path,
    kind: "file",
    line: 1,
    column: 1,
    lang: seed.lang || null,
    source: "syntax_fallback",
    outgoing: filteredOutgoing,
    incoming: filteredIncoming
  };
}

export function summarizeFallbackSeedLanguages(seeds) {
  const rows = Array.isArray(seeds) ? seeds : [];
  const counts = new Map();
  for (const seed of rows) {
    const raw = typeof seed?.lang === "string" ? seed.lang.trim().toLowerCase() : "";
    const lang = raw && raw !== "*" ? raw : "unknown";
    counts.set(lang, Number(counts.get(lang) || 0) + 1);
  }
  const total = rows.length;
  return {
    total,
    breakdown: Array.from(counts.entries())
      .map(([lang, count]) => ({
        lang,
        count,
        ratio: total > 0 ? Number((count / total).toFixed(4)) : 0
      }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.lang.localeCompare(b.lang);
      })
  };
}

export async function querySemanticGraphWithFallback(workspaceRoot, args = {}) {
  const semanticResult = await querySemanticGraph(workspaceRoot, args);
  if (semanticResult.ok) {
    return semanticResult;
  }

  if (!/semantic graph is empty/i.test(String(semanticResult.error || ""))) {
    return semanticResult;
  }

  const syntaxResult = await querySyntaxIndex(workspaceRoot, {
    query: args?.query,
    top_k: args?.top_k,
    max_neighbors: args?.max_neighbors,
    path_prefix: args?.path_prefix
  });
  if (syntaxResult.ok && Array.isArray(syntaxResult.seeds) && syntaxResult.seeds.length > 0) {
    const fallbackSeeds = syntaxResult.seeds.map((seed) =>
      mapSyntaxSeedToSemanticSeed(seed, args?.edge_type || null)
    );
    return {
      ok: true,
      provider: "syntax",
      fallback: true,
      warning: "semantic graph is empty, returned syntax-index fallback results",
      query: syntaxResult.query,
      filters: {
        edge_type: args?.edge_type || null,
        path_prefix: args?.path_prefix || null,
        max_hops: Number.isFinite(Number(args?.max_hops))
          ? Math.max(1, Math.floor(Number(args.max_hops)))
          : 1,
        per_hop_limit: Number.isFinite(Number(args?.per_hop_limit))
          ? Math.max(1, Math.floor(Number(args.per_hop_limit)))
          : null
      },
      priority_policy: ["syntax", "index_fallback"],
      total_seeds: fallbackSeeds.length,
      scanned_candidates: Number(syntaxResult.scanned_candidates || fallbackSeeds.length),
      deduped_candidates: fallbackSeeds.length,
      language_distribution: {
        scanned_candidates: null,
        deduped_candidates: summarizeFallbackSeedLanguages(fallbackSeeds),
        returned_seeds: summarizeFallbackSeedLanguages(fallbackSeeds)
      },
      seeds: fallbackSeeds
    };
  }

  const indexResult = await queryCodeIndex(workspaceRoot, {
    query: args?.query,
    top_k: args?.top_k
  });
  if (!indexResult.ok) {
    return semanticResult;
  }

  const fallbackSeeds = (indexResult.results || []).map((item) => ({
    path: item.path,
    name: item.path,
    kind: "file",
    line: Number(item.hit_line || 1),
    column: 1,
    lang: null,
    source: "index_fallback",
    outgoing: [],
    incoming: []
  }));

  return {
    ok: true,
    provider: "index",
    fallback: true,
    warning: "semantic graph is empty, returned index-based fallback results",
    query: indexResult.query,
    filters: {
      edge_type: args?.edge_type || null,
      path_prefix: args?.path_prefix || null,
      max_hops: Number.isFinite(Number(args?.max_hops))
        ? Math.max(1, Math.floor(Number(args.max_hops)))
        : 1,
      per_hop_limit: Number.isFinite(Number(args?.per_hop_limit))
        ? Math.max(1, Math.floor(Number(args.per_hop_limit)))
        : null
    },
    priority_policy: ["index_fallback"],
    total_seeds: fallbackSeeds.length,
    scanned_candidates: Number(indexResult.total_hits || fallbackSeeds.length),
    deduped_candidates: fallbackSeeds.length,
    language_distribution: {
      scanned_candidates: null,
      deduped_candidates: summarizeFallbackSeedLanguages(fallbackSeeds),
      returned_seeds: summarizeFallbackSeedLanguages(fallbackSeeds)
    },
    seeds: fallbackSeeds
  };
}
