import test from "node:test";
import assert from "node:assert/strict";
import {
  refreshCodeIndexInBatchesWithDeps,
  refreshIndexesForChangesWithDeps
} from "../src/index-watch-refresh.js";

test("refreshCodeIndexInBatchesWithDeps retries SQLITE_BUSY failures within budget", async () => {
  let attempts = 0;
  const result = await refreshCodeIndexInBatchesWithDeps(
    "/repo",
    ["src/a.ts"],
    [],
    1,
    {
      chunkArray(items) {
        return items.length > 0 ? [items] : [];
      },
      async refreshCodeIndex() {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            error: "SQLITE_BUSY: database is locked"
          };
        }
        return {
          ok: true,
          mode: "event"
        };
      },
      retryOptions: {
        db_retry_budget: 2,
        db_retry_backoff_ms: 1,
        db_retry_backoff_max_ms: 1
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.db_retry.attempts, 1);
  assert.equal(result.db_retry.exhausted, false);
  assert.ok(result.db_retry.stages.includes("refresh_code_index"));
});

test("refreshIndexesForChangesWithDeps reports retry exhaustion for busy database errors", async () => {
  const result = await refreshIndexesForChangesWithDeps(
    "/repo",
    {
      changed_paths: ["src/a.ts"],
      deleted_paths: []
    },
    {
      resolveWatchConfig() {
        return {
          max_batch_size: 10,
          include_syntax: false,
          include_semantic: false,
          include_vector: false,
          db_retry_budget: 1,
          db_retry_backoff_ms: 1,
          db_retry_backoff_max_ms: 1
        };
      },
      parseString(value, fallback) {
        return value || fallback;
      },
      async refreshCodeIndexInBatches() {
        return {
          ok: false,
          details: [
            {
              ok: false,
              error: "SQLITE_BUSY: database is locked"
            }
          ],
          db_retry: {
            attempts: 1,
            exhausted: true,
            stages: ["refresh_code_index"]
          }
        };
      },
      async refreshSyntaxIndex() {
        return { ok: true };
      },
      async refreshSemanticGraph() {
        return { ok: true };
      },
      async refreshVectorIndex() {
        return { ok: true };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.stage, "refresh_code_index");
  assert.equal(result.db_retry.attempts, 1);
  assert.equal(result.db_retry.exhausted, true);
  assert.ok(result.db_retry.stages.includes("refresh_code_index"));
});
