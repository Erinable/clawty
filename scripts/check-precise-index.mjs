import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_PATH = "artifacts/scip.normalized.json";
const DEFAULT_EXPECTED_FORMAT = "scip-normalized/v1";
const DEFAULT_MAX_NODES = 500_000;
const DEFAULT_MAX_EDGES = 1_000_000;

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseArgs(argv) {
  const options = {
    path: DEFAULT_PATH,
    allowMissing: false,
    allowEmpty: false,
    allowFormatMissing: false,
    expectedFormat: DEFAULT_EXPECTED_FORMAT,
    maxNodes: DEFAULT_MAX_NODES,
    maxEdges: DEFAULT_MAX_EDGES
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    if (arg === "--allow-empty") {
      options.allowEmpty = true;
      continue;
    }
    if (arg === "--allow-format-missing") {
      options.allowFormatMissing = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--path" && typeof argv[index + 1] === "string") {
      options.path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--path=")) {
      options.path = arg.slice("--path=".length);
      continue;
    }
    if (arg.startsWith("--expected-format=")) {
      options.expectedFormat = arg.slice("--expected-format=".length).trim();
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      options.maxNodes = parsePositiveInt(arg.slice("--max-nodes=".length), DEFAULT_MAX_NODES, 1, 2_000_000);
      continue;
    }
    if (arg.startsWith("--max-edges=")) {
      options.maxEdges = parsePositiveInt(arg.slice("--max-edges=".length), DEFAULT_MAX_EDGES, 1, 5_000_000);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (typeof options.path !== "string" || options.path.trim().length === 0) {
    throw new Error("path must be a non-empty string");
  }
  options.path = options.path.trim();
  return options;
}

export function resolvePreciseItems(payload) {
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

function normalizeLang(value) {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase();
  return normalized || "unknown";
}

function summarizeLanguages(nodes) {
  const counts = new Map();
  for (const node of nodes) {
    const lang = normalizeLang(node?.lang);
    counts.set(lang, Number(counts.get(lang) || 0) + 1);
  }
  const total = nodes.length;
  const breakdown = Array.from(counts.entries())
    .map(([lang, count]) => ({
      lang,
      count,
      ratio: total > 0 ? Number((count / total).toFixed(4)) : 0
    }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.lang.localeCompare(b.lang);
    });
  return { total, breakdown };
}

export function validatePreciseIndexPayload(payload, options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);
  const allowFormatMissing = Boolean(options.allowFormatMissing);
  const expectedFormat =
    typeof options.expectedFormat === "string" && options.expectedFormat.trim().length > 0
      ? options.expectedFormat.trim()
      : null;
  const maxNodes = parsePositiveInt(options.maxNodes, DEFAULT_MAX_NODES, 1, 2_000_000);
  const maxEdges = parsePositiveInt(options.maxEdges, DEFAULT_MAX_EDGES, 1, 5_000_000);

  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload must be a JSON object");
    return {
      ok: false,
      errors,
      warnings: [],
      summary: null
    };
  }

  const { nodeItems, edgeItems } = resolvePreciseItems(payload);
  const nodeCount = nodeItems.length;
  const edgeCount = edgeItems.length;

  if (!allowEmpty && nodeCount === 0 && edgeCount === 0) {
    errors.push("precise graph is empty (nodes=0 and edges=0)");
  }
  if (nodeCount > maxNodes) {
    errors.push(`node count ${nodeCount} exceeds max_nodes ${maxNodes}`);
  }
  if (edgeCount > maxEdges) {
    errors.push(`edge count ${edgeCount} exceeds max_edges ${maxEdges}`);
  }

  const format = typeof payload.format === "string" ? payload.format.trim() : "";
  if (expectedFormat) {
    if (!format) {
      if (!allowFormatMissing) {
        errors.push(`format is missing (expected ${expectedFormat})`);
      }
    } else if (format !== expectedFormat) {
      errors.push(`format mismatch: expected ${expectedFormat}, got ${format}`);
    }
  }

  let invalidNodeCount = 0;
  const invalidNodeSamples = [];
  for (let i = 0; i < nodeItems.length; i += 1) {
    const node = nodeItems[i];
    const pathLike = node?.path ?? node?.file ?? node?.relative_path;
    if (typeof pathLike === "string" && pathLike.trim().length > 0) {
      continue;
    }
    invalidNodeCount += 1;
    if (invalidNodeSamples.length < 5) {
      invalidNodeSamples.push(i);
    }
  }
  if (invalidNodeCount > 0) {
    errors.push(
      `nodes missing path/file/relative_path: ${invalidNodeCount} (sample indexes: ${invalidNodeSamples.join(", ")})`
    );
  }

  let invalidEdgeCount = 0;
  const invalidEdgeSamples = [];
  for (let i = 0; i < edgeItems.length; i += 1) {
    const edge = edgeItems[i];
    const fromEndpoint = edge?.from ?? edge?.from_symbol ?? edge?.source;
    const toEndpoint = edge?.to ?? edge?.to_symbol ?? edge?.target;
    const hasFrom =
      (typeof fromEndpoint === "string" && fromEndpoint.trim().length > 0) ||
      (fromEndpoint && typeof fromEndpoint === "object");
    const hasTo =
      (typeof toEndpoint === "string" && toEndpoint.trim().length > 0) ||
      (toEndpoint && typeof toEndpoint === "object");
    if (hasFrom && hasTo) {
      continue;
    }
    invalidEdgeCount += 1;
    if (invalidEdgeSamples.length < 5) {
      invalidEdgeSamples.push(i);
    }
  }
  if (invalidEdgeCount > 0) {
    errors.push(
      `edges missing from/to endpoint: ${invalidEdgeCount} (sample indexes: ${invalidEdgeSamples.join(", ")})`
    );
  }

  const summary = {
    format: format || null,
    counts: {
      nodes: nodeCount,
      edges: edgeCount
    },
    limits: {
      max_nodes: maxNodes,
      max_edges: maxEdges
    },
    language_distribution: summarizeLanguages(nodeItems),
    empty_graph: nodeCount === 0 && edgeCount === 0
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    summary
  };
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/check-precise-index.mjs [options]",
      "",
      "Options:",
      "  --path <file>                  Precise index JSON path (default: artifacts/scip.normalized.json)",
      "  --allow-missing                Exit 0 when file does not exist",
      "  --allow-empty                  Allow nodes=0 and edges=0",
      "  --allow-format-missing         Allow payload.format to be absent",
      "  --expected-format=<value>      Expected format (default: scip-normalized/v1)",
      "  --max-nodes=<n>                Maximum allowed node count",
      "  --max-edges=<n>                Maximum allowed edge count"
    ].join("\n")
  );
}

async function runCli(options) {
  const targetPath = path.resolve(process.cwd(), options.path);
  const relativePath = path.relative(process.cwd(), targetPath).split(path.sep).join("/");

  let payload;
  try {
    payload = JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && options.allowMissing) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            skipped: true,
            reason: "file_missing",
            path: relativePath
          },
          null,
          2
        )
      );
      return;
    }
    throw new Error(`failed to read/parse precise index file: ${error.message || String(error)}`);
  }

  const result = validatePreciseIndexPayload(payload, options);
  if (!result.ok) {
    const error = new Error("precise index validation failed");
    error.details = {
      path: relativePath,
      ...result
    };
    throw error;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: false,
        path: relativePath,
        ...result
      },
      null,
      2
    )
  );
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    await runCli(options);
  })().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.message || String(error),
          details: error?.details || null
        },
        null,
        2
      )
    );
    process.exit(1);
  });
}
