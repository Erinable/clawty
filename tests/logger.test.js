import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRuntimeLogger } from "../src/logger.js";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("runtime logger writes JSON lines and redacts sensitive keys", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-logger-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const config = {
    workspaceRoot,
    logging: {
      enabled: true,
      level: "debug",
      console: false,
      file: true,
      path: ".clawty/logs/runtime-test.log"
    }
  };

  const logger = createRuntimeLogger(config, {
    component: "logger-test",
    context: {
      suite: "logger"
    }
  });

  logger.debug("logger.debug_event", {
    apiKey: "sk-should-redact",
    nested: {
      authorization: "Bearer should-redact"
    },
    count: 1
  });
  logger.info("logger.info_event", {
    ok: true
  });

  const logPath = path.join(workspaceRoot, ".clawty", "logs", "runtime-test.log");
  const lines = await readJsonLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].component, "logger-test");
  assert.equal(lines[0].suite, "logger");
  assert.equal(lines[0].event, "logger.debug_event");
  assert.equal(lines[0].apiKey, "[REDACTED]");
  assert.equal(lines[0].nested.authorization, "[REDACTED]");
  assert.equal(lines[1].event, "logger.info_event");
});

test("runtime logger enforces level filter", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-logger-level-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const config = {
    workspaceRoot,
    logging: {
      enabled: true,
      level: "warn",
      console: false,
      file: true,
      path: ".clawty/logs/runtime-level.log"
    }
  };

  const logger = createRuntimeLogger(config, {
    component: "logger-level-test"
  });

  logger.info("logger.info_ignored", { value: 1 });
  logger.warn("logger.warn_written", { value: 2 });
  logger.error("logger.error_written", { value: 3 });

  const logPath = path.join(workspaceRoot, ".clawty", "logs", "runtime-level.log");
  const lines = await readJsonLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, "logger.warn_written");
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[1].event, "logger.error_written");
  assert.equal(lines[1].level, "error");
});
