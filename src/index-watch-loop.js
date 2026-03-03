import { WATCH_RUN_EVENT_TYPE } from "./metrics-event-types.js";

function createWatchMetrics() {
  return {
    poll_count: 0,
    enqueue_count: 0,
    flush_count: 0,
    failed_flush_count: 0,
    queue_depth: 0,
    max_queue_depth: 0,
    last_batch_size: 0,
    last_index_lag_ms: 0,
    last_flush_duration_ms: 0,
    dropped_by_hash: 0,
    hashed_paths: 0,
    hash_seeded_files: 0,
    refreshed_changed: 0,
    refreshed_deleted: 0
  };
}

export async function runIndexWatchLoopWithDeps(workspaceRoot, args = {}, deps = {}) {
  const {
    path,
    processRef,
    resolveWatchConfig,
    createDirtyQueueState,
    ensureIndexes,
    collectTrackedFiles,
    seedHashCacheFromSnapshot,
    formatLoopMessage,
    sleep,
    diffTrackedFiles,
    filterChangedPathsByHash,
    enqueueDirtyQueue,
    flushDirtyQueue,
    getDirtyQueueDepth,
    appendWatchMetricEvent,
    watchRunMetricsFile
  } = deps;

  const config = resolveWatchConfig(args);
  const root = path.resolve(workspaceRoot);
  const queueState = createDirtyQueueState();
  const contentHashCache = new Map();
  const metrics = createWatchMetrics();

  const stopState = {
    stopped: false,
    signal: null
  };
  const stopHandler = (signal) => {
    stopState.stopped = true;
    stopState.signal = signal;
  };

  processRef.on("SIGINT", stopHandler);
  processRef.on("SIGTERM", stopHandler);
  try {
    if (config.build_on_start) {
      formatLoopMessage("building indexes on start...", config);
      const built = await ensureIndexes(root, config);
      if (!built.ok) {
        return {
          ok: false,
          stage: built.stage,
          error: built.result?.error || `${built.stage} failed`,
          result: built.result || null
        };
      }
      formatLoopMessage("initial build completed", config);
    }

    let previousSnapshot = await collectTrackedFiles(root, config);
    const seededHashes = await seedHashCacheFromSnapshot(root, previousSnapshot, contentHashCache, config);
    metrics.hash_seeded_files = Number(seededHashes.hashed_files || 0);
    formatLoopMessage(`watch started (tracked files: ${previousSnapshot.size})`, config);

    while (!stopState.stopped) {
      await sleep(config.interval_ms);
      if (stopState.stopped) {
        break;
      }

      const currentSnapshot = await collectTrackedFiles(root, config);
      const diff = diffTrackedFiles(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;
      metrics.poll_count += 1;

      if (diff.changed_paths.length === 0 && diff.deleted_paths.length === 0) {
        continue;
      }

      for (const deletedPath of diff.deleted_paths) {
        contentHashCache.delete(deletedPath);
      }

      const changedAfterHash = await filterChangedPathsByHash(
        root,
        diff.changed_paths,
        contentHashCache,
        config
      );
      metrics.hashed_paths += Number(changedAfterHash.hashed_paths || 0);
      metrics.dropped_by_hash += Number(changedAfterHash.skipped_paths?.length || 0);

      const enqueued = enqueueDirtyQueue(
        queueState,
        {
          changed_paths: changedAfterHash.changed_paths,
          deleted_paths: diff.deleted_paths
        },
        Date.now()
      );
      metrics.enqueue_count += Number(enqueued.added_changed || 0) + Number(enqueued.added_deleted || 0);
      metrics.queue_depth = Number(enqueued.queue_depth || 0);
      metrics.max_queue_depth = Math.max(metrics.max_queue_depth, metrics.queue_depth);

      if (metrics.queue_depth <= 0) {
        continue;
      }
      await flushDirtyQueue(root, config, queueState, metrics);
      metrics.queue_depth = getDirtyQueueDepth(queueState);
    }

    if (getDirtyQueueDepth(queueState) > 0) {
      formatLoopMessage(
        `draining pending queue (depth=${getDirtyQueueDepth(queueState)}) before exit`,
        config
      );
      await flushDirtyQueue(root, config, queueState, metrics, { force: true });
      metrics.queue_depth = getDirtyQueueDepth(queueState);
    }

    formatLoopMessage("watch stopped", config);
    await appendWatchMetricEvent(root, config, watchRunMetricsFile, {
      timestamp: new Date().toISOString(),
      event_type: WATCH_RUN_EVENT_TYPE,
      stopped_by_signal: Boolean(stopState.signal),
      signal: stopState.signal || null,
      watch_metrics: {
        poll_count: Number(metrics.poll_count || 0),
        enqueue_count: Number(metrics.enqueue_count || 0),
        flush_count: Number(metrics.flush_count || 0),
        failed_flush_count: Number(metrics.failed_flush_count || 0),
        queue_depth: Number(metrics.queue_depth || 0),
        max_queue_depth: Number(metrics.max_queue_depth || 0),
        last_batch_size: Number(metrics.last_batch_size || 0),
        last_index_lag_ms: Number(metrics.last_index_lag_ms || 0),
        last_flush_duration_ms: Number(metrics.last_flush_duration_ms || 0),
        dropped_by_hash: Number(metrics.dropped_by_hash || 0),
        hashed_paths: Number(metrics.hashed_paths || 0),
        hash_seeded_files: Number(metrics.hash_seeded_files || 0),
        refreshed_changed: Number(metrics.refreshed_changed || 0),
        refreshed_deleted: Number(metrics.refreshed_deleted || 0)
      }
    });
    return {
      ok: true,
      stopped_by_signal: Boolean(stopState.signal),
      signal: stopState.signal,
      config,
      watch_metrics: metrics
    };
  } finally {
    processRef.off("SIGINT", stopHandler);
    processRef.off("SIGTERM", stopHandler);
  }
}
