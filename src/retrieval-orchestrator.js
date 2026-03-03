import { queryCodeIndex } from "./code-index.js";
import { querySemanticGraph } from "./semantic-graph.js";
import { querySyntaxIndex } from "./syntax-index.js";
import { queryVectorIndex } from "./vector-index.js";
import {
  addHybridCandidate,
  mapIndexResultToHybridSeed,
  mapVectorResultToHybridSeed,
  rankHybridCandidates
} from "./hybrid-ranking.js";
import { mapSyntaxSeedToSemanticSeed } from "./semantic-fallback.js";

export function classifyVectorQueryFailure(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (/embedding api key is missing/i.test(message) || /EMBEDDING_API_KEY_MISSING/i.test(code)) {
    return "EMBEDDING_API_KEY_MISSING";
  }
  return "VECTOR_QUERY_FAILED";
}

export async function queryHybridRetrievalSourcesWithDeps(
  {
    workspaceRoot,
    query,
    scanTopK,
    topK,
    effectiveArgs = {},
    vectorEnabled = true,
    embedding = {}
  },
  deps = {}
) {
  const {
    querySemanticGraph: querySemanticGraphFn,
    querySyntaxIndex: querySyntaxIndexFn,
    queryCodeIndex: queryCodeIndexFn,
    queryVectorIndex: queryVectorIndexFn
  } = deps;
  const retrievalArgs = /** @type {Record<string, any>} */ (effectiveArgs || {});

  const vectorQueryPromise = vectorEnabled
    ? queryVectorIndexFn(
        workspaceRoot,
        {
          query,
          top_k: Math.min(100, Math.max(scanTopK, topK * 4)),
          max_candidates: retrievalArgs.vector_max_candidates,
          path_prefix: retrievalArgs.path_prefix,
          language: retrievalArgs.language,
          layers: retrievalArgs.vector_layers,
          model: retrievalArgs.embedding_model
        },
        {
          embedding
        }
      ).catch((error) => ({
        ok: false,
        skipped: false,
        error: error?.message || String(error),
        error_code: classifyVectorQueryFailure(error)
      }))
    : Promise.resolve({
        ok: false,
        skipped: true,
        error: "vector source disabled"
      });

  const [semanticResult, syntaxResult, indexResult, vectorResult] = await Promise.all([
    querySemanticGraphFn(workspaceRoot, {
      query,
      top_k: Math.min(30, scanTopK),
      max_neighbors: retrievalArgs.max_neighbors,
      max_hops: retrievalArgs.max_hops,
      per_hop_limit: retrievalArgs.per_hop_limit,
      edge_type: retrievalArgs.edge_type,
      path_prefix: retrievalArgs.path_prefix
    }),
    querySyntaxIndexFn(workspaceRoot, {
      query,
      top_k: Math.min(30, scanTopK),
      max_neighbors: retrievalArgs.max_neighbors,
      path_prefix: retrievalArgs.path_prefix
    }),
    queryCodeIndexFn(workspaceRoot, {
      query,
      top_k: Math.min(50, Math.max(scanTopK, 20)),
      path_prefix: retrievalArgs.path_prefix,
      language: retrievalArgs.language
    }),
    vectorQueryPromise
  ]);

  return {
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult
  };
}

export async function queryHybridRetrievalSources({
  workspaceRoot,
  query,
  scanTopK,
  topK,
  effectiveArgs = {},
  vectorEnabled = true,
  embedding = {}
}) {
  return queryHybridRetrievalSourcesWithDeps(
    {
      workspaceRoot,
      query,
      scanTopK,
      topK,
      effectiveArgs,
      vectorEnabled,
      embedding
    },
    {
      querySemanticGraph,
      querySyntaxIndex,
      queryCodeIndex,
      queryVectorIndex
    }
  );
}

export function collectAndRankHybridCandidatesWithDeps(
  {
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult,
    edgeType,
    query,
    pathPrefix,
    explain
  },
  deps = {}
) {
  const {
    mapSyntaxSeedToSemanticSeed: mapSyntaxSeedToSemanticSeedFn,
    mapIndexResultToHybridSeed: mapIndexResultToHybridSeedFn,
    mapVectorResultToHybridSeed: mapVectorResultToHybridSeedFn,
    addHybridCandidate: addHybridCandidateFn,
    rankHybridCandidates: rankHybridCandidatesFn
  } = deps;

  const scannedCandidates = [];
  const deduped = new Map();

  if (semanticResult?.ok && Array.isArray(semanticResult.seeds)) {
    for (const seed of semanticResult.seeds) {
      scannedCandidates.push(seed);
      addHybridCandidateFn(deduped, seed, "semantic");
    }
  }

  if (syntaxResult?.ok && Array.isArray(syntaxResult.seeds)) {
    for (const seed of syntaxResult.seeds) {
      const mapped = mapSyntaxSeedToSemanticSeedFn(seed, edgeType || null);
      scannedCandidates.push(mapped);
      addHybridCandidateFn(deduped, mapped, "syntax");
    }
  }

  if (indexResult?.ok && Array.isArray(indexResult.results)) {
    for (const item of indexResult.results) {
      const mapped = mapIndexResultToHybridSeedFn(item);
      scannedCandidates.push(mapped);
      addHybridCandidateFn(deduped, mapped, "index");
    }
  }

  if (vectorResult?.ok && Array.isArray(vectorResult.results)) {
    for (const item of vectorResult.results) {
      const mapped = mapVectorResultToHybridSeedFn(item);
      scannedCandidates.push(mapped);
      addHybridCandidateFn(deduped, mapped, "vector");
    }
  }

  const ranked = rankHybridCandidatesFn(Array.from(deduped.values()), {
    query,
    path_prefix: pathPrefix,
    explain
  });

  return {
    scannedCandidates,
    deduped,
    ranked
  };
}

export function collectAndRankHybridCandidates({
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  edgeType,
  query,
  pathPrefix,
  explain
}) {
  return collectAndRankHybridCandidatesWithDeps(
    {
      semanticResult,
      syntaxResult,
      indexResult,
      vectorResult,
      edgeType,
      query,
      pathPrefix,
      explain
    },
    {
      mapSyntaxSeedToSemanticSeed,
      mapIndexResultToHybridSeed,
      mapVectorResultToHybridSeed,
      addHybridCandidate,
      rankHybridCandidates
    }
  );
}
