#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import { loadConfig } from "./config.js";
import { runAgentTurn } from "./agent.js";
import { shutdownAllLspClients } from "./lsp-manager.js";
import { parseWatchCliArgs, runIndexWatchLoop } from "./index-watch.js";

function printHelp() {
  console.log(
    [
      "Clawty CLI (MVP)",
      "",
      "Usage:",
      "  clawty chat",
      "  clawty run \"your task\"",
      "  clawty config show",
      "  clawty watch-index [options]",
      "  clawty --help",
      "",
      "Equivalent local commands:",
      "  node src/index.js chat",
      "  node src/index.js run \"your task\"",
      "  node src/index.js config show",
      "  node src/index.js watch-index [options]",
      "",
      "Environment:",
      "  OPENAI_API_KEY         Required",
      "  CLAWTY_MODEL           Optional (default: gpt-4.1-mini)",
      "  OPENAI_BASE_URL        Optional (default: https://api.openai.com/v1)",
      "  CLAWTY_WORKSPACE_ROOT  Optional (default: current directory)",
      "  CLAWTY_INDEX_MAX_FILES Optional (default: 3000)",
      "  CLAWTY_INDEX_MAX_FILE_SIZE_KB Optional (default: 512)",
      "  CLAWTY_LSP_ENABLED     Optional (default: true)",
      "  CLAWTY_LSP_TS_CMD      Optional (default: typescript-language-server --stdio)",
      "  CLAWTY_EMBEDDING_ENABLED Optional (default: false)",
      "  CLAWTY_EMBEDDING_MODEL  Optional (default: text-embedding-3-small)",
      "  CLAWTY_EMBEDDING_TOP_K  Optional (default: 15)",
      "  CLAWTY_EMBEDDING_WEIGHT Optional (default: 0.25)",
      "  CLAWTY_EMBEDDING_TIMEOUT_MS Optional (default: 15000)",
      "  CLAWTY_EMBEDDING_API_KEY Optional (default: OPENAI_API_KEY)",
      "  CLAWTY_EMBEDDING_BASE_URL Optional (default: OPENAI_BASE_URL)",
      "  CLAWTY_SEMANTIC_SEED_LANG_FILTER Optional (default: *)",
      "  CLAWTY_PRECISE_STALE_AFTER_MINUTES Optional (default: 1440)",
      "  CLAWTY_WATCH_INTERVAL_MS Optional (default: 2000)",
      "  CLAWTY_WATCH_MAX_FILES Optional (default: 20000)",
      "  CLAWTY_WATCH_MAX_BATCH_SIZE Optional (default: 300)",
      "  CLAWTY_WATCH_BUILD_ON_START Optional (default: true)",
      "  CLAWTY_WATCH_INCLUDE_SYNTAX Optional (default: true)",
      "  CLAWTY_WATCH_INCLUDE_SEMANTIC Optional (default: true)",
      "",
      "Config files:",
      "  clawty.config.json or .clawty/config.json"
    ].join("\n")
  );
}

function printWatchHelp() {
  console.log(
    [
      "watch-index: auto refresh code/syntax/semantic indexes by file changes",
      "",
      "Usage:",
      "  node src/index.js watch-index [options]",
      "",
      "Options:",
      "  --interval-ms <n>                Poll interval in milliseconds",
      "  --max-files <n>                  Max tracked files in snapshot",
      "  --max-batch-size <n>             Max changed/deleted files per refresh batch",
      "  --build-on-start <bool>          Build indexes once before watch loop",
      "  --no-build-on-start              Disable initial build",
      "  --include-syntax <bool>          Include syntax index refresh",
      "  --no-syntax                      Disable syntax index refresh",
      "  --include-semantic <bool>        Include semantic graph refresh",
      "  --no-semantic                    Disable semantic graph refresh",
      "  --semantic-include-definitions <bool>",
      "  --semantic-include-references <bool>",
      "  --quiet                          Disable loop logs",
      "  -h, --help                       Show this help",
      "",
      "Environment overrides:",
      "  CLAWTY_WATCH_INTERVAL_MS",
      "  CLAWTY_WATCH_MAX_FILES",
      "  CLAWTY_WATCH_MAX_BATCH_SIZE",
      "  CLAWTY_WATCH_BUILD_ON_START",
      "  CLAWTY_WATCH_INCLUDE_SYNTAX",
      "  CLAWTY_WATCH_INCLUDE_SEMANTIC",
      "  CLAWTY_WATCH_SEMANTIC_INCLUDE_DEFINITIONS",
      "  CLAWTY_WATCH_SEMANTIC_INCLUDE_REFERENCES",
      "  CLAWTY_WATCH_QUIET",
      "",
      "Examples:",
      "  node src/index.js watch-index",
      "  node src/index.js watch-index --interval-ms 1000 --max-batch-size 200",
      "  node src/index.js watch-index --no-semantic --quiet"
    ].join("\n")
  );
}

function redactConfig(config) {
  return {
    ...config,
    embedding: {
      ...(config.embedding || {}),
      apiKey: config.embedding?.apiKey ? `${config.embedding.apiKey.slice(0, 6)}***` : null
    },
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}***` : null
  };
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

  if (first === "config") {
    const sub = args[1] || "show";
    if (sub !== "show") {
      throw new Error('Unknown config command. Use: node src/index.js config show');
    }
    const config = loadConfig({ allowMissingApiKey: true });
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  if (first === "watch-index") {
    const watchArgs = parseWatchCliArgs(args.slice(1));
    if (watchArgs.help) {
      printWatchHelp();
      return;
    }
    const config = loadConfig({ allowMissingApiKey: true });
    const result = await runIndexWatchLoop(config.workspaceRoot, watchArgs);
    if (!result?.ok) {
      throw new Error(result?.error || "watch-index failed");
    }
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
