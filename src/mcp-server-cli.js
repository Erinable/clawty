export function printMcpHelp() {
  console.log(
    "Usage: clawty mcp-server [--workspace <path>] [--toolset <name>] [--expose-low-level] [--transport <stdio|http>] [--host <host>] [--port <n>] [--log-path <path>]"
  );
  console.log("");
  console.log("Quick start:");
  console.log("- clawty mcp-server                       # use config defaults (recommended)");
  console.log("- clawty mcp-server --port 8765           # quick HTTP mode on 127.0.0.1:8765");
  console.log("");
  console.log("Toolsets:");
  console.log("- analysis: search/explain/trace/impact/read-only code navigation");
  console.log("- ops: monitor_system");
  console.log("- edit-safe: reindex_codebase");
  console.log("- all: enable all facade toolsets");
  console.log("- default: analysis + ops");
  console.log("");
  console.log("Default exposed facade tools:");
  console.log("- search_code / go_to_definition / find_references");
  console.log("- get_code_context / explain_code / trace_call_chain / impact_analysis");
  console.log("- monitor_system");
  console.log("- reindex_codebase requires --toolset edit-safe (or --toolset all)");
  console.log("");
  console.log("Optional:");
  console.log("- --transport supports stdio (default) or http.");
  console.log("- --port implies http transport if --transport is omitted.");
  console.log("- --log-path overrides log file (default .clawty/logs/mcp-server.log).");
  console.log("- --expose-low-level exposes raw monitoring/index/LSP tools for debugging.");
}

export async function runMcpServerCliWithDeps(argv = [], deps = {}) {
  const {
    parseMcpServerArgs,
    resolveMcpServerRuntimeOptions,
    loadConfig,
    createRuntimeLogger,
    runMcpServer,
    isAbsolutePath,
    resolvePath,
    stderr
  } = deps;

  const args = parseMcpServerArgs(argv);
  if (args.help) {
    printMcpHelp();
    return;
  }

  const config = loadConfig({ allowMissingApiKey: true });
  const runtimeOptions = resolveMcpServerRuntimeOptions(args, config);
  const mcpLogFilePath = isAbsolutePath(runtimeOptions.logPath)
    ? runtimeOptions.logPath
    : resolvePath(runtimeOptions.workspaceRoot, runtimeOptions.logPath);
  const logger = createRuntimeLogger(config, {
    component: "mcp-server",
    consoleStream: stderr,
    filePath: mcpLogFilePath,
    context: {
      entrypoint: "mcp-server"
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
