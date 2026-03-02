import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildCodeIndex, refreshCodeIndex } from "./code-index.js";
import { buildSyntaxIndex, refreshSyntaxIndex } from "./syntax-index.js";
import { buildSemanticGraph, refreshSemanticGraph } from "./semantic-graph.js";
import { buildVectorIndex, refreshVectorIndex } from "./vector-index.js";

const DEFAULT_WATCH_INTERVAL_MS = 2000;
const DEFAULT_WATCH_MAX_FILES = 20_000;
const DEFAULT_WATCH_MAX_BATCH_SIZE = 300;
const DEFAULT_WATCH_DEBOUNCE_MS = 500;
const DEFAULT_WATCH_HASH_INIT_MAX_FILES = 2000;
const MAX_WATCH_MAX_FILES = 50_000;
const MAX_WATCH_MAX_BATCH_SIZE = 5000;
const MAX_WATCH_HASH_INIT_MAX_FILES = 100_000;
const MTIME_EPSILON_MS = 1;

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
    embedding: args.embedding && typeof args.embedding === "object" ? args.embedding : {}
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
  const config = resolveWatchConfig(args);
  const root = path.resolve(workspaceRoot);
  const snapshot = new Map();
  const queue = [root];

  while (queue.length > 0 && snapshot.size < config.max_files) {
    const currentDir = queue.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = toPosixPath(path.relative(root, fullPath));
      if (!shouldTrackPath(relativePath)) {
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      snapshot.set(relativePath, {
        mtime_ms: Number(stat.mtimeMs || 0),
        size: Number(stat.size || 0)
      });

      if (snapshot.size >= config.max_files) {
        break;
      }
    }
  }

  return snapshot;
}

export function diffTrackedFiles(previousSnapshot, currentSnapshot, args = {}) {
  const epsilonMs = parsePositiveInt(args.mtime_epsilon_ms, MTIME_EPSILON_MS, 0, 1000);
  const previous = previousSnapshot instanceof Map ? previousSnapshot : new Map();
  const current = currentSnapshot instanceof Map ? currentSnapshot : new Map();
  const changed = [];
  const deleted = [];

  for (const [filePath, currentMeta] of current.entries()) {
    const previousMeta = previous.get(filePath);
    if (!previousMeta) {
      changed.push(filePath);
      continue;
    }
    const currentSize = Number(currentMeta?.size || 0);
    const previousSize = Number(previousMeta?.size || 0);
    const currentMtime = Number(currentMeta?.mtime_ms || 0);
    const previousMtime = Number(previousMeta?.mtime_ms || 0);

    if (currentSize !== previousSize || Math.abs(currentMtime - previousMtime) > epsilonMs) {
      changed.push(filePath);
    }
  }

  for (const filePath of previous.keys()) {
    if (!current.has(filePath)) {
      deleted.push(filePath);
    }
  }

  changed.sort();
  deleted.sort();
  return {
    changed_paths: changed,
    deleted_paths: deleted
  };
}

function normalizeWatchPathList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? toPosixPath(item.trim()) : ""))
        .filter((item) => item.length > 0)
    )
  );
}

export function createDirtyQueueState() {
  return {
    changed_paths: new Set(),
    deleted_paths: new Set(),
    first_enqueued_at_ms: 0,
    last_enqueued_at_ms: 0
  };
}

export function getDirtyQueueDepth(queueState) {
  const changedDepth = queueState?.changed_paths instanceof Set ? queueState.changed_paths.size : 0;
  const deletedDepth = queueState?.deleted_paths instanceof Set ? queueState.deleted_paths.size : 0;
  return changedDepth + deletedDepth;
}

function touchQueueTimestamps(queueState, nowMs) {
  const depth = getDirtyQueueDepth(queueState);
  if (depth <= 0) {
    queueState.first_enqueued_at_ms = 0;
    queueState.last_enqueued_at_ms = 0;
    return;
  }
  if (!queueState.first_enqueued_at_ms) {
    queueState.first_enqueued_at_ms = nowMs;
  }
  queueState.last_enqueued_at_ms = nowMs;
}

export function enqueueDirtyQueue(queueState, diff = {}, nowMs = Date.now()) {
  const changedPaths = normalizeWatchPathList(diff.changed_paths);
  const deletedPaths = normalizeWatchPathList(diff.deleted_paths);
  let addedChanged = 0;
  let addedDeleted = 0;

  for (const filePath of changedPaths) {
    queueState.deleted_paths.delete(filePath);
    if (queueState.changed_paths.has(filePath)) {
      continue;
    }
    queueState.changed_paths.add(filePath);
    addedChanged += 1;
  }

  for (const filePath of deletedPaths) {
    queueState.changed_paths.delete(filePath);
    if (queueState.deleted_paths.has(filePath)) {
      continue;
    }
    queueState.deleted_paths.add(filePath);
    addedDeleted += 1;
  }

  const addedTotal = addedChanged + addedDeleted;
  if (addedTotal > 0) {
    touchQueueTimestamps(queueState, nowMs);
  } else {
    touchQueueTimestamps(queueState, queueState.last_enqueued_at_ms || nowMs);
  }
  return {
    added_changed: addedChanged,
    added_deleted: addedDeleted,
    queue_depth: getDirtyQueueDepth(queueState)
  };
}

export function shouldFlushDirtyQueue(
  queueState,
  nowMs,
  debounceMs,
  maxBatchSize,
  force = false
) {
  const depth = getDirtyQueueDepth(queueState);
  if (depth <= 0) {
    return false;
  }
  if (force) {
    return true;
  }
  if (depth >= Math.max(1, Number(maxBatchSize) || 1)) {
    return true;
  }
  if (!queueState.last_enqueued_at_ms) {
    return true;
  }
  return nowMs - queueState.last_enqueued_at_ms >= Math.max(100, Number(debounceMs) || 100);
}

export function takeDirtyQueueBatch(queueState, maxBatchSize, nowMs = Date.now()) {
  const changed = [];
  const deleted = [];
  const depthBefore = getDirtyQueueDepth(queueState);
  const size = Math.max(1, Number(maxBatchSize) || 1);
  const firstQueuedAt = Number(queueState.first_enqueued_at_ms || 0);

  for (const filePath of Array.from(queueState.changed_paths.values()).sort().slice(0, size)) {
    queueState.changed_paths.delete(filePath);
    changed.push(filePath);
  }
  for (const filePath of Array.from(queueState.deleted_paths.values()).sort().slice(0, size)) {
    queueState.deleted_paths.delete(filePath);
    deleted.push(filePath);
  }

  const depthAfter = getDirtyQueueDepth(queueState);
  if (depthAfter <= 0) {
    queueState.first_enqueued_at_ms = 0;
    queueState.last_enqueued_at_ms = 0;
  }
  return {
    changed_paths: changed,
    deleted_paths: deleted,
    batch_size: changed.length + deleted.length,
    queue_depth_before: depthBefore,
    queue_depth_after: depthAfter,
    index_lag_ms: firstQueuedAt ? Math.max(0, nowMs - firstQueuedAt) : 0
  };
}

export async function hashTrackedFile(workspaceRoot, relativePath) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  let content;
  try {
    content = await fs.readFile(absolutePath);
  } catch {
    return null;
  }
  return createHash("sha1").update(content).digest("hex");
}

export async function seedHashCacheFromSnapshot(workspaceRoot, snapshot, hashCache, args = {}) {
  const config = resolveWatchConfig(args);
  if (!config.hash_skip_enabled || !(snapshot instanceof Map) || config.hash_init_max_files <= 0) {
    return {
      hashed_files: 0
    };
  }

  const candidates = Array.from(snapshot.keys()).sort().slice(0, config.hash_init_max_files);
  let hashedFiles = 0;
  for (const relativePath of candidates) {
    const hash = await hashTrackedFile(workspaceRoot, relativePath);
    if (!hash) {
      continue;
    }
    hashCache.set(relativePath, hash);
    hashedFiles += 1;
  }
  return {
    hashed_files: hashedFiles
  };
}

export async function filterChangedPathsByHash(workspaceRoot, changedPaths, hashCache, args = {}) {
  const config = resolveWatchConfig(args);
  const normalizedChanged = normalizeWatchPathList(changedPaths);
  if (!config.hash_skip_enabled) {
    return {
      changed_paths: normalizedChanged,
      skipped_paths: [],
      hashed_paths: 0
    };
  }

  const kept = [];
  const skipped = [];
  let hashedPaths = 0;
  for (const relativePath of normalizedChanged) {
    const nextHash = await hashTrackedFile(workspaceRoot, relativePath);
    if (!nextHash) {
      hashCache.delete(relativePath);
      kept.push(relativePath);
      continue;
    }

    hashedPaths += 1;
    const previousHash = hashCache.get(relativePath);
    hashCache.set(relativePath, nextHash);
    if (previousHash && previousHash === nextHash) {
      skipped.push(relativePath);
      continue;
    }
    kept.push(relativePath);
  }

  return {
    changed_paths: kept,
    skipped_paths: skipped,
    hashed_paths: hashedPaths
  };
}

async function refreshCodeIndexInBatches(workspaceRoot, changedPaths, deletedPaths, maxBatchSize) {
  const changedChunks = chunkArray(changedPaths, maxBatchSize);
  const deletedChunks = chunkArray(deletedPaths, maxBatchSize);
  const chunkCount = Math.max(changedChunks.length, deletedChunks.length, 1);
  const details = [];

  for (let idx = 0; idx < chunkCount; idx += 1) {
    const changedBatch = changedChunks[idx] || [];
    const deletedBatch = deletedChunks[idx] || [];
    if (changedBatch.length === 0 && deletedBatch.length === 0) {
      continue;
    }
    const refreshed = await refreshCodeIndex(workspaceRoot, {
      changed_paths: changedBatch,
      deleted_paths: deletedBatch
    });
    details.push(refreshed);
    if (!refreshed?.ok) {
      return {
        ok: false,
        details
      };
    }
  }

  return {
    ok: true,
    details
  };
}

async function ensureIndexes(workspaceRoot, config) {
  const codeIndex = await buildCodeIndex(workspaceRoot, {});
  if (!codeIndex?.ok) {
    return {
      ok: false,
      stage: "build_code_index",
      result: codeIndex
    };
  }

  let syntaxIndex = null;
  if (config.include_syntax) {
    syntaxIndex = await buildSyntaxIndex(workspaceRoot, {
      parser_provider: "auto"
    });
    if (!syntaxIndex?.ok) {
      return {
        ok: false,
        stage: "build_syntax_index",
        result: syntaxIndex
      };
    }
  }

  let semanticGraph = null;
  if (config.include_semantic) {
    semanticGraph = await buildSemanticGraph(
      workspaceRoot,
      {
        include_syntax: config.include_syntax,
        include_definitions: config.semantic_include_definitions,
        include_references: config.semantic_include_references
      },
      { enabled: false }
    );
    if (!semanticGraph?.ok) {
      return {
        ok: false,
        stage: "build_semantic_graph",
        result: semanticGraph
      };
    }
  }

  let vectorIndex = null;
  if (config.include_vector) {
    vectorIndex = await buildVectorIndex(
      workspaceRoot,
      {
        layer: "base"
      },
      {
        embedding: config.embedding || {}
      }
    );
    if (!vectorIndex?.ok) {
      return {
        ok: false,
        stage: "build_vector_index",
        result: vectorIndex
      };
    }
  }

  return {
    ok: true,
    code_index: codeIndex,
    syntax_index: syntaxIndex,
    semantic_graph: semanticGraph,
    vector_index: vectorIndex
  };
}

export async function refreshIndexesForChanges(workspaceRoot, args = {}) {
  const config = resolveWatchConfig(args);
  const changedPaths = Array.isArray(args.changed_paths)
    ? args.changed_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const deletedPaths = Array.isArray(args.deleted_paths)
    ? args.deleted_paths.filter((item) => typeof item === "string" && item.length > 0)
    : [];

  if (changedPaths.length === 0 && deletedPaths.length === 0) {
    return {
      ok: true,
      skipped: true,
      changed_paths: [],
      deleted_paths: []
    };
  }

  const codeRefresh = await refreshCodeIndexInBatches(
    workspaceRoot,
    changedPaths,
    deletedPaths,
    config.max_batch_size
  );
  if (!codeRefresh.ok) {
    const failed = codeRefresh.details[codeRefresh.details.length - 1] || null;
    return {
      ok: false,
      stage: "refresh_code_index",
      changed_paths: changedPaths,
      deleted_paths: deletedPaths,
      error: failed?.error || "refresh_code_index failed",
      code_index: codeRefresh
    };
  }

  let syntaxRefresh = null;
  if (config.include_syntax) {
    syntaxRefresh = await refreshSyntaxIndex(workspaceRoot, {
      changed_paths: changedPaths,
      deleted_paths: deletedPaths,
      parser_provider: "auto"
    });
    if (!syntaxRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_syntax_index",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: syntaxRefresh?.error || "refresh_syntax_index failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh
      };
    }
  }

  let semanticRefresh = null;
  if (config.include_semantic) {
    semanticRefresh = await refreshSemanticGraph(
      workspaceRoot,
      {
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        include_syntax: config.include_syntax,
        include_definitions: config.semantic_include_definitions,
        include_references: config.semantic_include_references,
        precise_preferred: false
      },
      { enabled: false }
    );
    if (!semanticRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_semantic_graph",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: semanticRefresh?.error || "refresh_semantic_graph failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        semantic_graph: semanticRefresh
      };
    }
  }

  let vectorRefresh = null;
  if (config.include_vector) {
    vectorRefresh = await refreshVectorIndex(
      workspaceRoot,
      {
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        layer: parseString(config.vector_layer, "delta")
      },
      {
        embedding: config.embedding || {}
      }
    );
    if (!vectorRefresh?.ok) {
      return {
        ok: false,
        stage: "refresh_vector_index",
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        error: vectorRefresh?.error || "refresh_vector_index failed",
        code_index: codeRefresh,
        syntax_index: syntaxRefresh,
        semantic_graph: semanticRefresh,
        vector_index: vectorRefresh
      };
    }
  }

  return {
    ok: true,
    skipped: false,
    changed_paths: changedPaths,
    deleted_paths: deletedPaths,
    code_index: codeRefresh,
    syntax_index: syntaxRefresh,
    semantic_graph: semanticRefresh,
    vector_index: vectorRefresh
  };
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
  const force = Boolean(options.force);
  while (
    shouldFlushDirtyQueue(
      queueState,
      Date.now(),
      config.debounce_ms,
      config.max_batch_size,
      force
    )
  ) {
    const batch = takeDirtyQueueBatch(queueState, config.max_batch_size, Date.now());
    if (batch.batch_size <= 0) {
      break;
    }

    metrics.last_batch_size = batch.batch_size;
    metrics.last_index_lag_ms = batch.index_lag_ms;
    metrics.queue_depth = batch.queue_depth_after;
    metrics.max_queue_depth = Math.max(metrics.max_queue_depth, batch.queue_depth_before);

    const refreshStart = Date.now();
    const refreshed = await refreshIndexesForChanges(workspaceRoot, {
      ...config,
      changed_paths: batch.changed_paths,
      deleted_paths: batch.deleted_paths
    });
    const refreshMs = Date.now() - refreshStart;

    if (!refreshed.ok) {
      metrics.failed_flush_count += 1;
      enqueueDirtyQueue(
        queueState,
        {
          changed_paths: batch.changed_paths,
          deleted_paths: batch.deleted_paths
        },
        Date.now()
      );
      metrics.queue_depth = getDirtyQueueDepth(queueState);
      formatLoopMessage(
        [
          `refresh failed at ${refreshed.stage}: ${refreshed.error || "unknown error"}`,
          `queue_depth=${metrics.queue_depth}`,
          `batch_size=${batch.batch_size}`
        ].join(" "),
        config
      );
      break;
    }

    metrics.flush_count += 1;
    metrics.last_flush_duration_ms = refreshMs;
    metrics.refreshed_changed += batch.changed_paths.length;
    metrics.refreshed_deleted += batch.deleted_paths.length;
    metrics.queue_depth = batch.queue_depth_after;

    formatLoopMessage(
      [
        `refreshed changed=${batch.changed_paths.length}`,
        `deleted=${batch.deleted_paths.length}`,
        `queue_depth=${batch.queue_depth_after}`,
        `batch_size=${batch.batch_size}`,
        `index_lag_ms=${batch.index_lag_ms}`,
        `refresh_ms=${refreshMs}`
      ].join(" "),
      config
    );

    if (
      !force &&
      !shouldFlushDirtyQueue(
        queueState,
        Date.now(),
        config.debounce_ms,
        config.max_batch_size,
        false
      )
    ) {
      break;
    }
  }
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
