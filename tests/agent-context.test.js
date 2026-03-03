import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  collectIncrementalContext,
  formatIncrementalContextForPrompt,
  normalizeAgentRuntimeConfig
} from "../src/agent.js";
import {
  createWorkspace,
  initGitRepo,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);

async function runGit(workspaceRoot, args) {
  return execFileAsync("git", args, {
    cwd: workspaceRoot,
    timeout: 10_000
  });
}

test("collectIncrementalContext returns not_git_repository when workspace is not git", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = await collectIncrementalContext(workspaceRoot, {});
  assert.equal(context.enabled, true);
  assert.equal(context.available, false);
  assert.equal(context.reason, "not_git_repository");
  assert.equal(context.changed_paths.length, 0);
});

test("collectIncrementalContext captures changed paths and git diff excerpt", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await initGitRepo(workspaceRoot);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Clawty Test"]);

  await writeWorkspaceFile(workspaceRoot, "src/base.js", "export const base = 1;\n");
  await runGit(workspaceRoot, ["add", "."]);
  await runGit(workspaceRoot, ["commit", "-m", "init"]);

  await writeWorkspaceFile(workspaceRoot, "src/base.js", "export const base = 2;\n");
  await writeWorkspaceFile(workspaceRoot, "src/new-file.js", "export const fresh = true;\n");

  const context = await collectIncrementalContext(workspaceRoot, {
    maxPaths: 10,
    maxDiffChars: 4000
  });
  assert.equal(context.enabled, true);
  assert.equal(context.available, true);
  assert.equal(context.has_changes, true);
  assert.ok(context.changed_paths.includes("src/base.js"));
  assert.ok(context.changed_paths.includes("src/new-file.js"));
  assert.ok(context.untracked_paths.includes("src/new-file.js"));
  assert.match(context.diff_excerpt, /src\/base\.js/);

  const promptBlock = formatIncrementalContextForPrompt(context);
  assert.match(promptBlock, /\[workspace_incremental_context\]/);
  assert.match(promptBlock, /changed_paths:/);
  assert.match(promptBlock, /git_diff_unified0:/);
  assert.match(promptBlock, /src\/base\.js/);
});

test("normalizeAgentRuntimeConfig clamps invalid runtime values", () => {
  const normalized = normalizeAgentRuntimeConfig({
    maxToolIterations: -5,
    toolTimeoutMs: Number.NaN
  });
  assert.equal(normalized.maxToolIterations, 8);
  assert.equal(normalized.toolTimeoutMs, 120_000);

  const clamped = normalizeAgentRuntimeConfig({
    maxToolIterations: 1000,
    toolTimeoutMs: 999_999
  });
  assert.equal(clamped.maxToolIterations, 100);
  assert.equal(clamped.toolTimeoutMs, 300_000);
});
