import test from "node:test";
import assert from "node:assert/strict";
import {
  attachHybridRetrievalProtocol,
  attachIndexRetrievalProtocol,
  attachSemanticRetrievalProtocol,
  attachSyntaxRetrievalProtocol,
  attachVectorRetrievalProtocol
} from "../src/retrieval-adapters.js";

test("attachIndexRetrievalProtocol keeps response shape and appends retrieval", () => {
  const input = {
    ok: true,
    results: [{ path: "src/a.ts", score: 6.2, hit_line: 1 }]
  };
  const output = attachIndexRetrievalProtocol(input);
  assert.equal(output.ok, true);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].path, "src/a.ts");
  assert.equal(output.results[0].retrieval.source, "index");
});

test("attachSyntaxRetrievalProtocol appends retrieval for syntax seeds", () => {
  const input = {
    ok: true,
    seeds: [
      {
        path: "src/a.ts",
        import_count: 2,
        call_count: 3,
        incoming_importers: [],
        incoming_callers: []
      }
    ]
  };
  const output = attachSyntaxRetrievalProtocol(input);
  assert.equal(output.ok, true);
  assert.equal(output.seeds.length, 1);
  assert.equal(output.seeds[0].retrieval.source, "syntax");
  assert.equal(typeof output.seeds[0].retrieval.confidence.score, "number");
});

test("attachSemanticRetrievalProtocol supports fallback seed sources", () => {
  const input = {
    ok: true,
    provider: "syntax",
    seeds: [{ path: "src/a.ts", source: "syntax_fallback", name: "a", kind: "file" }]
  };
  const output = attachSemanticRetrievalProtocol(input);
  assert.equal(output.ok, true);
  assert.equal(output.seeds.length, 1);
  assert.equal(output.seeds[0].retrieval.source, "syntax_fallback");
  assert.equal(typeof output.seeds[0].retrieval.dedup_key, "string");
});

test("attachVectorRetrievalProtocol appends retrieval for vector results", () => {
  const input = {
    ok: true,
    results: [
      {
        chunk_id: "chunk-1",
        path: "src/vector.ts",
        start_line: 2,
        end_line: 9,
        score: 0.77
      }
    ]
  };
  const output = attachVectorRetrievalProtocol(input);
  assert.equal(output.ok, true);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].retrieval.source, "vector");
  assert.equal(typeof output.results[0].retrieval.confidence.score, "number");
});

test("attachHybridRetrievalProtocol backfills missing retrieval fields", () => {
  const input = {
    ok: true,
    seeds: [
      {
        path: "src/hybrid.ts",
        source: "semantic",
        hybrid_score: 0.91,
        freshness_score: 0.6
      }
    ]
  };
  const output = attachHybridRetrievalProtocol(input);
  assert.equal(output.ok, true);
  assert.equal(output.seeds.length, 1);
  assert.equal(output.seeds[0].retrieval.source, "semantic");
  assert.equal(typeof output.seeds[0].retrieval.timeliness.score, "number");
});
