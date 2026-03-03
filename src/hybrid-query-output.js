import fs from "node:fs/promises";
import path from "node:path";
import {
  buildHybridMetricSources,
  buildHybridResponseSources
} from "./hybrid-source-status.js";

function buildQueryPreview(query, maxChars) {
  const source = typeof query === "string" ? query.trim() : "";
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function roundHybridMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(3));
}

export function buildHybridDegradationSummary(embeddingSource, freshnessSource) {
  const attemptedSources = [];
  const failedSources = [];
  if (embeddingSource?.attempted) {
    attemptedSources.push("embedding");
    if (!embeddingSource?.ok) {
      failedSources.push("embedding");
    }
  }
  if (freshnessSource?.attempted) {
    attemptedSources.push("freshness");
    if (!freshnessSource?.ok) {
      failedSources.push("freshness");
    }
  }
  const degraded = failedSources.length > 0;
  return {
    attempted_sources: attemptedSources,
    failed_sources: failedSources,
    degraded,
    degrade_rate_sample: degraded ? 1 : 0
  };
}

export function buildHybridMetricEvent({
  query,
  queryTotalMs,
  topK,
  scannedCandidates,
  dedupedCandidates,
  seeds,
  effectiveArgs,
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  vectorEnabled,
  embeddingSource,
  freshnessSource,
  degradation,
  tunerDecision,
  tunerOutcome,
  queryPreviewChars
}) {
  return {
    timestamp: new Date().toISOString(),
    event_type: "hybrid_query",
    query_preview: buildQueryPreview(query, queryPreviewChars),
    query_chars: query.length,
    query_total_ms: queryTotalMs,
    top_k: topK,
    scanned_candidates: scannedCandidates.length,
    deduped_candidates: dedupedCandidates.size,
    total_seeds: seeds.length,
    filters: {
      path_prefix: effectiveArgs?.path_prefix || null,
      language: effectiveArgs?.language || null
    },
    sources: buildHybridMetricSources({
      semanticResult,
      syntaxResult,
      indexResult,
      vectorResult,
      vectorEnabled,
      embeddingSource,
      freshnessSource
    }),
    degradation,
    tuner: {
      enabled: Boolean(tunerDecision?.enabled),
      mode: tunerDecision?.mode || "off",
      decision_id: tunerDecision?.decision_id || null,
      arm_id: tunerDecision?.arm_id || null,
      explicit_override: Boolean(tunerDecision?.explicit_override),
      params_applied: tunerDecision?.applied_params || {},
      selection_strategy: tunerDecision?.selection?.strategy || null,
      reward: Number(tunerOutcome?.reward || 0),
      success: Boolean(tunerOutcome?.success),
      outcome_recorded: Boolean(tunerOutcome?.recorded)
    }
  };
}

export async function appendHybridQueryMetricEvent({
  workspaceRoot,
  event,
  metricsConfig,
  resolveSafePath,
  metricsSubdir,
  metricsFileName
}) {
  if (!metricsConfig.enabled || !metricsConfig.persist_hybrid) {
    return {
      logged: false,
      reason: "metrics_disabled"
    };
  }

  try {
    const metricsDir = resolveSafePath(workspaceRoot, metricsSubdir);
    await fs.mkdir(metricsDir, { recursive: true });
    const outputPath = path.join(metricsDir, metricsFileName);
    await fs.appendFile(outputPath, `${JSON.stringify(event)}\n`, "utf8");
    return {
      logged: true,
      reason: null
    };
  } catch (error) {
    return {
      logged: false,
      reason: "metrics_write_failed",
      error: error.message || String(error)
    };
  }
}

export function buildHybridQueryResponse({
  query,
  queryTotalMs,
  effectiveArgs,
  semanticResult,
  syntaxResult,
  indexResult,
  vectorResult,
  vectorEnabled,
  embeddingSource,
  freshnessSource,
  degradation,
  metricsWrite,
  tunerDecision,
  tunerOutcome,
  priorityPolicy,
  scannedCandidates,
  dedupedCandidates,
  languageDistribution,
  seeds
}) {
  return {
    ok: true,
    provider: "hybrid",
    protocol: {
      version: "hybrid_result.v1",
      candidate_fields: [
        "source",
        "confidence",
        "timeliness",
        "freshness",
        "dedup_key",
        "supporting_sources"
      ]
    },
    query,
    query_total_ms: queryTotalMs,
    filters: {
      edge_type: effectiveArgs?.edge_type || null,
      path_prefix: effectiveArgs?.path_prefix || null,
      language: effectiveArgs?.language || null,
      max_hops: Number.isFinite(Number(effectiveArgs?.max_hops))
        ? Math.max(1, Math.floor(Number(effectiveArgs.max_hops)))
        : 1,
      per_hop_limit: Number.isFinite(Number(effectiveArgs?.per_hop_limit))
        ? Math.max(1, Math.floor(Number(effectiveArgs.per_hop_limit)))
        : null,
      explain: Boolean(effectiveArgs?.explain),
      embedding: {
        enabled: Boolean(embeddingSource.enabled),
        attempted: Boolean(embeddingSource.attempted),
        model: embeddingSource.model,
        top_k: Number(embeddingSource.top_k || 0),
        weight: Number(embeddingSource.weight || 0),
        timeout_ms: Number(embeddingSource.timeout_ms || 0),
        status_code: embeddingSource.status_code || null
      },
      freshness: {
        enabled: Boolean(freshnessSource.enabled),
        attempted: Boolean(freshnessSource.attempted),
        stale_after_ms: Number(freshnessSource.stale_after_ms || 0),
        weight: Number(freshnessSource.weight || 0),
        vector_stale_penalty: Number(freshnessSource.vector_stale_penalty || 0),
        status_code: freshnessSource.status_code || null
      }
    },
    sources: buildHybridResponseSources({
      semanticResult,
      syntaxResult,
      indexResult,
      vectorResult,
      vectorEnabled,
      embeddingSource,
      freshnessSource
    }),
    degradation,
    observability: {
      metrics_logged: Boolean(metricsWrite.logged),
      metrics_reason: metricsWrite.reason || null,
      metrics_error: metricsWrite.error || null,
      online_tuner: {
        enabled: Boolean(tunerDecision?.enabled),
        mode: tunerDecision?.mode || "off",
        decision_id: tunerDecision?.decision_id || null,
        arm_id: tunerDecision?.arm_id || null,
        explicit_override: Boolean(tunerDecision?.explicit_override),
        params_applied: tunerDecision?.applied_params || {},
        selection_strategy: tunerDecision?.selection?.strategy || null,
        selection_candidates: Array.isArray(tunerDecision?.selection?.candidates)
          ? tunerDecision.selection.candidates.length
          : 0,
        selection_blocked: Array.isArray(tunerDecision?.selection?.blocked)
          ? tunerDecision.selection.blocked.length
          : 0,
        reward: Number(tunerOutcome?.reward || 0),
        success: Boolean(tunerOutcome?.success),
        outcome_recorded: Boolean(tunerOutcome?.recorded),
        outcome_reason: tunerOutcome?.reason || null,
        outcome_error: tunerOutcome?.error || null
      }
    },
    priority_policy: priorityPolicy,
    total_seeds: seeds.length,
    scanned_candidates: scannedCandidates.length,
    deduped_candidates: dedupedCandidates.size,
    language_distribution: languageDistribution,
    seeds
  };
}
