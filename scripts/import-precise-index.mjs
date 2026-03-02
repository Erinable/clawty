import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCodeIndex } from "../src/code-index.js";
import { importPreciseIndex } from "../src/semantic-graph.js";

const DEFAULT_PATH = "artifacts/scip.normalized.json";

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    path: DEFAULT_PATH,
    mode: "replace",
    source: "scip",
    maxNodes: 50_000,
    maxEdges: 200_000,
    skipBuild: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--workspace" && typeof argv[index + 1] === "string") {
      options.workspaceRoot = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      options.workspaceRoot = path.resolve(process.cwd(), arg.slice("--workspace=".length));
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
    if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length).trim().toLowerCase();
      options.mode = mode === "merge" ? "merge" : "replace";
      continue;
    }
    if (arg.startsWith("--source=")) {
      const source = arg.slice("--source=".length).trim().toLowerCase();
      if (source) {
        options.source = source;
      }
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      options.maxNodes = parsePositiveInt(arg.slice("--max-nodes=".length), 50_000, 1, 500_000);
      continue;
    }
    if (arg.startsWith("--max-edges=")) {
      options.maxEdges = parsePositiveInt(arg.slice("--max-edges=".length), 200_000, 1, 1_000_000);
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

function printHelp() {
  console.log(
    [
      "Usage: node scripts/import-precise-index.mjs [options]",
      "",
      "Options:",
      "  --workspace <dir>      Workspace root (default: current directory)",
      "  --path <file>          Precise index path (default: artifacts/scip.normalized.json)",
      "  --mode=<replace|merge> Import mode (default: replace)",
      "  --source=<label>       Source label (default: scip)",
      "  --max-nodes=<n>        Max imported nodes (default: 50000)",
      "  --max-edges=<n>        Max imported edges (default: 200000)",
      "  --skip-build           Skip build_code_index step"
    ].join("\n")
  );
}

async function run(options) {
  const workspaceRoot = options.workspaceRoot;
  const result = {
    ok: true,
    workspace_root: workspaceRoot,
    build: null,
    import: null
  };

  if (!options.skipBuild) {
    const buildResult = await buildCodeIndex(workspaceRoot, {});
    result.build = buildResult;
    if (!buildResult?.ok) {
      return {
        ...result,
        ok: false,
        error: `build_code_index failed: ${buildResult?.error || "unknown error"}`
      };
    }
  }

  const importResult = await importPreciseIndex(workspaceRoot, {
    path: options.path,
    mode: options.mode,
    source: options.source,
    max_nodes: options.maxNodes,
    max_edges: options.maxEdges
  });
  result.import = importResult;
  if (!importResult?.ok) {
    return {
      ...result,
      ok: false,
      error: `import_precise_index failed: ${importResult?.error || "unknown error"}`
    };
  }

  return result;
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
    const result = await run(options);
    if (!result.ok) {
      throw new Error(result.error || "precise import failed");
    }
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.message || String(error)
        },
        null,
        2
      )
    );
    process.exit(1);
  });
}
