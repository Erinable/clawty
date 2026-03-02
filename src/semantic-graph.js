import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { lspDefinition, lspHealth, lspReferences } from "./lsp-manager.js";

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const DEFAULT_MAX_SYMBOLS = 120;
const DEFAULT_MAX_REFERENCES_PER_SYMBOL = 12;
const DEFAULT_MAX_LSP_ERRORS = 12;
const DEFAULT_MAX_SYNTAX_IMPORT_EDGES = 6000;
const DEFAULT_MAX_SYNTAX_CALL_EDGES = 8000;
const DEFAULT_MAX_IMPORT_NODES = 50_000;
const DEFAULT_MAX_IMPORT_EDGES = 200_000;
const DEFAULT_SEED_SCAN_FACTOR = 8;
const MAX_SEED_SCAN_LIMIT = 400;
const MAX_MAX_SYMBOLS = 5000;
const MAX_MAX_REFERENCES = 200;
const MAX_MAX_LSP_ERRORS = 200;
const MAX_MAX_SYNTAX_EDGES = 200_000;
const MAX_IMPORT_NODES = 500_000;
const MAX_IMPORT_EDGES = 1_000_000;
const SOURCE_PRIORITY_ORDER = Object.freeze([
  "scip",
  "lsif",
  "lsp",
  "syntax",
  "index_seed",
  "lsp_anchor"
]);
const IMPORT_PATH_EXTENSION_CANDIDATES = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go"
]);
const PRECISE_INDEX_DEFAULT_CANDIDATES = Object.freeze([
  "artifacts/scip.normalized.json",
  ".clawty/scip.normalized.json",
  "scip.normalized.json"
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

function resolveConfig(args = {}) {
  const precisePathCandidates = [];
  const addCandidate = (value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    const normalized = toPosixPath(value.trim());
    if (!precisePathCandidates.includes(normalized)) {
      precisePathCandidates.push(normalized);
    }
  };

  addCandidate(args.precise_index_path);
  if (Array.isArray(args.precise_index_paths)) {
    for (const item of args.precise_index_paths) {
      addCandidate(item);
    }
  }
  for (const candidate of PRECISE_INDEX_DEFAULT_CANDIDATES) {
    addCandidate(candidate);
  }

  return {
    max_symbols: parsePositiveInt(args.max_symbols, DEFAULT_MAX_SYMBOLS, 1, MAX_MAX_SYMBOLS),
    max_references_per_symbol: parsePositiveInt(
      args.max_references_per_symbol,
      DEFAULT_MAX_REFERENCES_PER_SYMBOL,
      1,
      MAX_MAX_REFERENCES
    ),
    max_lsp_errors: parsePositiveInt(
      args.max_lsp_errors,
      DEFAULT_MAX_LSP_ERRORS,
      1,
      MAX_MAX_LSP_ERRORS
    ),
    include_definitions: parseBoolean(args.include_definitions, true),
    include_references: parseBoolean(args.include_references, true),
    include_syntax: parseBoolean(args.include_syntax, true),
    lsp_required: parseBoolean(args.lsp_required, false),
    max_syntax_import_edges: parsePositiveInt(
      args.max_syntax_import_edges,
      DEFAULT_MAX_SYNTAX_IMPORT_EDGES,
      1,
      MAX_MAX_SYNTAX_EDGES
    ),
    max_syntax_call_edges: parsePositiveInt(
      args.max_syntax_call_edges,
      DEFAULT_MAX_SYNTAX_CALL_EDGES,
      1,
      MAX_MAX_SYNTAX_EDGES
    ),
    precise_preferred: parseBoolean(args.precise_preferred, true),
    precise_required: parseBoolean(args.precise_required, false),
    precise_source:
      typeof args.precise_source === "string" && args.precise_source.trim().length > 0
        ? args.precise_source.trim().toLowerCase()
        : "scip",
    precise_mode: args.precise_mode === "merge" ? "merge" : "replace",
    precise_max_nodes: parsePositiveInt(
      args.precise_max_nodes,
      DEFAULT_MAX_IMPORT_NODES,
      1,
      MAX_IMPORT_NODES
    ),
    precise_max_edges: parsePositiveInt(
      args.precise_max_edges,
      DEFAULT_MAX_IMPORT_EDGES,
      1,
      MAX_IMPORT_EDGES
    ),
    precise_index_paths: precisePathCandidates
  };
}

function normalizeGraphPath(workspaceRoot, inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return null;
  }

  const root = path.resolve(workspaceRoot);
  const maybePath = inputPath.trim();

  if (path.isAbsolute(maybePath)) {
    const absolute = path.resolve(maybePath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      return null;
    }
    return toPosixPath(path.relative(root, absolute));
  }

  const fullPath = path.resolve(root, maybePath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return toPosixPath(path.relative(root, fullPath));
}

function inferLangFromPath(relativePath) {
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
  return "text";
}

function makeSymbolStableKey(node) {
  return `symbol:${node.path}:${node.line}:${node.column}:${node.kind}:${node.name}`;
}

function makeAnchorStableKey(pathValue, line, column) {
  return `anchor:${pathValue}:${line}:${column}`;
}

function normalizeEdgeType(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) {
    return "reference";
  }
  if (!/^[a-z][a-z0-9_:-]{0,63}$/.test(raw)) {
    return "reference";
  }
  return raw;
}

function openDb(workspaceRoot) {
  const dbPath = indexDbPath(workspaceRoot);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

function ensureSemanticSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      name_lc TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      column INTEGER NOT NULL DEFAULT 1,
      lang TEXT,
      source TEXT NOT NULL,
      stable_key TEXT NOT NULL UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_nodes_path_line ON semantic_nodes(path, line);
    CREATE INDEX IF NOT EXISTS idx_semantic_nodes_name_lc ON semantic_nodes(name_lc);
    CREATE INDEX IF NOT EXISTS idx_semantic_nodes_kind ON semantic_nodes(kind);

    CREATE TABLE IF NOT EXISTS semantic_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node_id INTEGER NOT NULL,
      to_node_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL,
      source TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      UNIQUE(from_node_id, to_node_id, edge_type, source),
      FOREIGN KEY(from_node_id) REFERENCES semantic_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY(to_node_id) REFERENCES semantic_nodes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_edges_from_node_id ON semantic_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_to_node_id ON semantic_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_type ON semantic_edges(edge_type);

    CREATE TABLE IF NOT EXISTS semantic_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      scanned_symbols INTEGER NOT NULL,
      seeded_nodes INTEGER NOT NULL,
      total_nodes INTEGER NOT NULL,
      total_edges INTEGER NOT NULL,
      lsp_available INTEGER NOT NULL,
      lsp_enriched_symbols INTEGER NOT NULL,
      lsp_error_count INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_runs_completed_at ON semantic_runs(completed_at);
  `);
}

function clearSemanticGraph(db) {
  db.exec(`
    DELETE FROM semantic_edges;
    DELETE FROM semantic_nodes;
  `);
}

function buildStatements(db) {
  return {
    selectSeedSymbols: db.prepare(`
      SELECT s.file_path AS path, s.name, s.kind, s.start_line AS line, f.lang
      FROM symbols s
      JOIN files f ON f.path = s.file_path
      WHERE f.lang = 'javascript'
      ORDER BY s.file_path ASC, s.start_line ASC, s.name ASC
      LIMIT ?
    `),
    insertNode: db.prepare(`
      INSERT OR IGNORE INTO semantic_nodes(path, name, name_lc, kind, line, column, lang, source, stable_key)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectNodeIdByStableKey: db.prepare(`
      SELECT id FROM semantic_nodes WHERE stable_key = ?
    `),
    selectNearestNodeByPathLine: db.prepare(`
      SELECT id, line
      FROM semantic_nodes
      WHERE path = ?
      ORDER BY ABS(line - ?), id ASC
      LIMIT 1
    `),
    insertEdge: db.prepare(`
      INSERT OR IGNORE INTO semantic_edges(from_node_id, to_node_id, edge_type, source, weight)
      VALUES(?, ?, ?, ?, ?)
    `),
    countNodes: db.prepare(`
      SELECT COUNT(*) AS count FROM semantic_nodes
    `),
    countEdges: db.prepare(`
      SELECT COUNT(*) AS count FROM semantic_edges
    `),
    edgeTypeCounts: db.prepare(`
      SELECT edge_type, COUNT(*) AS count
      FROM semantic_edges
      GROUP BY edge_type
      ORDER BY count DESC, edge_type ASC
    `),
    nodeSourceCounts: db.prepare(`
      SELECT source, COUNT(*) AS count
      FROM semantic_nodes
      GROUP BY source
      ORDER BY count DESC, source ASC
    `),
    edgeSourceCounts: db.prepare(`
      SELECT source, COUNT(*) AS count
      FROM semantic_edges
      GROUP BY source
      ORDER BY count DESC, source ASC
    `),
    insertRun: db.prepare(`
      INSERT INTO semantic_runs(
        started_at,
        completed_at,
        status,
        scanned_symbols,
        seeded_nodes,
        total_nodes,
        total_edges,
        lsp_available,
        lsp_enriched_symbols,
        lsp_error_count,
        config_json,
        error
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    latestRun: db.prepare(`
      SELECT
        started_at,
        completed_at,
        status,
        scanned_symbols,
        seeded_nodes,
        total_nodes,
        total_edges,
        lsp_available,
        lsp_enriched_symbols,
        lsp_error_count,
        config_json,
        error
      FROM semantic_runs
      ORDER BY id DESC
      LIMIT 1
    `),
    selectQuerySeeds: db.prepare(`
      SELECT id, path, name, name_lc, kind, line, column, lang, source
      FROM semantic_nodes
      WHERE (
        name_lc = ?
        OR name_lc LIKE ?
        OR name_lc LIKE ?
        OR path LIKE ?
      )
        AND (? IS NULL OR path LIKE ?)
      ORDER BY
        CASE
          WHEN name_lc = ? THEN 0
          WHEN name_lc LIKE ? THEN 1
          WHEN path LIKE ? THEN 2
          ELSE 3
        END,
        line ASC,
        path ASC
      LIMIT ?
    `),
    selectOutgoing: db.prepare(`
      SELECT
        e.edge_type,
        e.source AS edge_source,
        e.weight,
        n.path,
        n.name,
        n.kind,
        n.line,
        n.column,
        n.lang,
        n.source AS node_source
      FROM semantic_edges e
      JOIN semantic_nodes n ON n.id = e.to_node_id
      WHERE e.from_node_id = ?
        AND (? IS NULL OR e.edge_type = ?)
      ORDER BY e.edge_type ASC, n.path ASC, n.line ASC
      LIMIT ?
    `),
    selectIncoming: db.prepare(`
      SELECT
        e.edge_type,
        e.source AS edge_source,
        e.weight,
        n.path,
        n.name,
        n.kind,
        n.line,
        n.column,
        n.lang,
        n.source AS node_source
      FROM semantic_edges e
      JOIN semantic_nodes n ON n.id = e.from_node_id
      WHERE e.to_node_id = ?
        AND (? IS NULL OR e.edge_type = ?)
      ORDER BY e.edge_type ASC, n.path ASC, n.line ASC
      LIMIT ?
    `)
  };
}

function hasTable(db, tableName) {
  const row = db
    .prepare(
      `
      SELECT 1 AS ok
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `
    )
    .get(tableName);
  return Boolean(row?.ok);
}

function pushNodeToPathMap(pathMap, node) {
  if (!pathMap.has(node.path)) {
    pathMap.set(node.path, []);
  }
  pathMap.get(node.path).push(node);
}

function getFirstNodeIdFromPathMap(pathMap, pathValue) {
  const nodes = pathMap.get(pathValue);
  if (!nodes || nodes.length === 0) {
    return null;
  }
  return Number(nodes[0].id || 0) || null;
}

function findClosestNodeId(pathMap, pathValue, line) {
  const nodes = pathMap.get(pathValue);
  if (!nodes || nodes.length === 0) {
    return null;
  }

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = Math.abs((Number(node.line) || 1) - (Number(line) || 1));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
      if (distance === 0) {
        break;
      }
    }
  }

  if (!best) {
    return null;
  }
  if (bestDistance > 30) {
    return null;
  }
  return best.id;
}

function resolveImportedNodeId(pathMap, importedPath) {
  if (typeof importedPath !== "string" || importedPath.trim().length === 0) {
    return null;
  }
  const normalized = importedPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("pkg:")) {
    return null;
  }

  const candidates = [normalized];
  for (const ext of IMPORT_PATH_EXTENSION_CANDIDATES) {
    candidates.push(`${normalized}${ext}`);
  }
  for (const ext of IMPORT_PATH_EXTENSION_CANDIDATES) {
    candidates.push(`${normalized}/index${ext}`);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const nodeId = getFirstNodeIdFromPathMap(pathMap, candidate);
    if (nodeId) {
      return nodeId;
    }
  }
  return null;
}

function buildNameNodeMap(nodes) {
  const nameMap = new Map();
  for (const node of nodes) {
    const nameLc = String(node.name || "").toLowerCase();
    if (!nameLc) {
      continue;
    }
    if (!nameMap.has(nameLc)) {
      nameMap.set(nameLc, []);
    }
    nameMap.get(nameLc).push(node);
  }
  return nameMap;
}

function resolveCalleeNodeId(nameMap, callee, filePath) {
  if (typeof callee !== "string" || callee.trim().length === 0) {
    return null;
  }
  const candidates = nameMap.get(callee.trim().toLowerCase());
  if (!candidates || candidates.length === 0) {
    return null;
  }

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const candidateInFile = candidate.path === filePath;
    const bestInFile = best.path === filePath;
    if (candidateInFile && !bestInFile) {
      best = candidate;
      continue;
    }
    if (candidateInFile && bestInFile && Number(candidate.line || 1) < Number(best.line || 1)) {
      best = candidate;
      continue;
    }
    if (!candidateInFile && !bestInFile) {
      const candidatePath = String(candidate.path || "");
      const bestPath = String(best.path || "");
      if (
        candidatePath.localeCompare(bestPath) < 0 ||
        (candidatePath === bestPath && Number(candidate.line || 1) < Number(best.line || 1))
      ) {
        best = candidate;
      }
    }
  }
  return Number(best.id || 0) || null;
}

function ingestSyntaxEdges({ db, statements, pathMap, seededNodes, config }) {
  const result = {
    enabled: Boolean(config.include_syntax),
    available: false,
    import_edges: 0,
    call_edges: 0,
    reused_edges: 0,
    skipped_edges: 0,
    reason: config.include_syntax ? "syntax index tables not found" : "disabled",
    error: null
  };
  if (!config.include_syntax) {
    return result;
  }

  const hasImportTable = hasTable(db, "syntax_import_edges");
  const hasCallTable = hasTable(db, "syntax_call_edges");
  if (!hasImportTable && !hasCallTable) {
    return result;
  }

  const nameMap = buildNameNodeMap(seededNodes);
  result.available = true;
  result.reason = null;

  if (hasImportTable) {
    const selectSyntaxImportEdges = db.prepare(`
      SELECT file_path, imported_path, line
      FROM syntax_import_edges
      ORDER BY file_path ASC, line ASC, imported_path ASC
      LIMIT ?
    `);
    const importRows = selectSyntaxImportEdges.all(config.max_syntax_import_edges);
    for (const row of importRows) {
      const fromNodeId =
        findClosestNodeId(pathMap, row.file_path, Number(row.line || 1)) ||
        getFirstNodeIdFromPathMap(pathMap, row.file_path);
      if (!fromNodeId) {
        result.skipped_edges += 1;
        continue;
      }
      const toNodeId = resolveImportedNodeId(pathMap, row.imported_path);
      if (!toNodeId) {
        result.skipped_edges += 1;
        continue;
      }
      const insertResult = statements.insertEdge.run(fromNodeId, toNodeId, "import", "syntax", 1.5);
      if (Number(insertResult.changes || 0) > 0) {
        result.import_edges += 1;
      } else {
        result.reused_edges += 1;
      }
    }
  }

  if (hasCallTable) {
    const selectSyntaxCallEdges = db.prepare(`
      SELECT file_path, callee, line
      FROM syntax_call_edges
      ORDER BY file_path ASC, line ASC, callee ASC
      LIMIT ?
    `);
    const callRows = selectSyntaxCallEdges.all(config.max_syntax_call_edges);
    for (const row of callRows) {
      const fromNodeId =
        findClosestNodeId(pathMap, row.file_path, Number(row.line || 1)) ||
        getFirstNodeIdFromPathMap(pathMap, row.file_path);
      if (!fromNodeId) {
        result.skipped_edges += 1;
        continue;
      }
      const toNodeId = resolveCalleeNodeId(nameMap, row.callee, row.file_path);
      if (!toNodeId) {
        result.skipped_edges += 1;
        continue;
      }
      const insertResult = statements.insertEdge.run(fromNodeId, toNodeId, "call", "syntax", 1);
      if (Number(insertResult.changes || 0) > 0) {
        result.call_edges += 1;
      } else {
        result.reused_edges += 1;
      }
    }
  }

  return result;
}

function toNeighbor(row) {
  return {
    edge_type: row.edge_type,
    edge_source: row.edge_source,
    weight: Number(row.weight || 0),
    node: {
      path: row.path,
      name: row.name,
      kind: row.kind,
      line: Number(row.line || 1),
      column: Number(row.column || 1),
      lang: row.lang || null,
      source: row.node_source
    }
  };
}

function sourcePriority(source) {
  const normalized =
    typeof source === "string" && source.trim().length > 0
      ? source.trim().toLowerCase()
      : "other";
  const idx = SOURCE_PRIORITY_ORDER.indexOf(normalized);
  return idx >= 0 ? idx : SOURCE_PRIORITY_ORDER.length;
}

function seedDedupKey(seed) {
  return [
    String(seed.path || ""),
    String(seed.kind || ""),
    String(seed.name_lc || String(seed.name || "").toLowerCase()),
    Number(seed.line || 1)
  ].join("::");
}

function seedMatchRank(seed, queryLower) {
  const nameLc = String(seed.name_lc || String(seed.name || "").toLowerCase());
  const pathLc = String(seed.path || "").toLowerCase();
  if (nameLc === queryLower) {
    return 0;
  }
  if (nameLc.startsWith(queryLower)) {
    return 1;
  }
  if (pathLc.includes(queryLower)) {
    return 2;
  }
  return 3;
}

function pickPreferredSeed(existing, candidate, queryLower) {
  const existingRank = seedMatchRank(existing, queryLower);
  const candidateRank = seedMatchRank(candidate, queryLower);
  if (candidateRank < existingRank) {
    return candidate;
  }
  if (candidateRank > existingRank) {
    return existing;
  }

  const existingSourceRank = sourcePriority(existing.source);
  const candidateSourceRank = sourcePriority(candidate.source);
  if (candidateSourceRank < existingSourceRank) {
    return candidate;
  }
  if (candidateSourceRank > existingSourceRank) {
    return existing;
  }

  return existing;
}

function sortSeedsByPriority(a, b, queryLower) {
  const rankA = seedMatchRank(a, queryLower);
  const rankB = seedMatchRank(b, queryLower);
  if (rankA !== rankB) {
    return rankA - rankB;
  }

  const sourceA = sourcePriority(a.source);
  const sourceB = sourcePriority(b.source);
  if (sourceA !== sourceB) {
    return sourceA - sourceB;
  }

  const lineA = Number(a.line || 1);
  const lineB = Number(b.line || 1);
  if (lineA !== lineB) {
    return lineA - lineB;
  }

  return String(a.path || "").localeCompare(String(b.path || ""));
}

function neighborDedupKey(row) {
  return [
    String(row.edge_type || ""),
    String(row.path || ""),
    String(row.kind || ""),
    String(row.name || ""),
    Number(row.line || 1),
    Number(row.column || 1)
  ].join("::");
}

function pickPreferredNeighbor(existing, candidate) {
  const existingEdgeSourceRank = sourcePriority(existing.edge_source);
  const candidateEdgeSourceRank = sourcePriority(candidate.edge_source);
  if (candidateEdgeSourceRank < existingEdgeSourceRank) {
    return candidate;
  }
  if (candidateEdgeSourceRank > existingEdgeSourceRank) {
    return existing;
  }

  const existingNodeSourceRank = sourcePriority(existing.node_source);
  const candidateNodeSourceRank = sourcePriority(candidate.node_source);
  if (candidateNodeSourceRank < existingNodeSourceRank) {
    return candidate;
  }
  if (candidateNodeSourceRank > existingNodeSourceRank) {
    return existing;
  }

  if (Number(candidate.weight || 0) > Number(existing.weight || 0)) {
    return candidate;
  }
  return existing;
}

function dedupeNeighborRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = neighborDedupKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    byKey.set(key, pickPreferredNeighbor(existing, row));
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const sourceA = sourcePriority(a.edge_source);
    const sourceB = sourcePriority(b.edge_source);
    if (sourceA !== sourceB) {
      return sourceA - sourceB;
    }
    const edgeCompare = String(a.edge_type || "").localeCompare(String(b.edge_type || ""));
    if (edgeCompare !== 0) {
      return edgeCompare;
    }
    const pathCompare = String(a.path || "").localeCompare(String(b.path || ""));
    if (pathCompare !== 0) {
      return pathCompare;
    }
    const lineA = Number(a.line || 1);
    const lineB = Number(b.line || 1);
    return lineA - lineB;
  });
}

async function checkIndexExists(workspaceRoot) {
  const dbFile = indexDbPath(workspaceRoot);
  return fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);
}

async function resolvePreferredPrecisePath(workspaceRoot, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }

    let fullPath;
    try {
      fullPath = resolveSafePath(workspaceRoot, candidate);
    } catch {
      continue;
    }

    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      continue;
    }

    return toPosixPath(path.relative(workspaceRoot, fullPath));
  }

  return null;
}

function resolveLspAvailability(health) {
  return Boolean(
    health?.ok === true &&
      health?.enabled !== false &&
      health?.active === true &&
      health?.initialized === true
  );
}

export async function buildSemanticGraph(workspaceRoot, args = {}, lspInput = {}, internal = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const config = resolveConfig(args);
  const lspApi = {
    lspHealth: internal?.lspApi?.lspHealth || lspHealth,
    lspDefinition: internal?.lspApi?.lspDefinition || lspDefinition,
    lspReferences: internal?.lspApi?.lspReferences || lspReferences
  };
  const preciseAttempt = {
    preferred: config.precise_preferred,
    required: config.precise_required,
    path: null,
    source: config.precise_source,
    mode: config.precise_mode,
    used: false,
    error: null
  };

  if (config.precise_preferred || config.precise_required) {
    const preferredPrecisePath = await resolvePreferredPrecisePath(
      workspaceRoot,
      config.precise_index_paths
    );
    preciseAttempt.path = preferredPrecisePath;

    if (preferredPrecisePath) {
      const preciseImportResult = await importPreciseIndex(workspaceRoot, {
        path: preferredPrecisePath,
        mode: config.precise_mode,
        source: config.precise_source,
        max_nodes: config.precise_max_nodes,
        max_edges: config.precise_max_edges
      });
      if (preciseImportResult.ok) {
        preciseAttempt.used = true;
        return {
          ...preciseImportResult,
          strategy: {
            mode: "precise_import",
            fallback_used: false,
            precise: {
              preferred: true,
              required: config.precise_required,
              path: preferredPrecisePath,
              source: config.precise_source,
              mode: config.precise_mode,
              used: true,
              error: null
            }
          }
        };
      }

      preciseAttempt.error = preciseImportResult.error || "precise import failed";
      if (config.precise_required) {
        return {
          ok: false,
          error: `precise index import failed: ${preciseAttempt.error}`,
          strategy: {
            mode: "precise_required_failed",
            fallback_used: false,
            precise: preciseAttempt
          }
        };
      }
    } else if (config.precise_required) {
      return {
        ok: false,
        error: "precise index file not found",
        strategy: {
          mode: "precise_required_missing",
          fallback_used: false,
          precise: preciseAttempt
        }
      };
    }
  }

  const startedAt = new Date().toISOString();
  const db = openDb(workspaceRoot);
  ensureSemanticSchema(db);
  const statements = buildStatements(db);

  let lspHealthSnapshot = null;
  try {
    lspHealthSnapshot = await lspApi.lspHealth(workspaceRoot, { startup_check: true }, lspInput);
  } catch (error) {
    lspHealthSnapshot = {
      ok: false,
      enabled: false,
      error: error.message || String(error)
    };
  }
  const lspAvailable = resolveLspAvailability(lspHealthSnapshot);
  if (config.lsp_required && !lspAvailable) {
    db.close();
    return {
      ok: false,
      error: "LSP is required but unavailable",
      strategy: {
        mode: "lsp_required_failed",
        fallback_used: false,
        precise: preciseAttempt
      },
      lsp: {
        available: false,
        health: lspHealthSnapshot
      }
    };
  }

  let seededNodes = [];
  let scannedSymbols = 0;
  let lspEnrichedSymbols = 0;
  let lspErrorCount = 0;
  let definitionEdgeCount = 0;
  let referenceEdgeCount = 0;
  let syntaxImportEdgeCount = 0;
  let syntaxCallEdgeCount = 0;
  let anchorNodeCount = 0;
  let syntaxSummary = {
    enabled: Boolean(config.include_syntax),
    available: false,
    import_edges: 0,
    call_edges: 0,
    reused_edges: 0,
    skipped_edges: 0,
    reason: config.include_syntax ? "syntax index tables not found" : "disabled",
    error: null
  };

  const pathMap = new Map();
  const anchorMap = new Map();

  try {
    const seedRows = statements.selectSeedSymbols.all(config.max_symbols);
    scannedSymbols = seedRows.length;

    db.exec("BEGIN IMMEDIATE;");
    try {
      clearSemanticGraph(db);

      for (const row of seedRows) {
        const baseNode = {
          path: row.path,
          name: row.name,
          kind: row.kind || "symbol",
          line: Number(row.line || 1),
          column: 1,
          lang: row.lang || inferLangFromPath(row.path),
          source: "index_seed"
        };
        const stableKey = makeSymbolStableKey(baseNode);
        const insertResult = statements.insertNode.run(
          baseNode.path,
          baseNode.name,
          String(baseNode.name || "").toLowerCase(),
          baseNode.kind,
          baseNode.line,
          baseNode.column,
          baseNode.lang,
          baseNode.source,
          stableKey
        );
        let nodeId = Number(insertResult.lastInsertRowid || 0);
        if (nodeId <= 0) {
          const existing = statements.selectNodeIdByStableKey.get(stableKey);
          nodeId = Number(existing?.id || 0);
        }
        if (nodeId <= 0) {
          continue;
        }

        const node = {
          id: nodeId,
          ...baseNode,
          stable_key: stableKey
        };
        seededNodes.push(node);
        pushNodeToPathMap(pathMap, node);
      }

      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }

    const createAnchorNode = (pathValue, line, column) => {
      const stableKey = makeAnchorStableKey(pathValue, line, column);
      if (anchorMap.has(stableKey)) {
        return anchorMap.get(stableKey);
      }

      const insertResult = statements.insertNode.run(
        pathValue,
        `@${path.basename(pathValue)}:${line}`,
        `@${path.basename(pathValue).toLowerCase()}:${line}`,
        "location",
        line,
        column,
        inferLangFromPath(pathValue),
        "lsp_anchor",
        stableKey
      );
      let nodeId = Number(insertResult.lastInsertRowid || 0);
      if (nodeId <= 0) {
        const existing = statements.selectNodeIdByStableKey.get(stableKey);
        nodeId = Number(existing?.id || 0);
      }
      if (nodeId <= 0) {
        return null;
      }
      const node = {
        id: nodeId,
        path: pathValue,
        name: `@${path.basename(pathValue)}:${line}`,
        kind: "location",
        line,
        column,
        lang: inferLangFromPath(pathValue),
        source: "lsp_anchor",
        stable_key: stableKey
      };
      anchorMap.set(stableKey, nodeId);
      pushNodeToPathMap(pathMap, node);
      anchorNodeCount += 1;
      return nodeId;
    };

    const resolveLocationNodeId = (location) => {
      const targetPath = normalizeGraphPath(workspaceRoot, location?.path);
      if (!targetPath) {
        return null;
      }
      const line = Math.max(1, Number(location?.line || 1));
      const column = Math.max(1, Number(location?.column || 1));
      const closestId = findClosestNodeId(pathMap, targetPath, line);
      if (closestId) {
        return closestId;
      }
      return createAnchorNode(targetPath, line, column);
    };

    if (config.include_syntax) {
      try {
        syntaxSummary = ingestSyntaxEdges({
          db,
          statements,
          pathMap,
          seededNodes,
          config
        });
        syntaxImportEdgeCount = Number(syntaxSummary.import_edges || 0);
        syntaxCallEdgeCount = Number(syntaxSummary.call_edges || 0);
      } catch (error) {
        syntaxSummary = {
          ...syntaxSummary,
          available: false,
          reason: "syntax edge ingest failed",
          error: error.message || String(error)
        };
      }
    }

    if (lspAvailable) {
      for (const node of seededNodes) {
        if (lspErrorCount >= config.max_lsp_errors) {
          break;
        }

        let enriched = false;
        const queryArgs = {
          path: node.path,
          line: node.line,
          column: node.column,
          max_results: config.max_references_per_symbol
        };

        if (config.include_definitions) {
          try {
            const definitionResult = await lspApi.lspDefinition(
              workspaceRoot,
              { ...queryArgs, max_results: 1 },
              lspInput
            );
            if (
              definitionResult?.ok &&
              definitionResult.provider === "lsp" &&
              Array.isArray(definitionResult.locations)
            ) {
              for (const location of definitionResult.locations.slice(0, 1)) {
                const targetNodeId = resolveLocationNodeId(location);
                if (!targetNodeId) {
                  continue;
                }
                const edgeInsert = statements.insertEdge.run(
                  node.id,
                  targetNodeId,
                  "definition",
                  "lsp",
                  4
                );
                if (Number(edgeInsert.changes || 0) > 0) {
                  definitionEdgeCount += 1;
                  enriched = true;
                }
              }
            }
          } catch {
            lspErrorCount += 1;
          }
        }

        if (config.include_references && lspErrorCount < config.max_lsp_errors) {
          try {
            const referencesResult = await lspApi.lspReferences(
              workspaceRoot,
              {
                ...queryArgs,
                include_declaration: false,
                max_results: config.max_references_per_symbol
              },
              lspInput
            );
            if (
              referencesResult?.ok &&
              referencesResult.provider === "lsp" &&
              Array.isArray(referencesResult.locations)
            ) {
              for (const location of referencesResult.locations) {
                const targetNodeId = resolveLocationNodeId(location);
                if (!targetNodeId) {
                  continue;
                }
                const edgeInsert = statements.insertEdge.run(
                  node.id,
                  targetNodeId,
                  "reference",
                  "lsp",
                  1
                );
                if (Number(edgeInsert.changes || 0) > 0) {
                  referenceEdgeCount += 1;
                  enriched = true;
                }
              }
            }
          } catch {
            lspErrorCount += 1;
          }
        }

        if (enriched) {
          lspEnrichedSymbols += 1;
        }
      }
    }

    const nodeCount = Number(statements.countNodes.get().count || 0);
    const edgeCount = Number(statements.countEdges.get().count || 0);
    const completedAt = new Date().toISOString();
    statements.insertRun.run(
      startedAt,
      completedAt,
      "ok",
      scannedSymbols,
      seededNodes.length,
      nodeCount,
      edgeCount,
      lspAvailable ? 1 : 0,
      lspEnrichedSymbols,
      lspErrorCount,
      JSON.stringify(config),
      null
    );

    return {
      ok: true,
      index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
      scanned_symbols: scannedSymbols,
      seeded_nodes: seededNodes.length,
      anchor_nodes: anchorNodeCount,
      total_nodes: nodeCount,
      total_edges: edgeCount,
      edge_counts: {
        import: syntaxImportEdgeCount,
        call: syntaxCallEdgeCount,
        definition: definitionEdgeCount,
        reference: referenceEdgeCount
      },
      syntax: syntaxSummary,
      lsp: {
        available: lspAvailable,
        enriched_symbols: lspEnrichedSymbols,
        error_count: lspErrorCount,
        health: lspHealthSnapshot
      },
      strategy: {
        mode: "lsp_index_fallback",
        fallback_used: true,
        precise: preciseAttempt
      },
      config
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const nodeCount = Number(statements.countNodes.get().count || 0);
    const edgeCount = Number(statements.countEdges.get().count || 0);
    statements.insertRun.run(
      startedAt,
      completedAt,
      "error",
      scannedSymbols,
      seededNodes.length,
      nodeCount,
      edgeCount,
      lspAvailable ? 1 : 0,
      lspEnrichedSymbols,
      lspErrorCount,
      JSON.stringify(config),
      error.message || String(error)
    );
    return {
      ok: false,
      error: error.message || String(error),
      syntax: syntaxSummary,
      strategy: {
        mode: "lsp_index_fallback",
        fallback_used: true,
        precise: preciseAttempt
      }
    };
  } finally {
    db.close();
  }
}

export async function getSemanticGraphStats(workspaceRoot) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const db = openDb(workspaceRoot);
  try {
    ensureSemanticSchema(db);
    const statements = buildStatements(db);
    const nodeCount = Number(statements.countNodes.get().count || 0);
    const edgeCount = Number(statements.countEdges.get().count || 0);

    const edgeTypes = statements.edgeTypeCounts.all().map((row) => ({
      edge_type: row.edge_type,
      count: Number(row.count || 0)
    }));
    const nodeSources = statements.nodeSourceCounts.all().map((row) => ({
      source: row.source,
      count: Number(row.count || 0)
    }));
    const edgeSources = statements.edgeSourceCounts.all().map((row) => ({
      source: row.source,
      count: Number(row.count || 0)
    }));

    const latestRunRaw = statements.latestRun.get();
    let latestRun = null;
    if (latestRunRaw) {
      let parsedConfig = {};
      try {
        parsedConfig = JSON.parse(latestRunRaw.config_json || "{}");
      } catch {
        parsedConfig = {};
      }
      latestRun = {
        started_at: latestRunRaw.started_at,
        completed_at: latestRunRaw.completed_at,
        status: latestRunRaw.status,
        scanned_symbols: Number(latestRunRaw.scanned_symbols || 0),
        seeded_nodes: Number(latestRunRaw.seeded_nodes || 0),
        total_nodes: Number(latestRunRaw.total_nodes || 0),
        total_edges: Number(latestRunRaw.total_edges || 0),
        lsp_available: Boolean(latestRunRaw.lsp_available),
        lsp_enriched_symbols: Number(latestRunRaw.lsp_enriched_symbols || 0),
        lsp_error_count: Number(latestRunRaw.lsp_error_count || 0),
        config: parsedConfig,
        error: latestRunRaw.error || null
      };
    }

    return {
      ok: true,
      index_path: toPosixPath(path.relative(workspaceRoot, indexDbPath(workspaceRoot))),
      counts: {
        nodes: nodeCount,
        edges: edgeCount
      },
      edge_types: edgeTypes,
      node_sources: nodeSources,
      edge_sources: edgeSources,
      latest_run: latestRun
    };
  } finally {
    db.close();
  }
}

function resolveEdgeEndpointNodeId({
  workspaceRoot,
  endpoint,
  symbolMap,
  statements
}) {
  if (typeof endpoint === "string" && endpoint.trim().length > 0) {
    return symbolMap.get(endpoint.trim()) || null;
  }

  if (!endpoint || typeof endpoint !== "object") {
    return null;
  }

  const symbolCandidates = [
    endpoint.symbol,
    endpoint.symbol_id,
    endpoint.id
  ];
  for (const candidate of symbolCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const nodeId = symbolMap.get(candidate.trim());
      if (nodeId) {
        return nodeId;
      }
    }
  }

  const pathCandidates = [endpoint.path, endpoint.file, endpoint.relative_path];
  for (const candidate of pathCandidates) {
    const normalizedPath = normalizeGraphPath(workspaceRoot, candidate);
    if (!normalizedPath) {
      continue;
    }
    const line = parsePositiveInt(endpoint.line, 1, 1, 10_000_000);
    const nearest = statements.selectNearestNodeByPathLine.get(normalizedPath, line);
    if (!nearest) {
      continue;
    }
    const nearestLine = Number(nearest.line || 1);
    if (Math.abs(nearestLine - line) > 30) {
      continue;
    }
    return Number(nearest.id || 0) || null;
  }

  return null;
}

function resolvePreciseItems(payload) {
  const nodeItems = Array.isArray(payload?.nodes)
    ? payload.nodes
    : Array.isArray(payload?.symbols)
      ? payload.symbols
      : [];
  const edgeItems = Array.isArray(payload?.edges)
    ? payload.edges
    : Array.isArray(payload?.relationships)
      ? payload.relationships
      : [];
  return {
    nodeItems,
    edgeItems
  };
}

export async function importPreciseIndex(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return {
      ok: false,
      error: "path is required"
    };
  }

  const mode = args.mode === "replace" ? "replace" : "merge";
  const source =
    typeof args.source === "string" && args.source.trim().length > 0
      ? args.source.trim().toLowerCase()
      : "scip";
  const maxNodes = parsePositiveInt(args.max_nodes, DEFAULT_MAX_IMPORT_NODES, 1, MAX_IMPORT_NODES);
  const maxEdges = parsePositiveInt(args.max_edges, DEFAULT_MAX_IMPORT_EDGES, 1, MAX_IMPORT_EDGES);

  let payload;
  const importFile = resolveSafePath(workspaceRoot, args.path.trim());
  const importPathRelative = toPosixPath(path.relative(workspaceRoot, importFile));
  try {
    payload = JSON.parse(await fs.readFile(importFile, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: `failed to read/parse precise index file: ${error.message || String(error)}`
    };
  }

  const { nodeItems, edgeItems } = resolvePreciseItems(payload);
  const limitedNodes = nodeItems.slice(0, maxNodes);
  const limitedEdges = edgeItems.slice(0, maxEdges);

  const db = openDb(workspaceRoot);
  try {
    ensureSemanticSchema(db);
    const statements = buildStatements(db);
    const startedAt = new Date().toISOString();
    const symbolMap = new Map();
    let insertedNodes = 0;
    let reusedNodes = 0;
    let skippedNodes = 0;
    let insertedEdges = 0;
    let reusedEdges = 0;
    let skippedEdges = 0;

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (mode === "replace") {
        clearSemanticGraph(db);
      }

      for (const rawNode of limitedNodes) {
        if (!rawNode || typeof rawNode !== "object") {
          skippedNodes += 1;
          continue;
        }

        const nodePath = normalizeGraphPath(
          workspaceRoot,
          rawNode.path || rawNode.file || rawNode.relative_path
        );
        if (!nodePath) {
          skippedNodes += 1;
          continue;
        }

        const symbolKey =
          typeof rawNode.symbol === "string" && rawNode.symbol.trim().length > 0
            ? rawNode.symbol.trim()
            : typeof rawNode.id === "string" && rawNode.id.trim().length > 0
              ? rawNode.id.trim()
              : null;
        const line = parsePositiveInt(rawNode.line, 1, 1, 10_000_000);
        const column = parsePositiveInt(rawNode.column, 1, 1, 10_000_000);
        const name =
          typeof rawNode.name === "string" && rawNode.name.trim().length > 0
            ? rawNode.name.trim()
            : symbolKey || path.basename(nodePath, path.extname(nodePath));
        const kind =
          typeof rawNode.kind === "string" && rawNode.kind.trim().length > 0
            ? rawNode.kind.trim().toLowerCase()
            : "symbol";
        const lang =
          typeof rawNode.lang === "string" && rawNode.lang.trim().length > 0
            ? rawNode.lang.trim().toLowerCase()
            : inferLangFromPath(nodePath);
        const stableKey = symbolKey
          ? `${source}:symbol:${symbolKey}`
          : `${source}:node:${nodePath}:${line}:${column}:${kind}:${name}`;

        const insertNode = statements.insertNode.run(
          nodePath,
          name,
          name.toLowerCase(),
          kind,
          line,
          column,
          lang,
          source,
          stableKey
        );

        let nodeId = Number(insertNode.lastInsertRowid || 0);
        if (nodeId <= 0) {
          const existing = statements.selectNodeIdByStableKey.get(stableKey);
          nodeId = Number(existing?.id || 0);
        }
        if (nodeId <= 0) {
          skippedNodes += 1;
          continue;
        }
        if (Number(insertNode.changes || 0) > 0) {
          insertedNodes += 1;
        } else {
          reusedNodes += 1;
        }
        if (symbolKey) {
          symbolMap.set(symbolKey, nodeId);
        }
      }

      for (const rawEdge of limitedEdges) {
        if (!rawEdge || typeof rawEdge !== "object") {
          skippedEdges += 1;
          continue;
        }

        const fromEndpoint = rawEdge.from ?? rawEdge.from_symbol ?? rawEdge.source;
        const toEndpoint = rawEdge.to ?? rawEdge.to_symbol ?? rawEdge.target;
        const fromNodeId = resolveEdgeEndpointNodeId({
          workspaceRoot,
          endpoint: fromEndpoint,
          symbolMap,
          statements
        });
        const toNodeId = resolveEdgeEndpointNodeId({
          workspaceRoot,
          endpoint: toEndpoint,
          symbolMap,
          statements
        });
        if (!fromNodeId || !toNodeId) {
          skippedEdges += 1;
          continue;
        }

        const edgeType = normalizeEdgeType(rawEdge.edge_type || rawEdge.type);
        const defaultWeight = edgeType === "definition" ? 4 : 1;
        const rawWeight = Number(rawEdge.weight);
        const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : defaultWeight;

        const edgeInsert = statements.insertEdge.run(fromNodeId, toNodeId, edgeType, source, weight);
        if (Number(edgeInsert.changes || 0) > 0) {
          insertedEdges += 1;
        } else {
          reusedEdges += 1;
        }
      }

      const totalNodes = Number(statements.countNodes.get().count || 0);
      const totalEdges = Number(statements.countEdges.get().count || 0);
      const completedAt = new Date().toISOString();
      statements.insertRun.run(
        startedAt,
        completedAt,
        "ok_precise_import",
        0,
        insertedNodes,
        totalNodes,
        totalEdges,
        0,
        0,
        0,
        JSON.stringify({
          type: "precise_import",
          source,
          mode,
          import_path: importPathRelative,
          format: payload?.format || null,
          max_nodes: maxNodes,
          max_edges: maxEdges
        }),
        null
      );

      db.exec("COMMIT;");
      return {
        ok: true,
        source,
        mode,
        import_path: importPathRelative,
        format: payload?.format || null,
        input_counts: {
          nodes: nodeItems.length,
          edges: edgeItems.length
        },
        applied_limits: {
          nodes: maxNodes,
          edges: maxEdges
        },
        imported: {
          inserted_nodes: insertedNodes,
          reused_nodes: reusedNodes,
          skipped_nodes: skippedNodes,
          inserted_edges: insertedEdges,
          reused_edges: reusedEdges,
          skipped_edges: skippedEdges
        },
        totals: {
          nodes: Number(statements.countNodes.get().count || 0),
          edges: Number(statements.countEdges.get().count || 0)
        }
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function querySemanticGraph(workspaceRoot, args = {}) {
  const indexExists = await checkIndexExists(workspaceRoot);
  if (!indexExists) {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      ok: false,
      error: "query must be a non-empty string"
    };
  }

  const topK = parsePositiveInt(args.top_k, 5, 1, 30);
  const maxNeighbors = parsePositiveInt(args.max_neighbors, 8, 1, 100);
  const edgeType = typeof args.edge_type === "string" && args.edge_type.trim() ? args.edge_type.trim() : null;
  const pathPrefix = normalizePathPrefix(args.path_prefix);
  const pathLike = pathPrefix ? `${pathPrefix}%` : null;
  const queryLower = query.toLowerCase();
  const seedScanLimit = Math.min(
    MAX_SEED_SCAN_LIMIT,
    Math.max(topK, topK * DEFAULT_SEED_SCAN_FACTOR)
  );

  const db = openDb(workspaceRoot);
  try {
    ensureSemanticSchema(db);
    const statements = buildStatements(db);
    const nodeCount = Number(statements.countNodes.get().count || 0);
    if (nodeCount === 0) {
      return {
        ok: false,
        error: "semantic graph is empty; run build_semantic_graph first"
      };
    }

    const rawSeeds = statements.selectQuerySeeds.all(
      queryLower,
      `${queryLower}%`,
      `%${queryLower}%`,
      `%${queryLower}%`,
      pathPrefix,
      pathLike,
      queryLower,
      `${queryLower}%`,
      `%${queryLower}%`,
      seedScanLimit
    );

    const dedupedByKey = new Map();
    for (const seed of rawSeeds) {
      const key = seedDedupKey(seed);
      const existing = dedupedByKey.get(key);
      if (!existing) {
        dedupedByKey.set(key, seed);
        continue;
      }
      dedupedByKey.set(key, pickPreferredSeed(existing, seed, queryLower));
    }

    const seeds = Array.from(dedupedByKey.values())
      .sort((a, b) => sortSeedsByPriority(a, b, queryLower))
      .slice(0, topK);

    const enrichedSeeds = seeds.map((seed) => ({
      path: seed.path,
      name: seed.name,
      kind: seed.kind,
      line: Number(seed.line || 1),
      column: Number(seed.column || 1),
      lang: seed.lang || null,
      source: seed.source || null,
      outgoing: statements
        .selectOutgoing
        .all(seed.id, edgeType, edgeType, maxNeighbors),
      incoming: statements
        .selectIncoming
        .all(seed.id, edgeType, edgeType, maxNeighbors)
    }));

    const finalizedSeeds = enrichedSeeds.map((seed) => ({
      ...seed,
      outgoing: dedupeNeighborRows(seed.outgoing).slice(0, maxNeighbors).map(toNeighbor),
      incoming: dedupeNeighborRows(seed.incoming).slice(0, maxNeighbors).map(toNeighbor)
    }));

    return {
      ok: true,
      query,
      filters: {
        edge_type: edgeType,
        path_prefix: pathPrefix
      },
      priority_policy: SOURCE_PRIORITY_ORDER,
      total_seeds: finalizedSeeds.length,
      scanned_candidates: rawSeeds.length,
      deduped_candidates: dedupedByKey.size,
      seeds: finalizedSeeds
    };
  } finally {
    db.close();
  }
}
