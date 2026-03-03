const TOOLSET_ANALYSIS = "analysis";
const TOOLSET_EDIT_SAFE = "edit-safe";
const TOOLSET_OPS = "ops";
const TOOLSET_ALL = "all";

export const DEFAULT_TOOLSETS = [TOOLSET_ANALYSIS, TOOLSET_OPS];

const FACADE_TOOLSET_MAP = {
  [TOOLSET_ANALYSIS]: new Set([
    "search_code",
    "go_to_definition",
    "find_references",
    "get_code_context",
    "explain_code",
    "trace_call_chain",
    "impact_analysis"
  ]),
  [TOOLSET_EDIT_SAFE]: new Set(["reindex_codebase"]),
  [TOOLSET_OPS]: new Set(["monitor_system"])
};

export const VALID_TOOLSETS = new Set([
  TOOLSET_ANALYSIS,
  TOOLSET_EDIT_SAFE,
  TOOLSET_OPS,
  TOOLSET_ALL
]);

export function parseToolsetTokens(input) {
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => parseToolsetTokens(item))
      .filter((item) => typeof item === "string");
  }
  if (typeof input !== "string") {
    return [];
  }
  return input
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveEnabledToolsets(toolsetsInput) {
  const requested = new Set(parseToolsetTokens(toolsetsInput));
  if (requested.size === 0) {
    return new Set(DEFAULT_TOOLSETS);
  }
  if (requested.has(TOOLSET_ALL)) {
    return new Set([TOOLSET_ANALYSIS, TOOLSET_EDIT_SAFE, TOOLSET_OPS]);
  }
  const enabled = new Set();
  for (const token of requested) {
    if (!VALID_TOOLSETS.has(token)) {
      throw new Error(`Unknown toolset: ${token}. Expected one of: analysis, edit-safe, ops, all`);
    }
    enabled.add(token);
  }
  if (enabled.size === 0) {
    return new Set(DEFAULT_TOOLSETS);
  }
  return enabled;
}

export function resolveFacadeToolNamesForToolsets(toolsets) {
  const enabledToolsets = toolsets instanceof Set ? toolsets : new Set(DEFAULT_TOOLSETS);
  const names = new Set();
  for (const toolsetName of enabledToolsets) {
    const mapping = FACADE_TOOLSET_MAP[toolsetName];
    if (!mapping) {
      continue;
    }
    for (const toolName of mapping) {
      names.add(toolName);
    }
  }
  return names;
}
