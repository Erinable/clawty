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
