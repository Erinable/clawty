function defaultNormalizeSource(source) {
  if (typeof source !== "string") {
    return "unknown";
  }
  const normalized = source.trim().toLowerCase();
  return normalized || "unknown";
}

function defaultRoundMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(4));
}

export function classifyRetrievalConfidenceLevel(score) {
  const numeric = Number(score || 0);
  if (!Number.isFinite(numeric)) {
    return "low";
  }
  if (numeric >= 0.75) {
    return "high";
  }
  if (numeric >= 0.45) {
    return "medium";
  }
  return "low";
}

export function buildRetrievalResultProtocol(candidate, options = {}) {
  const normalizeSource =
    typeof options.normalizeSource === "function"
      ? options.normalizeSource
      : defaultNormalizeSource;
  const roundMetric =
    typeof options.roundMetric === "function" ? options.roundMetric : defaultRoundMetric;

  const source = normalizeSource(candidate?.source);
  const confidenceScore = roundMetric(candidate?.hybrid_score);
  const timelinessScore = Number.isFinite(Number(candidate?.freshness_score))
    ? roundMetric(candidate.freshness_score)
    : null;
  const timelinessAgeMs = Number.isFinite(Number(candidate?.freshness_age_ms))
    ? Math.floor(Number(candidate.freshness_age_ms))
    : null;
  const timelinessStale =
    typeof candidate?.freshness_stale === "boolean" ? candidate.freshness_stale : null;

  const providers = Array.isArray(candidate?.supporting_providers)
    ? Array.from(new Set(candidate.supporting_providers.map((item) => normalizeSource(item)))).sort()
    : [source];

  const dedupKey =
    typeof options.dedupKey === "string"
      ? options.dedupKey
      : typeof options.getDedupKey === "function"
        ? options.getDedupKey(candidate)
        : "";

  const timeliness = {
    score: timelinessScore,
    age_ms: timelinessAgeMs,
    stale: timelinessStale
  };

  return {
    source,
    confidence: {
      score: confidenceScore,
      level: classifyRetrievalConfidenceLevel(confidenceScore)
    },
    timeliness,
    freshness: timeliness,
    dedup_key: dedupKey,
    supporting_sources: providers
  };
}
