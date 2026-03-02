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
      sources: { freshness: { stale_hit_rate: 0.1 } },
      degradation: { degraded: false }
    },
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 40,
      sources: { freshness: { stale_hit_rate: 0.3 } },
      degradation: { degraded: true }
    },
    {
      timestamp: nowIso,
      event_type: "hybrid_query",
      query_total_ms: 25,
      sources: { freshness: { stale_hit_rate: 0.2 } },
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
      index_lag_ms: 100
    },
    {
      timestamp: nowIso,
      event_type: "watch_flush",
      index_lag_ms: 300
    },
    {
      timestamp: nowIso,
      event_type: "watch_flush",
      index_lag_ms: 200
    }
  ];
  await fs.writeFile(
    path.join(metricsDir, "watch-flush.jsonl"),
    `${watchEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );

  const report = await runMetricsReport(workspaceRoot);
  assert.equal(report.kpi.query_hybrid_p95_ms, 40);
  assert.equal(report.kpi.code_index_lag_p95_ms, 300);
  assert.equal(report.kpi.stale_hit_rate_avg, 0.2);
  assert.equal(report.kpi.degrade_rate, 0.3333);
  assert.equal(report.sample_sizes.hybrid_events, 3);
  assert.equal(report.sample_sizes.watch_flush_events, 3);
});

test("metrics-report returns null kpi values when metric files are missing", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-metrics-empty-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const report = await runMetricsReport(workspaceRoot);
  assert.equal(report.kpi.query_hybrid_p95_ms, null);
  assert.equal(report.kpi.code_index_lag_p95_ms, null);
  assert.equal(report.kpi.stale_hit_rate_avg, null);
  assert.equal(report.kpi.degrade_rate, null);
  assert.equal(report.sample_sizes.hybrid_events, 0);
  assert.equal(report.sample_sizes.watch_flush_events, 0);
});

