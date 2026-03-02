import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const SYNTAX_PROVIDER_SKELETON = "tree-sitter-skeleton";
const SYNTAX_PROVIDER_TREE_SITTER = "tree-sitter";
const SYNTAX_PARSER_VERSION_SKELETON = "skeleton-v1";
const SYNTAX_PARSER_VERSION_TREE_SITTER = "ts-v1";
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_CALLS_PER_FILE = 400;
const DEFAULT_MAX_ERRORS = 80;
const DEFAULT_QUERY_TOP_K = 5;
const DEFAULT_QUERY_MAX_NEIGHBORS = 8;
const DEFAULT_QUERY_SCAN_FACTOR = 8;
const DEFAULT_PARSER_PROVIDER = "skeleton";
const MAX_FILES_LIMIT = 20_000;
const MAX_CALLS_LIMIT = 2000;
const MAX_ERRORS_LIMIT = 1000;
const MAX_QUERY_TOP_K = 30;
const MAX_QUERY_MAX_NEIGHBORS = 100;
const MAX_QUERY_SCAN_LIMIT = 400;

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

function normalizeQueryToken(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isIdentifierToken(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
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
  const requestedProviderRaw =
    typeof args.parser_provider === "string" && args.parser_provider.trim().length > 0
      ? args.parser_provider.trim().toLowerCase()
      : DEFAULT_PARSER_PROVIDER;
  const parserProvider = ["tree-sitter", "skeleton", "auto"].includes(requestedProviderRaw)
    ? requestedProviderRaw
    : DEFAULT_PARSER_PROVIDER;
  return {
    max_files: parsePositiveInt(args.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_LIMIT),
    max_calls_per_file: parsePositiveInt(
      args.max_calls_per_file,
      DEFAULT_MAX_CALLS_PER_FILE,
      1,
      MAX_CALLS_LIMIT
    ),
    max_errors: parsePositiveInt(args.max_errors, DEFAULT_MAX_ERRORS, 1, MAX_ERRORS_LIMIT),
    parser_provider: parserProvider,
    parser_strict: parseBoolean(args.parser_strict, false)
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
    parser: SYNTAX_PARSER_VERSION_SKELETON,
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
    provider: SYNTAX_PROVIDER_SKELETON,
    parser_version: SYNTAX_PARSER_VERSION_SKELETON,
    tree_fingerprint: fingerprint,
    imports,
    calls,
    ast_json: JSON.stringify(ast)
  };
}

function dedupeImports(imports) {
  const deduped = new Map();
  for (const item of imports) {
    const key = `${item.imported_path}:${item.line}:${item.source}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

function dedupeCalls(calls) {
  const deduped = new Map();
  for (const item of calls) {
    const key = `${item.callee}:${item.line}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

let treeSitterRuntimePromise;

async function loadLanguageModule(name) {
  try {
    const loaded = await import(name);
    return loaded?.default || loaded || null;
  } catch {
    return null;
  }
}

async function loadTreeSitterRuntime() {
  if (treeSitterRuntimePromise) {
    return treeSitterRuntimePromise;
  }
  treeSitterRuntimePromise = (async () => {
    try {
      const parserModule = await import("tree-sitter");
      const Parser = parserModule?.default || parserModule;
      if (!Parser) {
        return { ok: false, error: "tree-sitter parser module missing default export" };
      }

      const languages = {
        javascript: await loadLanguageModule("tree-sitter-javascript"),
        python: await loadLanguageModule("tree-sitter-python"),
        go: await loadLanguageModule("tree-sitter-go")
      };
      const availableLanguageCount = Object.values(languages).filter(Boolean).length;
      if (availableLanguageCount === 0) {
        return { ok: false, error: "tree-sitter grammars not available" };
      }

      return {
        ok: true,
        Parser,
        languages
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  })();
  return treeSitterRuntimePromise;
}

function collectTreeChildren(node) {
  if (!node) {
    return [];
  }
  if (Array.isArray(node.namedChildren) && node.namedChildren.length > 0) {
    return node.namedChildren;
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    return node.children;
  }
  const children = [];
  const childCount = Number(node.childCount || 0);
  for (let i = 0; i < childCount; i += 1) {
    const child = typeof node.child === "function" ? node.child(i) : null;
    if (child) {
      children.push(child);
    }
  }
  return children;
}

function treeNodeText(content, node) {
  if (!node) {
    return "";
  }
  if (Number.isFinite(node.startIndex) && Number.isFinite(node.endIndex)) {
    return content.slice(Number(node.startIndex), Number(node.endIndex));
  }
  if (typeof node.text === "string") {
    return node.text;
  }
  return "";
}

function extractIdentifierFromCallee(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }
  const normalized = text
    .replace(/\?.*$/, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  const parts = normalized.split(/[.\s:>]+/).filter(Boolean);
  const candidate = parts[parts.length - 1] || normalized;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate)) {
    return candidate;
  }
  return "";
}

function buildTreeSitterSummary(relativePath, content, runtime, language, maxCalls) {
  const parser = new runtime.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  const root = tree?.rootNode;
  if (!root) {
    return null;
  }

  const imports = [];
  const calls = [];
  let nodeCount = 0;
  const blockedCallNames = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "function",
    "return",
    "new"
  ]);

  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    nodeCount += 1;
    const nodeType = String(node.type || "");
    const line = Number(node?.startPosition?.row || 0) + 1;
    const nodeText = treeNodeText(content, node);

    if (nodeType.includes("import")) {
      const stringMatches = Array.from(nodeText.matchAll(/["']([^"']+)["']/g));
      if (stringMatches.length > 0) {
        for (const match of stringMatches) {
          const importedPath = normalizeImportTarget(relativePath, match[1]);
          if (importedPath) {
            imports.push({ imported_path: importedPath, line, source: "ts" });
          }
        }
      } else if (nodeType === "import_from_statement" || nodeType === "import_statement") {
        const pyFromMatch = nodeText.match(/\bfrom\s+([A-Za-z0-9_.]+)\s+import\b/);
        if (pyFromMatch) {
          imports.push({ imported_path: `pkg:${pyFromMatch[1]}`, line, source: "ts" });
        } else {
          const pyImportMatch = nodeText.match(/\bimport\s+([A-Za-z0-9_.]+)/);
          if (pyImportMatch) {
            imports.push({ imported_path: `pkg:${pyImportMatch[1]}`, line, source: "ts" });
          }
        }
      }
    }

    if (nodeType === "call_expression" || nodeType === "call") {
      let functionNode = null;
      if (typeof node.childForFieldName === "function") {
        functionNode = node.childForFieldName("function");
      }
      if (!functionNode) {
        const children = collectTreeChildren(node);
        functionNode = children[0] || null;
      }
      const callee = extractIdentifierFromCallee(treeNodeText(content, functionNode));
      if (callee && !blockedCallNames.has(callee)) {
        calls.push({ callee, line });
      }
    }

    const children = collectTreeChildren(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }

  const dedupedImports = dedupeImports(imports);
  const dedupedCalls = dedupeCalls(calls).slice(0, maxCalls);
  const lines = splitLines(content);
  const lineCount = lines.length;
  const fingerprint = hashContent(
    JSON.stringify({
      path: relativePath,
      imports: dedupedImports,
      calls: dedupedCalls,
      node_count: nodeCount,
      line_count: lineCount
    })
  );
  return {
    line_count: lineCount,
    node_count: Math.max(1, nodeCount),
    import_count: dedupedImports.length,
    call_count: dedupedCalls.length,
    provider: SYNTAX_PROVIDER_TREE_SITTER,
    parser_version: SYNTAX_PARSER_VERSION_TREE_SITTER,
    tree_fingerprint: fingerprint,
    imports: dedupedImports,
    calls: dedupedCalls,
    ast_json: JSON.stringify({
      parser: SYNTAX_PARSER_VERSION_TREE_SITTER,
      provider: SYNTAX_PROVIDER_TREE_SITTER,
      node_count: Math.max(1, nodeCount),
      line_count: lineCount,
      imports: dedupedImports,
      calls: dedupedCalls
    })
  };
}

async function buildSyntaxSummaryWithProvider(relativePath, content, config) {
  const lang = detectLanguageByPath(relativePath);
  const requested = config.parser_provider;

  if (requested === "skeleton") {
    return {
      summary: buildSyntaxSummary(relativePath, content, config.max_calls_per_file),
      parser_info: {
        requested,
        actual: SYNTAX_PROVIDER_SKELETON,
        fallback_used: false,
        fallback_reason: null
      }
    };
  }

  const runtime = await loadTreeSitterRuntime();
  const language = runtime?.ok ? runtime.languages?.[lang] : null;
  if (runtime?.ok && language) {
    const tsSummary = buildTreeSitterSummary(relativePath, content, runtime, language, config.max_calls_per_file);
    if (tsSummary) {
      return {
        summary: tsSummary,
        parser_info: {
          requested,
          actual: SYNTAX_PROVIDER_TREE_SITTER,
          fallback_used: false,
          fallback_reason: null
        }
      };
    }
  }

  if (requested === "tree-sitter" && config.parser_strict) {
    throw new Error(`tree-sitter parser unavailable for ${relativePath}: ${runtime?.error || "language grammar missing"}`);
  }

  return {
    summary: buildSyntaxSummary(relativePath, content, config.max_calls_per_file),
    parser_info: {
      requested,
      actual: SYNTAX_PROVIDER_SKELETON,
      fallback_used: true,
      fallback_reason: runtime?.error || `language grammar missing for ${lang}`
    }
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
    selectQuerySeeds: db.prepare(`
      SELECT
        sf.path,
        sf.lang,
        sf.line_count,
        sf.node_count,
        sf.import_count,
        sf.call_count
      FROM syntax_files sf
      WHERE (
        sf.path LIKE ?
        OR EXISTS (
          SELECT 1
          FROM syntax_import_edges sie
          WHERE sie.file_path = sf.path
            AND sie.imported_path LIKE ?
        )
        OR EXISTS (
          SELECT 1
          FROM syntax_call_edges sce
          WHERE sce.file_path = sf.path
            AND sce.callee LIKE ?
        )
      )
        AND (? IS NULL OR sf.path LIKE ?)
      ORDER BY
        CASE
          WHEN sf.path = ? THEN 0
          WHEN sf.path LIKE ? THEN 1
          WHEN sf.path LIKE ? THEN 2
          ELSE 3
        END,
        (sf.import_count + sf.call_count) DESC,
        sf.path ASC
      LIMIT ?
    `),
    selectOutgoingImportsByFile: db.prepare(`
      SELECT imported_path, line, source
      FROM syntax_import_edges
      WHERE file_path = ?
      ORDER BY line ASC, imported_path ASC
      LIMIT ?
    `),
    selectIncomingImportersByTarget: db.prepare(`
      SELECT file_path, imported_path, line, source
      FROM syntax_import_edges
      WHERE imported_path = ?
      ORDER BY file_path ASC, line ASC
      LIMIT ?
    `),
    selectOutgoingCallsByFile: db.prepare(`
      SELECT callee, line
      FROM syntax_call_edges
      WHERE file_path = ?
      ORDER BY line ASC, callee ASC
      LIMIT ?
    `),
    selectIncomingCallersByCallee: db.prepare(`
      SELECT file_path, callee, line
      FROM syntax_call_edges
      WHERE callee = ?
      ORDER BY file_path ASC, line ASC
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

function buildImportPathCandidates(filePath) {
  const normalized = normalizeQueryToken(filePath);
  if (!normalized) {
    return [];
  }

  const candidates = new Set([normalized]);
  const ext = path.posix.extname(normalized);
  if (ext) {
    const withoutExt = normalized.slice(0, -ext.length);
    candidates.add(withoutExt);
    if (path.posix.basename(normalized, ext) === "index") {
      const dirPath = path.posix.dirname(normalized);
      if (dirPath && dirPath !== ".") {
        candidates.add(dirPath);
      }
    }
  }

  return Array.from(candidates);
}

function dedupeRows(rows, keyFn) {
  const deduped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

function createParserSummary(config) {
  return {
    requested: config.parser_provider,
    actual: SYNTAX_PROVIDER_SKELETON,
    fallback_used: false,
    fallback_reasons: [],
    provider_counts: {}
  };
}

function parserVersionForProvider(provider) {
  if (provider === SYNTAX_PROVIDER_TREE_SITTER) {
    return SYNTAX_PARSER_VERSION_TREE_SITTER;
  }
  return SYNTAX_PARSER_VERSION_SKELETON;
}

function updateParserSummary(summary, parserInfo) {
  if (!parserInfo) {
    return;
  }
  const actual = parserInfo.actual || SYNTAX_PROVIDER_SKELETON;
  summary.actual = actual;
  summary.provider_counts[actual] = Number(summary.provider_counts[actual] || 0) + 1;
  if (parserInfo.fallback_used) {
    summary.fallback_used = true;
    if (
      typeof parserInfo.fallback_reason === "string" &&
      parserInfo.fallback_reason.trim().length > 0 &&
      !summary.fallback_reasons.includes(parserInfo.fallback_reason)
    ) {
      summary.fallback_reasons.push(parserInfo.fallback_reason);
    }
  }
}

async function upsertFileSyntax(workspaceRoot, statements, fileRow, config) {
  const relativePath = fileRow.path;
  const fullPath = resolveSafePath(workspaceRoot, relativePath);
  const stat = await fs.stat(fullPath);
  const content = await readTextFile(fullPath);
  const hash = hashContent(content);
  const lang = fileRow.lang || detectLanguageByPath(relativePath);
  const { summary, parser_info: parserInfo } = await buildSyntaxSummaryWithProvider(
    relativePath,
    content,
    config
  );
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
    summary.provider,
    summary.parser_version,
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
    size: stat.size,
    parser_info: parserInfo
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
  const parserSummary = createParserSummary(config);

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
          const parseResult = await upsertFileSyntax(workspaceRoot, statements, fileRow, config);
          updateParserSummary(parserSummary, parseResult.parser_info);
          parsedFiles += 1;
        } catch (error) {
          if (
            config.parser_strict &&
            /tree-sitter parser unavailable/i.test(String(error?.message || error))
          ) {
            throw error;
          }
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
        parserSummary.actual,
        parserVersionForProvider(parserSummary.actual),
        JSON.stringify(config),
        null
      );
      db.exec("COMMIT;");

      return {
        ok: true,
        mode: "full",
        provider: parserSummary.actual,
        parser_version: parserVersionForProvider(parserSummary.actual),
        parser: parserSummary,
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
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      mode: "full",
      provider: parserSummary.actual,
      parser_version: parserVersionForProvider(parserSummary.actual),
      parser: parserSummary
    };
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
  const parserSummary = createParserSummary(config);
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
          const parseResult = await upsertFileSyntax(workspaceRoot, statements, fileRow, config);
          updateParserSummary(parserSummary, parseResult.parser_info);
          parsedFiles += 1;
        } catch (error) {
          if (
            config.parser_strict &&
            /tree-sitter parser unavailable/i.test(String(error?.message || error))
          ) {
            throw error;
          }
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
        parserSummary.actual,
        parserVersionForProvider(parserSummary.actual),
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
        provider: parserSummary.actual,
        parser_version: parserVersionForProvider(parserSummary.actual),
        parser: parserSummary,
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
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      mode: eventMode ? "event" : "incremental",
      provider: parserSummary.actual,
      parser_version: parserVersionForProvider(parserSummary.actual),
      parser: parserSummary
    };
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

    const statsProvider = latestRun?.provider || SYNTAX_PROVIDER_SKELETON;
    return {
      ok: true,
      provider: statsProvider,
      parser_version: latestRun?.parser_version || parserVersionForProvider(statsProvider),
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

export async function querySyntaxIndex(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const query = normalizeQueryToken(args.query);
  if (!query) {
    return {
      ok: false,
      error: "query must be a non-empty string"
    };
  }

  const topK = parsePositiveInt(args.top_k, DEFAULT_QUERY_TOP_K, 1, MAX_QUERY_TOP_K);
  const maxNeighbors = parsePositiveInt(
    args.max_neighbors,
    DEFAULT_QUERY_MAX_NEIGHBORS,
    1,
    MAX_QUERY_MAX_NEIGHBORS
  );
  const pathPrefix = normalizePathPrefix(args.path_prefix);
  const pathLike = pathPrefix ? `${pathPrefix}%` : null;
  const seedScanLimit = Math.min(MAX_QUERY_SCAN_LIMIT, Math.max(topK, topK * DEFAULT_QUERY_SCAN_FACTOR));
  const queryLike = `%${query}%`;
  const pathQuery = normalizeQueryToken(query);

  const db = openDb(workspaceRoot);
  ensureSyntaxSchema(db);
  const statements = buildStatements(db);
  try {
    const totalFiles = Number(statements.countFiles.get().count || 0);
    if (totalFiles === 0) {
      return {
        ok: false,
        error: "syntax index is empty; run build_syntax_index first"
      };
    }

    const latestRun = statements.latestRun.get();
    const provider = latestRun?.provider || SYNTAX_PROVIDER_SKELETON;
    const parserVersion = latestRun?.parser_version || parserVersionForProvider(provider);

    const rawSeeds = statements.selectQuerySeeds.all(
      queryLike,
      queryLike,
      queryLike,
      pathPrefix,
      pathLike,
      pathQuery,
      `${pathQuery}%`,
      `%${pathQuery}%`,
      seedScanLimit
    );

    const seeds = [];
    for (const seed of rawSeeds.slice(0, topK)) {
      const outgoingImports = statements
        .selectOutgoingImportsByFile
        .all(seed.path, maxNeighbors)
        .map((row) => ({
          imported_path: row.imported_path,
          line: Number(row.line || 1),
          source: row.source,
          external: String(row.imported_path || "").startsWith("pkg:")
        }));

      const incomingImportRows = [];
      for (const candidate of buildImportPathCandidates(seed.path)) {
        incomingImportRows.push(
          ...statements.selectIncomingImportersByTarget.all(candidate, maxNeighbors)
        );
      }
      const incomingImporters = dedupeRows(
        incomingImportRows,
        (row) => `${row.file_path}:${row.imported_path}:${row.line}:${row.source}`
      )
        .sort((a, b) => {
          const pathCompare = String(a.file_path || "").localeCompare(String(b.file_path || ""));
          if (pathCompare !== 0) {
            return pathCompare;
          }
          return Number(a.line || 1) - Number(b.line || 1);
        })
        .slice(0, maxNeighbors)
        .map((row) => ({
          file_path: row.file_path,
          imported_path: row.imported_path,
          line: Number(row.line || 1),
          source: row.source
        }));

      const outgoingCalls = statements
        .selectOutgoingCallsByFile
        .all(seed.path, maxNeighbors)
        .map((row) => ({
          callee: row.callee,
          line: Number(row.line || 1)
        }));

      const callTargets = new Set();
      const fileStem = path.posix.basename(seed.path, path.posix.extname(seed.path));
      if (isIdentifierToken(fileStem)) {
        callTargets.add(fileStem);
      }
      if (isIdentifierToken(query)) {
        callTargets.add(query);
      }

      const incomingCallRows = [];
      for (const callee of callTargets) {
        incomingCallRows.push(...statements.selectIncomingCallersByCallee.all(callee, maxNeighbors));
      }
      const incomingCallers = dedupeRows(
        incomingCallRows,
        (row) => `${row.file_path}:${row.callee}:${row.line}`
      )
        .sort((a, b) => {
          const pathCompare = String(a.file_path || "").localeCompare(String(b.file_path || ""));
          if (pathCompare !== 0) {
            return pathCompare;
          }
          const calleeCompare = String(a.callee || "").localeCompare(String(b.callee || ""));
          if (calleeCompare !== 0) {
            return calleeCompare;
          }
          return Number(a.line || 1) - Number(b.line || 1);
        })
        .slice(0, maxNeighbors)
        .map((row) => ({
          file_path: row.file_path,
          callee: row.callee,
          line: Number(row.line || 1)
        }));

      seeds.push({
        path: seed.path,
        lang: seed.lang || null,
        line_count: Number(seed.line_count || 0),
        node_count: Number(seed.node_count || 0),
        import_count: Number(seed.import_count || 0),
        call_count: Number(seed.call_count || 0),
        outgoing_imports: outgoingImports,
        incoming_importers: incomingImporters,
        outgoing_calls: outgoingCalls,
        incoming_callers: incomingCallers
      });
    }

    return {
      ok: true,
      query,
      filters: {
        path_prefix: pathPrefix
      },
      provider,
      parser_version: parserVersion,
      scanned_candidates: rawSeeds.length,
      total_seeds: seeds.length,
      seeds
    };
  } finally {
    db.close();
  }
}
