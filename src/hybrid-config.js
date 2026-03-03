export const DEFAULT_HYBRID_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_HYBRID_EMBEDDING_TOP_K = 15;
export const DEFAULT_HYBRID_EMBEDDING_WEIGHT = 0.25;
export const DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS = 15_000;
export const DEFAULT_HYBRID_FRESHNESS_ENABLED = true;
export const DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS = 300_000;
export const DEFAULT_HYBRID_FRESHNESS_WEIGHT = 0.12;
export const DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY = 0.25;
export const DEFAULT_HYBRID_FRESHNESS_MAX_PATHS = 200;
export const DEFAULT_METRICS_ENABLED = true;
export const DEFAULT_METRICS_PERSIST_HYBRID = true;
export const DEFAULT_METRICS_QUERY_PREVIEW_CHARS = 160;

export function parseHybridBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

export function parseHybridInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

export function parseHybridFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

export function resolveHybridEmbeddingConfig(args, context) {
  const embedding = context?.embedding || {};
  const enabled = parseHybridBoolean(args?.enable_embedding, Boolean(embedding.enabled));
  const topK = parseHybridInt(
    args?.embedding_top_k,
    parseHybridInt(embedding.topK, DEFAULT_HYBRID_EMBEDDING_TOP_K, 1, 200),
    1,
    200
  );
  const weight = parseHybridFloat(
    args?.embedding_weight,
    parseHybridFloat(embedding.weight, DEFAULT_HYBRID_EMBEDDING_WEIGHT, 0, 1),
    0,
    1
  );
  const timeoutMs = parseHybridInt(
    args?.embedding_timeout_ms,
    parseHybridInt(
      embedding.timeoutMs,
      DEFAULT_HYBRID_EMBEDDING_TIMEOUT_MS,
      1000,
      120_000
    ),
    1000,
    120_000
  );
  const model =
    typeof args?.embedding_model === "string" && args.embedding_model.trim().length > 0
      ? args.embedding_model.trim()
      : typeof embedding.model === "string" && embedding.model.trim().length > 0
        ? embedding.model.trim()
        : DEFAULT_HYBRID_EMBEDDING_MODEL;

  return {
    enabled,
    top_k: topK,
    weight,
    timeout_ms: timeoutMs,
    model,
    api_key:
      typeof embedding.apiKey === "string" && embedding.apiKey.trim().length > 0
        ? embedding.apiKey.trim()
        : null,
    base_url:
      typeof embedding.baseUrl === "string" && embedding.baseUrl.trim().length > 0
        ? embedding.baseUrl.trim()
        : "https://api.openai.com/v1",
    client: typeof embedding.client === "function" ? embedding.client : null
  };
}

export function resolveHybridFreshnessConfig(args, context) {
  const index = context?.index || {};
  const enabled = parseHybridBoolean(
    args?.enable_freshness,
    parseHybridBoolean(index.freshnessEnabled, DEFAULT_HYBRID_FRESHNESS_ENABLED)
  );
  return {
    enabled,
    stale_after_ms: parseHybridInt(
      args?.freshness_stale_after_ms,
      parseHybridInt(
        index.freshnessStaleAfterMs,
        DEFAULT_HYBRID_FRESHNESS_STALE_AFTER_MS,
        1000,
        86_400_000
      ),
      1000,
      86_400_000
    ),
    weight: parseHybridFloat(
      args?.freshness_weight,
      parseHybridFloat(index.freshnessWeight, DEFAULT_HYBRID_FRESHNESS_WEIGHT, 0, 1),
      0,
      1
    ),
    vector_stale_penalty: parseHybridFloat(
      args?.freshness_vector_stale_penalty,
      parseHybridFloat(
        index.freshnessVectorStalePenalty,
        DEFAULT_HYBRID_FRESHNESS_VECTOR_STALE_PENALTY,
        0,
        1
      ),
      0,
      1
    ),
    max_paths: parseHybridInt(
      args?.freshness_max_paths,
      parseHybridInt(index.freshnessMaxPaths, DEFAULT_HYBRID_FRESHNESS_MAX_PATHS, 1, 1000),
      1,
      1000
    )
  };
}

export function resolveMetricsConfig(context = {}) {
  const metrics = context?.metrics || {};
  return {
    enabled: parseHybridBoolean(
      metrics.enabled ?? process.env.CLAWTY_METRICS_ENABLED,
      DEFAULT_METRICS_ENABLED
    ),
    persist_hybrid: parseHybridBoolean(
      metrics.persistHybrid ?? process.env.CLAWTY_METRICS_PERSIST_HYBRID,
      DEFAULT_METRICS_PERSIST_HYBRID
    ),
    query_preview_chars: parseHybridInt(
      metrics.queryPreviewChars ?? process.env.CLAWTY_METRICS_QUERY_PREVIEW_CHARS,
      DEFAULT_METRICS_QUERY_PREVIEW_CHARS,
      32,
      1000
    )
  };
}
