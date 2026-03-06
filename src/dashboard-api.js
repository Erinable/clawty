import path from "node:path";
import fs from "node:fs/promises";
import { getIndexStats } from "./code-index.js";
import { refreshCodeIndex } from "./code-index.js";
import { getSyntaxIndexStats } from "./syntax-index.js";
import { refreshSyntaxIndex } from "./syntax-index.js";
import { getSemanticGraphStats } from "./semantic-graph.js";
import { refreshSemanticGraph } from "./semantic-graph.js";
import { getVectorIndexStats } from "./vector-index.js";
import { getMemoryStats, searchMemory } from "./memory.js";
import { loadConfig, validateProjectConfigData } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  HYBRID_QUERY_EVENT_TYPE,
  HYBRID_QUERY_METRICS_FILE,
  MEMORY_SEARCH_EVENT_TYPE,
  MEMORY_SEARCH_METRICS_FILE,
  METRICS_SUBDIR,
  WATCH_FLUSH_EVENT_TYPE,
  WATCH_FLUSH_METRICS_FILE
} from "./metrics-event-types.js";

const MCP_SERVER_VERSION = "0.1.0";
const SERVER_STARTED_AT_MS = Date.now();
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;
const DEFAULT_TIMELINE_LIMIT = 30;
const MAX_TIMELINE_LIMIT = 120;
const DEFAULT_PROJECT_CONFIG_PATH = [".clawty", "config.json"];
const LEGACY_PROJECT_CONFIG_PATH = ["clawty.config.json"];
const DEFAULT_RUNTIME_LOG_PATH = [".clawty", "logs", "runtime.log"];
const DEFAULT_MCP_LOG_PATH = [".clawty", "logs", "mcp-server.log"];

function safeAsync(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

function redactConfig(config) {
  return redactSensitiveKeys(config);
}

function flattenCodeIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_files: counts.files ?? 0,
    total_chunks: counts.chunks ?? 0,
    total_symbols: counts.symbols ?? 0,
    total_symbol_terms: counts.symbol_terms ?? 0,
    unique_tokens: counts.unique_tokens ?? 0
  };
}

function flattenSyntaxIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_files: counts.files ?? 0,
    total_imports: counts.import_edges ?? 0,
    total_calls: counts.call_edges ?? 0
  };
}

function flattenSemanticGraphStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  return {
    ...raw,
    total_nodes: counts.nodes ?? 0,
    total_edges: counts.edges ?? 0
  };
}

function flattenVectorIndexStats(raw) {
  if (!raw || raw.ok === false) return raw;
  const counts = raw.counts || {};
  const chunks = counts.chunks || {};
  const files = counts.files || {};
  return {
    ...raw,
    total_chunks: chunks.total ?? 0,
    layers: { base: chunks.base ?? 0, delta: chunks.delta ?? 0 },
    total_files_base: files.base ?? 0,
    total_files_delta: files.delta ?? 0
  };
}

async function collectIndexSummary(workspaceRoot) {
  const [code, syntax, semantic, vector] = await Promise.allSettled([
    getIndexStats(workspaceRoot),
    getSyntaxIndexStats(workspaceRoot),
    getSemanticGraphStats(workspaceRoot),
    getVectorIndexStats(workspaceRoot)
  ]);
  const codeVal = code.status === "fulfilled" ? flattenCodeIndexStats(code.value) : null;
  const syntaxVal = syntax.status === "fulfilled" ? flattenSyntaxIndexStats(syntax.value) : null;
  const semanticVal = semantic.status === "fulfilled" ? flattenSemanticGraphStats(semantic.value) : null;
  const vectorVal = vector.status === "fulfilled" ? flattenVectorIndexStats(vector.value) : null;
  return {
    code_files: codeVal?.ok !== false ? (codeVal?.total_files ?? null) : null,
    syntax_files: syntaxVal?.ok !== false ? (syntaxVal?.total_files ?? null) : null,
    semantic_nodes: semanticVal?.ok !== false ? (semanticVal?.total_nodes ?? null) : null,
    vector_chunks: vectorVal?.ok !== false ? (vectorVal?.total_chunks ?? null) : null
  };
}

function flattenMemoryStats(stats) {
  const counts = stats?.counts || {};
  return {
    ok: stats?.ok ?? false,
    db_path: stats?.db_path ?? null,
    scope: stats?.scope ?? null,
    workspace_root: stats?.workspace_root ?? null,
    total_lessons: counts.lessons ?? 0,
    quarantined: counts.quarantined_lessons ?? 0,
    total_episodes: counts.episodes ?? 0,
    total_feedback: counts.feedback ?? 0,
    top_lessons: stats?.top_lessons ?? [],
    top_tags: stats?.top_tags ?? []
  };
}

async function collectMemorySummary(workspaceRoot, options) {
  try {
    const stats = await getMemoryStats(workspaceRoot, options);
    const flat = flattenMemoryStats(stats);
    return {
      ok: true,
      total_lessons: flat.total_lessons
    };
  } catch {
    return { ok: false, total_lessons: 0 };
  }
}

const SENSITIVE_TOP_KEYS = new Set(["apiKey"]);
const SENSITIVE_NESTED_KEYS = new Set(["apiKey"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldTreatKeyAsSensitive(key, depth = 0) {
  return (depth === 0 ? SENSITIVE_TOP_KEYS : SENSITIVE_NESTED_KEYS).has(key);
}

function redactSensitiveString(value) {
  const text = String(value || "");
  return `${text.slice(0, 6)}***`;
}

function hasRedactedPlaceholder(value) {
  return typeof value === "string" && value.includes("***");
}

function redactSensitiveKeys(obj, depth = 0) {
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveKeys(item, depth + 1));
  }
  if (!isPlainObject(obj)) {
    return obj;
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (shouldTreatKeyAsSensitive(key, depth) && typeof value === "string") {
      result[key] = redactSensitiveString(value);
      continue;
    }
    result[key] = isPlainObject(value) || Array.isArray(value)
      ? redactSensitiveKeys(value, depth + 1)
      : value;
  }
  return result;
}

function stripRedactedKeys(obj, depth = 0) {
  if (Array.isArray(obj)) {
    return obj.map((item) => stripRedactedKeys(item, depth + 1));
  }
  if (!isPlainObject(obj)) return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (shouldTreatKeyAsSensitive(key, depth) && hasRedactedPlaceholder(value)) continue;
    result[key] = isPlainObject(value) || Array.isArray(value)
      ? stripRedactedKeys(value, depth + 1)
      : value;
  }
  return result;
}

function restoreRedactedKeys(template, existing, nextValue, depth = 0) {
  if (!isPlainObject(template)) {
    return nextValue;
  }

  const result = isPlainObject(nextValue) ? { ...nextValue } : {};
  for (const [key, value] of Object.entries(template)) {
    if (shouldTreatKeyAsSensitive(key, depth) && hasRedactedPlaceholder(value)) {
      if (typeof existing?.[key] === "string") {
        result[key] = existing[key];
      }
      continue;
    }

    if (isPlainObject(value)) {
      const restoredChild = restoreRedactedKeys(
        value,
        isPlainObject(existing?.[key]) ? existing[key] : undefined,
        isPlainObject(result[key]) ? result[key] : undefined,
        depth + 1
      );
      if (isPlainObject(restoredChild) && Object.keys(restoredChild).length > 0) {
        result[key] = restoredChild;
      }
    }
  }
  return result;
}

async function resolveProjectConfigLocation(workspaceRoot) {
  const candidates = [
    {
      path: path.join(workspaceRoot, ...DEFAULT_PROJECT_CONFIG_PATH),
      isLegacyPath: false
    },
    {
      path: path.join(workspaceRoot, ...LEGACY_PROJECT_CONFIG_PATH),
      isLegacyPath: true
    }
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate.path);
      return {
        ...candidate,
        exists: true
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    path: path.join(workspaceRoot, ...DEFAULT_PROJECT_CONFIG_PATH),
    isLegacyPath: false,
    exists: false
  };
}

async function readProjectConfigFile(workspaceRoot) {
  const configLocation = await resolveProjectConfigLocation(workspaceRoot);
  const configPath = configLocation.path;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return {
      ok: true,
      data: JSON.parse(raw),
      path: configPath,
      is_legacy_path: configLocation.isLegacyPath
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        ok: true,
        data: {},
        path: configPath,
        is_legacy_path: configLocation.isLegacyPath
      };
    }
    return {
      ok: false,
      error: err.message,
      path: configPath,
      is_legacy_path: configLocation.isLegacyPath
    };
  }
}

async function writeProjectConfigFile(workspaceRoot, data, options = {}) {
  const configLocation = options.configPath
    ? {
      path: options.configPath,
      isLegacyPath: Boolean(options.isLegacyPath)
    }
    : await resolveProjectConfigLocation(workspaceRoot);
  const configPath = configLocation.path;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const content = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(configPath, content, "utf8");
  return {
    path: configPath,
    is_legacy_path: configLocation.isLegacyPath
  };
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length === 0) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function parseEventTimestampMs(event) {
  const raw = typeof event?.timestamp === "string" ? event.timestamp : null;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content.trim()) return [];
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines.
    }
  }
  return rows;
}

function inferLogLevel(line) {
  const trimmed = String(line || "").trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed) && typeof parsed.level === "string") {
        return normalizeLogLevel(parsed.level);
      }
    } catch {
      // Fall through to plain-text inference.
    }
  }

  const text = String(line || "").toLowerCase();
  if (/\berror\b|\bfatal\b/.test(text)) return "error";
  if (/\bwarn\b/.test(text)) return "warn";
  if (/\bdebug\b/.test(text)) return "debug";
  if (/\binfo\b/.test(text)) return "info";
  return "unknown";
}

function normalizeLogLevel(level) {
  const normalized = String(level || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "fatal" || normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "info") return "info";
  if (normalized === "debug" || normalized === "trace") return "debug";
  return "unknown";
}

function extractTimestamp(line) {
  const match = String(line || "").match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  return match ? match[0] : null;
}

function resolveWorkspaceRelativePath(workspaceRoot, filePath, fallbackParts) {
  if (typeof filePath === "string" && filePath.trim().length > 0) {
    return path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot, filePath);
  }
  return path.join(workspaceRoot, ...fallbackParts);
}

function summarizeLogLevels(entries) {
  const counts = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    unknown: 0
  };
  for (const entry of entries) {
    const level = counts[entry?.level] !== undefined ? entry.level : "unknown";
    counts[level] += 1;
  }
  return counts;
}

function latestLogTimestamp(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.timestamp) {
      return entries[index].timestamp;
    }
  }
  return null;
}

function normalizeLogSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "mcp" || normalized === "mcp-server") return "mcp";
  return "runtime";
}

function normalizeLogScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "current" || normalized === "session") return "current";
  return "all";
}

function buildLogSources(workspaceRoot, config) {
  return {
    runtime: {
      key: "runtime",
      label: "Runtime log",
      path: resolveWorkspaceRelativePath(workspaceRoot, config?.logging?.path, DEFAULT_RUNTIME_LOG_PATH)
    },
    mcp: {
      key: "mcp",
      label: "MCP server log",
      path: resolveWorkspaceRelativePath(workspaceRoot, config?.mcpServer?.logPath, DEFAULT_MCP_LOG_PATH)
    }
  };
}

async function readDashboardLogs(workspaceRoot, query = {}, options = {}) {
  const requestedLines = clampInteger(query.get("lines"), DEFAULT_LOG_LINES, {
    min: 1,
    max: MAX_LOG_LINES
  });
  const sourceKey = normalizeLogSource(query.get("source"));
  const scope = normalizeLogScope(query.get("scope"));
  const levelFilter = (query.get("level") || "").trim().toLowerCase();
  const keyword = (query.get("q") || "").trim().toLowerCase();
  const sessionStartedAtMs = Number.isFinite(Number(options.sessionStartedAtMs))
    ? Number(options.sessionStartedAtMs)
    : SERVER_STARTED_AT_MS;
  const config = (() => {
    try {
      return options.loadConfig
        ? options.loadConfig({ cwd: workspaceRoot, allowMissingApiKey: true })
        : null;
    } catch {
      return null;
    }
  })();
  const sources = buildLogSources(workspaceRoot, config);
  const selectedSource = sources[sourceKey] || sources.runtime;
  const logPath = selectedSource.path;
  const scopeStartedAt = scope === "current"
    ? new Date(sessionStartedAtMs).toISOString()
    : null;
  const content = await fs.readFile(logPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (content == null) {
    return {
      ok: false,
      error: `Log file not found: ${logPath}`,
      source: selectedSource.key,
      source_label: selectedSource.label,
      scope,
      session_started_at: scopeStartedAt,
      available_sources: Object.values(sources).map((item) => ({
        key: item.key,
        label: item.label,
        path: item.path
      })),
      path: logPath,
      lines_requested: requestedLines,
      lines_returned: 0,
      total_lines: 0,
      truncated: false,
      entries: []
    };
  }

  const allEntries = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
    .map((raw) => {
      const level = inferLogLevel(raw);
      return {
        raw,
        level,
        timestamp: extractTimestamp(raw)
      };
    });

  const scopedEntries = allEntries.filter((entry) => {
    if (scope !== "current") return true;
    const tsMs = parseEventTimestampMs(entry);
    return tsMs !== null && tsMs >= sessionStartedAtMs;
  });

  const filteredEntries = scopedEntries.filter((entry) => {
    const matchesKeyword = !keyword || entry.raw.toLowerCase().includes(keyword);
    const matchesLevel = !levelFilter || entry.level === levelFilter;
    return matchesKeyword && matchesLevel;
  });

  const entries = filteredEntries.slice(-requestedLines);
  return {
    ok: true,
    source: selectedSource.key,
    source_label: selectedSource.label,
    scope,
    session_started_at: scopeStartedAt,
    available_sources: Object.values(sources).map((item) => ({
      key: item.key,
      label: item.label,
      path: item.path
    })),
    path: logPath,
    lines_requested: requestedLines,
    lines_returned: entries.length,
    total_lines: allEntries.length,
    scoped_lines: scopedEntries.length,
    counts_by_level: summarizeLogLevels(entries),
    latest_timestamp: latestLogTimestamp(entries),
    truncated: filteredEntries.length > entries.length,
    entries
  };
}

function buildTimelineSeries(events, mapper, limit) {
  return events
    .map((event) => {
      const tsMs = parseEventTimestampMs(event);
      if (tsMs === null) return null;
      return mapper(event, tsMs);
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-limit);
}

async function readMetricsTimeline(workspaceRoot, query = {}) {
  const limit = clampInteger(query.get("limit"), DEFAULT_TIMELINE_LIMIT, {
    min: 1,
    max: MAX_TIMELINE_LIMIT
  });
  const windowHours = clampInteger(query.get("window_hours"), 24, {
    min: 1,
    max: 24 * 30
  });
  const metricsDir = path.join(workspaceRoot, METRICS_SUBDIR);
  const nowMs = Date.now();
  const windowStartMs = nowMs - windowHours * 60 * 60 * 1000;

  const [hybridRows, watchRows, memoryRows] = await Promise.all([
    readJsonl(path.join(metricsDir, HYBRID_QUERY_METRICS_FILE)),
    readJsonl(path.join(metricsDir, WATCH_FLUSH_METRICS_FILE)),
    readJsonl(path.join(metricsDir, MEMORY_SEARCH_METRICS_FILE))
  ]);

  const inWindow = (event, eventType) =>
    event?.event_type === eventType && (parseEventTimestampMs(event) ?? 0) >= windowStartMs;

  return {
    ok: true,
    limit,
    window_hours: windowHours,
    hybrid: buildTimelineSeries(
      hybridRows.filter((event) => inWindow(event, HYBRID_QUERY_EVENT_TYPE)),
      (event, tsMs) => ({
        timestamp: new Date(tsMs).toISOString(),
        avg_latency_ms: Number.isFinite(Number(event?.query_total_ms)) ? Number(event.query_total_ms) : null,
        p95_latency_ms: Number.isFinite(Number(event?.query_p95_ms))
          ? Number(event.query_p95_ms)
          : Number.isFinite(Number(event?.p95_latency_ms))
            ? Number(event.p95_latency_ms)
            : null,
        success_rate: event?.degradation?.degraded === true ? 0 : 1
      }),
      limit
    ),
    watch_flush: buildTimelineSeries(
      watchRows.filter((event) => inWindow(event, WATCH_FLUSH_EVENT_TYPE)),
      (event, tsMs) => ({
        timestamp: new Date(tsMs).toISOString(),
        latency_ms: Number.isFinite(Number(event?.refresh_ms))
          ? Number(event.refresh_ms)
          : Number.isFinite(Number(event?.index_lag_ms))
            ? Number(event.index_lag_ms)
            : null
      }),
      limit
    ),
    memory: buildTimelineSeries(
      memoryRows.filter((event) => inWindow(event, MEMORY_SEARCH_EVENT_TYPE)),
      (event, tsMs) => ({
        timestamp: new Date(tsMs).toISOString(),
        latency_ms: Number.isFinite(Number(event?.query_total_ms))
          ? Number(event.query_total_ms)
          : null,
        hit: typeof event?.hit === "boolean"
          ? event.hit
          : Number.isFinite(Number(event?.returned_count))
            ? Number(event.returned_count) > 0
            : null
      }),
      limit
    )
  };
}

async function buildMetricsReportWithDefaults(options) {
  const { buildReport } = await import("../scripts/metrics-report.mjs");
  return buildReport(options);
}

async function buildTunerReportWithDefaults(options) {
  const { buildTunerReport } = await import("../scripts/tuner-report.mjs");
  return buildTunerReport(options);
}

export function createDashboardRouter(serverOptions, tools, logger, deps = {}) {
  const workspaceRoot = serverOptions.workspaceRoot || process.cwd();
  const memoryOptions = {
    homeDir: undefined,
    scope: "project+global"
  };
  const dashboardDeps = {
    refreshCodeIndex,
    refreshSyntaxIndex,
    refreshSemanticGraph,
    searchMemory,
    runDoctor,
    loadConfig,
    validateProjectConfigData,
    buildMetricsReport: buildMetricsReportWithDefaults,
    buildTunerReport: buildTunerReportWithDefaults,
    ...deps
  };

  const handlers = {
    overview: safeAsync(async () => {
      const [indexes, memory] = await Promise.all([
        collectIndexSummary(workspaceRoot),
        collectMemorySummary(workspaceRoot, memoryOptions)
      ]);
      return {
        server: {
          version: MCP_SERVER_VERSION,
          started_at: new Date(SERVER_STARTED_AT_MS).toISOString(),
          uptime_ms: Math.max(0, Date.now() - SERVER_STARTED_AT_MS),
          transport: serverOptions.transport,
          host: serverOptions.host,
          port: serverOptions.port,
          workspace_root: workspaceRoot,
          toolsets: Array.from(serverOptions.enabledToolsets || []),
          expose_low_level: serverOptions.exposeLowLevel || false
        },
        indexes,
        memory
      };
    }),

    "index-stats": safeAsync(async () => {
      const [code, syntax, semantic, vector] = await Promise.allSettled([
        getIndexStats(workspaceRoot),
        getSyntaxIndexStats(workspaceRoot),
        getSemanticGraphStats(workspaceRoot),
        getVectorIndexStats(workspaceRoot)
      ]);
      return {
        code: code.status === "fulfilled" ? flattenCodeIndexStats(code.value) : { ok: false, error: code.reason?.message },
        syntax: syntax.status === "fulfilled" ? flattenSyntaxIndexStats(syntax.value) : { ok: false, error: syntax.reason?.message },
        semantic: semantic.status === "fulfilled" ? flattenSemanticGraphStats(semantic.value) : { ok: false, error: semantic.reason?.message },
        vector: vector.status === "fulfilled" ? flattenVectorIndexStats(vector.value) : { ok: false, error: vector.reason?.message }
      };
    }),

    "memory-stats": safeAsync(async () => {
      const raw = await getMemoryStats(workspaceRoot, memoryOptions);
      return flattenMemoryStats(raw);
    }),

    metrics: safeAsync(async (request) => {
      const windowHours = clampInteger(request.searchParams.get("window_hours"), 24, {
        min: 1,
        max: 24 * 30
      });
      const [metrics, tuner] = await Promise.allSettled([
        dashboardDeps.buildMetricsReport({ workspaceRoot, windowHours, format: "json" }),
        dashboardDeps.buildTunerReport({ workspaceRoot, windowHours, format: "json" })
      ]);
      return {
        metrics: metrics.status === "fulfilled" ? metrics.value : null,
        tuner: tuner.status === "fulfilled" ? tuner.value : null
      };
    }),

    "metrics-timeline": safeAsync(async (request) => {
      return readMetricsTimeline(workspaceRoot, request.searchParams);
    }),

    config: safeAsync(async () => {
      const config = dashboardDeps.loadConfig({ cwd: workspaceRoot, allowMissingApiKey: true });
      return redactConfig(config);
    }),

    "config-file": safeAsync(async () => {
      const result = await readProjectConfigFile(workspaceRoot);
      if (!result.ok) return result;
      return {
        ok: true,
        data: redactSensitiveKeys(result.data),
        path: result.path,
        is_legacy_path: result.is_legacy_path
      };
    }),

    tools: safeAsync(async () => {
      return {
        tools: (tools || []).map((t) => ({
          name: t.name,
          description: t.description || "",
          category: categorize(t.name)
        }))
      };
    }),

    logs: safeAsync(async (request) => {
      return readDashboardLogs(workspaceRoot, request.searchParams, {
        loadConfig: dashboardDeps.loadConfig,
        sessionStartedAtMs: SERVER_STARTED_AT_MS
      });
    })
  };

  function categorize(name) {
    if (name.startsWith("search_") || name.startsWith("get_code") || name.startsWith("explain_") || name.startsWith("go_to_") || name.startsWith("find_") || name.startsWith("trace_") || name.startsWith("impact_")) return "analysis";
    if (name.startsWith("monitor_") || name.startsWith("metrics_") || name.startsWith("tuner_")) return "monitoring";
    if (name.startsWith("reindex_")) return "operations";
    if (name.startsWith("lsp_") || name.startsWith("build_") || name.startsWith("refresh_") || name.startsWith("query_")) return "low-level";
    return "general";
  }

  const postHandlers = {
    "config-save": safeAsync(async (body) => {
      if (!body || !isPlainObject(body) || !isPlainObject(body.data)) {
        return { ok: false, error: "Request body must include a 'data' object" };
      }

      const existing = await readProjectConfigFile(workspaceRoot);
      if (!existing.ok) {
        return existing;
      }

      const cleaned = stripRedactedKeys(body.data);
      const restored = restoreRedactedKeys(body.data, existing.data, cleaned);
      dashboardDeps.validateProjectConfigData(restored, {
        cwd: workspaceRoot,
        allowMissingApiKey: true
      });
      const saved = await writeProjectConfigFile(workspaceRoot, restored, {
        configPath: existing.path,
        isLegacyPath: existing.is_legacy_path
      });
      return {
        ok: true,
        path: saved.path,
        is_legacy_path: saved.is_legacy_path
      };
    }),

    "ops/doctor": safeAsync(async () => {
      const config = dashboardDeps.loadConfig({ cwd: workspaceRoot, allowMissingApiKey: true });
      return dashboardDeps.runDoctor(config);
    }),

    "ops/reindex": safeAsync(async () => {
      const startedAt = Date.now();
      const steps = [];
      const runners = [
        ["refresh_code_index", () => dashboardDeps.refreshCodeIndex(workspaceRoot, { force_rebuild: true })],
        ["refresh_syntax_index", () => dashboardDeps.refreshSyntaxIndex(workspaceRoot, {})],
        ["refresh_semantic_graph", () => dashboardDeps.refreshSemanticGraph(workspaceRoot, {})]
      ];

      for (const [name, run] of runners) {
        try {
          const result = await run();
          const ok = result?.ok !== false;
          steps.push({ name, ok, result });
        } catch (error) {
          steps.push({ name, ok: false, error: error?.message || String(error) });
        }
      }

      return {
        ok: steps.every((step) => step.ok),
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        steps
      };
    }),

    "ops/memory-search": safeAsync(async (body) => {
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) {
        return { ok: false, error: "Request body must include a non-empty 'query' string" };
      }
      const topK = clampInteger(body?.top_k, 5, { min: 1, max: 20 });
      return dashboardDeps.searchMemory(workspaceRoot, query, {
        ...memoryOptions,
        topK
      });
    })
  };

  return async function handleDashboardApi(pathname, options = {}) {
    const requestUrl = new URL(pathname, "http://localhost");
    const route = requestUrl.pathname.replace(/^\/api\/dashboard\/?/, "").replace(/\/$/, "") || "overview";
    const method = (options.method || "GET").toUpperCase();
    const request = {
      pathname: requestUrl.pathname,
      route,
      searchParams: requestUrl.searchParams
    };

    if (method === "POST") {
      const postHandler = postHandlers[route];
      if (!postHandler) {
        return {
          statusCode: 404,
          body: { ok: false, error: `Unknown dashboard POST route: ${route}` }
        };
      }
      const result = await postHandler(options.body, request);
      return { statusCode: 200, body: result };
    }

    const handler = handlers[route];
    if (!handler) {
      return {
        statusCode: 404,
        body: { ok: false, error: `Unknown dashboard API route: ${route}` }
      };
    }
    const result = await handler(request);
    return { statusCode: 200, body: result };
  };
}
