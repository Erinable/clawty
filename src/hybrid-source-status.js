function countCandidates(items) {
  return Array.isArray(items) ? items.length : 0;
}

export function buildHybridMetricSources({
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  vectorEnabled,
  embeddingSource,
  freshnessSource
}) {
  return {
    semantic_ok: Boolean(semanticResult?.ok),
    syntax_ok: Boolean(syntaxResult?.ok),
    index_ok: Boolean(indexResult?.ok),
    vector: {
      enabled: vectorEnabled,
      ok: Boolean(vectorResult?.ok),
      candidates: countCandidates(vectorResult?.results)
    },
    embedding: {
      enabled: Boolean(embeddingSource?.enabled),
      attempted: Boolean(embeddingSource?.attempted),
      ok: Boolean(embeddingSource?.ok),
      status_code: embeddingSource?.status_code || null,
      error_code: embeddingSource?.error_code || null,
      retryable: Boolean(embeddingSource?.retryable),
      reranked_candidates: Number(embeddingSource?.reranked_candidates || 0),
      timeout_ms: Number(embeddingSource?.timeout_ms || 0),
      latency_ms: Number(embeddingSource?.latency_ms || 0)
    },
    freshness: {
      enabled: Boolean(freshnessSource?.enabled),
      attempted: Boolean(freshnessSource?.attempted),
      ok: Boolean(freshnessSource?.ok),
      status_code: freshnessSource?.status_code || null,
      stale_hit_rate: Number(freshnessSource?.stale_hit_rate || 0),
      stale_vector_candidates: Number(
        freshnessSource?.stale_vector_candidates || 0
      )
    }
  };
}

export function buildHybridResponseSources({
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  vectorEnabled,
  embeddingSource,
  freshnessSource
}) {
  return {
    semantic: {
      ok: Boolean(semanticResult?.ok),
      candidates: countCandidates(semanticResult?.seeds),
      fallback: Boolean(semanticResult?.fallback),
      error: semanticResult?.ok ? null : semanticResult?.error || null
    },
    syntax: {
      ok: Boolean(syntaxResult?.ok),
      candidates: countCandidates(syntaxResult?.seeds),
      error: syntaxResult?.ok ? null : syntaxResult?.error || null
    },
    index: {
      ok: Boolean(indexResult?.ok),
      candidates: countCandidates(indexResult?.results),
      error: indexResult?.ok ? null : indexResult?.error || null
    },
    vector: {
      enabled: vectorEnabled,
      ok: Boolean(vectorResult?.ok),
      candidates: countCandidates(vectorResult?.results),
      skipped: Boolean(vectorResult?.skipped),
      error: vectorResult?.ok ? null : vectorResult?.error || null
    },
    embedding: {
      enabled: Boolean(embeddingSource?.enabled),
      attempted: Boolean(embeddingSource?.attempted),
      ok: Boolean(embeddingSource?.ok),
      model: embeddingSource?.model || null,
      reranked_candidates: Number(embeddingSource?.reranked_candidates || 0),
      timeout_ms: Number(embeddingSource?.timeout_ms || 0),
      latency_ms: Number(embeddingSource?.latency_ms || 0),
      status_code: embeddingSource?.status_code || null,
      error_code: embeddingSource?.error_code || null,
      retryable: Boolean(embeddingSource?.retryable),
      rank_shift_count: Number(embeddingSource?.rank_shift_count || 0),
      top1_changed: Boolean(embeddingSource?.top1_changed),
      score_delta_mean: Number(embeddingSource?.score_delta_mean || 0),
      error: embeddingSource?.error || null
    },
    freshness: {
      enabled: Boolean(freshnessSource?.enabled),
      attempted: Boolean(freshnessSource?.attempted),
      ok: Boolean(freshnessSource?.ok),
      stale_after_ms: Number(freshnessSource?.stale_after_ms || 0),
      weight: Number(freshnessSource?.weight || 0),
      vector_stale_penalty: Number(freshnessSource?.vector_stale_penalty || 0),
      sampled_paths: Number(freshnessSource?.sampled_paths || 0),
      sampled_paths_limit: Number(freshnessSource?.sampled_paths_limit || 0),
      sampled_paths_with_stat: Number(freshnessSource?.sampled_paths_with_stat || 0),
      missing_paths: Number(freshnessSource?.missing_paths || 0),
      candidates_with_freshness: Number(freshnessSource?.candidates_with_freshness || 0),
      stale_candidates: Number(freshnessSource?.stale_candidates || 0),
      stale_vector_candidates: Number(freshnessSource?.stale_vector_candidates || 0),
      stale_hit_rate: Number(freshnessSource?.stale_hit_rate || 0),
      status_code: freshnessSource?.status_code || null,
      error: freshnessSource?.error || null
    }
  };
}
