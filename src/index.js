#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import { loadConfig } from "./config.js";
import { runAgentTurn } from "./agent.js";
import { shutdownAllLspClients } from "./lsp-manager.js";

function printHelp() {
  console.log(
    [
      "Clawty CLI (MVP)",
      "",
      "Usage:",
      "  clawty chat",
      "  clawty run \"your task\"",
      "  clawty --help",
      "",
      "Equivalent local commands:",
      "  node src/index.js chat",
      "  node src/index.js run \"your task\"",
      "",
      "Environment:",
      "  OPENAI_API_KEY         Required",
      "  CLAWTY_MODEL           Optional (default: gpt-4.1-mini)",
      "  OPENAI_BASE_URL        Optional (default: https://api.openai.com/v1)",
      "  CLAWTY_WORKSPACE_ROOT  Optional (default: current directory)",
      "  CLAWTY_LSP_ENABLED     Optional (default: true)",
      "  CLAWTY_LSP_TS_CMD      Optional (default: typescript-language-server --stdio)"
    ].join("\n")
  );
}

async function runTask(config, state, task) {
  await runAgentTurn({
    config,
    state,
    userInput: task,
    onText(text) {
      console.log(`\n${text}\n`);
    },
    onTool(name, result) {
      const status = result.ok ? "ok" : "failed";
      console.error(`[tool:${name}] ${status}`);
    }
  });
}

async function runChat(config) {
  console.log("Clawty chat mode. Type 'exit' or 'quit' to stop.");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const state = {};

  try {
    while (true) {
      const raw = await rl.question("> ");
      const line = raw.trim();
      if (!line) {
        continue;
      }
      if (line === "exit" || line === "quit" || line === "/exit" || line === "/quit") {
        break;
      }
      await runTask(config, state, line);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h" || first === "help") {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (first === "chat") {
    await runChat(config);
    return;
  }

  if (first === "run") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      throw new Error('Missing task. Example: node src/index.js run "fix tests"');
    }
    await runTask(config, {}, task);
    return;
  }

  await runTask(config, {}, args.join(" "));
}

async function bootstrap() {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error.message || String(error));
    exitCode = 1;
  } finally {
    await shutdownAllLspClients().catch(() => {
      // Ignore cleanup failures on process shutdown.
    });
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

bootstrap();
