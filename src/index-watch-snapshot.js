export async function collectTrackedFilesWithDeps(workspaceRoot, args = {}, deps = {}) {
  const { path, fs, resolveWatchConfig, toPosixPath, shouldTrackPath, ignoredDirs } = deps;
  const config = resolveWatchConfig(args);
  const root = path.resolve(workspaceRoot);
  const snapshot = new Map();
  const queue = [root];

  while (queue.length > 0 && snapshot.size < config.max_files) {
    const currentDir = queue.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = toPosixPath(path.relative(root, fullPath));
      if (!shouldTrackPath(relativePath)) {
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      snapshot.set(relativePath, {
        mtime_ms: Number(stat.mtimeMs || 0),
        size: Number(stat.size || 0)
      });

      if (snapshot.size >= config.max_files) {
        break;
      }
    }
  }

  return snapshot;
}

export function diffTrackedFilesWithDeps(
  previousSnapshot,
  currentSnapshot,
  args = {},
  deps = {}
) {
  const { parsePositiveInt, mtimeEpsilonMs } = deps;
  const epsilonMs = parsePositiveInt(args.mtime_epsilon_ms, mtimeEpsilonMs, 0, 1000);
  const previous = previousSnapshot instanceof Map ? previousSnapshot : new Map();
  const current = currentSnapshot instanceof Map ? currentSnapshot : new Map();
  const changed = [];
  const deleted = [];

  for (const [filePath, currentMeta] of current.entries()) {
    const previousMeta = previous.get(filePath);
    if (!previousMeta) {
      changed.push(filePath);
      continue;
    }
    const currentSize = Number(currentMeta?.size || 0);
    const previousSize = Number(previousMeta?.size || 0);
    const currentMtime = Number(currentMeta?.mtime_ms || 0);
    const previousMtime = Number(previousMeta?.mtime_ms || 0);

    if (currentSize !== previousSize || Math.abs(currentMtime - previousMtime) > epsilonMs) {
      changed.push(filePath);
    }
  }

  for (const filePath of previous.keys()) {
    if (!current.has(filePath)) {
      deleted.push(filePath);
    }
  }

  changed.sort();
  deleted.sort();
  return {
    changed_paths: changed,
    deleted_paths: deleted
  };
}
