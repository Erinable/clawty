import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";
import { EmbeddingError } from "../src/embedding-client.js";
import {
  createWorkspace,
  initGitRepo,
  readWorkspaceFile,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function createContext(workspaceRoot) {
  return {
    workspaceRoot,
    defaultTimeoutMs: 30_000
  };
}

function createMockVectorEmbeddingClient() {
  return async ({ input }) =>
    input.map((text) => {
      const normalized = String(text || "").toLowerCase();
      return [
        normalized.includes("alpha") ? 1 : 0,
        normalized.includes("beta") ? 1 : 0,
        normalized.includes("newtoken") ? 1 : 0,
        0.05
      ];
    });
}

test("read_file and write_file work inside workspace", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const write = await runTool(
    "write_file",
    { path: "src/demo.js", content: "export const demo = 1;\n" },
    context
  );
  assert.equal(write.ok, true);
  assert.equal(write.path, "src/demo.js");

  const read = await runTool("read_file", { path: "src/demo.js" }, context);
  assert.equal(read.ok, true);
  assert.match(read.content, /demo = 1/);
});

test("file tools reject path traversal outside workspace", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  await assert.rejects(
    () => runTool("read_file", { path: "../outside.js" }, context),
    /Path escapes workspace root/
  );
});

test("run_shell blocks dangerous commands", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const blocked = await runTool("run_shell", { command: "rm -rf /tmp/test" }, context);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
});

test("run_shell executes safe commands", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const output = await runTool("run_shell", { command: "echo clawty-test" }, context);
  assert.equal(output.ok, true);
  assert.equal(output.exit_code, 0);
  assert.match(output.stdout, /clawty-test/);
});

test("apply_patch supports check-only and apply modes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await initGitRepo(workspaceRoot);
  await writeWorkspaceFile(workspaceRoot, "src/value.js", "const value = 1;\n");

  const patch = [
    "diff --git a/src/value.js b/src/value.js",
    "--- a/src/value.js",
    "+++ b/src/value.js",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
    ""
  ].join("\n");

  const context = createContext(workspaceRoot);
  const checked = await runTool("apply_patch", { patch, check: true }, context);
  assert.equal(checked.ok, true);
  assert.equal(checked.checked, true);

  const before = await readWorkspaceFile(workspaceRoot, "src/value.js");
  assert.match(before, /value = 1/);

  const applied = await runTool("apply_patch", { patch }, context);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.files, ["src/value.js"]);

  const after = await readWorkspaceFile(workspaceRoot, "src/value.js");
  assert.match(after, /value = 2/);
});

test("apply_patch rejects unsafe absolute patch paths", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await initGitRepo(workspaceRoot);
  const context = createContext(workspaceRoot);
  const patch = [
    "diff --git a/src/value.js b/src/value.js",
    "--- a/src/value.js",
    "+++ /tmp/hack.js",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
    ""
  ].join("\n");

  await assert.rejects(
    () => runTool("apply_patch", { patch }, context),
    /workspace-relative/
  );
});

test("index tools are callable through runTool", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/indexable.js", "const symbolAlpha = true;\n");
  const context = createContext(workspaceRoot);

  const built = await runTool("build_code_index", {}, context);
  assert.equal(built.ok, true);

  const refreshed = await runTool("refresh_code_index", {}, context);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "incremental");

  const queried = await runTool("query_code_index", { query: "symbolAlpha", top_k: 1 }, context);
  assert.equal(queried.ok, true);
  assert.equal(queried.results[0].path, "src/indexable.js");

  const queriedWithExplain = await runTool(
    "query_code_index",
    {
      query: "symbolAlpha",
      language: "javascript",
      path_prefix: "src",
      explain: true,
      top_k: 1
    },
    context
  );
  assert.equal(queriedWithExplain.ok, true);
  assert.ok(queriedWithExplain.results[0].explain);

  const eventRefreshed = await runTool(
    "refresh_code_index",
    { changed_paths: ["src/indexable.js"], deleted_paths: ["src/missing.js"] },
    context
  );
  assert.equal(eventRefreshed.ok, true);
  assert.equal(eventRefreshed.mode, "event");

  const stats = await runTool("get_index_stats", { top_files: 3 }, context);
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.files >= 1);
});

test("syntax index tools are callable through runTool", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-main.js",
    "import { syntaxDep } from './syntax-dep.js';\nexport function syntaxMain() { return syntaxDep(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-dep.js",
    "export function syntaxDep() { return true; }\n"
  );

  const context = createContext(workspaceRoot);
  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const builtSyntax = await runTool(
    "build_syntax_index",
    { max_files: 20, max_calls_per_file: 20 },
    context
  );
  assert.equal(builtSyntax.ok, true);
  assert.equal(builtSyntax.mode, "full");
  assert.ok(builtSyntax.total_import_edges >= 1);

  const statsBefore = await runTool("get_syntax_index_stats", { top_files: 5 }, context);
  assert.equal(statsBefore.ok, true);
  assert.ok(statsBefore.counts.files >= 2);

  const queriedSyntax = await runTool(
    "query_syntax_index",
    { query: "syntaxMain", top_k: 3, max_neighbors: 5, path_prefix: "src" },
    context
  );
  assert.equal(queriedSyntax.ok, true);
  assert.ok(queriedSyntax.total_seeds >= 1);
  assert.ok(Array.isArray(queriedSyntax.seeds[0].outgoing_imports));
  assert.ok(Array.isArray(queriedSyntax.seeds[0].outgoing_calls));

  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-main.js",
    "import { syntaxDep } from './syntax-dep.js';\nexport function syntaxMain() { return syntaxDep() && syntaxDep(); }\n"
  );
  const refreshedIndex = await runTool(
    "refresh_code_index",
    { changed_paths: ["src/syntax-main.js"] },
    context
  );
  assert.equal(refreshedIndex.ok, true);

  const refreshedSyntax = await runTool(
    "refresh_syntax_index",
    { changed_paths: ["src/syntax-main.js"] },
    context
  );
  assert.equal(refreshedSyntax.ok, true);
  assert.equal(refreshedSyntax.mode, "event");
  assert.ok(refreshedSyntax.parsed_files >= 1);
});

test("vector index tools are callable through runTool", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-alpha.js",
    "export function alphaToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-beta.js",
    "export function betaToken() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    embedding: {
      model: "mock-vector-model",
      client: createMockVectorEmbeddingClient()
    }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const builtVector = await runTool(
    "build_vector_index",
    { layer: "base", batch_size: 8, model: "mock-vector-model" },
    context
  );
  assert.equal(builtVector.ok, true);
  assert.equal(builtVector.layer, "base");
  assert.ok(builtVector.processed_chunks >= 2);

  const queriedVector = await runTool(
    "query_vector_index",
    {
      query: "alphaToken",
      top_k: 3,
      layers: ["base"],
      model: "mock-vector-model"
    },
    context
  );
  assert.equal(queriedVector.ok, true);
  assert.ok(queriedVector.results.length >= 1);
  assert.equal(queriedVector.results[0].path, "src/vector-alpha.js");

  const hybrid = await runTool(
    "query_hybrid_index",
    {
      query: "betaToken",
      include_vector: true,
      vector_layers: ["base"],
      vector_max_candidates: 200
    },
    context
  );
  assert.equal(hybrid.ok, true);
  assert.equal(hybrid.sources.vector.enabled, true);
  assert.equal(hybrid.sources.vector.ok, true);
  assert.ok(hybrid.sources.vector.candidates >= 1);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-alpha.js",
    "export function newToken() { return true; }\n"
  );

  const refreshedIndex = await runTool(
    "refresh_code_index",
    { changed_paths: ["src/vector-alpha.js"] },
    context
  );
  assert.equal(refreshedIndex.ok, true);

  const refreshedVector = await runTool(
    "refresh_vector_index",
    {
      layer: "delta",
      changed_paths: ["src/vector-alpha.js"],
      model: "mock-vector-model"
    },
    context
  );
  assert.equal(refreshedVector.ok, true);
  assert.equal(refreshedVector.layer, "delta");

  const mergedVector = await runTool("merge_vector_delta", {}, context);
  assert.equal(mergedVector.ok, true);
  assert.ok(mergedVector.merged_files >= 1);

  const stats = await runTool("get_vector_index_stats", {}, context);
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.chunks.base >= 1);
});

test("semantic graph tools are callable through runTool", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/semantic-a.ts",
    "import { semanticB } from './semantic-b';\nexport function semanticA() { return semanticB(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/semantic-b.ts",
    "export function semanticB() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const builtSyntax = await runTool("build_syntax_index", {}, context);
  assert.equal(builtSyntax.ok, true);

  const builtGraph = await runTool(
    "build_semantic_graph",
    {
      max_symbols: 20,
      include_definitions: true,
      include_references: true,
      include_syntax: true
    },
    context
  );
  assert.equal(builtGraph.ok, true);
  assert.ok(builtGraph.seeded_nodes >= 2);
  assert.ok(builtGraph.edge_counts.import >= 1);
  assert.ok(builtGraph.edge_counts.call >= 1);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/semantic-a.ts",
    "import { semanticB2 } from './semantic-b2';\nexport function semanticA2() { return semanticB2(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/semantic-b2.ts",
    "export function semanticB2() { return true; }\n"
  );
  const refreshedCode = await runTool(
    "refresh_code_index",
    { changed_paths: ["src/semantic-a.ts", "src/semantic-b2.ts"], deleted_paths: ["src/semantic-b.ts"] },
    context
  );
  assert.equal(refreshedCode.ok, true);
  assert.equal(refreshedCode.mode, "event");

  const refreshedSyntax = await runTool(
    "refresh_syntax_index",
    { changed_paths: ["src/semantic-a.ts", "src/semantic-b2.ts"], deleted_paths: ["src/semantic-b.ts"] },
    context
  );
  assert.equal(refreshedSyntax.ok, true);

  const refreshedGraph = await runTool(
    "refresh_semantic_graph",
    {
      changed_paths: ["src/semantic-a.ts", "src/semantic-b2.ts"],
      deleted_paths: ["src/semantic-b.ts"],
      include_definitions: false,
      include_references: false,
      include_syntax: true
    },
    context
  );
  assert.equal(refreshedGraph.ok, true);
  assert.equal(refreshedGraph.mode, "event");

  await writeWorkspaceFile(
    workspaceRoot,
    "artifacts/scip.normalized.json",
    JSON.stringify(
      {
        format: "scip-normalized/v1",
        nodes: [
          {
            symbol: "tool semanticA",
            path: "src/semantic-a.ts",
            name: "semanticA",
            kind: "function",
            line: 2,
            column: 1
          },
          {
            symbol: "tool semanticB",
            path: "src/semantic-b.ts",
            name: "semanticB",
            kind: "function",
            line: 1,
            column: 1
          }
        ],
        edges: [
          {
            from: "tool semanticA",
            to: "tool semanticB",
            edge_type: "call",
            weight: 2
          }
        ]
      },
      null,
      2
    )
  );

  const imported = await runTool(
    "import_precise_index",
    { path: "artifacts/scip.normalized.json", mode: "merge", source: "scip" },
    context
  );
  assert.equal(imported.ok, true);
  assert.equal(imported.imported.inserted_edges, 1);

  const graphStats = await runTool("get_semantic_graph_stats", {}, context);
  assert.equal(graphStats.ok, true);
  assert.ok(graphStats.counts.nodes >= 2);
  assert.ok(graphStats.edge_sources.some((item) => item.source === "scip"));

  const query = await runTool(
    "query_semantic_graph",
    { query: "semanticA", edge_type: "call", top_k: 3, max_neighbors: 5 },
    context
  );
  assert.equal(query.ok, true);
  assert.ok(query.total_seeds >= 1);
});

test("query_semantic_graph falls back to syntax index when semantic graph is empty", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-fallback.ts",
    "import { syntaxDepToken } from './syntax-dep';\nexport function syntaxFallbackToken() { return syntaxDepToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/syntax-dep.ts",
    "export function syntaxDepToken() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);
  const builtSyntax = await runTool("build_syntax_index", {}, context);
  assert.equal(builtSyntax.ok, true);

  const query = await runTool(
    "query_semantic_graph",
    { query: "syntaxFallbackToken", edge_type: "import", top_k: 3, max_neighbors: 5 },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.fallback, true);
  assert.equal(query.provider, "syntax");
  assert.ok(Array.isArray(query.seeds));
  assert.ok(query.seeds.length >= 1);
  assert.ok(query.seeds[0].outgoing.some((item) => item.edge_source === "syntax"));
  assert.ok(query.language_distribution);
  assert.ok(query.language_distribution.returned_seeds);
});

test("query_semantic_graph falls back to index when semantic graph is empty", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/fallback.ts",
    "export function fallbackToken() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const query = await runTool(
    "query_semantic_graph",
    { query: "fallbackToken", top_k: 3 },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.fallback, true);
  assert.equal(query.provider, "index");
  assert.ok(Array.isArray(query.seeds));
  assert.ok(query.seeds.length >= 1);
  assert.ok(query.language_distribution);
  assert.ok(query.language_distribution.returned_seeds);
});

test("query_hybrid_index fuses semantic/syntax/index and respects path_prefix rerank", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-main.ts",
    "import { hybridDep } from './hybrid-dep';\nexport function hybridSignal() { return hybridDep(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-dep.ts",
    "export function hybridDep() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "tests/hybrid-main.spec.ts",
    "export function hybridSignal() { return false; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const builtSyntax = await runTool("build_syntax_index", {}, context);
  assert.equal(builtSyntax.ok, true);

  const builtGraph = await runTool(
    "build_semantic_graph",
    {
      max_symbols: 50,
      include_definitions: false,
      include_references: false,
      include_syntax: true,
      precise_preferred: false
    },
    context
  );
  assert.equal(builtGraph.ok, true);

  const query = await runTool(
    "query_hybrid_index",
    {
      query: "hybridSignal",
      top_k: 5,
      path_prefix: "src",
      explain: true,
      max_neighbors: 6
    },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.provider, "hybrid");
  assert.ok(query.total_seeds >= 1);
  assert.ok(query.sources.semantic.ok);
  assert.ok(query.sources.syntax.ok);
  assert.ok(query.sources.index.ok);
  assert.ok(query.seeds[0].path.startsWith("src/"));
  assert.ok(Array.isArray(query.seeds[0].supporting_providers));
  assert.ok(query.seeds[0].supporting_providers.length >= 1);
  assert.equal(typeof query.seeds[0].hybrid_score, "number");
  assert.ok(query.seeds[0].hybrid_explain);
  assert.ok(query.language_distribution);
});

test("query_hybrid_index still returns candidates when semantic graph is empty", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-fallback.ts",
    "import { fallbackDep } from './fallback-dep';\nexport function hybridFallbackToken() { return fallbackDep(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/fallback-dep.ts",
    "export function fallbackDep() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);
  const builtSyntax = await runTool("build_syntax_index", {}, context);
  assert.equal(builtSyntax.ok, true);

  const query = await runTool(
    "query_hybrid_index",
    {
      query: "hybridFallbackToken",
      top_k: 5
    },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.provider, "hybrid");
  assert.ok(query.total_seeds >= 1);
  assert.equal(query.sources.semantic.ok, false);
  assert.ok(query.sources.syntax.ok);
  assert.ok(query.sources.index.ok);
  assert.ok(query.seeds.some((seed) => seed.path === "src/hybrid-fallback.ts"));
});

test("query_hybrid_index supports optional embedding rerank with mock client", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-embed.ts",
    "export function hybridEmbedToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "tests/hybrid-embed.spec.ts",
    "export function hybridEmbedToken() { return false; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false },
    embedding: {
      enabled: true,
      model: "mock-embedding",
      topK: 10,
      weight: 0.95,
      client: async ({ input }) =>
        input.map((text, idx) => {
          if (idx === 0) {
            return [1, 0];
          }
          return String(text).includes("tests/hybrid-embed.spec.ts") ? [1, 0] : [0, 1];
        })
    }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);
  const builtSyntax = await runTool("build_syntax_index", {}, context);
  assert.equal(builtSyntax.ok, true);
  const builtGraph = await runTool(
    "build_semantic_graph",
    {
      max_symbols: 50,
      include_definitions: false,
      include_references: false,
      include_syntax: true,
      precise_preferred: false
    },
    context
  );
  assert.equal(builtGraph.ok, true);

  const query = await runTool(
    "query_hybrid_index",
    {
      query: "hybridEmbedToken",
      top_k: 3,
      explain: true,
      enable_embedding: true,
      embedding_top_k: 3,
      embedding_weight: 0.95
    },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.sources.embedding.enabled, true);
  assert.equal(query.sources.embedding.attempted, true);
  assert.equal(query.sources.embedding.ok, true);
  assert.equal(query.sources.embedding.model, "mock-embedding");
  assert.equal(query.sources.embedding.status_code, "EMBEDDING_OK");
  assert.ok(query.sources.embedding.reranked_candidates >= 1);
  assert.ok(query.sources.embedding.rank_shift_count >= 1);
  assert.equal(query.sources.embedding.top1_changed, true);
  assert.ok(query.sources.embedding.score_delta_mean > 0);
  assert.equal(query.seeds[0].path, "tests/hybrid-embed.spec.ts");
  assert.ok(query.seeds[0].hybrid_explain);
  assert.equal(typeof query.seeds[0].hybrid_explain.embedding_score, "number");
});

test("query_hybrid_index degrades gracefully when embedding is enabled without key", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-embed-fallback.ts",
    "export function hybridEmbedFallback() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false },
    embedding: {
      enabled: true,
      apiKey: ""
    }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const query = await runTool(
    "query_hybrid_index",
    {
      query: "hybridEmbedFallback",
      top_k: 3,
      enable_embedding: true
    },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.sources.embedding.enabled, true);
  assert.equal(query.sources.embedding.attempted, false);
  assert.equal(query.sources.embedding.ok, false);
  assert.equal(query.sources.embedding.status_code, "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY");
  assert.equal(query.sources.embedding.error_code, "EMBEDDING_API_KEY_MISSING");
  assert.match(String(query.sources.embedding.error), /api key is missing/i);
  assert.ok(query.seeds.some((seed) => seed.path === "src/hybrid-embed-fallback.ts"));
});

test("query_hybrid_index classifies embedding timeout errors and keeps fallback results", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/hybrid-embed-timeout.ts",
    "export function hybridEmbedTimeout() { return true; }\n"
  );

  const context = {
    ...createContext(workspaceRoot),
    lsp: { enabled: false },
    embedding: {
      enabled: true,
      model: "mock-timeout",
      topK: 5,
      weight: 0.5,
      client: async () => {
        throw new EmbeddingError("EMBEDDING_REQUEST_TIMEOUT", "mock timeout", {
          retryable: true
        });
      }
    }
  };

  const builtIndex = await runTool("build_code_index", {}, context);
  assert.equal(builtIndex.ok, true);

  const query = await runTool(
    "query_hybrid_index",
    {
      query: "hybridEmbedTimeout",
      top_k: 3,
      enable_embedding: true
    },
    context
  );
  assert.equal(query.ok, true);
  assert.equal(query.sources.embedding.enabled, true);
  assert.equal(query.sources.embedding.attempted, true);
  assert.equal(query.sources.embedding.ok, false);
  assert.equal(query.sources.embedding.status_code, "EMBEDDING_ERROR_TIMEOUT");
  assert.equal(query.sources.embedding.error_code, "EMBEDDING_REQUEST_TIMEOUT");
  assert.equal(query.sources.embedding.retryable, true);
  assert.ok(query.sources.embedding.latency_ms >= 0);
  assert.ok(query.seeds.some((seed) => seed.path === "src/hybrid-embed-timeout.ts"));
});
