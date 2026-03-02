import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TUNER_DB_RELATIVE = path.join(".clawty", "tuner.db");
const GLOBAL_WORKSPACE_ID = "*";

const TUNED_PARAM_KEYS = Object.freeze([
  "enable_embedding",
  "embedding_top_k",
  "embedding_weight",
  "embedding_timeout_ms",
  "freshness_weight",
  "freshness_stale_after_ms"
]);

const DEFAULT_SELECTOR_OPTIONS = Object.freeze({
  epsilon: 0.08,
  globalPriorWeight: 0.35,
  localWarmupSamples: 50,
  minConstraintSamples: 30,
  maxDegradeRate: 0.1,
  maxTimeoutRate: 0.08,
  maxNetworkRate: 0.05,
  successRewardThreshold: 0.35
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeMode(value, enabled, fallback = "shadow") {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = ["off", "shadow", "active"].includes(raw) ? raw : fallback;
  if (!enabled) {
    return "off";
  }
  return normalized === "off" ? "shadow" : normalized;
}

function normalizeTunedParams(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const normalized = {};

  if (source.enable_embedding !== undefined) {
    normalized.enable_embedding = parseBoolean(source.enable_embedding, false);
  }
  if (source.embedding_top_k !== undefined) {
    normalized.embedding_top_k = clampInt(source.embedding_top_k, 15, 1, 200);
  }
  if (source.embedding_weight !== undefined) {
    normalized.embedding_weight = clampFloat(source.embedding_weight, 0.25, 0, 1);
  }
  if (source.embedding_timeout_ms !== undefined) {
    normalized.embedding_timeout_ms = clampInt(source.embedding_timeout_ms, 15_000, 1000, 120_000);
  }
  if (source.freshness_weight !== undefined) {
    normalized.freshness_weight = clampFloat(source.freshness_weight, 0.12, 0, 1);
  }
  if (source.freshness_stale_after_ms !== undefined) {
    normalized.freshness_stale_after_ms = clampInt(
      source.freshness_stale_after_ms,
      300_000,
      1000,
      86_400_000
    );
  }

  return normalized;
}

function normalizeArmCatalog(rawArms, context = {}) {
  if (!Array.isArray(rawArms) || rawArms.length === 0) {
    return buildDefaultArms(context);
  }

  const result = [];
  const dedup = new Set();
  for (const entry of rawArms) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const armIdRaw = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!armIdRaw) {
      continue;
    }
    const armId = armIdRaw.slice(0, 80);
    if (dedup.has(armId)) {
      continue;
    }
    dedup.add(armId);
    result.push({
      id: armId,
      params: normalizeTunedParams(entry.params)
    });
  }

  if (result.length === 0) {
    return buildDefaultArms(context);
  }
  return result;
}

function buildDefaultArms(context = {}) {
  const embedding = isPlainObject(context.embedding) ? context.embedding : {};
  const index = isPlainObject(context.index) ? context.index : {};

  const baseTopK = clampInt(embedding.topK, 15, 1, 200);
  const baseWeight = clampFloat(embedding.weight, 0.25, 0, 1);
  const baseTimeout = clampInt(embedding.timeoutMs, 15_000, 1000, 120_000);
  const baseFreshnessWeight = clampFloat(index.freshnessWeight, 0.12, 0, 1);
  const baseStaleAfterMs = clampInt(index.freshnessStaleAfterMs, 300_000, 1000, 86_400_000);

  return [
    {
      id: "safe_default",
      params: {}
    },
    {
      id: "embed_balanced",
      params: {
        enable_embedding: true,
        embedding_top_k: baseTopK,
        embedding_weight: baseWeight,
        embedding_timeout_ms: baseTimeout,
        freshness_weight: baseFreshnessWeight,
        freshness_stale_after_ms: baseStaleAfterMs
      }
    },
    {
      id: "embed_fast",
      params: {
        enable_embedding: true,
        embedding_top_k: Math.max(6, baseTopK - 5),
        embedding_weight: clampFloat(baseWeight * 0.75, 0.2, 0, 1),
        embedding_timeout_ms: Math.max(8000, baseTimeout - 5000),
        freshness_weight: baseFreshnessWeight,
        freshness_stale_after_ms: baseStaleAfterMs
      }
    },
    {
      id: "embed_quality",
      params: {
        enable_embedding: true,
        embedding_top_k: Math.min(200, baseTopK + 8),
        embedding_weight: clampFloat(baseWeight + 0.12, 0.35, 0, 1),
        embedding_timeout_ms: Math.min(120_000, baseTimeout + 5000),
        freshness_weight: clampFloat(baseFreshnessWeight + 0.04, 0.16, 0, 1),
        freshness_stale_after_ms: Math.max(1000, Math.floor(baseStaleAfterMs * 0.75))
      }
    },
    {
      id: "freshness_aggressive",
      params: {
        enable_embedding: false,
        freshness_weight: clampFloat(baseFreshnessWeight + 0.08, 0.2, 0, 1),
        freshness_stale_after_ms: Math.max(1000, Math.floor(baseStaleAfterMs * 0.5))
      }
    }
  ];
}

function resolveDbPath(workspaceRoot, config = {}) {
  const dbPathRaw = typeof config.dbPath === "string" ? config.dbPath.trim() : "";
  if (dbPathRaw) {
    return path.isAbsolute(dbPathRaw)
      ? dbPathRaw
      : path.resolve(workspaceRoot, dbPathRaw);
  }
  return path.resolve(workspaceRoot, DEFAULT_TUNER_DB_RELATIVE);
}

async function ensureDbDir(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tuner_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tuner_arms (
      arm_id TEXT PRIMARY KEY,
      params_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tuner_decisions (
      decision_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      explicit_override INTEGER NOT NULL DEFAULT 0,
      params_applied_json TEXT NOT NULL,
      context_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tuner_outcomes (
      decision_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      reward REAL NOT NULL,
      success INTEGER NOT NULL,
      quality_proxy REAL NOT NULL,
      query_total_ms REAL NOT NULL,
      degraded INTEGER NOT NULL,
      timeout INTEGER NOT NULL,
      network INTEGER NOT NULL,
      embedding_status_code TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tuner_posterior (
      workspace_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      degrade_count INTEGER NOT NULL DEFAULT 0,
      timeout_count INTEGER NOT NULL DEFAULT 0,
      network_count INTEGER NOT NULL DEFAULT 0,
      reward_sum REAL NOT NULL DEFAULT 0,
      reward_sq_sum REAL NOT NULL DEFAULT 0,
      latency_ms_sum REAL NOT NULL DEFAULT 0,
      alpha REAL NOT NULL DEFAULT 1,
      beta REAL NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, arm_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tuner_decisions_workspace_time
      ON tuner_decisions(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tuner_outcomes_workspace_time
      ON tuner_outcomes(workspace_id, created_at);
  `);
  db
    .prepare(
      `
      INSERT INTO tuner_meta(key, value)
      VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
    )
    .run("schema_version", "1");
  return db;
}

async function withDb(workspaceRoot, config, callback) {
  const dbPath = resolveDbPath(workspaceRoot, config);
  await ensureDbDir(dbPath);
  const db = openDb(dbPath);
  try {
    return await callback(db, dbPath);
  } finally {
    db.close();
  }
}

function hasExplicitOverride(args = {}) {
  for (const key of TUNED_PARAM_KEYS) {
    if (args?.[key] !== undefined && args?.[key] !== null) {
      return true;
    }
  }
  return false;
}

function applyArmParams(args = {}, armParams = {}) {
  const base = isPlainObject(args) ? { ...args } : {};
  const applied = {};
  for (const [key, value] of Object.entries(armParams || {})) {
    if (base[key] !== undefined && base[key] !== null) {
      continue;
    }
    base[key] = value;
    applied[key] = value;
  }
  return {
    effectiveArgs: base,
    appliedParams: applied
  };
}

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function blendPosterior(localStats, globalStats, options) {
  const localN = Number(localStats?.n || 0);
  const globalWeight = clampFloat(options.globalPriorWeight, 0.35, 0, 3);
  const warmup = clampInt(options.localWarmupSamples, 50, 1, 100000);
  const localFactor = Math.min(1, localN / warmup);
  const localWeight = Math.max(0.2, localFactor);
  return {
    n: localN * localWeight + Number(globalStats?.n || 0) * globalWeight,
    alpha:
      Number(localStats?.alpha || 1) * localWeight +
      Number(globalStats?.alpha || 1) * globalWeight,
    beta:
      Number(localStats?.beta || 1) * localWeight +
      Number(globalStats?.beta || 1) * globalWeight,
    degrade_count:
      Number(localStats?.degrade_count || 0) * localWeight +
      Number(globalStats?.degrade_count || 0) * globalWeight,
    timeout_count:
      Number(localStats?.timeout_count || 0) * localWeight +
      Number(globalStats?.timeout_count || 0) * globalWeight,
    network_count:
      Number(localStats?.network_count || 0) * localWeight +
      Number(globalStats?.network_count || 0) * globalWeight
  };
}

function isArmFeasible(stats, options) {
  const n = Number(stats?.n || 0);
  const minSamples = clampInt(options.minConstraintSamples, 30, 1, 100000);
  if (n < minSamples) {
    return {
      feasible: true,
      reason: "insufficient_samples"
    };
  }
  const degradeRate = Number(stats.degrade_count || 0) / Math.max(1, n);
  if (degradeRate > Number(options.maxDegradeRate)) {
    return {
      feasible: false,
      reason: "degrade_rate"
    };
  }
  const timeoutRate = Number(stats.timeout_count || 0) / Math.max(1, n);
  if (timeoutRate > Number(options.maxTimeoutRate)) {
    return {
      feasible: false,
      reason: "timeout_rate"
    };
  }
  const networkRate = Number(stats.network_count || 0) / Math.max(1, n);
  if (networkRate > Number(options.maxNetworkRate)) {
    return {
      feasible: false,
      reason: "network_rate"
    };
  }
  return {
    feasible: true,
    reason: "ok"
  };
}

function sampleScore(stats) {
  const alpha = Math.max(0.1, Number(stats.alpha || 1));
  const beta = Math.max(0.1, Number(stats.beta || 1));
  const total = alpha + beta;
  const mean = alpha / total;
  const variance = (alpha * beta) / (total * total * (total + 1));
  const std = Math.sqrt(Math.max(variance, 1e-6));
  return mean + randomNormal() * std;
}

function resolveSelectorOptions(config = {}) {
  return {
    epsilon: clampFloat(config.epsilon, DEFAULT_SELECTOR_OPTIONS.epsilon, 0, 1),
    globalPriorWeight: clampFloat(
      config.globalPriorWeight,
      DEFAULT_SELECTOR_OPTIONS.globalPriorWeight,
      0,
      3
    ),
    localWarmupSamples: clampInt(
      config.localWarmupSamples,
      DEFAULT_SELECTOR_OPTIONS.localWarmupSamples,
      1,
      100000
    ),
    minConstraintSamples: clampInt(
      config.minConstraintSamples,
      DEFAULT_SELECTOR_OPTIONS.minConstraintSamples,
      1,
      100000
    ),
    maxDegradeRate: clampFloat(
      config.maxDegradeRate,
      DEFAULT_SELECTOR_OPTIONS.maxDegradeRate,
      0,
      1
    ),
    maxTimeoutRate: clampFloat(
      config.maxTimeoutRate,
      DEFAULT_SELECTOR_OPTIONS.maxTimeoutRate,
      0,
      1
    ),
    maxNetworkRate: clampFloat(
      config.maxNetworkRate,
      DEFAULT_SELECTOR_OPTIONS.maxNetworkRate,
      0,
      1
    ),
    successRewardThreshold: clampFloat(
      config.successRewardThreshold,
      DEFAULT_SELECTOR_OPTIONS.successRewardThreshold,
      -1,
      1
    )
  };
}

function serializeContext(query, args) {
  return {
    query_length: typeof query === "string" ? query.length : 0,
    has_path_prefix: typeof args?.path_prefix === "string" && args.path_prefix.trim().length > 0,
    has_language_filter: typeof args?.language === "string" && args.language.trim().length > 0
  };
}

function readPosterior(db, workspaceId, armId) {
  const row = db
    .prepare(
      `
      SELECT workspace_id, arm_id, n, success_count, degrade_count, timeout_count, network_count,
             reward_sum, reward_sq_sum, latency_ms_sum, alpha, beta, updated_at
      FROM tuner_posterior
      WHERE workspace_id = ? AND arm_id = ?
    `
    )
    .get(workspaceId, armId);
  if (!row) {
    return {
      workspace_id: workspaceId,
      arm_id: armId,
      n: 0,
      success_count: 0,
      degrade_count: 0,
      timeout_count: 0,
      network_count: 0,
      reward_sum: 0,
      reward_sq_sum: 0,
      latency_ms_sum: 0,
      alpha: 1,
      beta: 1
    };
  }
  return row;
}

function upsertArms(db, arms) {
  const nowIso = new Date().toISOString();
  const upsert = db.prepare(
    `
    INSERT INTO tuner_arms(arm_id, params_json, active, updated_at)
    VALUES(?, ?, 1, ?)
    ON CONFLICT(arm_id) DO UPDATE SET
      params_json = excluded.params_json,
      active = 1,
      updated_at = excluded.updated_at
  `
  );
  for (const arm of arms) {
    upsert.run(arm.id, JSON.stringify(arm.params || {}), nowIso);
  }
}

function chooseArm(arms, localPosteriors, globalPosteriors, selectorOptions) {
  const candidateRows = [];
  const blockedRows = [];
  for (const arm of arms) {
    const localStats = localPosteriors.get(arm.id);
    const globalStats = globalPosteriors.get(arm.id);
    const blended = blendPosterior(localStats, globalStats, selectorOptions);
    const feasibility = isArmFeasible(blended, selectorOptions);
    const sampledScore = sampleScore(blended);
    const row = {
      arm_id: arm.id,
      blended_n: Number(blended.n || 0),
      sampled_score: Number(sampledScore.toFixed(6)),
      feasible: feasibility.feasible,
      blocked_reason: feasibility.reason
    };
    if (feasibility.feasible) {
      candidateRows.push(row);
    } else {
      blockedRows.push(row);
    }
  }

  if (candidateRows.length === 0) {
    return {
      selectedArmId: arms[0]?.id || null,
      strategy: "fallback_safe_arm",
      candidates: [],
      blocked: blockedRows
    };
  }

  const epsilon = Number(selectorOptions.epsilon || 0);
  if (Math.random() < epsilon) {
    const randomIndex = Math.floor(Math.random() * candidateRows.length);
    return {
      selectedArmId: candidateRows[randomIndex].arm_id,
      strategy: "epsilon_explore",
      candidates: candidateRows,
      blocked: blockedRows
    };
  }

  candidateRows.sort((a, b) => b.sampled_score - a.sampled_score);
  return {
    selectedArmId: candidateRows[0].arm_id,
    strategy: "thompson_exploit",
    candidates: candidateRows,
    blocked: blockedRows
  };
}

export async function prepareHybridTunerDecision(workspaceRoot, args = {}, context = {}) {
  const tunerConfig = resolveOnlineTunerConfig(context);
  const armCatalog = normalizeArmCatalog(tunerConfig.arms, context);
  const explicitOverride = hasExplicitOverride(args);

  if (!tunerConfig.enabled || tunerConfig.mode === "off") {
    return {
      enabled: false,
      mode: "off",
      decision_id: null,
      arm_id: null,
      effective_args: isPlainObject(args) ? { ...args } : {},
      applied_params: {},
      explicit_override: explicitOverride,
      selection: {
        strategy: "disabled",
        candidates: [],
        blocked: []
      }
    };
  }

  const selectorOptions = resolveSelectorOptions(tunerConfig);
  const normalizedWorkspace = path.resolve(workspaceRoot || process.cwd());

  return withDb(normalizedWorkspace, tunerConfig, async (db) => {
    upsertArms(db, armCatalog);
    const localPosteriors = new Map();
    const globalPosteriors = new Map();
    for (const arm of armCatalog) {
      localPosteriors.set(arm.id, readPosterior(db, normalizedWorkspace, arm.id));
      globalPosteriors.set(arm.id, readPosterior(db, GLOBAL_WORKSPACE_ID, arm.id));
    }

    const choice = chooseArm(armCatalog, localPosteriors, globalPosteriors, selectorOptions);
    const selectedArm =
      armCatalog.find((item) => item.id === choice.selectedArmId) || armCatalog[0] || {
        id: "safe_default",
        params: {}
      };

    const shouldApply = tunerConfig.mode === "active" && !explicitOverride;
    const merged = shouldApply
      ? applyArmParams(args, selectedArm.params)
      : {
          effectiveArgs: isPlainObject(args) ? { ...args } : {},
          appliedParams: {}
        };

    const decisionId = crypto.randomUUID();
    db
      .prepare(
        `
        INSERT INTO tuner_decisions(
          decision_id, workspace_id, arm_id, mode, explicit_override, params_applied_json, context_json, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        decisionId,
        normalizedWorkspace,
        selectedArm.id,
        tunerConfig.mode,
        explicitOverride ? 1 : 0,
        JSON.stringify(merged.appliedParams || {}),
        JSON.stringify(serializeContext(args?.query, args)),
        new Date().toISOString()
      );

    return {
      enabled: true,
      mode: tunerConfig.mode,
      decision_id: decisionId,
      arm_id: selectedArm.id,
      effective_args: merged.effectiveArgs,
      applied_params: merged.appliedParams,
      explicit_override: explicitOverride,
      selection: {
        strategy: choice.strategy,
        candidates: choice.candidates,
        blocked: choice.blocked
      }
    };
  });
}

function clampReward(value) {
  return Math.max(-1, Math.min(1, Number(value || 0)));
}

export function scoreHybridTunerOutcome(observation = {}, options = {}) {
  const queryTotalMs = Number(observation.query_total_ms || 0);
  const topSeed = Array.isArray(observation.seeds) ? observation.seeds[0] : null;
  const topSeedScore = Number(topSeed?.hybrid_score || 0);
  const qualityProxy = clampFloat(topSeedScore, 0, 0, 1);
  const hasSeed = Array.isArray(observation.seeds) && observation.seeds.length > 0;

  const embeddingStatusCode = String(observation?.sources?.embedding?.status_code || "");
  const degraded = Boolean(observation?.degradation?.degraded);
  const timeout = embeddingStatusCode === "EMBEDDING_ERROR_TIMEOUT";
  const network = embeddingStatusCode === "EMBEDDING_ERROR_NETWORK";

  const latencyPenalty = clampFloat(queryTotalMs / 2000, 0, 0, 1) * 0.2;
  const degradePenalty = degraded ? 0.35 : 0;
  const timeoutPenalty = timeout ? 0.2 : 0;
  const networkPenalty = network ? 0.15 : 0;
  const seedBonus = hasSeed ? 0.2 : 0;

  const reward = clampReward(
    qualityProxy * 0.6 + seedBonus - latencyPenalty - degradePenalty - timeoutPenalty - networkPenalty
  );

  const successThreshold = clampFloat(
    options.successRewardThreshold,
    DEFAULT_SELECTOR_OPTIONS.successRewardThreshold,
    -1,
    1
  );
  const success = reward >= successThreshold;

  return {
    reward,
    success,
    quality_proxy: qualityProxy,
    query_total_ms: Math.max(0, queryTotalMs),
    degraded,
    timeout,
    network,
    embedding_status_code: embeddingStatusCode || null
  };
}

function updatePosteriorRow(db, workspaceId, armId, scored) {
  const existing = readPosterior(db, workspaceId, armId);
  const nowIso = new Date().toISOString();
  const successDelta = scored.success ? 1 : 0;
  const failureDelta = scored.success ? 0 : 1;
  const updated = {
    n: Number(existing.n || 0) + 1,
    success_count: Number(existing.success_count || 0) + successDelta,
    degrade_count: Number(existing.degrade_count || 0) + (scored.degraded ? 1 : 0),
    timeout_count: Number(existing.timeout_count || 0) + (scored.timeout ? 1 : 0),
    network_count: Number(existing.network_count || 0) + (scored.network ? 1 : 0),
    reward_sum: Number(existing.reward_sum || 0) + Number(scored.reward || 0),
    reward_sq_sum: Number(existing.reward_sq_sum || 0) + Number(scored.reward || 0) ** 2,
    latency_ms_sum: Number(existing.latency_ms_sum || 0) + Number(scored.query_total_ms || 0),
    alpha: Number(existing.alpha || 1) + successDelta,
    beta: Number(existing.beta || 1) + failureDelta,
    updated_at: nowIso
  };

  db
    .prepare(
      `
      INSERT INTO tuner_posterior(
        workspace_id, arm_id, n, success_count, degrade_count, timeout_count, network_count,
        reward_sum, reward_sq_sum, latency_ms_sum, alpha, beta, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, arm_id) DO UPDATE SET
        n = excluded.n,
        success_count = excluded.success_count,
        degrade_count = excluded.degrade_count,
        timeout_count = excluded.timeout_count,
        network_count = excluded.network_count,
        reward_sum = excluded.reward_sum,
        reward_sq_sum = excluded.reward_sq_sum,
        latency_ms_sum = excluded.latency_ms_sum,
        alpha = excluded.alpha,
        beta = excluded.beta,
        updated_at = excluded.updated_at
    `
    )
    .run(
      workspaceId,
      armId,
      updated.n,
      updated.success_count,
      updated.degrade_count,
      updated.timeout_count,
      updated.network_count,
      updated.reward_sum,
      updated.reward_sq_sum,
      updated.latency_ms_sum,
      updated.alpha,
      updated.beta,
      updated.updated_at
    );
}

export async function recordHybridTunerOutcome(
  workspaceRoot,
  decision = {},
  observation = {},
  context = {}
) {
  if (!decision?.enabled || !decision?.decision_id || !decision?.arm_id) {
    return {
      recorded: false,
      reason: "decision_disabled"
    };
  }

  const tunerConfig = resolveOnlineTunerConfig(context);
  if (!tunerConfig.enabled || tunerConfig.mode === "off") {
    return {
      recorded: false,
      reason: "tuner_disabled"
    };
  }

  const normalizedWorkspace = path.resolve(workspaceRoot || process.cwd());
  const scored = scoreHybridTunerOutcome(
    {
      query_total_ms: observation.query_total_ms,
      seeds: observation.seeds,
      sources: observation.sources,
      degradation: observation.degradation
    },
    tunerConfig
  );

  return withDb(normalizedWorkspace, tunerConfig, async (db) => {
    db
      .prepare(
        `
      INSERT INTO tuner_outcomes(
        decision_id, workspace_id, arm_id, reward, success, quality_proxy, query_total_ms,
        degraded, timeout, network, embedding_status_code, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET
        reward = excluded.reward,
        success = excluded.success,
        quality_proxy = excluded.quality_proxy,
        query_total_ms = excluded.query_total_ms,
        degraded = excluded.degraded,
        timeout = excluded.timeout,
        network = excluded.network,
        embedding_status_code = excluded.embedding_status_code,
        created_at = excluded.created_at
    `
      )
      .run(
        decision.decision_id,
        normalizedWorkspace,
        decision.arm_id,
        scored.reward,
        scored.success ? 1 : 0,
        scored.quality_proxy,
        scored.query_total_ms,
        scored.degraded ? 1 : 0,
        scored.timeout ? 1 : 0,
        scored.network ? 1 : 0,
        scored.embedding_status_code,
        new Date().toISOString()
      );

    updatePosteriorRow(db, normalizedWorkspace, decision.arm_id, scored);
    updatePosteriorRow(db, GLOBAL_WORKSPACE_ID, decision.arm_id, scored);

    return {
      recorded: true,
      decision_id: decision.decision_id,
      arm_id: decision.arm_id,
      reward: scored.reward,
      success: scored.success,
      quality_proxy: scored.quality_proxy,
      degraded: scored.degraded,
      timeout: scored.timeout,
      network: scored.network
    };
  });
}

export function resolveOnlineTunerConfig(context = {}) {
  const raw = isPlainObject(context.onlineTuner) ? context.onlineTuner : {};
  const env = process.env;
  const enabled = parseBoolean(raw.enabled ?? env.CLAWTY_TUNER_ENABLED, false);
  const mode = normalizeMode(raw.mode ?? env.CLAWTY_TUNER_MODE, enabled, "shadow");

  return {
    enabled,
    mode,
    dbPath: typeof raw.dbPath === "string" && raw.dbPath.trim() ? raw.dbPath.trim() : "",
    epsilon: clampFloat(raw.epsilon ?? env.CLAWTY_TUNER_EPSILON, DEFAULT_SELECTOR_OPTIONS.epsilon, 0, 1),
    globalPriorWeight: clampFloat(
      raw.globalPriorWeight ?? env.CLAWTY_TUNER_GLOBAL_PRIOR_WEIGHT,
      DEFAULT_SELECTOR_OPTIONS.globalPriorWeight,
      0,
      3
    ),
    localWarmupSamples: clampInt(
      raw.localWarmupSamples ?? env.CLAWTY_TUNER_LOCAL_WARMUP_SAMPLES,
      DEFAULT_SELECTOR_OPTIONS.localWarmupSamples,
      1,
      100000
    ),
    minConstraintSamples: clampInt(
      raw.minConstraintSamples ?? env.CLAWTY_TUNER_MIN_CONSTRAINT_SAMPLES,
      DEFAULT_SELECTOR_OPTIONS.minConstraintSamples,
      1,
      100000
    ),
    maxDegradeRate: clampFloat(
      raw.maxDegradeRate ?? env.CLAWTY_TUNER_MAX_DEGRADE_RATE,
      DEFAULT_SELECTOR_OPTIONS.maxDegradeRate,
      0,
      1
    ),
    maxTimeoutRate: clampFloat(
      raw.maxTimeoutRate ?? env.CLAWTY_TUNER_MAX_TIMEOUT_RATE,
      DEFAULT_SELECTOR_OPTIONS.maxTimeoutRate,
      0,
      1
    ),
    maxNetworkRate: clampFloat(
      raw.maxNetworkRate ?? env.CLAWTY_TUNER_MAX_NETWORK_RATE,
      DEFAULT_SELECTOR_OPTIONS.maxNetworkRate,
      0,
      1
    ),
    successRewardThreshold: clampFloat(
      raw.successRewardThreshold ?? env.CLAWTY_TUNER_SUCCESS_REWARD_THRESHOLD,
      DEFAULT_SELECTOR_OPTIONS.successRewardThreshold,
      -1,
      1
    ),
    arms: Array.isArray(raw.arms) ? raw.arms : null
  };
}

