import path from "node:path";
import fs from "node:fs/promises";
import { buildCodeIndex, refreshCodeIndex } from "./code-index.js";
import { buildSyntaxIndex, refreshSyntaxIndex } from "./syntax-index.js";
import { buildSemanticGraph, refreshSemanticGraph } from "./semantic-graph.js";

const DEFAULT_WATCH_INTERVAL_MS = 2000;
const DEFAULT_WATCH_MAX_FILES = 20_000;
const DEFAULT_WATCH_MAX_BATCH_SIZE = 300;
const MAX_WATCH_MAX_FILES = 50_000;
const MAX_WATCH_MAX_BATCH_SIZE = 5000;
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
    semantic_include_definitions: parseBoolean(
      args.semantic_include_definitions ?? process.env.CLAWTY_WATCH_SEMANTIC_INCLUDE_DEFINITIONS,
      false
    ),
    semantic_include_references: parseBoolean(
      args.semantic_include_references ?? process.env.CLAWTY_WATCH_SEMANTIC_INCLUDE_REFERENCES,
      false
    ),
    quiet: parseBoolean(args.quiet ?? process.env.CLAWTY_WATCH_QUIET, false)
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

  return {
    ok: true,
    code_index: codeIndex,
    syntax_index: syntaxIndex,
    semantic_graph: semanticGraph
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

  return {
    ok: true,
    skipped: false,
    changed_paths: changedPaths,
    deleted_paths: deletedPaths,
    code_index: codeRefresh,
    syntax_index: syntaxRefresh,
    semantic_graph: semanticRefresh
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

export async function runIndexWatchLoop(workspaceRoot, args = {}) {
  const config = resolveWatchConfig(args);
  const root = path.resolve(workspaceRoot);

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
    formatLoopMessage(`watch started (tracked files: ${previousSnapshot.size})`, config);

    while (!stopState.stopped) {
      await sleep(config.interval_ms);
      if (stopState.stopped) {
        break;
      }

      const currentSnapshot = await collectTrackedFiles(root, config);
      const diff = diffTrackedFiles(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;

      if (diff.changed_paths.length === 0 && diff.deleted_paths.length === 0) {
        continue;
      }

      const cycleStart = Date.now();
      const refreshed = await refreshIndexesForChanges(root, {
        ...config,
        changed_paths: diff.changed_paths,
        deleted_paths: diff.deleted_paths
      });

      if (!refreshed.ok) {
        formatLoopMessage(
          `refresh failed at ${refreshed.stage}: ${refreshed.error || "unknown error"}`,
          config
        );
        continue;
      }

      const cycleMs = Date.now() - cycleStart;
      formatLoopMessage(
        `refreshed changed=${diff.changed_paths.length} deleted=${diff.deleted_paths.length} (${cycleMs}ms)`,
        config
      );
    }

    formatLoopMessage("watch stopped", config);
    return {
      ok: true,
      stopped_by_signal: Boolean(stopState.signal),
      signal: stopState.signal,
      config
    };
  } finally {
    process.off("SIGINT", stopHandler);
    process.off("SIGTERM", stopHandler);
  }
}
