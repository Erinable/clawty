import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildCodeIndex, refreshCodeIndex } from "../src/code-index.js";
import {
  buildSyntaxIndex,
  refreshSyntaxIndex,
  getSyntaxIndexStats,
  querySyntaxIndex
} from "../src/syntax-index.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

test("syntax index tools report clear error when code index is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const built = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(built.ok, false);
  assert.match(String(built.error), /build_code_index/i);

  const refreshed = await refreshSyntaxIndex(workspaceRoot, {});
  assert.equal(refreshed.ok, false);
  assert.match(String(refreshed.error), /build_code_index/i);

  const stats = await getSyntaxIndexStats(workspaceRoot, {});
  assert.equal(stats.ok, false);
  assert.match(String(stats.error), /build_code_index/i);

  const query = await querySyntaxIndex(workspaceRoot, { query: "demo" });
  assert.equal(query.ok, false);
  assert.match(String(query.error), /build_code_index/i);
});

test("buildSyntaxIndex extracts import and call edges", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/main.js",
    [
      "import { depCall } from './dep.js';",
      "const fs = require('node:fs');",
      "export function runMain() {",
      "  depCall();",
      "  return fs.existsSync('.');",
      "}",
      ""
    ].join("\n")
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/dep.js",
    "export function depCall() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/helper.py",
    ["from pkg.mod import util", "import os", "def run_py():", "    util.run()", ""].join("\n")
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSyntaxIndex(workspaceRoot, {
    max_files: 50,
    max_calls_per_file: 30
  });
  assert.equal(built.ok, true);
  assert.equal(built.mode, "full");
  assert.ok(built.parsed_files >= 3);
  assert.ok(built.total_import_edges >= 4);
  assert.ok(built.total_call_edges >= 2);

  const stats = await getSyntaxIndexStats(workspaceRoot, { top_files: 5 });
  assert.equal(stats.ok, true);
  assert.ok(["tree-sitter-skeleton", "tree-sitter"].includes(stats.provider));
  assert.ok(stats.counts.files >= 3);
  assert.ok(stats.counts.import_edges >= 4);
  assert.ok(stats.top_imported.some((item) => item.imported_path === "pkg:node:fs"));
  assert.equal(stats.latest_run.mode, "full");
});

test("buildSyntaxIndex supports tree-sitter provider request with fallback/strict modes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/provider.ts",
    "import { depToken } from './dep';\nexport function providerToken() { return depToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/dep.ts",
    "export function depToken() { return true; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const requested = await buildSyntaxIndex(workspaceRoot, {
    parser_provider: "tree-sitter"
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.parser.requested, "tree-sitter");
  assert.ok(["tree-sitter-skeleton", "tree-sitter"].includes(requested.provider));

  const strict = await buildSyntaxIndex(workspaceRoot, {
    parser_provider: "tree-sitter",
    parser_strict: true
  });
  if (strict.ok) {
    assert.equal(strict.provider, "tree-sitter");
  } else {
    assert.match(String(strict.error), /tree-sitter parser unavailable/i);
  }
});

test("buildSyntaxIndex defaults parser_provider to auto", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/default-auto.ts",
    "export function defaultAutoToken() { return true; }\n"
  );
  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(built.ok, true);
  assert.equal(built.parser.requested, "auto");
  assert.ok(["tree-sitter-skeleton", "tree-sitter"].includes(built.provider));
  const providerCounts = built.parser.provider_counts || {};
  assert.ok(Object.keys(providerCounts).length >= 1);
});

test("parser summary actual provider is resolved from counts (not last file)", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/resolve-provider.ts",
    "export function resolveProviderToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/readme.custom.md",
    "# Title\nsome markdown content\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);

  const built = await buildSyntaxIndex(workspaceRoot, {
    parser_provider: "auto",
    max_files: 20
  });
  assert.equal(built.ok, true);
  const treeCount = Number(built.parser.provider_counts["tree-sitter"] || 0);
  const skeletonCount = Number(built.parser.provider_counts["tree-sitter-skeleton"] || 0);
  if (treeCount > skeletonCount) {
    assert.equal(built.provider, "tree-sitter");
  } else if (skeletonCount > treeCount) {
    assert.equal(built.provider, "tree-sitter-skeleton");
  } else if (treeCount > 0) {
    assert.equal(built.provider, "tree-sitter");
  } else {
    assert.equal(built.provider, "tree-sitter-skeleton");
  }
});

test("querySyntaxIndex returns structural neighbors and supports filters", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/core/main.ts",
    "import { helperToken } from './helper';\nexport function runToken() { return helperToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/core/helper.ts",
    "export function helperToken() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/feature/other.ts",
    "export function otherToken() { return 1; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);
  const built = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(built.ok, true);

  const query = await querySyntaxIndex(workspaceRoot, {
    query: "runToken",
    top_k: 3,
    max_neighbors: 5,
    path_prefix: "src/core"
  });
  assert.equal(query.ok, true);
  assert.equal(query.query, "runToken");
  assert.ok(query.total_seeds >= 1);
  assert.ok(query.scanned_candidates >= 1);
  assert.ok(query.seeds.every((seed) => seed.path.startsWith("src/core/")));
  assert.ok(query.seeds[0].outgoing_imports.length >= 1);
  assert.ok(query.seeds[0].outgoing_calls.length >= 1);
  assert.ok(Array.isArray(query.seeds[0].incoming_importers));
  assert.ok(Array.isArray(query.seeds[0].incoming_callers));
});

test("refreshSyntaxIndex supports incremental and event modes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/a.js",
    "import { b } from './b.js';\nexport function a() { return b(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/b.js",
    "export function b() { return true; }\n"
  );

  const indexed = await buildCodeIndex(workspaceRoot, {});
  assert.equal(indexed.ok, true);
  const built = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(built.ok, true);

  const refreshedIncremental = await refreshSyntaxIndex(workspaceRoot, {});
  assert.equal(refreshedIncremental.ok, true);
  assert.equal(refreshedIncremental.mode, "incremental");
  assert.ok(refreshedIncremental.reused_files >= 2);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/a.js",
    "import { c } from './c.js';\nexport function a() { return c(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/c.js",
    "export function c() { return true; }\n"
  );

  const refreshedIndexEvent = await refreshCodeIndex(workspaceRoot, {
    changed_paths: ["src/a.js", "src/c.js"]
  });
  assert.equal(refreshedIndexEvent.ok, true);

  const refreshedEvent = await refreshSyntaxIndex(workspaceRoot, {
    changed_paths: ["src/a.js", "src/c.js"]
  });
  assert.equal(refreshedEvent.ok, true);
  assert.equal(refreshedEvent.mode, "event");
  assert.ok(refreshedEvent.parsed_files >= 2);

  await fs.rm(`${workspaceRoot}/src/b.js`, { force: true });
  const refreshedIndexDelete = await refreshCodeIndex(workspaceRoot, {
    deleted_paths: ["src/b.js"]
  });
  assert.equal(refreshedIndexDelete.ok, true);

  const refreshedDelete = await refreshSyntaxIndex(workspaceRoot, {
    deleted_paths: ["src/b.js"]
  });
  assert.equal(refreshedDelete.ok, true);
  assert.equal(refreshedDelete.mode, "event");
  assert.ok(refreshedDelete.removed_files >= 1);
});
