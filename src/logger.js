import fs from "node:fs";
import path from "node:path";

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100
};

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /token/i,
  /secret/i,
  /password/i
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLevel(value, fallback = "info") {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, raw)) {
    return raw;
  }
  return fallback;
}

function levelEnabled(currentLevel, entryLevel) {
  const currentWeight = LEVEL_WEIGHT[normalizeLevel(currentLevel, "info")] ?? LEVEL_WEIGHT.info;
  const entryWeight = LEVEL_WEIGHT[normalizeLevel(entryLevel, "info")] ?? LEVEL_WEIGHT.info;
  return entryWeight >= currentWeight;
}

function shouldRedactKey(key) {
  if (typeof key !== "string" || !key) {
    return false;
  }
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function sanitizeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || null
  };
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, current) => {
      if (shouldRedactKey(key)) {
        return "[REDACTED]";
      }
      if (current instanceof Error) {
        return sanitizeError(current);
      }
      if (typeof current === "bigint") {
        return Number(current);
      }
      if (typeof current === "function") {
        return `[Function:${current.name || "anonymous"}]`;
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }
      return current;
    });
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      component: "logger",
      event: "serialize_failed"
    });
  }
}

function ensureParentDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function normalizeConsoleStream(stream) {
  if (stream && typeof stream.write === "function") {
    return stream;
  }
  return process.stderr;
}

export function createLogger(options = {}) {
  const enabled = options.enabled !== false;
  const level = normalizeLevel(options.level, "info");
  const component = typeof options.component === "string" && options.component.trim()
    ? options.component.trim()
    : "app";
  const context = isPlainObject(options.context) ? { ...options.context } : {};
  const consoleEnabled = enabled && options.console !== false;
  const consoleStream = normalizeConsoleStream(options.consoleStream);
  const fileEnabled = enabled && options.file === true;
  const filePath =
    fileEnabled && typeof options.filePath === "string" && options.filePath.trim()
      ? path.resolve(options.filePath.trim())
      : null;

  let fileReady = false;

  function writeEntry(levelValue, event, fields = {}) {
    if (!enabled || normalizeLevel(levelValue, "info") === "off") {
      return;
    }
    if (!levelEnabled(level, levelValue)) {
      return;
    }

    const payload = isPlainObject(fields) ? fields : { value: fields };
    const entry = {
      ts: new Date().toISOString(),
      level: normalizeLevel(levelValue, "info"),
      component,
      event: typeof event === "string" && event.trim() ? event.trim() : "event",
      ...context,
      ...payload
    };
    const line = safeJsonStringify(entry);

    if (consoleEnabled) {
      try {
        consoleStream.write(`${line}\n`);
      } catch {
        // Console sink is best-effort.
      }
    }

    if (fileEnabled && filePath) {
      if (!fileReady) {
        fileReady = ensureParentDir(filePath);
      }
      if (fileReady) {
        try {
          fs.appendFileSync(filePath, `${line}\n`, "utf8");
        } catch {
          // File sink is best-effort.
        }
      }
    }
  }

  function child(childOptions = {}) {
    const childContext = isPlainObject(childOptions.context) ? childOptions.context : {};
    const nextComponent =
      typeof childOptions.component === "string" && childOptions.component.trim()
        ? childOptions.component.trim()
        : component;
    return createLogger({
      enabled,
      level,
      console: consoleEnabled,
      consoleStream,
      file: fileEnabled,
      filePath,
      component: nextComponent,
      context: {
        ...context,
        ...childContext
      }
    });
  }

  return {
    enabled,
    level,
    component,
    debug(event, fields) {
      writeEntry("debug", event, fields);
    },
    info(event, fields) {
      writeEntry("info", event, fields);
    },
    warn(event, fields) {
      writeEntry("warn", event, fields);
    },
    error(event, fields) {
      writeEntry("error", event, fields);
    },
    child
  };
}

function resolveLogFilePath(workspaceRoot, logging = {}) {
  const rawPath =
    typeof logging.path === "string" && logging.path.trim().length > 0
      ? logging.path.trim()
      : path.join(".clawty", "logs", "runtime.log");
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(workspaceRoot, rawPath);
}

export function createRuntimeLogger(config = {}, options = {}) {
  const workspaceRoot = path.resolve(config.workspaceRoot || process.cwd());
  const logging = isPlainObject(config.logging) ? config.logging : {};
  return createLogger({
    enabled: logging.enabled !== false,
    level: normalizeLevel(logging.level, "info"),
    console: options.console ?? logging.console ?? false,
    consoleStream: options.consoleStream || process.stderr,
    file: options.file ?? logging.file ?? true,
    filePath: resolveLogFilePath(workspaceRoot, logging),
    component: options.component || "runtime",
    context: isPlainObject(options.context) ? options.context : {}
  });
}
