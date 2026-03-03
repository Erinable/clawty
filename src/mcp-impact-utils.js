function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function collectPathsFromSearchResult(payload) {
  const paths = [];
  if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
    return paths;
  }
  for (const item of payload.results) {
    if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
      paths.push(item.path.trim());
    }
  }
  return paths;
}

export function collectPathsFromSemanticResult(payload) {
  const paths = [];
  if (!isPlainObject(payload) || !Array.isArray(payload.seeds)) {
    return paths;
  }

  for (const seed of payload.seeds) {
    if (isPlainObject(seed) && typeof seed.path === "string" && seed.path.trim()) {
      paths.push(seed.path.trim());
    }
    const outgoing = Array.isArray(seed?.outgoing) ? seed.outgoing : [];
    for (const item of outgoing) {
      if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
        paths.push(item.path.trim());
      }
    }
    const incoming = Array.isArray(seed?.incoming) ? seed.incoming : [];
    for (const item of incoming) {
      if (isPlainObject(item) && typeof item.path === "string" && item.path.trim()) {
        paths.push(item.path.trim());
      }
    }
  }

  return paths;
}

export function dedupePaths(paths, maxPaths = 100) {
  const deduped = [];
  const seen = new Set();
  for (const rawPath of paths) {
    if (typeof rawPath !== "string") {
      continue;
    }
    const normalized = rawPath.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= maxPaths) {
      break;
    }
  }
  return deduped;
}

export function hasLocationArgs(args) {
  if (!isPlainObject(args)) {
    return false;
  }
  return (
    typeof args.path === "string" &&
    args.path.trim() &&
    Number.isFinite(Number(args.line)) &&
    Number(args.line) > 0 &&
    Number.isFinite(Number(args.column)) &&
    Number(args.column) > 0
  );
}

export function collectReferencePaths(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.locations)) {
    return [];
  }
  const paths = [];
  for (const location of payload.locations) {
    if (isPlainObject(location) && typeof location.path === "string" && location.path.trim()) {
      paths.push(location.path.trim());
    }
  }
  return paths;
}
