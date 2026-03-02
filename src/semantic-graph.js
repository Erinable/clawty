import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { lspDefinition, lspHealth, lspReferences } from "./lsp-manager.js";

const INDEX_DIR = ".clawty";
const INDEX_DB_FILENAME = "index.db";
const DEFAULT_MAX_SYMBOLS = 120;
const DEFAULT_MAX_REFERENCES_PER_SYMBOL = 12;
const DEFAULT_MAX_LSP_ERRORS = 12;
const MAX_MAX_SYMBOLS = 5000;
const MAX_MAX_REFERENCES = 200;
const MAX_MAX_LSP_ERRORS = 200;

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

function indexDbPath(workspaceRoot) {
  return path.join(workspaceRoot, INDEX_DIR, INDEX_DB_FILENAME);
}

function resolveConfig(args = {}) {
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
    lsp_required: parseBoolean(args.lsp_required, false)
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
      SELECT id, path, name, kind, line, column, lang, source
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

function pushNodeToPathMap(pathMap, node) {
  if (!pathMap.has(node.path)) {
    pathMap.set(node.path, []);
  }
  pathMap.get(node.path).push(node);
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

async function checkIndexExists(workspaceRoot) {
  const dbFile = indexDbPath(workspaceRoot);
  return fs
    .access(dbFile)
    .then(() => true)
    .catch(() => false);
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
  let anchorNodeCount = 0;

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
        definition: definitionEdgeCount,
        reference: referenceEdgeCount
      },
      lsp: {
        available: lspAvailable,
        enriched_symbols: lspEnrichedSymbols,
        error_count: lspErrorCount,
        health: lspHealthSnapshot
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
      error: error.message || String(error)
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

    const seeds = statements.selectQuerySeeds.all(
      queryLower,
      `${queryLower}%`,
      `%${queryLower}%`,
      `%${queryLower}%`,
      pathPrefix,
      pathLike,
      queryLower,
      `${queryLower}%`,
      `%${queryLower}%`,
      topK
    );

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
        .all(seed.id, edgeType, edgeType, maxNeighbors)
        .map(toNeighbor),
      incoming: statements
        .selectIncoming
        .all(seed.id, edgeType, edgeType, maxNeighbors)
        .map(toNeighbor)
    }));

    return {
      ok: true,
      query,
      filters: {
        edge_type: edgeType,
        path_prefix: pathPrefix
      },
      total_seeds: enrichedSeeds.length,
      seeds: enrichedSeeds
    };
  } finally {
    db.close();
  }
}
