export async function callToolWithDeps(name, args, serverOptions = {}, deps = {}) {
  const {
    facadeToolNameSet,
    facadeToolHandlers,
    monitorToolNameSet,
    lowLevelCodeToolNameSet,
    resolveDefaultFacadeToolNames,
    callMonitorTool,
    callLowLevelCodeTool
  } = deps;
  const exposedFacadeToolNames =
    serverOptions.exposedFacadeToolNames instanceof Set
      ? serverOptions.exposedFacadeToolNames
      : resolveDefaultFacadeToolNames();
  if (facadeToolNameSet.has(name) && !exposedFacadeToolNames.has(name)) {
    throw new Error(`Tool not exposed by current policy: ${name}`);
  }

  const facadeHandler = facadeToolHandlers[name];
  if (typeof facadeHandler === "function") {
    return facadeHandler(args, serverOptions);
  }

  if (monitorToolNameSet.has(name)) {
    if (!serverOptions.exposeLowLevel) {
      throw new Error(`Tool not exposed by current policy: ${name}`);
    }
    return callMonitorTool(name, args, serverOptions);
  }

  if (lowLevelCodeToolNameSet.has(name)) {
    if (!serverOptions.exposeLowLevel) {
      throw new Error(`Tool not exposed by current policy: ${name}`);
    }
    return callLowLevelCodeTool(name, args, serverOptions);
  }

  throw new Error(`Unknown tool: ${name}`);
}
