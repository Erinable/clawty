import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCodeIndex, refreshCodeIndex } from "../src/code-index.js";
import {
  buildVectorIndex,
  refreshVectorIndex,
  queryVectorIndex,
  getVectorIndexStats,
  mergeVectorDelta
} from "../src/vector-index.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function createMockEmbeddingClient() {
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

function createEmbeddingContext() {
  return {
    embedding: {
      model: "mock-vector-model",
      client: createMockEmbeddingClient()
    }
  };
}

test("build/query/get stats for vector index with mock embeddings", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-alpha.js",
    "export function alphaToken() { return 'alpha'; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-beta.js",
    "export function betaToken() { return 'beta'; }\n"
  );

  const builtCodeIndex = await buildCodeIndex(workspaceRoot, {});
  assert.equal(builtCodeIndex.ok, true);

  const context = createEmbeddingContext();
  const builtVector = await buildVectorIndex(
    workspaceRoot,
    { layer: "base", batch_size: 2, model: "mock-vector-model" },
    context
  );
  assert.equal(builtVector.ok, true);
  assert.equal(builtVector.layer, "base");
  assert.ok(builtVector.processed_chunks >= 2);

  const queried = await queryVectorIndex(
    workspaceRoot,
    {
      query: "alphaToken",
      top_k: 3,
      layers: ["base"],
      model: "mock-vector-model"
    },
    context
  );
  assert.equal(queried.ok, true);
  assert.ok(queried.results.length >= 1);
  assert.equal(queried.results[0].path, "src/vector-alpha.js");

  const stats = await getVectorIndexStats(workspaceRoot);
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.chunks.base >= 2);
  assert.equal(stats.latest_run?.layer, "base");
});

test("refresh + merge vector delta keeps base layer queryable", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-main.js",
    "export function oldToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-old.js",
    "export function staleToken() { return false; }\n"
  );

  const builtCodeIndex = await buildCodeIndex(workspaceRoot, {});
  assert.equal(builtCodeIndex.ok, true);

  const context = createEmbeddingContext();
  const builtVector = await buildVectorIndex(
    workspaceRoot,
    { layer: "base", model: "mock-vector-model" },
    context
  );
  assert.equal(builtVector.ok, true);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/vector-main.js",
    "export function newToken() { return true; }\n"
  );
  await fs.rm(path.join(workspaceRoot, "src/vector-old.js"), { force: true });

  const refreshedCodeIndex = await refreshCodeIndex(workspaceRoot, {
    changed_paths: ["src/vector-main.js"],
    deleted_paths: ["src/vector-old.js"]
  });
  assert.equal(refreshedCodeIndex.ok, true);
  assert.equal(refreshedCodeIndex.mode, "event");

  const refreshedVector = await refreshVectorIndex(
    workspaceRoot,
    {
      layer: "delta",
      changed_paths: ["src/vector-main.js"],
      deleted_paths: ["src/vector-old.js"],
      model: "mock-vector-model"
    },
    context
  );
  assert.equal(refreshedVector.ok, true);
  assert.equal(refreshedVector.mode, "event");
  assert.equal(refreshedVector.layer, "delta");
  assert.ok(refreshedVector.processed_chunks >= 1);

  const deltaQuery = await queryVectorIndex(
    workspaceRoot,
    { query: "newToken", layers: ["delta"], top_k: 3, model: "mock-vector-model" },
    context
  );
  assert.equal(deltaQuery.ok, true);
  assert.ok(deltaQuery.results.some((item) => item.path === "src/vector-main.js"));
  assert.equal(deltaQuery.results.some((item) => item.path === "src/vector-old.js"), false);

  const merged = await mergeVectorDelta(workspaceRoot);
  assert.equal(merged.ok, true);
  assert.ok(merged.merged_files >= 1);
  assert.ok(merged.merged_chunks >= 1);

  const baseQuery = await queryVectorIndex(
    workspaceRoot,
    { query: "newToken", layers: ["base"], top_k: 3, model: "mock-vector-model" },
    context
  );
  assert.equal(baseQuery.ok, true);
  assert.ok(baseQuery.results.some((item) => item.path === "src/vector-main.js"));

  const stats = await getVectorIndexStats(workspaceRoot);
  assert.equal(stats.ok, true);
  assert.equal(stats.counts.chunks.delta, 0);
});
