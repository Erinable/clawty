import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const tunerReportScript = path.join(repoRoot, "scripts", "tuner-report.mjs");

async function runTunerReport(workspaceRoot, extraArgs = []) {
  const args = [
    tunerReportScript,
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

function seedTunerDb(workspaceRoot, rows = {}) {
  const tunerDbPath = path.join(workspaceRoot, ".clawty", "tuner.db");
  const db = new DatabaseSync(tunerDbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tuner_decisions (
        decision_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        arm_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        explicit_override INTEGER NOT NULL DEFAULT 0,
        params_applied_json TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tuner_outcomes (
        decision_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        arm_id TEXT NOT NULL,
        reward REAL NOT NULL,
        success INTEGER NOT NULL,
        quality_proxy REAL NOT NULL,
        query_total_ms REAL NOT NULL,
        degraded INTEGER NOT NULL,
        timeout INTEGER NOT NULL,
        network INTEGER NOT NULL,
        embedding_status_code TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const nowIso = new Date().toISOString();
    const decisions = Array.isArray(rows.decisions) ? rows.decisions : [];
    const outcomes = Array.isArray(rows.outcomes) ? rows.outcomes : [];

    const insertDecision = db.prepare(`
      INSERT INTO tuner_decisions(
        decision_id, workspace_id, arm_id, mode, explicit_override, params_applied_json, context_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOutcome = db.prepare(`
      INSERT INTO tuner_outcomes(
        decision_id, workspace_id, arm_id, reward, success, quality_proxy, query_total_ms, degraded, timeout, network, embedding_status_code, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of decisions) {
      insertDecision.run(
        item.decision_id,
        item.workspace_id || workspaceRoot,
        item.arm_id || "safe_default",
        item.mode || "shadow",
        Number(item.explicit_override || 0),
        JSON.stringify(item.params_applied_json || {}),
        JSON.stringify(item.context_json || {}),
        item.created_at || nowIso
      );
    }
    for (const item of outcomes) {
      insertOutcome.run(
        item.decision_id,
        item.workspace_id || workspaceRoot,
        item.arm_id || "safe_default",
        Number(item.reward || 0),
        Number(item.success || 0),
        Number(item.quality_proxy || 0),
        Number(item.query_total_ms || 0),
        Number(item.degraded || 0),
        Number(item.timeout || 0),
        Number(item.network || 0),
        item.embedding_status_code || null,
        item.created_at || nowIso
      );
    }
  } finally {
    db.close();
  }
}

test("tuner-report summarizes outcome distribution and arm stats", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-tuner-report-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });
  await fs.mkdir(path.join(workspaceRoot, ".clawty"), { recursive: true });

  seedTunerDb(workspaceRoot, {
    decisions: [
      { decision_id: "d1", arm_id: "safe_default", mode: "shadow" },
      { decision_id: "d2", arm_id: "embed_fast", mode: "shadow" },
      { decision_id: "d3", arm_id: "embed_fast", mode: "active" }
    ],
    outcomes: [
      {
        decision_id: "d1",
        arm_id: "safe_default",
        reward: 0.2,
        success: 0,
        quality_proxy: 0.5,
        query_total_ms: 100,
        degraded: 0,
        timeout: 0,
        network: 0,
        embedding_status_code: "EMBEDDING_DISABLED"
      },
      {
        decision_id: "d2",
        arm_id: "embed_fast",
        reward: 0.7,
        success: 1,
        quality_proxy: 0.8,
        query_total_ms: 120,
        degraded: 0,
        timeout: 0,
        network: 0,
        embedding_status_code: "EMBEDDING_OK"
      },
      {
        decision_id: "d3",
        arm_id: "embed_fast",
        reward: -0.4,
        success: 0,
        quality_proxy: 0.2,
        query_total_ms: 300,
        degraded: 1,
        timeout: 1,
        network: 0,
        embedding_status_code: "EMBEDDING_ERROR_TIMEOUT"
      }
    ]
  });

  const report = await runTunerReport(workspaceRoot);
  assert.equal(report.summary.decision_count, 3);
  assert.equal(report.summary.outcome_count, 3);
  assert.equal(report.summary.outcome_coverage_rate, 1);
  assert.equal(report.summary.success_rate, 0.3333);
  assert.equal(report.summary.degrade_rate, 0.3333);
  assert.equal(report.summary.timeout_rate, 0.3333);
  assert.ok(Array.isArray(report.by_arm));
  assert.equal(report.by_arm[0].arm_id, "embed_fast");
  assert.equal(report.by_arm[0].outcomes, 2);
  assert.ok(Array.isArray(report.reward_distribution.histogram));
  assert.ok(report.reward_distribution.histogram.some((item) => item.count > 0));
});

test("tuner-report handles missing tuner.db", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-tuner-report-empty-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });
  const report = await runTunerReport(workspaceRoot);
  assert.equal(report.inputs.tuner_db.exists, false);
  assert.equal(report.summary.decision_count, 0);
  assert.equal(report.summary.outcome_count, 0);
  assert.equal(report.summary.reward_avg, null);
  assert.deepEqual(report.by_arm, []);
});
