import path from "node:path";
import fs from "node:fs/promises";
import { buildCodeIndex, refreshCodeIndex } from "./code-index.js";
import { buildSyntaxIndex, refreshSyntaxIndex } from "./syntax-index.js";
import { buildSemanticGraph, refreshSemanticGraph } from "./semantic-graph.js";
import { buildVectorIndex, refreshVectorIndex } from "./vector-index.js";
import {
  parsePositiveInt,
  parseString,
  parseWatchCliArgs,
  resolveWatchConfig
} from "./index-watch-config.js";
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

const MTIME_EPSILON_MS = 1;

export {
  createDirtyQueueState,
  enqueueDirtyQueue,
  getDirtyQueueDepth,
  shouldFlushDirtyQueue,
  takeDirtyQueueBatch
} from "./index-watch-queue.js";
export { parseWatchCliArgs, resolveWatchConfig };

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
