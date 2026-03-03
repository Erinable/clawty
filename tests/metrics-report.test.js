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
const metricsReportScript = path.join(repoRoot, "scripts/metrics-report.mjs");

async function runMetricsReport(workspaceRoot, extraArgs = []) {
  const args = [
    metricsReportScript,
    "--json",
    `--workspace=${workspaceRoot}`,
    "--window-hours=24",
    ...extraArgs
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

test("metrics-report aggregates hybrid and watch KPI from jsonl files", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-report-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const metricsDir = path.join(workspaceRoot, ".clawty/metrics");
  await fs.mkdir(metricsDir, { recursive: true });
  const nowIso = new Date().toISOString();

  const hybridEvents = [
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 12,
      sources: {
        freshness: { stale_hit_rate: 0.1 },
        embedding: { attempted: true, status_code: "EMBEDDING_OK" }
      },
      degradation: { degraded: false }
    },
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 40,
      sources: {
        freshness: { stale_hit_rate: 0.3 },
        embedding: { attempted: true, status_code: "EMBEDDING_ERROR_TIMEOUT" }
      },
      degradation: { degraded: true }
    },
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 25,
      sources: {
        freshness: { stale_hit_rate: 0.2 },
        embedding: { attempted: true, status_code: "EMBEDDING_ERROR_NETWORK" }
      },
      degradation: { degraded: false }
    }
  ];
  await fs.writeFile(
    path.join(metricsDir, "hybrid-query.jsonl"),
    `${hybridEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );

  const watchEvents = [
    {
      timestamp: nowIso,
      event_type: "watch_flush",
      index_lag_ms: 100,
      backpressure_active: false,
      effective_debounce_ms: 500
    },
    {
      timestamp: nowIso,
      event_type: "watch_flush",
      index_lag_ms: 300,
      backpressure_active: true,
      effective_debounce_ms: 120
    },
    {
      timestamp: nowIso,
      event_type: "watch_flush",
      index_lag_ms: 200,
      backpressure_active: true,
      effective_debounce_ms: 100
    }
  ];
  await fs.writeFile(
    path.join(metricsDir, "watch-flush.jsonl"),
    `${watchEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );

  const memoryEvents = [
    {
      timestamp: nowIso,
      event_type: "memory_search",
      query_total_ms: 30,
      returned_count: 1,
      fallback_used: false
    },
    {
      timestamp: nowIso,
      event_type: "memory_search",
      query_total_ms: 80,
      returned_count: 0,
      fallback_used: true
    },
    {
      timestamp: nowIso,
      event_type: "memory_search",
      query_total_ms: 55,
      returned_count: 2,
      fallback_used: false
    }
  ];
  await fs.writeFile(
    path.join(metricsDir, "memory.jsonl"),
    `${memoryEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );

  const report = await runMetricsReport(workspaceRoot);
  assert.equal(report.kpi.query_hybrid_p95_ms, 40);
  assert.equal(report.kpi.code_index_lag_p95_ms, 300);
  assert.equal(report.kpi.watch_backpressure_flush_rate, 0.6667);
  assert.equal(report.kpi.watch_effective_debounce_avg_ms, 240);
  assert.equal(report.kpi.watch_effective_debounce_p95_ms, 500);
  assert.equal(report.kpi.stale_hit_rate_avg, 0.2);
  assert.equal(report.kpi.degrade_rate, 0.3333);
  assert.equal(report.kpi.embedding_timeout_rate, 0.3333);
  assert.equal(report.kpi.embedding_network_rate, 0.3333);
  assert.equal(report.kpi.embedding_api_rate, 0);
  assert.equal(report.kpi.embedding_unknown_rate, 0);
  assert.equal(report.kpi.embedding_failure_rate, 0.6667);
  assert.equal(report.kpi.memory_query_p95_ms, 80);
  assert.equal(report.kpi.memory_hit_rate, 0.6667);
  assert.equal(report.kpi.memory_fallback_rate, 0.3333);
  assert.equal(report.sample_sizes.hybrid_events, 3);
  assert.equal(report.sample_sizes.watch_flush_events, 3);
  assert.equal(report.sample_sizes.memory_events, 3);
  assert.equal(report.sample_sizes.embedding_attempt_samples, 3);
  assert.equal(report.sample_sizes.embedding_failure_samples, 2);
  assert.equal(report.sample_sizes.embedding_timeout_samples, 1);
  assert.equal(report.sample_sizes.embedding_network_samples, 1);
  assert.equal(report.sample_sizes.embedding_api_samples, 0);
  assert.equal(report.sample_sizes.embedding_unknown_samples, 0);
  assert.equal(report.sample_sizes.embedding_unmapped_status_samples, 0);
  assert.equal(report.sample_sizes.backpressure_flush_samples, 2);
  assert.equal(report.sample_sizes.effective_debounce_samples, 3);
  assert.deepEqual(report.runbook.embedding_unmapped_status_codes, []);
});

test("metrics-report returns null kpi values when metric files are missing", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-empty-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const report = await runMetricsReport(workspaceRoot);
  assert.equal(report.kpi.query_hybrid_p95_ms, null);
  assert.equal(report.kpi.code_index_lag_p95_ms, null);
  assert.equal(report.kpi.watch_backpressure_flush_rate, null);
  assert.equal(report.kpi.watch_effective_debounce_avg_ms, null);
  assert.equal(report.kpi.watch_effective_debounce_p95_ms, null);
  assert.equal(report.kpi.stale_hit_rate_avg, null);
  assert.equal(report.kpi.degrade_rate, null);
  assert.equal(report.kpi.embedding_timeout_rate, null);
  assert.equal(report.kpi.embedding_network_rate, null);
  assert.equal(report.kpi.embedding_api_rate, null);
  assert.equal(report.kpi.embedding_unknown_rate, null);
  assert.equal(report.kpi.embedding_failure_rate, null);
  assert.equal(report.kpi.memory_query_p95_ms, null);
  assert.equal(report.kpi.memory_hit_rate, null);
  assert.equal(report.kpi.memory_fallback_rate, null);
  assert.equal(report.sample_sizes.hybrid_events, 0);
  assert.equal(report.sample_sizes.watch_flush_events, 0);
  assert.equal(report.sample_sizes.memory_events, 0);
  assert.equal(report.sample_sizes.embedding_attempt_samples, 0);
  assert.equal(report.sample_sizes.embedding_unmapped_status_samples, 0);
  assert.equal(report.sample_sizes.backpressure_flush_samples, 0);
  assert.equal(report.sample_sizes.effective_debounce_samples, 0);
  assert.deepEqual(report.runbook.embedding_unmapped_status_codes, []);
});

test("metrics-report records unmapped embedding status codes for runbook coverage", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-runbook-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const metricsDir = path.join(workspaceRoot, ".clawty/metrics");
  await fs.mkdir(metricsDir, { recursive: true });
  const nowIso = new Date().toISOString();

  const hybridEvents = [
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 18,
      sources: {
        freshness: { stale_hit_rate: 0.05 },
        embedding: { attempted: true, status_code: "EMBEDDING_ERROR_NEW_PROVIDER" }
      },
      degradation: { degraded: true }
    }
  ];
  await fs.writeFile(
    path.join(metricsDir, "hybrid-query.jsonl"),
    `${hybridEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );

  const report = await runMetricsReport(workspaceRoot);
  assert.equal(report.kpi.embedding_unknown_rate, 1);
  assert.equal(report.sample_sizes.embedding_attempt_samples, 1);
  assert.equal(report.sample_sizes.embedding_unmapped_status_samples, 1);
  assert.deepEqual(report.runbook.embedding_unmapped_status_codes, [
    "EMBEDDING_ERROR_NEW_PROVIDER"
  ]);
});
