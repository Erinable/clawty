import { queryCodeIndex } from "./code-index.js";
import { querySemanticGraph } from "./semantic-graph.js";
import { querySyntaxIndex } from "./syntax-index.js";
import { queryVectorIndex } from "./vector-index.js";

function classifyVectorQueryFailure(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (/embedding api key is missing/i.test(message) || /EMBEDDING_API_KEY_MISSING/i.test(code)) {
    return "EMBEDDING_API_KEY_MISSING";
  }
  return "VECTOR_QUERY_FAILED";
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
  const vectorQueryPromise = vectorEnabled
    ? queryVectorIndex(
        workspaceRoot,
        {
          query,
          top_k: Math.min(100, Math.max(scanTopK, topK * 4)),
          max_candidates: effectiveArgs?.vector_max_candidates,
          path_prefix: effectiveArgs?.path_prefix,
          language: effectiveArgs?.language,
          layers: effectiveArgs?.vector_layers,
          model: effectiveArgs?.embedding_model
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
    querySemanticGraph(workspaceRoot, {
      query,
      top_k: Math.min(30, scanTopK),
      max_neighbors: effectiveArgs?.max_neighbors,
      max_hops: effectiveArgs?.max_hops,
      per_hop_limit: effectiveArgs?.per_hop_limit,
      edge_type: effectiveArgs?.edge_type,
      path_prefix: effectiveArgs?.path_prefix
    }),
    querySyntaxIndex(workspaceRoot, {
      query,
      top_k: Math.min(30, scanTopK),
      max_neighbors: effectiveArgs?.max_neighbors,
      path_prefix: effectiveArgs?.path_prefix
    }),
    queryCodeIndex(workspaceRoot, {
      query,
      top_k: Math.min(50, Math.max(scanTopK, 20)),
      path_prefix: effectiveArgs?.path_prefix,
      language: effectiveArgs?.language
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

export function collectAndRankHybridCandidates({
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  edgeType,
  query,
  pathPrefix,
  explain,
  mapSyntaxSeedToSemanticSeed,
  mapIndexResultToHybridSeed,
  mapVectorResultToHybridSeed,
  addHybridCandidate,
  rankHybridCandidates
}) {
  const scannedCandidates = [];
  const deduped = new Map();

  if (semanticResult?.ok && Array.isArray(semanticResult.seeds)) {
    for (const seed of semanticResult.seeds) {
      scannedCandidates.push(seed);
      addHybridCandidate(deduped, seed, "semantic");
    }
  }

  if (syntaxResult?.ok && Array.isArray(syntaxResult.seeds)) {
    for (const seed of syntaxResult.seeds) {
      const mapped = mapSyntaxSeedToSemanticSeed(seed, edgeType || null);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "syntax");
    }
  }

  if (indexResult?.ok && Array.isArray(indexResult.results)) {
    for (const item of indexResult.results) {
      const mapped = mapIndexResultToHybridSeed(item);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "index");
    }
  }

  if (vectorResult?.ok && Array.isArray(vectorResult.results)) {
    for (const item of vectorResult.results) {
      const mapped = mapVectorResultToHybridSeed(item);
      scannedCandidates.push(mapped);
      addHybridCandidate(deduped, mapped, "vector");
    }
  }

  const ranked = rankHybridCandidates(Array.from(deduped.values()), {
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
