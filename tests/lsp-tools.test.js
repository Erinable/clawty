import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";
import { shutdownAllLspClients } from "../src/lsp-manager.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function createContext(workspaceRoot, lsp = {}) {
  return {
    workspaceRoot,
    defaultTimeoutMs: 30_000,
    lsp
  };
}

function registerCleanup(t, workspaceRoot) {
  t.after(async () => {
    await shutdownAllLspClients();
    await removeWorkspace(workspaceRoot);
  });
}

test("lsp_health reports disabled state", async (t) => {
  const workspaceRoot = await createWorkspace();
  registerCleanup(t, workspaceRoot);

  const context = createContext(workspaceRoot, { enabled: false });
  const health = await runTool("lsp_health", {}, context);

  assert.equal(health.ok, true);
  assert.equal(health.enabled, false);
  assert.match(String(health.reason), /disabled/i);
});

test("lsp_definition falls back to code index when LSP is disabled", async (t) => {
  const workspaceRoot = await createWorkspace();
  registerCleanup(t, workspaceRoot);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/main.ts",
    "export function greet(name: string) { return `hi ${name}`; }\n"
  );

  const context = createContext(workspaceRoot, { enabled: false });
  const built = await runTool("build_code_index", {}, context);
  assert.equal(built.ok, true);

  const result = await runTool(
    "lsp_definition",
    { path: "src/main.ts", line: 1, column: 17 },
    context
  );

  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.provider, "index");
  assert.ok(Array.isArray(result.locations));
  assert.ok(result.locations.length >= 1);
  assert.equal(result.locations[0].path, "src/main.ts");
});

test("lsp_workspace_symbols falls back when LSP command is unavailable", async (t) => {
  const workspaceRoot = await createWorkspace();
  registerCleanup(t, workspaceRoot);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/symbols.ts",
    "export function runToolAlpha() { return true; }\n"
  );

  const context = createContext(workspaceRoot, {
    enabled: true,
    timeoutMs: 1000,
    maxResults: 20,
    tsCommand: "definitely-missing-typescript-lsp --stdio"
  });
  const built = await runTool("build_code_index", {}, context);
  assert.equal(built.ok, true);

  const symbols = await runTool(
    "lsp_workspace_symbols",
    { query: "runToolAlpha", max_results: 5 },
    context
  );

  assert.equal(symbols.ok, true);
  assert.equal(symbols.fallback, true);
  assert.equal(symbols.provider, "index");
  assert.ok(Array.isArray(symbols.results));
  assert.ok(symbols.results.length >= 1);
});

test("lsp_definition rejects unsupported file language", async (t) => {
  const workspaceRoot = await createWorkspace();
  registerCleanup(t, workspaceRoot);

  await writeWorkspaceFile(workspaceRoot, "notes.txt", "plain text\n");

  const context = createContext(workspaceRoot, { enabled: false });
  const result = await runTool(
    "lsp_definition",
    { path: "notes.txt", line: 1, column: 1 },
    context
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported language/i);
});
