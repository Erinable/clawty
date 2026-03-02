import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_TUNER_DB_RELATIVE = path.join(".clawty", "tuner.db");

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    windowHours: DEFAULT_WINDOW_HOURS,
    format: "text"
  };

  for (const arg of argv) {
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      options.format = "text";
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim();
      if (!value) {
        throw new Error("Invalid --workspace argument");
      }
      options.workspaceRoot = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--window-hours=")) {
      const value = Number(arg.slice("--window-hours=".length));
      if (!Number.isFinite(value) || value <= 0 || value > 24 * 30) {
        throw new Error("Invalid --window-hours argument");
      }
      options.windowHours = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function roundMetric(value, digits = 4) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildRewardHistogram(rewards) {
  const bins = [
    { label: "[-1.0,-0.5)", min: -1, max: -0.5, count: 0 },
    { label: "[-0.5,0.0)", min: -0.5, max: 0, count: 0 },
    { label: "[0.0,0.25)", min: 0, max: 0.25, count: 0 },
    { label: "[0.25,0.5)", min: 0.25, max: 0.5, count: 0 },
    { label: "[0.5,0.75)", min: 0.5, max: 0.75, count: 0 },
    { label: "[0.75,1.0]", min: 0.75, max: 1.00001, count: 0 }
  ];

  for (const raw of rewards) {
    const reward = clamp(Number(raw || 0), -1, 1);
    const target = bins.find((bin) => reward >= bin.min && reward < bin.max);
    if (target) {
      target.count += 1;
    }
  }

  return bins.map((bin) => ({
    label: bin.label,
    count: bin.count
  }));
}

async function fileExists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

function openDbReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, {
    open: true,
    readOnly: true
  });
  db.exec("PRAGMA query_only = ON;");
  return db;
}

function readRowsInWindow(db, tableName, windowStartIso) {
  return db
    .prepare(
      `
      SELECT *
      FROM ${tableName}
      WHERE created_at >= ?
      ORDER BY created_at ASC
    `
    )
    .all(windowStartIso);
}

function summarizeOutcomes(outcomeRows) {
  const rewards = outcomeRows
    .map((row) => Number(row?.reward))
    .filter((value) => Number.isFinite(value));

  const successCount = outcomeRows.filter((row) => Number(row?.success || 0) === 1).length;
  const degradeCount = outcomeRows.filter((row) => Number(row?.degraded || 0) === 1).length;
  const timeoutCount = outcomeRows.filter((row) => Number(row?.timeout || 0) === 1).length;
  const networkCount = outcomeRows.filter((row) => Number(row?.network || 0) === 1).length;

  return {
    reward_avg:
      rewards.length > 0
        ? roundMetric(rewards.reduce((sum, value) => sum + value, 0) / rewards.length)
        : null,
    reward_p50: rewards.length > 0 ? roundMetric(percentile(rewards, 50)) : null,
    reward_p95: rewards.length > 0 ? roundMetric(percentile(rewards, 95)) : null,
    reward_min: rewards.length > 0 ? roundMetric(Math.min(...rewards)) : null,
    reward_max: rewards.length > 0 ? roundMetric(Math.max(...rewards)) : null,
    success_rate:
      outcomeRows.length > 0 ? roundMetric(successCount / outcomeRows.length) : null,
    degrade_rate:
      outcomeRows.length > 0 ? roundMetric(degradeCount / outcomeRows.length) : null,
    timeout_rate:
      outcomeRows.length > 0 ? roundMetric(timeoutCount / outcomeRows.length) : null,
    network_rate:
      outcomeRows.length > 0 ? roundMetric(networkCount / outcomeRows.length) : null,
    histogram: buildRewardHistogram(rewards)
  };
}

function summarizeByArm(outcomeRows) {
  const grouped = new Map();
  for (const row of outcomeRows) {
    const armId = typeof row?.arm_id === "string" && row.arm_id ? row.arm_id : "unknown";
    if (!grouped.has(armId)) {
      grouped.set(armId, []);
    }
    grouped.get(armId).push(row);
  }

  return Array.from(grouped.entries())
    .map(([armId, rows]) => {
      const summary = summarizeOutcomes(rows);
      return {
        arm_id: armId,
        outcomes: rows.length,
        reward_avg: summary.reward_avg,
        reward_p50: summary.reward_p50,
        reward_p95: summary.reward_p95,
        success_rate: summary.success_rate,
        degrade_rate: summary.degrade_rate,
        timeout_rate: summary.timeout_rate,
        network_rate: summary.network_rate
      };
    })
    .sort((a, b) => b.outcomes - a.outcomes || String(a.arm_id).localeCompare(String(b.arm_id)));
}

function summarizeModeCounts(decisionRows) {
  const counts = {};
  for (const row of decisionRows) {
    const mode = typeof row?.mode === "string" && row.mode ? row.mode : "unknown";
    counts[mode] = Number(counts[mode] || 0) + 1;
  }
  return counts;
}

function summarizeTopStatusCodes(outcomeRows, topN = 10) {
  const counts = new Map();
  for (const row of outcomeRows) {
    const code =
      typeof row?.embedding_status_code === "string" && row.embedding_status_code
        ? row.embedding_status_code
        : "UNKNOWN";
    counts.set(code, Number(counts.get(code) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([status_code, count]) => ({ status_code, count }));
}

async function buildTunerReport(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const tunerDbPath = path.join(workspaceRoot, DEFAULT_TUNER_DB_RELATIVE);
  const nowMs = Date.now();
  const windowStartMs = nowMs - options.windowHours * 60 * 60 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();

  const exists = await fileExists(tunerDbPath);
  if (!exists) {
    return {
      generated_at: new Date(nowMs).toISOString(),
      workspace_root: workspaceRoot,
      window_hours: options.windowHours,
      window_start: windowStartIso,
      inputs: {
        tuner_db: {
          path: path.relative(workspaceRoot, tunerDbPath),
          exists: false
        }
      },
      summary: {
        decision_count: 0,
        outcome_count: 0,
        outcome_coverage_rate: null,
        reward_avg: null,
        reward_p50: null,
        reward_p95: null,
        success_rate: null,
        degrade_rate: null,
        timeout_rate: null,
        network_rate: null
      },
      reward_distribution: {
        histogram: buildRewardHistogram([]),
        top_status_codes: []
      },
      by_arm: [],
      mode_counts: {}
    };
  }

  const db = openDbReadOnly(tunerDbPath);
  try {
    const decisionRows = readRowsInWindow(db, "tuner_decisions", windowStartIso);
    const outcomeRows = readRowsInWindow(db, "tuner_outcomes", windowStartIso);

    const summary = summarizeOutcomes(outcomeRows);
    const byArm = summarizeByArm(outcomeRows);
    const modeCounts = summarizeModeCounts(decisionRows);
    const topStatusCodes = summarizeTopStatusCodes(outcomeRows);

    return {
      generated_at: new Date(nowMs).toISOString(),
      workspace_root: workspaceRoot,
      window_hours: options.windowHours,
      window_start: windowStartIso,
      inputs: {
        tuner_db: {
          path: path.relative(workspaceRoot, tunerDbPath),
          exists: true
        }
      },
      summary: {
        decision_count: decisionRows.length,
        outcome_count: outcomeRows.length,
        outcome_coverage_rate:
          decisionRows.length > 0 ? roundMetric(outcomeRows.length / decisionRows.length) : null,
        reward_avg: summary.reward_avg,
        reward_p50: summary.reward_p50,
        reward_p95: summary.reward_p95,
        reward_min: summary.reward_min,
        reward_max: summary.reward_max,
        success_rate: summary.success_rate,
        degrade_rate: summary.degrade_rate,
        timeout_rate: summary.timeout_rate,
        network_rate: summary.network_rate
      },
      reward_distribution: {
        histogram: summary.histogram,
        top_status_codes: topStatusCodes
      },
      by_arm: byArm,
      mode_counts: modeCounts
    };
  } finally {
    db.close();
  }
}

function printTextReport(report) {
  console.log("Tuner Report");
  console.log(`- workspace: ${report.workspace_root}`);
  console.log(`- window: last ${report.window_hours}h`);
  console.log(`- generated_at: ${report.generated_at}`);
  console.log(
    `- tuner_db: ${
      report.inputs?.tuner_db?.exists
        ? report.inputs?.tuner_db?.path || "present"
        : "missing"
    }`
  );
  console.log("");
  console.log("Summary");
  console.log(`- decision_count: ${report.summary.decision_count}`);
  console.log(`- outcome_count: ${report.summary.outcome_count}`);
  console.log(`- outcome_coverage_rate: ${report.summary.outcome_coverage_rate ?? "n/a"}`);
  console.log(`- reward_avg: ${report.summary.reward_avg ?? "n/a"}`);
  console.log(`- reward_p50: ${report.summary.reward_p50 ?? "n/a"}`);
  console.log(`- reward_p95: ${report.summary.reward_p95 ?? "n/a"}`);
  console.log(`- success_rate: ${report.summary.success_rate ?? "n/a"}`);
  console.log(`- degrade_rate: ${report.summary.degrade_rate ?? "n/a"}`);
  console.log(`- timeout_rate: ${report.summary.timeout_rate ?? "n/a"}`);
  console.log(`- network_rate: ${report.summary.network_rate ?? "n/a"}`);
  console.log("");
  console.log("Mode Counts");
  for (const [mode, count] of Object.entries(report.mode_counts || {})) {
    console.log(`- ${mode}: ${count}`);
  }
  if (Object.keys(report.mode_counts || {}).length === 0) {
    console.log("- n/a");
  }
  console.log("");
  console.log("Reward Histogram");
  for (const bin of report.reward_distribution?.histogram || []) {
    console.log(`- ${bin.label}: ${bin.count}`);
  }
  console.log("");
  console.log("Top Arms");
  const topArms = Array.isArray(report.by_arm) ? report.by_arm.slice(0, 10) : [];
  for (const item of topArms) {
    console.log(
      `- ${item.arm_id}: outcomes=${item.outcomes}, reward_avg=${item.reward_avg ?? "n/a"}, success_rate=${item.success_rate ?? "n/a"}`
    );
  }
  if (topArms.length === 0) {
    console.log("- n/a");
  }
}

export { buildTunerReport };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildTunerReport(options);
  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTextReport(report);
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(`tuner-report failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
