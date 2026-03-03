import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const metricsCheckScript = path.join(repoRoot, "scripts/metrics-check.mjs");

async function runMetricsCheck(workspaceRoot, extraArgs = []) {
  const args = [
    metricsCheckScript,
    "--json",
    `--workspace=${workspaceRoot}`,
    "--window-hours=24",
    ...extraArgs
  ];
  return execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

async function writeMetricFiles(workspaceRoot, { hybridEvents = [], watchEvents = [], memoryEvents = [] }) {
  const metricsDir = path.join(workspaceRoot, ".clawty/metrics");
  await fs.mkdir(metricsDir, { recursive: true });
  await fs.writeFile(
    path.join(metricsDir, "hybrid-query.jsonl"),
    hybridEvents.map((item) => JSON.stringify(item)).join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(metricsDir, "watch-flush.jsonl"),
    watchEvents.map((item) => JSON.stringify(item)).join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(metricsDir, "memory.jsonl"),
    memoryEvents.map((item) => JSON.stringify(item)).join("\n"),
    "utf8"
  );
}

test("metrics-check passes when KPI values are under thresholds", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-pass-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 100,
        sources: {
          freshness: { stale_hit_rate: 0.01 },
          embedding: { attempted: true, status_code: "EMBEDDING_OK" }
        },
        degradation: { degraded: false }
      },
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 120,
        sources: {
          freshness: { stale_hit_rate: 0.03 },
          embedding: { attempted: true, status_code: "EMBEDDING_OK" }
        },
        degradation: { degraded: false }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 300
      },
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 500
      }
    ]
  });

  const { stdout } = await runMetricsCheck(workspaceRoot);
  const payload = JSON.parse(stdout);
  assert.equal(payload.evaluation.pass, true);
  assert.equal(payload.evaluation.failures.length, 0);
});

test("metrics-check fails when KPI exceeds threshold", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-fail-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 300,
        sources: {
          freshness: { stale_hit_rate: 0.4 },
          embedding: { attempted: true, status_code: "EMBEDDING_ERROR_TIMEOUT" }
        },
        degradation: { degraded: true }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 500
      }
    ]
  });

  await assert.rejects(
    () => runMetricsCheck(workspaceRoot, ["--max-stale-hit-rate=0.1"]),
    (error) => {
      const stdout = String(error?.stdout || "");
      const payload = JSON.parse(stdout);
      assert.equal(payload.evaluation.pass, false);
      assert.match(
        payload.evaluation.failures.join("\n"),
        /stale_hit_rate_avg=0\.4 exceeds max=0\.1/
      );
      return true;
    }
  );
});

test("metrics-check supports --allow-missing for empty metrics", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-empty-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const { stdout } = await runMetricsCheck(workspaceRoot, ["--allow-missing"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.evaluation.pass, true);
  assert.equal(payload.evaluation.sample_sizes.hybrid_events, 0);
  assert.equal(payload.evaluation.sample_sizes.watch_flush_events, 0);
});

test("metrics-check supports memory KPI thresholds", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-memory-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 120,
        sources: {
          freshness: { stale_hit_rate: 0.03 },
          embedding: { attempted: true, status_code: "EMBEDDING_OK" }
        },
        degradation: { degraded: false }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 400
      }
    ],
    memoryEvents: [
      {
        timestamp: nowIso,
        event_type: "memory_search",
        query_total_ms: 60,
        returned_count: 1,
        fallback_used: false
      },
      {
        timestamp: nowIso,
        event_type: "memory_search",
        query_total_ms: 80,
        returned_count: 0,
        fallback_used: true
      }
    ]
  });

  const { stdout } = await runMetricsCheck(workspaceRoot, [
    "--max-memory-query-p95-ms=100",
    "--min-memory-hit-rate=0.4",
    "--max-memory-fallback-rate=0.6",
    "--min-memory-events=2"
  ]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.evaluation.pass, true);
  assert.equal(payload.evaluation.sample_sizes.memory_events, 2);

  await assert.rejects(
    () =>
      runMetricsCheck(workspaceRoot, [
        "--max-memory-query-p95-ms=100",
        "--min-memory-hit-rate=0.8",
        "--max-memory-fallback-rate=0.6",
        "--min-memory-events=2"
      ]),
    (error) => {
      const stdoutText = String(error?.stdout || "");
      const failedPayload = JSON.parse(stdoutText);
      assert.equal(failedPayload.evaluation.pass, false);
      assert.match(failedPayload.evaluation.failures.join("\n"), /memory_hit_rate=0\.5 below min=0\.8/);
      return true;
    }
  );
});

test("metrics-check supports embedding thresholds and embedding attempt sample gate", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-embedding-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 100,
        sources: {
          freshness: { stale_hit_rate: 0.01 },
          embedding: { attempted: true, status_code: "EMBEDDING_OK" }
        },
        degradation: { degraded: false }
      },
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 140,
        sources: {
          freshness: { stale_hit_rate: 0.03 },
          embedding: { attempted: true, status_code: "EMBEDDING_ERROR_TIMEOUT" }
        },
        degradation: { degraded: true }
      },
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 150,
        sources: {
          freshness: { stale_hit_rate: 0.02 },
          embedding: { attempted: true, status_code: "EMBEDDING_ERROR_NETWORK" }
        },
        degradation: { degraded: true }
      },
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 90,
        sources: {
          freshness: { stale_hit_rate: 0.01 },
          embedding: { attempted: true, status_code: "EMBEDDING_ERROR_API" }
        },
        degradation: { degraded: true }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 500
      }
    ]
  });

  const { stdout } = await runMetricsCheck(workspaceRoot, [
    "--max-degrade-rate=1",
    "--max-embedding-timeout-rate=0.3",
    "--max-embedding-network-rate=0.3",
    "--min-embedding-attempts=4"
  ]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.evaluation.pass, true);
  assert.equal(payload.evaluation.sample_sizes.embedding_attempt_samples, 4);

  await assert.rejects(
    () =>
      runMetricsCheck(workspaceRoot, [
        "--max-degrade-rate=1",
        "--max-embedding-timeout-rate=0.2",
        "--max-embedding-network-rate=0.3",
        "--min-embedding-attempts=4"
      ]),
    (error) => {
      const stdoutText = String(error?.stdout || "");
      const failedPayload = JSON.parse(stdoutText);
      assert.equal(failedPayload.evaluation.pass, false);
      assert.match(
        failedPayload.evaluation.failures.join("\n"),
        /embedding_timeout_rate=0\.25 exceeds max=0\.2/
      );
      return true;
    }
  );
});

test("metrics-check supports watch backpressure thresholds", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-watch-backpressure-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 100,
        sources: {
          freshness: { stale_hit_rate: 0.01 },
          embedding: { attempted: true, status_code: "EMBEDDING_OK" }
        },
        degradation: { degraded: false }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 200,
        backpressure_active: false,
        effective_debounce_ms: 500
      },
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 300,
        backpressure_active: true,
        effective_debounce_ms: 120
      }
    ]
  });

  const { stdout } = await runMetricsCheck(workspaceRoot, [
    "--max-watch-backpressure-flush-rate=0.6",
    "--max-watch-effective-debounce-p95-ms=600"
  ]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.evaluation.pass, true);

  await assert.rejects(
    () => runMetricsCheck(workspaceRoot, ["--max-watch-backpressure-flush-rate=0.4"]),
    (error) => {
      const stdoutText = String(error?.stdout || "");
      const failedPayload = JSON.parse(stdoutText);
      assert.equal(failedPayload.evaluation.pass, false);
      assert.match(
        failedPayload.evaluation.failures.join("\n"),
        /watch_backpressure_flush_rate=0\.5 exceeds max=0\.4/
      );
      return true;
    }
  );

  await assert.rejects(
    () => runMetricsCheck(workspaceRoot, ["--max-watch-effective-debounce-p95-ms=300"]),
    (error) => {
      const stdoutText = String(error?.stdout || "");
      const failedPayload = JSON.parse(stdoutText);
      assert.equal(failedPayload.evaluation.pass, false);
      assert.match(
        failedPayload.evaluation.failures.join("\n"),
        /watch_effective_debounce_p95_ms=500 exceeds max=300/
      );
      return true;
    }
  );
});

test("metrics-check fails with --runbook-enforce when embedding status is unmapped", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-check-runbook-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const nowIso = new Date().toISOString();
  await writeMetricFiles(workspaceRoot, {
    hybridEvents: [
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 88,
        sources: {
          freshness: { stale_hit_rate: 0.02 },
          embedding: { attempted: true, status_code: "EMBEDDING_ERROR_VENDOR_X" }
        },
        degradation: { degraded: true }
      }
    ],
    watchEvents: [
      {
        timestamp: nowIso,
        event_type: "watch_flush",
        index_lag_ms: 600
      }
    ]
  });

  await assert.rejects(
    () => runMetricsCheck(workspaceRoot, ["--runbook-enforce"]),
    (error) => {
      const stdoutText = String(error?.stdout || "");
      const failedPayload = JSON.parse(stdoutText);
      assert.equal(failedPayload.evaluation.pass, false);
      assert.match(
        failedPayload.evaluation.failures.join("\n"),
        /runbook enforcement failed: unmapped embedding status codes detected/
      );
      assert.deepEqual(
        failedPayload.evaluation.runbook.embedding_unmapped_status_codes,
        ["EMBEDDING_ERROR_VENDOR_X"]
      );
      return true;
    }
  );
});
