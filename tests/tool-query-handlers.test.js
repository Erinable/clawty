import test from "node:test";
import assert from "node:assert/strict";
import { createQueryToolHandlers } from "../src/tool-query-handlers.js";

function createDeps(calls) {
  const stub = (name, valueFactory) => async (...args) => {
    calls.push({ name, args });
    if (typeof valueFactory === "function") {
      return valueFactory(...args);
    }
    return { ok: true, name };
  };

  return {
    buildCodeIndex: stub("buildCodeIndex"),
    getIndexStats: stub("getIndexStats"),
    queryCodeIndex: stub("queryCodeIndex"),
    refreshCodeIndex: stub("refreshCodeIndex"),
    buildSemanticGraph: stub("buildSemanticGraph"),
    refreshSemanticGraph: stub("refreshSemanticGraph"),
    importPreciseIndex: stub("importPreciseIndex"),
    getSemanticGraphStats: stub("getSemanticGraphStats"),
    buildSyntaxIndex: stub("buildSyntaxIndex"),
    querySyntaxIndex: stub("querySyntaxIndex"),
    refreshSyntaxIndex: stub("refreshSyntaxIndex"),
    getSyntaxIndexStats: stub("getSyntaxIndexStats"),
    querySemanticGraphWithFallback: stub("querySemanticGraphWithFallback"),
    buildVectorIndex: stub("buildVectorIndex"),
    refreshVectorIndex: stub("refreshVectorIndex"),
    queryVectorIndex: stub("queryVectorIndex"),
    getVectorIndexStats: stub("getVectorIndexStats"),
    mergeVectorDelta: stub("mergeVectorDelta"),
    runHybridQueryPipeline: stub("runHybridQueryPipeline", (payload) => payload),
    lspDefinition: stub("lspDefinition"),
    lspHealth: stub("lspHealth"),
    lspReferences: stub("lspReferences"),
    lspWorkspaceSymbols: stub("lspWorkspaceSymbols"),
    resolveSafePath: (workspaceRoot, inputPath) => `${workspaceRoot}:${inputPath}`,
    metricsSubdir: ".clawty/metrics",
    hybridQueryMetricsFile: "hybrid-query.jsonl"
  };
}

test("createQueryToolHandlers merges index defaults for build and refresh", async () => {
  const calls = [];
  const handlers = createQueryToolHandlers(createDeps(calls));
  const context = {
    workspaceRoot: "/repo",
    index: {
      maxFiles: 111,
      maxFileSizeKb: 222
    }
  };

  await handlers.build_code_index({}, context);
  await handlers.refresh_code_index({ max_files: 5 }, context);

  const buildCall = calls.find((item) => item.name === "buildCodeIndex");
  assert.deepEqual(buildCall.args, [
    "/repo",
    {
      max_files: 111,
      max_file_size_kb: 222
    }
  ]);

  const refreshCall = calls.find((item) => item.name === "refreshCodeIndex");
  assert.deepEqual(refreshCall.args, [
    "/repo",
    {
      max_files: 5,
      max_file_size_kb: 222
    }
  ]);
});

test("createQueryToolHandlers forwards hybrid pipeline wiring payload", async () => {
  const calls = [];
  const handlers = createQueryToolHandlers(createDeps(calls));
  const context = { workspaceRoot: "/repo", embedding: { provider: "mock" } };
  const args = { query: "token", top_k: 3 };

  const result = await handlers.query_hybrid_index(args, context);
  assert.deepEqual(result.args, args);
  assert.deepEqual(result.context, context);
  assert.equal(result.metricsSubdir, ".clawty/metrics");
  assert.equal(result.metricsFileName, "hybrid-query.jsonl");
  assert.equal(typeof result.resolveSafePath, "function");
});

test("createQueryToolHandlers passes embedding and lsp context to adapters", async () => {
  const calls = [];
  const handlers = createQueryToolHandlers(createDeps(calls));
  const context = {
    workspaceRoot: "/repo",
    embedding: { apiKey: "k" },
    lsp: { enabled: true }
  };

  await handlers.build_vector_index({ layer: "base" }, context);
  await handlers.lsp_definition({ path: "src/a.ts", line: 1, column: 1 }, context);

  const vectorCall = calls.find((item) => item.name === "buildVectorIndex");
  assert.deepEqual(vectorCall.args, [
    "/repo",
    { layer: "base" },
    { embedding: { apiKey: "k" } }
  ]);

  const lspCall = calls.find((item) => item.name === "lspDefinition");
  assert.deepEqual(lspCall.args, [
    "/repo",
    { path: "src/a.ts", line: 1, column: 1 },
    { enabled: true }
  ]);
});

test("createQueryToolHandlers attaches retrieval protocol to query responses", async () => {
  const calls = [];
  const deps = createDeps(calls);
  deps.queryCodeIndex = async () => ({
    ok: true,
    results: [{ path: "src/a.ts", score: 6.5, hit_line: 3 }]
  });
  deps.querySyntaxIndex = async () => ({
    ok: true,
    seeds: [{ path: "src/a.ts", import_count: 2, call_count: 1 }]
  });
  deps.querySemanticGraphWithFallback = async () => ({
    ok: true,
    provider: "syntax",
    seeds: [{ path: "src/a.ts", source: "syntax_fallback", name: "a", kind: "file" }]
  });
  deps.queryVectorIndex = async () => ({
    ok: true,
    results: [{ path: "src/a.ts", chunk_id: "chunk-1", start_line: 1, end_line: 10, score: 0.88 }]
  });
  deps.runHybridQueryPipeline = async () => ({
    ok: true,
    provider: "hybrid",
    seeds: [{ path: "src/a.ts", source: "semantic", hybrid_score: 0.9 }]
  });
  const handlers = createQueryToolHandlers(deps);
  const context = { workspaceRoot: "/repo" };

  const codeResult = await handlers.query_code_index({ query: "a" }, context);
  assert.equal(typeof codeResult.results[0].retrieval, "object");
  assert.equal(codeResult.results[0].retrieval.source, "index");

  const syntaxResult = await handlers.query_syntax_index({ query: "a" }, context);
  assert.equal(typeof syntaxResult.seeds[0].retrieval, "object");
  assert.equal(syntaxResult.seeds[0].retrieval.source, "syntax");

  const semanticResult = await handlers.query_semantic_graph({ query: "a" }, context);
  assert.equal(typeof semanticResult.seeds[0].retrieval, "object");
  assert.equal(semanticResult.seeds[0].retrieval.source, "syntax_fallback");

  const vectorResult = await handlers.query_vector_index({ query: "a" }, context);
  assert.equal(typeof vectorResult.results[0].retrieval, "object");
  assert.equal(vectorResult.results[0].retrieval.source, "vector");

  const hybridResult = await handlers.query_hybrid_index({ query: "a" }, context);
  assert.equal(typeof hybridResult.seeds[0].retrieval, "object");
  assert.equal(hybridResult.seeds[0].retrieval.source, "semantic");
});
