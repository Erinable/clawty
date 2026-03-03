import path from "node:path";

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

export function normalizeWatchPathList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? toPosixPath(item.trim()) : ""))
        .filter((item) => item.length > 0)
    )
  );
}

export function createDirtyQueueState() {
  return {
    changed_paths: new Set(),
    deleted_paths: new Set(),
    first_enqueued_at_ms: 0,
    last_enqueued_at_ms: 0
  };
}

export function getDirtyQueueDepth(queueState) {
  const changedDepth = queueState?.changed_paths instanceof Set ? queueState.changed_paths.size : 0;
  const deletedDepth = queueState?.deleted_paths instanceof Set ? queueState.deleted_paths.size : 0;
  return changedDepth + deletedDepth;
}

function touchQueueTimestamps(queueState, nowMs) {
  const depth = getDirtyQueueDepth(queueState);
  if (depth <= 0) {
    queueState.first_enqueued_at_ms = 0;
    queueState.last_enqueued_at_ms = 0;
    return;
  }
  if (!queueState.first_enqueued_at_ms) {
    queueState.first_enqueued_at_ms = nowMs;
  }
  queueState.last_enqueued_at_ms = nowMs;
}

export function enqueueDirtyQueue(queueState, diff = {}, nowMs = Date.now()) {
  const changedPaths = normalizeWatchPathList(diff.changed_paths);
  const deletedPaths = normalizeWatchPathList(diff.deleted_paths);
  let addedChanged = 0;
  let addedDeleted = 0;

  for (const filePath of changedPaths) {
    queueState.deleted_paths.delete(filePath);
    if (queueState.changed_paths.has(filePath)) {
      continue;
    }
    queueState.changed_paths.add(filePath);
    addedChanged += 1;
  }

  for (const filePath of deletedPaths) {
    queueState.changed_paths.delete(filePath);
    if (queueState.deleted_paths.has(filePath)) {
      continue;
    }
    queueState.deleted_paths.add(filePath);
    addedDeleted += 1;
  }

  const addedTotal = addedChanged + addedDeleted;
  if (addedTotal > 0) {
    touchQueueTimestamps(queueState, nowMs);
  } else {
    touchQueueTimestamps(queueState, queueState.last_enqueued_at_ms || nowMs);
  }
  return {
    added_changed: addedChanged,
    added_deleted: addedDeleted,
    queue_depth: getDirtyQueueDepth(queueState)
  };
}

export function shouldFlushDirtyQueue(
  queueState,
  nowMs,
  debounceMs,
  maxBatchSize,
  force = false
) {
  const depth = getDirtyQueueDepth(queueState);
  if (depth <= 0) {
    return false;
  }
  if (force) {
    return true;
  }
  if (depth >= Math.max(1, Number(maxBatchSize) || 1)) {
    return true;
  }
  if (!queueState.last_enqueued_at_ms) {
    return true;
  }
  return nowMs - queueState.last_enqueued_at_ms >= Math.max(100, Number(debounceMs) || 100);
}

export function takeDirtyQueueBatch(queueState, maxBatchSize, nowMs = Date.now()) {
  const changed = [];
  const deleted = [];
  const depthBefore = getDirtyQueueDepth(queueState);
  const size = Math.max(1, Number(maxBatchSize) || 1);
  const firstQueuedAt = Number(queueState.first_enqueued_at_ms || 0);

  for (const filePath of queueState.changed_paths.values()) {
    if (changed.length >= size) {
      break;
    }
    queueState.changed_paths.delete(filePath);
    changed.push(filePath);
  }
  for (const filePath of queueState.deleted_paths.values()) {
    if (deleted.length >= size) {
      break;
    }
    queueState.deleted_paths.delete(filePath);
    deleted.push(filePath);
  }

  const depthAfter = getDirtyQueueDepth(queueState);
  if (depthAfter <= 0) {
    queueState.first_enqueued_at_ms = 0;
    queueState.last_enqueued_at_ms = 0;
  }
  return {
    changed_paths: changed,
    deleted_paths: deleted,
    batch_size: changed.length + deleted.length,
    queue_depth_before: depthBefore,
    queue_depth_after: depthAfter,
    index_lag_ms: firstQueuedAt ? Math.max(0, nowMs - firstQueuedAt) : 0
  };
}
