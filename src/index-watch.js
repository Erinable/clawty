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
import {
  shouldTrackWatchPath,
  toPosixPath,
  WATCH_IGNORED_DIRS
} from "./index-watch-path-policy.js";
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
import { resolveWatchBackpressure, runIndexWatchLoopWithDeps } from "./index-watch-loop.js";
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
export { resolveWatchBackpressure } from "./index-watch-loop.js";
export { parseWatchCliArgs, resolveWatchConfig };

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
  return shouldTrackWatchPath(relativePath);
}

export async function collectTrackedFiles(workspaceRoot, args = {}) {
  return collectTrackedFilesWithDeps(workspaceRoot, args, {
    path,
    fs,
    resolveWatchConfig,
    toPosixPath,
    shouldTrackPath,
    ignoredDirs: WATCH_IGNORED_DIRS
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

async function refreshCodeIndexInBatches(
  workspaceRoot,
  changedPaths,
  deletedPaths,
  maxBatchSize,
  retryOptions = {}
) {
  return refreshCodeIndexInBatchesWithDeps(
    workspaceRoot,
    changedPaths,
    deletedPaths,
    maxBatchSize,
    {
      chunkArray,
      refreshCodeIndex,
      retryOptions
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
  return runIndexWatchLoopWithDeps(workspaceRoot, args, {
    path,
    processRef: process,
    resolveWatchConfig,
    createDirtyQueueState,
    ensureIndexes,
    collectTrackedFiles,
    seedHashCacheFromSnapshot,
    formatLoopMessage,
    sleep,
    diffTrackedFiles,
    filterChangedPathsByHash,
    enqueueDirtyQueue,
    flushDirtyQueue,
    getDirtyQueueDepth,
    appendWatchMetricEvent,
    watchRunMetricsFile: WATCH_RUN_METRICS_FILE
  });
}
