import { WATCH_FLUSH_EVENT_TYPE } from "./metrics-event-types.js";

export async function flushDirtyQueueWithDeps(
  workspaceRoot,
  config,
  queueState,
  metrics,
  options = {},
  deps = {}
) {
  const {
    shouldFlushDirtyQueue,
    takeDirtyQueueBatch,
    refreshIndexesForChanges,
    enqueueDirtyQueue,
    getDirtyQueueDepth,
    formatLoopMessage,
    appendWatchMetricEvent,
    watchFlushMetricsFile,
    roundWatchMetric
  } = deps;
  const force = Boolean(options.force);
  while (
    shouldFlushDirtyQueue(
      queueState,
      Date.now(),
      config.debounce_ms,
      config.max_batch_size,
      force
    )
  ) {
    const batch = takeDirtyQueueBatch(queueState, config.max_batch_size, Date.now());
    if (batch.batch_size <= 0) {
      break;
    }

    metrics.last_batch_size = batch.batch_size;
    metrics.last_index_lag_ms = batch.index_lag_ms;
    metrics.queue_depth = batch.queue_depth_after;
    metrics.max_queue_depth = Math.max(metrics.max_queue_depth, batch.queue_depth_before);

    const refreshStart = Date.now();
    const refreshed = await refreshIndexesForChanges(workspaceRoot, {
      ...config,
      changed_paths: batch.changed_paths,
      deleted_paths: batch.deleted_paths
    });
    const refreshMs = Date.now() - refreshStart;

    if (!refreshed.ok) {
      metrics.failed_flush_count += 1;
      enqueueDirtyQueue(
        queueState,
        {
          changed_paths: batch.changed_paths,
          deleted_paths: batch.deleted_paths
        },
        Date.now()
      );
      metrics.queue_depth = getDirtyQueueDepth(queueState);
      formatLoopMessage(
        [
          `refresh failed at ${refreshed.stage}: ${refreshed.error || "unknown error"}`,
          `queue_depth=${metrics.queue_depth}`,
          `batch_size=${batch.batch_size}`
        ].join(" "),
        config
      );
      await appendWatchMetricEvent(workspaceRoot, config, watchFlushMetricsFile, {
        timestamp: new Date().toISOString(),
        event_type: WATCH_FLUSH_EVENT_TYPE,
        ok: false,
        stage: refreshed.stage || null,
        error: refreshed.error || "refresh failed",
        batch_size: Number(batch.batch_size || 0),
        changed_count: Number(batch.changed_paths.length || 0),
        deleted_count: Number(batch.deleted_paths.length || 0),
        queue_depth_before: Number(batch.queue_depth_before || 0),
        queue_depth_after: Number(metrics.queue_depth || 0),
        index_lag_ms: Number(batch.index_lag_ms || 0),
        refresh_ms: roundWatchMetric(refreshMs)
      });
      break;
    }

    metrics.flush_count += 1;
    metrics.last_flush_duration_ms = refreshMs;
    metrics.refreshed_changed += batch.changed_paths.length;
    metrics.refreshed_deleted += batch.deleted_paths.length;
    metrics.queue_depth = batch.queue_depth_after;

    formatLoopMessage(
      [
        `refreshed changed=${batch.changed_paths.length}`,
        `deleted=${batch.deleted_paths.length}`,
        `queue_depth=${batch.queue_depth_after}`,
        `batch_size=${batch.batch_size}`,
        `index_lag_ms=${batch.index_lag_ms}`,
        `refresh_ms=${refreshMs}`
      ].join(" "),
      config
    );
    await appendWatchMetricEvent(workspaceRoot, config, watchFlushMetricsFile, {
      timestamp: new Date().toISOString(),
      event_type: WATCH_FLUSH_EVENT_TYPE,
      ok: true,
      stage: "refresh_indexes",
      error: null,
      batch_size: Number(batch.batch_size || 0),
      changed_count: Number(batch.changed_paths.length || 0),
      deleted_count: Number(batch.deleted_paths.length || 0),
      queue_depth_before: Number(batch.queue_depth_before || 0),
      queue_depth_after: Number(batch.queue_depth_after || 0),
      index_lag_ms: Number(batch.index_lag_ms || 0),
      refresh_ms: roundWatchMetric(refreshMs)
    });

    if (
      !force &&
      !shouldFlushDirtyQueue(
        queueState,
        Date.now(),
        config.debounce_ms,
        config.max_batch_size,
        false
      )
    ) {
      break;
    }
  }
}
