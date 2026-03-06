import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createDashboardRouter } from "../src/dashboard-api.js";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

function createServerOptions(workspaceRoot) {
  return {
    workspaceRoot,
    transport: "http",
    host: "127.0.0.1",
    port: 8765,
    enabledToolsets: new Set(["default"]),
    exposeLowLevel: false
  };
}

test("dashboard overview includes started_at and uptime_ms", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-overview-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/overview");

  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.body?.server?.started_at, "string");
  assert.equal(Number.isFinite(Date.parse(result.body?.server?.started_at)), true);
  assert.equal(typeof result.body?.server?.uptime_ms, "number");
  assert.equal(result.body?.server?.uptime_ms >= 0, true);
});

test("dashboard config-file redacts secrets and preserves them on save", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-config-redact-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const configPath = path.join(workspaceRoot, ".clawty", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        model: "gpt-4.1-mini",
        openai: {
          apiKey: "sk-workspace-secret"
        },
        embedding: {
          apiKey: "sk-embedding-secret"
        },
        metrics: {
          enabled: true
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const configFile = await router("/api/dashboard/config-file");

  assert.equal(configFile.statusCode, 200);
  assert.equal(configFile.body?.ok, true);
  assert.match(String(configFile.body?.data?.openai?.apiKey || ""), /\*\*\*$/);
  assert.match(String(configFile.body?.data?.embedding?.apiKey || ""), /\*\*\*$/);
  assert.notEqual(configFile.body?.data?.openai?.apiKey, "sk-workspace-secret");
  assert.notEqual(configFile.body?.data?.embedding?.apiKey, "sk-embedding-secret");

  const payload = JSON.parse(JSON.stringify(configFile.body.data));
  payload.metrics.enabled = false;

  const save = await router("/api/dashboard/config-save", {
    method: "POST",
    body: {
      data: payload
    }
  });
  assert.equal(save.statusCode, 200);
  assert.equal(save.body?.ok, true);
  assert.equal(save.body?.path, configPath);

  const savedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(savedConfig.metrics?.enabled, false);
  assert.equal(savedConfig.openai?.apiKey, "sk-workspace-secret");
  assert.equal(savedConfig.embedding?.apiKey, "sk-embedding-secret");
});

test("dashboard config-save validates config before writing", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-config-validate-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const configPath = path.join(workspaceRoot, ".clawty", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        model: "gpt-4.1-mini",
        openai: {
          apiKey: "sk-workspace-secret"
        },
        mcpServer: {
          transport: "http",
          port: 8899
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const configFile = await router("/api/dashboard/config-file");
  const payload = JSON.parse(JSON.stringify(configFile.body?.data || {}));
  payload.mcpServer.port = 80.5;

  const save = await router("/api/dashboard/config-save", {
    method: "POST",
    body: {
      data: payload
    }
  });

  assert.equal(save.statusCode, 200);
  assert.equal(save.body?.ok, false);
  assert.match(String(save.body?.error || ""), /Invalid CLAWTY_MCP_PORT/);

  const savedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(savedConfig.mcpServer?.port, 8899);
  assert.equal(savedConfig.openai?.apiKey, "sk-workspace-secret");
});

test("dashboard logs route filters by level and keyword with line clamp", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-logs-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const logDir = path.join(workspaceRoot, ".clawty", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "runtime.log"),
    [
      "2026-03-06T10:00:00.000Z info server start",
      "2026-03-06T10:00:01.000Z warn warm cache",
      "2026-03-06T10:00:02.000Z error boom timeout",
      "2026-03-06T10:00:03.000Z error boom retry"
    ].join("\n") + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/logs?source=runtime&scope=all&lines=5000&level=error&q=boom");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.source, "runtime");
  assert.equal(result.body?.scope, "all");
  assert.equal(result.body?.lines_requested, 1000);
  assert.equal(result.body?.lines_returned, 2);
  assert.equal(result.body?.entries?.every((entry) => entry.level === "error"), true);
  assert.equal(result.body?.entries?.every((entry) => entry.raw.includes("boom")), true);
});

test("dashboard logs route supports source selection and current-session filtering", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-logs-current-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const logDir = path.join(workspaceRoot, ".clawty", "logs");
  await fs.mkdir(logDir, { recursive: true });

  const now = Date.now();
  const mcpLines = [
    JSON.stringify({
      ts: new Date(now - 60 * 60 * 1000).toISOString(),
      level: "error",
      component: "mcp-server",
      event: "historical.error",
      message: "old"
    }),
    JSON.stringify({
      ts: new Date(now).toISOString(),
      level: "info",
      component: "mcp-server",
      event: "current.info",
      message: "new"
    })
  ];
  await fs.writeFile(path.join(logDir, "mcp-server.log"), mcpLines.join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(logDir, "runtime.log"), "", "utf8");

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/logs?source=mcp&scope=current&lines=100");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.source, "mcp");
  assert.equal(result.body?.scope, "current");
  assert.equal(result.body?.source_label, "MCP server log");
  assert.equal(typeof result.body?.session_started_at, "string");
  assert.equal(result.body?.entries?.length, 1);
  assert.match(result.body?.path || "", /mcp-server\.log$/);
  assert.equal(result.body?.entries?.[0]?.raw.includes("current.info"), true);
  assert.equal(result.body?.counts_by_level?.info, 1);
  assert.equal(result.body?.counts_by_level?.error, 0);
  assert.equal(Array.isArray(result.body?.available_sources), true);
  assert.equal(result.body?.available_sources?.some((item) => item.key === "runtime"), true);
  assert.equal(result.body?.available_sources?.some((item) => item.key === "mcp"), true);
});

test("dashboard logs route prefers structured log level over message text", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-logs-structured-level-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const logDir = path.join(workspaceRoot, ".clawty", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "runtime.log"),
    [
      JSON.stringify({
        ts: "2026-03-06T10:00:00.000Z",
        level: "info",
        message: "previous error cleared"
      }),
      JSON.stringify({
        ts: "2026-03-06T10:00:01.000Z",
        level: "error",
        message: "actual failure"
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const infoResult = await router("/api/dashboard/logs?source=runtime&scope=all&level=info&lines=100");
  const errorResult = await router("/api/dashboard/logs?source=runtime&scope=all&level=error&lines=100");

  assert.equal(infoResult.statusCode, 200);
  assert.equal(infoResult.body?.ok, true);
  assert.equal(infoResult.body?.entries?.length, 1);
  assert.equal(infoResult.body?.entries?.[0]?.level, "info");
  assert.match(infoResult.body?.entries?.[0]?.raw || "", /previous error cleared/);
  assert.equal(infoResult.body?.counts_by_level?.info, 1);

  assert.equal(errorResult.statusCode, 200);
  assert.equal(errorResult.body?.ok, true);
  assert.equal(errorResult.body?.entries?.length, 1);
  assert.equal(errorResult.body?.entries?.[0]?.level, "error");
  assert.match(errorResult.body?.entries?.[0]?.raw || "", /actual failure/);
  assert.equal(errorResult.body?.counts_by_level?.error, 1);
});

test("dashboard logs route uses fallback defaults when query params are omitted", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-logs-defaults-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const logDir = path.join(workspaceRoot, ".clawty", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "runtime.log"),
    [
      JSON.stringify({ ts: "2026-03-06T10:00:00.000Z", level: "info", event: "one" }),
      JSON.stringify({ ts: "2026-03-06T10:00:01.000Z", level: "warn", event: "two" })
    ].join("\n") + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/logs?source=runtime");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.lines_requested, 200);
  assert.equal(result.body?.scope, "all");
});

test("dashboard metrics timeline respects limit and parses event streams", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-timeline-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const metricsDir = path.join(workspaceRoot, ".clawty", "metrics");
  await fs.mkdir(metricsDir, { recursive: true });

  const now = Date.now();
  const rows = [0, 1, 2].map((offset) =>
    JSON.stringify({
      event_type: "hybrid_query",
      timestamp: new Date(now - (3 - offset) * 60_000).toISOString(),
      query_total_ms: 30 + offset,
      degradation: { degraded: offset === 2 }
    })
  );
  await fs.writeFile(path.join(metricsDir, "hybrid-query.jsonl"), rows.join("\n") + "\n", "utf8");
  await fs.writeFile(
    path.join(metricsDir, "watch-flush.jsonl"),
    JSON.stringify({
      event_type: "watch_flush",
      timestamp: new Date(now - 30_000).toISOString(),
      refresh_ms: 17,
      index_lag_ms: 9
    }) + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(metricsDir, "memory.jsonl"),
    JSON.stringify({
      event_type: "memory_search",
      timestamp: new Date(now - 15_000).toISOString(),
      query_total_ms: 41,
      returned_count: 2
    }) + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/metrics-timeline?limit=2");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.limit, 2);
  assert.equal(Array.isArray(result.body?.hybrid), true);
  assert.equal(result.body?.hybrid.length, 2);
  assert.equal(result.body?.hybrid[0].avg_latency_ms, 31);
  assert.equal(result.body?.hybrid[1].avg_latency_ms, 32);
  assert.equal(result.body?.watch_flush?.[0]?.latency_ms, 17);
  assert.equal(result.body?.memory?.[0]?.latency_ms, 41);
  assert.equal(result.body?.memory?.[0]?.hit, true);
});

test("dashboard metrics timeline uses 24h fallback window when omitted", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-timeline-default-window-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const metricsDir = path.join(workspaceRoot, ".clawty", "metrics");
  await fs.mkdir(metricsDir, { recursive: true });

  const now = Date.now();
  await fs.writeFile(path.join(metricsDir, "hybrid-query.jsonl"), "", "utf8");
  await fs.writeFile(path.join(metricsDir, "watch-flush.jsonl"), "", "utf8");
  await fs.writeFile(
    path.join(metricsDir, "memory.jsonl"),
    JSON.stringify({
      event_type: "memory_search",
      timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      query_total_ms: 12,
      returned_count: 1
    }) + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);
  const result = await router("/api/dashboard/metrics-timeline?limit=10");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.window_hours, 24);
  assert.equal(result.body?.memory?.length, 1);
  assert.equal(result.body?.memory?.[0]?.latency_ms, 12);
  assert.equal(result.body?.memory?.[0]?.hit, true);
});

test("dashboard metrics route forwards selected time window to report builders", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-metrics-window-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const calls = [];
  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null, {
    async buildMetricsReport(options) {
      calls.push(["metrics", options.windowHours]);
      return {
        generated_at: "2026-03-06T00:00:00.000Z",
        workspace_root: workspaceRoot,
        window_hours: options.windowHours,
        inputs: {},
        kpi: {},
        sample_sizes: {}
      };
    },
    async buildTunerReport(options) {
      calls.push(["tuner", options.windowHours]);
      return {
        generated_at: "2026-03-06T00:00:00.000Z",
        workspace_root: workspaceRoot,
        window_hours: options.windowHours,
        inputs: {},
        summary: {}
      };
    }
  });

  const result = await router("/api/dashboard/metrics?window_hours=168");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.metrics?.window_hours, 168);
  assert.equal(result.body?.tuner?.window_hours, 168);
  assert.deepEqual(calls, [
    ["metrics", 168],
    ["tuner", 168]
  ]);
});

test("dashboard operations routes use injected dependencies", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-ops-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const called = {
    doctor: 0,
    reindex: [],
    memory: [],
    loadConfig: []
  };

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null, {
    loadConfig(options = {}) {
      called.loadConfig.push(options);
      assert.equal(options.cwd, workspaceRoot);
      assert.equal(options.allowMissingApiKey, true);
      return { workspaceRoot, model: "gpt-4.1-mini" };
    },
    async runDoctor(config) {
      called.doctor += 1;
      assert.equal(config.workspaceRoot, workspaceRoot);
      return { ok: true, summary: { pass: 1, warn: 0, fail: 0 } };
    },
    async refreshCodeIndex(root, args) {
      called.reindex.push(["code", root, args]);
      return { ok: true, refreshed: 1 };
    },
    async refreshSyntaxIndex(root, args) {
      called.reindex.push(["syntax", root, args]);
      return { ok: true, refreshed: 1 };
    },
    async refreshSemanticGraph(root, args) {
      called.reindex.push(["semantic", root, args]);
      return { ok: true, refreshed: 1 };
    },
    async searchMemory(root, query, options) {
      called.memory.push([root, query, options]);
      return {
        ok: true,
        results: [{ id: 1, title: "remember", confidence: 0.8 }]
      };
    }
  });

  const config = await router("/api/dashboard/config");
  assert.equal(config.statusCode, 200);
  assert.equal(config.body?.model, "gpt-4.1-mini");

  const doctor = await router("/api/dashboard/ops/doctor", {
    method: "POST",
    body: {}
  });
  assert.equal(doctor.statusCode, 200);
  assert.equal(doctor.body?.ok, true);
  assert.equal(called.doctor, 1);
  assert.equal(called.loadConfig.length, 2);

  const reindex = await router("/api/dashboard/ops/reindex", {
    method: "POST",
    body: {}
  });
  assert.equal(reindex.statusCode, 200);
  assert.equal(reindex.body?.ok, true);
  assert.deepEqual(
    called.reindex.map((item) => item[0]),
    ["code", "syntax", "semantic"]
  );
  assert.equal(called.reindex[0][2].force_rebuild, true);

  const memory = await router("/api/dashboard/ops/memory-search", {
    method: "POST",
    body: {
      query: "index quality",
      top_k: 8
    }
  });
  assert.equal(memory.statusCode, 200);
  assert.equal(memory.body?.ok, true);
  assert.equal(called.memory.length, 1);
  assert.equal(called.memory[0][1], "index quality");
  assert.equal(called.memory[0][2].topK, 8);

  const emptyQuery = await router("/api/dashboard/ops/memory-search", {
    method: "POST",
    body: {
      query: "   "
    }
  });
  assert.equal(emptyQuery.body?.ok, false);
});

test("dashboard config-file uses legacy project config path when present", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-dashboard-config-legacy-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const legacyPath = path.join(workspaceRoot, "clawty.config.json");
  await fs.writeFile(
    legacyPath,
    JSON.stringify(
      {
        model: "legacy-model",
        memory: {
          enabled: true
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const router = createDashboardRouter(createServerOptions(workspaceRoot), [], null);

  const effectiveConfig = await router("/api/dashboard/config");
  assert.equal(effectiveConfig.statusCode, 200);
  assert.equal(effectiveConfig.body?.model, "legacy-model");

  const configFile = await router("/api/dashboard/config-file");
  assert.equal(configFile.statusCode, 200);
  assert.equal(configFile.body?.ok, true);
  assert.equal(configFile.body?.path, legacyPath);
  assert.equal(configFile.body?.is_legacy_path, true);
  assert.equal(configFile.body?.data?.model, "legacy-model");

  const payload = JSON.parse(JSON.stringify(configFile.body.data));
  payload.memory.enabled = false;

  const save = await router("/api/dashboard/config-save", {
    method: "POST",
    body: {
      data: payload
    }
  });
  assert.equal(save.statusCode, 200);
  assert.equal(save.body?.ok, true);
  assert.equal(save.body?.path, legacyPath);
  assert.equal(save.body?.is_legacy_path, true);

  const savedLegacyConfig = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  assert.equal(savedLegacyConfig.memory?.enabled, false);

  const newConfigExists = await fs.stat(path.join(workspaceRoot, ".clawty", "config.json"))
    .then(() => true)
    .catch(() => false);
  assert.equal(newConfigExists, false);
});
