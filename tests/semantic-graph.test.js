import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticGraph,
  importPreciseIndex,
  getSemanticGraphStats,
  querySemanticGraph
} from "../src/semantic-graph.js";
import { buildCodeIndex } from "../src/code-index.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

test("buildSemanticGraph reports clear error when code index is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const result = await buildSemanticGraph(workspaceRoot, {}, { enabled: false });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /build_code_index/i);
});

test("buildSemanticGraph creates seed graph and querySemanticGraph returns node matches", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/foo.ts",
    "import { barToken } from './bar';\nexport function fooToken() { return barToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/bar.ts",
    "export function barToken() { return 1; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSemanticGraph(
    workspaceRoot,
    {
      max_symbols: 20,
      include_definitions: true,
      include_references: true
    },
    { enabled: false }
  );
  assert.equal(built.ok, true);
  assert.ok(built.seeded_nodes >= 2);
  assert.equal(built.lsp.available, false);

  const stats = await getSemanticGraphStats(workspaceRoot);
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.nodes >= 2);
  assert.ok(stats.latest_run);
  assert.equal(stats.latest_run.lsp_available, false);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "fooToken",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(query.ok, true);
  assert.ok(query.total_seeds >= 1);
  assert.ok(query.seeds.some((seed) => seed.name === "fooToken"));
});

test("buildSemanticGraph ingests LSP facts when provider is available", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/foo.ts",
    "import { barToken } from './bar';\nexport function fooToken() { return barToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/bar.ts",
    "export function barToken() { return 1; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/main.ts",
    "import { fooToken } from './foo';\nfooToken();\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const fakeLspApi = {
    lspHealth: async () => ({
      ok: true,
      enabled: true,
      active: true,
      initialized: true
    }),
    lspDefinition: async (_root, args) => {
      if (args.path === "src/foo.ts") {
        return {
          ok: true,
          provider: "lsp",
          fallback: false,
          locations: [
            {
              path: "src/bar.ts",
              line: 1,
              column: 1,
              end_line: 1,
              end_column: 10
            }
          ]
        };
      }
      return {
        ok: true,
        provider: "lsp",
        fallback: false,
        locations: []
      };
    },
    lspReferences: async (_root, args) => {
      if (args.path === "src/foo.ts") {
        return {
          ok: true,
          provider: "lsp",
          fallback: false,
          include_declaration: false,
          locations: [
            {
              path: "src/main.ts",
              line: 2,
              column: 1,
              end_line: 2,
              end_column: 8
            }
          ]
        };
      }
      return {
        ok: true,
        provider: "lsp",
        fallback: false,
        include_declaration: false,
        locations: []
      };
    }
  };

  const built = await buildSemanticGraph(
    workspaceRoot,
    {
      max_symbols: 20,
      max_references_per_symbol: 5,
      include_definitions: true,
      include_references: true
    },
    {},
    { lspApi: fakeLspApi }
  );
  assert.equal(built.ok, true);
  assert.ok(built.edge_counts.definition >= 1);
  assert.ok(built.edge_counts.reference >= 1);
  assert.equal(built.lsp.available, true);
  assert.ok(built.lsp.enriched_symbols >= 1);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "fooToken",
    edge_type: "definition",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(query.ok, true);
  assert.ok(query.total_seeds >= 1);
  const fooSeed = query.seeds.find((seed) => seed.name === "fooToken");
  assert.ok(fooSeed);
  assert.ok(fooSeed.outgoing.some((item) => item.edge_type === "definition"));
});

test("importPreciseIndex imports SCIP-normalized nodes and edges", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/alpha.ts",
    "export class AlphaService {}\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/beta.ts",
    "export function betaWorker() { return true; }\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const payload = {
    format: "scip-normalized/v1",
    nodes: [
      {
        symbol: "local alpha",
        path: "src/alpha.ts",
        name: "AlphaService",
        kind: "class",
        line: 1,
        column: 1,
        lang: "javascript"
      },
      {
        symbol: "local beta",
        path: "src/beta.ts",
        name: "betaWorker",
        kind: "function",
        line: 1,
        column: 1,
        lang: "javascript"
      }
    ],
    edges: [
      {
        from: "local alpha",
        to: "local beta",
        edge_type: "call",
        weight: 3
      }
    ]
  };
  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip.normalized.json",
    `${JSON.stringify(payload, null, 2)}\n`
  );

  const imported = await importPreciseIndex(workspaceRoot, {
    path: "artifacts/scip.normalized.json",
    mode: "replace",
    source: "scip"
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.mode, "replace");
  assert.equal(imported.imported.inserted_nodes, 2);
  assert.equal(imported.imported.inserted_edges, 1);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "AlphaService",
    edge_type: "call",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(query.ok, true);
  const alphaSeed = query.seeds.find((seed) => seed.name === "AlphaService");
  assert.ok(alphaSeed);
  const callEdge = alphaSeed.outgoing.find((item) => item.edge_type === "call");
  assert.ok(callEdge);
  assert.equal(callEdge.node.name, "betaWorker");
  assert.equal(callEdge.edge_source, "scip");

  const stats = await getSemanticGraphStats(workspaceRoot);
  assert.equal(stats.ok, true);
  assert.ok(stats.edge_sources.some((item) => item.source === "scip"));
});

test("querySemanticGraph deduplicates seeds and prefers SCIP over index source", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/dedup.ts",
    "export function dedupToken() { return true; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSemanticGraph(
    workspaceRoot,
    { max_symbols: 20, include_definitions: false, include_references: false },
    { enabled: false }
  );
  assert.equal(built.ok, true);
  assert.ok(built.seeded_nodes >= 1);

  const precisePayload = {
    format: "scip-normalized/v1",
    nodes: [
      {
        symbol: "scip dedup token",
        path: "src/dedup.ts",
        name: "dedupToken",
        kind: "function",
        line: 1,
        column: 1,
        lang: "javascript"
      }
    ],
    edges: []
  };
  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip-dedup.json",
    `${JSON.stringify(precisePayload, null, 2)}\n`
  );

  const imported = await importPreciseIndex(workspaceRoot, {
    path: "artifacts/scip-dedup.json",
    mode: "merge",
    source: "scip"
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported.inserted_nodes, 1);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "dedupToken",
    top_k: 5,
    max_neighbors: 3
  });
  assert.equal(query.ok, true);
  assert.ok(Array.isArray(query.priority_policy));
  assert.equal(query.seeds.length, 1);
  assert.equal(query.seeds[0].name, "dedupToken");
  assert.equal(query.seeds[0].source, "scip");
  assert.ok(query.scanned_candidates >= 2);
  assert.ok(query.deduped_candidates >= 1);
});
