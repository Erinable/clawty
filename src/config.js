import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE_CANDIDATES = ["clawty.config.json", path.join(".clawty", "config.json")];

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

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return { values: {}, path: null };
  }
  const content = fs.readFileSync(envPath, "utf8");
  return {
    values: parseDotEnv(content),
    path: envPath
  };
}

function findConfigFile(rootDir) {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const absolutePath = path.join(rootDir, candidate);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const raw = fs.readFileSync(absolutePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in ${candidate}: ${error.message || String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid config in ${candidate}: root must be a JSON object`);
    }
    return {
      path: absolutePath,
      relativePath: candidate,
      data: parsed
    };
  }
  return {
    path: null,
    relativePath: null,
    data: {}
  };
}

function readInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function readFloat(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

function readBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readString(value, fallback) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function deepPick(object, pathList) {
  let current = object;
  for (const key of pathList) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function resolveWorkspaceRoot(rootDir, fileConfig, env) {
  const fromEnv = readString(env.CLAWTY_WORKSPACE_ROOT, null);
  if (fromEnv) {
    return path.resolve(rootDir, fromEnv);
  }
  const fromFile = readString(fileConfig.workspaceRoot, null);
  if (fromFile) {
    return path.resolve(rootDir, fromFile);
  }
  return rootDir;
}

export function loadConfig(options = {}) {
  const rootDir = path.resolve(options.cwd || process.cwd());
  const allowMissingApiKey = Boolean(options.allowMissingApiKey);
  const runtimeEnv = options.env && typeof options.env === "object" ? options.env : process.env;

  const dotEnv = loadDotEnv(rootDir);
  const fileConfig = findConfigFile(rootDir);
  const env = {
    ...dotEnv.values,
    ...runtimeEnv
  };

  const apiKey =
    readString(env.OPENAI_API_KEY, null) ||
    readString(deepPick(fileConfig.data, ["openai", "apiKey"]), null);
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Set env var, put it in .env, or set openai.apiKey in clawty.config.json."
    );
  }

  const baseUrl = readString(
    env.OPENAI_BASE_URL,
    readString(deepPick(fileConfig.data, ["openai", "baseUrl"]), "https://api.openai.com/v1")
  ).replace(/\/$/, "");

  const model = readString(env.CLAWTY_MODEL, readString(fileConfig.data.model, "gpt-4.1-mini"));

  const toolTimeoutMs = readInt(
    env.CLAWTY_TOOL_TIMEOUT_MS ?? deepPick(fileConfig.data, ["tools", "timeoutMs"]),
    120_000,
    1000,
    300_000
  );

  const maxToolIterations = readInt(
    env.CLAWTY_MAX_TOOL_ITERATIONS ?? deepPick(fileConfig.data, ["tools", "maxIterations"]),
    8,
    1,
    100
  );

  const lsp = {
    enabled: readBoolean(
      env.CLAWTY_LSP_ENABLED ?? deepPick(fileConfig.data, ["lsp", "enabled"]),
      true
    ),
    timeoutMs: readInt(
      env.CLAWTY_LSP_TIMEOUT_MS ?? deepPick(fileConfig.data, ["lsp", "timeoutMs"]),
      5000,
      1000,
      60_000
    ),
    maxResults: readInt(
      env.CLAWTY_LSP_MAX_RESULTS ?? deepPick(fileConfig.data, ["lsp", "maxResults"]),
      100,
      1,
      1000
    ),
    tsCommand: readString(
      env.CLAWTY_LSP_TS_CMD,
      readString(deepPick(fileConfig.data, ["lsp", "tsCommand"]), "typescript-language-server --stdio")
    )
  };

  const index = {
    maxFiles: readInt(
      env.CLAWTY_INDEX_MAX_FILES ?? deepPick(fileConfig.data, ["index", "maxFiles"]),
      3000,
      1,
      20_000
    ),
    maxFileSizeKb: readInt(
      env.CLAWTY_INDEX_MAX_FILE_SIZE_KB ?? deepPick(fileConfig.data, ["index", "maxFileSizeKb"]),
      512,
      1,
      8192
    )
  };

  const embeddingApiKey =
    readString(
      env.CLAWTY_EMBEDDING_API_KEY,
      readString(deepPick(fileConfig.data, ["embedding", "apiKey"]), null)
    ) || apiKey;

  const embedding = {
    enabled: readBoolean(
      env.CLAWTY_EMBEDDING_ENABLED ?? deepPick(fileConfig.data, ["embedding", "enabled"]),
      false
    ),
    apiKey: embeddingApiKey,
    baseUrl: readString(
      env.CLAWTY_EMBEDDING_BASE_URL,
      readString(deepPick(fileConfig.data, ["embedding", "baseUrl"]), baseUrl)
    ).replace(/\/$/, ""),
    model: readString(
      env.CLAWTY_EMBEDDING_MODEL,
      readString(deepPick(fileConfig.data, ["embedding", "model"]), "text-embedding-3-small")
    ),
    topK: readInt(
      env.CLAWTY_EMBEDDING_TOP_K ?? deepPick(fileConfig.data, ["embedding", "topK"]),
      15,
      1,
      200
    ),
    weight: readFloat(
      env.CLAWTY_EMBEDDING_WEIGHT ?? deepPick(fileConfig.data, ["embedding", "weight"]),
      0.25,
      0,
      1
    ),
    timeoutMs: readInt(
      env.CLAWTY_EMBEDDING_TIMEOUT_MS ?? deepPick(fileConfig.data, ["embedding", "timeoutMs"]),
      15_000,
      1000,
      120_000
    )
  };

  return {
    apiKey: apiKey || null,
    baseUrl,
    model,
    workspaceRoot: resolveWorkspaceRoot(rootDir, fileConfig.data, env),
    toolTimeoutMs,
    maxToolIterations,
    lsp,
    index,
    embedding,
    sources: {
      cwd: rootDir,
      configFile: fileConfig.path,
      dotEnvFile: dotEnv.path
    }
  };
}
