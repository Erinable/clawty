import fs from "node:fs/promises";
import { createEmbeddings, EmbeddingError } from "./embedding-client.js";
import {
  buildHybridEmbeddingText,
  cosineSimilarity,
  hybridCandidateKey,
  normalizeHybridSource,
  normalizedCosineScore,
  roundHybridMetric,
  sortHybridCandidates
} from "./hybrid-ranking.js";

const DEFAULT_FRESHNESS_STALE_AFTER_MS = 300_000;

function classifyEmbeddingFailure(error) {
  const code = String(error?.code || "").trim();
  if (code === "EMBEDDING_REQUEST_TIMEOUT") {
    return {
      status_code: "EMBEDDING_ERROR_TIMEOUT",
      error_code: code,
      retryable: true
    };
  }
  if (code === "EMBEDDING_REQUEST_NETWORK") {
    return {
      status_code: "EMBEDDING_ERROR_NETWORK",
      error_code: code,
      retryable: true
    };
  }
  if (code === "EMBEDDING_API_HTTP_ERROR") {
    return {
      status_code: "EMBEDDING_ERROR_API",
      error_code: code,
      retryable: Boolean(error?.retryable)
    };
  }
  if (code === "EMBEDDING_RESPONSE_INVALID") {
    return {
      status_code: "EMBEDDING_ERROR_RESPONSE",
      error_code: code,
      retryable: false
    };
  }
  if (code === "EMBEDDING_INPUT_INVALID") {
    return {
      status_code: "EMBEDDING_ERROR_INPUT",
      error_code: code,
      retryable: false
    };
  }
  if (code === "EMBEDDING_API_KEY_MISSING") {
    return {
      status_code: "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY",
      error_code: code,
      retryable: false
    };
  }
  return {
    status_code: "EMBEDDING_ERROR_UNKNOWN",
    error_code: code || "EMBEDDING_UNKNOWN",
    retryable: false
  };
}

function buildEmbeddingSourceBase(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    attempted: false,
    ok: false,
    model: config.model || null,
    top_k: Number(config.top_k || 0),
    weight: Number(config.weight || 0),
    timeout_ms: Number(config.timeout_ms || 0),
    reranked_candidates: 0,
    latency_ms: 0,
    status_code: config.enabled ? "EMBEDDING_PENDING" : "EMBEDDING_DISABLED",
    error_code: null,
    retryable: false,
    error: null,
    rank_shift_count: 0,
    top1_changed: false,
    score_delta_mean: 0
  };
}

function buildFreshnessSourceBase(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    attempted: false,
    ok: false,
    stale_after_ms: Number(config.stale_after_ms || 0),
    weight: Number(config.weight || 0),
    vector_stale_penalty: Number(config.vector_stale_penalty || 0),
    sampled_paths: 0,
    sampled_paths_limit: Number(config.max_paths || 0),
    sampled_paths_with_stat: 0,
    missing_paths: 0,
    candidates_with_freshness: 0,
    stale_candidates: 0,
    stale_vector_candidates: 0,
    stale_hit_rate: 0,
    status_code: config.enabled ? "FRESHNESS_PENDING" : "FRESHNESS_DISABLED",
    error: null
  };
}

function normalizeCandidatePath(pathValue) {
  if (typeof pathValue !== "string") {
    return null;
  }
  const trimmed = pathValue.trim().replace(/\\/g, "/");
  return trimmed.length > 0 ? trimmed : null;
}

function freshnessScoreFromAge(ageMs, staleAfterMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return null;
  }
  const threshold = Math.max(
    1000,
    Number(staleAfterMs || DEFAULT_FRESHNESS_STALE_AFTER_MS)
  );
  const ratio = Math.min(1, ageMs / threshold);
  return roundHybridMetric(1 - ratio);
}

async function collectFreshnessByPath(workspaceRoot, paths, resolveSafePathFn) {
  const nowMs = Date.now();
  const map = new Map();
  await Promise.all(
    paths.map(async (relativePath) => {
      try {
        const fullPath = resolveSafePathFn(workspaceRoot, relativePath);
        const stat = await fs.stat(fullPath);
        const mtimeMs = Number(stat.mtimeMs || 0);
        map.set(relativePath, {
          exists: true,
          mtime_ms: mtimeMs,
          age_ms: Number.isFinite(mtimeMs) && mtimeMs > 0 ? Math.max(0, nowMs - mtimeMs) : null
        });
      } catch {
        map.set(relativePath, {
          exists: false,
          mtime_ms: null,
          age_ms: null
        });
      }
    })
  );
  return map;
}

export async function rerankHybridCandidatesWithFreshness({
  ranked,
  args,
  config,
  workspaceRoot,
  resolveSafePath
}) {
  const base = buildFreshnessSourceBase(config);
  if (!config?.enabled) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "FRESHNESS_DISABLED"
      }
    };
  }

  if (!Array.isArray(ranked) || ranked.length === 0) {
    return {
      ranked,
      source: {
        ...base,
        attempted: false,
        ok: true,
        status_code: "FRESHNESS_NOT_ATTEMPTED_NO_CANDIDATES"
      }
    };
  }

  const uniquePaths = [];
  const seenPaths = new Set();
  for (const candidate of ranked) {
    const candidatePath = normalizeCandidatePath(candidate?.path);
    if (!candidatePath || seenPaths.has(candidatePath)) {
      continue;
    }
    seenPaths.add(candidatePath);
    uniquePaths.push(candidatePath);
    if (uniquePaths.length >= Number(config.max_paths || 0)) {
      break;
    }
  }

  if (uniquePaths.length === 0) {
    return {
      ranked,
      source: {
        ...base,
        attempted: false,
        ok: true,
        sampled_paths: 0,
        status_code: "FRESHNESS_NOT_ATTEMPTED_NO_PATHS"
      }
    };
  }

  const freshnessByPath = await collectFreshnessByPath(
    workspaceRoot,
    uniquePaths,
    resolveSafePath
  );
  const explain = Boolean(args?.explain);
  let withFreshness = 0;
  let staleCandidates = 0;
  let staleVectorCandidates = 0;
  let sampledWithStat = 0;

  for (const value of freshnessByPath.values()) {
    if (value?.exists) {
      sampledWithStat += 1;
    }
  }

  const reranked = ranked.map((candidate) => {
    const pathValue = normalizeCandidatePath(candidate?.path);
    const freshnessMeta = pathValue ? freshnessByPath.get(pathValue) : null;
    const ageMs = Number(freshnessMeta?.age_ms);
    const freshnessScore = freshnessScoreFromAge(ageMs, config.stale_after_ms);
    const isStale = Number.isFinite(ageMs) && ageMs > config.stale_after_ms;

    const providers = new Set(
      [candidate?.source, ...(Array.isArray(candidate?.supporting_providers) ? candidate.supporting_providers : [])]
        .map((item) => normalizeHybridSource(item))
        .filter(Boolean)
    );
    const hasVectorSupport = providers.has("vector");

    let nextScore = roundHybridMetric(candidate.hybrid_score);
    let vectorPenaltyApplied = 0;
    if (freshnessScore !== null) {
      withFreshness += 1;
      if (isStale) {
        staleCandidates += 1;
      }
      nextScore = roundHybridMetric(
        nextScore * (1 - config.weight) + freshnessScore * config.weight
      );
      if (hasVectorSupport && isStale) {
        staleVectorCandidates += 1;
        const staleOverMs = Math.max(0, ageMs - config.stale_after_ms);
        const staleRatio = Math.min(1, staleOverMs / config.stale_after_ms);
        vectorPenaltyApplied = roundHybridMetric(
          config.vector_stale_penalty * (0.5 + staleRatio * 0.5)
        );
        nextScore = roundHybridMetric(nextScore * (1 - vectorPenaltyApplied));
      }
    }

    const merged = {
      ...candidate,
      hybrid_score: nextScore,
      freshness_score: freshnessScore,
      freshness_age_ms: Number.isFinite(ageMs) ? Math.floor(ageMs) : null,
      freshness_mtime_ms: Number.isFinite(Number(freshnessMeta?.mtime_ms))
        ? Math.floor(Number(freshnessMeta?.mtime_ms))
        : null,
      freshness_stale: Boolean(isStale)
    };
    if (explain) {
      merged.hybrid_explain = {
        ...(candidate.hybrid_explain || {}),
        freshness_score: freshnessScore,
        freshness_age_ms: Number.isFinite(ageMs) ? Math.floor(ageMs) : null,
        freshness_weight: roundHybridMetric(config.weight),
        freshness_vector_penalty: vectorPenaltyApplied,
        final_score: nextScore
      };
    }
    return merged;
  });

  reranked.sort(sortHybridCandidates);

  const missingPaths = uniquePaths.length - sampledWithStat;
  return {
    ranked: reranked,
    source: {
      ...base,
      attempted: true,
      ok: true,
      sampled_paths: uniquePaths.length,
      sampled_paths_with_stat: sampledWithStat,
      missing_paths: missingPaths,
      candidates_with_freshness: withFreshness,
      stale_candidates: staleCandidates,
      stale_vector_candidates: staleVectorCandidates,
      stale_hit_rate:
        withFreshness > 0 ? roundHybridMetric(staleCandidates / withFreshness) : 0,
      status_code: "FRESHNESS_OK"
    }
  };
}

export async function rerankHybridCandidatesWithEmbedding({
  ranked,
  args,
  config
}) {
  const base = buildEmbeddingSourceBase(config);
  if (!config?.enabled) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_DISABLED"
      }
    };
  }

  if (!config.client && !config.api_key) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY",
        error_code: "EMBEDDING_API_KEY_MISSING",
        error: "embedding api key is missing"
      }
    };
  }

  const rerankCount = Math.min(ranked.length, Math.max(1, config.top_k));
  if (rerankCount === 0) {
    return {
      ranked,
      source: {
        ...base,
        status_code: "EMBEDDING_NOT_ATTEMPTED_NO_CANDIDATES",
        error_code: "EMBEDDING_NO_CANDIDATES",
        error: "no hybrid candidates available"
      }
    };
  }

  const explain = Boolean(args?.explain);
  const pool = ranked.slice(0, rerankCount);
  const rest = ranked.slice(rerankCount);

  const input = [
    String(args?.query || ""),
    ...pool.map((candidate) => buildHybridEmbeddingText(candidate))
  ];

  const startedAt = Date.now();
  let vectors;
  try {
    vectors = await createEmbeddings({
      apiKey: config.api_key,
      baseUrl: config.base_url,
      model: config.model,
      input,
      timeoutMs: config.timeout_ms,
      client: config.client
    });
  } catch (error) {
    const classified = classifyEmbeddingFailure(
      error instanceof EmbeddingError ? error : error
    );
    return {
      ranked,
      source: {
        ...base,
        attempted: true,
        latency_ms: Math.max(0, Date.now() - startedAt),
        status_code: classified.status_code,
        error_code: classified.error_code,
        retryable: classified.retryable,
        error: error.message || String(error)
      }
    };
  }

  const queryVector = vectors[0];
  let scoreDeltaTotal = 0;
  const rerankedPool = pool.map((candidate, idx) => {
    const baseScore = roundHybridMetric(candidate.hybrid_score);
    const candidateVector = vectors[idx + 1];
    const embeddingScore = normalizedCosineScore(cosineSimilarity(queryVector, candidateVector));
    const finalScore = roundHybridMetric(baseScore * (1 - config.weight) + embeddingScore * config.weight);
    scoreDeltaTotal += Math.abs(finalScore - baseScore);
    const next = {
      ...candidate,
      hybrid_score: finalScore
    };
    if (explain) {
      next.hybrid_explain = {
        ...(candidate.hybrid_explain || {}),
        base_score: baseScore,
        embedding_score: embeddingScore,
        embedding_weight: roundHybridMetric(config.weight),
        final_score: finalScore
      };
    }
    return next;
  });

  const merged = [...rerankedPool, ...rest];
  merged.sort(sortHybridCandidates);
  const beforeOrder = pool.map((candidate) => hybridCandidateKey(candidate));
  const afterPosition = new Map(
    merged.map((candidate, idx) => [hybridCandidateKey(candidate), idx])
  );
  let rankShiftCount = 0;
  for (let idx = 0; idx < beforeOrder.length; idx += 1) {
    const key = beforeOrder[idx];
    if (!afterPosition.has(key)) {
      continue;
    }
    if (afterPosition.get(key) !== idx) {
      rankShiftCount += 1;
    }
  }
  const top1Changed =
    beforeOrder.length > 0 &&
    merged.length > 0 &&
    beforeOrder[0] !== hybridCandidateKey(merged[0]);

  return {
    ranked: merged,
    source: {
      ...base,
      attempted: true,
      ok: true,
      latency_ms: Math.max(0, Date.now() - startedAt),
      status_code: "EMBEDDING_OK",
      error_code: null,
      retryable: false,
      reranked_candidates: rerankCount,
      rank_shift_count: rankShiftCount,
      top1_changed: top1Changed,
      score_delta_mean: rerankCount > 0 ? roundHybridMetric(scoreDeltaTotal / rerankCount) : 0,
      error: null
    }
  };
}
