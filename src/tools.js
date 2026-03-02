import path from "node:path";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const MAX_TOOL_TEXT = 100_000;

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/i
];

function truncate(text, maxChars = MAX_TOOL_TEXT) {
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function isBlockedCommand(command) {
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        max_chars: {
          type: "integer",
          description: "Optional max chars in output.",
          minimum: 100,
          maximum: 200000
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 text file to workspace (overwrite if exists).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        content: { type: "string", description: "Full file content." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_shell",
    description: "Run a shell command in workspace root with timeout and output capture.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
          minimum: 1000,
          maximum: 300000
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

async function readFileTool(args, context) {
  const maxChars = Number.isFinite(args.max_chars) ? args.max_chars : MAX_TOOL_TEXT;
  const filePath = resolveSafePath(context.workspaceRoot, args.path);
  const content = await fs.readFile(filePath, "utf8");
  return {
    ok: true,
    path: path.relative(context.workspaceRoot, filePath),
    content: truncate(content, maxChars)
  };
}

async function writeFileTool(args, context) {
  const filePath = resolveSafePath(context.workspaceRoot, args.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, args.content, "utf8");
  return {
    ok: true,
    path: path.relative(context.workspaceRoot, filePath),
    bytes: Buffer.byteLength(args.content, "utf8")
  };
}

async function runShellTool(args, context) {
  if (isBlockedCommand(args.command)) {
    return {
      ok: false,
      blocked: true,
      reason: "Blocked potentially destructive command by policy."
    };
  }

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: context.workspaceRoot,
      timeout: args.timeout_ms || context.defaultTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: "/bin/zsh"
    });
    return {
      ok: true,
      exit_code: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: Number.isInteger(error.code) ? error.code : 1,
      stdout: truncate(error.stdout || ""),
      stderr: truncate(error.stderr || error.message || "")
    };
  }
}

export async function runTool(name, args, context) {
  if (name === "read_file") {
    return readFileTool(args, context);
  }
  if (name === "write_file") {
    return writeFileTool(args, context);
  }
  if (name === "run_shell") {
    return runShellTool(args, context);
  }
  throw new Error(`Unknown tool: ${name}`);
}
