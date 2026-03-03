import path from "node:path";
import fs from "node:fs/promises";
import { buildCodeIndex, refreshCodeIndex } from "./code-index.js";
import { buildSyntaxIndex, refreshSyntaxIndex } from "./syntax-index.js";
import { buildSemanticGraph, refreshSemanticGraph } from "./semantic-graph.js";
import { buildVectorIndex, refreshVectorIndex } from "./vector-index.js";
import { flushDirtyQueueWithDeps } from "./index-watch-flush.js";
import {
  filterChangedPathsByHash as filterChangedPathsByHashWithDeps,
  hashTrackedFile as hashTrackedFileWithDeps,
  seedHashCacheFromSnapshot as seedHashCacheFromSnapshotWithDeps
} from "./index-watch-hash.js";
import {
  appendWatchMetricEvent,
  roundWatchMetric,
  WATCH_FLUSH_METRICS_FILE,
  WATCH_RUN_METRICS_FILE
} from "./index-watch-metrics.js";
import {
  ensureIndexesWithDeps,
  refreshCodeIndexInBatchesWithDeps,
  refreshIndexesForChangesWithDeps
} from "./index-watch-refresh.js";
import {
  collectTrackedFilesWithDeps,
  diffTrackedFilesWithDeps
} from "./index-watch-snapshot.js";
import {
  createDirtyQueueState,
  enqueueDirtyQueue,
  getDirtyQueueDepth,
  shouldFlushDirtyQueue,
  takeDirtyQueueBatch
} from "./index-watch-queue.js";

const DEFAULT_WATCH_INTERVAL_MS = 2000;
const DEFAULT_WATCH_MAX_FILES = 20_000;
const DEFAULT_WATCH_MAX_BATCH_SIZE = 300;
const DEFAULT_WATCH_DEBOUNCE_MS = 500;
const DEFAULT_WATCH_HASH_INIT_MAX_FILES = 2000;
const MAX_WATCH_MAX_FILES = 50_000;
const MAX_WATCH_MAX_BATCH_SIZE = 5000;
const MAX_WATCH_HASH_INIT_MAX_FILES = 100_000;
const MTIME_EPSILON_MS = 1;
const DEFAULT_METRICS_ENABLED = true;
const DEFAULT_METRICS_PERSIST_WATCH = true;

export {
  createDirtyQueueState,
  enqueueDirtyQueue,
  getDirtyQueueDepth,
  shouldFlushDirtyQueue,
  takeDirtyQueueBatch
} from "./index-watch-queue.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".clawty"
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sh",
  ".yml",
  ".yaml",
  ".toml",
  ".ini"
]);

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseBoolean(value, fallback = false) {
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

function parseString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function chunkArray(items, chunkSize) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const size = Math.max(1, chunkSize);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function shouldTrackPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return false;
  }
  const normalized = toPosixPath(relativePath.trim());
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORED_DIRS.has(part))) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
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

export async function collectTrackedFiles(workspaceRoot, args = {}) {
  return collectTrackedFilesWithDeps(workspaceRoot, args, {
    path,
    fs,
    resolveWatchConfig,
    toPosixPath,
    shouldTrackPath,
    ignoredDirs: IGNORED_DIRS
  });
}

export function diffTrackedFiles(previousSnapshot, currentSnapshot, args = {}) {
  return diffTrackedFilesWithDeps(previousSnapshot, currentSnapshot, args, {
    parsePositiveInt,
    mtimeEpsilonMs: MTIME_EPSILON_MS
  });
}

export async function hashTrackedFile(workspaceRoot, relativePath) {
  return hashTrackedFileWithDeps(workspaceRoot, relativePath);
}

export async function seedHashCacheFromSnapshot(workspaceRoot, snapshot, hashCache, args = {}) {
  return seedHashCacheFromSnapshotWithDeps(workspaceRoot, snapshot, hashCache, args, {
    resolveWatchConfig
  });
}

export async function filterChangedPathsByHash(workspaceRoot, changedPaths, hashCache, args = {}) {
  return filterChangedPathsByHashWithDeps(workspaceRoot, changedPaths, hashCache, args, {
    resolveWatchConfig
  });
}

async function refreshCodeIndexInBatches(workspaceRoot, changedPaths, deletedPaths, maxBatchSize) {
  return refreshCodeIndexInBatchesWithDeps(
    workspaceRoot,
    changedPaths,
    deletedPaths,
    maxBatchSize,
    {
      chunkArray,
      refreshCodeIndex
    }
  );
}

async function ensureIndexes(workspaceRoot, config) {
  return ensureIndexesWithDeps(workspaceRoot, config, {
    buildCodeIndex,
    buildSyntaxIndex,
    buildSemanticGraph,
    buildVectorIndex
  });
}

export async function refreshIndexesForChanges(workspaceRoot, args = {}) {
  return refreshIndexesForChangesWithDeps(workspaceRoot, args, {
    resolveWatchConfig,
    parseString,
    refreshCodeIndexInBatches,
    refreshSyntaxIndex,
    refreshSemanticGraph,
    refreshVectorIndex
  });
}

function formatLoopMessage(message, config) {
  if (config.quiet) {
    return;
  }
  const stamp = new Date().toISOString();
  console.log(`[watch-index][${stamp}] ${message}`);
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function flushDirtyQueue(workspaceRoot, config, queueState, metrics, options = {}) {
  return flushDirtyQueueWithDeps(workspaceRoot, config, queueState, metrics, options, {
    shouldFlushDirtyQueue,
    takeDirtyQueueBatch,
    refreshIndexesForChanges,
    enqueueDirtyQueue,
    getDirtyQueueDepth,
    formatLoopMessage,
    appendWatchMetricEvent,
    watchFlushMetricsFile: WATCH_FLUSH_METRICS_FILE,
    roundWatchMetric
  });
}

export async function runIndexWatchLoop(workspaceRoot, args = {}) {
  const config = resolveWatchConfig(args);
  const root = path.resolve(workspaceRoot);
  const queueState = createDirtyQueueState();
  const contentHashCache = new Map();
  const metrics = {
    poll_count: 0,
    enqueue_count: 0,
    flush_count: 0,
    failed_flush_count: 0,
    queue_depth: 0,
    max_queue_depth: 0,
    last_batch_size: 0,
    last_index_lag_ms: 0,
    last_flush_duration_ms: 0,
    dropped_by_hash: 0,
    hashed_paths: 0,
    hash_seeded_files: 0,
    refreshed_changed: 0,
    refreshed_deleted: 0
  };

  const stopState = {
    stopped: false,
    signal: null
  };
  const stopHandler = (signal) => {
    stopState.stopped = true;
    stopState.signal = signal;
  };

  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);
  try {
    if (config.build_on_start) {
      formatLoopMessage("building indexes on start...", config);
      const built = await ensureIndexes(root, config);
      if (!built.ok) {
        return {
          ok: false,
          stage: built.stage,
          error: built.result?.error || `${built.stage} failed`,
          result: built.result || null
        };
      }
      formatLoopMessage("initial build completed", config);
    }

    let previousSnapshot = await collectTrackedFiles(root, config);
    const seededHashes = await seedHashCacheFromSnapshot(root, previousSnapshot, contentHashCache, config);
    metrics.hash_seeded_files = Number(seededHashes.hashed_files || 0);
    formatLoopMessage(`watch started (tracked files: ${previousSnapshot.size})`, config);

    while (!stopState.stopped) {
      await sleep(config.interval_ms);
      if (stopState.stopped) {
        break;
      }

      const currentSnapshot = await collectTrackedFiles(root, config);
      const diff = diffTrackedFiles(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;
      metrics.poll_count += 1;

      if (diff.changed_paths.length === 0 && diff.deleted_paths.length === 0) {
        continue;
      }

      for (const deletedPath of diff.deleted_paths) {
        contentHashCache.delete(deletedPath);
      }

      const changedAfterHash = await filterChangedPathsByHash(
        root,
        diff.changed_paths,
        contentHashCache,
        config
      );
      metrics.hashed_paths += Number(changedAfterHash.hashed_paths || 0);
      metrics.dropped_by_hash += Number(changedAfterHash.skipped_paths?.length || 0);

      const enqueued = enqueueDirtyQueue(
        queueState,
        {
          changed_paths: changedAfterHash.changed_paths,
          deleted_paths: diff.deleted_paths
        },
        Date.now()
      );
      metrics.enqueue_count += Number(enqueued.added_changed || 0) + Number(enqueued.added_deleted || 0);
      metrics.queue_depth = Number(enqueued.queue_depth || 0);
      metrics.max_queue_depth = Math.max(metrics.max_queue_depth, metrics.queue_depth);

      if (metrics.queue_depth <= 0) {
        continue;
      }
      await flushDirtyQueue(root, config, queueState, metrics);
      metrics.queue_depth = getDirtyQueueDepth(queueState);
    }

    if (getDirtyQueueDepth(queueState) > 0) {
      formatLoopMessage(
        `draining pending queue (depth=${getDirtyQueueDepth(queueState)}) before exit`,
        config
      );
      await flushDirtyQueue(root, config, queueState, metrics, { force: true });
      metrics.queue_depth = getDirtyQueueDepth(queueState);
    }

    formatLoopMessage("watch stopped", config);
    await appendWatchMetricEvent(root, config, WATCH_RUN_METRICS_FILE, {
      timestamp: new Date().toISOString(),
      event_type: "watch_run",
      stopped_by_signal: Boolean(stopState.signal),
      signal: stopState.signal || null,
      watch_metrics: {
        poll_count: Number(metrics.poll_count || 0),
        enqueue_count: Number(metrics.enqueue_count || 0),
        flush_count: Number(metrics.flush_count || 0),
        failed_flush_count: Number(metrics.failed_flush_count || 0),
        queue_depth: Number(metrics.queue_depth || 0),
        max_queue_depth: Number(metrics.max_queue_depth || 0),
        last_batch_size: Number(metrics.last_batch_size || 0),
        last_index_lag_ms: Number(metrics.last_index_lag_ms || 0),
        last_flush_duration_ms: Number(metrics.last_flush_duration_ms || 0),
        dropped_by_hash: Number(metrics.dropped_by_hash || 0),
        hashed_paths: Number(metrics.hashed_paths || 0),
        hash_seeded_files: Number(metrics.hash_seeded_files || 0),
        refreshed_changed: Number(metrics.refreshed_changed || 0),
        refreshed_deleted: Number(metrics.refreshed_deleted || 0)
      }
    });
    return {
      ok: true,
      stopped_by_signal: Boolean(stopState.signal),
      signal: stopState.signal,
      config,
      watch_metrics: metrics
    };
  } finally {
    process.off("SIGINT", stopHandler);
    process.off("SIGTERM", stopHandler);
  }
}
