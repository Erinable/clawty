export function createCallLowLevelCodeTool(deps = {}) {
  const { runTool, resolvePath, isPlainObject } = deps;

  function splitWorkspaceArg(args, fallbackWorkspace) {
    const normalizedArgs = isPlainObject(args) ? { ...args } : {};
    let workspaceRoot = resolvePath(fallbackWorkspace || process.cwd());
    if (
      typeof normalizedArgs.workspace === "string" &&
      normalizedArgs.workspace.trim().length > 0
    ) {
      workspaceRoot = resolvePath(normalizedArgs.workspace.trim());
    }
    delete normalizedArgs.workspace;
    return {
      workspaceRoot,
      toolArgs: normalizedArgs
    };
  }

  function createToolContext(workspaceRoot, serverOptions = {}) {
    return {
      workspaceRoot,
      toolTimeoutMs: serverOptions.toolTimeoutMs,
      lsp: serverOptions.lsp || {},
      embedding: serverOptions.embedding || {},
      metrics: serverOptions.metrics || {},
      onlineTuner: serverOptions.onlineTuner || {}
    };
  }

  return async function callLowLevelCodeTool(name, args, serverOptions = {}) {
    const { workspaceRoot, toolArgs } = splitWorkspaceArg(args, serverOptions.workspaceRoot);
    const toolContext = createToolContext(workspaceRoot, serverOptions);
    return runTool(name, toolArgs, toolContext);
  };
}
