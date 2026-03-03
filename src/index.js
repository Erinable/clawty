#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createRuntimeLogger } from "./logger.js";

const LOGO = "== clawty ==";

let shouldAttemptLspCleanup = false;
let agentTurnModulePromise = null;
let packageVersionPromise = null;

const ROOT_COMMANDS = [
  ["clawty config [show]", "show effective configuration"],
  ["clawty memory [search|stats]", "search or inspect memory stats"],
  ["clawty monitor [report]", "show runtime metrics and tuner stats"],
  ["clawty run [message..]", "run clawty with a message"],
  ["clawty chat", "start interactive chat mode"],
  ["clawty init", "bootstrap repository analysis"],
  ["clawty doctor", "run diagnostics and health checks"],
  ["clawty watch-index", "auto refresh indexes on file changes"],
  ["clawty mcp-server", "start MCP server for monitoring and code intelligence"]
];

const ROOT_OPTIONS = [
  ["-h, --help", "show help"],
  ["-v, --version", "show version number"]
];

function formatRows(rows, indent = 2) {
  const list = Array.isArray(rows) ? rows : [];
  const width = list.reduce((max, row) => Math.max(max, String(row[0] || "").length), 0);
  return list.map(([left, right]) => {
    const lhs = String(left || "").padEnd(width, " ");
    return `${" ".repeat(indent)}${lhs}  ${String(right || "")}`;
  });
}

function renderHelp({ commands = [], positionals = [], options = [], footer = [] } = {}) {
  const lines = [LOGO, ""];

  if (commands.length > 0) {
    lines.push("Commands:");
    lines.push(...formatRows(commands));
    lines.push("");
  }

  if (positionals.length > 0) {
    lines.push("Positionals:");
    lines.push(...formatRows(positionals));
    lines.push("");
  }

  if (options.length > 0) {
    lines.push("Options:");
    lines.push(...formatRows(options));
    lines.push("");
  }

  if (footer.length > 0) {
    lines.push(...footer);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function getPackageVersion() {
  if (!packageVersionPromise) {
    packageVersionPromise = (async () => {
      const candidateDirs = [];
      const scriptPath = typeof process.argv?.[1] === "string" ? process.argv[1] : null;
      if (scriptPath) {
        const scriptDir = path.dirname(path.resolve(scriptPath));
        candidateDirs.push(path.resolve(scriptDir, ".."));
        candidateDirs.push(scriptDir);
      }
      candidateDirs.push(path.resolve(process.cwd()));

      const visited = new Set();
      for (const dir of candidateDirs) {
        const normalized = path.resolve(dir);
        if (visited.has(normalized)) {
          continue;
        }
        visited.add(normalized);
        const packagePath = path.join(normalized, "package.json");
        try {
          const raw = await fs.readFile(packagePath, "utf8");
          const parsed = JSON.parse(raw);
          if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
            return parsed.version.trim();
          }
        } catch {
          // Try next candidate.
        }
      }
      return "0.0.0";
    })();
  }
  return packageVersionPromise;
}

async function getRunAgentTurn() {
  if (!agentTurnModulePromise) {
    agentTurnModulePromise = import("./agent.js");
  }
  const module = await agentTurnModulePromise;
  return module.runAgentTurn;
}

function printMainHelp() {
  console.log(
    renderHelp({
      commands: ROOT_COMMANDS,
      options: ROOT_OPTIONS
    })
  );
}

function printWatchHelp() {
  console.log(
    renderHelp({
      commands: [["clawty watch-index [options]", "start watch loop and refresh indexes"]],
      options: [
        ["--interval-ms <n>", "poll interval in milliseconds"],
        ["--no-vector", "disable vector refresh"],
        ["--quiet", "disable loop logs"],
        ["-h, --help", "show help"]
      ],
      footer: [
        "Advanced watch parameters are still supported via .clawty/config.json and env vars."
      ]
    })
  );
}

function printConfigHelp() {
  console.log(
    renderHelp({
      commands: [["clawty config [show]", "show effective config (redacted)"]],
      options: [
        ["--json", "output JSON"],
        ["-h, --help", "show help"]
      ],
      footer: [
        "`config path` and `config validate` have been removed from the public CLI; use `doctor --json`."
      ]
    })
  );
}

function printMemoryHelp() {
  console.log(
    renderHelp({
      commands: [
        ["clawty memory search <query>", "search memory lessons"],
        ["clawty memory stats", "show memory usage statistics"]
      ],
      positionals: [["query", "search text for memory recall"]],
      options: [
        ["--json", "output structured JSON"],
        ["--explain", "include score component breakdown (search command)"],
        ["--top-k <n>", "max returned lessons for search"],
        ["--scope <project|global|project+global>", "memory scope"],
        ["-h, --help", "show help"]
      ],
      footer: [
        "Advanced memory admin commands (inspect/feedback/prune/reindex) are removed from public CLI."
      ]
    })
  );
}

function printMonitorHelp() {
  console.log(
    renderHelp({
      commands: [["clawty monitor [report]", "combined metrics+tuner report"]],
      options: [
        ["--json", "output JSON"],
        ["--window-hours <n>", "time window in hours (default 24)"],
        ["--watch", "refresh report periodically"],
        ["--interval-ms <n>", "watch refresh interval (default 5000ms)"],
        ["-h, --help", "show help"]
      ],
      footer: [
        "`monitor metrics` / `monitor tuner` have been removed from public CLI."
      ]
    })
  );
}

function printMcpServerHelp() {
  console.log(
    renderHelp({
      commands: [
        ["clawty mcp-server", "start MCP server from config (recommended)"],
        ["clawty mcp-server --port 8765", "start MCP HTTP server on 127.0.0.1:8765"]
      ],
      options: [
        ["--workspace <path>", "workspace root for MCP tools"],
        ["--port <n>", "HTTP listen port (implies --transport http if omitted)"],
        ["--log-path <path>", "MCP log file path (default .clawty/logs/mcp-server.log)"],
        ["-h, --help", "show help"]
      ],
      footer: [
        "Advanced MCP switches (toolset/expose-low-level/transport/host) are config-first and hidden from quick help."
      ]
    })
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
  shouldAttemptLspCleanup = true;
  const logger = createRuntimeLogger(config, {
    component: "cli",
    context: {
      command: "run"
    }
  });
  logger.info("cli.run_start", {
    task_chars: typeof task === "string" ? task.length : 0
  });
  const runAgentTurn = await getRunAgentTurn();
  await runAgentTurn({
    config,
    state,
    userInput: task,
    logger: logger.child({ component: "agent-turn" }),
    onText(text) {
      console.log(`\n${text}\n`);
    },
    onTool(name, result) {
      const status = result.ok ? "ok" : "failed";
      console.error(`[tool:${name}] ${status}`);
    }
  });
  logger.info("cli.run_complete");
}

async function runChat(config) {
  const logger = createRuntimeLogger(config, {
    component: "cli",
    context: {
      command: "chat"
    }
  });
  console.log("Clawty chat mode. Type 'exit' or 'quit' to stop.");
  logger.info("cli.chat_start");
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
        logger.info("cli.chat_exit");
        break;
      }
      logger.debug("cli.chat_turn", {
        input_chars: line.length
      });
      const runAgentTurn = await getRunAgentTurn();
      shouldAttemptLspCleanup = true;
      await runAgentTurn({
        config,
        state,
        userInput: line,
        logger: logger.child({ component: "agent-turn" }),
        onText(text) {
          console.log(`\n${text}\n`);
        },
        onTool(name, result) {
          const status = result.ok ? "ok" : "failed";
          console.error(`[tool:${name}] ${status}`);
        }
      });
    }
  } finally {
    rl.close();
  }
}

function parseJsonAndHelpFlags(argv = []) {
  const state = {
    help: false,
    format: "text",
    rest: []
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      state.help = true;
      continue;
    }
    if (arg === "--json" || arg === "--format=json") {
      state.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      state.format = "text";
      continue;
    }
    state.rest.push(arg);
  }

  return state;
}

async function handleConfigCommand(argv) {
  const parsed = parseJsonAndHelpFlags(argv);
  const sub = parsed.rest[0] || "show";

  if (parsed.help) {
    printConfigHelp();
    return;
  }

  if (sub === "show") {
    const config = loadConfig({ allowMissingApiKey: true });
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  if (sub === "path" || sub === "validate") {
    throw new Error(
      `\`clawty config ${sub}\` has been removed from public CLI. Use: clawty doctor --json`
    );
  }

  if (parsed.rest.length === 0) {
    const config = loadConfig({ allowMissingApiKey: true });
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  throw new Error(`Unknown config command: ${sub}. Use: clawty config [show]`);
}

function parseMemoryArgs(argv = []) {
  const state = {
    help: false,
    format: "text",
    topK: null,
    scope: null,
    explain: false,
    rest: []
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "-h" || arg === "--help") {
      state.help = true;
      continue;
    }
    if (arg === "--json" || arg === "--format=json") {
      state.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      state.format = "text";
      continue;
    }
    if (arg === "--explain") {
      state.explain = true;
      continue;
    }
    if (arg === "--top-k") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --top-k");
      }
      state.topK = Number(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--top-k=")) {
      state.topK = Number(arg.slice("--top-k=".length));
      continue;
    }
    if (arg === "--scope") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --scope");
      }
      state.scope = String(raw).trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      state.scope = String(arg.slice("--scope=".length)).trim();
      continue;
    }
    state.rest.push(arg);
  }

  return state;
}

async function handleMemoryCommand(argv) {
  const parsed = parseMemoryArgs(argv);
  const sub = parsed.rest[0] || "stats";

  if (parsed.help) {
    printMemoryHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const memoryOptions = {
    homeDir: config?.sources?.homeDir,
    scope: parsed.scope || config?.memory?.scope || "project+global",
    quarantineThreshold: config?.memory?.quarantineThreshold,
    ranking: config?.memory?.ranking,
    metrics: config?.metrics
  };

  const {
    searchMemory,
    getMemoryStats
  } = await import("./memory.js");

  if (sub === "search") {
    const query = parsed.rest.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Missing query. Example: clawty memory search \"auth retry\" --top-k 5");
    }
    const result = await searchMemory(config.workspaceRoot, query, {
      ...memoryOptions,
      topK: parsed.topK,
      explain: parsed.explain
    });
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          scope: result.scope,
          count: Array.isArray(result.items) ? result.items.length : 0,
          items: Array.isArray(result.items)
            ? result.items.map((item) => ({
                id: item.id,
                title: item.title,
                score: item.score,
                confidence: item.confidence,
                workspace_match: item.workspace_match,
                updated_at: item.updated_at,
                ...(parsed.explain ? { components: item.components || null } : {})
              }))
            : [],
          ...(parsed.explain ? { ranking: result.ranking || null } : {})
        },
        null,
        2
      )
    );
    return;
  }

  if (sub === "stats") {
    const result = await getMemoryStats(config.workspaceRoot, memoryOptions);
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (["inspect", "feedback", "prune", "reindex"].includes(sub)) {
    throw new Error(
      `\`clawty memory ${sub}\` has been removed from public CLI. Supported: search, stats`
    );
  }

  if (parsed.rest.length === 0) {
    const result = await getMemoryStats(config.workspaceRoot, memoryOptions);
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown memory command: ${sub}. Use: clawty memory <search|stats>`);
}

function parseMonitorArgs(argv = []) {
  const state = {
    help: false,
    format: "text",
    windowHours: 24,
    watch: false,
    intervalMs: 5000,
    rest: []
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "-h" || arg === "--help") {
      state.help = true;
      continue;
    }
    if (arg === "--json" || arg === "--format=json") {
      state.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      state.format = "text";
      continue;
    }
    if (arg === "--watch") {
      state.watch = true;
      continue;
    }
    if (arg === "--window-hours") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --window-hours");
      }
      state.windowHours = Number(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--window-hours=")) {
      state.windowHours = Number(arg.slice("--window-hours=".length));
      continue;
    }
    if (arg === "--interval-ms") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --interval-ms");
      }
      state.intervalMs = Number(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--interval-ms=")) {
      state.intervalMs = Number(arg.slice("--interval-ms=".length));
      continue;
    }
    state.rest.push(arg);
  }

  if (!Number.isFinite(state.windowHours) || state.windowHours <= 0 || state.windowHours > 24 * 30) {
    throw new Error("Invalid --window-hours: expected 0 < hours <= 720");
  }
  if (!Number.isFinite(state.intervalMs) || state.intervalMs < 500 || state.intervalMs > 60_000) {
    throw new Error("Invalid --interval-ms: expected 500-60000");
  }

  return state;
}

async function handleMonitorCommand(argv) {
  const parsed = parseMonitorArgs(argv);
  const sub = parsed.rest[0] || "report";
  if (parsed.help) {
    printMonitorHelp();
    return;
  }

  if (sub === "metrics" || sub === "tuner") {
    throw new Error(
      `\`clawty monitor ${sub}\` has been removed from public CLI. Use: clawty monitor report`
    );
  }
  if (sub !== "report") {
    throw new Error(`Unknown monitor command: ${sub}. Use: clawty monitor [report]`);
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const workspaceRoot = config.workspaceRoot;
  const { buildReport } = await import("../scripts/metrics-report.mjs");
  const { buildTunerReport } = await import("../scripts/tuner-report.mjs");

  const buildOnce = async () => {
    const [metrics, tuner] = await Promise.all([
      buildReport({
        workspaceRoot,
        windowHours: parsed.windowHours,
        format: "json"
      }),
      buildTunerReport({
        workspaceRoot,
        windowHours: parsed.windowHours,
        format: "json"
      })
    ]);
    return {
      generated_at: new Date().toISOString(),
      workspace_root: workspaceRoot,
      window_hours: parsed.windowHours,
      metrics,
      tuner
    };
  };

  const render = (payload) => {
    if (parsed.format === "json") {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
  };

  if (!parsed.watch) {
    render(await buildOnce());
    return;
  }

  while (true) {
    render(await buildOnce());
    await new Promise((resolve) => setTimeout(resolve, parsed.intervalMs));
  }
}

async function handleMcpServerCommand(argv) {
  const { runMcpServer, parseMcpServerArgs, resolveMcpServerRuntimeOptions } = await import(
    "./mcp-server.js"
  );
  const args = parseMcpServerArgs(argv);
  if (args.help) {
    printMcpServerHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const runtimeOptions = resolveMcpServerRuntimeOptions(args, config);
  const mcpLogFilePath = path.isAbsolute(runtimeOptions.logPath)
    ? runtimeOptions.logPath
    : path.resolve(runtimeOptions.workspaceRoot, runtimeOptions.logPath);
  const logger = createRuntimeLogger(config, {
    component: "mcp-server",
    consoleStream: process.stderr,
    filePath: mcpLogFilePath,
    context: {
      entrypoint: "index"
    }
  });
  await runMcpServer({
    workspaceRoot: runtimeOptions.workspaceRoot,
    exposeLowLevel: runtimeOptions.exposeLowLevel,
    toolsets: runtimeOptions.toolsets,
    transport: runtimeOptions.transport,
    host: runtimeOptions.host,
    port: runtimeOptions.port,
    toolTimeoutMs: config.toolTimeoutMs,
    logger,
    lsp: config.lsp,
    embedding: config.embedding,
    metrics: config.metrics,
    onlineTuner: config.onlineTuner
  });
}

async function handleWatchIndexCommand(argv) {
  const { parseWatchCliArgs, runIndexWatchLoop } = await import("./index-watch.js");
  const watchArgs = parseWatchCliArgs(argv);
  if (watchArgs.help) {
    printWatchHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  shouldAttemptLspCleanup = true;
  const result = await runIndexWatchLoop(config.workspaceRoot, {
    ...watchArgs,
    embedding: config.embedding,
    metrics: config.metrics
  });

  if (!result?.ok) {
    throw new Error(result?.error || "watch-index failed");
  }
}

async function handleDoctorCommand(argv) {
  const { parseDoctorCliArgs, printDoctorHelp, formatDoctorReportText, runDoctor } = await import(
    "./doctor.js"
  );
  const doctorArgs = parseDoctorCliArgs(argv);
  if (doctorArgs.help) {
    printDoctorHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const report = await runDoctor(config);
  if (doctorArgs.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReportText(report));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function handleInitCommand(argv) {
  const { parseInitCliArgs, printInitHelp, formatInitReportText, runInit } = await import("./init.js");
  const initArgs = parseInitCliArgs(argv);
  if (initArgs.help) {
    printInitHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  shouldAttemptLspCleanup = true;
  const report = await runInit(config, initArgs);
  if (initArgs.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatInitReportText(report));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h" || first === "help") {
    printMainHelp();
    return;
  }

  if (first === "--version" || first === "-v" || first === "version") {
    console.log(await getPackageVersion());
    return;
  }

  if (first === "config") {
    await handleConfigCommand(args.slice(1));
    return;
  }

  if (first === "memory") {
    await handleMemoryCommand(args.slice(1));
    return;
  }

  if (first === "monitor") {
    await handleMonitorCommand(args.slice(1));
    return;
  }

  if (first === "watch-index") {
    await handleWatchIndexCommand(args.slice(1));
    return;
  }

  if (first === "doctor") {
    await handleDoctorCommand(args.slice(1));
    return;
  }

  if (first === "init") {
    await handleInitCommand(args.slice(1));
    return;
  }

  if (first === "completion" || first === "upgrade" || first === "uninstall") {
    throw new Error(`\`clawty ${first}\` has been removed from public CLI`);
    return;
  }

  if (first === "mcp-server") {
    await handleMcpServerCommand(args.slice(1));
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
      throw new Error('Missing task. Example: clawty run "fix tests"');
    }
    await runTask(config, {}, task);
    return;
  }

  if (first.startsWith("-")) {
    throw new Error(`Unknown option: ${first}`);
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
    if (shouldAttemptLspCleanup) {
      await import("./lsp-manager.js")
        .then(({ shutdownAllLspClients }) =>
          shutdownAllLspClients().catch(() => {
            // Ignore cleanup failures on process shutdown.
          })
        )
        .catch(() => {
          // Ignore lazy cleanup import failures.
        });
    }
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

bootstrap();
