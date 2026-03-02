import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createWorkspace(prefix = "clawty-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeWorkspace(workspaceRoot) {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}

export async function writeWorkspaceFile(workspaceRoot, relativePath, content) {
  const fullPath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

export async function readWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = path.join(workspaceRoot, relativePath);
  return fs.readFile(fullPath, "utf8");
}

export async function initGitRepo(workspaceRoot) {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
}
