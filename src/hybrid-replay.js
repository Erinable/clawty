function roundMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(6));
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function normalizeBucket(caseDef) {
  if (typeof caseDef?.bucket === "string" && caseDef.bucket.trim()) {
    return caseDef.bucket.trim();
  }
  if (typeof caseDef?.args?.language === "string" && caseDef.args.language.trim()) {
    return `language:${caseDef.args.language.trim().toLowerCase()}`;
  }
  if (typeof caseDef?.intent === "string" && caseDef.intent.trim()) {
    return `intent:${caseDef.intent.trim().toLowerCase()}`;
  }
  return "default";
}

function normalizeLabel(value, fallback = "unknown") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeQueryPattern(caseDef) {
  if (typeof caseDef?.query_pattern === "string" && caseDef.query_pattern.trim()) {
    return caseDef.query_pattern.trim();
  }
  if (Array.isArray(caseDef?.query_patterns)) {
    const first = caseDef.query_patterns.find((item) => typeof item === "string" && item.trim());
    if (first) {
      return first.trim();
    }
  }
  if (Array.isArray(caseDef?.tags)) {
    const first = caseDef.tags.find((item) => typeof item === "string" && item.trim());
    if (first) {
      return first.trim();
    }
  }
  return "unknown";
}

export function mergeHybridReplayArgs(baseArgs, overrideArgs) {
  const base = baseArgs && typeof baseArgs === "object" ? baseArgs : {};
  const override = overrideArgs && typeof overrideArgs === "object" ? overrideArgs : {};
  return {
    ...base,
    ...override
  };
}

export function summarizeHybridReplayTask(caseDef, queryResult, queryMs) {
  const resultPaths = Array.isArray(queryResult?.seeds)
    ? queryResult.seeds.map((item) => item.path).filter((item) => typeof item === "string")
    : [];
  const rankByPath = new Map();
  for (let idx = 0; idx < resultPaths.length; idx += 1) {
    rankByPath.set(resultPaths[idx], idx + 1);
  }

  const primaryPath =
    typeof caseDef?.expected_primary_path === "string" ? caseDef.expected_primary_path : null;
  const primaryRank = primaryPath ? rankByPath.get(primaryPath) ?? null : null;

  const expectedStatus =
    typeof caseDef?.expected_embedding_status === "string"
      ? caseDef.expected_embedding_status
      : null;
  const actualStatus = queryResult?.sources?.embedding?.status_code || null;
  const statusMatch = expectedStatus === null ? true : expectedStatus === actualStatus;

  const expectedDegraded =
    typeof caseDef?.expected_degraded === "boolean" ? caseDef.expected_degraded : null;
  const actualDegraded = Boolean(queryResult?.degradation?.degraded);
  const degradedMatch = expectedDegraded === null ? true : expectedDegraded === actualDegraded;

  const queryOk = Boolean(queryResult?.ok);
  const success = Boolean(queryOk && primaryRank === 1 && statusMatch && degradedMatch);

  const language = normalizeLabel(caseDef?.language || caseDef?.args?.language, "unknown");
  const fileType = normalizeLabel(caseDef?.file_type, "unknown");
  const intent = normalizeLabel(caseDef?.intent, "unknown");
  const queryPattern = normalizeQueryPattern(caseDef);

  return {
    name: caseDef?.name || "unknown_case",
    bucket: normalizeBucket(caseDef),
    language,
    file_type: fileType,
    intent,
    query_pattern: queryPattern,
    query: caseDef?.args?.query || "",
    query_ok: queryOk,
    query_ms: roundMetric(queryMs),
    primary_path: primaryPath,
    primary_rank: primaryRank,
    top1: primaryRank === 1,
    top3: Boolean(primaryRank && primaryRank <= 3),
    expected_embedding_status: expectedStatus,
    actual_embedding_status: actualStatus,
    embedding_status_match: statusMatch,
    expected_degraded: expectedDegraded,
    actual_degraded: actualDegraded,
    degraded_match: degradedMatch,
    embedding_attempted: Boolean(queryResult?.sources?.embedding?.attempted),
    success
  };
}

export function aggregateHybridReplayMetrics(taskResults) {
  const tasks = Array.isArray(taskResults) ? taskResults : [];
  const taskCount = tasks.length;
  const successCount = tasks.filter((item) => item.success).length;
  const top1Count = tasks.filter((item) => item.top1).length;
  const top3Count = tasks.filter((item) => item.top3).length;
  const statusMatchCount = tasks.filter((item) => item.embedding_status_match).length;
  const degradeMatchCount = tasks.filter((item) => item.degraded_match).length;
  const attemptedCount = tasks.filter((item) => item.embedding_attempted).length;
  const degradedCount = tasks.filter((item) => item.actual_degraded).length;
  const queryErrorCount = tasks.filter((item) => !item.query_ok).length;
  const mrrSum = tasks.reduce((sum, item) => {
    if (!item.primary_rank) {
      return sum;
    }
    return sum + 1 / item.primary_rank;
  }, 0);
  const queryMsValues = tasks.map((item) => Number(item.query_ms || 0));

  return {
    task_count: taskCount,
    task_success_rate: taskCount > 0 ? roundMetric(successCount / taskCount) : 0,
    primary_top1_rate: taskCount > 0 ? roundMetric(top1Count / taskCount) : 0,
    primary_top3_rate: taskCount > 0 ? roundMetric(top3Count / taskCount) : 0,
    embedding_status_match_rate: taskCount > 0 ? roundMetric(statusMatchCount / taskCount) : 0,
    degrade_match_rate: taskCount > 0 ? roundMetric(degradeMatchCount / taskCount) : 0,
    embedding_attempt_rate: taskCount > 0 ? roundMetric(attemptedCount / taskCount) : 0,
    observed_degrade_rate: taskCount > 0 ? roundMetric(degradedCount / taskCount) : 0,
    query_error_rate: taskCount > 0 ? roundMetric(queryErrorCount / taskCount) : 0,
    mean_reciprocal_rank: taskCount > 0 ? roundMetric(mrrSum / taskCount) : 0,
    query_avg_ms:
      taskCount > 0
        ? roundMetric(queryMsValues.reduce((acc, item) => acc + item, 0) / taskCount)
        : 0,
    query_p95_ms: roundMetric(percentile(queryMsValues, 95))
  };
}

export function aggregateHybridReplayByBucket(taskResults) {
  const tasks = Array.isArray(taskResults) ? taskResults : [];
  const groupBy = (pickKey) => {
    const map = new Map();
    for (const item of tasks) {
      const key = pickKey(item);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(item);
    }
    const output = {};
    for (const [key, values] of map.entries()) {
      output[key] = aggregateHybridReplayMetrics(values);
    }
    return output;
  };

  return {
    bucket: groupBy((item) =>
      typeof item?.bucket === "string" && item.bucket.trim() ? item.bucket : "default"
    ),
    language: groupBy((item) => normalizeLabel(item?.language, "unknown")),
    file_type: groupBy((item) => normalizeLabel(item?.file_type, "unknown")),
    intent: groupBy((item) => normalizeLabel(item?.intent, "unknown")),
    query_pattern: groupBy((item) => normalizeQueryPattern(item))
  };
}

export function scoreHybridReplayPreset(metrics) {
  const data = metrics && typeof metrics === "object" ? metrics : {};
  const top1 = Number(data.primary_top1_rate || 0);
  const top3 = Number(data.primary_top3_rate || 0);
  const mrr = Number(data.mean_reciprocal_rank || 0);
  const queryError = Number(data.query_error_rate || 0);
  const degradeMismatch = Math.max(0, 1 - Number(data.degrade_match_rate || 0));
  const statusMismatch = Math.max(0, 1 - Number(data.embedding_status_match_rate || 0));

  const qualityScore =
    top1 * 0.5 + top3 * 0.2 + mrr * 0.3 - queryError * 0.4 - degradeMismatch * 0.1 - statusMismatch * 0.1;
  return roundMetric(qualityScore);
}

export function sortHybridReplaySummaries(summaries) {
  const items = Array.isArray(summaries) ? [...summaries] : [];
  items.sort((a, b) => {
    const scoreA = Number(a?.score || 0);
    const scoreB = Number(b?.score || 0);
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    const top1A = Number(a?.metrics?.primary_top1_rate || 0);
    const top1B = Number(b?.metrics?.primary_top1_rate || 0);
    if (top1B !== top1A) {
      return top1B - top1A;
    }
    const mrrA = Number(a?.metrics?.mean_reciprocal_rank || 0);
    const mrrB = Number(b?.metrics?.mean_reciprocal_rank || 0);
    if (mrrB !== mrrA) {
      return mrrB - mrrA;
    }
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
  return items;
}

function buildHybridReplayFailureReasons(taskRow) {
  const reasons = [];
  if (!taskRow?.query_ok) {
    reasons.push("query_failed");
  }
  if (!taskRow?.top1) {
    reasons.push("primary_not_top1");
  }
  if (!taskRow?.embedding_status_match) {
    reasons.push("embedding_status_mismatch");
  }
  if (!taskRow?.degraded_match) {
    reasons.push("degraded_flag_mismatch");
  }
  return reasons;
}

export function extractHybridReplayFailures(taskResults) {
  const tasks = Array.isArray(taskResults) ? taskResults : [];
  return tasks
    .filter((item) => !item?.success)
    .map((item) => {
      const reasons = buildHybridReplayFailureReasons(item);
      return {
        name: item?.name || "unknown_case",
        bucket: item?.bucket || "default",
        language: item?.language || "unknown",
        file_type: item?.file_type || "unknown",
        intent: item?.intent || "unknown",
        query_pattern: item?.query_pattern || "unknown",
        query: item?.query || "",
        primary_path: item?.primary_path || null,
        primary_rank: item?.primary_rank ?? null,
        expected_embedding_status: item?.expected_embedding_status ?? null,
        actual_embedding_status: item?.actual_embedding_status ?? null,
        expected_degraded: item?.expected_degraded ?? null,
        actual_degraded: item?.actual_degraded ?? null,
        failure_reasons: reasons
      };
    })
    .sort((a, b) => {
      if (b.failure_reasons.length !== a.failure_reasons.length) {
        return b.failure_reasons.length - a.failure_reasons.length;
      }
      const rankA = Number.isFinite(Number(a.primary_rank)) ? Number(a.primary_rank) : Number.MAX_SAFE_INTEGER;
      const rankB = Number.isFinite(Number(b.primary_rank)) ? Number(b.primary_rank) : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
}
