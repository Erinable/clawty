import { createResponse } from "./openai.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INCREMENTAL_CONTEXT_MAX_PATHS = 40;
const DEFAULT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS = 12_000;
const DEFAULT_INCREMENTAL_CONTEXT_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = [
  "You are Clawty, a CLI coding assistant.",
  "Focus on software engineering tasks in the workspace.",
  "For repository exploration, build_code_index once, then use refresh_code_index + query_code_index.",
  "Use get_index_stats when you need index health or coverage details.",
  "For structural code context, build_syntax_index then use refresh_syntax_index + query_syntax_index + get_syntax_index_stats.",
  "For multi-hop reasoning, build_semantic_graph, then refresh_semantic_graph after code changes, and use query_semantic_graph/get_semantic_graph_stats.",
  "For ambiguous or cross-signal retrieval, use query_hybrid_index to fuse semantic/syntax/index candidates.",
  "When a turn includes workspace_incremental_context, prioritize changed_paths and git_diff evidence first.",
  "When configured, query_hybrid_index can enable embedding rerank via enable_embedding for semantic intent matching.",
  "When syntax index is available, build_semantic_graph can ingest syntax import/call edges as structural priors.",
  "When precise index data exists, import it via import_precise_index before semantic graph query.",
  "For semantic code navigation in TS/JS, use lsp_definition, lsp_references, and lsp_workspace_symbols.",
  "Use lsp_health to diagnose language server problems.",
  "Before editing, inspect relevant files first.",
  "Prefer minimal, correct changes.",
  "For focused edits, prefer apply_patch over full-file overwrite.",
  "Use run_shell for checks when useful.",
  "Avoid destructive operations and do not access paths outside workspace root.",
  "When finished, provide a concise summary and any follow-up steps."
].join(" ");

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function normalizeGitPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  let normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\\/g, "/");
  return normalized || null;
}

function parseGitStatusLine(line) {
  if (typeof line !== "string" || line.length < 4) {
    return null;
  }
  const status = line.slice(0, 2);
  let rawPath = line.slice(3).trim();
  if (!rawPath) {
    return null;
  }
  const renameMarker = rawPath.lastIndexOf(" -> ");
  if (renameMarker >= 0) {
    rawPath = rawPath.slice(renameMarker + 4);
  }
  const pathValue = normalizeGitPath(rawPath);
  if (!pathValue) {
    return null;
  }
  return {
    status,
    path: pathValue,
    untracked: status === "??"
  };
}

function truncateText(text, maxChars) {
  const source = typeof text === "string" ? text : "";
  if (source.length <= maxChars) {
    return {
      text: source,
      truncated: false
    };
  }
  const keep = Math.max(0, maxChars - 48);
  return {
    text: `${source.slice(0, keep)}\n...[truncated ${source.length - keep} chars]`,
    truncated: true
  };
}

async function runGitCommand(workspaceRoot, args, timeoutMs, maxBuffer) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    timeout: timeoutMs,
    maxBuffer
  });
  return String(stdout || "");
}

export async function collectIncrementalContext(workspaceRoot, options = {}) {
  const enabled = options.enabled !== false;
  const maxPaths = clampInt(
    options.maxPaths,
    DEFAULT_INCREMENTAL_CONTEXT_MAX_PATHS,
    1,
    500
  );
  const maxDiffChars = clampInt(
    options.maxDiffChars,
    DEFAULT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS,
    500,
    200_000
  );
  const timeoutMs = clampInt(
    options.timeoutMs,
    DEFAULT_INCREMENTAL_CONTEXT_TIMEOUT_MS,
    500,
    20_000
  );

  const baseResult = {
    enabled,
    available: false,
    has_changes: false,
    changed_paths: [],
    total_changed_paths: 0,
    untracked_paths: [],
    diff_excerpt: "",
    diff_truncated: false,
    reason: null,
    error: null
  };

  if (!enabled) {
    return {
      ...baseResult,
      reason: "disabled"
    };
  }

  try {
    const marker = await runGitCommand(
      workspaceRoot,
      ["rev-parse", "--is-inside-work-tree"],
      timeoutMs,
      64 * 1024
    );
    if (!marker.trim().toLowerCase().startsWith("true")) {
      return {
        ...baseResult,
        reason: "not_git_repository"
      };
    }
  } catch {
    return {
      ...baseResult,
      reason: "not_git_repository"
    };
  }

  let statusText = "";
  try {
    statusText = await runGitCommand(
      workspaceRoot,
      ["status", "--porcelain", "--untracked-files=all"],
      timeoutMs,
      1024 * 1024
    );
  } catch (error) {
    return {
      ...baseResult,
      available: true,
      reason: "status_failed",
      error: error.message || String(error)
    };
  }

  const changedPaths = [];
  const untrackedPaths = [];
  const seenPaths = new Set();
  for (const line of statusText.split(/\r?\n/)) {
    const parsed = parseGitStatusLine(line);
    if (!parsed) {
      continue;
    }
    if (seenPaths.has(parsed.path)) {
      continue;
    }
    seenPaths.add(parsed.path);
    changedPaths.push(parsed.path);
    if (parsed.untracked) {
      untrackedPaths.push(parsed.path);
    }
  }

  if (changedPaths.length === 0) {
    return {
      ...baseResult,
      available: true,
      reason: "clean_worktree"
    };
  }

  const limitedChangedPaths = changedPaths.slice(0, maxPaths);
  const limitedUntrackedPaths = untrackedPaths.slice(0, maxPaths);
  const maxBuffer = Math.max(1024 * 1024, maxDiffChars * 8);

  let stagedDiff = "";
  let unstagedDiff = "";
  try {
    stagedDiff = await runGitCommand(
      workspaceRoot,
      ["diff", "--cached", "--no-color", "--unified=0", "--", "."],
      timeoutMs,
      maxBuffer
    );
  } catch {
    stagedDiff = "";
  }
  try {
    unstagedDiff = await runGitCommand(
      workspaceRoot,
      ["diff", "--no-color", "--unified=0", "--", "."],
      timeoutMs,
      maxBuffer
    );
  } catch {
    unstagedDiff = "";
  }

  let mergedDiff = "";
  if (stagedDiff.trim()) {
    mergedDiff += `# staged\n${stagedDiff.trim()}\n`;
  }
  if (unstagedDiff.trim()) {
    mergedDiff += `${mergedDiff ? "\n" : ""}# unstaged\n${unstagedDiff.trim()}`;
  }
  if (!mergedDiff && limitedUntrackedPaths.length > 0) {
    mergedDiff = [
      "# untracked_files",
      ...limitedUntrackedPaths.map((item) => `+ ${item}`)
    ].join("\n");
  }

  const excerpt = truncateText(mergedDiff, maxDiffChars);
  return {
    ...baseResult,
    available: true,
    has_changes: true,
    changed_paths: limitedChangedPaths,
    total_changed_paths: changedPaths.length,
    untracked_paths: limitedUntrackedPaths,
    diff_excerpt: excerpt.text,
    diff_truncated: excerpt.truncated,
    reason: "ok"
  };
}

export function formatIncrementalContextForPrompt(context) {
  if (!context?.enabled || !context?.available) {
    return "";
  }
  const changedPaths = Array.isArray(context.changed_paths) ? context.changed_paths : [];
  const totalChanged = Number(context.total_changed_paths || changedPaths.length);
  const untrackedPaths = Array.isArray(context.untracked_paths)
    ? context.untracked_paths
    : [];

  if (!context.has_changes || changedPaths.length === 0) {
    return [
      "[workspace_incremental_context]",
      "changed_paths: []",
      "[/workspace_incremental_context]"
    ].join("\n");
  }

  const lines = [
    "[workspace_incremental_context]",
    `changed_paths_count: ${totalChanged}`,
    "changed_paths:",
    ...changedPaths.map((item) => `- ${item}`)
  ];
  if (totalChanged > changedPaths.length) {
    lines.push(`- ... (${totalChanged - changedPaths.length} more paths omitted)`);
  }
  if (untrackedPaths.length > 0) {
    lines.push("untracked_paths:", ...untrackedPaths.map((item) => `- ${item}`));
  }
  lines.push("git_diff_unified0:");
  if (typeof context.diff_excerpt === "string" && context.diff_excerpt.trim().length > 0) {
    lines.push(context.diff_excerpt.trim());
  } else {
    lines.push("(empty)");
  }
  if (context.diff_truncated) {
    lines.push("git_diff_note: excerpt truncated");
  }
  lines.push("[/workspace_incremental_context]");
  return lines.join("\n");
}

function buildTurnInputWithIncrementalContext(userInput, context) {
  const baseInput = typeof userInput === "string" ? userInput : String(userInput ?? "");
  const contextBlock = formatIncrementalContextForPrompt(context);
  if (!contextBlock) {
    return baseInput;
  }
  if (!baseInput.trim()) {
    return contextBlock;
  }
  return `${baseInput}\n\n${contextBlock}`;
}

function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

function parseArguments(rawArgs) {
  if (!rawArgs) {
    return {};
  }
  if (typeof rawArgs === "object") {
    return rawArgs;
  }
  if (typeof rawArgs === "string") {
    return JSON.parse(rawArgs);
  }
  return {};
}

async function callModel(config, state, input) {
  const payload = {
    model: config.model,
    instructions: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
    input
  };

  if (state.previousResponseId) {
    payload.previous_response_id = state.previousResponseId;
  }

  return createResponse({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    payload
  });
}

export async function runAgentTurn({ config, state, userInput, onText, onTool }) {
  let initialInput = userInput;
  if (typeof userInput === "string") {
    try {
      const incrementalContext = await collectIncrementalContext(config.workspaceRoot, {
        enabled: config?.agentContext?.incrementalContextEnabled,
        maxPaths: config?.agentContext?.incrementalContextMaxPaths,
        maxDiffChars: config?.agentContext?.incrementalContextMaxDiffChars,
        timeoutMs: config?.agentContext?.incrementalContextTimeoutMs
      });
      state.incremental_context = incrementalContext;
      initialInput = buildTurnInputWithIncrementalContext(userInput, incrementalContext);
    } catch (error) {
      state.incremental_context = {
        enabled: true,
        available: false,
        reason: "context_collection_failed",
        error: error.message || String(error)
      };
      initialInput = userInput;
    }
  }

  let response = await callModel(config, state, initialInput);

  for (let i = 0; i < config.maxToolIterations; i += 1) {
    const text = extractText(response);
    if (text) {
      onText(text);
    }

    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      state.previousResponseId = response.id;
      return;
    }

    const outputs = [];
    for (const call of calls) {
      let result;
      try {
        const args = parseArguments(call.arguments);
        result = await runTool(call.name, args, {
          workspaceRoot: config.workspaceRoot,
          defaultTimeoutMs: config.toolTimeoutMs,
          lsp: config.lsp,
          index: config.index,
          embedding: config.embedding,
          metrics: config.metrics
        });
      } catch (error) {
        result = {
          ok: false,
          error: error.message || String(error)
        };
      }
      onTool(call.name, result);
      outputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }

    state.previousResponseId = response.id;
    response = await callModel(config, state, outputs);
  }

  throw new Error(
    `Tool loop exceeded ${config.maxToolIterations} rounds. Increase CLAWTY_MAX_TOOL_ITERATIONS if needed.`
  );
}
