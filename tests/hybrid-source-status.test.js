import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHybridMetricSources,
  buildHybridResponseSources
} from "../src/hybrid-source-status.js";

test("buildHybridMetricSources maps source health fields", () => {
  const sources = buildHybridMetricSources({
    semanticResult: { ok: true },
    syntaxResult: { ok: false },
    indexResult: { ok: true },
    vectorResult: { ok: true, results: [{ path: "a" }, { path: "b" }] },
    vectorEnabled: true,
    embeddingSource: {
      enabled: true,
      attempted: true,
      ok: false,
      status_code: "EMBEDDING_TIMEOUT",
      error_code: "EMBEDDING_TIMEOUT",
      retryable: true,
      reranked_candidates: 3,
      timeout_ms: 1000,
      latency_ms: 1200
    },
    freshnessSource: {
      enabled: true,
      attempted: true,
      ok: true,
      status_code: "FRESHNESS_OK",
      stale_hit_rate: 0.2,
      stale_vector_candidates: 4
    }
  });

  assert.equal(sources.semantic_ok, true);
  assert.equal(sources.syntax_ok, false);
  assert.equal(sources.vector.candidates, 2);
  assert.equal(sources.embedding.ok, false);
  assert.equal(sources.embedding.retryable, true);
  assert.equal(sources.freshness.stale_vector_candidates, 4);
});

test("buildHybridResponseSources maps source response payload", () => {
  const sources = buildHybridResponseSources({
    semanticResult: { ok: false, error: "semantic down", fallback: true },
    syntaxResult: { ok: true, seeds: [{}, {}] },
    indexResult: { ok: true, results: [{}] },
    vectorResult: { ok: false, skipped: true, error: "disabled" },
    vectorEnabled: false,
    embeddingSource: {
      enabled: true,
      attempted: true,
      ok: true,
      model: "mock-embed",
      reranked_candidates: 2,
      timeout_ms: 15000,
      latency_ms: 300,
      status_code: "EMBEDDING_OK",
      rank_shift_count: 1,
      top1_changed: true,
      score_delta_mean: 0.1
    },
    freshnessSource: {
      enabled: true,
      attempted: true,
      ok: false,
      stale_after_ms: 300000,
      weight: 0.12,
      vector_stale_penalty: 0.6,
      sampled_paths: 2,
      sampled_paths_limit: 200,
      sampled_paths_with_stat: 1,
      missing_paths: 1,
      candidates_with_freshness: 1,
      stale_candidates: 1,
      stale_vector_candidates: 1,
      stale_hit_rate: 1,
      status_code: "FRESHNESS_STAT_FAILED",
      error: "stat failed"
    }
  });

  assert.equal(sources.semantic.ok, false);
  assert.equal(sources.semantic.fallback, true);
  assert.match(sources.semantic.error, /semantic down/);
  assert.equal(sources.syntax.candidates, 2);
  assert.equal(sources.vector.enabled, false);
  assert.equal(sources.vector.skipped, true);
  assert.equal(sources.embedding.model, "mock-embed");
  assert.equal(sources.embedding.top1_changed, true);
  assert.equal(sources.freshness.ok, false);
  assert.equal(sources.freshness.stale_candidates, 1);
  assert.match(sources.freshness.error, /stat failed/);
});
