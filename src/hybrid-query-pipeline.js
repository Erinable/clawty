import { performance } from "node:perf_hooks";
import {
  collectAndRankHybridCandidates,
  queryHybridRetrievalSources
} from "./retrieval-orchestrator.js";
import { attachHybridRetrievalProtocol } from "./hybrid-ranking.js";
import {
  rerankHybridCandidatesWithEmbedding,
  rerankHybridCandidatesWithFreshness
} from "./hybrid-rerank.js";
import {
  appendHybridQueryMetricEvent,
  buildHybridDegradationSummary,
  buildHybridMetricEvent,
  buildHybridQueryResponse,
  roundHybridMs
} from "./hybrid-query-output.js";
import {
  DEFAULT_HYBRID_EMBEDDING_MODEL,
  DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
  DEFAULT_HYBRID_EMBEDDING_TOP_K,
  DEFAULT_HYBRID_EMBEDDING_WEIGHT,
  DEFAULT_HYBRID_FRESHNESS_MAX_PATHS,
  DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
  DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
  DEFAULT_HYBRID_FRESHNESS_WEIGHT,
  parseHybridBoolean,
  resolveHybridEmbeddingConfig,
  resolveHybridFreshnessConfig,
  resolveMetricsConfig
} from "./hybrid-config.js";
import { summarizeFallbackSeedLanguages } from "./semantic-fallback.js";
import { prepareHybridTunerDecision, recordHybridTunerOutcome } from "./online-tuner.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function runHybridQueryPipeline({
  args,
  context,
  resolveSafePath,
  metricsSubdir,
  metricsFileName
}) {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      ok: false,
      error: "query must be a non-empty string"
    };
  }
  const queryStartedAt = performance.now();

  let tunerDecision = {
    enabled: false,
    mode: "off",
    decision_id: null,
    arm_id: null,
    effective_args: isPlainObject(args) ? { ...args } : {},
    applied_params: {},
    explicit_override: false,
    selection: {
      strategy: "disabled",
      candidates: [],
      blocked: []
    }
  };
  try {
    tunerDecision = await prepareHybridTunerDecision(context.workspaceRoot, args, context);
  } catch (error) {
    tunerDecision = {
      ...tunerDecision,
      selection: {
        strategy: "decision_failed",
        candidates: [],
        blocked: []
      },
      error: error.message || String(error)
    };
  }
  const effectiveArgs = isPlainObject(tunerDecision?.effective_args)
    ? tunerDecision.effective_args
    : isPlainObject(args)
      ? { ...args }
      : {};

  const topK = Number.isFinite(Number(effectiveArgs?.top_k))
    ? Math.max(1, Math.min(30, Math.floor(Number(effectiveArgs.top_k))))
    : 5;
  const scanTopK = Math.max(topK * 3, 10);
  const vectorEnabled = parseHybridBoolean(effectiveArgs?.include_vector, true);
  const { semanticResult, syntaxResult, indexResult, vectorResult } =
    await queryHybridRetrievalSources({
      workspaceRoot: context.workspaceRoot,
      query,
      scanTopK,
      topK,
      effectiveArgs,
      vectorEnabled,
      embedding: context.embedding || {}
    });

  const { scannedCandidates, deduped, ranked } = collectAndRankHybridCandidates({
    semanticResult,
    syntaxResult,
    indexResult,
    vectorResult,
    edgeType: effectiveArgs?.edge_type,
    query,
    pathPrefix: effectiveArgs?.path_prefix,
    explain: effectiveArgs?.explain
  });
  const embeddingRerank = await rerankHybridCandidatesWithEmbedding({
    ranked,
    args: {
      ...effectiveArgs,
      query
    },
    config: resolveHybridEmbeddingConfig(effectiveArgs, context)
  });
  const finalRanked = Array.isArray(embeddingRerank?.ranked) ? embeddingRerank.ranked : ranked;
  const freshnessRerank = await rerankHybridCandidatesWithFreshness({
    ranked: finalRanked,
    args: {
      ...effectiveArgs,
      query
    },
    config: resolveHybridFreshnessConfig(effectiveArgs, context),
    workspaceRoot: context.workspaceRoot,
    resolveSafePath
  });
  const freshnessRanked = Array.isArray(freshnessRerank?.ranked)
    ? freshnessRerank.ranked
    : finalRanked;
  const seeds = attachHybridRetrievalProtocol(freshnessRanked.slice(0, topK));
  const embeddingSource = embeddingRerank?.source || {
    enabled: false,
    attempted: false,
    ok: false,
    model: DEFAULT_HYBRID_EMBEDDING_MODEL,
    top_k: DEFAULT_HYBRID_EMBEDDING_TOP_K,
    weight: DEFAULT_HYBRID_EMBEDDING_WEIGHT,
    timeout_ms: DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
    reranked_candidates: 0,
    latency_ms: 0,
    status_code: "EMBEDDING_DISABLED",
    error_code: null,
    retryable: false,
    rank_shift_count: 0,
    top1_changed: false,
    score_delta_mean: 0,
    error: null
  };
  const freshnessSource = freshnessRerank?.source || {
    enabled: false,
    attempted: false,
    ok: false,
    stale_after_ms: DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
    weight: DEFAULT_HYBRID_FRESHNESS_WEIGHT,
    vector_stale_penalty: DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
    sampled_paths: 0,
    sampled_paths_limit: DEFAULT_HYBRID_FRESHNESS_MAX_PATHS,
    sampled_paths_with_stat: 0,
    missing_paths: 0,
    candidates_with_freshness: 0,
    stale_candidates: 0,
    stale_vector_candidates: 0,
    stale_hit_rate: 0,
    status_code: "FRESHNESS_DISABLED",
    error: null
  };
  const priorityPolicy = ["semantic", "vector", "syntax", "index"];
  if (embeddingSource.ok) {
    priorityPolicy.push("embedding_rerank");
  }
  if (freshnessSource.attempted) {
    priorityPolicy.push("freshness_rerank");
  }
  const degradation = buildHybridDegradationSummary(
    embeddingSource,
    freshnessSource
  );
  const queryTotalMs = roundHybridMs(performance.now() - queryStartedAt);
  let tunerOutcome = {
    recorded: false,
    reason: "not_recorded"
  };
  try {
    tunerOutcome = await recordHybridTunerOutcome(
      context.workspaceRoot,
      tunerDecision,
      {
        query_total_ms: queryTotalMs,
        seeds,
        sources: {
          embedding: {
            status_code: embeddingSource.status_code || null
          }
        },
        degradation
      },
      context
    );
  } catch (error) {
    tunerOutcome = {
      recorded: false,
      reason: "record_failed",
      error: error.message || String(error)
    };
  }
  const metricsConfig = resolveMetricsConfig(context);
  const metricsEvent = buildHybridMetricEvent({
    trace: context?.trace,
    query,
    queryTotalMs,
    topK,
    scannedCandidates,
    dedupedCandidates: deduped,
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
    queryPreviewChars: metricsConfig.query_preview_chars
  });
  const metricsWrite = await appendHybridQueryMetricEvent({
    workspaceRoot: context.workspaceRoot,
    event: metricsEvent,
    metricsConfig,
    resolveSafePath,
    metricsSubdir,
    metricsFileName
  });

  const languageDistribution = {
    scanned_candidates: summarizeFallbackSeedLanguages(scannedCandidates),
    deduped_candidates: summarizeFallbackSeedLanguages(
      Array.from(deduped.values()).map((entry) => entry.candidate)
    ),
    returned_seeds: summarizeFallbackSeedLanguages(seeds)
  };

  return buildHybridQueryResponse({
    trace: context?.trace,
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
    dedupedCandidates: deduped,
    languageDistribution,
    seeds
  });
}
