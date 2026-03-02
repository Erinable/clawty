import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticGraph,
  importPreciseIndex,
  getSemanticGraphStats,
  querySemanticGraph
} from "../src/semantic-graph.js";
import { buildCodeIndex } from "../src/code-index.js";
import { buildSyntaxIndex } from "../src/syntax-index.js";
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

test("buildSemanticGraph ingests syntax import/call edges when syntax index exists", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-foo.ts",
    "import { syntaxBar } from './syntax-bar';\nexport function syntaxFoo() { return syntaxBar(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-bar.ts",
    "export function syntaxBar() { return true; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const syntaxBuilt = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(syntaxBuilt.ok, true);
  assert.ok(syntaxBuilt.total_import_edges >= 1);
  assert.ok(syntaxBuilt.total_call_edges >= 1);

  const built = await buildSemanticGraph(
    workspaceRoot,
    {
      max_symbols: 20,
      include_definitions: false,
      include_references: false,
      include_syntax: true
    },
    { enabled: false }
  );
  assert.equal(built.ok, true);
  assert.equal(built.syntax?.available, true);
  assert.ok(built.edge_counts.import >= 1);
  assert.ok(built.edge_counts.call >= 1);

  const importQuery = await querySemanticGraph(workspaceRoot, {
    query: "syntaxFoo",
    edge_type: "import",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(importQuery.ok, true);
  const fooSeed = importQuery.seeds.find((seed) => seed.name === "syntaxFoo");
  assert.ok(fooSeed);
  assert.ok(fooSeed.outgoing.some((item) => item.edge_source === "syntax"));

  const callQuery = await querySemanticGraph(workspaceRoot, {
    query: "syntaxFoo",
    edge_type: "call",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(callQuery.ok, true);
  const callSeed = callQuery.seeds.find((seed) => seed.name === "syntaxFoo");
  assert.ok(callSeed);
  assert.ok(
    callSeed.outgoing.some(
      (item) => item.edge_type === "call" && item.node.name === "syntaxBar"
    )
  );
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

test("querySemanticGraph supports multi-hop expansion when max_hops > 1", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/multi-hop-a.ts",
    "export function hopA() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/multi-hop-b.ts",
    "export function hopB() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/multi-hop-c.ts",
    "export function hopC() { return true; }\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const payload = {
    format: "scip-normalized/v1",
    nodes: [
      {
        symbol: "multi hop a",
        path: "src/multi-hop-a.ts",
        name: "hopA",
        kind: "function",
        line: 1,
        column: 1
      },
      {
        symbol: "multi hop b",
        path: "src/multi-hop-b.ts",
        name: "hopB",
        kind: "function",
        line: 1,
        column: 1
      },
      {
        symbol: "multi hop c",
        path: "src/multi-hop-c.ts",
        name: "hopC",
        kind: "function",
        line: 1,
        column: 1
      }
    ],
    edges: [
      {
        from: "multi hop a",
        to: "multi hop b",
        edge_type: "call",
        weight: 2
      },
      {
        from: "multi hop b",
        to: "multi hop c",
        edge_type: "call",
        weight: 2
      }
    ]
  };
  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip-multi-hop.json",
    `${JSON.stringify(payload, null, 2)}\n`
  );

  const imported = await importPreciseIndex(workspaceRoot, {
    path: "artifacts/scip-multi-hop.json",
    mode: "replace",
    source: "scip"
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported.inserted_edges, 2);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "hopA",
    edge_type: "call",
    top_k: 2,
    max_neighbors: 5,
    max_hops: 3,
    per_hop_limit: 5
  });
  assert.equal(query.ok, true);
  assert.equal(query.filters.max_hops, 3);
  const seed = query.seeds.find((item) => item.name === "hopA");
  assert.ok(seed);
  assert.ok(seed.multi_hop);
  assert.equal(seed.multi_hop.max_hops, 3);
  const hop2 = seed.multi_hop.outgoing.find(
    (item) => item.hop === 2 && item.node.name === "hopC"
  );
  assert.ok(hop2);
  assert.equal(typeof hop2.path_score, "number");
  assert.ok(hop2.path_score > 0);
  assert.equal(typeof hop2.quality?.avg_source, "number");
  assert.equal(typeof hop2.quality?.avg_edge_type, "number");
  assert.equal(hop2.path.length, 2);
  assert.equal(hop2.path[0].node.name, "hopB");
  assert.equal(hop2.path[1].node.name, "hopC");
});

test("querySemanticGraph multi-hop keeps higher-quality path for same endpoint", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/quality-a.ts",
    "export function qualityA() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/quality-b-weak.ts",
    "export function qualityBWeak() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/quality-b-strong.ts",
    "export function qualityBStrong() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/quality-terminal.ts",
    "export function qualityTerminal() { return true; }\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const payload = {
    format: "scip-normalized/v1",
    nodes: [
      {
        symbol: "quality a",
        path: "src/quality-a.ts",
        name: "qualityA",
        kind: "function",
        line: 1,
        column: 1
      },
      {
        symbol: "quality b weak",
        path: "src/quality-b-weak.ts",
        name: "qualityBWeak",
        kind: "function",
        line: 1,
        column: 1
      },
      {
        symbol: "quality b strong",
        path: "src/quality-b-strong.ts",
        name: "qualityBStrong",
        kind: "function",
        line: 1,
        column: 1
      },
      {
        symbol: "quality terminal",
        path: "src/quality-terminal.ts",
        name: "qualityTerminal",
        kind: "function",
        line: 1,
        column: 1
      }
    ],
    edges: [
      {
        from: "quality a",
        to: "quality b weak",
        edge_type: "call",
        weight: 2
      },
      {
        from: "quality b weak",
        to: "quality terminal",
        edge_type: "reference",
        weight: 1
      },
      {
        from: "quality a",
        to: "quality b strong",
        edge_type: "call",
        weight: 2
      },
      {
        from: "quality b strong",
        to: "quality terminal",
        edge_type: "call",
        weight: 1
      }
    ]
  };

  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip-quality-paths.json",
    `${JSON.stringify(payload, null, 2)}\n`
  );
  const imported = await importPreciseIndex(workspaceRoot, {
    path: "artifacts/scip-quality-paths.json",
    mode: "replace",
    source: "scip"
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported.inserted_edges, 4);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "qualityA",
    top_k: 2,
    max_neighbors: 10,
    max_hops: 3,
    per_hop_limit: 10
  });
  assert.equal(query.ok, true);
  const seed = query.seeds.find((item) => item.name === "qualityA");
  assert.ok(seed);
  const hop2 = seed.multi_hop?.outgoing?.find(
    (item) => item.hop === 2 && item.node.name === "qualityTerminal"
  );
  assert.ok(hop2);
  assert.equal(hop2.path.length, 2);
  assert.equal(hop2.path[0].node.name, "qualityBStrong");
  assert.equal(hop2.path[1].node.name, "qualityTerminal");
  assert.equal(hop2.path[1].edge_type, "call");
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

test("buildSemanticGraph prefers precise import when SCIP file is present", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/precise.ts",
    "export function preciseAutoToken() { return true; }\n"
  );
  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const precisePayload = {
    format: "scip-normalized/v1",
    nodes: [
      {
        symbol: "scip precise auto",
        path: "src/precise.ts",
        name: "preciseAutoToken",
        kind: "function",
        line: 1,
        column: 1
      }
    ],
    edges: []
  };
  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip.normalized.json",
    `${JSON.stringify(precisePayload, null, 2)}\n`
  );

  const built = await buildSemanticGraph(workspaceRoot, {}, { enabled: false });
  assert.equal(built.ok, true);
  assert.equal(built.strategy?.mode, "precise_import");
  assert.equal(built.imported?.inserted_nodes, 1);

  const query = await querySemanticGraph(workspaceRoot, {
    query: "preciseAutoToken",
    top_k: 3
  });
  assert.equal(query.ok, true);
  assert.equal(query.seeds.length, 1);
  assert.equal(query.seeds[0].source, "scip");
});

test("buildSemanticGraph fails when precise_required is true and file is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/required.ts",
    "export const requiredToken = 1;\n"
  );
  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSemanticGraph(
    workspaceRoot,
    {
      precise_required: true,
      precise_index_paths: ["artifacts/not-found.json"]
    },
    { enabled: false }
  );
  assert.equal(built.ok, false);
  assert.match(String(built.error), /precise index file not found/i);
  assert.equal(built.strategy?.mode, "precise_required_missing");
});
