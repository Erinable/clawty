import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeWatchPathList } from "./index-watch-queue.js";

export async function hashTrackedFile(workspaceRoot, relativePath) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  let content;
  try {
    content = await fs.readFile(absolutePath);
  } catch {
    return null;
  }
  return createHash("sha1").update(content).digest("hex");
}

export async function seedHashCacheFromSnapshot(
  workspaceRoot,
  snapshot,
  hashCache,
  args = {},
  deps = {}
) {
  const { resolveWatchConfig } = deps;
  const config = resolveWatchConfig(args);
  if (!config.hash_skip_enabled || !(snapshot instanceof Map) || config.hash_init_max_files <= 0) {
    return {
      hashed_files: 0
    };
  }

  const candidates = Array.from(snapshot.keys()).sort().slice(0, config.hash_init_max_files);
  let hashedFiles = 0;
  for (const relativePath of candidates) {
    const hash = await hashTrackedFile(workspaceRoot, relativePath);
    if (!hash) {
      continue;
    }
    hashCache.set(relativePath, hash);
    hashedFiles += 1;
  }
  return {
    hashed_files: hashedFiles
  };
}

export async function filterChangedPathsByHash(
  workspaceRoot,
  changedPaths,
  hashCache,
  args = {},
  deps = {}
) {
  const { resolveWatchConfig } = deps;
  const config = resolveWatchConfig(args);
  const normalizedChanged = normalizeWatchPathList(changedPaths);
  if (!config.hash_skip_enabled) {
    return {
      changed_paths: normalizedChanged,
      skipped_paths: [],
      hashed_paths: 0
    };
  }

  const kept = [];
  const skipped = [];
  let hashedPaths = 0;
  for (const relativePath of normalizedChanged) {
    const nextHash = await hashTrackedFile(workspaceRoot, relativePath);
    if (!nextHash) {
      hashCache.delete(relativePath);
      kept.push(relativePath);
      continue;
    }

    hashedPaths += 1;
    const previousHash = hashCache.get(relativePath);
    hashCache.set(relativePath, nextHash);
    if (previousHash && previousHash === nextHash) {
      skipped.push(relativePath);
      continue;
    }
    kept.push(relativePath);
  }

  return {
    changed_paths: kept,
    skipped_paths: skipped,
    hashed_paths: hashedPaths
  };
}
