import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_CONFIG_CANDIDATES = [path.join(".clawty", "config.json"), "clawty.config.json"];
const GLOBAL_CONFIG_RELATIVE_PATH = path.join(".clawty", "config.json");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  const source = isPlainObject(base) ? base : {};
  const extra = isPlainObject(override) ? override : {};
  const result = { ...source };

  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

function parseDotEnv(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return { values: {}, path: null };
  }
  const content = fs.readFileSync(envPath, "utf8");
  return {
    values: parseDotEnv(content),
    path: envPath
  };
}

function parseJsonObject(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message || String(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid config in ${label}: root must be a JSON object`);
  }

  return parsed;
}

function readJsonConfigFileIfExists(fullPath, label) {
  if (!fs.existsSync(fullPath)) {
    return {
      path: null,
      data: {},
      label,
      exists: false
    };
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  return {
    path: fullPath,
    data: parseJsonObject(raw, label),
    label,
    exists: true
  };
}

function findProjectConfig(rootDir) {
  for (const candidate of PROJECT_CONFIG_CANDIDATES) {
    const fullPath = path.join(rootDir, candidate);
    const loaded = readJsonConfigFileIfExists(fullPath, candidate);
    if (!loaded.exists) {
      continue;
    }
    return {
      ...loaded,
      relativePath: candidate,
      isLegacyPath: candidate === "clawty.config.json"
    };
  }

  return {
    path: null,
    data: {},
    label: null,
    exists: false,
    relativePath: null,
    isLegacyPath: false
  };
}

function resolveHomeDir(runtimeEnv, explicitHomeDir = null) {
  if (typeof explicitHomeDir === "string" && explicitHomeDir.trim().length > 0) {
    return path.resolve(explicitHomeDir.trim());
  }

  const fromEnv =
    (typeof runtimeEnv?.HOME === "string" && runtimeEnv.HOME.trim()) ||
    (typeof runtimeEnv?.USERPROFILE === "string" && runtimeEnv.USERPROFILE.trim()) ||
    null;

  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.resolve(os.homedir());
}

function loadGlobalConfig(homeDir) {
  const fullPath = path.join(homeDir, GLOBAL_CONFIG_RELATIVE_PATH);
  const label = path.join("~", GLOBAL_CONFIG_RELATIVE_PATH);
  return readJsonConfigFileIfExists(fullPath, label);
}

export function resolveConfigSources(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const runtimeEnv = options.env && typeof options.env === "object" ? options.env : process.env;
  const homeDir = resolveHomeDir(runtimeEnv, options.homeDir);

  const dotEnv = loadDotEnv(cwd);
  const globalConfig = loadGlobalConfig(homeDir);
  const projectConfig = findProjectConfig(cwd);
  const mergedFileConfig = deepMerge(globalConfig.data, projectConfig.data);

  const warnings = [];
  if (projectConfig.isLegacyPath) {
    warnings.push({
      code: "legacy_project_config_path",
      message: "Project config at clawty.config.json is deprecated; move to .clawty/config.json."
    });
  }

  return {
    cwd,
    homeDir,
    dotEnv,
    globalConfig,
    projectConfig,
    mergedFileConfig,
    warnings
  };
}

function readInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function readFloat(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

function readBoolean(value, fallback) {
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

function readString(value, fallback) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function readEnumString(value, fallback, allowedValues) {
  const normalized = readString(value, "").toLowerCase();
  if (normalized && Array.isArray(allowedValues) && allowedValues.includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function readHttpUrl(value, fallback, label) {
  const candidate = readString(value, fallback);
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`Invalid ${label}: URL is empty`);
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid ${label}: ${candidate}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid ${label}: protocol must be http or https`);
  }
  return candidate.replace(/\/+$/, "");
}

function deepPick(object, pathList) {
  let current = object;
  for (const key of pathList) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function resolveWorkspaceRoot(rootDir, fileConfig, env) {
  const fromEnv = readString(env.CLAWTY_WORKSPACE_ROOT, null);
  if (fromEnv) {
    return path.resolve(rootDir, fromEnv);
  }
  const fromFile = readString(fileConfig.workspaceRoot, null);
  if (fromFile) {
    return path.resolve(rootDir, fromFile);
  }
  return rootDir;
}

export function loadConfig(options = {}) {
  const sources = resolveConfigSources(options);
  const rootDir = sources.cwd;
  const allowMissingApiKey = Boolean(options.allowMissingApiKey);
  const runtimeEnv = options.env && typeof options.env === "object" ? options.env : process.env;
  const fileConfig = sources.mergedFileConfig;

  const env = {
    ...sources.dotEnv.values,
    ...runtimeEnv
  };

  const apiKey =
    readString(env.OPENAI_API_KEY, null) ||
    readString(deepPick(fileConfig, ["openai", "apiKey"]), null);
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Set env var, put it in .env, or set openai.apiKey in .clawty/config.json (~/.clawty/config.json for global default)."
    );
  }

  const baseUrl = readHttpUrl(
    env.OPENAI_BASE_URL,
    readString(deepPick(fileConfig, ["openai", "baseUrl"]), "https://api.openai.com/v1"),
    "OPENAI_BASE_URL"
  );

  const model = readString(env.CLAWTY_MODEL, readString(fileConfig.model, "gpt-4.1-mini"));

  const toolTimeoutMs = readInt(
    env.CLAWTY_TOOL_TIMEOUT_MS ?? deepPick(fileConfig, ["tools", "timeoutMs"]),
    120_000,
    1000,
    300_000
  );

  const maxToolIterations = readInt(
    env.CLAWTY_MAX_TOOL_ITERATIONS ?? deepPick(fileConfig, ["tools", "maxIterations"]),
    8,
    1,
    100
  );

  const lsp = {
    enabled: readBoolean(
      env.CLAWTY_LSP_ENABLED ?? deepPick(fileConfig, ["lsp", "enabled"]),
      true
    ),
    timeoutMs: readInt(
      env.CLAWTY_LSP_TIMEOUT_MS ?? deepPick(fileConfig, ["lsp", "timeoutMs"]),
      5000,
      1000,
      60_000
    ),
    maxResults: readInt(
      env.CLAWTY_LSP_MAX_RESULTS ?? deepPick(fileConfig, ["lsp", "maxResults"]),
      100,
      1,
      1000
    ),
    tsCommand: readString(
      env.CLAWTY_LSP_TS_CMD,
      readString(deepPick(fileConfig, ["lsp", "tsCommand"]), "typescript-language-server --stdio")
    )
  };

  const index = {
    maxFiles: readInt(
      env.CLAWTY_INDEX_MAX_FILES ?? deepPick(fileConfig, ["index", "maxFiles"]),
      3000,
      1,
      20_000
    ),
    maxFileSizeKb: readInt(
      env.CLAWTY_INDEX_MAX_FILE_SIZE_KB ?? deepPick(fileConfig, ["index", "maxFileSizeKb"]),
      512,
      1,
      8192
    ),
    freshnessEnabled: readBoolean(
      env.CLAWTY_INDEX_FRESHNESS_ENABLED ?? deepPick(fileConfig, ["index", "freshnessEnabled"]),
      true
    ),
    freshnessStaleAfterMs: readInt(
      env.CLAWTY_INDEX_FRESHNESS_STALE_AFTER_MS ??
        deepPick(fileConfig, ["index", "freshnessStaleAfterMs"]),
      300_000,
      1000,
      86_400_000
    ),
    freshnessWeight: readFloat(
      env.CLAWTY_INDEX_FRESHNESS_WEIGHT ?? deepPick(fileConfig, ["index", "freshnessWeight"]),
      0.12,
      0,
      1
    ),
    freshnessVectorStalePenalty: readFloat(
      env.CLAWTY_INDEX_FRESHNESS_VECTOR_STALE_PENALTY ??
        deepPick(fileConfig, ["index", "freshnessVectorStalePenalty"]),
      0.25,
      0,
      1
    ),
    freshnessMaxPaths: readInt(
      env.CLAWTY_INDEX_FRESHNESS_MAX_PATHS ?? deepPick(fileConfig, ["index", "freshnessMaxPaths"]),
      200,
      1,
      1000
    )
  };

  const embeddingApiKey =
    readString(
      env.CLAWTY_EMBEDDING_API_KEY,
      readString(deepPick(fileConfig, ["embedding", "apiKey"]), null)
    ) || apiKey;

  const embedding = {
    enabled: readBoolean(
      env.CLAWTY_EMBEDDING_ENABLED ?? deepPick(fileConfig, ["embedding", "enabled"]),
      false
    ),
    apiKey: embeddingApiKey,
    baseUrl: readHttpUrl(
      env.CLAWTY_EMBEDDING_BASE_URL,
      readString(deepPick(fileConfig, ["embedding", "baseUrl"]), baseUrl),
      "CLAWTY_EMBEDDING_BASE_URL"
    ),
    model: readString(
      env.CLAWTY_EMBEDDING_MODEL,
      readString(deepPick(fileConfig, ["embedding", "model"]), "text-embedding-3-small")
    ),
    topK: readInt(
      env.CLAWTY_EMBEDDING_TOP_K ?? deepPick(fileConfig, ["embedding", "topK"]),
      15,
      1,
      200
    ),
    weight: readFloat(
      env.CLAWTY_EMBEDDING_WEIGHT ?? deepPick(fileConfig, ["embedding", "weight"]),
      0.25,
      0,
      1
    ),
    timeoutMs: readInt(
      env.CLAWTY_EMBEDDING_TIMEOUT_MS ?? deepPick(fileConfig, ["embedding", "timeoutMs"]),
      15_000,
      1000,
      120_000
    )
  };

  const agentContext = {
    incrementalContextEnabled: readBoolean(
      env.CLAWTY_AGENT_INCREMENTAL_CONTEXT_ENABLED ??
        deepPick(fileConfig, ["agentContext", "incrementalContextEnabled"]),
      true
    ),
    incrementalContextMaxPaths: readInt(
      env.CLAWTY_AGENT_INCREMENTAL_CONTEXT_MAX_PATHS ??
        deepPick(fileConfig, ["agentContext", "incrementalContextMaxPaths"]),
      40,
      1,
      500
    ),
    incrementalContextMaxDiffChars: readInt(
      env.CLAWTY_AGENT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS ??
        deepPick(fileConfig, ["agentContext", "incrementalContextMaxDiffChars"]),
      12_000,
      500,
      200_000
    ),
    incrementalContextTimeoutMs: readInt(
      env.CLAWTY_AGENT_INCREMENTAL_CONTEXT_TIMEOUT_MS ??
        deepPick(fileConfig, ["agentContext", "incrementalContextTimeoutMs"]),
      3000,
      500,
      20_000
    )
  };

  const metrics = {
    enabled: readBoolean(
      env.CLAWTY_METRICS_ENABLED ?? deepPick(fileConfig, ["metrics", "enabled"]),
      true
    ),
    persistHybrid: readBoolean(
      env.CLAWTY_METRICS_PERSIST_HYBRID ?? deepPick(fileConfig, ["metrics", "persistHybrid"]),
      true
    ),
    persistWatch: readBoolean(
      env.CLAWTY_METRICS_PERSIST_WATCH ?? deepPick(fileConfig, ["metrics", "persistWatch"]),
      true
    ),
    persistMemory: readBoolean(
      env.CLAWTY_METRICS_PERSIST_MEMORY ?? deepPick(fileConfig, ["metrics", "persistMemory"]),
      true
    ),
    queryPreviewChars: readInt(
      env.CLAWTY_METRICS_QUERY_PREVIEW_CHARS ??
        deepPick(fileConfig, ["metrics", "queryPreviewChars"]),
      160,
      32,
      1000
    )
  };

  const logging = {
    enabled: readBoolean(
      env.CLAWTY_LOG_ENABLED ?? deepPick(fileConfig, ["logging", "enabled"]),
      true
    ),
    level: readEnumString(
      env.CLAWTY_LOG_LEVEL ?? deepPick(fileConfig, ["logging", "level"]),
      "info",
      ["debug", "info", "warn", "error", "off"]
    ),
    console: readBoolean(
      env.CLAWTY_LOG_CONSOLE ?? deepPick(fileConfig, ["logging", "console"]),
      false
    ),
    file: readBoolean(
      env.CLAWTY_LOG_FILE ?? deepPick(fileConfig, ["logging", "file"]),
      true
    ),
    path: readString(
      env.CLAWTY_LOG_PATH ?? deepPick(fileConfig, ["logging", "path"]),
      path.join(".clawty", "logs", "runtime.log")
    )
  };

  const onlineTunerEnabled = readBoolean(
    env.CLAWTY_TUNER_ENABLED ?? deepPick(fileConfig, ["onlineTuner", "enabled"]),
    false
  );
  const onlineTunerMode = readEnumString(
    env.CLAWTY_TUNER_MODE ?? deepPick(fileConfig, ["onlineTuner", "mode"]),
    onlineTunerEnabled ? "shadow" : "off",
    ["off", "shadow", "active"]
  );
  const onlineTuner = {
    enabled: onlineTunerEnabled,
    mode: onlineTunerEnabled ? onlineTunerMode : "off",
    dbPath: readString(
      env.CLAWTY_TUNER_DB_PATH ?? deepPick(fileConfig, ["onlineTuner", "dbPath"]),
      path.join(".clawty", "tuner.db")
    ),
    epsilon: readFloat(
      env.CLAWTY_TUNER_EPSILON ?? deepPick(fileConfig, ["onlineTuner", "epsilon"]),
      0.08,
      0,
      1
    ),
    globalPriorWeight: readFloat(
      env.CLAWTY_TUNER_GLOBAL_PRIOR_WEIGHT ??
        deepPick(fileConfig, ["onlineTuner", "globalPriorWeight"]),
      0.35,
      0,
      3
    ),
    localWarmupSamples: readInt(
      env.CLAWTY_TUNER_LOCAL_WARMUP_SAMPLES ??
        deepPick(fileConfig, ["onlineTuner", "localWarmupSamples"]),
      50,
      1,
      100000
    ),
    minConstraintSamples: readInt(
      env.CLAWTY_TUNER_MIN_CONSTRAINT_SAMPLES ??
        deepPick(fileConfig, ["onlineTuner", "minConstraintSamples"]),
      30,
      1,
      100000
    ),
    maxDegradeRate: readFloat(
      env.CLAWTY_TUNER_MAX_DEGRADE_RATE ??
        deepPick(fileConfig, ["onlineTuner", "maxDegradeRate"]),
      0.1,
      0,
      1
    ),
    maxTimeoutRate: readFloat(
      env.CLAWTY_TUNER_MAX_TIMEOUT_RATE ??
        deepPick(fileConfig, ["onlineTuner", "maxTimeoutRate"]),
      0.08,
      0,
      1
    ),
    maxNetworkRate: readFloat(
      env.CLAWTY_TUNER_MAX_NETWORK_RATE ??
        deepPick(fileConfig, ["onlineTuner", "maxNetworkRate"]),
      0.05,
      0,
      1
    ),
    successRewardThreshold: readFloat(
      env.CLAWTY_TUNER_SUCCESS_REWARD_THRESHOLD ??
        deepPick(fileConfig, ["onlineTuner", "successRewardThreshold"]),
      0.35,
      -1,
      1
    ),
    arms: Array.isArray(deepPick(fileConfig, ["onlineTuner", "arms"]))
      ? deepPick(fileConfig, ["onlineTuner", "arms"])
      : null
  };

  const memoryScopeRaw = readString(
    env.CLAWTY_MEMORY_SCOPE ?? deepPick(fileConfig, ["memory", "scope"]),
    "project+global"
  ).toLowerCase();
  const memoryScope = ["project", "global", "project+global"].includes(memoryScopeRaw)
    ? memoryScopeRaw
    : "project+global";
  const memoryRanking = {
    bm25Weight: readFloat(
      env.CLAWTY_MEMORY_RANK_BM25_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "bm25Weight"]),
      0.34,
      0,
      4
    ),
    recencyWeight: readFloat(
      env.CLAWTY_MEMORY_RANK_RECENCY_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "recencyWeight"]),
      0.16,
      0,
      4
    ),
    confidenceWeight: readFloat(
      env.CLAWTY_MEMORY_RANK_CONFIDENCE_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "confidenceWeight"]),
      0.12,
      0,
      4
    ),
    successRateWeight: readFloat(
      env.CLAWTY_MEMORY_RANK_SUCCESS_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "successRateWeight"]),
      0.12,
      0,
      4
    ),
    qualityWeight: readFloat(
      env.CLAWTY_MEMORY_RANK_QUALITY_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "qualityWeight"]),
      0.14,
      0,
      4
    ),
    feedbackWeight: readFloat(
      env.CLAWTY_MEMORY_RANK_FEEDBACK_WEIGHT ??
        deepPick(fileConfig, ["memory", "ranking", "feedbackWeight"]),
      0.12,
      0,
      4
    ),
    projectBoost: readFloat(
      env.CLAWTY_MEMORY_RANK_PROJECT_BOOST ??
        deepPick(fileConfig, ["memory", "ranking", "projectBoost"]),
      1,
      0.1,
      4
    ),
    globalBoost: readFloat(
      env.CLAWTY_MEMORY_RANK_GLOBAL_BOOST ??
        deepPick(fileConfig, ["memory", "ranking", "globalBoost"]),
      0.35,
      0,
      4
    ),
    negativePenaltyPerDownvote: readFloat(
      env.CLAWTY_MEMORY_RANK_NEGATIVE_PENALTY_PER_DOWNVOTE ??
        deepPick(fileConfig, ["memory", "ranking", "negativePenaltyPerDownvote"]),
      0.06,
      0,
      2
    ),
    negativePenaltyCap: readFloat(
      env.CLAWTY_MEMORY_RANK_NEGATIVE_PENALTY_CAP ??
        deepPick(fileConfig, ["memory", "ranking", "negativePenaltyCap"]),
      0.3,
      0,
      2
    ),
    recentNegativePenalty: readFloat(
      env.CLAWTY_MEMORY_RANK_RECENT_NEGATIVE_PENALTY ??
        deepPick(fileConfig, ["memory", "ranking", "recentNegativePenalty"]),
      0.18,
      0,
      2
    ),
    recentNegativeRecencyThreshold: readFloat(
      env.CLAWTY_MEMORY_RANK_RECENT_NEGATIVE_RECENCY_THRESHOLD ??
        deepPick(fileConfig, ["memory", "ranking", "recentNegativeRecencyThreshold"]),
      0.55,
      0,
      1
    )
  };

  const memory = {
    enabled: readBoolean(
      env.CLAWTY_MEMORY_ENABLED ?? deepPick(fileConfig, ["memory", "enabled"]),
      true
    ),
    maxInjectedItems: readInt(
      env.CLAWTY_MEMORY_MAX_INJECTED_ITEMS ??
        deepPick(fileConfig, ["memory", "maxInjectedItems"]),
      5,
      1,
      20
    ),
    maxInjectedChars: readInt(
      env.CLAWTY_MEMORY_MAX_INJECTED_CHARS ??
        deepPick(fileConfig, ["memory", "maxInjectedChars"]),
      2400,
      200,
      50_000
    ),
    autoWrite: readBoolean(
      env.CLAWTY_MEMORY_AUTO_WRITE ?? deepPick(fileConfig, ["memory", "autoWrite"]),
      true
    ),
    writeGateEnabled: readBoolean(
      env.CLAWTY_MEMORY_WRITE_GATE_ENABLED ?? deepPick(fileConfig, ["memory", "writeGateEnabled"]),
      true
    ),
    minLessonChars: readInt(
      env.CLAWTY_MEMORY_MIN_LESSON_CHARS ?? deepPick(fileConfig, ["memory", "minLessonChars"]),
      80,
      40,
      4000
    ),
    dedupeEnabled: readBoolean(
      env.CLAWTY_MEMORY_DEDUPE_ENABLED ?? deepPick(fileConfig, ["memory", "dedupeEnabled"]),
      true
    ),
    quarantineThreshold: readInt(
      env.CLAWTY_MEMORY_QUARANTINE_THRESHOLD ??
        deepPick(fileConfig, ["memory", "quarantineThreshold"]),
      3,
      1,
      20
    ),
    ranking: memoryRanking,
    scope: memoryScope
  };

  return {
    apiKey: apiKey || null,
    baseUrl,
    model,
    workspaceRoot: resolveWorkspaceRoot(rootDir, fileConfig, env),
    toolTimeoutMs,
    maxToolIterations,
    lsp,
    index,
    embedding,
    agentContext,
    metrics,
    logging,
    onlineTuner,
    memory,
    sources: {
      cwd: rootDir,
      homeDir: sources.homeDir,
      configFile: sources.projectConfig.path || sources.globalConfig.path || null,
      projectConfigFile: sources.projectConfig.path,
      globalConfigFile: sources.globalConfig.path,
      legacyProjectConfigFile: sources.projectConfig.isLegacyPath ? sources.projectConfig.path : null,
      dotEnvFile: sources.dotEnv.path,
      warnings: sources.warnings
    }
  };
}
