const EMBEDDING_STATUS_RUNBOOK = Object.freeze({
  EMBEDDING_OK: {
    mapped: true,
    category: "ok",
    kpi_bucket: null,
    failure: false
  },
  EMBEDDING_DISABLED: {
    mapped: true,
    category: "disabled",
    kpi_bucket: null,
    failure: false
  },
  EMBEDDING_NOT_ATTEMPTED_NO_API_KEY: {
    mapped: true,
    category: "misconfig",
    kpi_bucket: null,
    failure: false
  },
  EMBEDDING_NOT_ATTEMPTED_NO_CANDIDATES: {
    mapped: true,
    category: "no_candidates",
    kpi_bucket: null,
    failure: false
  },
  EMBEDDING_ERROR_TIMEOUT: {
    mapped: true,
    category: "timeout",
    kpi_bucket: "timeout",
    failure: true
  },
  EMBEDDING_ERROR_NETWORK: {
    mapped: true,
    category: "network",
    kpi_bucket: "network",
    failure: true
  },
  EMBEDDING_ERROR_API: {
    mapped: true,
    category: "api",
    kpi_bucket: "api",
    failure: true
  },
  EMBEDDING_ERROR_RESPONSE: {
    mapped: true,
    category: "response",
    kpi_bucket: "unknown",
    failure: true
  },
  EMBEDDING_ERROR_INPUT: {
    mapped: true,
    category: "input",
    kpi_bucket: "unknown",
    failure: true
  },
  EMBEDDING_ERROR_UNKNOWN: {
    mapped: true,
    category: "unknown",
    kpi_bucket: "unknown",
    failure: true
  }
});

function normalizeEmbeddingStatusCode(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().toUpperCase();
}

function classifyEmbeddingStatus(statusCode) {
  const normalized = normalizeEmbeddingStatusCode(statusCode);
  if (!normalized) {
    return {
      status_code: null,
      mapped: false,
      category: "unknown",
      kpi_bucket: "unknown",
      failure: true
    };
  }
  const matched = EMBEDDING_STATUS_RUNBOOK[normalized];
  if (!matched) {
    return {
      status_code: normalized,
      mapped: false,
      category: "unknown",
      kpi_bucket: "unknown",
      failure: true
    };
  }
  return {
    status_code: normalized,
    ...matched
  };
}

export { EMBEDDING_STATUS_RUNBOOK, classifyEmbeddingStatus, normalizeEmbeddingStatusCode };
