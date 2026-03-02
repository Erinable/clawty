import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const SYNTAX_PROVIDER = "tree-sitter-skeleton";
const SYNTAX_PARSER_VERSION = "skeleton-v1";
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_CALLS_PER_FILE = 400;
const DEFAULT_MAX_ERRORS = 80;
const MAX_FILES_LIMIT = 20_000;
const MAX_CALLS_LIMIT = 2000;
const MAX_ERRORS_LIMIT = 1000;

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function indexDbPath(workspaceRoot) {
  return path.join(workspaceRoot, INDEX_DIR, INDEX_DB_FILENAME);
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
  return toPosixPath(path.relative(workspaceRoot, resolveSafePath(workspaceRoot, inputPath)));
}

function parsePathList(workspaceRoot, value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const deduped = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      continue;
    }
    deduped.add(normalizeRelativePath(workspaceRoot, item.trim()));
  }
  return Array.from(deduped);
}

function resolveConfig(args = {}) {
  return {
    max_files: parsePositiveInt(args.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_LIMIT),
    max_calls_per_file: parsePositiveInt(
      args.max_calls_per_file,
      DEFAULT_MAX_CALLS_PER_FILE,
      1,
      MAX_CALLS_LIMIT
    ),
    max_errors: parsePositiveInt(args.max_errors, DEFAULT_MAX_ERRORS, 1, MAX_ERRORS_LIMIT)
  };
}

function hashContent(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}

function splitLines(content) {
  return content.split(/\r?\n/);
}

function detectLanguageByPath(relativePath) {
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
  if ([".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift"].includes(ext)) {
    return "systems";
  }
  return "text";
}

function normalizeImportTarget(relativePath, specifier) {
  if (typeof specifier !== "string" || specifier.trim().length === 0) {
    return null;
  }
  const cleaned = specifier.trim();
  if (cleaned.startsWith(".")) {
    const fileDir = path.dirname(relativePath);
    return toPosixPath(path.normalize(path.join(fileDir, cleaned)));
  }
  return `pkg:${cleaned}`;
}

function extractImports(relativePath, lines) {
  const imports = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const esmMatch = line.match(/^\s*import\s+.+?\s+from\s+["'](.+?)["']/);
    if (esmMatch) {
      const target = normalizeImportTarget(relativePath, esmMatch[1]);
      if (target) {
        imports.push({ imported_path: target, line: i + 1, source: "esm" });
      }
    }

    const requireMatch = line.match(/require\(\s*["'](.+?)["']\s*\)/);
    if (requireMatch) {
      const target = normalizeImportTarget(relativePath, requireMatch[1]);
      if (target) {
        imports.push({ imported_path: target, line: i + 1, source: "cjs" });
      }
    }

    const pyFromMatch = line.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/);
    if (pyFromMatch) {
      imports.push({ imported_path: `pkg:${pyFromMatch[1]}`, line: i + 1, source: "py" });
    }

    const pyImportMatch = line.match(/^\s*import\s+([A-Za-z0-9_.]+)/);
    if (pyImportMatch) {
      imports.push({ imported_path: `pkg:${pyImportMatch[1]}`, line: i + 1, source: "py" });
    }
  }

  const deduped = new Map();
  for (const item of imports) {
    const key = `${item.imported_path}:${item.line}:${item.source}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

function extractCalls(lines, maxCalls) {
  const calls = [];
  const seen = new Set();
  const blocked = new Set(["if", "for", "while", "switch", "catch", "function", "return", "new"]);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const matches = line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g);
    for (const match of matches) {
      const callee = String(match[1] || "");
      if (!callee || blocked.has(callee)) {
        continue;
      }
      const key = `${callee}:${i + 1}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      calls.push({ callee, line: i + 1 });
      if (calls.length >= maxCalls) {
        return calls;
      }
    }
  }
  return calls;
}

function estimateNodeCount(lines) {
  let count = 0;
  for (const line of lines) {
    const keywordMatches =
      line.match(/\b(function|class|if|for|while|switch|try|catch|return|import|export)\b/g) || [];
    const symbolMatches = line.match(/[{}()[\]]/g) || [];
    count += keywordMatches.length + Math.floor(symbolMatches.length / 2);
  }
  return Math.max(1, count);
}

function buildSyntaxSummary(relativePath, content, maxCalls) {
  const lines = splitLines(content);
  const imports = extractImports(relativePath, lines);
  const calls = extractCalls(lines, maxCalls);
  const nodeCount = estimateNodeCount(lines);
  const lineCount = lines.length;
  const fingerprint = hashContent(
    JSON.stringify({
      path: relativePath,
      imports,
      calls,
      node_count: nodeCount,
      line_count: lineCount
    })
  );
  const ast = {
    parser: SYNTAX_PARSER_VERSION,
    node_count: nodeCount,
    line_count: lineCount,
    imports,
    calls
  };
  return {
    line_count: lineCount,
    node_count: nodeCount,
    import_count: imports.length,
    call_count: calls.length,
    tree_fingerprint: fingerprint,
    imports,
    calls,
    ast_json: JSON.stringify(ast)
  };
}

function openDb(workspaceRoot) {
  const db = new DatabaseSync(indexDbPath(workspaceRoot));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

function ensureSyntaxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS syntax_files (
      path TEXT PRIMARY KEY,
      lang TEXT NOT NULL,
      hash TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      node_count INTEGER NOT NULL,
      import_count INTEGER NOT NULL,
      call_count INTEGER NOT NULL,
      provider TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      tree_fingerprint TEXT NOT NULL,
      ast_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS syntax_import_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      imported_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(file_path, imported_path, line, source)
    );

    CREATE TABLE IF NOT EXISTS syntax_call_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      callee TEXT NOT NULL,
      line INTEGER NOT NULL,
      UNIQUE(file_path, callee, line)
    );

    CREATE INDEX IF NOT EXISTS idx_syntax_import_edges_file ON syntax_import_edges(file_path);
    CREATE INDEX IF NOT EXISTS idx_syntax_import_edges_target ON syntax_import_edges(imported_path);
    CREATE INDEX IF NOT EXISTS idx_syntax_call_edges_file ON syntax_call_edges(file_path);
    CREATE INDEX IF NOT EXISTS idx_syntax_call_edges_callee ON syntax_call_edges(callee);

    CREATE TABLE IF NOT EXISTS syntax_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      parsed_files INTEGER NOT NULL,
      reused_files INTEGER NOT NULL,
      removed_files INTEGER NOT NULL,
      skipped_files INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      total_files INTEGER NOT NULL,
      total_import_edges INTEGER NOT NULL,
      total_call_edges INTEGER NOT NULL,
      provider TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      error TEXT
    );
  `);
}

function buildStatements(db) {
  return {
    selectIndexFiles: db.prepare(`
      SELECT path, mtime_ms, size, lang
      FROM files
      ORDER BY path ASC
      LIMIT ?
    `),
    selectSyntaxFiles: db.prepare(`
      SELECT path, hash, mtime_ms, size
      FROM syntax_files
    `),
    upsertSyntaxFile: db.prepare(`
      INSERT INTO syntax_files(
        path, lang, hash, mtime_ms, size, line_count, node_count, import_count, call_count,
        provider, parser_version, tree_fingerprint, ast_json, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        lang = excluded.lang,
        hash = excluded.hash,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        line_count = excluded.line_count,
        node_count = excluded.node_count,
        import_count = excluded.import_count,
        call_count = excluded.call_count,
        provider = excluded.provider,
        parser_version = excluded.parser_version,
        tree_fingerprint = excluded.tree_fingerprint,
        ast_json = excluded.ast_json,
        updated_at = excluded.updated_at
    `),
    deleteSyntaxFile: db.prepare(`
      DELETE FROM syntax_files WHERE path = ?
    `),
    deleteImportEdgesByFile: db.prepare(`
      DELETE FROM syntax_import_edges WHERE file_path = ?
    `),
    deleteCallEdgesByFile: db.prepare(`
      DELETE FROM syntax_call_edges WHERE file_path = ?
    `),
    insertImportEdge: db.prepare(`
      INSERT OR IGNORE INTO syntax_import_edges(file_path, imported_path, line, source)
      VALUES(?, ?, ?, ?)
    `),
    insertCallEdge: db.prepare(`
      INSERT OR IGNORE INTO syntax_call_edges(file_path, callee, line)
      VALUES(?, ?, ?)
    `),
    countFiles: db.prepare(`
      SELECT COUNT(*) AS count FROM syntax_files
    `),
    countImportEdges: db.prepare(`
      SELECT COUNT(*) AS count FROM syntax_import_edges
    `),
    countCallEdges: db.prepare(`
      SELECT COUNT(*) AS count FROM syntax_call_edges
    `),
    topCallers: db.prepare(`
      SELECT file_path, COUNT(*) AS count
      FROM syntax_call_edges
      GROUP BY file_path
      ORDER BY count DESC, file_path ASC
      LIMIT ?
    `),
    topImported: db.prepare(`
      SELECT imported_path, COUNT(*) AS count
      FROM syntax_import_edges
      GROUP BY imported_path
      ORDER BY count DESC, imported_path ASC
      LIMIT ?
    `),
    latestRun: db.prepare(`
      SELECT *
      FROM syntax_runs
      ORDER BY id DESC
      LIMIT 1
    `),
    insertRun: db.prepare(`
      INSERT INTO syntax_runs(
        started_at, completed_at, mode, parsed_files, reused_files, removed_files, skipped_files,
        error_count, total_files, total_import_edges, total_call_edges, provider, parser_version,
        config_json, error
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

async function checkIndexExists(workspaceRoot) {
  return fs
    .access(indexDbPath(workspaceRoot))
    .then(() => true)
    .catch(() => false);
}

async function readTextFile(fullPath) {
  const content = await fs.readFile(fullPath, "utf8");
  if (content.includes("\0")) {
    throw new Error("binary file");
  }
  return content;
}

function deleteSyntaxForFile(statements, relativePath) {
  statements.deleteImportEdgesByFile.run(relativePath);
  statements.deleteCallEdgesByFile.run(relativePath);
  statements.deleteSyntaxFile.run(relativePath);
}

async function upsertFileSyntax(workspaceRoot, statements, fileRow, config) {
  const relativePath = fileRow.path;
  const fullPath = resolveSafePath(workspaceRoot, relativePath);
  const stat = await fs.stat(fullPath);
  const content = await readTextFile(fullPath);
  const hash = hashContent(content);
  const lang = fileRow.lang || detectLanguageByPath(relativePath);
  const summary = buildSyntaxSummary(relativePath, content, config.max_calls_per_file);
  const updatedAt = new Date().toISOString();

  deleteSyntaxForFile(statements, relativePath);
  statements.upsertSyntaxFile.run(
    relativePath,
    lang,
    hash,
    stat.mtimeMs,
    stat.size,
    summary.line_count,
    summary.node_count,
    summary.import_count,
    summary.call_count,
    SYNTAX_PROVIDER,
    SYNTAX_PARSER_VERSION,
    summary.tree_fingerprint,
    summary.ast_json,
    updatedAt
  );

  for (const edge of summary.imports) {
    statements.insertImportEdge.run(relativePath, edge.imported_path, edge.line, edge.source);
  }
  for (const call of summary.calls) {
    statements.insertCallEdge.run(relativePath, call.callee, call.line);
  }

  return {
    hash,
    mtime_ms: stat.mtimeMs,
    size: stat.size
  };
}

export async function buildSyntaxIndex(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const config = resolveConfig(args);
  const db = openDb(workspaceRoot);
  ensureSyntaxSchema(db);
  const statements = buildStatements(db);
  const startedAt = new Date().toISOString();

  let parsedFiles = 0;
  let skippedFiles = 0;
  let errorCount = 0;
  try {
    const fileRows = statements.selectIndexFiles.all(config.max_files);
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`
        DELETE FROM syntax_import_edges;
        DELETE FROM syntax_call_edges;
        DELETE FROM syntax_files;
      `);

      for (const fileRow of fileRows) {
        try {
          await upsertFileSyntax(workspaceRoot, statements, fileRow, config);
          parsedFiles += 1;
        } catch {
          skippedFiles += 1;
          errorCount += 1;
          if (errorCount >= config.max_errors) {
            break;
          }
        }
      }

      const completedAt = new Date().toISOString();
      const totalFiles = Number(statements.countFiles.get().count || 0);
      const totalImports = Number(statements.countImportEdges.get().count || 0);
      const totalCalls = Number(statements.countCallEdges.get().count || 0);
      statements.insertRun.run(
        startedAt,
        completedAt,
        "full",
        parsedFiles,
        0,
        0,
        skippedFiles,
        errorCount,
        totalFiles,
        totalImports,
        totalCalls,
        SYNTAX_PROVIDER,
        SYNTAX_PARSER_VERSION,
        JSON.stringify(config),
        null
      );
      db.exec("COMMIT;");

      return {
        ok: true,
        mode: "full",
        provider: SYNTAX_PROVIDER,
        parser_version: SYNTAX_PARSER_VERSION,
        index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
        parsed_files: parsedFiles,
        reused_files: 0,
        removed_files: 0,
        skipped_files: skippedFiles,
        error_count: errorCount,
        total_files: totalFiles,
        total_import_edges: totalImports,
        total_call_edges: totalCalls
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function refreshSyntaxIndex(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const config = resolveConfig(args);
  const changedPaths = parsePathList(workspaceRoot, args.changed_paths);
  const deletedPaths = parsePathList(workspaceRoot, args.deleted_paths);
  const eventMode = changedPaths.length > 0 || deletedPaths.length > 0;

  const db = openDb(workspaceRoot);
  ensureSyntaxSchema(db);
  const statements = buildStatements(db);
  const startedAt = new Date().toISOString();
  let parsedFiles = 0;
  let reusedFiles = 0;
  let removedFiles = 0;
  let skippedFiles = 0;
  let errorCount = 0;

  try {
    const indexFiles = statements.selectIndexFiles.all(config.max_files);
    const indexFileMap = new Map(indexFiles.map((row) => [row.path, row]));
    const syntaxFiles = statements.selectSyntaxFiles.all();
    const syntaxFileMap = new Map(syntaxFiles.map((row) => [row.path, row]));

    db.exec("BEGIN IMMEDIATE;");
    try {
      const parseCandidates = [];
      const removeCandidates = new Set();

      if (eventMode) {
        for (const p of deletedPaths) {
          removeCandidates.add(p);
        }
        for (const p of changedPaths) {
          if (!indexFileMap.has(p)) {
            removeCandidates.add(p);
            continue;
          }
          parseCandidates.push(indexFileMap.get(p));
        }
      } else {
        for (const existing of syntaxFiles) {
          if (!indexFileMap.has(existing.path)) {
            removeCandidates.add(existing.path);
          }
        }
        for (const fileRow of indexFiles) {
          const existing = syntaxFileMap.get(fileRow.path);
          if (!existing) {
            parseCandidates.push(fileRow);
            continue;
          }
          const unchanged =
            Number(existing.size || 0) === Number(fileRow.size || 0) &&
            Math.abs(Number(existing.mtime_ms || 0) - Number(fileRow.mtime_ms || 0)) < 1;
          if (unchanged) {
            reusedFiles += 1;
            continue;
          }
          parseCandidates.push(fileRow);
        }
      }

      for (const filePath of removeCandidates) {
        if (!syntaxFileMap.has(filePath)) {
          continue;
        }
        deleteSyntaxForFile(statements, filePath);
        removedFiles += 1;
      }

      for (const fileRow of parseCandidates) {
        try {
          await upsertFileSyntax(workspaceRoot, statements, fileRow, config);
          parsedFiles += 1;
        } catch {
          skippedFiles += 1;
          errorCount += 1;
          if (syntaxFileMap.has(fileRow.path)) {
            deleteSyntaxForFile(statements, fileRow.path);
            removedFiles += 1;
          }
          if (errorCount >= config.max_errors) {
            break;
          }
        }
      }

      const completedAt = new Date().toISOString();
      const totalFiles = Number(statements.countFiles.get().count || 0);
      const totalImports = Number(statements.countImportEdges.get().count || 0);
      const totalCalls = Number(statements.countCallEdges.get().count || 0);
      statements.insertRun.run(
        startedAt,
        completedAt,
        eventMode ? "event" : "incremental",
        parsedFiles,
        reusedFiles,
        removedFiles,
        skippedFiles,
        errorCount,
        totalFiles,
        totalImports,
        totalCalls,
        SYNTAX_PROVIDER,
        SYNTAX_PARSER_VERSION,
        JSON.stringify({
          ...config,
          changed_paths: changedPaths,
          deleted_paths: deletedPaths
        }),
        null
      );
      db.exec("COMMIT;");

      return {
        ok: true,
        mode: eventMode ? "event" : "incremental",
        provider: SYNTAX_PROVIDER,
        parser_version: SYNTAX_PARSER_VERSION,
        index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
        parsed_files: parsedFiles,
        reused_files: reusedFiles,
        removed_files: removedFiles,
        skipped_files: skippedFiles,
        error_count: errorCount,
        changed_paths: changedPaths,
        deleted_paths: deletedPaths,
        total_files: totalFiles,
        total_import_edges: totalImports,
        total_call_edges: totalCalls
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function getSyntaxIndexStats(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const db = openDb(workspaceRoot);
  ensureSyntaxSchema(db);
  const statements = buildStatements(db);
  const topN = parsePositiveInt(args.top_files, 10, 1, 50);
  try {
    const totalFiles = Number(statements.countFiles.get().count || 0);
    const totalImports = Number(statements.countImportEdges.get().count || 0);
    const totalCalls = Number(statements.countCallEdges.get().count || 0);
    const topCallers = statements.topCallers.all(topN).map((row) => ({
      path: row.file_path,
      call_count: Number(row.count || 0)
    }));
    const topImported = statements.topImported.all(topN).map((row) => ({
      imported_path: row.imported_path,
      count: Number(row.count || 0)
    }));
    const latestRunRaw = statements.latestRun.get();
    const latestRun = latestRunRaw
      ? {
          started_at: latestRunRaw.started_at,
          completed_at: latestRunRaw.completed_at,
          mode: latestRunRaw.mode,
          parsed_files: Number(latestRunRaw.parsed_files || 0),
          reused_files: Number(latestRunRaw.reused_files || 0),
          removed_files: Number(latestRunRaw.removed_files || 0),
          skipped_files: Number(latestRunRaw.skipped_files || 0),
          error_count: Number(latestRunRaw.error_count || 0),
          provider: latestRunRaw.provider,
          parser_version: latestRunRaw.parser_version,
          error: latestRunRaw.error || null
        }
      : null;

    return {
      ok: true,
      provider: SYNTAX_PROVIDER,
      parser_version: SYNTAX_PARSER_VERSION,
      index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
      counts: {
        files: totalFiles,
        import_edges: totalImports,
        call_edges: totalCalls
      },
      top_callers: topCallers,
      top_imported: topImported,
      latest_run: latestRun
    };
  } finally {
    db.close();
  }
}
