export function normalizeTransport(value, fallback = "stdio") {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "stdio" || normalized === "http") {
    return normalized;
  }
  return fallback;
}

export function normalizeHost(value, fallback = "127.0.0.1") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
}

export function normalizePort(value, fallback, label = "port") {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: expected integer in [1, 65535]`);
  }
  return port;
}

export function normalizeServerOptionsWithDeps(options = {}, deps = {}) {
  const {
    resolvePath,
    resolveEnabledToolsets,
    resolveFacadeToolNamesForToolsets,
    isPlainObject
  } = deps;
  const hasExplicitPort =
    options.port !== undefined &&
    options.port !== null &&
    !(typeof options.port === "string" && options.port.trim().length === 0);
  const transportInput =
    typeof options.transport === "string" && options.transport.trim().length > 0
      ? options.transport.trim().toLowerCase()
      : hasExplicitPort
        ? "http"
        : "stdio";
  const transport = normalizeTransport(transportInput, "stdio");
  const workspaceRoot =
    typeof options.workspaceRoot === "string" && options.workspaceRoot.trim().length > 0
      ? resolvePath(options.workspaceRoot)
      : resolvePath(process.cwd());
  const enabledToolsets = resolveEnabledToolsets(options.toolsets);
  const exposedFacadeToolNames = resolveFacadeToolNamesForToolsets(enabledToolsets);
  return {
    workspaceRoot,
    toolTimeoutMs: Number.isFinite(options.toolTimeoutMs) ? options.toolTimeoutMs : 180_000,
    exposeLowLevel: options.exposeLowLevel === true,
    transport,
    host: normalizeHost(options.host, "127.0.0.1"),
    port:
      transport === "http" ? normalizePort(options.port, 8765, "mcp-server port") : null,
    logger: options.logger && typeof options.logger === "object" ? options.logger : null,
    enabledToolsets,
    exposedFacadeToolNames,
    lsp: isPlainObject(options.lsp) ? options.lsp : {},
    embedding: isPlainObject(options.embedding) ? options.embedding : {},
    metrics: isPlainObject(options.metrics) ? options.metrics : {},
    onlineTuner: isPlainObject(options.onlineTuner) ? options.onlineTuner : {}
  };
}
