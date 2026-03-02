import fs from "node:fs";
import path from "node:path";

function parseDotEnv(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadDotEnvIfExists(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, "utf8");
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readInt(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function loadConfig() {
  const cwd = process.cwd();
  loadDotEnvIfExists(cwd);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Create .env from .env.example or export OPENAI_API_KEY."
    );
  }

  const workspaceRoot = path.resolve(process.env.CLAWTY_WORKSPACE_ROOT || cwd);
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
    /\/$/,
    ""
  );

  return {
    apiKey,
    baseUrl,
    model: process.env.CLAWTY_MODEL || "gpt-4.1-mini",
    workspaceRoot,
    toolTimeoutMs: readInt("CLAWTY_TOOL_TIMEOUT_MS", 120_000),
    maxToolIterations: readInt("CLAWTY_MAX_TOOL_ITERATIONS", 8),
    lsp: {
      enabled: readBoolean("CLAWTY_LSP_ENABLED", true),
      timeoutMs: readInt("CLAWTY_LSP_TIMEOUT_MS", 5000),
      maxResults: readInt("CLAWTY_LSP_MAX_RESULTS", 100),
      tsCommand: process.env.CLAWTY_LSP_TS_CMD || "typescript-language-server --stdio"
    }
  };
}
