import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRetrievalResultProtocol,
  classifyRetrievalConfidenceLevel
} from "../src/retrieval-result-protocol.js";

test("classifyRetrievalConfidenceLevel uses low/medium/high thresholds", () => {
  assert.equal(classifyRetrievalConfidenceLevel(0.2), "low");
  assert.equal(classifyRetrievalConfidenceLevel(0.5), "medium");
  assert.equal(classifyRetrievalConfidenceLevel(0.8), "high");
  assert.equal(classifyRetrievalConfidenceLevel(Number.NaN), "low");
});

test("buildRetrievalResultProtocol emits source/confidence/timeliness/dedup contract", () => {
  const candidate = {
    source: "Semantic",
    hybrid_score: 0.81234,
    freshness_score: 0.55,
    freshness_age_ms: 1234.9,
    freshness_stale: true,
    supporting_providers: ["vector", "semantic", "vector"]
  };
  const result = buildRetrievalResultProtocol(candidate, {
    dedupKey: "path:src/demo.ts"
  });

  assert.equal(result.source, "semantic");
  assert.equal(result.confidence.score, 0.8123);
  assert.equal(result.confidence.level, "high");
  assert.deepEqual(result.timeliness, {
    score: 0.55,
    age_ms: 1234,
    stale: true
  });
  assert.deepEqual(result.freshness, result.timeliness);
  assert.equal(result.dedup_key, "path:src/demo.ts");
  assert.deepEqual(result.supporting_sources, ["semantic", "vector"]);
});
