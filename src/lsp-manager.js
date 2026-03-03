import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { queryCodeIndex } from "./code-index.js";

const clients = new Map();
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_TS_COMMAND = "typescript-language-server --stdio";
const STDERR_HISTORY_LIMIT = 30;
const PROCESS_CLOSE_TIMEOUT_MS = 800;

let cleanupRegistered = false;

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function normalizeRelativePath(workspaceRoot, inputPath) {
  const fullPath = resolveSafePath(workspaceRoot, inputPath);
  return toPosixPath(path.relative(workspaceRoot, fullPath));
}

function detectLanguageId(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    return "typescript";
  }
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return "javascript";
  }
  return null;
}

function buildClientKey(workspaceRoot) {
  return `${path.resolve(workspaceRoot)}::ts-js`;
}

function sanitizeLspConfig(input) {
  const config = input || {};
  return {
    enabled: config.enabled !== false,
    timeoutMs: parsePositiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60_000),
    maxResults: parsePositiveInt(config.maxResults, DEFAULT_MAX_RESULTS, 1, 1000),
    tsCommand:
      typeof config.tsCommand === "string" && config.tsCommand.trim().length > 0
        ? config.tsCommand.trim()
        : DEFAULT_TS_COMMAND
  };
}

function ensureCleanupHandlers() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  process.once("exit", () => {
    for (const client of clients.values()) {
      client.killImmediately();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdownAllLspClients()
        .catch(() => {
          // Ignore cleanup failures.
        })
        .finally(() => {
          process.exit(0);
        });
    });
  }
}

function toLspPosition(line, column) {
  const safeLine = Math.max(1, Number(line) || 1);
  const safeColumn = Math.max(1, Number(column) || 1);
  return {
    line: safeLine - 1,
    character: safeColumn - 1
  };
}

function fromLspRange(range) {
  if (!range || !range.start || !range.end) {
    return {
      line: 1,
      column: 1,
      end_line: 1,
      end_column: 1
    };
  }
  return {
    line: Number(range.start.line || 0) + 1,
    column: Number(range.start.character || 0) + 1,
    end_line: Number(range.end.line || 0) + 1,
    end_column: Number(range.end.character || 0) + 1
  };
}

function uriToPath(uri, workspaceRoot) {
  if (typeof uri !== "string") {
    return null;
  }
  if (!uri.startsWith("file://")) {
    return uri;
  }
  try {
    const absolute = fileURLToPath(uri);
    const normalizedRoot = path.resolve(workspaceRoot);
    const normalizedPath = path.resolve(absolute);
    if (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
      return toPosixPath(path.relative(workspaceRoot, normalizedPath));
    }
    return normalizedPath;
  } catch {
    return uri;
  }
}

function normalizeLocation(location, workspaceRoot) {
  if (!location || typeof location !== "object") {
    return null;
  }

  if (location.targetUri && location.targetRange) {
    const pathValue = uriToPath(location.targetUri, workspaceRoot);
    const range = fromLspRange(location.targetRange);
    return {
      path: pathValue,
      ...range
    };
  }

  if (location.uri && location.range) {
    const pathValue = uriToPath(location.uri, workspaceRoot);
    const range = fromLspRange(location.range);
    return {
      path: pathValue,
      ...range
    };
  }

  return null;
}

function normalizeLocationArray(raw, workspaceRoot, maxResults) {
  const asArray = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const output = [];
  for (const item of asArray) {
    const normalized = normalizeLocation(item, workspaceRoot);
    if (!normalized || !normalized.path) {
      continue;
    }
    output.push(normalized);
    if (output.length >= maxResults) {
      break;
    }
  }
  return output;
}

function normalizeWorkspaceSymbols(raw, workspaceRoot, maxResults) {
  const asArray = Array.isArray(raw) ? raw : [];
  const output = [];
  for (const symbol of asArray) {
    if (!symbol || typeof symbol.name !== "string") {
      continue;
    }

    let pathValue = null;
    let line = 1;
    let column = 1;

    if (symbol.location) {
      if (symbol.location.uri && symbol.location.range) {
        pathValue = uriToPath(symbol.location.uri, workspaceRoot);
        const start = fromLspRange(symbol.location.range);
        line = start.line;
        column = start.column;
      } else if (symbol.location.targetUri && symbol.location.targetRange) {
        pathValue = uriToPath(symbol.location.targetUri, workspaceRoot);
        const start = fromLspRange(symbol.location.targetRange);
        line = start.line;
        column = start.column;
      }
    }

    if (!pathValue) {
      continue;
    }

    output.push({
      name: symbol.name,
      kind: symbol.kind || null,
      container_name: symbol.containerName || null,
      path: pathValue,
      line,
      column
    });
    if (output.length >= maxResults) {
      break;
    }
  }
  return output;
}

function symbolAtPosition(content, line, column) {
  const lines = content.split(/\r?\n/);
  const idx = Math.max(0, Math.min(lines.length - 1, (Number(line) || 1) - 1));
  const text = lines[idx] || "";
  if (!text) {
    return "";
  }

  const col = Math.max(0, Math.min(text.length, (Number(column) || 1) - 1));
  const ident = /[A-Za-z0-9_$]/;
  let left = col;
  let right = col;

  while (left > 0 && ident.test(text[left - 1])) {
    left -= 1;
  }
  while (right < text.length && ident.test(text[right])) {
    right += 1;
  }

  return text.slice(left, right).trim();
}

async function fallbackUsingCodeIndex({
  workspaceRoot,
  mode,
  path: relativePath = "",
  line = 1,
  column = 1,
  query = "",
  maxResults = 10,
  reason = "fallback"
}) {
  let resolvedQuery = typeof query === "string" ? query.trim() : "";
  if (!resolvedQuery && typeof relativePath === "string") {
    try {
      const fullPath = resolveSafePath(workspaceRoot, relativePath);
      const content = await fs.readFile(fullPath, "utf8");
      resolvedQuery = symbolAtPosition(content, line, column);
    } catch {
      // Ignore read errors for fallback.
    }
  }
  if (!resolvedQuery && typeof relativePath === "string") {
    resolvedQuery = path.basename(relativePath, path.extname(relativePath));
  }

  if (!resolvedQuery) {
    return {
      ok: false,
      fallback: true,
      provider: "index",
      error: `LSP unavailable and fallback query is empty (${reason})`
    };
  }

  const indexResult = await queryCodeIndex(workspaceRoot, {
    query: resolvedQuery,
    top_k: Math.max(1, maxResults)
  });
  if (!indexResult.ok) {
    return {
      ok: false,
      fallback: true,
      provider: "index",
      error: `LSP unavailable (${reason}); index fallback failed: ${indexResult.error}`
    };
  }

  if (mode === "workspace_symbols") {
    const results = indexResult.results.map((item) => ({
      name: path.basename(item.path, path.extname(item.path)),
      kind: "index_match",
      container_name: null,
      path: item.path,
      line: item.hit_line || 1,
      column: 1
    }));
    return {
      ok: true,
      provider: "index",
      fallback: true,
      warning: `LSP unavailable (${reason}), returned index-based symbol matches.`,
      query: resolvedQuery,
      results,
      total_hits: indexResult.total_hits
    };
  }

  const locations = indexResult.results.map((item) => ({
    path: item.path,
    line: item.hit_line || 1,
    column: 1,
    end_line: item.hit_line || 1,
    end_column: 1
  }));

  return {
    ok: true,
    provider: "index",
    fallback: true,
    warning: `LSP unavailable (${reason}), returned index-based matches.`,
    query: resolvedQuery,
    locations,
    count: locations.length
  };
}

class LspClient {
  constructor({ workspaceRoot, command, timeoutMs }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.initialized = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderrTail = [];
    this.lastError = null;
    this.restartCount = 0;
  }

  get isRunning() {
    return Boolean(this.proc && !this.closed);
  }

  get pid() {
    return this.proc?.pid || null;
  }

  async ensureStarted() {
    if (this.isRunning && this.initialized) {
      return;
    }
    await this.start();
  }

  start() {
    if (this._startingPromise) {
      return this._startingPromise;
    }

    this._startingPromise = (async () => {
      this.disposePending("LSP client restarting");
      this.closed = false;
      this.initialized = false;
      this.buffer = Buffer.alloc(0);

      const child = spawn(this.command, {
        cwd: this.workspaceRoot,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      this.proc = child;

      child.stdout.on("data", (chunk) => this.onStdout(chunk));
      child.stderr.on("data", (chunk) => this.onStderr(chunk));
      if (child.stdin) {
        child.stdin.on("error", (error) => {
          const message = `lsp stdin error: ${error?.message || String(error)}`;
          this.lastError = message;
          this.disposePending(message);
        });
      }
      child.on("error", (error) => {
        this.lastError = `spawn error: ${error.message || String(error)}`;
      });
      child.on("exit", (code, signal) => {
        this.closed = true;
        this.initialized = false;
        const message = `LSP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.lastError = this.lastError || message;
        this.disposePending(message);
      });

      try {
        const rootUri = pathToFileURL(this.workspaceRoot).href;
        await this.request(
          "initialize",
          {
            processId: process.pid,
            clientInfo: {
              name: "clawty",
              version: "0.1.0"
            },
            rootUri,
            rootPath: this.workspaceRoot,
            capabilities: {}
          },
          this.timeoutMs
        );
        this.notify("initialized", {});
        this.initialized = true;
      } catch (error) {
        this.lastError = error.message || String(error);
        await this.stop();
        throw error;
      } finally {
        this._startingPromise = null;
      }
    })();

    return this._startingPromise;
  }

  async restart() {
    this.restartCount += 1;
    await this.stop();
    await this.start();
  }

  async stop() {
    const child = this.proc;
    if (!child) {
      this.closed = true;
      this.initialized = false;
      return;
    }

    try {
      if (this.initialized) {
        try {
          await this.request("shutdown", null, Math.min(this.timeoutMs, 1500));
        } catch {
          // Ignore graceful shutdown errors.
        }
        this.notify("exit", null);
      }
    } finally {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        child.once("exit", done);
        setTimeout(done, PROCESS_CLOSE_TIMEOUT_MS);
        try {
          child.kill("SIGTERM");
        } catch {
          done();
        }
      });
      this.killImmediately();
    }
  }

  killImmediately() {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Ignore kill errors.
      }
    }
    this.proc = null;
    this.closed = true;
    this.initialized = false;
    this.disposePending("LSP client stopped");
  }

  disposePending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  onStderr(chunk) {
    const text = chunk.toString("utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_HISTORY_LIMIT) {
        this.stderrTail.shift();
      }
    }
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(match[1]);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) {
        return;
      }
      const body = this.buffer.slice(headerEnd + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.slice(totalLength);

      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        this.lastError = `invalid LSP payload: ${error.message || String(error)}`;
        continue;
      }
      this.handleMessage(payload);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      if (Object.prototype.hasOwnProperty.call(message, "method")) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: null
        });
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        const msg = message.error.message || JSON.stringify(message.error);
        pending.reject(new Error(msg));
        return;
      }
      pending.resolve(message.result);
    }
  }

  send(payload) {
    if (!this.proc || !this.proc.stdin || this.closed) {
      throw new Error("LSP process is not running");
    }
    const body = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.proc.stdin.write(header);
    this.proc.stdin.write(body);
  }

  request(method, params, timeoutMs) {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error("LSP process is not running"));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs || this.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        this.send({
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.closed) {
      return;
    }
    try {
      this.send({
        jsonrpc: "2.0",
        method,
        params
      });
    } catch {
      // Ignore notification failures.
    }
  }

  async withOpenDocument(relativePath, fn) {
    const fullPath = resolveSafePath(this.workspaceRoot, relativePath);
    const content = await fs.readFile(fullPath, "utf8");
    const languageId = detectLanguageId(relativePath) || "plaintext";
    const uri = pathToFileURL(fullPath).href;

    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });

    try {
      return await fn(uri);
    } finally {
      this.notify("textDocument/didClose", {
        textDocument: { uri }
      });
    }
  }

  health() {
    return {
      active: this.isRunning,
      initialized: this.initialized,
      pid: this.pid,
      restart_count: this.restartCount,
      command: this.command,
      last_error: this.lastError,
      stderr_tail: this.stderrTail.slice(-10)
    };
  }
}

async function getClient(workspaceRoot, lspConfig) {
  ensureCleanupHandlers();
  const key = buildClientKey(workspaceRoot);
  const existing = clients.get(key);
  if (existing) {
    if (!existing.isRunning || !existing.initialized) {
      try {
        await existing.ensureStarted();
      } catch (error) {
        clients.delete(key);
        throw error;
      }
    }
    return existing;
  }

  const client = new LspClient({
    workspaceRoot,
    command: lspConfig.tsCommand,
    timeoutMs: lspConfig.timeoutMs
  });
  clients.set(key, client);
  try {
    await client.ensureStarted();
  } catch (error) {
    clients.delete(key);
    throw error;
  }
  return client;
}

async function runLspRequestWithRetry(client, runRequest) {
  try {
    return await runRequest();
  } catch (firstError) {
    await client.restart();
    return runRequest().catch((secondError) => {
      const error = new Error(secondError.message || String(secondError));
      error.cause = firstError;
      throw error;
    });
  }
}

function validatePositionArgs(args) {
  if (!args || typeof args.path !== "string" || args.path.trim().length === 0) {
    throw new Error("path is required");
  }
  const line = parsePositiveInt(args.line, 1, 1, 10_000_000);
  const column = parsePositiveInt(args.column, 1, 1, 10_000_000);
  return {
    path: args.path.trim(),
    line,
    column
  };
}

function maxResultsFromArgs(args, lspConfig) {
  return parsePositiveInt(args?.max_results, lspConfig.maxResults, 1, 1000);
}

export async function lspHealth(workspaceRoot, args = {}, lspInput = {}) {
  const lspConfig = sanitizeLspConfig(lspInput);
  const response = {
    ok: true,
    enabled: lspConfig.enabled,
    command: lspConfig.tsCommand,
    timeout_ms: lspConfig.timeoutMs,
    max_results: lspConfig.maxResults
  };

  if (!lspConfig.enabled) {
    return {
      ...response,
      active: false,
      initialized: false,
      reason: "disabled by CLAWTY_LSP_ENABLED"
    };
  }

  const startupCheck = Boolean(args.startup_check);
  if (!startupCheck) {
    const key = buildClientKey(workspaceRoot);
    const client = clients.get(key);
    if (!client) {
      return {
        ...response,
        active: false,
        initialized: false,
        reason: "not started yet"
      };
    }
    return {
      ...response,
      ...client.health()
    };
  }

  try {
    const client = await getClient(workspaceRoot, lspConfig);
    return {
      ...response,
      ...client.health()
    };
  } catch (error) {
    return {
      ok: false,
      enabled: lspConfig.enabled,
      command: lspConfig.tsCommand,
      error: error.message || String(error)
    };
  }
}

export async function lspDefinition(workspaceRoot, args = {}, lspInput = {}) {
  const lspConfig = sanitizeLspConfig(lspInput);
  const { path: relativePath, line, column } = validatePositionArgs(args);
  const language = detectLanguageId(relativePath);
  const maxResults = maxResultsFromArgs(args, lspConfig);

  if (!language) {
    return {
      ok: false,
      error: `Unsupported language for LSP: ${relativePath}`
    };
  }

  if (!lspConfig.enabled) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "definition",
      path: relativePath,
      line,
      column,
      maxResults,
      reason: "disabled"
    });
  }

  try {
    const client = await getClient(workspaceRoot, lspConfig);
    const result = await runLspRequestWithRetry(client, () =>
      client.withOpenDocument(relativePath, async (uri) =>
        client.request(
          "textDocument/definition",
          {
            textDocument: { uri },
            position: toLspPosition(line, column)
          },
          lspConfig.timeoutMs
        )
      )
    );

    const locations = normalizeLocationArray(result, workspaceRoot, maxResults);
    return {
      ok: true,
      provider: "lsp",
      fallback: false,
      locations,
      count: locations.length
    };
  } catch (error) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "definition",
      path: relativePath,
      line,
      column,
      maxResults,
      reason: error.message || String(error)
    });
  }
}

export async function lspReferences(workspaceRoot, args = {}, lspInput = {}) {
  const lspConfig = sanitizeLspConfig(lspInput);
  const { path: relativePath, line, column } = validatePositionArgs(args);
  const language = detectLanguageId(relativePath);
  const maxResults = maxResultsFromArgs(args, lspConfig);
  const includeDeclaration = Boolean(args.include_declaration);

  if (!language) {
    return {
      ok: false,
      error: `Unsupported language for LSP: ${relativePath}`
    };
  }

  if (!lspConfig.enabled) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "references",
      path: relativePath,
      line,
      column,
      maxResults,
      reason: "disabled"
    });
  }

  try {
    const client = await getClient(workspaceRoot, lspConfig);
    const result = await runLspRequestWithRetry(client, () =>
      client.withOpenDocument(relativePath, async (uri) =>
        client.request(
          "textDocument/references",
          {
            textDocument: { uri },
            position: toLspPosition(line, column),
            context: { includeDeclaration }
          },
          lspConfig.timeoutMs
        )
      )
    );

    const locations = normalizeLocationArray(result, workspaceRoot, maxResults);
    return {
      ok: true,
      provider: "lsp",
      fallback: false,
      include_declaration: includeDeclaration,
      locations,
      count: locations.length
    };
  } catch (error) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "references",
      path: relativePath,
      line,
      column,
      maxResults,
      reason: error.message || String(error)
    });
  }
}

export async function lspWorkspaceSymbols(workspaceRoot, args = {}, lspInput = {}) {
  const lspConfig = sanitizeLspConfig(lspInput);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const maxResults = maxResultsFromArgs(args, lspConfig);

  if (!query) {
    return { ok: false, error: "query is required" };
  }

  if (!lspConfig.enabled) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "workspace_symbols",
      query,
      maxResults,
      reason: "disabled"
    });
  }

  try {
    const client = await getClient(workspaceRoot, lspConfig);
    const result = await runLspRequestWithRetry(client, () =>
      client.request("workspace/symbol", { query }, lspConfig.timeoutMs)
    );

    const symbols = normalizeWorkspaceSymbols(result, workspaceRoot, maxResults);
    return {
      ok: true,
      provider: "lsp",
      fallback: false,
      query,
      results: symbols,
      count: symbols.length
    };
  } catch (error) {
    return fallbackUsingCodeIndex({
      workspaceRoot,
      mode: "workspace_symbols",
      query,
      maxResults,
      reason: error.message || String(error)
    });
  }
}

export async function shutdownAllLspClients() {
  const closing = [];
  for (const [key, client] of clients.entries()) {
    closing.push(
      client
        .stop()
        .catch(() => {
          // Ignore close failures.
        })
        .finally(() => {
          clients.delete(key);
        })
    );
  }
  await Promise.all(closing);
}
