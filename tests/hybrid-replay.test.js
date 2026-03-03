import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateHybridReplayByBucket,
  aggregateHybridReplayMetrics,
  extractHybridReplayFailures,
  findUnexpectedHybridReplayFailures,
  mergeHybridReplayArgs,
  scoreHybridReplayPreset,
  sortHybridReplaySummaries,
  summarizeHybridReplayTask
} from "../src/hybrid-replay.js";

test("mergeHybridReplayArgs applies override values", () => {
  const merged = mergeHybridReplayArgs(
    { query: "token", top_k: 5, enable_embedding: false },
    { top_k: 3, enable_embedding: true }
  );
  assert.deepEqual(merged, {
    query: "token",
    top_k: 3,
    enable_embedding: true
  });
});

test("summarizeHybridReplayTask derives top ranks and match flags", () => {
  const row = summarizeHybridReplayTask(
    {
      name: "case_a",
      bucket: "intent:search",
      language: "typescript",
      file_type: "test",
      intent: "rerank",
      query_pattern: "symbol_exact",
      args: { query: "token" },
      expected_primary_path: "src/a.ts",
      expected_embedding_status: "EMBEDDING_OK",
      expected_degraded: false
    },
    {
      ok: true,
      seeds: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      sources: { embedding: { status_code: "EMBEDDING_OK", attempted: true } },
      degradation: { degraded: false }
    },
    12.3456
  );

  assert.equal(row.name, "case_a");
  assert.equal(row.bucket, "intent:search");
  assert.equal(row.language, "typescript");
  assert.equal(row.file_type, "test");
  assert.equal(row.intent, "rerank");
  assert.equal(row.query_pattern, "symbol_exact");
  assert.equal(row.primary_rank, 1);
  assert.equal(row.top1, true);
  assert.equal(row.top3, true);
  assert.equal(row.embedding_status_match, true);
  assert.equal(row.degraded_match, true);
  assert.equal(row.success, true);
  assert.equal(row.query_ms, 12.3456);
});

test("aggregateHybridReplayMetrics computes quality and latency stats", () => {
  const metrics = aggregateHybridReplayMetrics([
    {
      success: true,
      top1: true,
      top3: true,
      embedding_status_match: true,
      degraded_match: true,
      embedding_attempted: true,
      actual_degraded: false,
      query_ok: true,
      primary_rank: 1,
      query_ms: 10
    },
    {
      success: false,
      top1: false,
      top3: true,
      embedding_status_match: false,
      degraded_match: true,
      embedding_attempted: false,
      actual_degraded: true,
      query_ok: false,
      primary_rank: 3,
      query_ms: 30
    }
  ]);

  assert.equal(metrics.task_count, 2);
  assert.equal(metrics.task_success_rate, 0.5);
  assert.equal(metrics.primary_top1_rate, 0.5);
  assert.equal(metrics.primary_top3_rate, 1);
  assert.equal(metrics.query_error_rate, 0.5);
  assert.equal(metrics.query_avg_ms, 20);
  assert.equal(metrics.query_p95_ms, 30);
  assert.equal(metrics.mean_reciprocal_rank, 0.666667);
});

test("aggregateHybridReplayByBucket groups metrics per bucket", () => {
  const grouped = aggregateHybridReplayByBucket([
    {
      bucket: "language:ts",
      language: "typescript",
      file_type: "source",
      intent: "baseline",
      query_pattern: "identifier_exact",
      success: true,
      top1: true,
      top3: true,
      embedding_status_match: true,
      degraded_match: true,
      embedding_attempted: false,
      actual_degraded: false,
      query_ok: true,
      primary_rank: 1,
      query_ms: 5
    },
    {
      bucket: "language:py",
      language: "python",
      file_type: "test",
      intent: "degrade_timeout",
      query_patterns: ["timeout_embedding"],
      success: false,
      top1: false,
      top3: false,
      embedding_status_match: true,
      degraded_match: true,
      embedding_attempted: false,
      actual_degraded: false,
      query_ok: true,
      primary_rank: null,
      query_ms: 7
    }
  ]);

  assert.equal(grouped.bucket["language:ts"].task_count, 1);
  assert.equal(grouped.bucket["language:ts"].primary_top1_rate, 1);
  assert.equal(grouped.bucket["language:py"].task_count, 1);
  assert.equal(grouped.bucket["language:py"].primary_top1_rate, 0);
  assert.equal(grouped.language.typescript.task_count, 1);
  assert.equal(grouped.language.python.task_count, 1);
  assert.equal(grouped.file_type.source.task_count, 1);
  assert.equal(grouped.file_type.test.task_count, 1);
  assert.equal(grouped.intent.baseline.task_count, 1);
  assert.equal(grouped.intent.degrade_timeout.task_count, 1);
  assert.equal(grouped.query_pattern.identifier_exact.task_count, 1);
  assert.equal(grouped.query_pattern.timeout_embedding.task_count, 1);
});

test("sortHybridReplaySummaries ranks by score then quality ties", () => {
  const sorted = sortHybridReplaySummaries([
    {
      name: "preset_b",
      score: 0.7,
      metrics: { primary_top1_rate: 0.6, mean_reciprocal_rank: 0.6 }
    },
    {
      name: "preset_a",
      score: 0.7,
      metrics: { primary_top1_rate: 0.7, mean_reciprocal_rank: 0.5 }
    },
    {
      name: "preset_c",
      score: 0.9,
      metrics: { primary_top1_rate: 0.8, mean_reciprocal_rank: 0.8 }
    }
  ]);

  assert.deepEqual(sorted.map((item) => item.name), ["preset_c", "preset_a", "preset_b"]);
  assert.ok(scoreHybridReplayPreset(sorted[0].metrics) > 0);
});

test("extractHybridReplayFailures returns failed rows with reason tags", () => {
  const failures = extractHybridReplayFailures([
    {
      name: "ok_case",
      success: true,
      query_ok: true,
      top1: true,
      embedding_status_match: true,
      degraded_match: true
    },
    {
      name: "failed_case",
      bucket: "intent:embedding_rerank",
      language: "typescript",
      file_type: "test",
      intent: "rerank",
      query_pattern: "cross_file_semantic",
      query: "hybridEmbedToken",
      success: false,
      query_ok: true,
      top1: false,
      primary_rank: 2,
      embedding_status_match: false,
      degraded_match: true,
      expected_embedding_status: "EMBEDDING_OK",
      actual_embedding_status: "EMBEDDING_NOT_ATTEMPTED_NO_API_KEY",
      expected_degraded: false,
      actual_degraded: false
    }
  ]);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "failed_case");
  assert.equal(failures[0].primary_rank, 2);
  assert.deepEqual(failures[0].failure_reasons, [
    "primary_not_top1",
    "embedding_status_mismatch"
  ]);
});

test("findUnexpectedHybridReplayFailures detects newly introduced failures", () => {
  const unexpected = findUnexpectedHybridReplayFailures(
    [
      {
        name: "baseline_fixture",
        failure_samples: [{ name: "known_case", primary_path: "src/known.ts" }]
      },
      {
        name: "embedding_light",
        failure_samples: [
          { name: "known_case", primary_path: "src/known.ts" },
          {
            name: "new_case",
            primary_path: "src/new.ts",
            failure_reasons: ["embedding_status_mismatch"]
          }
        ]
      }
    ],
    {
      presets: [
        {
          name: "embedding_light",
          failure_samples: [{ name: "known_case", primary_path: "src/known.ts" }]
        }
      ]
    }
  );

  assert.deepEqual(unexpected, [
    {
      preset: "baseline_fixture",
      name: "known_case",
      primary_path: "src/known.ts",
      failure_reasons: []
    },
    {
      preset: "embedding_light",
      name: "new_case",
      primary_path: "src/new.ts",
      failure_reasons: ["embedding_status_mismatch"]
    }
  ]);
});
