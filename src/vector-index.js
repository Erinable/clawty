import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createEmbeddings } from "./embedding-client.js";

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_BATCH_SIZE = 24;
const DEFAULT_MAX_CHUNKS = 6000;
const DEFAULT_QUERY_TOP_K = 8;
const DEFAULT_QUERY_MAX_CANDIDATES = 2000;
const DEFAULT_PREVIEW_CHARS = 240;
const MAX_BATCH_SIZE = 128;
const MAX_MAX_CHUNKS = 20000;
const MAX_QUERY_MAX_CANDIDATES = 20000;
const MAX_QUERY_TOP_K = 100;
const MAX_LAYER_COUNT = 2;
const CHUNKING_VERSION = "code_chunks_v1";

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function parseLayer(value, fallback = "base") {
  const normalized = parseString(value, fallback)?.toLowerCase() || fallback;
  if (normalized === "base" || normalized === "delta") {
    return normalized;
  }
  return fallback;
}

function normalizeLayers(value) {
  if (!Array.isArray(value)) {
    return ["base", "delta"];
  }
  const output = [];
  for (const item of value) {
    const layer = parseLayer(item, null);
    if (!layer) {
      continue;
    }
    if (output.includes(layer)) {
      continue;
    }
    output.push(layer);
  }
  if (output.length === 0) {
    return ["base", "delta"];
  }
  return output.slice(0, MAX_LAYER_COUNT);
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function normalizeRelativePath(workspaceRoot, inputPath) {
  const fullPath = resolveSafePath(workspaceRoot, inputPath);
  return toPosixPath(path.relative(workspaceRoot, fullPath));
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
    set.add(normalizeRelativePath(workspaceRoot, item.trim()));
  }
  return Array.from(set.values()).sort();
}

function indexDbPath(workspaceRoot) {
  return path.join(workspaceRoot, INDEX_DIR, INDEX_DB_FILENAME);
}

async function ensureIndexDir(workspaceRoot) {
  await fs.mkdir(path.join(workspaceRoot, INDEX_DIR), { recursive: true });
}

function hashString(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function buildChunkId({ filePath, startLine, endLine, fileHash }) {
  return hashString(
    [
      filePath,
      String(startLine),
      String(endLine),
      String(fileHash || ""),
      CHUNKING_VERSION
    ].join(":")
  );
}

function clipPreview(text, maxChars = DEFAULT_PREVIEW_CHARS) {
  const input = typeof text === "string" ? text.trim() : "";
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars - 3)}...`;
}

function chunkEmbeddingText(row) {
  return [
    `path: ${row.file_path}`,
    `lang: ${row.lang || "text"}`,
    `lines: ${row.start_line}-${row.end_line}`,
    row.text || ""
  ].join("\n");
}

function chunkArray(items, size) {
  const output = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let idx = 0; idx < items.length; idx += chunkSize) {
    output.push(items.slice(idx, idx + chunkSize));
  }
  return output;
}

function parseEmbeddingContext(args = {}, context = {}) {
  const embedding = context?.embedding || {};
  return {
    apiKey:
      parseString(args.api_key, null) ||
      parseString(embedding.apiKey, null) ||
      parseString(process.env.CLAWTY_EMBEDDING_API_KEY, null) ||
      parseString(process.env.OPENAI_API_KEY, null),
    baseUrl:
      parseString(args.base_url, null) ||
      parseString(embedding.baseUrl, null) ||
      parseString(process.env.CLAWTY_EMBEDDING_BASE_URL, null) ||
      parseString(process.env.OPENAI_BASE_URL, "https://api.openai.com/v1"),
    model: parseString(args.model, null) || parseString(embedding.model, DEFAULT_MODEL),
    timeoutMs: parsePositiveInt(
      args.timeout_ms ?? embedding.timeoutMs ?? process.env.CLAWTY_EMBEDDING_TIMEOUT_MS,
      15_000,
      1000,
      120_000
    ),
    client: typeof args.client === "function" ? args.client : embedding.client || null
  };
}

function parseBuildConfig(args = {}, context = {}) {
  const embedding = parseEmbeddingContext(args, context);
  return {
    ...embedding,
    layer: parseLayer(args.layer, "base"),
    mode: parseString(args.mode, "full"),
    batchSize: parsePositiveInt(args.batch_size, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    maxChunks: parsePositiveInt(args.max_chunks, DEFAULT_MAX_CHUNKS, 1, MAX_MAX_CHUNKS),
    sourceRevision:
      parseString(args.source_revision, null) || new Date().toISOString(),
    chunkingVersion: CHUNKING_VERSION
  };
}

function parseRefreshConfig(args = {}, context = {}) {
  const config = parseBuildConfig(args, context);
  return {
    ...config,
    layer: parseLayer(args.layer, "delta"),
    changedPaths: parsePathList(context?.workspaceRoot || process.cwd(), args.changed_paths),
    deletedPaths: parsePathList(context?.workspaceRoot || process.cwd(), args.deleted_paths)
  };
}

function parseQueryConfig(args = {}, context = {}) {
  const embedding = parseEmbeddingContext(args, context);
  return {
    ...embedding,
    topK: parsePositiveInt(args.top_k, DEFAULT_QUERY_TOP_K, 1, MAX_QUERY_TOP_K),
    maxCandidates: parsePositiveInt(
      args.max_candidates,
      DEFAULT_QUERY_MAX_CANDIDATES,
      1,
      MAX_QUERY_MAX_CANDIDATES
    ),
    pathPrefix: parseString(args.path_prefix, null),
    language: parseString(args.language, null),
    layers: normalizeLayers(args.layers)
  };
}

function openDb(workspaceRoot) {
  const db = new DatabaseSync(indexDbPath(workspaceRoot));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_chunks (
      chunk_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      lang TEXT,
      content_hash TEXT NOT NULL,
      text_preview TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dims INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      layer TEXT NOT NULL,
      source_revision TEXT,
      chunking_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vector_chunks_layer ON vector_chunks(layer);
    CREATE INDEX IF NOT EXISTS idx_vector_chunks_file_path ON vector_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_vector_chunks_lang ON vector_chunks(lang);
    CREATE INDEX IF NOT EXISTS idx_vector_chunks_updated_at ON vector_chunks(updated_at);

    CREATE TABLE IF NOT EXISTS vector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      layer TEXT NOT NULL,
      processed_files INTEGER NOT NULL,
      processed_chunks INTEGER NOT NULL,
      deleted_files INTEGER NOT NULL,
      skipped_chunks INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      embedding_model TEXT NOT NULL,
      source_revision TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vector_runs_completed_at ON vector_runs(completed_at);
  `);
  return db;
}

async function ensureCodeIndexExists(workspaceRoot) {
  const dbFile = indexDbPath(workspaceRoot);
  return fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);
}

function buildStatements(db) {
  return {
    selectChunkRows: db.prepare(`
      SELECT
        c.file_path,
        c.start_line,
        c.end_line,
        c.text,
        f.hash AS file_hash,
        f.lang
      FROM chunks c
      JOIN files f ON f.path = c.file_path
      ORDER BY c.file_path ASC, c.start_line ASC
      LIMIT ?
    `),
    selectChunkRowsByPath: db.prepare(`
      SELECT
        c.file_path,
        c.start_line,
        c.end_line,
        c.text,
        f.hash AS file_hash,
        f.lang
      FROM chunks c
      JOIN files f ON f.path = c.file_path
      WHERE c.file_path = ?
      ORDER BY c.start_line ASC
    `),
    upsertVectorChunk: db.prepare(`
      INSERT INTO vector_chunks(
        chunk_id, file_path, start_line, end_line, lang, content_hash, text_preview,
        embedding_model, embedding_dims, embedding_json, layer, source_revision,
        chunking_version, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        file_path = excluded.file_path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        lang = excluded.lang,
        content_hash = excluded.content_hash,
        text_preview = excluded.text_preview,
        embedding_model = excluded.embedding_model,
        embedding_dims = excluded.embedding_dims,
        embedding_json = excluded.embedding_json,
        layer = excluded.layer,
        source_revision = excluded.source_revision,
        chunking_version = excluded.chunking_version,
        updated_at = excluded.updated_at
    `),
    deleteLayerRows: db.prepare(`
      DELETE FROM vector_chunks
      WHERE layer = ?
    `),
    deleteLayerRowsByPath: db.prepare(`
      DELETE FROM vector_chunks
      WHERE layer = ? AND file_path = ?
    `),
    deleteBaseRowsByPath: db.prepare(`
      DELETE FROM vector_chunks
      WHERE layer = 'base' AND file_path = ?
    `),
    selectDistinctDeltaFiles: db.prepare(`
      SELECT DISTINCT file_path
      FROM vector_chunks
      WHERE layer = 'delta'
      ORDER BY file_path ASC
    `),
    insertRun: db.prepare(`
      INSERT INTO vector_runs(
        started_at, completed_at, mode, layer, processed_files, processed_chunks,
        deleted_files, skipped_chunks, error_count, embedding_model, source_revision, details_json
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countByLayer: db.prepare(`
      SELECT layer, COUNT(*) AS count
      FROM vector_chunks
      GROUP BY layer
      ORDER BY layer ASC
    `),
    countDistinctFiles: db.prepare(`
      SELECT COUNT(DISTINCT file_path) AS count
      FROM vector_chunks
      WHERE layer = ?
    `),
    latestRun: db.prepare(`
      SELECT *
      FROM vector_runs
      ORDER BY id DESC
      LIMIT 1
    `),
    selectCandidates: db.prepare(`
      SELECT
        chunk_id, file_path, start_line, end_line, lang, text_preview,
        embedding_model, embedding_dims, embedding_json, layer, updated_at
      FROM vector_chunks
      WHERE layer IN (?, ?)
        AND (? IS NULL OR file_path LIKE ?)
        AND (? IS NULL OR lang = ?)
      ORDER BY updated_at DESC, file_path ASC, start_line ASC
      LIMIT ?
    `),
    copyDeltaToBaseByPath: db.prepare(`
      INSERT INTO vector_chunks(
        chunk_id, file_path, start_line, end_line, lang, content_hash, text_preview,
        embedding_model, embedding_dims, embedding_json, layer, source_revision,
        chunking_version, updated_at
      )
      SELECT
        chunk_id, file_path, start_line, end_line, lang, content_hash, text_preview,
        embedding_model, embedding_dims, embedding_json, 'base', source_revision,
        chunking_version, updated_at
      FROM vector_chunks
      WHERE layer = 'delta' AND file_path = ?
      ON CONFLICT(chunk_id) DO UPDATE SET
        file_path = excluded.file_path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        lang = excluded.lang,
        content_hash = excluded.content_hash,
        text_preview = excluded.text_preview,
        embedding_model = excluded.embedding_model,
        embedding_dims = excluded.embedding_dims,
        embedding_json = excluded.embedding_json,
        layer = excluded.layer,
        source_revision = excluded.source_revision,
        chunking_version = excluded.chunking_version,
        updated_at = excluded.updated_at
    `)
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let idx = 0; idx < size; idx += 1) {
    const av = Number(a[idx] || 0);
    const bv = Number(b[idx] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function roundMetric(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Number(n.toFixed(6));
}

function assertEmbeddingReady(config) {
  if (typeof config.client === "function") {
    return;
  }
  if (parseString(config.apiKey, null)) {
    return;
  }
  throw new Error("embedding api key is missing");
}

async function embedChunkRows(chunkRows, config) {
  if (!Array.isArray(chunkRows) || chunkRows.length === 0) {
    return {
      ok: true,
      embeddedRows: [],
      skippedChunks: 0
    };
  }
  assertEmbeddingReady(config);

  const embeddedRows = [];
  let skippedChunks = 0;
  for (const batch of chunkArray(chunkRows, config.batchSize)) {
    const inputs = batch.map((row) => chunkEmbeddingText(row));
    const vectors = await createEmbeddings({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      input: inputs,
      timeoutMs: config.timeoutMs,
      client: config.client
    });
    for (let idx = 0; idx < batch.length; idx += 1) {
      const row = batch[idx];
      const vector = vectors[idx];
      if (!Array.isArray(vector) || vector.length === 0) {
        skippedChunks += 1;
        continue;
      }
      embeddedRows.push({
        ...row,
        embedding: vector
      });
    }
  }
  return {
    ok: true,
    embeddedRows,
    skippedChunks
  };
}

async function loadChunkRowsForPaths(statements, paths, maxChunks) {
  const rows = [];
  if (paths.length === 0) {
    return rows;
  }
  for (const filePath of paths) {
    const fileRows = statements.selectChunkRowsByPath.all(filePath);
    for (const row of fileRows) {
      rows.push(row);
      if (rows.length >= maxChunks) {
        return rows;
      }
    }
  }
  return rows;
}

function toIndexPath(workspaceRoot) {
  return toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot)));
}

export async function buildVectorIndex(workspaceRoot, args = {}, context = {}) {
  const root = path.resolve(workspaceRoot);
  const indexExists = await ensureCodeIndexExists(root);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  await ensureIndexDir(root);
  const config = parseBuildConfig(args, context);
  const db = openDb(root);
  const statements = buildStatements(db);
  const startedAt = new Date().toISOString();

  let processedChunks = 0;
  let skippedChunks = 0;
  let processedFiles = 0;
  try {
    const chunkRows = statements.selectChunkRows.all(config.maxChunks);
    const fileSet = new Set(chunkRows.map((row) => row.file_path));
    processedFiles = fileSet.size;
    const embedded = await embedChunkRows(chunkRows, config);
    processedChunks = embedded.embeddedRows.length;
    skippedChunks = embedded.skippedChunks;

    db.exec("BEGIN IMMEDIATE;");
    try {
      statements.deleteLayerRows.run(config.layer);
      const updatedAt = new Date().toISOString();
      for (const row of embedded.embeddedRows) {
        const chunkId = buildChunkId({
          filePath: row.file_path,
          startLine: Number(row.start_line || 1),
          endLine: Number(row.end_line || 1),
          fileHash: row.file_hash
        });
        statements.upsertVectorChunk.run(
          chunkId,
          row.file_path,
          Number(row.start_line || 1),
          Number(row.end_line || 1),
          row.lang || null,
          row.file_hash || "",
          clipPreview(row.text),
          config.model,
          row.embedding.length,
          JSON.stringify(row.embedding),
          config.layer,
          config.sourceRevision,
          config.chunkingVersion,
          updatedAt
        );
      }
      const completedAt = new Date().toISOString();
      statements.insertRun.run(
        startedAt,
        completedAt,
        "full",
        config.layer,
        processedFiles,
        processedChunks,
        0,
        skippedChunks,
        0,
        config.model,
        config.sourceRevision,
        JSON.stringify({
          max_chunks: config.maxChunks,
          batch_size: config.batchSize
        })
      );
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }

    return {
      ok: true,
      mode: "full",
      layer: config.layer,
      embedding_model: config.model,
      source_revision: config.sourceRevision,
      index_path: toIndexPath(root),
      processed_files: processedFiles,
      processed_chunks: processedChunks,
      skipped_chunks: skippedChunks
    };
  } catch (error) {
    return {
      ok: false,
      mode: "full",
      layer: config.layer,
      embedding_model: config.model,
      error: error.message || String(error)
    };
  } finally {
    db.close();
  }
}

export async function refreshVectorIndex(workspaceRoot, args = {}, context = {}) {
  const root = path.resolve(workspaceRoot);
  const indexExists = await ensureCodeIndexExists(root);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const contextWithRoot = {
    ...(context || {}),
    workspaceRoot: root
  };
  const config = parseRefreshConfig(args, contextWithRoot);
  const hasEventInput = config.changedPaths.length > 0 || config.deletedPaths.length > 0;
  if (!hasEventInput) {
    const rebuilt = await buildVectorIndex(
      root,
      {
        ...args,
        layer: parseLayer(args.layer, "base")
      },
      context
    );
    if (!rebuilt.ok) {
      return rebuilt;
    }
    return {
      ...rebuilt,
      mode: "full_fallback",
      changed_paths: [],
      deleted_paths: []
    };
  }

  await ensureIndexDir(root);
  const db = openDb(root);
  const statements = buildStatements(db);
  const startedAt = new Date().toISOString();
  try {
    const chunkRows = await loadChunkRowsForPaths(statements, config.changedPaths, config.maxChunks);
    const embedded = await embedChunkRows(chunkRows, config);

    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const filePath of [...config.deletedPaths, ...config.changedPaths]) {
        statements.deleteLayerRowsByPath.run(config.layer, filePath);
      }
      const updatedAt = new Date().toISOString();
      for (const row of embedded.embeddedRows) {
        const chunkId = buildChunkId({
          filePath: row.file_path,
          startLine: Number(row.start_line || 1),
          endLine: Number(row.end_line || 1),
          fileHash: row.file_hash
        });
        statements.upsertVectorChunk.run(
          chunkId,
          row.file_path,
          Number(row.start_line || 1),
          Number(row.end_line || 1),
          row.lang || null,
          row.file_hash || "",
          clipPreview(row.text),
          config.model,
          row.embedding.length,
          JSON.stringify(row.embedding),
          config.layer,
          config.sourceRevision,
          config.chunkingVersion,
          updatedAt
        );
      }
      const completedAt = new Date().toISOString();
      statements.insertRun.run(
        startedAt,
        completedAt,
        "event",
        config.layer,
        config.changedPaths.length,
        embedded.embeddedRows.length,
        config.deletedPaths.length,
        embedded.skippedChunks,
        0,
        config.model,
        config.sourceRevision,
        JSON.stringify({
          changed_paths: config.changedPaths,
          deleted_paths: config.deletedPaths,
          max_chunks: config.maxChunks,
          batch_size: config.batchSize
        })
      );
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }

    return {
      ok: true,
      mode: "event",
      layer: config.layer,
      embedding_model: config.model,
      source_revision: config.sourceRevision,
      index_path: toIndexPath(root),
      changed_paths: config.changedPaths,
      deleted_paths: config.deletedPaths,
      processed_files: config.changedPaths.length,
      deleted_files: config.deletedPaths.length,
      processed_chunks: embedded.embeddedRows.length,
      skipped_chunks: embedded.skippedChunks
    };
  } catch (error) {
    return {
      ok: false,
      mode: "event",
      layer: config.layer,
      embedding_model: config.model,
      changed_paths: config.changedPaths,
      deleted_paths: config.deletedPaths,
      error: error.message || String(error)
    };
  } finally {
    db.close();
  }
}

export async function mergeVectorDelta(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const indexExists = await ensureCodeIndexExists(root);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const db = openDb(root);
  const statements = buildStatements(db);
  try {
    const deltaFiles = statements.selectDistinctDeltaFiles.all().map((row) => row.file_path);
    if (deltaFiles.length === 0) {
      return {
        ok: true,
        merged_files: 0,
        merged_chunks: 0
      };
    }

    let mergedChunks = 0;
    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const filePath of deltaFiles) {
        statements.deleteBaseRowsByPath.run(filePath);
        const inserted = statements.copyDeltaToBaseByPath.run(filePath);
        mergedChunks += Number(inserted.changes || 0);
        statements.deleteLayerRowsByPath.run("delta", filePath);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }

    return {
      ok: true,
      merged_files: deltaFiles.length,
      merged_chunks: mergedChunks
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  } finally {
    db.close();
  }
}

export async function queryVectorIndex(workspaceRoot, args = {}, context = {}) {
  const root = path.resolve(workspaceRoot);
  const indexExists = await ensureCodeIndexExists(root);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const query = parseString(args.query, "");
  if (!query) {
    return {
      ok: false,
      error: "query must be a non-empty string"
    };
  }

  const config = parseQueryConfig(args, context);
  assertEmbeddingReady(config);
  const db = openDb(root);
  const statements = buildStatements(db);
  try {
    const layerA = config.layers[0] || "base";
    const layerB = config.layers[1] || layerA;
    const pathPrefix = config.pathPrefix ? `${config.pathPrefix.replace(/\\/g, "/")}%` : null;
    const rows = statements.selectCandidates.all(
      layerA,
      layerB,
      pathPrefix,
      pathPrefix,
      config.language,
      config.language,
      config.maxCandidates
    );
    if (rows.length === 0) {
      return {
        ok: false,
        error: "vector index is empty; run build_vector_index first"
      };
    }

    const vectors = await createEmbeddings({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      input: [query],
      timeoutMs: config.timeoutMs,
      client: config.client
    });
    const queryVector = vectors[0];
    const ranked = [];

    for (const row of rows) {
      let embedding = null;
      try {
        embedding = JSON.parse(String(row.embedding_json || "[]"));
      } catch {
        embedding = null;
      }
      if (!Array.isArray(embedding) || embedding.length === 0) {
        continue;
      }
      const score = roundMetric(cosineSimilarity(queryVector, embedding));
      ranked.push({
        chunk_id: row.chunk_id,
        path: row.file_path,
        start_line: Number(row.start_line || 1),
        end_line: Number(row.end_line || 1),
        language: row.lang || null,
        layer: row.layer,
        embedding_model: row.embedding_model,
        preview: row.text_preview || "",
        score,
        updated_at: row.updated_at || null
      });
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const pathCompare = String(a.path || "").localeCompare(String(b.path || ""));
      if (pathCompare !== 0) {
        return pathCompare;
      }
      return Number(a.start_line || 1) - Number(b.start_line || 1);
    });

    return {
      ok: true,
      provider: "vector_index",
      query,
      filters: {
        path_prefix: config.pathPrefix || null,
        language: config.language || null,
        layers: config.layers
      },
      embedding_model: config.model,
      scanned_candidates: rows.length,
      total_hits: ranked.length,
      results: ranked.slice(0, config.topK)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  } finally {
    db.close();
  }
}

export async function getVectorIndexStats(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const indexExists = await ensureCodeIndexExists(root);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }
  const db = openDb(root);
  const statements = buildStatements(db);
  try {
    const layerRows = statements.countByLayer.all();
    const layers = {};
    for (const row of layerRows) {
      layers[row.layer] = Number(row.count || 0);
    }
    const latestRun = statements.latestRun.get();
    return {
      ok: true,
      index_path: toIndexPath(root),
      counts: {
        chunks: {
          base: Number(layers.base || 0),
          delta: Number(layers.delta || 0),
          total: Number(layers.base || 0) + Number(layers.delta || 0)
        },
        files: {
          base: Number(statements.countDistinctFiles.get("base")?.count || 0),
          delta: Number(statements.countDistinctFiles.get("delta")?.count || 0)
        }
      },
      latest_run: latestRun
        ? {
            mode: latestRun.mode,
            layer: latestRun.layer,
            processed_files: Number(latestRun.processed_files || 0),
            processed_chunks: Number(latestRun.processed_chunks || 0),
            deleted_files: Number(latestRun.deleted_files || 0),
            skipped_chunks: Number(latestRun.skipped_chunks || 0),
            error_count: Number(latestRun.error_count || 0),
            embedding_model: latestRun.embedding_model,
            source_revision: latestRun.source_revision || null,
            completed_at: latestRun.completed_at
          }
        : null
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  } finally {
    db.close();
  }
}
