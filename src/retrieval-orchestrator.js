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
