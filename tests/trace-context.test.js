import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequestTraceContext,
  createTraceContext,
  createTurnTraceContext,
  pickTraceFields
} from "../src/trace-context.js";

test("createTraceContext normalizes provided trace id", () => {
  const trace = createTraceContext({
    trace_id: "  trace-123  "
  });
  assert.equal(trace.trace_id, "trace-123");
});

test("createTurnTraceContext preserves trace and assigns turn id", () => {
  const trace = createTurnTraceContext({
    trace_id: "trace-456"
  });
  assert.equal(trace.trace_id, "trace-456");
  assert.equal(typeof trace.turn_id, "string");
  assert.ok(trace.turn_id.length > 0);
});

test("createRequestTraceContext and pickTraceFields include normalized ids", () => {
  const trace = createRequestTraceContext({
    trace_id: "trace-789",
    turn_id: "turn-1",
    request_id: "req-1"
  });
  assert.deepEqual(trace, {
    trace_id: "trace-789",
    turn_id: "turn-1",
    request_id: "req-1"
  });

  assert.deepEqual(pickTraceFields(trace), trace);
  assert.deepEqual(pickTraceFields(trace, { includeRequest: false }), {
    trace_id: "trace-789",
    turn_id: "turn-1"
  });
  assert.deepEqual(pickTraceFields(trace, { includeTurn: false, includeRequest: false }), {
    trace_id: "trace-789"
  });
});
