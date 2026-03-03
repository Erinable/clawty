import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INCREMENTAL_CONTEXT_MAX_PATHS = 40;
const DEFAULT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS = 12_000;
const DEFAULT_INCREMENTAL_CONTEXT_TIMEOUT_MS = 3000;

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
