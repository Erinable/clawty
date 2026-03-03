function isArrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function callReindexCodebaseFacadeWithDeps(args, deps = {}) {
  const { isPlainObject, callLowLevelCodeTool, serverOptions } = deps;
  const safeArgs = isPlainObject(args) ? args : {};
  const changedPaths = isArrayOfStrings(safeArgs.changed_paths)
    ? safeArgs.changed_paths
    : undefined;
  const deletedPaths = isArrayOfStrings(safeArgs.deleted_paths)
    ? safeArgs.deleted_paths
    : undefined;
  const forceFull = safeArgs.force_full === true;
  const baseArgs = {
    workspace: safeArgs.workspace
  };

  const steps = [];
  if (forceFull) {
    steps.push(["build_code_index", {}]);
    steps.push(["build_syntax_index", {}]);
    steps.push(["build_semantic_graph", {}]);
  } else {
    const refreshArgs = {};
    if (changedPaths) {
      refreshArgs.changed_paths = changedPaths;
    }
    if (deletedPaths) {
      refreshArgs.deleted_paths = deletedPaths;
    }
    steps.push(["refresh_code_index", refreshArgs]);
    steps.push(["refresh_syntax_index", refreshArgs]);
    steps.push(["refresh_semantic_graph", refreshArgs]);
  }

  const results = [];
  let ok = true;
  for (const [name, toolArgs] of steps) {
    try {
      const payload = await callLowLevelCodeTool(name, { ...baseArgs, ...toolArgs }, serverOptions);
      const stepOk = payload?.ok === true;
      results.push({
        tool: name,
        ok: stepOk,
        result: payload
      });
      if (!stepOk) {
        ok = false;
      }
    } catch (error) {
      ok = false;
      results.push({
        tool: name,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  return {
    ok,
    mode: forceFull ? "full" : "refresh",
    steps: results
  };
}
