# DB Sync Risk Runbook

## Scope
- Applies to SQLite-backed indexing flows (`code-index`, `syntax-index`, `semantic-graph`, `vector-index`, `memory`).
- Focuses on lock contention and main-thread blocking symptoms from synchronous DB access.

## Detection Signals
- `watch_flush` events show `db_retry_count > 0`.
- `watch_flush` events show `db_retry_exhausted = true`.
- `watch_flush` events show `slow_flush = true`.
- `watch_run.watch_metrics` counters increase:
  - `db_retry_count`
  - `db_retry_exhausted_count`
  - `slow_flush_count`

## Immediate Mitigation
1. Reduce watch pressure:
   - Increase `CLAWTY_WATCH_INTERVAL_MS`
   - Decrease `CLAWTY_WATCH_MAX_BATCH_SIZE`
2. Relax hot-loop pressure:
   - Increase `CLAWTY_WATCH_DEBOUNCE_MS`
   - Disable vector refresh temporarily (`CLAWTY_WATCH_INCLUDE_VECTOR=false`)
3. Tune DB retry controls:
   - `CLAWTY_WATCH_DB_RETRY_BUDGET` (default `2`)
   - `CLAWTY_WATCH_DB_RETRY_BACKOFF_MS` (default `120`)
   - `CLAWTY_WATCH_DB_RETRY_BACKOFF_MAX_MS` (default `1200`)
4. Raise slow-flush alert threshold if workload is expected to be heavy:
   - `CLAWTY_WATCH_SLOW_FLUSH_WARN_MS` (default `2500`)

## Failure Modes
- `SQLITE_BUSY` / `database is locked`:
  - Automatic bounded retry is enabled in watch refresh path.
  - If retry budget is exhausted, flush fails and queue is re-enqueued.
- Non-retryable DB errors:
  - Fail fast, preserve error in flush event.

## Recovery Verification
1. Confirm `watch_flush` events no longer show `db_retry_exhausted=true`.
2. Confirm `watch_db_retry_exhausted_rate` returns to `0`.
3. Confirm `watch_slow_flush_rate` and `watch_refresh_p95_ms` trend down.
4. Run:
   - `npm run metrics:report`
   - `npm run metrics:check`

## Rollback
- Revert watch retry tuning to defaults:
  - `CLAWTY_WATCH_DB_RETRY_BUDGET=2`
  - `CLAWTY_WATCH_DB_RETRY_BACKOFF_MS=120`
  - `CLAWTY_WATCH_DB_RETRY_BACKOFF_MAX_MS=1200`
- Re-run baseline checks and compare KPI deltas.
