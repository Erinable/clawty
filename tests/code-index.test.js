import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  buildCodeIndex,
  getIndexStats,
  queryCodeIndex,
  refreshCodeIndex
} from "../src/code-index.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

test("buildCodeIndex builds index and queryCodeIndex returns ranked matches", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/main.js",
    "function applyPatch() { return 'ok'; }\nconst refreshIndex = true;\n"
  );
  await writeWorkspaceFile(workspaceRoot, "docs/guide.md", "Refresh index documentation.\n");
  await writeWorkspaceFile(workspaceRoot, "src/binary.js", "abc\0def");
  await writeWorkspaceFile(workspaceRoot, "src/big.js", "x".repeat(2048));
  await writeWorkspaceFile(workspaceRoot, "node_modules/pkg/index.js", "ignored = true;\n");

  const build = await buildCodeIndex(workspaceRoot, {
    max_files: 100,
    max_file_size_kb: 1
  });

  assert.equal(build.ok, true);
  assert.equal(build.mode, "full");
  assert.equal(build.discovered_files, 4);
  assert.equal(build.indexed_files, 2);
  assert.equal(build.skipped_large_files, 1);
  assert.equal(build.skipped_binary_files, 1);
  assert.match(build.index_path, /^\.clawty\/index\.db$/);

  const indexPath = path.join(workspaceRoot, build.index_path);
  await fs.access(indexPath);
  const db = new DatabaseSync(indexPath);
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM files").get();
  assert.equal(Number(countRow.count), 2);
  db.close();

  const query = await queryCodeIndex(workspaceRoot, {
    query: "applyPatch refreshIndex",
    top_k: 5
  });

  assert.equal(query.ok, true);
  assert.ok(query.total_hits >= 1);
  assert.equal(query.results[0].path, "src/main.js");
  assert.match(query.results[0].snippet, /^\d+:/m);
});

test("queryCodeIndex supports path/language filters and explain mode", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/indexer.js",
    "export function indexTokenCore() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/indexer.md",
    "indexTokenCore is mentioned in docs.\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const filteredByPath = await queryCodeIndex(workspaceRoot, {
    query: "indexTokenCore",
    path_prefix: "docs",
    top_k: 5
  });
  assert.equal(filteredByPath.ok, true);
  assert.ok(filteredByPath.results.length >= 1);
  assert.ok(filteredByPath.results.every((item) => item.path.startsWith("docs/")));

  const filteredByLanguage = await queryCodeIndex(workspaceRoot, {
    query: "indexTokenCore",
    language: "javascript",
    top_k: 5
  });
  assert.equal(filteredByLanguage.ok, true);
  assert.ok(filteredByLanguage.results.length >= 1);
  assert.ok(filteredByLanguage.results.every((item) => item.path.endsWith(".js")));

  const explained = await queryCodeIndex(workspaceRoot, {
    query: "indexTokenCore",
    language: "javascript",
    explain: true,
    top_k: 1
  });
  assert.equal(explained.ok, true);
  assert.equal(explained.results.length, 1);
  assert.ok(explained.results[0].explain);
  assert.ok(typeof explained.results[0].explain.chunk_match_count === "number");
  assert.ok(typeof explained.results[0].explain.score_breakdown.chunk_score === "number");
});

test("refreshCodeIndex performs incremental update for changed and deleted files", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/a.js", "const alpha = 1;\n");
  await writeWorkspaceFile(workspaceRoot, "src/b.js", "const beta = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  const noChange = await refreshCodeIndex(workspaceRoot, {});
  assert.equal(noChange.mode, "incremental");
  assert.equal(noChange.reused_files, 2);
  assert.equal(noChange.reindexed_files, 0);
  assert.equal(noChange.removed_files, 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeWorkspaceFile(workspaceRoot, "src/a.js", "const alpha = 42;\nconst changed = true;\n");

  const changed = await refreshCodeIndex(workspaceRoot, {});
  assert.equal(changed.mode, "incremental");
  assert.equal(changed.reused_files, 1);
  assert.equal(changed.reindexed_files, 1);
  assert.equal(changed.removed_files, 0);

  await fs.rm(path.join(workspaceRoot, "src/b.js"), { force: true });
  const deleted = await refreshCodeIndex(workspaceRoot, {});
  assert.equal(deleted.mode, "incremental");
  assert.equal(deleted.removed_files, 1);
});

test("refreshCodeIndex falls back to full build when index is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/new.js", "export const value = 1;\n");
  const refreshed = await refreshCodeIndex(workspaceRoot, {});

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "full");
  assert.equal(refreshed.fallback_full_rebuild, true);
  assert.equal(refreshed.indexed_files, 1);
});

test("queryCodeIndex returns clear error when index is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const query = await queryCodeIndex(workspaceRoot, { query: "anything" });
  assert.equal(query.ok, false);
  assert.match(query.error, /build_code_index/);
});

test("refreshCodeIndex supports event-driven changed_paths and deleted_paths", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/a.js", "const alpha = 1;\n");
  await writeWorkspaceFile(workspaceRoot, "src/b.js", "const beta = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  await writeWorkspaceFile(workspaceRoot, "src/a.js", "const alpha = 2;\nconst changed = true;\n");
  await writeWorkspaceFile(workspaceRoot, "src/c.js", "const gamma = 3;\n");
  await fs.rm(path.join(workspaceRoot, "src/b.js"), { force: true });

  const refreshed = await refreshCodeIndex(workspaceRoot, {
    changed_paths: ["src/a.js", "src/c.js"],
    deleted_paths: ["src/b.js"]
  });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "event");
  assert.equal(refreshed.incremental, true);
  assert.equal(refreshed.reindexed_files, 2);
  assert.equal(refreshed.removed_files, 1);
  assert.equal(refreshed.discovered_files, 3);
});

test("getIndexStats returns index aggregates and language distribution", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/main.js", "function hello() { return true; }\n");
  await writeWorkspaceFile(workspaceRoot, "scripts/helper.py", "def helper():\n    return 1\n");
  await buildCodeIndex(workspaceRoot, {});

  const stats = await getIndexStats(workspaceRoot, { top_files: 5 });
  assert.equal(stats.ok, true);
  assert.match(stats.index_path, /^\.clawty\/index\.db$/);
  assert.equal(stats.engine, "sqlite_fts5");
  assert.ok(stats.counts.files >= 2);
  assert.ok(stats.counts.chunks >= 2);
  assert.ok(stats.counts.unique_tokens > 0);
  assert.ok(Array.isArray(stats.languages));
  assert.ok(stats.languages.some((item) => item.language === "javascript"));
  assert.ok(Array.isArray(stats.top_files));
});
