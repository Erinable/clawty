import path from "node:path";
import { existsSync } from "node:fs";

export const DEFAULT_MAX_TOOL_TEXT = 100_000;

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/i
];

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function truncate(text, maxChars = DEFAULT_MAX_TOOL_TEXT) {
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

export function isBlockedCommand(command) {
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function resolveRunShellExecutable({
  platform = process.platform,
  env = process.env,
  pathExists = existsSync
} = {}) {
  if (platform === "win32") {
    const comSpec = typeof env?.ComSpec === "string" ? env.ComSpec.trim() : "";
    return comSpec || "cmd.exe";
  }

  const candidateShells = [];
  if (typeof env?.SHELL === "string" && env.SHELL.trim().length > 0) {
    candidateShells.push(env.SHELL.trim());
  }
  candidateShells.push("/bin/zsh", "/bin/bash", "/bin/sh");

  for (const shellPath of candidateShells) {
    if (!shellPath) {
      continue;
    }
    if (!path.isAbsolute(shellPath)) {
      return shellPath;
    }
    if (pathExists(shellPath)) {
      return shellPath;
    }
  }

  return "/bin/sh";
}

function normalizePatchPath(rawPath) {
  if (!rawPath || rawPath === "/dev/null") {
    return null;
  }
  let clean = rawPath.trim().split(/\s+/)[0];
  if (clean.startsWith("a/") || clean.startsWith("b/")) {
    clean = clean.slice(2);
  }
  return clean;
}

function assertSafePatchPath(filePath) {
  if (!filePath) {
    return;
  }
  if (filePath.includes("\0")) {
    throw new Error(`Invalid patch path: ${filePath}`);
  }
  if (path.isAbsolute(filePath) || filePath.startsWith("~")) {
    throw new Error(`Patch path must be workspace-relative: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Patch path escapes workspace root: ${filePath}`);
  }
}

export function extractPatchedFiles(patch) {
  const files = new Set();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }
    const filePath = normalizePatchPath(line.slice(4));
    if (!filePath) {
      continue;
    }
    assertSafePatchPath(filePath);
    files.add(filePath);
  }
  return Array.from(files);
}
