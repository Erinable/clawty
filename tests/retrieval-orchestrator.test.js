import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyVectorQueryFailure,
  collectAndRankHybridCandidatesWithDeps,
  queryHybridRetrievalSourcesWithDeps
} from "../src/retrieval-orchestrator.js";

test("classifyVectorQueryFailure distinguishes missing-key errors", () => {
  assert.equal(
    classifyVectorQueryFailure({ message: "embedding api key is missing" }),
    "EMBEDDING_API_KEY_MISSING"
  );
  assert.equal(
    classifyVectorQueryFailure({ code: "EMBEDDING_API_KEY_MISSING" }),
    "EMBEDDING_API_KEY_MISSING"
  );
  assert.equal(
    classifyVectorQueryFailure({ message: "network timeout" }),
    "VECTOR_QUERY_FAILED"
  );
});

test("queryHybridRetrievalSourcesWithDeps skips vector query when disabled", async () => {
  let vectorCalled = false;
  const result = await queryHybridRetrievalSourcesWithDeps(
    {
      workspaceRoot: "/repo",
      query: "token",
      scanTopK: 12,
      topK: 4,
      effectiveArgs: {
        max_neighbors: 6,
        max_hops: 2,
        per_hop_limit: 3,
        path_prefix: "src",
        language: "javascript"
      },
      vectorEnabled: false
    },
    {
      querySemanticGraph: async (workspaceRoot, args) => {
        assert.equal(workspaceRoot, "/repo");
        assert.equal(args.query, "token");
        assert.equal(args.top_k, 12);
        return { ok: true, seeds: [] };
      },
      querySyntaxIndex: async () => ({ ok: true, seeds: [] }),
      queryCodeIndex: async () => ({ ok: true, results: [] }),
      queryVectorIndex: async () => {
        vectorCalled = true;
        return { ok: true, results: [] };
      }
    }
  );

  assert.equal(vectorCalled, false);
  assert.equal(result.vectorResult.ok, false);
  assert.equal(result.vectorResult.skipped, true);
  assert.match(result.vectorResult.error, /vector source disabled/i);
});

test("queryHybridRetrievalSourcesWithDeps classifies vector query failures", async () => {
  const result = await queryHybridRetrievalSourcesWithDeps(
    {
      workspaceRoot: "/repo",
      query: "token",
      scanTopK: 8,
      topK: 3,
      vectorEnabled: true
    },
    {
      querySemanticGraph: async () => ({ ok: true, seeds: [] }),
      querySyntaxIndex: async () => ({ ok: true, seeds: [] }),
      queryCodeIndex: async () => ({ ok: true, results: [] }),
      queryVectorIndex: async () => {
        const error = new Error("embedding api key is missing");
        error.code = "EMBEDDING_API_KEY_MISSING";
        throw error;
      }
    }
  );

  assert.equal(result.vectorResult.ok, false);
  assert.equal(result.vectorResult.error_code, "EMBEDDING_API_KEY_MISSING");
});

test("collectAndRankHybridCandidatesWithDeps merges sources and preserves rank inputs", () => {
  const rankCalls = [];
  const mapSyntaxCalls = [];
  const ranked = collectAndRankHybridCandidatesWithDeps(
    {
      semanticResult: {
        ok: true,
        seeds: [{ path: "src/a.ts", source: "semantic" }]
      },
      syntaxResult: {
        ok: true,
        seeds: [{ path: "src/a.ts" }, { path: "src/b.ts" }]
      },
      indexResult: {
        ok: true,
        results: [{ path: "src/c.ts" }]
      },
      vectorResult: {
        ok: true,
        results: [{ path: "src/c.ts" }, { path: "src/d.ts" }]
      },
      edgeType: "call",
      query: "token",
      pathPrefix: "src",
      explain: true
    },
    {
      mapSyntaxSeedToSemanticSeed: (seed, edgeType) => {
        mapSyntaxCalls.push({ seed, edgeType });
        return {
          ...seed,
          source: "syntax",
          mapped_from_edge_type: edgeType
        };
      },
      mapIndexResultToHybridSeed: (item) => ({
        path: item.path,
        source: "index"
      }),
      mapVectorResultToHybridSeed: (item) => ({
        path: item.path,
        source: "vector"
      }),
      addHybridCandidate: (map, candidate, provider) => {
        const key = candidate.path;
        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            candidate,
            providers: new Set([provider])
          });
          return;
        }
        existing.providers.add(provider);
      },
      rankHybridCandidates: (entries, options) => {
        rankCalls.push({ entries, options });
        return entries.map((entry) => ({
          ...entry.candidate,
          supporting_providers: Array.from(entry.providers).sort()
        }));
      }
    }
  );

  assert.equal(mapSyntaxCalls.length, 2);
  assert.ok(mapSyntaxCalls.every((item) => item.edgeType === "call"));
  assert.equal(ranked.scannedCandidates.length, 6);
  assert.equal(ranked.deduped.size, 4);
  assert.equal(ranked.ranked.length, 4);
  assert.equal(rankCalls.length, 1);
  assert.equal(rankCalls[0].options.query, "token");
  assert.equal(rankCalls[0].options.path_prefix, "src");
  assert.equal(rankCalls[0].options.explain, true);

  const cEntry = ranked.ranked.find((item) => item.path === "src/c.ts");
  assert.ok(cEntry);
  assert.deepEqual(cEntry.supporting_providers, ["index", "vector"]);
});
