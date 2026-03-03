#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { loadConfig, resolveConfigSources } from "./config.js";
import { createRuntimeLogger } from "./logger.js";

const LOGO = "== clawty ==";
const STATUS = {
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  SKIP: "skip"
};

const STATUS_ICON = {
  [STATUS.PASS]: "✓",
  [STATUS.FAIL]: "✗",
  [STATUS.WARN]: "⚠",
  [STATUS.SKIP]: "○"
};

let shouldAttemptLspCleanup = false;
let agentTurnModulePromise = null;
let packageVersionPromise = null;

const ROOT_COMMANDS = [
  ["clawty completion [shell]", "generate shell completion script"],
  ["clawty config <command>", "manage configuration"],
  ["clawty memory <command>", "manage long-term memory"],
  ["clawty monitor [subcommand]", "show runtime metrics and tuner stats"],
  ["clawty run [message..]", "run clawty with a message"],
  ["clawty chat", "start interactive chat mode"],
  ["clawty init", "bootstrap repository analysis"],
  ["clawty doctor", "run diagnostics and health checks"],
  ["clawty watch-index", "auto refresh indexes on file changes"],
  ["clawty mcp-server", "start MCP stdio server for monitoring and code intelligence"],
  ["clawty upgrade [target]", "upgrade clawty via npm"],
  ["clawty uninstall", "uninstall clawty and cleanup files"]
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
        ["--max-files <n>", "max tracked files in snapshot"],
        ["--max-batch-size <n>", "max changed/deleted files per refresh batch"],
        ["--debounce-ms <n>", "delay before queue flush"],
        ["--build-on-start <bool>", "build indexes once before watch loop"],
        ["--no-build-on-start", "disable initial build"],
        ["--hash-skip-enabled <bool>", "skip unchanged files by content hash"],
        ["--hash-init-max-files <n>", "max files hashed during startup seed"],
        ["--no-hash-skip", "disable hash-skip optimization"],
        ["--include-syntax <bool>", "include syntax refresh"],
        ["--no-syntax", "disable syntax refresh"],
        ["--include-semantic <bool>", "include semantic refresh"],
        ["--no-semantic", "disable semantic refresh"],
        ["--include-vector <bool>", "include vector refresh"],
        ["--no-vector", "disable vector refresh"],
        ["--vector-layer <base|delta>", "target vector layer"],
        ["--semantic-include-definitions <bool>", "include definition edges in semantic refresh"],
        ["--semantic-include-references <bool>", "include reference edges in semantic refresh"],
        ["--quiet", "disable loop logs"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printConfigHelp() {
  console.log(
    renderHelp({
      commands: [
        ["clawty config show", "show effective config (redacted)"],
        ["clawty config path", "show resolved config file paths"],
        ["clawty config validate", "validate config files and report warnings"]
      ],
      options: [
        ["--json", "output JSON report for path/validate"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printCompletionHelp() {
  console.log(
    renderHelp({
      commands: [["clawty completion [shell]", "print shell completion script"]],
      positionals: [["shell", "target shell: bash | zsh | fish"]],
      options: [["-h, --help", "show help"]]
    })
  );
}

function printMemoryHelp() {
  console.log(
    renderHelp({
      commands: [
        ["clawty memory search <query>", "search memory lessons"],
        ["clawty memory stats", "show memory usage statistics"],
        ["clawty memory inspect <lessonId>", "inspect one memory lesson detail"],
        ["clawty memory feedback <lessonId>", "mark lesson as up/down vote"],
        ["clawty memory prune", "remove stale memory entries"],
        ["clawty memory reindex", "rebuild memory tags/fts metadata"]
      ],
      positionals: [
        ["query", "search text for memory recall"],
        ["lessonId", "lesson identifier from search results"]
      ],
      options: [
        ["--json", "output structured JSON"],
        ["--explain", "include score component breakdown (search command)"],
        ["--top-k <n>", "max returned lessons for search"],
        ["--scope <project|global|project+global>", "memory scope"],
        ["--vote <up|down>", "feedback vote (for feedback command)"],
        ["--reason <wrong|stale|unsafe|irrelevant|good>", "feedback reason (optional)"],
        ["--note <text>", "optional feedback note"],
        ["--days <n>", "retention days (for prune command)"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printMonitorHelp() {
  console.log(
    renderHelp({
      commands: [
        ["clawty monitor report", "combined metrics+tuner report (default)"],
        ["clawty monitor metrics", "metrics report only"],
        ["clawty monitor tuner", "tuner report only"]
      ],
      options: [
        ["--json", "output JSON"],
        ["--window-hours <n>", "time window in hours (default 24)"],
        ["--watch", "refresh report periodically"],
        ["--interval-ms <n>", "watch refresh interval (default 5000ms)"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printMcpServerHelp() {
  console.log(
    renderHelp({
      commands: [["clawty mcp-server", "start MCP stdio server"]],
      options: [
        ["--workspace <path>", "workspace root for MCP tools"],
        ["--toolset <name>", "facade toolset: analysis|edit-safe|ops|all (repeatable)"],
        ["--expose-low-level", "also expose raw index/LSP/monitor tools"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printUpgradeHelp() {
  console.log(
    renderHelp({
      commands: [["clawty upgrade [target]", "upgrade clawty via npm global install"]],
      positionals: [["target", "optional version/range, default latest"]],
      options: [
        ["--dry-run", "print upgrade command without running"],
        ["-h, --help", "show help"]
      ]
    })
  );
}

function printUninstallHelp() {
  console.log(
    renderHelp({
      commands: [["clawty uninstall", "uninstall clawty and remove related files"]],
      options: [
        ["--yes", "confirm uninstall and execute"],
        ["--keep-config", "keep ~/.clawty/config.json and related files"],
        ["--skip-npm", "skip npm uninstall -g clawty"],
        ["-h, --help", "show help"]
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

function summarizeChecks(checks) {
  const summary = {
    total: checks.length,
    pass: 0,
    fail: 0,
    warn: 0,
    skip: 0
  };

  for (const item of checks) {
    if (item.status === STATUS.PASS) {
      summary.pass += 1;
      continue;
    }
    if (item.status === STATUS.FAIL) {
      summary.fail += 1;
      continue;
    }
    if (item.status === STATUS.WARN) {
      summary.warn += 1;
      continue;
    }
    summary.skip += 1;
  }

  return summary;
}

function formatConfigValidateText(report) {
  const lines = ["Clawty Config Validate", ""];
  for (const check of report.checks) {
    const icon = STATUS_ICON[check.status] || check.status;
    lines.push(`${icon} ${check.title}: ${check.message}`);
  }
  lines.push("");
  lines.push(
    `${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.skip} skipped`
  );
  return lines.join("\n");
}

async function runConfigValidate(cwd = process.cwd(), env = process.env) {
  const startedAt = Date.now();
  const checks = [];

  let sourceInfo;
  try {
    sourceInfo = resolveConfigSources({ cwd, env });
  } catch (error) {
    checks.push({
      id: "config_parse",
      status: STATUS.FAIL,
      title: "Config parsing",
      message: error.message || String(error)
    });
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      checks,
      summary: summarizeChecks(checks)
    };
  }

  if (sourceInfo.globalConfig.path) {
    checks.push({
      id: "global_config",
      status: STATUS.PASS,
      title: "Global config",
      message: sourceInfo.globalConfig.path
    });
  } else {
    checks.push({
      id: "global_config",
      status: STATUS.SKIP,
      title: "Global config",
      message: "Not found"
    });
  }

  if (sourceInfo.projectConfig.path) {
    checks.push({
      id: "project_config",
      status: STATUS.PASS,
      title: "Project config",
      message: sourceInfo.projectConfig.path
    });
  } else {
    checks.push({
      id: "project_config",
      status: STATUS.SKIP,
      title: "Project config",
      message: "Not found"
    });
  }

  if (sourceInfo.projectConfig.isLegacyPath) {
    checks.push({
      id: "legacy_path",
      status: STATUS.WARN,
      title: "Legacy project config path",
      message: "clawty.config.json is deprecated; move to .clawty/config.json"
    });
  } else {
    checks.push({
      id: "legacy_path",
      status: STATUS.PASS,
      title: "Legacy project config path",
      message: "Not used"
    });
  }

  let config;
  try {
    config = loadConfig({
      cwd,
      env,
      allowMissingApiKey: true,
      homeDir: sourceInfo.homeDir
    });
    checks.push({
      id: "effective_config",
      status: STATUS.PASS,
      title: "Effective config",
      message: "Resolved successfully"
    });
  } catch (error) {
    checks.push({
      id: "effective_config",
      status: STATUS.FAIL,
      title: "Effective config",
      message: error.message || String(error)
    });
  }

  if (config?.apiKey) {
    checks.push({
      id: "api_key",
      status: STATUS.PASS,
      title: "OpenAI API key",
      message: "Configured"
    });
  } else {
    checks.push({
      id: "api_key",
      status: STATUS.WARN,
      title: "OpenAI API key",
      message: "Missing OPENAI_API_KEY"
    });
  }

  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    generated_at: new Date().toISOString(),
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    checks,
    summary,
    sources: {
      cwd: sourceInfo.cwd,
      home_dir: sourceInfo.homeDir,
      global_config: sourceInfo.globalConfig.path,
      project_config: sourceInfo.projectConfig.path,
      dot_env: sourceInfo.dotEnv.path
    }
  };
}

function mapShellFromEnv(value) {
  const shell = String(value || "").toLowerCase();
  if (shell.includes("zsh")) {
    return "zsh";
  }
  if (shell.includes("fish")) {
    return "fish";
  }
  return "bash";
}

function generateBashCompletion(binary = "clawty") {
  return [
    `_${binary}_completion() {`,
    "  local cur prev",
    "  COMPREPLY=()",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
    "  local cmds=\"chat run init doctor watch-index config memory monitor mcp-server completion upgrade uninstall help\"",
    "  local config_sub=\"show path validate\"",
    "  local memory_sub=\"search stats inspect feedback prune reindex\"",
    "  case \"$prev\" in",
    "    config)",
    "      COMPREPLY=( $(compgen -W \"$config_sub\" -- \"$cur\") )",
    "      return 0",
    "      ;;",
    "    memory)",
    "      COMPREPLY=( $(compgen -W \"$memory_sub\" -- \"$cur\") )",
    "      return 0",
    "      ;;",
    "    completion)",
    "      COMPREPLY=( $(compgen -W \"bash zsh fish\" -- \"$cur\") )",
    "      return 0",
    "      ;;",
    "  esac",
    "  COMPREPLY=( $(compgen -W \"$cmds\" -- \"$cur\") )",
    "  return 0",
    "}",
    `complete -F _${binary}_completion ${binary}`,
    ""
  ].join("\n");
}

function generateZshCompletion(binary = "clawty") {
  return [
    `#compdef ${binary}`,
    "",
    "local -a commands",
    "commands=(",
    "  'chat:start interactive chat mode'",
    "  'run:run clawty with a message'",
    "  'init:bootstrap repository analysis'",
    "  'doctor:run diagnostics and health checks'",
    "  'watch-index:auto refresh indexes on file changes'",
    "  'config:manage configuration'",
    "  'memory:manage long-term memory'",
    "  'monitor:show runtime metrics and tuner stats'",
    "  'mcp-server:start MCP stdio server for monitoring and code intelligence'",
    "  'completion:generate shell completion script'",
    "  'upgrade:upgrade clawty via npm'",
    "  'uninstall:uninstall clawty and cleanup files'",
    ")",
    "_describe 'command' commands",
    ""
  ].join("\n");
}

function generateFishCompletion(binary = "clawty") {
  return [
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a chat -d \"start interactive chat mode\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a run -d \"run clawty with a message\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a init -d \"bootstrap repository analysis\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a doctor -d \"run diagnostics and health checks\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a watch-index -d \"auto refresh indexes on file changes\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a config -d \"manage configuration\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a memory -d \"manage long-term memory\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a monitor -d \"show runtime metrics and tuner stats\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a mcp-server -d \"start MCP stdio server for monitoring and code intelligence\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a completion -d \"generate shell completion script\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a upgrade -d \"upgrade clawty via npm\"`,
    `complete -c ${binary} -f -n \"__fish_use_subcommand\" -a uninstall -d \"uninstall clawty and cleanup files\"`,
    ""
  ].join("\n");
}

function generateCompletionScript(shell, binary = "clawty") {
  if (shell === "zsh") {
    return generateZshCompletion(binary);
  }
  if (shell === "fish") {
    return generateFishCompletion(binary);
  }
  return generateBashCompletion(binary);
}

function spawnInherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
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

  if (sub === "path") {
    const sources = resolveConfigSources();
    const payload = {
      cwd: sources.cwd,
      home_dir: sources.homeDir,
      project_config_path: sources.projectConfig.path,
      global_config_path: sources.globalConfig.path,
      active_config_path: sources.projectConfig.path || sources.globalConfig.path || null,
      dot_env_path: sources.dotEnv.path,
      warnings: sources.warnings
    };

    if (parsed.format === "json") {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(
      renderHelp({
        commands: [
          ["cwd", payload.cwd],
          ["home_dir", payload.home_dir],
          ["project_config", payload.project_config_path || "(none)"],
          ["global_config", payload.global_config_path || "(none)"],
          ["active_config", payload.active_config_path || "(none)"],
          ["dot_env", payload.dot_env_path || "(none)"]
        ]
      })
    );
    return;
  }

  if (sub === "validate") {
    const report = await runConfigValidate();
    if (parsed.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatConfigValidateText(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown config command: ${sub}. Use: clawty config <show|path|validate>`);
}

function parseMemoryArgs(argv = []) {
  const state = {
    help: false,
    format: "text",
    topK: null,
    scope: null,
    vote: null,
    reason: null,
    note: null,
    days: null,
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
    if (arg === "--vote") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --vote");
      }
      state.vote = String(raw).trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--vote=")) {
      state.vote = String(arg.slice("--vote=".length)).trim();
      continue;
    }
    if (arg === "--reason") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --reason");
      }
      state.reason = String(raw).trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--reason=")) {
      state.reason = String(arg.slice("--reason=".length)).trim();
      continue;
    }
    if (arg === "--note") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --note");
      }
      state.note = String(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--note=")) {
      state.note = String(arg.slice("--note=".length));
      continue;
    }
    if (arg === "--days") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --days");
      }
      state.days = Number(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--days=")) {
      state.days = Number(arg.slice("--days=".length));
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
    getMemoryStats,
    inspectMemoryLesson,
    reindexMemory,
    recordFeedback,
    pruneMemory
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

  if (sub === "inspect") {
    const lessonId = Number(parsed.rest[1]);
    if (!Number.isFinite(lessonId) || lessonId <= 0) {
      throw new Error("Missing lesson id. Example: clawty memory inspect 12");
    }
    const result = await inspectMemoryLesson(config.workspaceRoot, lessonId, memoryOptions);
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "feedback") {
    const lessonId = Number(parsed.rest[1]);
    if (!Number.isFinite(lessonId) || lessonId <= 0) {
      throw new Error("Missing lesson id. Example: clawty memory feedback 12 --vote up");
    }
    if (!parsed.vote) {
      throw new Error("Missing --vote <up|down>");
    }
    const result = await recordFeedback(
      config.workspaceRoot,
      lessonId,
      parsed.vote,
      parsed.note,
      parsed.reason,
      memoryOptions
    );
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "prune") {
    const result = await pruneMemory(config.workspaceRoot, {
      ...memoryOptions,
      days: parsed.days
    });
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "reindex") {
    const result = await reindexMemory(config.workspaceRoot, memoryOptions);
    if (parsed.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(
    `Unknown memory command: ${sub}. Use: clawty memory <search|stats|inspect|feedback|prune|reindex>`
  );
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

  if (!["report", "metrics", "tuner"].includes(sub)) {
    throw new Error(`Unknown monitor command: ${sub}. Use: clawty monitor <report|metrics|tuner>`);
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const workspaceRoot = config.workspaceRoot;
  const { buildReport } = await import("../scripts/metrics-report.mjs");
  const { buildTunerReport } = await import("../scripts/tuner-report.mjs");

  const buildOnce = async () => {
    if (sub === "metrics") {
      return buildReport({
        workspaceRoot,
        windowHours: parsed.windowHours,
        format: "json"
      });
    }
    if (sub === "tuner") {
      return buildTunerReport({
        workspaceRoot,
        windowHours: parsed.windowHours,
        format: "json"
      });
    }
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
  if (argv.includes("-h") || argv.includes("--help")) {
    printMcpServerHelp();
    return;
  }

  const { runMcpServer } = await import("./mcp-server.js");
  let workspaceRoot = null;
  let exposeLowLevel = false;
  const toolsets = [];
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--workspace") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --workspace");
      }
      workspaceRoot = path.resolve(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      workspaceRoot = path.resolve(arg.slice("--workspace=".length));
      continue;
    }
    if (arg === "--expose-low-level") {
      exposeLowLevel = true;
      continue;
    }
    if (arg === "--toolset") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --toolset");
      }
      toolsets.push(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--toolset=")) {
      toolsets.push(arg.slice("--toolset=".length));
      continue;
    }
    throw new Error(`Unknown mcp-server argument: ${arg}`);
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const logger = createRuntimeLogger(config, {
    component: "mcp-server",
    consoleStream: process.stderr,
    context: {
      entrypoint: "index"
    }
  });
  await runMcpServer({
    workspaceRoot: workspaceRoot || config.workspaceRoot,
    exposeLowLevel,
    toolsets,
    toolTimeoutMs: config.toolTimeoutMs,
    logger,
    lsp: config.lsp,
    embedding: config.embedding,
    metrics: config.metrics,
    onlineTuner: config.onlineTuner
  });
}

async function handleCompletionCommand(argv) {
  const args = argv.slice();
  if (args.includes("-h") || args.includes("--help")) {
    printCompletionHelp();
    return;
  }

  const shell = args.find((item) => !item.startsWith("-")) || mapShellFromEnv(process.env.SHELL);
  if (!["bash", "zsh", "fish"].includes(shell)) {
    throw new Error(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish`);
  }

  console.log(generateCompletionScript(shell, "clawty"));
}

async function handleUpgradeCommand(argv) {
  const args = argv.slice();
  if (args.includes("-h") || args.includes("--help")) {
    printUpgradeHelp();
    return;
  }

  const dryRun = args.includes("--dry-run");
  const target = args.find((item) => !item.startsWith("-")) || "latest";
  const npmArgs = ["install", "-g", `clawty@${target}`];

  if (dryRun) {
    console.log(`npm ${npmArgs.join(" ")}`);
    return;
  }

  await spawnInherit("npm", npmArgs);
  console.log(`Upgraded clawty to ${target}`);
}

function parseUninstallArgs(argv = []) {
  const options = {
    help: false,
    yes: false,
    keepConfig: false,
    skipNpm: false
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg === "--keep-config") {
      options.keepConfig = true;
      continue;
    }
    if (arg === "--skip-npm") {
      options.skipNpm = true;
      continue;
    }
    throw new Error(`Unknown uninstall argument: ${arg}`);
  }

  return options;
}

function resolveHomeDirForUninstall(runtimeEnv = process.env) {
  const fromEnv =
    (typeof runtimeEnv.HOME === "string" && runtimeEnv.HOME.trim()) ||
    (typeof runtimeEnv.USERPROFILE === "string" && runtimeEnv.USERPROFILE.trim()) ||
    null;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(os.homedir());
}

async function handleUninstallCommand(argv) {
  const options = parseUninstallArgs(argv);
  if (options.help) {
    printUninstallHelp();
    return;
  }

  if (!options.yes) {
    throw new Error("Uninstall requires explicit confirmation: pass --yes");
  }

  const homeDir = resolveHomeDirForUninstall();
  const clawtyHome = path.join(homeDir, ".clawty");
  const clawtyBinDir = path.join(clawtyHome, "bin");

  if (!options.skipNpm) {
    try {
      await spawnInherit("npm", ["uninstall", "-g", "clawty"]);
    } catch (error) {
      console.error(`npm uninstall warning: ${error.message || String(error)}`);
    }
  }

  await fs.rm(clawtyBinDir, { recursive: true, force: true });
  if (!options.keepConfig) {
    await fs.rm(clawtyHome, { recursive: true, force: true });
  }

  console.log("clawty uninstalled");
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

  if (first === "completion") {
    await handleCompletionCommand(args.slice(1));
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

  if (first === "upgrade") {
    await handleUpgradeCommand(args.slice(1));
    return;
  }

  if (first === "uninstall") {
    await handleUninstallCommand(args.slice(1));
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
