import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_SEARCH_EVENT_TYPE,
  MEMORY_SEARCH_METRICS_FILE,
  METRICS_SUBDIR
} from "./metrics-event-types.js";
import { pickTraceFields } from "./trace-context.js";

const DEFAULT_DB_BASENAME = "memory.db";
const DEFAULT_SCOPE = "project+global";
const ALLOWED_SCOPE = new Set(["project", "global", "project+global"]);
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 50;
const DEFAULT_MAX_CHARS = 2400;
const MAX_QUERY_TOKENS = 12;
const DEFAULT_MIN_LESSON_CHARS = 80;
const DEFAULT_QUARANTINE_THRESHOLD = 3;
const DEFAULT_MEMORY_METRICS_QUERY_PREVIEW_CHARS = 120;
const DEFAULT_MEMORY_RANKING = Object.freeze({
  bm25Weight: 0.34,
  recencyWeight: 0.16,
  confidenceWeight: 0.12,
  successRateWeight: 0.12,
  qualityWeight: 0.14,
  feedbackWeight: 0.12,
  projectBoost: 1,
  globalBoost: 0.35,
  negativePenaltyPerDownvote: 0.06,
  negativePenaltyCap: 0.3,
  recentNegativePenalty: 0.18,
  recentNegativeRecencyThreshold: 0.55
});
const ALLOWED_FEEDBACK_REASONS = new Set(["wrong", "stale", "unsafe", "irrelevant", "good"]);

function isFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
}

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

function toPosixPath(inputPath) {
  return String(inputPath || "").split(path.sep).join("/");
}

function normalizeWorkspaceRoot(workspaceRoot) {
  return path.resolve(workspaceRoot || process.cwd());
}

function resolveHomeDir(options = {}) {
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  if (typeof options.homeDir === "string" && options.homeDir.trim().length > 0) {
    return path.resolve(options.homeDir);
  }
  const envHome =
    (typeof env.HOME === "string" && env.HOME.trim()) ||
    (typeof env.USERPROFILE === "string" && env.USERPROFILE.trim()) ||
    "";
  if (envHome) {
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir());
}

export function resolveMemoryDbPath(options = {}) {
  if (typeof options.dbPath === "string" && options.dbPath.trim().length > 0) {
    return path.resolve(options.dbPath.trim());
  }
  const homeDir = resolveHomeDir(options);
  return path.join(homeDir, ".clawty", DEFAULT_DB_BASENAME);
}

function hashWorkspaceRoot(workspaceRoot) {
  const normalized = normalizeWorkspaceRoot(workspaceRoot);
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

function normalizeScope(scope) {
  if (typeof scope !== "string") {
    return DEFAULT_SCOPE;
  }
  const normalized = scope.trim().toLowerCase();
  if (ALLOWED_SCOPE.has(normalized)) {
    return normalized;
  }
  return DEFAULT_SCOPE;
}

function resolveScopeFlags(scope) {
  const normalized = normalizeScope(scope);
  return {
    scope: normalized,
    includeProject: normalized === "project" || normalized === "project+global",
    includeGlobal: normalized === "global" || normalized === "project+global"
  };
}

function tokenizeQuery(query) {
  const text = typeof query === "string" ? query : "";
  const tokens = [];
  for (const match of text.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const token = String(match[0] || "").toLowerCase();
    if (!token || token.length < 2) {
      continue;
    }
    if (!tokens.includes(token)) {
      tokens.push(token);
    }
    if (tokens.length >= MAX_QUERY_TOKENS) {
      break;
    }
  }
  return tokens;
}

function buildFtsQuery(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return "";
  }
  return tokens
    .map((token) => String(token || "").replaceAll('"', '""'))
    .filter(Boolean)
    .map((token) => `"${token}"*`)
    .join(" OR ");
}

function scoreFromBm25(rawScore) {
  const score = Number(rawScore);
  if (!Number.isFinite(score)) {
    return 0;
  }
  if (score <= 0) {
    return 1 + Math.abs(score);
  }
  return 1 / (1 + score);
}

function recencyScore(updatedAt) {
  const ms = Date.parse(String(updatedAt || ""));
  if (!Number.isFinite(ms)) {
    return 0;
  }
  const ageHours = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60));
  if (ageHours <= 1) {
    return 1;
  }
  if (ageHours <= 24) {
    return 0.8;
  }
  if (ageHours <= 24 * 7) {
    return 0.55;
  }
  if (ageHours <= 24 * 30) {
    return 0.3;
  }
  return 0.1;
}

function normalizeWeightMap(rawWeights, fallbackWeights) {
  const fallback = {
    bm25: Number(fallbackWeights.bm25Weight || 0),
    recency: Number(fallbackWeights.recencyWeight || 0),
    confidence: Number(fallbackWeights.confidenceWeight || 0),
    success_rate: Number(fallbackWeights.successRateWeight || 0),
    quality: Number(fallbackWeights.qualityWeight || 0),
    feedback: Number(fallbackWeights.feedbackWeight || 0)
  };
  const source = {
    bm25: Number(rawWeights.bm25 || 0),
    recency: Number(rawWeights.recency || 0),
    confidence: Number(rawWeights.confidence || 0),
    success_rate: Number(rawWeights.success_rate || 0),
    quality: Number(rawWeights.quality || 0),
    feedback: Number(rawWeights.feedback || 0)
  };

  let sum = 0;
  for (const key of Object.keys(source)) {
    const value = Number(source[key] || 0);
    if (!Number.isFinite(value) || value <= 0) {
      source[key] = 0;
      continue;
    }
    source[key] = value;
    sum += value;
  }

  if (sum <= 0) {
    return fallback;
  }

  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    normalized[key] = Number((value / sum).toFixed(6));
  }
  return normalized;
}

function resolveMemoryRanking(options = {}) {
  const input = isPlainObject(options.ranking) ? options.ranking : {};
  const weights = normalizeWeightMap(
    {
      bm25: clampFloat(
        input.bm25Weight,
        DEFAULT_MEMORY_RANKING.bm25Weight,
        0,
        4
      ),
      recency: clampFloat(
        input.recencyWeight,
        DEFAULT_MEMORY_RANKING.recencyWeight,
        0,
        4
      ),
      confidence: clampFloat(
        input.confidenceWeight,
        DEFAULT_MEMORY_RANKING.confidenceWeight,
        0,
        4
      ),
      success_rate: clampFloat(
        input.successRateWeight,
        DEFAULT_MEMORY_RANKING.successRateWeight,
        0,
        4
      ),
      quality: clampFloat(
        input.qualityWeight,
        DEFAULT_MEMORY_RANKING.qualityWeight,
        0,
        4
      ),
      feedback: clampFloat(
        input.feedbackWeight,
        DEFAULT_MEMORY_RANKING.feedbackWeight,
        0,
        4
      )
    },
    DEFAULT_MEMORY_RANKING
  );

  return {
    weights,
    workspace_boost: {
      project: clampFloat(input.projectBoost, DEFAULT_MEMORY_RANKING.projectBoost, 0.1, 4),
      global: clampFloat(input.globalBoost, DEFAULT_MEMORY_RANKING.globalBoost, 0, 4)
    },
    penalties: {
      per_downvote: clampFloat(
        input.negativePenaltyPerDownvote,
        DEFAULT_MEMORY_RANKING.negativePenaltyPerDownvote,
        0,
        2
      ),
      cap: clampFloat(
        input.negativePenaltyCap,
        DEFAULT_MEMORY_RANKING.negativePenaltyCap,
        0,
        2
      ),
      recent: clampFloat(
        input.recentNegativePenalty,
        DEFAULT_MEMORY_RANKING.recentNegativePenalty,
        0,
        2
      ),
      recent_recency_threshold: clampFloat(
        input.recentNegativeRecencyThreshold,
        DEFAULT_MEMORY_RANKING.recentNegativeRecencyThreshold,
        0,
        1
      )
    }
  };
}

function resolveMemoryMetricsConfig(options = {}) {
  const metricsInput = isPlainObject(options.metrics) ? options.metrics : {};
  const env = options.env && typeof options.env === "object" ? options.env : process.env;

  return {
    enabled: parseBoolean(metricsInput.enabled ?? env.CLAWTY_METRICS_ENABLED, true),
    persist_memory: parseBoolean(
      metricsInput.persistMemory ??
        metricsInput.persist_memory ??
        env.CLAWTY_METRICS_PERSIST_MEMORY,
      true
    ),
    query_preview_chars: clampInt(
      metricsInput.queryPreviewChars ??
        metricsInput.query_preview_chars ??
        env.CLAWTY_METRICS_QUERY_PREVIEW_CHARS,
      DEFAULT_MEMORY_METRICS_QUERY_PREVIEW_CHARS,
      32,
      1000
    )
  };
}

function buildQueryPreview(query, maxChars) {
  const text = typeof query === "string" ? query.trim() : "";
  if (!text) {
    return "";
  }
  const limit = clampInt(maxChars, DEFAULT_MEMORY_METRICS_QUERY_PREVIEW_CHARS, 32, 1000);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 16))}...[truncated]`;
}

async function appendMemoryMetricEvent(workspaceRoot, event, options = {}) {
  const metricsConfig = resolveMemoryMetricsConfig(options);
  if (!metricsConfig.enabled || !metricsConfig.persist_memory) {
    return {
      logged: false,
      reason: "metrics_disabled"
    };
  }

  try {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    const metricsDir = path.join(root, METRICS_SUBDIR);
    await fs.mkdir(metricsDir, { recursive: true });
    const outputPath = path.join(metricsDir, MEMORY_SEARCH_METRICS_FILE);
    const traceFields = pickTraceFields(options.trace || {});
    const payload = {
      timestamp: new Date().toISOString(),
      event_type: MEMORY_SEARCH_EVENT_TYPE,
      ...traceFields,
      ...event
    };
    await fs.appendFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
    return {
      logged: true,
      reason: null
    };
  } catch (error) {
    return {
      logged: false,
      reason: "metrics_write_failed",
      error: error.message || String(error)
    };
  }
}

function clipText(input, maxChars) {
  const text = typeof input === "string" ? input.trim() : "";
  const limit = clampInt(maxChars, DEFAULT_MAX_CHARS, 200, 50_000);
  if (text.length <= limit) {
    return text;
  }
  const keep = Math.max(0, limit - 32);
  return `${text.slice(0, keep)} ...[truncated]`;
}

function normalizeFeedbackReason(reason) {
  if (typeof reason !== "string") {
    return null;
  }
  const normalized = reason.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return ALLOWED_FEEDBACK_REASONS.has(normalized) ? normalized : null;
}

function estimateLessonQuality(lessonText, queryText = "", refs = []) {
  const lesson = String(lessonText || "").trim();
  const query = String(queryText || "").trim();
  if (!lesson) {
    return 0;
  }

  let score = 0.25;
  if (lesson.length >= 80) {
    score += 0.25;
  }
  if (query.length >= 8) {
    score += 0.15;
  }
  if (Array.isArray(refs) && refs.length > 0) {
    score += 0.1;
  }
  if (/\b(fix|update|retry|patch|refactor|handle|run|test|build|validate|guard|avoid|use)\b/i.test(lesson)) {
    score += 0.15;
  }
  if (/\b(success|failed|resolved|works|error|warning|pass|improved|result)\b/i.test(lesson)) {
    score += 0.1;
  }

  return clampFloat(score, 0.5, 0, 1);
}

function mergeTags(existingTags, incomingTags) {
  const dedup = new Set([...parseTags(existingTags), ...parseTags(incomingTags)]);
  return Array.from(dedup).slice(0, 12);
}

function mergeLessonText(existingText, incomingText) {
  const base = String(existingText || "").trim();
  const incoming = String(incomingText || "").trim();
  if (!base) {
    return clipText(incoming, 8_000);
  }
  if (!incoming || incoming === base) {
    return clipText(base, 8_000);
  }
  if (base.includes(incoming)) {
    return clipText(base, 8_000);
  }
  if (incoming.includes(base)) {
    return clipText(incoming, 8_000);
  }
  return clipText(`${base}\n\nUpdate:\n${incoming}`, 8_000);
}

async function ensureMemoryDir(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_root TEXT NOT NULL,
      workspace_hash TEXT NOT NULL,
      session_id TEXT,
      turn_no INTEGER,
      user_query TEXT NOT NULL,
      assistant_summary TEXT,
      outcome TEXT NOT NULL,
      tool_calls_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_episodes_workspace_hash ON memory_episodes(workspace_hash);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_created_at ON memory_episodes(created_at);

    CREATE TABLE IF NOT EXISTS memory_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_root TEXT NOT NULL,
      workspace_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      lesson TEXT NOT NULL,
      tags TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      success_rate REAL NOT NULL DEFAULT 0.5,
      quality_score REAL NOT NULL DEFAULT 0.5,
      use_count INTEGER NOT NULL DEFAULT 0,
      quarantined INTEGER NOT NULL DEFAULT 0,
      last_negative_feedback_at TEXT,
      merged_from_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_lessons_workspace_hash ON memory_lessons(workspace_hash);
    CREATE INDEX IF NOT EXISTS idx_memory_lessons_updated_at ON memory_lessons(updated_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_lessons_fts USING fts5(
      lesson_id UNINDEXED,
      title,
      lesson,
      tags,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS memory_refs (
      lesson_id INTEGER NOT NULL,
      file_path TEXT,
      symbol_name TEXT,
      symbol_lc TEXT,
      line_start INTEGER,
      line_end INTEGER,
      ref_weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (lesson_id, file_path, symbol_lc, line_start),
      FOREIGN KEY(lesson_id) REFERENCES memory_lessons(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_refs_file_path ON memory_refs(file_path);
    CREATE INDEX IF NOT EXISTS idx_memory_refs_symbol_lc ON memory_refs(symbol_lc);

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER NOT NULL,
      vote INTEGER NOT NULL,
      note TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(lesson_id) REFERENCES memory_lessons(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_feedback_lesson_id ON memory_feedback(lesson_id);
    CREATE INDEX IF NOT EXISTS idx_memory_feedback_created_at ON memory_feedback(created_at);
  `);

  // Schema migration for existing databases.
  const alterStatements = [
    "ALTER TABLE memory_lessons ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.5;",
    "ALTER TABLE memory_lessons ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE memory_lessons ADD COLUMN last_negative_feedback_at TEXT;",
    "ALTER TABLE memory_lessons ADD COLUMN merged_from_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE memory_feedback ADD COLUMN reason TEXT;"
  ];
  for (const sql of alterStatements) {
    try {
      db.exec(sql);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("duplicate column name")) {
        continue;
      }
      throw error;
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_lessons_quarantined ON memory_lessons(quarantined);");

  db
    .prepare(
      `
      INSERT INTO memory_meta(key, value)
      VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
    )
    .run("schema_version", "2");

  return db;
}

function parseRefs(refs, workspaceRoot) {
  if (!Array.isArray(refs)) {
    return [];
  }

  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const dedup = new Set();
  const result = [];
  for (const item of refs) {
    if (!item || typeof item !== "object") {
      continue;
    }

    let filePath = typeof item.file_path === "string" ? item.file_path.trim() : "";
    if (!filePath && typeof item.path === "string") {
      filePath = item.path.trim();
    }
    if (filePath) {
      const resolved = path.resolve(normalizedRoot, filePath);
      if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
        continue;
      }
      filePath = toPosixPath(path.relative(normalizedRoot, resolved));
    } else {
      filePath = null;
    }

    const symbolName = typeof item.symbol_name === "string" ? item.symbol_name.trim() : "";
    const symbolLc = symbolName ? symbolName.toLowerCase() : null;
    const lineStart = isFiniteNumber(item.line_start) ? Math.max(1, Math.floor(Number(item.line_start))) : null;
    const lineEnd = isFiniteNumber(item.line_end)
      ? Math.max(lineStart || 1, Math.floor(Number(item.line_end)))
      : null;
    const refWeight = clampFloat(item.ref_weight, 1, 0, 3);

    const dedupKey = `${filePath || ""}::${symbolLc || ""}::${lineStart || 0}`;
    if (dedup.has(dedupKey)) {
      continue;
    }
    dedup.add(dedupKey);

    result.push({
      file_path: filePath,
      symbol_name: symbolName || null,
      symbol_lc: symbolLc,
      line_start: lineStart,
      line_end: lineEnd,
      ref_weight: refWeight
    });
  }

  return result;
}

function parseTags(tags) {
  const normalize = (input) =>
    input
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);

  if (Array.isArray(tags)) {
    return normalize(tags);
  }

  if (typeof tags === "string") {
    const raw = tags.trim();
    if (!raw) {
      return [];
    }

    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return normalize(parsed);
        }
      } catch {
        // Fall back to delimiter split for backward compatibility.
      }
    }

    return normalize(raw.split(/[\s,;|]+/));
  }

  return [];
}

function parseToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls
    .slice(0, 200)
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      return {
        name: String(item.name || ""),
        ok: item.ok !== false,
        error: item.error ? String(item.error) : null
      };
    })
    .filter(Boolean);
}

function buildScopeWhereClause(flags) {
  if (flags.includeProject && flags.includeGlobal) {
    return "1 = 1";
  }
  if (flags.includeProject) {
    return "workspace_hash = ?";
  }
  return "workspace_hash <> ?";
}

function buildScopeArgs(flags, workspaceHash) {
  if (flags.includeProject && flags.includeGlobal) {
    return [];
  }
  if (flags.includeProject) {
    return [workspaceHash];
  }
  return [workspaceHash];
}

function collectRefsByLesson(db, lessonIds) {
  if (!Array.isArray(lessonIds) || lessonIds.length === 0) {
    return new Map();
  }
  const placeholders = lessonIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT lesson_id, file_path, symbol_name, line_start, line_end, ref_weight
      FROM memory_refs
      WHERE lesson_id IN (${placeholders})
      ORDER BY ref_weight DESC, file_path ASC
    `
    )
    .all(...lessonIds);

  const result = new Map();
  for (const row of rows) {
    const lessonId = Number(row.lesson_id || 0);
    if (lessonId <= 0) {
      continue;
    }
    if (!result.has(lessonId)) {
      result.set(lessonId, []);
    }
    result.get(lessonId).push({
      file_path: row.file_path || null,
      symbol_name: row.symbol_name || null,
      line_start: isFiniteNumber(row.line_start) ? Number(row.line_start) : null,
      line_end: isFiniteNumber(row.line_end) ? Number(row.line_end) : null,
      ref_weight: clampFloat(row.ref_weight, 1, 0, 3)
    });
  }
  return result;
}

async function withDb(options, callback) {
  const dbPath = resolveMemoryDbPath(options);
  await ensureMemoryDir(dbPath);
  const db = openDb(dbPath);
  try {
    return await callback(db, dbPath);
  } finally {
    db.close();
  }
}

export async function recordEpisode(workspaceRoot, payload = {}, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);

  return withDb(options, async (db, dbPath) => {
    const createdAt = typeof payload.created_at === "string" ? payload.created_at : new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO memory_episodes(
        workspace_root,
        workspace_hash,
        session_id,
        turn_no,
        user_query,
        assistant_summary,
        outcome,
        tool_calls_json,
        created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      normalizedRoot,
      workspaceHash,
      typeof payload.session_id === "string" ? payload.session_id : null,
      isFiniteNumber(payload.turn_no) ? Math.max(1, Math.floor(Number(payload.turn_no))) : null,
      clipText(payload.user_query, 12_000),
      clipText(payload.assistant_summary, 12_000),
      String(payload.outcome || "partial"),
      JSON.stringify(parseToolCalls(payload.tool_calls)),
      createdAt
    );

    return {
      ok: true,
      id: Number(result.lastInsertRowid || 0),
      db_path: dbPath,
      workspace_hash: workspaceHash
    };
  });
}

export async function recordLesson(workspaceRoot, payload = {}, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);

  return withDb(options, async (db, dbPath) => {
    const createdAt = typeof payload.created_at === "string" ? payload.created_at : new Date().toISOString();
    const updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : createdAt;
    const title = clipText(payload.title || "Untitled lesson", 200) || "Untitled lesson";
    const lesson = clipText(payload.lesson || "", 8_000);
    if (!lesson) {
      return {
        ok: false,
        error: "lesson content is empty"
      };
    }

    const tags = parseTags(payload.tags);
    const refs = parseRefs(payload.refs, normalizedRoot);
    const dedupeEnabled = options.dedupeEnabled !== false && payload.disable_dedupe !== true;
    const incomingQuality = estimateLessonQuality(lesson, payload.source_query || payload.user_query || "", refs);

    db.exec("BEGIN IMMEDIATE;");
    try {
      let lessonId = 0;
      let merged = false;
      let mergedFromCount = 0;

      if (dedupeEnabled) {
        const existing = db
          .prepare(
            `
            SELECT
              id,
              lesson,
              tags,
              confidence,
              success_rate,
              quality_score,
              merged_from_count
            FROM memory_lessons
            WHERE workspace_hash = ?
              AND LOWER(title) = LOWER(?)
              AND COALESCE(quarantined, 0) = 0
            ORDER BY updated_at DESC
            LIMIT 1
          `
          )
          .get(workspaceHash, title);

        if (existing) {
          lessonId = Number(existing.id || 0);
          merged = true;
          mergedFromCount = Number(existing.merged_from_count || 0) + 1;
          const nextTags = mergeTags(existing.tags, tags);
          const nextLesson = mergeLessonText(existing.lesson, lesson);
          const nextConfidence = clampFloat(
            Math.max(Number(existing.confidence || 0), clampFloat(payload.confidence, 0.6, 0, 1)),
            0.6,
            0,
            1
          );
          const nextSuccessRate = clampFloat(
            Math.max(Number(existing.success_rate || 0), clampFloat(payload.success_rate, 0.7, 0, 1)),
            0.7,
            0,
            1
          );
          const nextQuality = clampFloat(
            Math.max(Number(existing.quality_score || 0), incomingQuality),
            0.5,
            0,
            1
          );

          db.prepare(`
            UPDATE memory_lessons
            SET
              lesson = ?,
              tags = ?,
              confidence = ?,
              success_rate = ?,
              quality_score = ?,
              merged_from_count = ?,
              updated_at = ?
            WHERE id = ?
          `).run(
            nextLesson,
            JSON.stringify(nextTags),
            nextConfidence,
            nextSuccessRate,
            nextQuality,
            mergedFromCount,
            updatedAt,
            lessonId
          );

          db.prepare("DELETE FROM memory_lessons_fts WHERE lesson_id = ?").run(lessonId);
          db.prepare(`
            INSERT INTO memory_lessons_fts(lesson_id, title, lesson, tags)
            VALUES(?, ?, ?, ?)
          `).run(lessonId, title, nextLesson, nextTags.join(" "));
        }
      }

      if (lessonId <= 0) {
        const insertLesson = db.prepare(`
          INSERT INTO memory_lessons(
            workspace_root,
            workspace_hash,
            title,
            lesson,
            tags,
            confidence,
            success_rate,
            quality_score,
            use_count,
            quarantined,
            last_negative_feedback_at,
            merged_from_count,
            created_at,
            updated_at
          )
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertResult = insertLesson.run(
          normalizedRoot,
          workspaceHash,
          title,
          lesson,
          JSON.stringify(tags),
          clampFloat(payload.confidence, 0.6, 0, 1),
          clampFloat(payload.success_rate, 0.7, 0, 1),
          incomingQuality,
          clampInt(payload.use_count, 0, 0, 1_000_000),
          0,
          null,
          0,
          createdAt,
          updatedAt
        );

        lessonId = Number(insertResult.lastInsertRowid || 0);
        db.prepare(`
          INSERT INTO memory_lessons_fts(lesson_id, title, lesson, tags)
          VALUES(?, ?, ?, ?)
        `).run(lessonId, title, lesson, tags.join(" "));
      }

      const insertRef = db.prepare(`
        INSERT OR IGNORE INTO memory_refs(
          lesson_id,
          file_path,
          symbol_name,
          symbol_lc,
          line_start,
          line_end,
          ref_weight
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ref of refs) {
        insertRef.run(
          lessonId,
          ref.file_path,
          ref.symbol_name,
          ref.symbol_lc,
          ref.line_start,
          ref.line_end,
          ref.ref_weight
        );
      }

      db.exec("COMMIT;");
      return {
        ok: true,
        id: lessonId,
        merged,
        merged_from_count: mergedFromCount,
        quality_score: Number(incomingQuality.toFixed(4)),
        refs_inserted: refs.length,
        db_path: dbPath,
        workspace_hash: workspaceHash
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });
}

export async function loadMemoryContext(workspaceRoot, query, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);
  const topK = clampInt(options.topK ?? options.maxItems, DEFAULT_TOP_K, 1, MAX_TOP_K);
  const maxChars = clampInt(options.maxChars, DEFAULT_MAX_CHARS, 200, 50_000);
  const scopeFlags = resolveScopeFlags(options.scope);
  const explain = options.explain === true;
  const ranking = resolveMemoryRanking(options);
  const metricsConfig = resolveMemoryMetricsConfig(options);
  const queryStartedAt = Date.now();

  return withDb(options, async (db, dbPath) => {
    const tokens = tokenizeQuery(query);
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);

    let rows = [];
    let ftsMatchCount = 0;
    let fallbackUsed = false;
    if (tokens.length > 0) {
      const ftsQuery = buildFtsQuery(tokens);
      rows = db
        .prepare(
          `
          SELECT
            ml.id,
            ml.workspace_root,
            ml.workspace_hash,
            ml.title,
            ml.lesson,
            ml.tags,
            ml.confidence,
            ml.success_rate,
            ml.quality_score,
            ml.quarantined,
            ml.use_count,
            ml.updated_at,
            bm25(memory_lessons_fts) AS bm25
          FROM memory_lessons_fts
          JOIN memory_lessons ml ON ml.id = memory_lessons_fts.lesson_id
          WHERE memory_lessons_fts MATCH ?
            AND ${scopeWhere}
            AND COALESCE(ml.quarantined, 0) = 0
          ORDER BY bm25 ASC
          LIMIT 200
        `
          )
          .all(ftsQuery, ...scopeArgs);
      ftsMatchCount = rows.length;
    }

    if (rows.length === 0) {
      fallbackUsed = true;
      rows = db
        .prepare(
          `
          SELECT
            id,
            workspace_root,
            workspace_hash,
            title,
            lesson,
            tags,
            confidence,
            success_rate,
            quality_score,
            quarantined,
            use_count,
            updated_at,
            0 AS bm25
          FROM memory_lessons
          WHERE ${scopeWhere}
            AND COALESCE(quarantined, 0) = 0
          ORDER BY updated_at DESC
          LIMIT 200
        `
        )
        .all(...scopeArgs);
    }

    const ids = rows.map((row) => Number(row.id || 0)).filter((id) => id > 0);
    const refsByLesson = collectRefsByLesson(db, ids);

    const feedbackRows = ids.length
      ? db
          .prepare(
            `
            SELECT
              lesson_id,
              COALESCE(SUM(vote), 0) AS score,
              COUNT(*) AS count,
              SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) AS down_count,
              MAX(CASE WHEN vote < 0 THEN created_at ELSE NULL END) AS last_down_at
            FROM memory_feedback
            WHERE lesson_id IN (${ids.map(() => "?").join(",")})
            GROUP BY lesson_id
          `
          )
          .all(...ids)
      : [];

    const feedbackMap = new Map();
    for (const row of feedbackRows) {
      feedbackMap.set(Number(row.lesson_id || 0), {
        score: Number(row.score || 0),
        count: Number(row.count || 0),
        down_count: Number(row.down_count || 0),
        last_down_at: row.last_down_at || null
      });
    }

    const ranked = rows
      .map((row) => {
        const id = Number(row.id || 0);
        const refs = refsByLesson.get(id) || [];
        const isProject = String(row.workspace_hash || "") === workspaceHash;
        const feedback = feedbackMap.get(id) || {
          score: 0,
          count: 0,
          down_count: 0,
          last_down_at: null
        };

        const bm25Score = scoreFromBm25(row.bm25);
        const recency = recencyScore(row.updated_at);
        const confidence = clampFloat(row.confidence, 0.5, 0, 1);
        const successRate = clampFloat(row.success_rate, 0.5, 0, 1);
        const qualityScore = clampFloat(row.quality_score, 0.5, 0, 1);
        const feedbackScore = clampFloat((feedback.score + 5) / 10, 0.5, 0, 1);
        const downCount = Math.max(0, Number(feedback.down_count || 0));
        const recentNegativePenalty =
          downCount > 0 &&
          recencyScore(feedback.last_down_at) >= ranking.penalties.recent_recency_threshold
            ? ranking.penalties.recent
            : 0;
        const negativePenalty = Math.min(
          ranking.penalties.cap,
          downCount * ranking.penalties.per_downvote + recentNegativePenalty
        );
        const workspaceBoost = isProject ? ranking.workspace_boost.project : ranking.workspace_boost.global;
        const weightedScore =
          bm25Score * ranking.weights.bm25 +
          recency * ranking.weights.recency +
          confidence * ranking.weights.confidence +
          successRate * ranking.weights.success_rate +
          qualityScore * ranking.weights.quality +
          feedbackScore * ranking.weights.feedback -
          negativePenalty;
        const score = weightedScore * workspaceBoost;

        return {
          id,
          workspace_root: row.workspace_root,
          workspace_match: isProject,
          title: String(row.title || ""),
          lesson: clipText(row.lesson, maxChars),
          tags: parseTags(row.tags),
          confidence,
          success_rate: successRate,
          quality_score: qualityScore,
          use_count: clampInt(row.use_count, 0, 0, 1_000_000),
          updated_at: row.updated_at,
          refs: refs.slice(0, 12),
          score: Number(score.toFixed(6)),
          ...(explain
            ? {
                components: {
                  bm25: Number(bm25Score.toFixed(6)),
                  recency: Number(recency.toFixed(6)),
                  confidence: Number(confidence.toFixed(6)),
                  success_rate: Number(successRate.toFixed(6)),
                  quality: Number(qualityScore.toFixed(6)),
                  feedback: Number(feedbackScore.toFixed(6)),
                  negative_penalty: Number(negativePenalty.toFixed(6)),
                  weighted_score: Number(weightedScore.toFixed(6)),
                  workspace_boost: Number(workspaceBoost.toFixed(6)),
                  down_count: downCount,
                  weights: ranking.weights
                }
              }
            : {})
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const incrementUseCount = db.prepare(`
      UPDATE memory_lessons
      SET use_count = use_count + 1
      WHERE id = ?
    `);
    for (const item of ranked) {
      incrementUseCount.run(item.id);
    }

    const totalChars = ranked.reduce((acc, item) => acc + item.lesson.length, 0);
    const queryTotalMs = Math.max(0, Date.now() - queryStartedAt);
    const scoreValues = ranked.map((item) => Number(item.score || 0)).filter(Number.isFinite);
    const avgScore =
      scoreValues.length > 0
        ? Number((scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length).toFixed(6))
        : 0;
    const topScore = scoreValues.length > 0 ? Number(scoreValues[0].toFixed(6)) : 0;
    const metricsWrite = await appendMemoryMetricEvent(
      normalizedRoot,
      {
        scope: scopeFlags.scope,
        query_preview: buildQueryPreview(query, metricsConfig.query_preview_chars),
        token_count: tokens.length,
        top_k: topK,
        returned_count: ranked.length,
        candidate_count: rows.length,
        fts_match_count: ftsMatchCount,
        fallback_used: fallbackUsed,
        query_total_ms: queryTotalMs,
        avg_score: avgScore,
        top_score: topScore,
        explain
      },
      {
        ...options,
        metrics: metricsConfig
      }
    );

    return {
      ok: true,
      db_path: dbPath,
      scope: scopeFlags.scope,
      query: String(query || ""),
      token_count: tokens.length,
      total_chars: totalChars,
      query_total_ms: queryTotalMs,
      metrics_logged: Boolean(metricsWrite.logged),
      metrics_reason: metricsWrite.reason || null,
      metrics_error: metricsWrite.error || null,
      ...(explain ? { ranking } : {}),
      items: ranked
    };
  });
}

export function formatMemoryContextForPrompt(context, options = {}) {
  if (!context?.ok || !Array.isArray(context.items) || context.items.length === 0) {
    return "";
  }
  const maxChars = clampInt(options.maxChars, DEFAULT_MAX_CHARS, 200, 50_000);

  const lines = [
    "[memory_context]",
    `scope: ${context.scope || DEFAULT_SCOPE}`,
    `items: ${context.items.length}`
  ];

  let consumed = 0;
  for (const item of context.items) {
    const lesson = clipText(item.lesson, maxChars);
    const entry = [
      `- lesson_id: ${item.id}`,
      `  title: ${item.title}`,
      `  lesson: ${lesson}`,
      `  confidence: ${Number(item.confidence || 0).toFixed(2)}`,
      `  workspace_match: ${item.workspace_match ? "yes" : "no"}`
    ];

    const ref = Array.isArray(item.refs) && item.refs.length > 0 ? item.refs[0] : null;
    if (ref?.file_path) {
      entry.push(`  ref: ${ref.file_path}`);
    }

    const chunk = entry.join("\n");
    if (consumed + chunk.length > maxChars && lines.length > 3) {
      lines.push("- ...truncated");
      break;
    }

    lines.push(chunk);
    consumed += chunk.length;
  }

  lines.push("[/memory_context]");
  return lines.join("\n");
}

export async function recordFeedback(
  workspaceRoot,
  lessonId,
  vote,
  note = null,
  reasonOrOptions = null,
  maybeOptions = {}
) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const targetLessonId = clampInt(lessonId, 0, 1, Number.MAX_SAFE_INTEGER);
  const normalizedVote = typeof vote === "string" ? vote.trim().toLowerCase() : vote;
  const voteValue =
    normalizedVote === "up" || normalizedVote === "+1" || normalizedVote === 1
      ? 1
      : normalizedVote === "down" || normalizedVote === "-1" || normalizedVote === -1
        ? -1
        : 0;

  if (voteValue === 0) {
    return {
      ok: false,
      error: "vote must be up/down or +1/-1"
    };
  }

  let reason = null;
  let options = {};
  if (isPlainObject(reasonOrOptions) && !isPlainObject(maybeOptions)) {
    options = reasonOrOptions;
  } else if (
    isPlainObject(reasonOrOptions) &&
    isPlainObject(maybeOptions) &&
    Object.keys(maybeOptions).length === 0
  ) {
    options = reasonOrOptions;
  } else {
    reason = normalizeFeedbackReason(reasonOrOptions);
    options = isPlainObject(maybeOptions) ? maybeOptions : {};
  }
  if (!reason && typeof reasonOrOptions === "string" && reasonOrOptions.trim()) {
    return {
      ok: false,
      error: `invalid feedback reason: ${reasonOrOptions}`
    };
  }

  return withDb(options, async (db) => {
    const exists = db
      .prepare("SELECT id, quality_score FROM memory_lessons WHERE id = ?")
      .get(targetLessonId);
    if (!exists) {
      return {
        ok: false,
        error: `lesson not found: ${targetLessonId}`
      };
    }

    const createdAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        INSERT INTO memory_feedback(lesson_id, vote, note, reason, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(
        targetLessonId,
        voteValue,
        note ? String(note).slice(0, 1000) : null,
        reason,
        createdAt
      );

      const agg = db
        .prepare(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) AS up_count,
            SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) AS down_count,
            MAX(CASE WHEN vote < 0 THEN created_at ELSE NULL END) AS last_down_at
          FROM memory_feedback
          WHERE lesson_id = ?
        `
        )
        .get(targetLessonId);

      const total = Number(agg?.total || 0);
      const upCount = Number(agg?.up_count || 0);
      const downCount = Number(agg?.down_count || 0);
      const successRate = total > 0 ? upCount / total : 0.5;
      const confidence = clampFloat(0.5 + Math.min(0.4, total * 0.04), 0.5, 0, 1);
      const quarantineThreshold = clampInt(
        options.quarantineThreshold,
        DEFAULT_QUARANTINE_THRESHOLD,
        1,
        20
      );
      const quarantined = downCount >= quarantineThreshold ? 1 : 0;
      const baseQuality = clampFloat(exists.quality_score, 0.5, 0, 1);
      const qualityScore = clampFloat(baseQuality * 0.75 + successRate * 0.25, 0.5, 0, 1);

      db.prepare(`
        UPDATE memory_lessons
        SET
          success_rate = ?,
          confidence = ?,
          quality_score = ?,
          quarantined = ?,
          last_negative_feedback_at = CASE
            WHEN ? IS NOT NULL THEN ?
            ELSE last_negative_feedback_at
          END,
          updated_at = ?
        WHERE id = ?
      `).run(
        successRate,
        confidence,
        qualityScore,
        quarantined,
        agg?.last_down_at || null,
        agg?.last_down_at || null,
        createdAt,
        targetLessonId
      );

      db.exec("COMMIT;");
      return {
        ok: true,
        lesson_id: targetLessonId,
        vote: voteValue,
        reason,
        total_feedback: total,
        down_feedback: downCount,
        success_rate: Number(successRate.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        quality_score: Number(qualityScore.toFixed(4)),
        quarantined: quarantined === 1,
        quarantine_threshold: quarantineThreshold,
        workspace_root: normalizedRoot
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });
}

export async function getMemoryStats(workspaceRoot, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);
  const scopeFlags = resolveScopeFlags(options.scope);

  return withDb(options, async (db, dbPath) => {
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);

    const lessonCount = db
      .prepare(`SELECT COUNT(*) AS count FROM memory_lessons WHERE ${scopeWhere}`)
      .get(...scopeArgs);
    const quarantinedCount = db
      .prepare(`SELECT COUNT(*) AS count FROM memory_lessons WHERE ${scopeWhere} AND COALESCE(quarantined, 0) = 1`)
      .get(...scopeArgs);
    const episodeCount = db
      .prepare(`SELECT COUNT(*) AS count FROM memory_episodes WHERE ${scopeWhere}`)
      .get(...scopeArgs);
    const feedbackCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM memory_feedback f
        JOIN memory_lessons l ON l.id = f.lesson_id
        WHERE ${scopeWhere.replace(/workspace_hash/g, "l.workspace_hash")}
      `
      )
      .get(...scopeArgs);

    const topLessons = db
      .prepare(
        `
        SELECT id, title, confidence, success_rate, use_count, updated_at
        FROM memory_lessons
        WHERE ${scopeWhere}
        ORDER BY use_count DESC, updated_at DESC
        LIMIT 5
      `
      )
      .all(...scopeArgs)
      .map((row) => ({
        id: Number(row.id || 0),
        title: String(row.title || ""),
        confidence: Number(Number(row.confidence || 0).toFixed(4)),
        success_rate: Number(Number(row.success_rate || 0).toFixed(4)),
        use_count: Number(row.use_count || 0),
        updated_at: row.updated_at || null
      }));

    const tagsRaw = db
      .prepare(
        `
        SELECT tags
        FROM memory_lessons
        WHERE ${scopeWhere}
        ORDER BY updated_at DESC
        LIMIT 200
      `
      )
      .all(...scopeArgs);

    const tagCounts = new Map();
    for (const row of tagsRaw) {
      const tags = parseTags(row.tags);
      for (const tag of tags) {
        tagCounts.set(tag, Number(tagCounts.get(tag) || 0) + 1);
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      ok: true,
      db_path: dbPath,
      scope: scopeFlags.scope,
      workspace_root: normalizedRoot,
      counts: {
        lessons: Number(lessonCount?.count || 0),
        quarantined_lessons: Number(quarantinedCount?.count || 0),
        episodes: Number(episodeCount?.count || 0),
        feedback: Number(feedbackCount?.count || 0)
      },
      top_lessons: topLessons,
      top_tags: topTags
    };
  });
}

export async function pruneMemory(workspaceRoot, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);
  const scopeFlags = resolveScopeFlags(options.scope);
  const keepDays = clampInt(options.days, 90, 1, 3650);
  const threshold = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();

  return withDb(options, async (db) => {
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);

    const lessonWhere = `${scopeWhere} AND updated_at < ?`;
    const episodeWhere = `${scopeWhere} AND created_at < ?`;

    const lessonDelete = db.prepare(`DELETE FROM memory_lessons WHERE ${lessonWhere}`);
    const episodeDelete = db.prepare(`DELETE FROM memory_episodes WHERE ${episodeWhere}`);

    db.exec("BEGIN IMMEDIATE;");
    try {
      const lessonResult = lessonDelete.run(...scopeArgs, threshold);
      db.prepare(`
        DELETE FROM memory_lessons_fts
        WHERE lesson_id NOT IN (SELECT id FROM memory_lessons)
      `).run();
      const episodeResult = episodeDelete.run(...scopeArgs, threshold);
      db.exec("COMMIT;");

      return {
        ok: true,
        threshold,
        removed_lessons: Number(lessonResult?.changes || 0),
        removed_episodes: Number(episodeResult?.changes || 0)
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });
}

export async function searchMemory(workspaceRoot, query, options = {}) {
  const result = await loadMemoryContext(workspaceRoot, query, options);
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    results: result.items
  };
}

export async function inspectMemoryLesson(workspaceRoot, lessonId, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);
  const targetLessonId = clampInt(lessonId, 0, 1, Number.MAX_SAFE_INTEGER);
  const scopeFlags = resolveScopeFlags(options.scope);

  return withDb(options, async (db, dbPath) => {
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);
    const lesson = db
      .prepare(
        `
        SELECT
          id,
          workspace_root,
          workspace_hash,
          title,
          lesson,
          tags,
          confidence,
          success_rate,
          quality_score,
          use_count,
          quarantined,
          last_negative_feedback_at,
          merged_from_count,
          created_at,
          updated_at
        FROM memory_lessons
        WHERE id = ?
          AND ${scopeWhere}
        LIMIT 1
      `
      )
      .get(targetLessonId, ...scopeArgs);

    if (!lesson) {
      return {
        ok: false,
        error: `lesson not found: ${targetLessonId}`
      };
    }

    const refs = db
      .prepare(
        `
        SELECT file_path, symbol_name, line_start, line_end, ref_weight
        FROM memory_refs
        WHERE lesson_id = ?
        ORDER BY ref_weight DESC, file_path ASC
      `
      )
      .all(targetLessonId)
      .map((row) => ({
        file_path: row.file_path || null,
        symbol_name: row.symbol_name || null,
        line_start: isFiniteNumber(row.line_start) ? Number(row.line_start) : null,
        line_end: isFiniteNumber(row.line_end) ? Number(row.line_end) : null,
        ref_weight: clampFloat(row.ref_weight, 1, 0, 3)
      }));

    const feedbackRows = db
      .prepare(
        `
        SELECT vote, note, reason, created_at
        FROM memory_feedback
        WHERE lesson_id = ?
        ORDER BY created_at DESC
        LIMIT 200
      `
      )
      .all(targetLessonId);
    const feedbackSummary = {
      total: feedbackRows.length,
      up: feedbackRows.filter((item) => Number(item.vote) > 0).length,
      down: feedbackRows.filter((item) => Number(item.vote) < 0).length
    };
    const reasonCounts = new Map();
    for (const item of feedbackRows) {
      const reason = normalizeFeedbackReason(item.reason);
      if (!reason) {
        continue;
      }
      reasonCounts.set(reason, Number(reasonCounts.get(reason) || 0) + 1);
    }

    return {
      ok: true,
      db_path: dbPath,
      scope: scopeFlags.scope,
      lesson: {
        id: Number(lesson.id || 0),
        workspace_root: lesson.workspace_root || null,
        workspace_match: String(lesson.workspace_hash || "") === workspaceHash,
        title: String(lesson.title || ""),
        lesson: String(lesson.lesson || ""),
        tags: parseTags(lesson.tags),
        confidence: clampFloat(lesson.confidence, 0.5, 0, 1),
        success_rate: clampFloat(lesson.success_rate, 0.5, 0, 1),
        quality_score: clampFloat(lesson.quality_score, 0.5, 0, 1),
        use_count: clampInt(lesson.use_count, 0, 0, 1_000_000),
        quarantined: Number(lesson.quarantined || 0) === 1,
        last_negative_feedback_at: lesson.last_negative_feedback_at || null,
        merged_from_count: clampInt(lesson.merged_from_count, 0, 0, 1_000_000),
        created_at: lesson.created_at || null,
        updated_at: lesson.updated_at || null,
        refs,
        feedback: {
          ...feedbackSummary,
          reasons: Array.from(reasonCounts.entries())
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count)
        }
      }
    };
  });
}

export async function reindexMemory(workspaceRoot, options = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(normalizedRoot);
  const scopeFlags = resolveScopeFlags(options.scope);

  return withDb(options, async (db) => {
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);
    const rows = db
      .prepare(
        `
        SELECT id, title, lesson, tags, quality_score, updated_at
        FROM memory_lessons
        WHERE ${scopeWhere}
        ORDER BY id ASC
      `
      )
      .all(...scopeArgs);

    const updateLesson = db.prepare(`
      UPDATE memory_lessons
      SET tags = ?, quality_score = ?, updated_at = ?
      WHERE id = ?
    `);
    const deleteFts = db.prepare("DELETE FROM memory_lessons_fts WHERE lesson_id = ?");
    const insertFts = db.prepare(`
      INSERT INTO memory_lessons_fts(lesson_id, title, lesson, tags)
      VALUES(?, ?, ?, ?)
    `);

    let updatedTags = 0;
    let updatedQuality = 0;
    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of rows) {
        const lessonId = Number(row.id || 0);
        if (lessonId <= 0) {
          continue;
        }
        const tags = parseTags(row.tags);
        const tagsJson = JSON.stringify(tags);
        const qualityScore = estimateLessonQuality(row.lesson || "", row.title || "", []);
        if (String(row.tags || "") !== tagsJson) {
          updatedTags += 1;
        }
        if (Math.abs(Number(row.quality_score || 0) - qualityScore) > 0.0001) {
          updatedQuality += 1;
        }
        updateLesson.run(tagsJson, qualityScore, row.updated_at || new Date().toISOString(), lessonId);
        deleteFts.run(lessonId);
        insertFts.run(lessonId, String(row.title || ""), String(row.lesson || ""), tags.join(" "));
      }
      db.exec("COMMIT;");
      return {
        ok: true,
        scope: scopeFlags.scope,
        scanned_lessons: rows.length,
        updated_tags: updatedTags,
        updated_quality_score: updatedQuality,
        rebuilt_fts_rows: rows.length
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });
}

function extractLessonTitle(query, summary) {
  const fromQuery = clipText(query, 120);
  if (fromQuery) {
    return fromQuery;
  }
  const firstLine = String(summary || "").split(/\r?\n/, 1)[0] || "";
  return clipText(firstLine, 120) || "Clawty lesson";
}

function inferTags(query, summary) {
  const tokens = tokenizeQuery(`${query || ""} ${summary || ""}`);
  return tokens.slice(0, 8);
}

export async function recordLessonFromTurn(workspaceRoot, turn = {}, options = {}) {
  const query = String(turn.user_query || "").trim();
  const summary = String(turn.assistant_summary || "").trim();
  const minLessonChars = clampInt(options.minLessonChars, DEFAULT_MIN_LESSON_CHARS, 40, 4_000);
  const gateEnabled = options.writeGateEnabled !== false;
  if (!summary || summary.length < minLessonChars) {
    return {
      ok: false,
      skipped: true,
      reason: "summary_too_short",
      min_chars: minLessonChars
    };
  }

  if (gateEnabled) {
    const signals = {
      problem: query.length >= 8,
      action: /\b(fix|update|retry|patch|refactor|handle|run|test|build|validate|guard|avoid|use)\b/i.test(
        summary
      ),
      outcome: /\b(success|failed|resolved|works|error|warning|pass|improved|result)\b/i.test(summary)
    };
    const score =
      Number(signals.problem === true) + Number(signals.action === true) + Number(signals.outcome === true);
    if (score < 2) {
      return {
        ok: false,
        skipped: true,
        reason: "write_gate_rejected",
        gate_score: score,
        signals
      };
    }
  }

  const refs = Array.isArray(turn.changed_paths)
    ? turn.changed_paths.slice(0, 10).map((item) => ({ file_path: item, ref_weight: 0.8 }))
    : [];

  return recordLesson(
    workspaceRoot,
    {
      title: extractLessonTitle(query, summary),
      lesson: summary,
      tags: inferTags(query, summary),
      confidence: turn.outcome === "success" ? 0.68 : 0.45,
      success_rate: turn.outcome === "success" ? 0.75 : 0.4,
      source_query: query,
      refs
    },
    options
  );
}
