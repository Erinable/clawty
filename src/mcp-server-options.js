export function parseMcpServerArgsWithDeps(argv = [], deps = {}) {
  const {
    resolvePath,
    parseToolsetTokens,
    validToolsets,
    normalizePort
  } = deps;

  const options = {
    help: false,
    workspaceRoot: null,
    exposeLowLevel: null,
    toolsets: [],
    transport: null,
    host: null,
    port: null,
    logPath: null
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--workspace") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --workspace");
      }
      options.workspaceRoot = resolvePath(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      options.workspaceRoot = resolvePath(arg.slice("--workspace=".length));
      continue;
    }
    if (arg === "--expose-low-level") {
      options.exposeLowLevel = true;
      continue;
    }
    if (arg === "--toolset") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --toolset");
      }
      for (const token of parseToolsetTokens(raw)) {
        if (!validToolsets.has(token)) {
          throw new Error(
            `Unknown toolset: ${token}. Expected one of: analysis, edit-safe, ops, all`
          );
        }
        options.toolsets.push(token);
      }
      idx += 1;
      continue;
    }
    if (arg.startsWith("--toolset=")) {
      const raw = arg.slice("--toolset=".length);
      for (const token of parseToolsetTokens(raw)) {
        if (!validToolsets.has(token)) {
          throw new Error(
            `Unknown toolset: ${token}. Expected one of: analysis, edit-safe, ops, all`
          );
        }
        options.toolsets.push(token);
      }
      continue;
    }
    if (arg === "--transport") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --transport");
      }
      const normalized = String(raw).trim().toLowerCase();
      if (!["stdio", "http"].includes(normalized)) {
        throw new Error(`Unknown transport: ${raw}. Expected one of: stdio, http`);
      }
      options.transport = normalized;
      idx += 1;
      continue;
    }
    if (arg.startsWith("--transport=")) {
      const raw = arg.slice("--transport=".length);
      const normalized = String(raw).trim().toLowerCase();
      if (!["stdio", "http"].includes(normalized)) {
        throw new Error(`Unknown transport: ${raw}. Expected one of: stdio, http`);
      }
      options.transport = normalized;
      continue;
    }
    if (arg === "--host") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --host");
      }
      options.host = String(raw).trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      options.host = String(arg.slice("--host=".length)).trim();
      continue;
    }
    if (arg === "--port") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --port");
      }
      options.port = normalizePort(raw, null, "--port");
      idx += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = normalizePort(arg.slice("--port=".length), null, "--port");
      continue;
    }
    if (arg === "--log-path") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --log-path");
      }
      options.logPath = String(raw).trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--log-path=")) {
      options.logPath = String(arg.slice("--log-path=".length)).trim();
      continue;
    }
    throw new Error(`Unknown mcp-server argument: ${arg}`);
  }
  return options;
}

export function resolveMcpServerRuntimeOptionsWithDeps(args = {}, config = {}, deps = {}) {
  const {
    isPlainObject,
    parseToolsetTokens,
    normalizeTransport,
    normalizeHost,
    normalizePort,
    resolvePath,
    joinPath
  } = deps;
  const parsedArgs = isPlainObject(args) ? args : {};
  const mcpConfig = isPlainObject(config?.mcpServer) ? config.mcpServer : {};
  const toolsetsFromArgs = Array.isArray(parsedArgs.toolsets) ? parsedArgs.toolsets : [];
  const toolsetsFromConfig = parseToolsetTokens(mcpConfig.toolsets);
  const hasExplicitPort =
    parsedArgs.port !== undefined &&
    parsedArgs.port !== null &&
    !(typeof parsedArgs.port === "string" && parsedArgs.port.trim().length === 0);
  const hasConfigPort =
    mcpConfig.port !== undefined &&
    mcpConfig.port !== null &&
    !(typeof mcpConfig.port === "string" && mcpConfig.port.trim().length === 0);
  const hasConfigTransport =
    typeof mcpConfig.transport === "string" && mcpConfig.transport.trim().length > 0;
  const transportInput =
    parsedArgs.transport ||
    (hasExplicitPort ? "http" : hasConfigTransport ? mcpConfig.transport : hasConfigPort ? "http" : null);
  const transport = normalizeTransport(transportInput, "stdio");
  if (transport === "stdio" && hasExplicitPort) {
    throw new Error("--port cannot be used with --transport stdio");
  }

  const defaultLogPath =
    typeof joinPath === "function"
      ? joinPath(".clawty", "logs", "mcp-server.log")
      : ".clawty/logs/mcp-server.log";

  return {
    workspaceRoot: resolvePath(parsedArgs.workspaceRoot || config.workspaceRoot || process.cwd()),
    exposeLowLevel: parsedArgs.exposeLowLevel === true || mcpConfig.exposeLowLevel === true,
    toolsets: toolsetsFromArgs.length > 0 ? toolsetsFromArgs : toolsetsFromConfig,
    transport,
    host: normalizeHost(parsedArgs.host || mcpConfig.host, "127.0.0.1"),
    port:
      transport === "http"
        ? normalizePort(parsedArgs.port ?? mcpConfig.port, 8765, "mcp-server port")
        : null,
    logPath:
      typeof parsedArgs.logPath === "string" && parsedArgs.logPath.trim().length > 0
        ? parsedArgs.logPath.trim()
        : typeof mcpConfig.logPath === "string" && mcpConfig.logPath.trim().length > 0
          ? mcpConfig.logPath.trim()
          : defaultLogPath
  };
}
