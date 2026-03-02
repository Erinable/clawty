import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "../src/config.js";
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
          queryPreviewChars: 120
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
  assert.equal(config.metrics.queryPreviewChars, 120);
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
      CLAWTY_METRICS_QUERY_PREVIEW_CHARS: "220"
    }
  });

  assert.equal(config.apiKey, "sk-from-env");
  assert.equal(config.model, "model-from-env");
  assert.equal(config.toolTimeoutMs, 3333);
  assert.equal(config.index.freshnessStaleAfterMs, 123000);
  assert.equal(config.agentContext.incrementalContextMaxDiffChars, 9000);
  assert.equal(config.metrics.queryPreviewChars, 220);
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
