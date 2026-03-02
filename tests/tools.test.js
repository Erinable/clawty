import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";
import {
  createWorkspace,
  initGitRepo,
  readWorkspaceFile,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function createContext(workspaceRoot) {
  return {
    workspaceRoot,
    defaultTimeoutMs: 30_000
  };
}

test("read_file and write_file work inside workspace", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const write = await runTool(
    "write_file",
    { path: "src/demo.js", content: "export const demo = 1;\n" },
    context
  );
  assert.equal(write.ok, true);
  assert.equal(write.path, "src/demo.js");

  const read = await runTool("read_file", { path: "src/demo.js" }, context);
  assert.equal(read.ok, true);
  assert.match(read.content, /demo = 1/);
});

test("file tools reject path traversal outside workspace", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  await assert.rejects(
    () => runTool("read_file", { path: "../outside.js" }, context),
    /Path escapes workspace root/
  );
});

test("run_shell blocks dangerous commands", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const blocked = await runTool("run_shell", { command: "rm -rf /tmp/test" }, context);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
});

test("run_shell executes safe commands", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const context = createContext(workspaceRoot);
  const output = await runTool("run_shell", { command: "echo clawty-test" }, context);
  assert.equal(output.ok, true);
  assert.equal(output.exit_code, 0);
  assert.match(output.stdout, /clawty-test/);
});

test("apply_patch supports check-only and apply modes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await initGitRepo(workspaceRoot);
  await writeWorkspaceFile(workspaceRoot, "src/value.js", "const value = 1;\n");

  const patch = [
    "diff --git a/src/value.js b/src/value.js",
    "--- a/src/value.js",
    "+++ b/src/value.js",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
    ""
  ].join("\n");

  const context = createContext(workspaceRoot);
  const checked = await runTool("apply_patch", { patch, check: true }, context);
  assert.equal(checked.ok, true);
  assert.equal(checked.checked, true);

  const before = await readWorkspaceFile(workspaceRoot, "src/value.js");
  assert.match(before, /value = 1/);

  const applied = await runTool("apply_patch", { patch }, context);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.files, ["src/value.js"]);

  const after = await readWorkspaceFile(workspaceRoot, "src/value.js");
  assert.match(after, /value = 2/);
});

test("apply_patch rejects unsafe absolute patch paths", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await initGitRepo(workspaceRoot);
  const context = createContext(workspaceRoot);
  const patch = [
    "diff --git a/src/value.js b/src/value.js",
    "--- a/src/value.js",
    "+++ /tmp/hack.js",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
    ""
  ].join("\n");

  await assert.rejects(
    () => runTool("apply_patch", { patch }, context),
    /workspace-relative/
  );
});

test("index tools are callable through runTool", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/indexable.js", "const symbolAlpha = true;\n");
  const context = createContext(workspaceRoot);

  const built = await runTool("build_code_index", {}, context);
  assert.equal(built.ok, true);

  const refreshed = await runTool("refresh_code_index", {}, context);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "incremental");

  const queried = await runTool("query_code_index", { query: "symbolAlpha", top_k: 1 }, context);
  assert.equal(queried.ok, true);
  assert.equal(queried.results[0].path, "src/indexable.js");

  const queriedWithExplain = await runTool(
    "query_code_index",
    {
      query: "symbolAlpha",
      language: "javascript",
      path_prefix: "src",
      explain: true,
      top_k: 1
    },
    context
  );
  assert.equal(queriedWithExplain.ok, true);
  assert.ok(queriedWithExplain.results[0].explain);

  const eventRefreshed = await runTool(
    "refresh_code_index",
    { changed_paths: ["src/indexable.js"], deleted_paths: ["src/missing.js"] },
    context
  );
  assert.equal(eventRefreshed.ok, true);
  assert.equal(eventRefreshed.mode, "event");

  const stats = await runTool("get_index_stats", { top_files: 3 }, context);
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.files >= 1);
});
