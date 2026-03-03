const DEFAULT_WATCH_INTERVAL_MS = 2000;
const DEFAULT_WATCH_MAX_FILES = 20_000;
const DEFAULT_WATCH_MAX_BATCH_SIZE = 300;
const DEFAULT_WATCH_DEBOUNCE_MS = 500;
const DEFAULT_WATCH_BACKPRESSURE_ENABLED = true;
const DEFAULT_WATCH_BACKPRESSURE_THRESHOLD_RATIO = 2;
const DEFAULT_WATCH_BACKPRESSURE_DEBOUNCE_MS = 120;
const DEFAULT_WATCH_DB_RETRY_BUDGET = 2;
const DEFAULT_WATCH_DB_RETRY_BACKOFF_MS = 120;
const DEFAULT_WATCH_DB_RETRY_BACKOFF_MAX_MS = 1200;
const DEFAULT_WATCH_SLOW_FLUSH_WARN_MS = 2500;
const DEFAULT_WATCH_HASH_INIT_MAX_FILES = 2000;
const MAX_WATCH_MAX_FILES = 50_000;
const MAX_WATCH_MAX_BATCH_SIZE = 5000;
const MAX_WATCH_HASH_INIT_MAX_FILES = 100_000;
const MAX_WATCH_BACKPRESSURE_THRESHOLD_RATIO = 20;
const MAX_WATCH_DB_RETRY_BUDGET = 20;
const DEFAULT_METRICS_ENABLED = true;
const DEFAULT_METRICS_PERSIST_WATCH = true;

export function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

export function parseBoolean(value, fallback = false) {
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

export function parseString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function resolveWatchConfig(args = {}) {
  const metricsInput = args.metrics && typeof args.metrics === "object" ? args.metrics : {};
  return {
    interval_ms: parsePositiveInt(
      args.interval_ms ?? process.env.CLAWTY_WATCH_INTERVAL_MS,
      DEFAULT_WATCH_INTERVAL_MS,
      250,
      60_000
    ),
    max_files: parsePositiveInt(
      args.max_files ?? process.env.CLAWTY_WATCH_MAX_FILES,
      DEFAULT_WATCH_MAX_FILES,
      1,
      MAX_WATCH_MAX_FILES
    ),
    max_batch_size: parsePositiveInt(
      args.max_batch_size ?? process.env.CLAWTY_WATCH_MAX_BATCH_SIZE,
      DEFAULT_WATCH_MAX_BATCH_SIZE,
      1,
      MAX_WATCH_MAX_BATCH_SIZE
    ),
    debounce_ms: parsePositiveInt(
      args.debounce_ms ?? process.env.CLAWTY_WATCH_DEBOUNCE_MS,
      DEFAULT_WATCH_DEBOUNCE_MS,
      100,
      10_000
    ),
    backpressure_enabled: parseBoolean(
      args.backpressure_enabled ?? process.env.CLAWTY_WATCH_BACKPRESSURE_ENABLED,
      DEFAULT_WATCH_BACKPRESSURE_ENABLED
    ),
    backpressure_threshold_ratio: parsePositiveInt(
      args.backpressure_threshold_ratio ?? process.env.CLAWTY_WATCH_BACKPRESSURE_THRESHOLD_RATIO,
      DEFAULT_WATCH_BACKPRESSURE_THRESHOLD_RATIO,
      1,
      MAX_WATCH_BACKPRESSURE_THRESHOLD_RATIO
    ),
    backpressure_debounce_ms: parsePositiveInt(
      args.backpressure_debounce_ms ?? process.env.CLAWTY_WATCH_BACKPRESSURE_DEBOUNCE_MS,
      DEFAULT_WATCH_BACKPRESSURE_DEBOUNCE_MS,
      50,
      10_000
    ),
    db_retry_budget: parsePositiveInt(
      args.db_retry_budget ?? process.env.CLAWTY_WATCH_DB_RETRY_BUDGET,
      DEFAULT_WATCH_DB_RETRY_BUDGET,
      0,
      MAX_WATCH_DB_RETRY_BUDGET
    ),
    db_retry_backoff_ms: parsePositiveInt(
      args.db_retry_backoff_ms ?? process.env.CLAWTY_WATCH_DB_RETRY_BACKOFF_MS,
      DEFAULT_WATCH_DB_RETRY_BACKOFF_MS,
      10,
      30_000
    ),
    db_retry_backoff_max_ms: parsePositiveInt(
      args.db_retry_backoff_max_ms ?? process.env.CLAWTY_WATCH_DB_RETRY_BACKOFF_MAX_MS,
      DEFAULT_WATCH_DB_RETRY_BACKOFF_MAX_MS,
      10,
      60_000
    ),
    slow_flush_warn_ms: parsePositiveInt(
      args.slow_flush_warn_ms ?? process.env.CLAWTY_WATCH_SLOW_FLUSH_WARN_MS,
      DEFAULT_WATCH_SLOW_FLUSH_WARN_MS,
      100,
      120_000
    ),
    hash_skip_enabled: parseBoolean(
      args.hash_skip_enabled ?? process.env.CLAWTY_WATCH_HASH_SKIP_ENABLED,
      true
    ),
    hash_init_max_files: parsePositiveInt(
      args.hash_init_max_files ?? process.env.CLAWTY_WATCH_HASH_INIT_MAX_FILES,
      DEFAULT_WATCH_HASH_INIT_MAX_FILES,
      0,
      MAX_WATCH_HASH_INIT_MAX_FILES
    ),
    build_on_start: parseBoolean(
      args.build_on_start ?? process.env.CLAWTY_WATCH_BUILD_ON_START,
      true
    ),
    include_syntax: parseBoolean(
      args.include_syntax ?? process.env.CLAWTY_WATCH_INCLUDE_SYNTAX,
      true
    ),
    include_semantic: parseBoolean(
      args.include_semantic ?? process.env.CLAWTY_WATCH_INCLUDE_SEMANTIC,
      true
    ),
    include_vector: parseBoolean(
      args.include_vector ?? process.env.CLAWTY_WATCH_INCLUDE_VECTOR,
      false
    ),
    vector_layer: parseString(args.vector_layer ?? process.env.CLAWTY_WATCH_VECTOR_LAYER, "delta"),
    semantic_include_definitions: parseBoolean(
      args.semantic_include_definitions ?? process.env.CLAWTY_WATCH_SEMANTIC_INCLUDE_DEFINITIONS,
      false
    ),
    semantic_include_references: parseBoolean(
      args.semantic_include_references ?? process.env.CLAWTY_WATCH_SEMANTIC_INCLUDE_REFERENCES,
      false
    ),
    quiet: parseBoolean(args.quiet ?? process.env.CLAWTY_WATCH_QUIET, false),
    embedding: args.embedding && typeof args.embedding === "object" ? args.embedding : {},
    metrics: {
      enabled: parseBoolean(
        metricsInput.enabled ?? process.env.CLAWTY_METRICS_ENABLED,
        DEFAULT_METRICS_ENABLED
      ),
      persist_watch: parseBoolean(
        metricsInput.persistWatch ?? process.env.CLAWTY_METRICS_PERSIST_WATCH,
        DEFAULT_METRICS_PERSIST_WATCH
      )
    }
  };
}

function parseFlagValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.trim().toLowerCase())) {
    return value.trim();
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  return value;
}

export function parseWatchCliArgs(argv = []) {
  const parsed = {};
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--quiet") {
      parsed.quiet = true;
      continue;
    }
    if (arg === "--no-build-on-start") {
      parsed.build_on_start = false;
      continue;
    }
    if (arg === "--no-syntax") {
      parsed.include_syntax = false;
      continue;
    }
    if (arg === "--no-semantic") {
      parsed.include_semantic = false;
      continue;
    }
    if (arg === "--no-vector") {
      parsed.include_vector = false;
      continue;
    }
    if (arg === "--no-hash-skip") {
      parsed.hash_skip_enabled = false;
      continue;
    }
    if (arg === "--no-backpressure") {
      parsed.backpressure_enabled = false;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const [rawKey, rawValue] = arg.slice(2).split("=", 2);
      if (!rawKey) {
        continue;
      }
      const key = rawKey.replace(/-/g, "_");
      parsed[key] = parseFlagValue(rawValue);
      continue;
    }
    if (arg.startsWith("--") && typeof argv[idx + 1] === "string") {
      const key = arg.slice(2).replace(/-/g, "_");
      parsed[key] = parseFlagValue(argv[idx + 1]);
      idx += 1;
      continue;
    }
    throw new Error(`Unknown watch-index argument: ${arg}`);
  }

  return {
    ...resolveWatchConfig(parsed),
    help: Boolean(parsed.help)
  };
}
