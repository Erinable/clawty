import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLocalToolHandlers } from "../src/tool-local-handlers.js";
import {
  extractPatchedFiles,
  isBlockedCommand,
  resolveSafePath,
  truncate
} from "../src/tool-guards.js";
import {
  createWorkspace,
  removeWorkspace
} from "./helpers/workspace.js";

function createContext(workspaceRoot) {
  return {
    workspaceRoot,
    defaultTimeoutMs: 30_000
  };
}

test("createLocalToolHandlers read_file/write_file keep workspace safety and truncation", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const handlers = createLocalToolHandlers({
    path,
    fs,
    os,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    execFileAsync: async () => ({ stdout: "", stderr: "" }),
    maxToolText: 5,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable: () => "/bin/sh",
    extractPatchedFiles
  });
  const context = createContext(workspaceRoot);

  const writeResult = await handlers.write_file(
    { path: "src/local.txt", content: "abcdef" },
    context
  );
  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.bytes, 6);

  const readResult = await handlers.read_file({ path: "src/local.txt" }, context);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.path, "src/local.txt");
  assert.match(readResult.content, /\.\.\.\[truncated 1 chars\]/);

  await assert.rejects(
    () => handlers.read_file({ path: "../outside.txt" }, context),
    /Path escapes workspace root/
  );
});

test("createLocalToolHandlers run_shell blocks dangerous commands before exec", async () => {
  let execCalled = false;
  const handlers = createLocalToolHandlers({
    path,
    fs,
    os,
    execAsync: async () => {
      execCalled = true;
      return { stdout: "", stderr: "" };
    },
    execFileAsync: async () => ({ stdout: "", stderr: "" }),
    maxToolText: 100,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable: () => "/bin/sh",
    extractPatchedFiles
  });

  const blocked = await handlers.run_shell(
    { command: "rm -rf /tmp/forbidden" },
    { workspaceRoot: "/tmp/none", defaultTimeoutMs: 1000 }
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(execCalled, false);
});

test("createLocalToolHandlers run_shell forwards timeout and shell config", async () => {
  let captured = null;
  const handlers = createLocalToolHandlers({
    path,
    fs,
    os,
    execAsync: async (command, options) => {
      captured = { command, options };
      return { stdout: "ok", stderr: "" };
    },
    execFileAsync: async () => ({ stdout: "", stderr: "" }),
    maxToolText: 100,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable: () => "/bin/custom-shell",
    extractPatchedFiles
  });

  const result = await handlers.run_shell(
    { command: "echo hi", timeout_ms: 4321 },
    { workspaceRoot: "/tmp/demo", defaultTimeoutMs: 1111 }
  );
  assert.equal(result.ok, true);
  assert.equal(captured.command, "echo hi");
  assert.equal(captured.options.timeout, 4321);
  assert.equal(captured.options.shell, "/bin/custom-shell");
  assert.equal(captured.options.cwd, "/tmp/demo");
});

test("createLocalToolHandlers apply_patch validates empty patch early", async () => {
  const handlers = createLocalToolHandlers({
    path,
    fs,
    os,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    execFileAsync: async () => ({ stdout: "", stderr: "" }),
    maxToolText: 100,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable: () => "/bin/sh",
    extractPatchedFiles
  });

  const result = await handlers.apply_patch(
    { patch: "   " },
    { workspaceRoot: "/tmp/demo", defaultTimeoutMs: 1000 }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /non-empty string/);
});

test("createLocalToolHandlers apply_patch returns parsed files and cleans temp patch", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  let patchPath = null;
  const handlers = createLocalToolHandlers({
    path,
    fs,
    os,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    execFileAsync: async (command, gitArgs) => {
      assert.equal(command, "git");
      assert.ok(gitArgs.includes("--check"));
      patchPath = gitArgs[gitArgs.length - 1];
      assert.match(patchPath, /change\.patch$/);
      return { stdout: "checked", stderr: "" };
    },
    maxToolText: 100,
    resolveSafePath,
    truncate,
    isBlockedCommand,
    resolveRunShellExecutable: () => "/bin/sh",
    extractPatchedFiles
  });

  const patch = [
    "diff --git a/src/value.js b/src/value.js",
    "--- a/src/value.js",
    "+++ b/src/value.js",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
    ""
  ].join("\n");

  const result = await handlers.apply_patch({ patch, check: true }, createContext(workspaceRoot));
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["src/value.js"]);
  assert.equal(result.checked, true);
  await assert.rejects(() => fs.stat(patchPath), /ENOENT/);
});
