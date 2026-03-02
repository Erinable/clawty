import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const execFileAsync = promisify(execFile);

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_FILE_SIZE_KB = 512;
const DEFAULT_CHUNK_LINES = 80;
const DEFAULT_CHUNK_OVERLAP = 16;
const MTIME_EPSILON_MS = 1;
const QUERY_CACHE_TTL_MS = 10_000;
const QUERY_CACHE_MAX_ENTRIES = 200;
const DEFAULT_INDEX_PREPARE_CONCURRENCY = 6;
const MAX_INDEX_PREPARE_CONCURRENCY = 16;
const QUERY_SLOW_THRESHOLD_MS = 60;
const QUERY_METRICS_MAX_SLOW_QUERIES = 20;

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

let ctagsAvailablePromise;
const queryResultCache = new Map();
const queryMetricsByWorkspace = new Map();

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function cloneValue(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function getWorkspaceQueryCache(workspaceRoot) {
  const key = path.resolve(workspaceRoot);
  if (!queryResultCache.has(key)) {
    queryResultCache.set(key, new Map());
  }
  return queryResultCache.get(key);
}

function clearQueryCache(workspaceRoot) {
  const key = path.resolve(workspaceRoot);
  queryResultCache.delete(key);
}

function makeQueryCacheKey({
  query,
  topK,
  pathPrefix,
  language,
  explain,
  indexMtimeMs
}) {
  return JSON.stringify({
    q: query.toLowerCase(),
    top_k: topK,
    path_prefix: pathPrefix || null,
    language: language || null,
    explain: Boolean(explain),
    index_mtime_ms: Number(indexMtimeMs || 0)
  });
}

function getCachedQuery(workspaceRoot, cacheKey) {
  const cache = getWorkspaceQueryCache(workspaceRoot);
  const entry = cache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey);
    return null;
  }
  return cloneValue(entry.value);
}

function setCachedQuery(workspaceRoot, cacheKey, value) {
  const cache = getWorkspaceQueryCache(workspaceRoot);
  if (cache.size >= QUERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    value: cloneValue(value),
    expiresAt: Date.now() + QUERY_CACHE_TTL_MS
  });
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

function getWorkspaceQueryMetrics(workspaceRoot) {
  const key = path.resolve(workspaceRoot);
  if (!queryMetricsByWorkspace.has(key)) {
    queryMetricsByWorkspace.set(key, {
      total_queries: 0,
      cache_hits: 0,
      cache_misses: 0,
      zero_hit_queries: 0,
      total_latency_ms: 0,
      last_query_at: null,
      slow_query_threshold_ms: QUERY_SLOW_THRESHOLD_MS,
      recent_slow_queries: []
    });
  }
  return queryMetricsByWorkspace.get(key);
}

function clampQueryPreview(query) {
  if (typeof query !== "string") {
    return "";
  }
  const trimmed = query.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117)}...`;
}

function recordQueryMetrics(workspaceRoot, details) {
  const metrics = getWorkspaceQueryMetrics(workspaceRoot);
  metrics.total_queries += 1;
  if (details.cache_hit) {
    metrics.cache_hits += 1;
  } else {
    metrics.cache_misses += 1;
  }
  if (Number(details.total_hits || 0) === 0) {
    metrics.zero_hit_queries += 1;
  }
  if (Number.isFinite(details.latency_ms)) {
    metrics.total_latency_ms += details.latency_ms;
  }
  metrics.last_query_at = new Date().toISOString();

  if (Number.isFinite(details.latency_ms) && details.latency_ms >= QUERY_SLOW_THRESHOLD_MS) {
    metrics.recent_slow_queries.push({
      query: clampQueryPreview(details.query),
      latency_ms: roundMs(details.latency_ms),
      cache_hit: Boolean(details.cache_hit),
      total_hits: Number(details.total_hits || 0),
      filters: {
        path_prefix: details.filters?.path_prefix || null,
        language: details.filters?.language || null
      },
      at: new Date().toISOString()
    });
    if (metrics.recent_slow_queries.length > QUERY_METRICS_MAX_SLOW_QUERIES) {
      metrics.recent_slow_queries.shift();
    }
  }
}

function buildQueryMetricsSnapshot(workspaceRoot) {
  const metrics = getWorkspaceQueryMetrics(workspaceRoot);
  const total = Number(metrics.total_queries || 0);
  const hitRate = total > 0 ? Number((metrics.cache_hits / total).toFixed(4)) : 0;
  const avgLatency = total > 0 ? roundMs(metrics.total_latency_ms / total) : 0;

  return {
    total_queries: total,
    cache_hits: Number(metrics.cache_hits || 0),
    cache_misses: Number(metrics.cache_misses || 0),
    cache_hit_rate: hitRate,
    zero_hit_queries: Number(metrics.zero_hit_queries || 0),
    avg_latency_ms: avgLatency,
    slow_query_threshold_ms: Number(metrics.slow_query_threshold_ms || QUERY_SLOW_THRESHOLD_MS),
    slow_query_count: metrics.recent_slow_queries.length,
    recent_slow_queries: metrics.recent_slow_queries.map((item) => ({
      query: item.query,
      latency_ms: item.latency_ms,
      cache_hit: item.cache_hit,
      total_hits: item.total_hits,
      filters: {
        path_prefix: item.filters.path_prefix,
        language: item.filters.language
      },
      at: item.at
    })),
    last_query_at: metrics.last_query_at
  };
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function getIndexPrepareConcurrency() {
  const cpuHint =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : DEFAULT_INDEX_PREPARE_CONCURRENCY;
  const fallback = Math.max(2, Math.min(DEFAULT_INDEX_PREPARE_CONCURRENCY, cpuHint));
  return parsePositiveInt(
    process.env.CLAWTY_INDEX_PREPARE_CONCURRENCY,
    fallback,
    1,
    MAX_INDEX_PREPARE_CONCURRENCY
  );
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function tokenize(text) {
  const matches = text.match(/[A-Za-z_][A-Za-z0-9_]{1,63}/g) || [];
  return matches.map((value) => value.toLowerCase());
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function isProbablyText(content) {
  return !content.includes("\0");
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function indexDbPath(workspaceRoot) {
  return path.join(workspaceRoot, INDEX_DIR, INDEX_DB_FILENAME);
}

function normalizeRelativePath(workspaceRoot, inputPath) {
  const fullPath = resolveSafePath(workspaceRoot, inputPath);
  return toPosixPath(path.relative(workspaceRoot, fullPath));
}

function shouldIndexPath(relativePath) {
  const normalized = toPosixPath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORED_DIRS.has(part))) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function parsePathList(workspaceRoot, value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const set = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      continue;
    }
    const normalized = normalizeRelativePath(workspaceRoot, item.trim());
    set.add(normalized);
  }
  return Array.from(set);
}

function detectLanguage(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    return "javascript";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".go") {
    return "go";
  }
  if ([".java", ".kt", ".kts", ".scala"].includes(ext)) {
    return "jvm";
  }
  if ([".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".cs", ".swift"].includes(ext)) {
    return "systems";
  }
  return "text";
}

function hashContent(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}

function splitLines(content) {
  return content.split(/\r?\n/);
}

function chunkContent(content, chunkLines = DEFAULT_CHUNK_LINES, overlap = DEFAULT_CHUNK_OVERLAP) {
  const lines = splitLines(content);
  if (lines.length === 0) {
    return [];
  }

  const chunks = [];
  const safeChunkLines = Math.max(1, chunkLines);
  const step = Math.max(1, safeChunkLines - Math.max(0, overlap));

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + safeChunkLines);
    const text = lines.slice(start, end).join("\n").trimEnd();
    if (text.trim().length > 0) {
      chunks.push({
        start_line: start + 1,
        end_line: end,
        text
      });
    }
    if (end >= lines.length) {
      break;
    }
  }

  return chunks;
}

function extractSymbolsByRegex(content, language) {
  const lines = splitLines(content);
  const symbols = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (language === "javascript") {
      const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (functionMatch) {
        symbols.push({
          name: functionMatch[1],
          kind: "function",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }

      const classMatch = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: "class",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }

      const variableMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
      if (variableMatch) {
        symbols.push({
          name: variableMatch[1],
          kind: "variable",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }
    }

    if (language === "python") {
      const defMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (defMatch) {
        symbols.push({
          name: defMatch[1],
          kind: "function",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }

      const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: "class",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }
    }

    if (language === "go") {
      const funcMatch = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (funcMatch) {
        symbols.push({
          name: funcMatch[1],
          kind: "function",
          start_line: index + 1,
          end_line: index + 1,
          signature: line.trim()
        });
      }
    }
  }

  return symbols.slice(0, 500);
}

async function hasCtags() {
  if (!ctagsAvailablePromise) {
    ctagsAvailablePromise = execFileAsync("ctags", ["--version"], {
      timeout: 2000,
      maxBuffer: 1024 * 1024
    })
      .then(() => true)
      .catch(() => false);
  }
  return ctagsAvailablePromise;
}

async function extractSymbolsByCtags(workspaceRoot, relativePath) {
  if (!(await hasCtags())) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      "ctags",
      [
        "--output-format=json",
        "--fields=+nK",
        "--extras=-F",
        "--sort=no",
        "-o",
        "-",
        "--",
        relativePath
      ],
      {
        cwd: workspaceRoot,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024
      }
    );

    const symbols = [];
    const seen = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (record._type !== "tag" || typeof record.name !== "string" || record.name.length === 0) {
        continue;
      }

      const lineNo = Number(record.line);
      const startLine = Number.isFinite(lineNo) && lineNo > 0 ? lineNo : 1;
      const kind = String(record.kind || record.kindName || "symbol").toLowerCase();
      const key = `${record.name}::${kind}::${startLine}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      symbols.push({
        name: record.name,
        kind,
        start_line: startLine,
        end_line: startLine,
        signature: typeof record.pattern === "string" ? record.pattern : null
      });
    }

    return symbols.slice(0, 1000);
  } catch {
    return [];
  }
}

async function extractSymbols(workspaceRoot, relativePath, content, language) {
  const ctagsSymbols = await extractSymbolsByCtags(workspaceRoot, relativePath);
  if (ctagsSymbols.length > 0) {
    return ctagsSymbols;
  }
  return extractSymbolsByRegex(content, language);
}

function resolveIndexConfig(args = {}, fallback = {}) {
  return {
    max_files: parsePositiveInt(
      args.max_files,
      parsePositiveInt(fallback.max_files, DEFAULT_MAX_FILES, 1, 20000),
      1,
      20000
    ),
    max_file_size_kb: parsePositiveInt(
      args.max_file_size_kb,
      parsePositiveInt(fallback.max_file_size_kb, DEFAULT_MAX_FILE_SIZE_KB, 1, 8192),
      1,
      8192
    )
  };
}

async function walkFiles(workspaceRoot, dirPath, state, maxFiles) {
  if (state.collected.length >= maxFiles) {
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (state.collected.length >= maxFiles) {
      return;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walkFiles(workspaceRoot, fullPath, state, maxFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      continue;
    }

    state.collected.push(toPosixPath(path.relative(workspaceRoot, fullPath)));
  }
}

async function listCandidateFiles(workspaceRoot, maxFiles) {
  const state = { collected: [] };
  await walkFiles(workspaceRoot, workspaceRoot, state, maxFiles);
  state.collected.sort();
  return state.collected;
}

async function ensureIndexDir(workspaceRoot) {
  await fs.mkdir(path.join(workspaceRoot, INDEX_DIR), { recursive: true });
}

function openIndexDb(workspaceRoot) {
  const dbPath = indexDbPath(workspaceRoot);
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      lang TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      file_path UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      name_lc TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_name_lc ON symbols(name_lc);
  `);

  ensureSymbolNameLowercaseColumn(db);

  return db;
}

function ensureSymbolNameLowercaseColumn(db) {
  try {
    db.exec("ALTER TABLE symbols ADD COLUMN name_lc TEXT;");
  } catch {
    // Ignore when column already exists.
  }

  db.exec("UPDATE symbols SET name_lc = lower(name) WHERE name_lc IS NULL OR name_lc = '';");
  db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_name_lc ON symbols(name_lc);");
}

function clearAllIndexData(db) {
  db.exec(`
    DELETE FROM chunks_fts;
    DELETE FROM symbols;
    DELETE FROM chunks;
    DELETE FROM files;
  `);
}

function deleteFileIndex(statements, filePath) {
  statements.deleteChunksFtsByFilePath.run(filePath);
  statements.deleteSymbolsByFilePath.run(filePath);
  statements.deleteChunksByFilePath.run(filePath);
  statements.deleteFileByPath.run(filePath);
}

function buildSqlStatements(db) {
  return {
    selectAllFiles: db.prepare(`
      SELECT path, hash, mtime_ms, size
      FROM files
    `),
    selectMetaByKey: db.prepare(`
      SELECT value FROM meta WHERE key = ?
    `),
    countIndexedFiles: db.prepare(`
      SELECT COUNT(*) AS count FROM files
    `),
    countChunks: db.prepare(`
      SELECT COUNT(*) AS count FROM chunks
    `),
    countSymbols: db.prepare(`
      SELECT COUNT(*) AS count FROM symbols
    `),
    selectLanguageCounts: db.prepare(`
      SELECT lang, COUNT(*) AS count
      FROM files
      GROUP BY lang
      ORDER BY count DESC, lang ASC
    `),
    selectLargestFiles: db.prepare(`
      SELECT path, size, line_count
      FROM files
      ORDER BY size DESC, path ASC
      LIMIT ?
    `),
    upsertFile: db.prepare(`
      INSERT INTO files(path, hash, mtime_ms, size, lang, line_count, token_count, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        lang = excluded.lang,
        line_count = excluded.line_count,
        token_count = excluded.token_count,
        updated_at = excluded.updated_at
    `),
    insertChunk: db.prepare(`
      INSERT INTO chunks(file_path, start_line, end_line, text)
      VALUES(?, ?, ?, ?)
    `),
    insertChunkFts: db.prepare(`
      INSERT INTO chunks_fts(text, file_path, start_line, end_line)
      VALUES(?, ?, ?, ?)
    `),
    insertSymbol: db.prepare(`
      INSERT INTO symbols(file_path, name, name_lc, kind, start_line, end_line, signature)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `),
    deleteFileByPath: db.prepare(`
      DELETE FROM files WHERE path = ?
    `),
    deleteChunksByFilePath: db.prepare(`
      DELETE FROM chunks WHERE file_path = ?
    `),
    deleteChunksFtsByFilePath: db.prepare(`
      DELETE FROM chunks_fts WHERE file_path = ?
    `),
    deleteSymbolsByFilePath: db.prepare(`
      DELETE FROM symbols WHERE file_path = ?
    `),
    setMeta: db.prepare(`
      INSERT INTO meta(key, value)
      VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
  };
}

function countUniqueTokens(db) {
  const vocabTable = "__chunks_vocab_tmp";
  try {
    db.exec(`DROP TABLE IF EXISTS ${vocabTable};`);
    db.exec(`CREATE VIRTUAL TABLE ${vocabTable} USING fts5vocab(chunks_fts, row);`);
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${vocabTable}`).get();
    db.exec(`DROP TABLE IF EXISTS ${vocabTable};`);
    return Number(row?.count || 0);
  } catch {
    try {
      db.exec(`DROP TABLE IF EXISTS ${vocabTable};`);
    } catch {
      // Ignore cleanup errors.
    }
    return 0;
  }
}

function formatSnippet(chunkText, startLine, maxLines = 3) {
  const lines = splitLines(chunkText).slice(0, maxLines);
  return lines.map((line, index) => `${startLine + index}: ${line}`).join("\n");
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

async function readFileForIndex(workspaceRoot, relativePath, maxFileBytes) {
  const fullPath = resolveSafePath(workspaceRoot, relativePath);

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { status: "missing" };
  }

  if (stat.size > maxFileBytes) {
    return { status: "skip_large", stat };
  }

  let content;
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    return { status: "missing", stat };
  }

  if (!isProbablyText(content)) {
    return { status: "skip_binary", stat };
  }

  return {
    status: "ok",
    stat,
    content,
    hash: hashContent(content),
    line_count: splitLines(content).length,
    token_count: tokenize(content).length,
    chunks: chunkContent(content),
    language: detectLanguage(relativePath)
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  const parallel = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: parallel }, () => runWorker()));
  return results;
}

async function prepareIndexingPayload(workspaceRoot, relativePath, maxFileBytes) {
  const readResult = await readFileForIndex(workspaceRoot, relativePath, maxFileBytes);
  if (readResult.status !== "ok") {
    return {
      path: relativePath,
      status: readResult.status,
      readResult
    };
  }

  const symbols = await extractSymbols(
    workspaceRoot,
    relativePath,
    readResult.content,
    readResult.language
  );

  return {
    path: relativePath,
    status: "ok",
    readResult,
    symbols
  };
}

function upsertFileMetadataOnly(statements, relativePath, existingHash, readResult) {
  statements.upsertFile.run(
    relativePath,
    existingHash,
    readResult.stat.mtimeMs,
    readResult.stat.size,
    detectLanguage(relativePath),
    readResult.line_count,
    readResult.token_count,
    new Date().toISOString()
  );
}

function indexFileContent(relativePath, readResult, symbols, statements) {
  const updatedAt = new Date().toISOString();

  deleteFileIndex(statements, relativePath);

  statements.upsertFile.run(
    relativePath,
    readResult.hash,
    readResult.stat.mtimeMs,
    readResult.stat.size,
    readResult.language,
    readResult.line_count,
    readResult.token_count,
    updatedAt
  );

  for (const chunk of readResult.chunks) {
    statements.insertChunk.run(relativePath, chunk.start_line, chunk.end_line, chunk.text);
    statements.insertChunkFts.run(chunk.text, relativePath, chunk.start_line, chunk.end_line);
  }

  for (const symbol of symbols) {
    const symbolName = String(symbol.name || "");
    if (!symbolName) {
      continue;
    }
    statements.insertSymbol.run(
      relativePath,
      symbolName,
      symbolName.toLowerCase(),
      symbol.kind,
      symbol.start_line,
      symbol.end_line,
      symbol.signature
    );
  }
}

function writeIndexMeta(statements, config) {
  statements.setMeta.run("schema_version", "2");
  statements.setMeta.run("engine", "sqlite_fts5");
  statements.setMeta.run("config", JSON.stringify(config));
  statements.setMeta.run("updated_at", new Date().toISOString());
}

function readStoredConfig(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'config'").get();
  if (!row || typeof row.value !== "string") {
    return {};
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

function readMetaValue(statements, key, fallback = null) {
  const row = statements.selectMetaByKey.get(key);
  if (!row || typeof row.value !== "string") {
    return fallback;
  }
  return row.value;
}

function collectDbStats(db, statements) {
  const indexedFiles = Number(statements.countIndexedFiles.get().count || 0);
  const chunkCount = Number(statements.countChunks.get().count || 0);
  const symbolCount = Number(statements.countSymbols.get().count || 0);
  const uniqueTokens = countUniqueTokens(db);

  return {
    indexed_files: indexedFiles,
    chunk_count: chunkCount,
    symbol_count: symbolCount,
    unique_tokens: uniqueTokens
  };
}

async function runFullBuild(workspaceRoot, db, config) {
  const statements = buildSqlStatements(db);
  const maxFileBytes = config.max_file_size_kb * 1024;
  const discoveredPaths = await listCandidateFiles(workspaceRoot, config.max_files);
  const preparedPayloads = await mapWithConcurrency(
    discoveredPaths,
    getIndexPrepareConcurrency(),
    async (relativePath) => prepareIndexingPayload(workspaceRoot, relativePath, maxFileBytes)
  );

  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;

  db.exec("BEGIN IMMEDIATE;");
  try {
    clearAllIndexData(db);

    for (const payload of preparedPayloads) {
      if (payload.status === "skip_large") {
        skippedLargeFiles += 1;
        continue;
      }
      if (payload.status === "skip_binary") {
        skippedBinaryFiles += 1;
        continue;
      }
      if (payload.status !== "ok") {
        continue;
      }

      indexFileContent(payload.path, payload.readResult, payload.symbols, statements);
    }

    writeIndexMeta(statements, config);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  const aggregates = collectDbStats(db, statements);

  return {
    mode: "full",
    discovered_files: discoveredPaths.length,
    indexed_files: aggregates.indexed_files,
    chunk_count: aggregates.chunk_count,
    symbol_count: aggregates.symbol_count,
    skipped_large_files: skippedLargeFiles,
    skipped_binary_files: skippedBinaryFiles,
    unique_tokens: aggregates.unique_tokens,
    incremental: false,
    reused_files: 0,
    reindexed_files: aggregates.indexed_files,
    removed_files: 0
  };
}

async function runIncrementalRefresh(workspaceRoot, db, config) {
  const statements = buildSqlStatements(db);
  const maxFileBytes = config.max_file_size_kb * 1024;
  const discoveredPaths = await listCandidateFiles(workspaceRoot, config.max_files);
  const discoveredSet = new Set(discoveredPaths);

  const existingRows = statements.selectAllFiles.all();
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let reusedFiles = 0;
  let reindexedFiles = 0;
  let removedFiles = 0;
  const removePaths = new Set();
  const preparePlans = [];

  for (const row of existingRows) {
    if (!discoveredSet.has(row.path)) {
      removePaths.add(row.path);
      removedFiles += 1;
    }
  }

  for (const relativePath of discoveredPaths) {
    const existing = existingByPath.get(relativePath);
    const fullPath = resolveSafePath(workspaceRoot, relativePath);

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      if (existing) {
        removePaths.add(relativePath);
        removedFiles += 1;
      }
      continue;
    }

    if (stat.size > maxFileBytes) {
      skippedLargeFiles += 1;
      if (existing) {
        removePaths.add(relativePath);
      }
      continue;
    }

    const mtimeUnchanged =
      existing &&
      existing.size === stat.size &&
      Math.abs(existing.mtime_ms - stat.mtimeMs) < MTIME_EPSILON_MS;
    if (mtimeUnchanged) {
      reusedFiles += 1;
      continue;
    }

    preparePlans.push({
      path: relativePath,
      existing
    });
  }

  const preparedPayloads = await mapWithConcurrency(
    preparePlans.map((plan) => plan.path),
    getIndexPrepareConcurrency(),
    async (relativePath) => prepareIndexingPayload(workspaceRoot, relativePath, maxFileBytes)
  );

  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const filePath of removePaths) {
      deleteFileIndex(statements, filePath);
    }

    for (let i = 0; i < preparePlans.length; i += 1) {
      const plan = preparePlans[i];
      const payload = preparedPayloads[i];

      if (!payload || payload.status === "skip_large") {
        skippedLargeFiles += 1;
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
        }
        continue;
      }
      if (payload.status === "skip_binary") {
        skippedBinaryFiles += 1;
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
        }
        continue;
      }
      if (payload.status !== "ok") {
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
          removedFiles += 1;
        }
        continue;
      }

      if (plan.existing && plan.existing.hash === payload.readResult.hash) {
        upsertFileMetadataOnly(statements, plan.path, plan.existing.hash, payload.readResult);
        reusedFiles += 1;
        continue;
      }

      indexFileContent(plan.path, payload.readResult, payload.symbols, statements);
      reindexedFiles += 1;
    }

    writeIndexMeta(statements, config);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  const aggregates = collectDbStats(db, statements);

  return {
    mode: "incremental",
    discovered_files: discoveredPaths.length,
    indexed_files: aggregates.indexed_files,
    chunk_count: aggregates.chunk_count,
    symbol_count: aggregates.symbol_count,
    skipped_large_files: skippedLargeFiles,
    skipped_binary_files: skippedBinaryFiles,
    unique_tokens: aggregates.unique_tokens,
    incremental: true,
    reused_files: reusedFiles,
    reindexed_files: reindexedFiles,
    removed_files: removedFiles
  };
}

async function runEventRefresh(workspaceRoot, db, config, eventPaths) {
  const statements = buildSqlStatements(db);
  const maxFileBytes = config.max_file_size_kb * 1024;

  const changedPaths = parsePathList(workspaceRoot, eventPaths.changed_paths);
  const deletedPaths = parsePathList(workspaceRoot, eventPaths.deleted_paths);
  const changedSet = new Set(changedPaths);
  const deletedSet = new Set(deletedPaths);

  const existingRows = statements.selectAllFiles.all();
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let reusedFiles = 0;
  let reindexedFiles = 0;
  let removedFiles = 0;
  const deletePlans = new Set();
  const removeUnsupportedPlans = new Set();
  const preparePlans = [];

  for (const filePath of deletedSet) {
    if (!existingByPath.has(filePath)) {
      continue;
    }
    deletePlans.add(filePath);
    existingByPath.delete(filePath);
    removedFiles += 1;
  }

  for (const filePath of changedSet) {
    const existing = existingByPath.get(filePath);
    if (!shouldIndexPath(filePath)) {
      if (existing) {
        removeUnsupportedPlans.add(filePath);
        existingByPath.delete(filePath);
        removedFiles += 1;
      }
      continue;
    }

    preparePlans.push({
      path: filePath,
      existing
    });
  }

  const preparedPayloads = await mapWithConcurrency(
    preparePlans.map((plan) => plan.path),
    getIndexPrepareConcurrency(),
    async (relativePath) => prepareIndexingPayload(workspaceRoot, relativePath, maxFileBytes)
  );

  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const filePath of deletePlans) {
      deleteFileIndex(statements, filePath);
    }

    for (const filePath of removeUnsupportedPlans) {
      deleteFileIndex(statements, filePath);
    }

    for (let i = 0; i < preparePlans.length; i += 1) {
      const plan = preparePlans[i];
      const payload = preparedPayloads[i];

      if (!payload || payload.status === "skip_large") {
        skippedLargeFiles += 1;
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
          removedFiles += 1;
        }
        continue;
      }
      if (payload.status === "skip_binary") {
        skippedBinaryFiles += 1;
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
          removedFiles += 1;
        }
        continue;
      }
      if (payload.status !== "ok") {
        if (plan.existing) {
          deleteFileIndex(statements, plan.path);
          removedFiles += 1;
        }
        continue;
      }

      if (plan.existing && plan.existing.hash === payload.readResult.hash) {
        upsertFileMetadataOnly(statements, plan.path, plan.existing.hash, payload.readResult);
        reusedFiles += 1;
        continue;
      }

      indexFileContent(plan.path, payload.readResult, payload.symbols, statements);
      reindexedFiles += 1;
    }

    writeIndexMeta(statements, config);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  const aggregates = collectDbStats(db, statements);

  return {
    mode: "event",
    discovered_files: changedSet.size + deletedSet.size,
    indexed_files: aggregates.indexed_files,
    chunk_count: aggregates.chunk_count,
    symbol_count: aggregates.symbol_count,
    skipped_large_files: skippedLargeFiles,
    skipped_binary_files: skippedBinaryFiles,
    unique_tokens: aggregates.unique_tokens,
    incremental: true,
    reused_files: reusedFiles,
    reindexed_files: reindexedFiles,
    removed_files: removedFiles,
    changed_paths: Array.from(changedSet),
    deleted_paths: Array.from(deletedSet)
  };
}

function buildResult(workspaceRoot, stats, extra = {}) {
  return {
    ok: true,
    index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
    ...stats,
    ...extra
  };
}

export async function buildCodeIndex(workspaceRoot, args = {}) {
  const config = resolveIndexConfig(args);
  await ensureIndexDir(workspaceRoot);
  const db = openIndexDb(workspaceRoot);

  try {
    const stats = await runFullBuild(workspaceRoot, db, config);
    clearQueryCache(workspaceRoot);
    return buildResult(workspaceRoot, stats);
  } finally {
    db.close();
  }
}

export async function refreshCodeIndex(workspaceRoot, args = {}) {
  const forceRebuild = parseBoolean(args.force_rebuild, false);
  const hasEventInput =
    Array.isArray(args.changed_paths) ||
    Array.isArray(args.deleted_paths);
  await ensureIndexDir(workspaceRoot);

  const dbFile = indexDbPath(workspaceRoot);
  const dbExists = await fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);

  const db = openIndexDb(workspaceRoot);

  try {
    const fallbackConfig = readStoredConfig(db);
    const config = resolveIndexConfig(args, fallbackConfig);

    if (!dbExists || forceRebuild) {
      const stats = await runFullBuild(workspaceRoot, db, config);
      clearQueryCache(workspaceRoot);
      return buildResult(workspaceRoot, stats, {
        mode: "full",
        fallback_full_rebuild: !dbExists
      });
    }

    if (hasEventInput) {
      const stats = await runEventRefresh(workspaceRoot, db, config, {
        changed_paths: args.changed_paths,
        deleted_paths: args.deleted_paths
      });
      clearQueryCache(workspaceRoot);
      return buildResult(workspaceRoot, stats);
    }

    const stats = await runIncrementalRefresh(workspaceRoot, db, config);
    clearQueryCache(workspaceRoot);
    return buildResult(workspaceRoot, stats);
  } finally {
    db.close();
  }
}

function buildFtsQuery(tokens) {
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function deriveQueryCandidateProfile({ tokenCount, queryLength }) {
  if (tokenCount >= 4) {
    return "semantic_broad";
  }
  if (tokenCount >= 2) {
    return "hybrid";
  }
  if (tokenCount === 1 && queryLength >= 4 && queryLength <= 48) {
    return "symbol_focused";
  }
  return "default";
}

function computeChunkCandidateLimit({
  topK,
  tokenCount,
  hasPathFilter,
  hasLanguageFilter,
  explain,
  profile
}) {
  let limit = Math.max(40, topK * 10);
  limit += Math.min(100, tokenCount * 6);
  if (profile === "hybrid") {
    limit += 30;
  }
  if (profile === "semantic_broad") {
    limit += 80;
  }
  if (!hasPathFilter) {
    limit += 40;
  }
  if (!hasLanguageFilter) {
    limit += 25;
  }
  if (explain) {
    limit += 40;
  }
  if (hasPathFilter && hasLanguageFilter) {
    limit = Math.max(30, Math.floor(limit * 0.85));
  }
  return Math.min(3000, limit);
}

function computeSymbolCandidateLimit({
  topK,
  tokenCount,
  hasPathFilter,
  hasLanguageFilter,
  queryLength,
  profile
}) {
  let limit = Math.max(80, topK * 16);
  limit += Math.min(200, tokenCount * 20);

  if (profile === "symbol_focused" && topK <= 20 && queryLength >= 6) {
    limit += 40;
  }
  if (profile === "hybrid") {
    limit = Math.floor(limit * 0.85);
  }
  if (profile === "semantic_broad") {
    limit = Math.floor(limit * 0.7);
  }
  if (hasPathFilter && hasLanguageFilter) {
    limit = Math.floor(limit * 0.9);
  }

  return Math.min(3000, Math.max(60, limit));
}

function normalizePathPrefix(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) {
    return null;
  }
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function normalizeLanguageFilter(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().toLowerCase();
  return cleaned || null;
}

function querySymbols(db, tokens, filters = {}) {
  if (tokens.length === 0) {
    return [];
  }

  const clauses = [];
  const params = [];
  for (const token of tokens) {
    clauses.push("s.name_lc = ?");
    params.push(token);
    clauses.push("s.name_lc LIKE ?");
    params.push(`${token}%`);
  }

  const sql = `
    SELECT s.file_path, s.name, s.kind, s.start_line, s.end_line
    FROM symbols s
    JOIN files f ON f.path = s.file_path
    WHERE (${clauses.join(" OR ")})
      AND (? IS NULL OR s.file_path LIKE ?)
      AND (? IS NULL OR f.lang = ?)
    LIMIT ?
  `;

  const pathLike = filters.pathPrefix ? `${filters.pathPrefix}%` : null;
  const limit = parsePositiveInt(filters.limit, 2000, 1, 5000);
  return db
    .prepare(sql)
    .all(...params, filters.pathPrefix, pathLike, filters.language, filters.language, limit);
}

function buildFileRanking({ chunkRows, symbolRows, tokens, explain = false }) {
  const files = new Map();

  for (const row of chunkRows) {
    const current = files.get(row.file_path) || {
      path: row.file_path,
      score: 0,
      score_breakdown: {
        chunk_score: 0,
        symbol_score: 0,
        path_score: 0
      },
      chunk_match_count: 0,
      matched_tokens: new Set(),
      symbol_hits: [],
      snippet: "",
      hit_line: Number(row.start_line) || 1
    };

    const chunkScore = scoreFromBm25(row.rank);
    current.score += chunkScore;
    current.score_breakdown.chunk_score += chunkScore;
    current.chunk_match_count += 1;

    const snippet = formatSnippet(String(row.text || ""), Number(row.start_line) || 1);
    if (!current.snippet) {
      current.snippet = snippet;
      current.hit_line = Number(row.start_line) || 1;
    }

    const lowerText = String(row.text || "").toLowerCase();
    for (const token of tokens) {
      if (lowerText.includes(token)) {
        current.matched_tokens.add(token);
      }
    }

    files.set(row.file_path, current);
  }

  for (const symbol of symbolRows) {
    const current = files.get(symbol.file_path) || {
      path: symbol.file_path,
      score: 0,
      score_breakdown: {
        chunk_score: 0,
        symbol_score: 0,
        path_score: 0
      },
      chunk_match_count: 0,
      matched_tokens: new Set(),
      symbol_hits: [],
      snippet: "",
      hit_line: Number(symbol.start_line) || 1
    };

    const nameLower = String(symbol.name || "").toLowerCase();
    for (const token of tokens) {
      if (nameLower === token) {
        current.score += 4;
        current.score_breakdown.symbol_score += 4;
        current.matched_tokens.add(token);
      } else if (nameLower.startsWith(token)) {
        current.score += 2;
        current.score_breakdown.symbol_score += 2;
        current.matched_tokens.add(token);
      }
    }

    if (current.symbol_hits.length < 8) {
      current.symbol_hits.push({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.start_line
      });
    }

    if (!current.snippet) {
      current.snippet = `${symbol.start_line}: ${symbol.kind} ${symbol.name}`;
      current.hit_line = Number(symbol.start_line) || 1;
    }

    files.set(symbol.file_path, current);
  }

  for (const current of files.values()) {
    const basename = path.basename(current.path).toLowerCase();
    for (const token of tokens) {
      if (basename.includes(token)) {
        current.score += 0.5;
        current.score_breakdown.path_score += 0.5;
        current.matched_tokens.add(token);
      }
    }
  }

  return Array.from(files.values())
    .sort((a, b) => b.score - a.score)
    .map((item) => {
      const base = {
        path: item.path,
        score: Number(item.score.toFixed(3)),
        matched_tokens: Array.from(item.matched_tokens),
        hit_line: item.hit_line,
        snippet: item.snippet,
        symbol_hits: item.symbol_hits
      };
      if (!explain) {
        return base;
      }
      return {
        ...base,
        explain: {
          chunk_match_count: item.chunk_match_count,
          symbol_match_count: item.symbol_hits.length,
          score_breakdown: {
            chunk_score: Number(item.score_breakdown.chunk_score.toFixed(3)),
            symbol_score: Number(item.score_breakdown.symbol_score.toFixed(3)),
            path_score: Number(item.score_breakdown.path_score.toFixed(3))
          }
        }
      };
    });
}

export async function getIndexStats(workspaceRoot, args = {}) {
  const limit = parsePositiveInt(args.top_files, 10, 1, 50);
  const dbFile = indexDbPath(workspaceRoot);
  const exists = await fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const db = openIndexDb(workspaceRoot);
  try {
    const statements = buildSqlStatements(db);
    const aggregates = collectDbStats(db, statements);
    const configRaw = readMetaValue(statements, "config", "{}");
    const updatedAt = readMetaValue(statements, "updated_at", null);
    const engine = readMetaValue(statements, "engine", "sqlite_fts5");

    let config = {};
    try {
      config = JSON.parse(configRaw);
    } catch {
      config = {};
    }

    const languages = statements.selectLanguageCounts.all().map((row) => ({
      language: row.lang,
      count: Number(row.count || 0)
    }));
    const topFiles = statements.selectLargestFiles.all(limit).map((row) => ({
      path: row.path,
      size: Number(row.size || 0),
      line_count: Number(row.line_count || 0)
    }));

    return {
      ok: true,
      index_path: toPosixPath(path.relative(workspaceRoot, dbFile)),
      engine,
      updated_at: updatedAt,
      config,
      counts: {
        files: aggregates.indexed_files,
        chunks: aggregates.chunk_count,
        symbols: aggregates.symbol_count,
        unique_tokens: aggregates.unique_tokens
      },
      query_metrics: buildQueryMetricsSnapshot(workspaceRoot),
      languages,
      top_files: topFiles
    };
  } finally {
    db.close();
  }
}

export async function queryCodeIndex(workspaceRoot, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, error: "query must be a non-empty string" };
  }
  const queryStartMs = performance.now();

  const dbFile = indexDbPath(workspaceRoot);
  const exists = await fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const tokens = uniqueTokens(tokenize(query));
  if (tokens.length === 0) {
    return {
      ok: false,
      error: "query has no indexable tokens"
    };
  }

  const topK =
    Number.isFinite(args.top_k) && args.top_k > 0
      ? Math.min(50, Math.floor(args.top_k))
      : 8;
  const pathPrefix = normalizePathPrefix(args.path_prefix);
  const languageFilter = normalizeLanguageFilter(args.language);
  const explain = Boolean(args.explain);
  const queryProfile = deriveQueryCandidateProfile({
    tokenCount: tokens.length,
    queryLength: query.length
  });
  const filterSnapshot = {
    path_prefix: pathPrefix,
    language: languageFilter
  };
  const dbStat = await fs.stat(dbFile).catch(() => null);
  const cacheKey = makeQueryCacheKey({
    query,
    topK,
    pathPrefix,
    language: languageFilter,
    explain,
    indexMtimeMs: dbStat?.mtimeMs || 0
  });
  const cached = getCachedQuery(workspaceRoot, cacheKey);
  if (cached) {
    const latencyMs = performance.now() - queryStartMs;
    const response = {
      ...cached,
      cache_hit: true,
      query_time_ms: roundMs(latencyMs)
    };
    recordQueryMetrics(workspaceRoot, {
      query,
      cache_hit: true,
      total_hits: Number(cached.total_hits || 0),
      latency_ms: latencyMs,
      filters: filterSnapshot
    });
    return response;
  }

  const db = openIndexDb(workspaceRoot);
  try {
    const rowCount = db.prepare("SELECT COUNT(*) AS count FROM chunks").get();
    if (!rowCount || Number(rowCount.count || 0) === 0) {
      return {
        ok: false,
        error: "code index is empty; run build_code_index first"
      };
    }

    const ftsQuery = buildFtsQuery(tokens);
    const pathLike = pathPrefix ? `${pathPrefix}%` : null;
    const chunkCandidateLimit = computeChunkCandidateLimit({
      topK,
      tokenCount: tokens.length,
      hasPathFilter: Boolean(pathPrefix),
      hasLanguageFilter: Boolean(languageFilter),
      explain,
      profile: queryProfile
    });
    const chunkRows = db
      .prepare(
        `
        SELECT chunks_fts.file_path, chunks_fts.start_line, chunks_fts.end_line, chunks_fts.text, bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN files ON files.path = chunks_fts.file_path
        WHERE chunks_fts MATCH ?
          AND (? IS NULL OR chunks_fts.file_path LIKE ?)
          AND (? IS NULL OR files.lang = ?)
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(ftsQuery, pathPrefix, pathLike, languageFilter, languageFilter, chunkCandidateLimit);

    const symbolCandidateLimit = computeSymbolCandidateLimit({
      topK,
      tokenCount: tokens.length,
      hasPathFilter: Boolean(pathPrefix),
      hasLanguageFilter: Boolean(languageFilter),
      queryLength: query.length,
      profile: queryProfile
    });
    const symbolRows = querySymbols(db, tokens, {
      pathPrefix,
      language: languageFilter,
      limit: symbolCandidateLimit
    });
    const ranked = buildFileRanking({ chunkRows, symbolRows, tokens, explain });
    const results = ranked.slice(0, topK);
    const latencyMs = performance.now() - queryStartMs;
    const response = {
      ok: true,
      query,
      query_tokens: tokens,
      filters: filterSnapshot,
      candidate_profile: queryProfile,
      candidate_limits: {
        chunks: chunkCandidateLimit,
        symbols: symbolCandidateLimit
      },
      total_hits: ranked.length,
      results,
      index_path: toPosixPath(path.relative(workspaceRoot, dbFile)),
      cache_hit: false,
      query_time_ms: roundMs(latencyMs)
    };
    setCachedQuery(workspaceRoot, cacheKey, response);
    recordQueryMetrics(workspaceRoot, {
      query,
      cache_hit: false,
      total_hits: ranked.length,
      latency_ms: latencyMs,
      filters: filterSnapshot
    });
    return response;
  } finally {
    db.close();
  }
}
