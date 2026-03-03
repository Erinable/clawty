import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  HYBRID_QUERY_EVENT_TYPE,
  HYBRID_QUERY_METRICS_FILE,
  MEMORY_SEARCH_EVENT_TYPE,
  MEMORY_SEARCH_METRICS_FILE,
  METRICS_SUBDIR,
  WATCH_FLUSH_EVENT_TYPE,
  WATCH_FLUSH_METRICS_FILE,
  WATCH_RUN_EVENT_TYPE,
  WATCH_RUN_METRICS_FILE
} from "../src/metrics-event-types.js";

test("metrics schema constants remain stable across modules", () => {
  assert.equal(METRICS_SUBDIR, path.join(".clawty", "metrics"));
  assert.equal(HYBRID_QUERY_METRICS_FILE, "hybrid-query.jsonl");
  assert.equal(WATCH_FLUSH_METRICS_FILE, "watch-flush.jsonl");
  assert.equal(WATCH_RUN_METRICS_FILE, "watch-run.jsonl");
  assert.equal(MEMORY_SEARCH_METRICS_FILE, "memory.jsonl");

  assert.equal(HYBRID_QUERY_EVENT_TYPE, "hybrid_query");
  assert.equal(WATCH_FLUSH_EVENT_TYPE, "watch_flush");
  assert.equal(WATCH_RUN_EVENT_TYPE, "watch_run");
  assert.equal(MEMORY_SEARCH_EVENT_TYPE, "memory_search");
});
