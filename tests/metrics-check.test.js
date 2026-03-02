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

async function writeMetricFiles(workspaceRoot, { hybridEvents = [], watchEvents = [] }) {
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
        sources: { freshness: { stale_hit_rate: 0.01 } },
        degradation: { degraded: false }
      },
      {
        timestamp: nowIso,
        event_type: "hybrid_query",
        query_total_ms: 120,
        sources: { freshness: { stale_hit_rate: 0.03 } },
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
        sources: { freshness: { stale_hit_rate: 0.4 } },
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
