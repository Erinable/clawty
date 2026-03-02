import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_BASENAME = "memory.db";
const DEFAULT_SCOPE = "project+global";
const ALLOWED_SCOPE = new Set(["project", "global", "project+global"]);
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 50;
const DEFAULT_MAX_CHARS = 2400;
const MAX_QUERY_TOKENS = 12;

function isFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
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

function clipText(input, maxChars) {
  const text = typeof input === "string" ? input.trim() : "";
  const limit = clampInt(maxChars, DEFAULT_MAX_CHARS, 200, 50_000);
  if (text.length <= limit) {
    return text;
  }
  const keep = Math.max(0, limit - 32);
  return `${text.slice(0, keep)} ...[truncated]`;
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
      use_count INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL,
      FOREIGN KEY(lesson_id) REFERENCES memory_lessons(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_feedback_lesson_id ON memory_feedback(lesson_id);
    CREATE INDEX IF NOT EXISTS idx_memory_feedback_created_at ON memory_feedback(created_at);
  `);

  db
    .prepare(
      `
      INSERT INTO memory_meta(key, value)
      VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
    )
    .run("schema_version", "1");

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

    db.exec("BEGIN IMMEDIATE;");
    try {
      const insertLesson = db.prepare(`
        INSERT INTO memory_lessons(
          workspace_root,
          workspace_hash,
          title,
          lesson,
          tags,
          confidence,
          success_rate,
          use_count,
          created_at,
          updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertResult = insertLesson.run(
        normalizedRoot,
        workspaceHash,
        title,
        lesson,
        JSON.stringify(tags),
        clampFloat(payload.confidence, 0.6, 0, 1),
        clampFloat(payload.success_rate, 0.7, 0, 1),
        clampInt(payload.use_count, 0, 0, 1_000_000),
        createdAt,
        updatedAt
      );

      const lessonId = Number(insertResult.lastInsertRowid || 0);
      db.prepare(`
        INSERT INTO memory_lessons_fts(lesson_id, title, lesson, tags)
        VALUES(?, ?, ?, ?)
      `).run(lessonId, title, lesson, tags.join(" "));

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

  return withDb(options, async (db, dbPath) => {
    const tokens = tokenizeQuery(query);
    const scopeWhere = buildScopeWhereClause(scopeFlags);
    const scopeArgs = buildScopeArgs(scopeFlags, workspaceHash);

    let rows = [];
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
            ml.use_count,
            ml.updated_at,
            bm25(memory_lessons_fts) AS bm25
          FROM memory_lessons_fts
          JOIN memory_lessons ml ON ml.id = memory_lessons_fts.lesson_id
          WHERE memory_lessons_fts MATCH ?
            AND ${scopeWhere}
          ORDER BY bm25 ASC
          LIMIT 200
        `
        )
        .all(ftsQuery, ...scopeArgs);
    }

    if (rows.length === 0) {
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
            use_count,
            updated_at,
            0 AS bm25
          FROM memory_lessons
          WHERE ${scopeWhere}
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
            SELECT lesson_id, COALESCE(SUM(vote), 0) AS score, COUNT(*) AS count
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
        count: Number(row.count || 0)
      });
    }

    const ranked = rows
      .map((row) => {
        const id = Number(row.id || 0);
        const refs = refsByLesson.get(id) || [];
        const isProject = String(row.workspace_hash || "") === workspaceHash;
        const feedback = feedbackMap.get(id) || { score: 0, count: 0 };

        const bm25Score = scoreFromBm25(row.bm25);
        const recency = recencyScore(row.updated_at);
        const confidence = clampFloat(row.confidence, 0.5, 0, 1);
        const successRate = clampFloat(row.success_rate, 0.5, 0, 1);
        const feedbackScore = clampFloat((feedback.score + 5) / 10, 0.5, 0, 1);
        const workspaceBoost = isProject ? 1 : 0.35;
        const score =
          bm25Score * 0.42 +
          recency * 0.2 +
          confidence * 0.12 +
          successRate * 0.12 +
          feedbackScore * 0.14;

        return {
          id,
          workspace_root: row.workspace_root,
          workspace_match: isProject,
          title: String(row.title || ""),
          lesson: clipText(row.lesson, maxChars),
          tags: parseTags(row.tags),
          confidence,
          success_rate: successRate,
          use_count: clampInt(row.use_count, 0, 0, 1_000_000),
          updated_at: row.updated_at,
          refs: refs.slice(0, 12),
          score: Number((score * workspaceBoost).toFixed(6)),
          components: {
            bm25: Number(bm25Score.toFixed(6)),
            recency: Number(recency.toFixed(6)),
            feedback: Number(feedbackScore.toFixed(6)),
            workspace_boost: Number(workspaceBoost.toFixed(6))
          }
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

    return {
      ok: true,
      db_path: dbPath,
      scope: scopeFlags.scope,
      query: String(query || ""),
      token_count: tokens.length,
      total_chars: totalChars,
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

export async function recordFeedback(workspaceRoot, lessonId, vote, note = null, options = {}) {
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

  return withDb(options, async (db) => {
    const exists = db.prepare("SELECT id FROM memory_lessons WHERE id = ?").get(targetLessonId);
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
        INSERT INTO memory_feedback(lesson_id, vote, note, created_at)
        VALUES(?, ?, ?, ?)
      `).run(targetLessonId, voteValue, note ? String(note).slice(0, 1000) : null, createdAt);

      const agg = db
        .prepare(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) AS up_count
          FROM memory_feedback
          WHERE lesson_id = ?
        `
        )
        .get(targetLessonId);

      const total = Number(agg?.total || 0);
      const upCount = Number(agg?.up_count || 0);
      const successRate = total > 0 ? upCount / total : 0.5;
      const confidence = clampFloat(0.5 + Math.min(0.4, total * 0.04), 0.5, 0, 1);

      db.prepare(`
        UPDATE memory_lessons
        SET
          success_rate = ?,
          confidence = ?,
          updated_at = ?
        WHERE id = ?
      `).run(successRate, confidence, createdAt, targetLessonId);

      db.exec("COMMIT;");
      return {
        ok: true,
        lesson_id: targetLessonId,
        vote: voteValue,
        total_feedback: total,
        success_rate: Number(successRate.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
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
  if (!summary || summary.length < 40) {
    return {
      ok: false,
      skipped: true,
      reason: "summary_too_short"
    };
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
      refs
    },
    options
  );
}
