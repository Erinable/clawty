# DB Sync Risk Runbook

适用范围：SQLite 同步访问引发的 lock contention 与 flush 变慢问题。

## 1. 识别信号

重点看 `watch_flush` 与 `watch_run` 指标：

- `db_retry_count > 0`
- `db_retry_exhausted = true`
- `slow_flush = true`
- `db_retry_exhausted_count` 持续上升

## 2. 立即缓解

### 降低 watch 压力

- 增大 `CLAWTY_WATCH_INTERVAL_MS`
- 降低 `CLAWTY_WATCH_MAX_BATCH_SIZE`
- 增大 `CLAWTY_WATCH_DEBOUNCE_MS`
- 临时关闭向量刷新：`CLAWTY_WATCH_INCLUDE_VECTOR=false`

### 调整 DB 重试参数

- `CLAWTY_WATCH_DB_RETRY_BUDGET`（默认 `2`）
- `CLAWTY_WATCH_DB_RETRY_BACKOFF_MS`（默认 `120`）
- `CLAWTY_WATCH_DB_RETRY_BACKOFF_MAX_MS`（默认 `1200`）
- `CLAWTY_WATCH_SLOW_FLUSH_WARN_MS`（默认 `2500`）

## 3. 常见故障模式

- `SQLITE_BUSY` / `database is locked`
  - watch 刷新路径会做有界重试
  - 重试耗尽时会失败并重入队列

- 非可重试错误
  - fail fast，并记录到 flush 事件

## 4. 恢复验证

```bash
npm run metrics:report
npm run metrics:check
```

重点确认：

- `watch_db_retry_exhausted_rate` 回到 `0`
- `watch_slow_flush_rate` 和 `watch_refresh_p95_ms` 明显下降

## 5. 回滚建议

如临时调参无收益，回滚到默认：

- `CLAWTY_WATCH_DB_RETRY_BUDGET=2`
- `CLAWTY_WATCH_DB_RETRY_BACKOFF_MS=120`
- `CLAWTY_WATCH_DB_RETRY_BACKOFF_MAX_MS=1200`
