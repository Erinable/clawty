import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { resolveMemoryDbPath } from "./memory.js";

const execFileAsync = promisify(execFile);
const SECTION_SEPARATOR = "────────────────────────────────────────";

const STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  SKIP: "skip"
});

const STATUS_ICON = Object.freeze({
  [STATUS.PASS]: "✓",
  [STATUS.FAIL]: "✗",
  [STATUS.WARN]: "⚠",
  [STATUS.SKIP]: "○"
});

const SECTION_ORDER = [
  "Installation",
  "Configuration",
  "Authentication",
  "Dependencies",
  "Tools & Servers",
  "Updates"
];

function result(status, message, hint = null, details = null) {
  return {
    status,
    message,
    hint: hint || null,
    details: details || null
  };
}

function firstCommandToken(command) {
  if (typeof command !== "string") {
    return null;
  }
  const input = command.trim();
  if (!input) {
    return null;
  }
  const firstChar = input[0];
  if (firstChar === '"' || firstChar === "'") {
    const end = input.indexOf(firstChar, 1);
    if (end > 1) {
      return input.slice(1, end);
    }
  }
  return input.split(/\s+/)[0] || null;
}

async function isCommandAvailable(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        resolve(false);
        return;
      }
      resolve(true);
    });
    child.on("close", () => {
      resolve(true);
    });
  });
}

async function readCommandStdout(command, args = [], options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: options.timeout || 5000,
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      stdout: String(stdout || "").trim()
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      code: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim()
    };
  }
}

async function loadPackageVersion() {
  const candidateDirs = [];
  candidateDirs.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

  if (typeof process.argv?.[1] === "string" && process.argv[1].trim()) {
    const scriptDir = path.dirname(path.resolve(process.argv[1]));
    candidateDirs.push(path.resolve(scriptDir, ".."));
    candidateDirs.push(scriptDir);
  }

  const visited = new Set();
  for (const dir of candidateDirs) {
    const normalized = path.resolve(dir);
    if (visited.has(normalized)) {
      continue;
    }
    visited.add(normalized);

    try {
      const raw = await fs.readFile(path.join(normalized, "package.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed?.name === "clawty" &&
        typeof parsed?.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version.trim();
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

async function runNodeVersionCheck() {
  const major = Number(String(process.versions.node || "").split(".")[0] || 0);
  if (Number.isFinite(major) && major >= 22) {
    return result(STATUS.PASS, `Node.js ${process.version}`);
  }
  return result(
    STATUS.FAIL,
    `Node.js ${process.version} (requires >= 22)`,
    "Upgrade Node.js to v22 or newer."
  );
}

async function runClawtyInstallCheck(context) {
  const version = context.packageVersion;
  if (!version) {
    return result(
      STATUS.WARN,
      "Unable to resolve package version",
      "Verify package.json exists and is valid JSON."
    );
  }
  return result(STATUS.PASS, `Version ${version}`);
}

async function runConfigSourceCheck(context) {
  const configFile = context.config?.sources?.configFile || null;
  const dotEnvFile = context.config?.sources?.dotEnvFile || null;
  if (configFile || dotEnvFile) {
    return result(
      STATUS.PASS,
      `config=${configFile ? path.basename(configFile) : "none"}, env=${dotEnvFile ? ".env" : "none"}`
    );
  }
  return result(
    STATUS.WARN,
    "No config file or .env detected",
    "Create .env or clawty.config.json for stable local setup."
  );
}

async function runWorkspaceAccessCheck(context) {
  const workspaceRoot = path.resolve(context.config.workspaceRoot);
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) {
      return result(
        STATUS.FAIL,
        `Not a directory: ${workspaceRoot}`,
        "Set CLAWTY_WORKSPACE_ROOT to a valid directory."
      );
    }
  } catch (error) {
    return result(
      STATUS.FAIL,
      `Not accessible: ${workspaceRoot} (${error.message || String(error)})`,
      "Fix CLAWTY_WORKSPACE_ROOT or run from an existing workspace."
    );
  }
  return result(STATUS.PASS, workspaceRoot);
}

async function runWorkspaceWritableCheck(context) {
  const workspaceRoot = path.resolve(context.config.workspaceRoot);
  const clawtyDir = path.join(workspaceRoot, ".clawty");
  const probePath = path.join(clawtyDir, `.doctor-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.mkdir(clawtyDir, { recursive: true });
    await fs.writeFile(probePath, "ok", "utf8");
    await fs.rm(probePath, { force: true });
    return result(STATUS.PASS, `Writable (${clawtyDir})`);
  } catch (error) {
    return result(
      STATUS.FAIL,
      `Write probe failed (${error.message || String(error)})`,
      "Ensure the workspace is writable by the current user."
    );
  }
}

async function runModelResolutionCheck(context) {
  const model = context?.config?.model;
  if (typeof model === "string" && model.trim().length > 0) {
    return result(STATUS.PASS, model.trim());
  }
  return result(
    STATUS.WARN,
    "Model is empty; fallback may be used",
    "Set CLAWTY_MODEL or model in clawty.config.json."
  );
}

async function runOpenAiAuthCheck(context) {
  const key = typeof context?.config?.apiKey === "string" ? context.config.apiKey.trim() : "";
  if (key) {
    return result(STATUS.PASS, "Configured");
  }
  return result(
    STATUS.FAIL,
    "Missing API key",
    "Set OPENAI_API_KEY in .env or environment variables."
  );
}

async function runEmbeddingAuthCheck(context) {
  const enabled = context?.config?.embedding?.enabled === true;
  if (!enabled) {
    return result(STATUS.SKIP, "Embedding disabled by config");
  }
  const key =
    typeof context?.config?.embedding?.apiKey === "string"
      ? context.config.embedding.apiKey.trim()
      : "";
  if (key) {
    return result(STATUS.PASS, "Configured");
  }
  return result(
    STATUS.WARN,
    "Embedding enabled but key missing",
    "Set CLAWTY_EMBEDDING_API_KEY or OPENAI_API_KEY."
  );
}

async function runTreeSitterCheck() {
  try {
    await import("tree-sitter");
    await import("tree-sitter-javascript");
    await import("tree-sitter-python");
    await import("tree-sitter-go");
    return result(STATUS.PASS, "Runtime and grammars available");
  } catch (error) {
    return result(
      STATUS.WARN,
      `Unavailable (${error.message || String(error)})`,
      "Install tree-sitter dependencies or use parser_provider=auto."
    );
  }
}

async function runGitCliCheck() {
  const available = await isCommandAvailable("git");
  if (!available) {
    return result(
      STATUS.WARN,
      "git not found",
      "Install git to enable incremental git-diff context."
    );
  }
  const versionRes = await readCommandStdout("git", ["--version"]);
  if (versionRes.ok) {
    return result(STATUS.PASS, versionRes.stdout || "git available");
  }
  return result(STATUS.PASS, "git available");
}

async function runGitRepositoryCheck(context) {
  const workspaceRoot = path.resolve(context.config.workspaceRoot);
  const available = await isCommandAvailable("git");
  if (!available) {
    return result(STATUS.SKIP, "git not installed");
  }
  const insideRes = await readCommandStdout(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: workspaceRoot, timeout: 5000 }
  );
  if (insideRes.ok && insideRes.stdout.toLowerCase().startsWith("true")) {
    return result(STATUS.PASS, "Workspace is inside a git repository");
  }
  return result(
    STATUS.WARN,
    "Workspace is not a git repository",
    "Run `git init` (or use an existing repo) to enable incremental context."
  );
}

async function runLspCommandCheck(context) {
  const enabled = context?.config?.lsp?.enabled !== false;
  if (!enabled) {
    return result(STATUS.SKIP, "LSP disabled by config");
  }
  const tsCommand =
    typeof context?.config?.lsp?.tsCommand === "string" ? context.config.lsp.tsCommand : "";
  const binary = firstCommandToken(tsCommand);
  if (!binary) {
    return result(
      STATUS.WARN,
      "LSP command is empty",
      "Set CLAWTY_LSP_TS_CMD (for example: typescript-language-server --stdio)."
    );
  }
  const available = await isCommandAvailable(binary);
  if (!available) {
    return result(
      STATUS.WARN,
      `Command not found: ${binary}`,
      "Install TypeScript LSP or adjust CLAWTY_LSP_TS_CMD."
    );
  }
  return result(STATUS.PASS, `${binary} detected`);
}

async function runGitHubCliCheck() {
  const available = await isCommandAvailable("gh", ["--version"]);
  if (!available) {
    return result(STATUS.SKIP, "GitHub CLI not installed");
  }

  const versionRes = await readCommandStdout("gh", ["--version"]);
  const versionText = versionRes.ok
    ? (versionRes.stdout.split("\n")[0] || "gh available")
    : "gh available";
  const authRes = await readCommandStdout("gh", ["auth", "status", "-h", "github.com"]);
  if (authRes.ok) {
    return result(STATUS.PASS, `${versionText} - authenticated`);
  }
  return result(STATUS.WARN, `${versionText} - not authenticated`, "Run `gh auth login` if needed.");
}

async function runIndexDbCheck(context) {
  const workspaceRoot = path.resolve(context.config.workspaceRoot);
  const indexDbPath = path.join(workspaceRoot, ".clawty", "index.db");
  try {
    const stat = await fs.stat(indexDbPath);
    if (stat.size > 0) {
      return result(STATUS.PASS, `Found (${stat.size} bytes)`);
    }
  } catch {
    // Fall through.
  }
  return result(
    STATUS.WARN,
    "Not found",
    "Run `build_code_index` (or `watch-index`) before deep retrieval tasks."
  );
}

function resolveDoctorMemoryPath(context) {
  return resolveMemoryDbPath({
    homeDir: context?.config?.sources?.homeDir
  });
}

async function runMemoryDbCheck(context) {
  if (context?.config?.memory?.enabled !== true) {
    return result(STATUS.SKIP, "Disabled");
  }

  const dbPath = resolveDoctorMemoryPath(context);
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("SELECT 1;");
    db.close();
    return result(STATUS.PASS, `Ready (${dbPath})`);
  } catch (error) {
    return result(
      STATUS.FAIL,
      `Unavailable: ${error.message || String(error)}`,
      "Check filesystem permissions for ~/.clawty."
    );
  }
}

async function runMemorySchemaCheck(context) {
  if (context?.config?.memory?.enabled !== true) {
    return result(STATUS.SKIP, "Disabled");
  }

  const dbPath = resolveDoctorMemoryPath(context);
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const schemaRow = db
      .prepare("SELECT value FROM memory_meta WHERE key = 'schema_version' LIMIT 1")
      .get();
    const schemaVersion = Number(schemaRow?.value || 0);
    const lessonColumns = db
      .prepare("SELECT name FROM pragma_table_info('memory_lessons')")
      .all()
      .map((row) => String(row.name || ""));
    const feedbackColumns = db
      .prepare("SELECT name FROM pragma_table_info('memory_feedback')")
      .all()
      .map((row) => String(row.name || ""));
    const hasRequiredLessonColumns = ["quality_score", "quarantined"].every((name) =>
      lessonColumns.includes(name)
    );
    const hasReasonColumn = feedbackColumns.includes("reason");

    if (schemaVersion >= 2 && hasRequiredLessonColumns && hasReasonColumn) {
      return result(STATUS.PASS, `schema_version=${schemaVersion}`);
    }
    return result(
      STATUS.WARN,
      `schema_version=${schemaVersion || 0}`,
      "Run a memory command once to trigger automatic migration."
    );
  } catch (error) {
    return result(
      STATUS.WARN,
      `Schema check skipped: ${error.message || String(error)}`,
      "Run `clawty memory stats --json` to initialize memory metadata."
    );
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function runMemoryRecentWriteCheck(context) {
  if (context?.config?.memory?.enabled !== true) {
    return result(STATUS.SKIP, "Disabled");
  }

  const dbPath = resolveDoctorMemoryPath(context);
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const threshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lessonCount = db
      .prepare("SELECT COUNT(*) AS count FROM memory_lessons WHERE created_at >= ?")
      .get(threshold);
    const episodeCount = db
      .prepare("SELECT COUNT(*) AS count FROM memory_episodes WHERE created_at >= ?")
      .get(threshold);
    const lessons = Number(lessonCount?.count || 0);
    const episodes = Number(episodeCount?.count || 0);
    if (lessons === 0 && episodes === 0) {
      return result(
        STATUS.WARN,
        "No writes in last 7 days",
        "Use chat/run and `clawty memory feedback` to build memory signal."
      );
    }
    return result(STATUS.PASS, `7d lessons=${lessons}, episodes=${episodes}`);
  } catch (error) {
    return result(
      STATUS.WARN,
      `Recent-write check skipped: ${error.message || String(error)}`,
      "Memory DB may not be initialized yet."
    );
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function runVersionUpdateCheck() {
  return result(STATUS.SKIP, "Update check not configured");
}

const CHECK_DEFINITIONS = [
  {
    id: "node_runtime",
    section: "Installation",
    title: "Node.js Runtime",
    run: runNodeVersionCheck
  },
  {
    id: "clawty_installation",
    section: "Installation",
    title: "Clawty Installation",
    run: runClawtyInstallCheck
  },
  {
    id: "configuration_sources",
    section: "Configuration",
    title: "Configuration Sources",
    run: runConfigSourceCheck
  },
  {
    id: "workspace_access",
    section: "Configuration",
    title: "Workspace Access",
    run: runWorkspaceAccessCheck
  },
  {
    id: "workspace_writable",
    section: "Configuration",
    title: "Workspace Write Access",
    run: runWorkspaceWritableCheck
  },
  {
    id: "model_resolution",
    section: "Configuration",
    title: "Model Resolution",
    run: runModelResolutionCheck
  },
  {
    id: "memory_db",
    section: "Configuration",
    title: "Memory DB",
    run: runMemoryDbCheck
  },
  {
    id: "memory_schema",
    section: "Configuration",
    title: "Memory Schema",
    run: runMemorySchemaCheck
  },
  {
    id: "memory_recent_write",
    section: "Configuration",
    title: "Memory Recent Write",
    run: runMemoryRecentWriteCheck
  },
  {
    id: "openai_auth",
    section: "Authentication",
    title: "OpenAI Auth",
    run: runOpenAiAuthCheck
  },
  {
    id: "embedding_auth",
    section: "Authentication",
    title: "Embedding Auth",
    run: runEmbeddingAuthCheck
  },
  {
    id: "tree_sitter_runtime",
    section: "Dependencies",
    title: "tree-sitter Runtime",
    run: runTreeSitterCheck
  },
  {
    id: "git_cli",
    section: "Tools & Servers",
    title: "Git CLI",
    run: runGitCliCheck
  },
  {
    id: "git_repository",
    section: "Tools & Servers",
    title: "Git Repository",
    run: runGitRepositoryCheck
  },
  {
    id: "lsp_command",
    section: "Tools & Servers",
    title: "TypeScript LSP",
    run: runLspCommandCheck
  },
  {
    id: "github_cli",
    section: "Tools & Servers",
    title: "GitHub CLI",
    run: runGitHubCliCheck
  },
  {
    id: "index_database",
    section: "Tools & Servers",
    title: "Index Database",
    run: runIndexDbCheck
  },
  {
    id: "version_status",
    section: "Updates",
    title: "Version Status",
    run: runVersionUpdateCheck
  }
];

function summarizeChecks(checks) {
  const summary = {
    total: checks.length,
    pass: 0,
    fail: 0,
    warn: 0,
    skip: 0
  };
  for (const check of checks) {
    if (check.status === STATUS.PASS) {
      summary.pass += 1;
      continue;
    }
    if (check.status === STATUS.FAIL) {
      summary.fail += 1;
      continue;
    }
    if (check.status === STATUS.WARN) {
      summary.warn += 1;
      continue;
    }
    summary.skip += 1;
  }
  return summary;
}

function groupChecksBySection(checks) {
  const map = new Map();
  for (const section of SECTION_ORDER) {
    map.set(section, []);
  }
  for (const check of checks) {
    if (!map.has(check.section)) {
      map.set(check.section, []);
    }
    map.get(check.section).push(check);
  }
  return Array.from(map.entries()).map(([section, items]) => ({
    section,
    checks: items
  }));
}

async function executeCheck(definition, context) {
  const startedAt = Date.now();
  try {
    const outcome = await definition.run(context);
    return {
      id: definition.id,
      section: definition.section,
      title: definition.title,
      status: outcome.status,
      message: outcome.message,
      hint: outcome.hint || null,
      details: outcome.details || null,
      elapsed_ms: Math.max(0, Date.now() - startedAt)
    };
  } catch (error) {
    return {
      id: definition.id,
      section: definition.section,
      title: definition.title,
      status: STATUS.FAIL,
      message: error.message || String(error),
      hint: "Doctor check crashed; inspect stack trace or rerun with debug logs.",
      details: null,
      elapsed_ms: Math.max(0, Date.now() - startedAt)
    };
  }
}

export function parseDoctorCliArgs(argv = []) {
  const options = {
    format: "text",
    help: false
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      options.format = "text";
      continue;
    }
    throw new Error(
      `Unknown doctor argument: ${arg}. Use: node src/index.js doctor [--json]`
    );
  }
  return options;
}

export function printDoctorHelp() {
  console.log(
    [
      "doctor: run local diagnostics for config, tools, and workspace health",
      "",
      "Usage:",
      "  node src/index.js doctor",
      "  node src/index.js doctor --json",
      "",
      "Options:",
      "  --json           Output structured JSON report",
      "  -h, --help       Show this help"
    ].join("\n")
  );
}

function renderSummaryConclusion(summary) {
  if (summary.fail > 0) {
    return "✗ Doctor found failing checks.";
  }
  if (summary.warn > 0) {
    return "⚠ All systems operational with warnings.";
  }
  return "✓ All systems operational.";
}

export function formatDoctorReportText(report) {
  const lines = [];
  lines.push(" Clawty... Doctor");
  lines.push("");

  for (const block of report.sections) {
    if (!block.checks || block.checks.length === 0) {
      continue;
    }
    lines.push(block.section);
    lines.push(SECTION_SEPARATOR);
    for (const check of block.checks) {
      const icon = STATUS_ICON[check.status] || check.status;
      lines.push(`  ${icon} ${check.title} → ${check.message}`);
      if (check.hint && check.status !== STATUS.PASS) {
        lines.push(`    hint: ${check.hint}`);
      }
    }
    lines.push("");
  }

  lines.push("Summary");
  lines.push(SECTION_SEPARATOR);
  lines.push(
    `  ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.skip} skipped`
  );
  lines.push(`  Total: ${report.summary.total} checks in ${report.elapsed_ms}ms`);
  lines.push("");
  lines.push(renderSummaryConclusion(report.summary));
  return lines.join("\n");
}

export async function runDoctor(config) {
  const startedAt = Date.now();
  const context = {
    config,
    packageVersion: await loadPackageVersion()
  };
  const checks = [];
  for (const definition of CHECK_DEFINITIONS) {
    checks.push(await executeCheck(definition, context));
  }

  const summary = summarizeChecks(checks);
  const report = {
    ok: summary.fail === 0,
    generated_at: new Date().toISOString(),
    workspace_root: path.resolve(config.workspaceRoot),
    model: config.model,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    summary,
    checks,
    sections: groupChecksBySection(checks)
  };
  return report;
}
