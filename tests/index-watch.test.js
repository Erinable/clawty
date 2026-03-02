import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  shouldTrackPath,
  parseWatchCliArgs,
  diffTrackedFiles,
  createDirtyQueueState,
  enqueueDirtyQueue,
  shouldFlushDirtyQueue,
  takeDirtyQueueBatch,
  seedHashCacheFromSnapshot,
  filterChangedPathsByHash,
  refreshIndexesForChanges
} from "../src/index-watch.js";
import { buildCodeIndex, queryCodeIndex } from "../src/code-index.js";
import { buildSyntaxIndex, querySyntaxIndex } from "../src/syntax-index.js";
import { buildSemanticGraph, querySemanticGraph } from "../src/semantic-graph.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

test("shouldTrackPath filters ignored directories and unsupported extensions", () => {
  assert.equal(shouldTrackPath("src/main.ts"), true);
  assert.equal(shouldTrackPath("docs/readme.md"), true);
  assert.equal(shouldTrackPath("node_modules/pkg/index.js"), false);
  assert.equal(shouldTrackPath(".git/hooks/post-commit"), false);
  assert.equal(shouldTrackPath("dist/out.js"), false);
  assert.equal(shouldTrackPath("src/no-extension"), false);
  assert.equal(shouldTrackPath(""), false);
});

test("parseWatchCliArgs supports scalar and boolean flags", () => {
  const parsed = parseWatchCliArgs([
    "--interval-ms",
    "1200",
    "--max-files=100",
    "--max-batch-size",
    "40",
    "--debounce-ms",
    "650",
    "--no-hash-skip",
    "--no-semantic",
    "--quiet",
    "--help"
  ]);

  assert.equal(parsed.interval_ms, 1200);
  assert.equal(parsed.max_files, 100);
  assert.equal(parsed.max_batch_size, 40);
  assert.equal(parsed.debounce_ms, 650);
  assert.equal(parsed.hash_skip_enabled, false);
  assert.equal(parsed.include_semantic, false);
  assert.equal(parsed.quiet, true);
  assert.equal(parsed.help, true);
});

test("diffTrackedFiles returns sorted changed/deleted path lists", () => {
  const previous = new Map([
    ["src/a.ts", { mtime_ms: 100, size: 10 }],
    ["src/b.ts", { mtime_ms: 200, size: 20 }],
    ["src/c.ts", { mtime_ms: 300, size: 30 }]
  ]);
  const current = new Map([
    ["src/a.ts", { mtime_ms: 100, size: 10 }],
    ["src/b.ts", { mtime_ms: 205, size: 20 }],
    ["src/d.ts", { mtime_ms: 1, size: 1 }]
  ]);

  const diff = diffTrackedFiles(previous, current, { mtime_epsilon_ms: 1 });
  assert.deepEqual(diff.changed_paths, ["src/b.ts", "src/d.ts"]);
  assert.deepEqual(diff.deleted_paths, ["src/c.ts"]);
});

test("dirty queue deduplicates paths and flushes by debounce/batch rules", () => {
  const queue = createDirtyQueueState();
  const enqueued = enqueueDirtyQueue(
    queue,
    {
      changed_paths: ["src/a.ts", "src/a.ts", "src/b.ts"],
      deleted_paths: ["src/c.ts"]
    },
    1000
  );
  assert.equal(enqueued.added_changed, 2);
  assert.equal(enqueued.added_deleted, 1);
  assert.equal(enqueued.queue_depth, 3);

  const noFlushYet = shouldFlushDirtyQueue(queue, 1200, 500, 10, false);
  assert.equal(noFlushYet, false);
  const flushByDebounce = shouldFlushDirtyQueue(queue, 1605, 500, 10, false);
  assert.equal(flushByDebounce, true);

  const batch = takeDirtyQueueBatch(queue, 2, 1700);
  assert.equal(batch.batch_size, 3);
  assert.ok(batch.changed_paths.length >= 1);
  assert.ok(batch.deleted_paths.length >= 1);
  assert.ok(batch.index_lag_ms >= 700);
  assert.equal(batch.queue_depth_before, 3);
  assert.equal(batch.queue_depth_after, 0);
});

test("hash skip filters unchanged files after cache seed", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, "src/hash-a.ts", "export const a = 1;\n");
  await writeWorkspaceFile(workspaceRoot, "src/hash-b.ts", "export const b = 1;\n");

  const snapshot = new Map([
    ["src/hash-a.ts", { mtime_ms: 1, size: 1 }],
    ["src/hash-b.ts", { mtime_ms: 1, size: 1 }]
  ]);
  const hashCache = new Map();
  const seeded = await seedHashCacheFromSnapshot(workspaceRoot, snapshot, hashCache, {
    hash_skip_enabled: true,
    hash_init_max_files: 10
  });
  assert.equal(seeded.hashed_files, 2);

  const unchanged = await filterChangedPathsByHash(
    workspaceRoot,
    ["src/hash-a.ts"],
    hashCache,
    { hash_skip_enabled: true }
  );
  assert.deepEqual(unchanged.changed_paths, []);
  assert.deepEqual(unchanged.skipped_paths, ["src/hash-a.ts"]);
  assert.equal(unchanged.hashed_paths, 1);

  await writeWorkspaceFile(workspaceRoot, "src/hash-a.ts", "export const a = 2;\n");
  const changed = await filterChangedPathsByHash(
    workspaceRoot,
    ["src/hash-a.ts"],
    hashCache,
    { hash_skip_enabled: true }
  );
  assert.deepEqual(changed.changed_paths, ["src/hash-a.ts"]);
  assert.deepEqual(changed.skipped_paths, []);
  assert.equal(changed.hashed_paths, 1);
});

test("refreshIndexesForChanges updates code/syntax/semantic indexes in event mode", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/watch-a.ts",
    "import { watchOldToken } from './watch-b';\nexport function watchMainToken() { return watchOldToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/watch-b.ts",
    "export function watchOldToken() { return true; }\n"
  );

  const builtCode = await buildCodeIndex(workspaceRoot, {});
  assert.equal(builtCode.ok, true);
  const builtSyntax = await buildSyntaxIndex(workspaceRoot, {});
  assert.equal(builtSyntax.ok, true);
  const builtGraph = await buildSemanticGraph(
    workspaceRoot,
    {
      include_syntax: true,
      include_definitions: false,
      include_references: false,
      precise_preferred: false
    },
    { enabled: false }
  );
  assert.equal(builtGraph.ok, true);

  await writeWorkspaceFile(
    workspaceRoot,
    "src/watch-a.ts",
    "import { watchNewToken } from './watch-c';\nexport function watchMainTokenV2() { return watchNewToken(); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/watch-c.ts",
    "export function watchNewToken() { return true; }\n"
  );
  await fs.rm(path.join(workspaceRoot, "src/watch-b.ts"), { force: true });

  const refreshed = await refreshIndexesForChanges(workspaceRoot, {
    changed_paths: ["src/watch-a.ts", "src/watch-c.ts"],
    deleted_paths: ["src/watch-b.ts"],
    max_batch_size: 1,
    include_syntax: true,
    include_semantic: true,
    semantic_include_definitions: false,
    semantic_include_references: false
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.skipped, false);
  assert.equal(refreshed.code_index.details.length, 2);
  assert.ok(refreshed.code_index.details.every((item) => item.ok));
  assert.equal(refreshed.syntax_index?.ok, true);
  assert.equal(refreshed.semantic_graph?.ok, true);
  assert.equal(refreshed.semantic_graph?.mode, "event");

  const codeQuery = await queryCodeIndex(workspaceRoot, { query: "watchMainTokenV2", top_k: 3 });
  assert.equal(codeQuery.ok, true);
  assert.ok(codeQuery.results.some((item) => item.path === "src/watch-a.ts"));

  const oldCodeQuery = await queryCodeIndex(workspaceRoot, { query: "watchOldToken", top_k: 5 });
  assert.equal(oldCodeQuery.ok, true);
  assert.equal(oldCodeQuery.results.some((item) => item.path === "src/watch-b.ts"), false);

  const syntaxQuery = await querySyntaxIndex(workspaceRoot, {
    query: "watchMainTokenV2",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(syntaxQuery.ok, true);
  const syntaxSeed = syntaxQuery.seeds.find((seed) => seed.path === "src/watch-a.ts");
  assert.ok(syntaxSeed);
  assert.ok(syntaxSeed.outgoing_calls.some((edge) => edge.callee === "watchNewToken"));

  const semanticQuery = await querySemanticGraph(workspaceRoot, {
    query: "watchMainTokenV2",
    edge_type: "call",
    top_k: 3,
    max_neighbors: 5
  });
  assert.equal(semanticQuery.ok, true);
  const semanticSeed = semanticQuery.seeds.find((seed) => seed.name === "watchMainTokenV2");
  assert.ok(semanticSeed);
  assert.ok(
    semanticSeed.outgoing.some(
      (edge) => edge.edge_type === "call" && edge.node?.name === "watchNewToken"
    )
  );

  const skipped = await refreshIndexesForChanges(workspaceRoot, {
    changed_paths: [],
    deleted_paths: []
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
});
