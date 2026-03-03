export function createLocalToolHandlers(deps = {}) {
  const {
    path,
    fs,
    os,
    execAsync,
    execFileAsync,
    maxToolText,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable,
    extractPatchedFiles
  } = deps;

  async function readFileTool(args, context) {
    const maxChars = Number.isFinite(args.max_chars) ? args.max_chars : maxToolText;
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
        shell: resolveRunShellExecutable()
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

  async function applyPatchTool(args, context) {
    if (typeof args.patch !== "string" || args.patch.trim().length === 0) {
      return { ok: false, error: "patch must be a non-empty string" };
    }

    const patchedFiles = extractPatchedFiles(args.patch);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawty-patch-"));
    const patchPath = path.join(tempDir, "change.patch");
    await fs.writeFile(patchPath, args.patch, "utf8");

    const gitArgs = ["apply", "--whitespace=nowarn"];
    if (args.check) {
      gitArgs.push("--check");
    }
    gitArgs.push(patchPath);

    try {
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd: context.workspaceRoot,
        timeout: args.timeout_ms || context.defaultTimeoutMs,
        maxBuffer: 4 * 1024 * 1024
      });

      return {
        ok: true,
        checked: Boolean(args.check),
        files: patchedFiles,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      };
    } catch (error) {
      return {
        ok: false,
        checked: Boolean(args.check),
        files: patchedFiles,
        exit_code: Number.isInteger(error.code) ? error.code : 1,
        stdout: truncate(error.stdout || ""),
        stderr: truncate(error.stderr || error.message || "")
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    read_file: readFileTool,
    write_file: writeFileTool,
    run_shell: runShellTool,
    apply_patch: applyPatchTool
  };
}
