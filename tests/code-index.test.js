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
  assert.equal(query.cache_hit, false);
  assert.ok(query.total_hits >= 1);
  assert.equal(query.results[0].path, "src/main.js");
  assert.match(query.results[0].snippet, /^\d+:/m);
  assert.ok(query.candidate_limits.chunks >= 40);
  assert.ok(query.candidate_limits.symbols >= 80);

  const cachedQuery = await queryCodeIndex(workspaceRoot, {
    query: "applyPatch refreshIndex",
    top_k: 5
  });
  assert.equal(cachedQuery.ok, true);
  assert.equal(cachedQuery.cache_hit, true);
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
  assert.equal(filteredByPath.filters.path_prefix, "docs/");
  assert.ok(filteredByPath.results.length >= 1);
  assert.ok(filteredByPath.results.every((item) => item.path.startsWith("docs/")));

  const filteredByLanguage = await queryCodeIndex(workspaceRoot, {
    query: "indexTokenCore",
    language: "javascript",
    top_k: 5
  });
  assert.equal(filteredByLanguage.ok, true);
  assert.equal(filteredByLanguage.filters.language, "javascript");
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

test("queryCodeIndex validates query input and clamps top_k", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/main.js",
    "const alphaToken = 1;\nfunction alphaTokenFn() { return alphaToken; }\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const emptyQuery = await queryCodeIndex(workspaceRoot, { query: "   " });
  assert.equal(emptyQuery.ok, false);
  assert.match(emptyQuery.error, /non-empty string/i);

  const noTokenQuery = await queryCodeIndex(workspaceRoot, { query: "++ -- !!" });
  assert.equal(noTokenQuery.ok, false);
  assert.match(noTokenQuery.error, /no indexable tokens/i);

  const clamped = await queryCodeIndex(workspaceRoot, {
    query: "alphaToken",
    top_k: 999
  });
  assert.equal(clamped.ok, true);
  assert.ok(clamped.results.length <= 50);
  assert.equal(clamped.candidate_limits.chunks, 571);
  assert.equal(clamped.candidate_limits.symbols, 820);
});

test("queryCodeIndex cache expires after TTL", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/cache.js", "const cacheToken = true;\n");
  await buildCodeIndex(workspaceRoot, {});

  const originalNow = Date.now;
  let fakeNow = originalNow();
  Date.now = () => fakeNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const first = await queryCodeIndex(workspaceRoot, { query: "cacheToken", top_k: 5 });
  assert.equal(first.ok, true);
  assert.equal(first.cache_hit, false);

  const second = await queryCodeIndex(workspaceRoot, { query: "cacheToken", top_k: 5 });
  assert.equal(second.ok, true);
  assert.equal(second.cache_hit, true);

  fakeNow += 10_001;
  const third = await queryCodeIndex(workspaceRoot, { query: "cacheToken", top_k: 5 });
  assert.equal(third.ok, true);
  assert.equal(third.cache_hit, false);
});

test("buildCodeIndex and refreshCodeIndex invalidate query cache", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/cache-refresh.js", "const refreshToken = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  const warm1 = await queryCodeIndex(workspaceRoot, { query: "refreshToken", top_k: 5 });
  assert.equal(warm1.ok, true);
  assert.equal(warm1.cache_hit, false);

  const warm2 = await queryCodeIndex(workspaceRoot, { query: "refreshToken", top_k: 5 });
  assert.equal(warm2.ok, true);
  assert.equal(warm2.cache_hit, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeWorkspaceFile(
    workspaceRoot,
    "src/cache-refresh.js",
    "const refreshToken = 2;\nconst changed = true;\n"
  );
  const refreshed = await refreshCodeIndex(workspaceRoot, {});
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "incremental");

  const afterRefresh = await queryCodeIndex(workspaceRoot, { query: "refreshToken", top_k: 5 });
  assert.equal(afterRefresh.ok, true);
  assert.equal(afterRefresh.cache_hit, false);

  await buildCodeIndex(workspaceRoot, {});
  const afterBuild = await queryCodeIndex(workspaceRoot, { query: "refreshToken", top_k: 5 });
  assert.equal(afterBuild.ok, true);
  assert.equal(afterBuild.cache_hit, false);
});

test("refreshCodeIndex supports string force_rebuild and false-like value", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/rebuild.js", "const rebuild = true;\n");
  await buildCodeIndex(workspaceRoot, {});

  const rebuilt = await refreshCodeIndex(workspaceRoot, { force_rebuild: "true" });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.mode, "full");
  assert.equal(rebuilt.fallback_full_rebuild, false);

  const incremental = await refreshCodeIndex(workspaceRoot, { force_rebuild: "0" });
  assert.equal(incremental.ok, true);
  assert.equal(incremental.mode, "incremental");
  assert.ok(incremental.reused_files >= 1);
});

test("refreshCodeIndex rejects event paths that escape workspace root", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/safe.js", "const safe = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  await assert.rejects(
    () =>
      refreshCodeIndex(workspaceRoot, {
        changed_paths: ["../evil.js"],
        deleted_paths: []
      }),
    /Path escapes workspace root/i
  );
});

test("event refresh removes file when changed file becomes binary", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/binary-target.js", "const binaryToken = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  await writeWorkspaceFile(workspaceRoot, "src/binary-target.js", "abc\0def");
  const refreshed = await refreshCodeIndex(workspaceRoot, {
    changed_paths: ["src/binary-target.js"],
    deleted_paths: []
  });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "event");
  assert.equal(refreshed.skipped_binary_files, 1);
  assert.equal(refreshed.removed_files, 1);
  assert.equal(refreshed.indexed_files, 0);

  const query = await queryCodeIndex(workspaceRoot, { query: "binaryToken" });
  assert.equal(query.ok, false);
  assert.match(query.error, /index is empty/i);
});

test("queryCodeIndex reports empty index when DB exists without indexed chunks", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const built = await buildCodeIndex(workspaceRoot, {});
  assert.equal(built.ok, true);
  assert.equal(built.indexed_files, 0);

  const query = await queryCodeIndex(workspaceRoot, { query: "anything" });
  assert.equal(query.ok, false);
  assert.match(query.error, /index is empty/i);
});

test("queryCodeIndex evicts oldest cache entries when cache reaches max size", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/cache-evict.js", "const keepToken = true;\n");
  await buildCodeIndex(workspaceRoot, {});

  const first = await queryCodeIndex(workspaceRoot, { query: "keepToken", top_k: 5 });
  assert.equal(first.ok, true);
  assert.equal(first.cache_hit, false);

  for (let i = 0; i < 210; i += 1) {
    const result = await queryCodeIndex(workspaceRoot, {
      query: `token${i}`,
      top_k: 5
    });
    assert.equal(result.ok, true);
  }

  const afterEviction = await queryCodeIndex(workspaceRoot, { query: "keepToken", top_k: 5 });
  assert.equal(afterEviction.ok, true);
  assert.equal(afterEviction.cache_hit, false);
});

test("event refresh handles mixed changed paths and large files", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/base.js", "const baseToken = 1;\n");
  await writeWorkspaceFile(workspaceRoot, "src/huge.js", "x".repeat(4096));
  await buildCodeIndex(workspaceRoot, { max_file_size_kb: 8 });

  const refreshed = await refreshCodeIndex(workspaceRoot, {
    changed_paths: [123, "", "node_modules/pkg/index.js", "src/missing.js", "src/huge.js"],
    deleted_paths: [null],
    max_file_size_kb: 1
  });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, "event");
  assert.equal(refreshed.incremental, true);
  assert.equal(refreshed.skipped_large_files, 1);
  assert.equal(refreshed.reindexed_files, 0);
  assert.equal(refreshed.removed_files, 1);
  assert.ok(refreshed.changed_paths.includes("node_modules/pkg/index.js"));
  assert.ok(refreshed.changed_paths.includes("src/missing.js"));
  assert.ok(refreshed.changed_paths.includes("src/huge.js"));

  const query = await queryCodeIndex(workspaceRoot, { query: "baseToken" });
  assert.equal(query.ok, true);
  assert.ok(query.results.some((item) => item.path === "src/base.js"));
});

test("buildCodeIndex indexes extension families for language buckets", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/model.js", "export class Car {}\n");
  await writeWorkspaceFile(workspaceRoot, "src/util.py", "def helper():\n    return 1\n");
  await writeWorkspaceFile(workspaceRoot, "src/worker.go", "func RunTask() {}\n");
  await writeWorkspaceFile(workspaceRoot, "src/app.kt", "class App\n");
  await writeWorkspaceFile(workspaceRoot, "src/native.rs", "fn main() {}\n");
  await writeWorkspaceFile(workspaceRoot, "src/empty.js", "");

  const build = await buildCodeIndex(workspaceRoot, {});
  assert.equal(build.ok, true);
  assert.ok(build.indexed_files >= 6);

  const stats = await getIndexStats(workspaceRoot, {});
  assert.equal(stats.ok, true);
  assert.ok(stats.languages.some((item) => item.language === "javascript"));
  assert.ok(stats.languages.some((item) => item.language === "python"));
  assert.ok(stats.languages.some((item) => item.language === "go"));
  assert.ok(stats.languages.some((item) => item.language === "jvm"));
  assert.ok(stats.languages.some((item) => item.language === "systems"));
});

test("getIndexStats handles missing index and invalid stored config JSON", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const missing = await getIndexStats(workspaceRoot, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /build_code_index/i);

  await writeWorkspaceFile(workspaceRoot, "src/main.js", "const statsToken = true;\n");
  const built = await buildCodeIndex(workspaceRoot, {});
  assert.equal(built.ok, true);

  const db = new DatabaseSync(path.join(workspaceRoot, ".clawty/index.db"));
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{", "config");
  db.close();

  const stats = await getIndexStats(workspaceRoot, {});
  assert.equal(stats.ok, true);
  assert.deepEqual(stats.config, {});
});

test("refreshCodeIndex supports boolean force_rebuild values", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/force.js", "const forceValue = 1;\n");
  await buildCodeIndex(workspaceRoot, {});

  const full = await refreshCodeIndex(workspaceRoot, { force_rebuild: true });
  assert.equal(full.ok, true);
  assert.equal(full.mode, "full");

  const incremental = await refreshCodeIndex(workspaceRoot, { force_rebuild: false });
  assert.equal(incremental.ok, true);
  assert.equal(incremental.mode, "incremental");
});

test("queryCodeIndex applies layered candidate strategy and records query metrics", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/services/user-service.js",
    "export function createUserProfile(payload) { return payload; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/user-guide.md",
    "create user profile workflow guide and troubleshooting.\n"
  );
  await buildCodeIndex(workspaceRoot, {});

  const focused = await queryCodeIndex(workspaceRoot, {
    query: "createUserProfile",
    top_k: 8
  });
  assert.equal(focused.ok, true);
  assert.equal(focused.candidate_profile, "symbol_focused");
  assert.equal(typeof focused.query_time_ms, "number");
  assert.equal(focused.cache_hit, false);

  const broad = await queryCodeIndex(workspaceRoot, {
    query: "create user profile workflow guide",
    top_k: 8
  });
  assert.equal(broad.ok, true);
  assert.equal(broad.candidate_profile, "semantic_broad");
  assert.equal(typeof broad.query_time_ms, "number");
  assert.ok(broad.candidate_limits.chunks > focused.candidate_limits.chunks);
  assert.ok(broad.candidate_limits.symbols < focused.candidate_limits.symbols);

  const cachedFocused = await queryCodeIndex(workspaceRoot, {
    query: "createUserProfile",
    top_k: 8
  });
  assert.equal(cachedFocused.ok, true);
  assert.equal(cachedFocused.cache_hit, true);

  const noHits = await queryCodeIndex(workspaceRoot, {
    query: "totallyNotFoundTokenForQueryMetrics",
    top_k: 5
  });
  assert.equal(noHits.ok, true);
  assert.equal(noHits.total_hits, 0);

  const stats = await getIndexStats(workspaceRoot, {});
  assert.equal(stats.ok, true);
  assert.ok(stats.query_metrics);
  assert.ok(stats.query_metrics.total_queries >= 4);
  assert.ok(stats.query_metrics.cache_hits >= 1);
  assert.ok(stats.query_metrics.cache_misses >= 3);
  assert.ok(stats.query_metrics.cache_hit_rate >= 0);
  assert.ok(stats.query_metrics.cache_hit_rate <= 1);
  assert.ok(stats.query_metrics.zero_hit_queries >= 1);
  assert.equal(typeof stats.query_metrics.avg_latency_ms, "number");
  assert.ok(Array.isArray(stats.query_metrics.recent_slow_queries));
});
