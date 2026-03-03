import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHybridMetricEvent,
  buildHybridQueryResponse
} from "../src/hybrid-query-output.js";

function createBaseArgs() {
  return {
    query: "trace token",
    queryTotalMs: 12.5,
    topK: 3,
    scannedCandidates: [],
    dedupedCandidates: new Map(),
    seeds: [],
    effectiveArgs: {},
    semanticResult: { ok: true, seeds: [] },
    syntaxResult: { ok: true, seeds: [] },
    indexResult: { ok: true, results: [] },
    vectorResult: { ok: false, results: [], skipped: true },
    vectorEnabled: false,
    embeddingSource: { enabled: false, attempted: false, ok: false },
    freshnessSource: { enabled: false, attempted: false, ok: false },
    degradation: {
      attempted_sources: [],
      failed_sources: [],
      degraded: false,
      degrade_rate_sample: 0
    },
    tunerDecision: { enabled: false },
    tunerOutcome: { recorded: false },
    queryPreviewChars: 64,
    metricsWrite: {
      logged: true,
      reason: null,
      error: null
    },
    priorityPolicy: [],
    languageDistribution: {
      scanned_candidates: {},
      deduped_candidates: {},
      returned_seeds: {}
    }
  };
}

test("buildHybridMetricEvent includes trace fields", () => {
  const event = buildHybridMetricEvent({
    ...createBaseArgs(),
    trace: {
      trace_id: "trace-1",
      turn_id: "turn-1",
      request_id: "req-1"
    }
  });

  assert.equal(event.trace_id, "trace-1");
  assert.equal(event.turn_id, "turn-1");
  assert.equal(event.request_id, "req-1");
});

test("buildHybridQueryResponse includes trace fields in observability", () => {
  const response = buildHybridQueryResponse({
    ...createBaseArgs(),
    trace: {
      trace_id: "trace-2",
      turn_id: "turn-2",
      request_id: "req-2"
    }
  });

  assert.equal(response.observability.trace.trace_id, "trace-2");
  assert.equal(response.observability.trace.turn_id, "turn-2");
  assert.equal(response.observability.trace.request_id, "req-2");
});
