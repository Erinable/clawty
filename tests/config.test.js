import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig, resolveConfigSources } from "../src/config.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

test("loadConfig reads file-based config and resolves workspaceRoot", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "clawty.config.json",
    JSON.stringify(
      {
        openai: {
          apiKey: "sk-test-file-key",
          baseUrl: "https://example.invalid/v1/"
        },
        model: "gpt-4.1",
        workspaceRoot: ".",
        tools: {
          timeoutMs: 45000,
          maxIterations: 12
        },
        index: {
          maxFiles: 1234,
          maxFileSizeKb: 256,
          freshnessEnabled: false,
          freshnessStaleAfterMs: 600000,
          freshnessWeight: 0.2,
          freshnessVectorStalePenalty: 0.35,
          freshnessMaxPaths: 88
        },
        lsp: {
          enabled: false,
          timeoutMs: 8000,
          maxResults: 33,
          tsCommand: "my-ts-lsp --stdio"
        },
        agentContext: {
          incrementalContextEnabled: false,
          incrementalContextMaxPaths: 12,
          incrementalContextMaxDiffChars: 3200,
          incrementalContextTimeoutMs: 2500
        },
        metrics: {
          enabled: false,
          persistHybrid: false,
          persistWatch: false,
          persistMemory: false,
          queryPreviewChars: 120
        },
        onlineTuner: {
          enabled: true,
          mode: "shadow",
          dbPath: ".clawty/custom-tuner.db",
          epsilon: 0.12,
          globalPriorWeight: 0.4,
          localWarmupSamples: 60,
          minConstraintSamples: 45,
          maxDegradeRate: 0.11,
          maxTimeoutRate: 0.09,
          maxNetworkRate: 0.06,
          successRewardThreshold: 0.42
        },
        memory: {
          enabled: true,
          maxInjectedItems: 7,
          maxInjectedChars: 2800,
          autoWrite: true,
          writeGateEnabled: true,
          minLessonChars: 96,
          dedupeEnabled: false,
          quarantineThreshold: 4,
          ranking: {
            bm25Weight: 0.4,
            recencyWeight: 0.2,
            confidenceWeight: 0.1,
            successRateWeight: 0.1,
            qualityWeight: 0.1,
            feedbackWeight: 0.1,
            projectBoost: 1.2,
            globalBoost: 0.4,
            negativePenaltyPerDownvote: 0.08,
            negativePenaltyCap: 0.35,
            recentNegativePenalty: 0.2,
            recentNegativeRecencyThreshold: 0.6
          },
          scope: "project"
        }
      },
      null,
      2
    )
  );

  const config = loadConfig({ cwd: workspaceRoot, env: {} });
  assert.equal(config.apiKey, "sk-test-file-key");
  assert.equal(config.baseUrl, "https://example.invalid/v1");
  assert.equal(config.model, "gpt-4.1");
  assert.equal(config.workspaceRoot, path.resolve(workspaceRoot));
  assert.equal(config.toolTimeoutMs, 45000);
  assert.equal(config.maxToolIterations, 12);
  assert.equal(config.index.maxFiles, 1234);
  assert.equal(config.index.maxFileSizeKb, 256);
  assert.equal(config.index.freshnessEnabled, false);
  assert.equal(config.index.freshnessStaleAfterMs, 600000);
  assert.equal(config.index.freshnessWeight, 0.2);
  assert.equal(config.index.freshnessVectorStalePenalty, 0.35);
  assert.equal(config.index.freshnessMaxPaths, 88);
  assert.equal(config.lsp.enabled, false);
  assert.equal(config.lsp.timeoutMs, 8000);
  assert.equal(config.lsp.maxResults, 33);
  assert.equal(config.lsp.tsCommand, "my-ts-lsp --stdio");
  assert.equal(config.agentContext.incrementalContextEnabled, false);
  assert.equal(config.agentContext.incrementalContextMaxPaths, 12);
  assert.equal(config.agentContext.incrementalContextMaxDiffChars, 3200);
  assert.equal(config.agentContext.incrementalContextTimeoutMs, 2500);
  assert.equal(config.metrics.enabled, false);
  assert.equal(config.metrics.persistHybrid, false);
  assert.equal(config.metrics.persistWatch, false);
  assert.equal(config.metrics.persistMemory, false);
  assert.equal(config.metrics.queryPreviewChars, 120);
  assert.equal(config.onlineTuner.enabled, true);
  assert.equal(config.onlineTuner.mode, "shadow");
  assert.equal(config.onlineTuner.dbPath, ".clawty/custom-tuner.db");
  assert.equal(config.onlineTuner.epsilon, 0.12);
  assert.equal(config.onlineTuner.globalPriorWeight, 0.4);
  assert.equal(config.onlineTuner.localWarmupSamples, 60);
  assert.equal(config.onlineTuner.minConstraintSamples, 45);
  assert.equal(config.onlineTuner.maxDegradeRate, 0.11);
  assert.equal(config.onlineTuner.maxTimeoutRate, 0.09);
  assert.equal(config.onlineTuner.maxNetworkRate, 0.06);
  assert.equal(config.onlineTuner.successRewardThreshold, 0.42);
  assert.equal(config.memory.enabled, true);
  assert.equal(config.memory.maxInjectedItems, 7);
  assert.equal(config.memory.maxInjectedChars, 2800);
  assert.equal(config.memory.autoWrite, true);
  assert.equal(config.memory.writeGateEnabled, true);
  assert.equal(config.memory.minLessonChars, 96);
  assert.equal(config.memory.dedupeEnabled, false);
  assert.equal(config.memory.quarantineThreshold, 4);
  assert.equal(config.memory.ranking.bm25Weight, 0.4);
  assert.equal(config.memory.ranking.projectBoost, 1.2);
  assert.equal(config.memory.ranking.recentNegativeRecencyThreshold, 0.6);
  assert.equal(config.memory.scope, "project");
  assert.ok(config.sources.configFile?.endsWith("clawty.config.json"));
});

test("loadConfig applies precedence: env > .env > file > defaults", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "clawty.config.json",
    JSON.stringify(
      {
        openai: {
          apiKey: "sk-from-file"
        },
        model: "model-from-file",
        tools: {
          timeoutMs: 1000
        },
        lsp: {
          enabled: true
        }
      },
      null,
      2
    )
  );

  await writeWorkspaceFile(
    workspaceRoot,
    ".env",
    [
      "OPENAI_API_KEY=sk-from-dotenv",
      "CLAWTY_MODEL=model-from-dotenv",
      "CLAWTY_TOOL_TIMEOUT_MS=2222"
    ].join("\n")
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {
      OPENAI_API_KEY: "sk-from-env",
      CLAWTY_MODEL: "model-from-env",
      CLAWTY_TOOL_TIMEOUT_MS: "3333",
      CLAWTY_INDEX_FRESHNESS_STALE_AFTER_MS: "123000",
      CLAWTY_AGENT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS: "9000",
      CLAWTY_METRICS_PERSIST_WATCH: "false",
      CLAWTY_METRICS_PERSIST_MEMORY: "false",
      CLAWTY_METRICS_QUERY_PREVIEW_CHARS: "220",
      CLAWTY_MEMORY_MIN_LESSON_CHARS: "120",
      CLAWTY_MEMORY_DEDUPE_ENABLED: "false",
      CLAWTY_MEMORY_QUARANTINE_THRESHOLD: "6",
      CLAWTY_MEMORY_RANK_RECENCY_WEIGHT: "0.9",
      CLAWTY_MEMORY_RANK_BM25_WEIGHT: "0.1",
      CLAWTY_TUNER_ENABLED: "true",
      CLAWTY_TUNER_MODE: "active",
      CLAWTY_TUNER_EPSILON: "0.03",
      CLAWTY_TUNER_MAX_TIMEOUT_RATE: "0.06",
      CLAWTY_TUNER_SUCCESS_REWARD_THRESHOLD: "0.25"
    }
  });

  assert.equal(config.apiKey, "sk-from-env");
  assert.equal(config.model, "model-from-env");
  assert.equal(config.toolTimeoutMs, 3333);
  assert.equal(config.index.freshnessStaleAfterMs, 123000);
  assert.equal(config.agentContext.incrementalContextMaxDiffChars, 9000);
  assert.equal(config.metrics.persistWatch, false);
  assert.equal(config.metrics.persistMemory, false);
  assert.equal(config.metrics.queryPreviewChars, 220);
  assert.equal(config.memory.minLessonChars, 120);
  assert.equal(config.memory.dedupeEnabled, false);
  assert.equal(config.memory.quarantineThreshold, 6);
  assert.equal(config.memory.ranking.recencyWeight, 0.9);
  assert.equal(config.memory.ranking.bm25Weight, 0.1);
  assert.equal(config.onlineTuner.enabled, true);
  assert.equal(config.onlineTuner.mode, "active");
  assert.equal(config.onlineTuner.epsilon, 0.03);
  assert.equal(config.onlineTuner.maxTimeoutRate, 0.06);
  assert.equal(config.onlineTuner.successRewardThreshold, 0.25);
  assert.ok(config.sources.dotEnvFile?.endsWith(".env"));
});

test("loadConfig throws on missing API key unless allowMissingApiKey=true", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  assert.throws(
    () => loadConfig({ cwd: workspaceRoot, env: {} }),
    /Missing OPENAI_API_KEY/
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {},
    allowMissingApiKey: true
  });
  assert.equal(config.apiKey, null);
});

test("loadConfig resolves embedding config and honors env overrides", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "clawty.config.json",
    JSON.stringify(
      {
        openai: {
          apiKey: "sk-base-key",
          baseUrl: "https://example.invalid/v1"
        },
        embedding: {
          enabled: true,
          model: "text-embedding-3-large",
          topK: 12,
          weight: 0.4,
          timeoutMs: 20000
        }
      },
      null,
      2
    )
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {
      CLAWTY_EMBEDDING_TOP_K: "22",
      CLAWTY_EMBEDDING_WEIGHT: "0.7"
    }
  });

  assert.equal(config.embedding.enabled, true);
  assert.equal(config.embedding.model, "text-embedding-3-large");
  assert.equal(config.embedding.topK, 22);
  assert.equal(config.embedding.weight, 0.7);
  assert.equal(config.embedding.timeoutMs, 20000);
  assert.equal(config.embedding.apiKey, "sk-base-key");
  assert.equal(config.embedding.baseUrl, "https://example.invalid/v1");
});

test("loadConfig validates OPENAI_BASE_URL and embedding base URL", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  assert.throws(
    () =>
      loadConfig({
        cwd: workspaceRoot,
        env: {
          OPENAI_API_KEY: "sk-test",
          OPENAI_BASE_URL: "notaurl"
        }
      }),
    /Invalid OPENAI_BASE_URL/
  );

  assert.throws(
    () =>
      loadConfig({
        cwd: workspaceRoot,
        env: {
          OPENAI_API_KEY: "sk-test",
          OPENAI_BASE_URL: "https://api.openai.com/v1",
          CLAWTY_EMBEDDING_BASE_URL: "ftp://example.com/v1"
        }
      }),
    /Invalid CLAWTY_EMBEDDING_BASE_URL/
  );
});

test("loadConfig throws on invalid JSON config", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await fs.writeFile(path.join(workspaceRoot, "clawty.config.json"), "{ invalid ", "utf8");

  assert.throws(
    () =>
      loadConfig({
        cwd: workspaceRoot,
        env: {},
        allowMissingApiKey: true
      }),
    /Invalid JSON/
  );
});

test("loadConfig applies precedence: env > project > global", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    path.join("fake-home", ".clawty", "config.json"),
    JSON.stringify(
      {
        openai: {
          apiKey: "sk-global"
        },
        model: "global-model",
        index: {
          maxFiles: 111
        }
      },
      null,
      2
    )
  );

  await writeWorkspaceFile(
    workspaceRoot,
    path.join(".clawty", "config.json"),
    JSON.stringify(
      {
        model: "project-model",
        index: {
          maxFiles: 222
        }
      },
      null,
      2
    )
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    homeDir: fakeHome,
    env: {
      CLAWTY_MODEL: "env-model",
      OPENAI_API_KEY: "sk-env"
    }
  });

  assert.equal(config.model, "env-model");
  assert.equal(config.apiKey, "sk-env");
  assert.equal(config.index.maxFiles, 222);
  assert.equal(config.sources.projectConfigFile, path.join(workspaceRoot, ".clawty", "config.json"));
  assert.equal(config.sources.globalConfigFile, path.join(fakeHome, ".clawty", "config.json"));
});

test("resolveConfigSources reports legacy project config warning", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "clawty.config.json",
    JSON.stringify(
      {
        model: "legacy-project-model"
      },
      null,
      2
    )
  );

  const sources = resolveConfigSources({
    cwd: workspaceRoot,
    homeDir: fakeHome,
    env: {}
  });

  assert.equal(sources.projectConfig.isLegacyPath, true);
  assert.ok(Array.isArray(sources.warnings));
  assert.match(sources.warnings[0]?.message || "", /deprecated/i);
});
