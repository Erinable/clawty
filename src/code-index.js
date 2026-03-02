import path from "node:path";
import fs from "node:fs/promises";

const INDEX_VERSION = 2;
const INDEX_DIR = ".clawty";
const INDEX_FILENAME = "code-index.json";
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_FILE_SIZE_KB = 512;
const MTIME_EPSILON_MS = 1;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".clawty"
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sh",
  ".yml",
  ".yaml",
  ".toml",
  ".ini"
]);

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function tokenize(text) {
  const matches = text.match(/[A-Za-z_][A-Za-z0-9_]{1,63}/g) || [];
  return matches.map((value) => value.toLowerCase());
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function isProbablyText(content) {
  return !content.includes("\0");
}

function resolveSafePath(workspaceRoot, inputPath) {
  const fullPath = path.resolve(workspaceRoot, inputPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return fullPath;
}

function indexFilePath(workspaceRoot) {
  return path.join(workspaceRoot, INDEX_DIR, INDEX_FILENAME);
}

function resolveIndexConfig(args = {}, fallback = {}) {
  return {
    max_files: parsePositiveInt(
      args.max_files,
      parsePositiveInt(fallback.max_files, DEFAULT_MAX_FILES, 1, 20000),
      1,
      20000
    ),
    max_file_size_kb: parsePositiveInt(
      args.max_file_size_kb,
      parsePositiveInt(fallback.max_file_size_kb, DEFAULT_MAX_FILE_SIZE_KB, 1, 8192),
      1,
      8192
    )
  };
}

async function walkFiles(workspaceRoot, dirPath, state, maxFiles) {
  if (state.collected.length >= maxFiles) {
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (state.collected.length >= maxFiles) {
      return;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walkFiles(workspaceRoot, fullPath, state, maxFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      continue;
    }

    state.collected.push(toPosixPath(path.relative(workspaceRoot, fullPath)));
  }
}

async function listCandidateFiles(workspaceRoot, maxFiles) {
  const state = { collected: [] };
  await walkFiles(workspaceRoot, workspaceRoot, state, maxFiles);
  state.collected.sort();
  return state.collected;
}

function countTokens(content) {
  const tokenList = tokenize(content);
  const tokenCounts = {};
  for (const token of tokenList) {
    tokenCounts[token] = (tokenCounts[token] || 0) + 1;
  }
  return { tokenCounts, tokenTotal: tokenList.length };
}

function buildIndexedEntry(relativePath, stat, content) {
  if (!isProbablyText(content)) {
    return { status: "skip_binary" };
  }

  const lines = content.split(/\r?\n/).length;
  const { tokenCounts, tokenTotal } = countTokens(content);
  return {
    status: "indexed",
    file: {
      path: relativePath,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      line_count: lines,
      token_count: tokenTotal
    },
    token_counts: tokenCounts
  };
}

async function indexFileFresh(workspaceRoot, relativePath, maxFileBytes) {
  const fullPath = resolveSafePath(workspaceRoot, relativePath);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { status: "missing" };
  }

  if (stat.size > maxFileBytes) {
    return { status: "skip_large" };
  }

  let content;
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    return { status: "missing" };
  }

  return buildIndexedEntry(relativePath, stat, content);
}

function isReusableFile(oldFileMeta, oldTokenCounts, stat) {
  if (!oldFileMeta || !oldTokenCounts) {
    return false;
  }
  if (oldFileMeta.size !== stat.size) {
    return false;
  }
  return Math.abs(oldFileMeta.mtime_ms - stat.mtimeMs) < MTIME_EPSILON_MS;
}

async function indexFileIncremental(workspaceRoot, relativePath, maxFileBytes, oldFileMeta, oldTokenCounts) {
  const fullPath = resolveSafePath(workspaceRoot, relativePath);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { status: "missing" };
  }

  if (stat.size > maxFileBytes) {
    return { status: "skip_large" };
  }

  if (isReusableFile(oldFileMeta, oldTokenCounts, stat)) {
    return {
      status: "reused",
      file: oldFileMeta,
      token_counts: oldTokenCounts
    };
  }

  let content;
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    return { status: "missing" };
  }

  return buildIndexedEntry(relativePath, stat, content);
}

function buildInverted(fileTokensByPath) {
  const tokenMap = new Map();

  for (const [filePath, tokenCounts] of Object.entries(fileTokensByPath)) {
    for (const [token, count] of Object.entries(tokenCounts)) {
      if (!tokenMap.has(token)) {
        tokenMap.set(token, []);
      }
      tokenMap.get(token).push([filePath, count]);
    }
  }

  const inverted = {};
  for (const [token, postings] of tokenMap.entries()) {
    postings.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    inverted[token] = postings;
  }
  return inverted;
}

function buildStats({
  discoveredFiles,
  indexedFiles,
  skippedLargeFiles,
  skippedBinaryFiles,
  inverted,
  reusedFiles = 0,
  reindexedFiles = 0,
  removedFiles = 0,
  incremental = false
}) {
  return {
    discovered_files: discoveredFiles,
    indexed_files: indexedFiles,
    skipped_large_files: skippedLargeFiles,
    skipped_binary_files: skippedBinaryFiles,
    unique_tokens: Object.keys(inverted).length,
    incremental,
    reused_files: reusedFiles,
    reindexed_files: reindexedFiles,
    removed_files: removedFiles
  };
}

function buildPayload(workspaceRoot, config, stats, files, fileTokens, inverted) {
  return {
    version: INDEX_VERSION,
    created_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    config,
    stats,
    files,
    file_tokens: fileTokens,
    inverted
  };
}

async function writeCodeIndex(workspaceRoot, payload) {
  const outputDir = path.join(workspaceRoot, INDEX_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = indexFilePath(workspaceRoot);
  await fs.writeFile(outputPath, JSON.stringify(payload), "utf8");
  return outputPath;
}

function buildResult(workspaceRoot, payload, extra = {}) {
  const outputPath = indexFilePath(workspaceRoot);
  return {
    ok: true,
    index_path: toPosixPath(path.relative(workspaceRoot, outputPath)),
    ...payload.stats,
    ...extra
  };
}

async function readCodeIndexIfExists(workspaceRoot) {
  try {
    const fullPath = indexFilePath(workspaceRoot);
    const raw = await fs.readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function buildCodeIndex(workspaceRoot, args = {}) {
  const config = resolveIndexConfig(args);
  const maxFileBytes = config.max_file_size_kb * 1024;
  const discoveredPaths = await listCandidateFiles(workspaceRoot, config.max_files);

  const files = [];
  const fileTokens = {};
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let indexedFiles = 0;

  for (const relativePath of discoveredPaths) {
    const result = await indexFileFresh(workspaceRoot, relativePath, maxFileBytes);
    if (result.status === "skip_large") {
      skippedLargeFiles += 1;
      continue;
    }
    if (result.status === "skip_binary") {
      skippedBinaryFiles += 1;
      continue;
    }
    if (result.status !== "indexed") {
      continue;
    }

    files.push(result.file);
    fileTokens[relativePath] = result.token_counts;
    indexedFiles += 1;
  }

  const inverted = buildInverted(fileTokens);
  const stats = buildStats({
    discoveredFiles: discoveredPaths.length,
    indexedFiles,
    skippedLargeFiles,
    skippedBinaryFiles,
    inverted,
    incremental: false,
    reusedFiles: 0,
    reindexedFiles: indexedFiles,
    removedFiles: 0
  });

  const payload = buildPayload(workspaceRoot, config, stats, files, fileTokens, inverted);
  await writeCodeIndex(workspaceRoot, payload);
  return buildResult(workspaceRoot, payload, { mode: "full" });
}

export async function refreshCodeIndex(workspaceRoot, args = {}) {
  const existing = await readCodeIndexIfExists(workspaceRoot);
  const forceRebuild = parseBoolean(args.force_rebuild, false);

  if (!existing || forceRebuild || existing.version !== INDEX_VERSION || !existing.file_tokens) {
    const rebuilt = await buildCodeIndex(workspaceRoot, args);
    return {
      ...rebuilt,
      mode: "full",
      fallback_full_rebuild: !existing || existing.version !== INDEX_VERSION || !existing.file_tokens
    };
  }

  const config = resolveIndexConfig(args, existing.config || {});
  const maxFileBytes = config.max_file_size_kb * 1024;
  const discoveredPaths = await listCandidateFiles(workspaceRoot, config.max_files);

  const oldFileMetaByPath = new Map((existing.files || []).map((item) => [item.path, item]));
  const oldFileTokens = existing.file_tokens || {};

  const files = [];
  const fileTokens = {};
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let indexedFiles = 0;
  let reusedFiles = 0;
  let reindexedFiles = 0;

  for (const relativePath of discoveredPaths) {
    const oldMeta = oldFileMetaByPath.get(relativePath);
    const oldTokens = oldFileTokens[relativePath];

    const result = await indexFileIncremental(
      workspaceRoot,
      relativePath,
      maxFileBytes,
      oldMeta,
      oldTokens
    );

    if (result.status === "skip_large") {
      skippedLargeFiles += 1;
      continue;
    }
    if (result.status === "skip_binary") {
      skippedBinaryFiles += 1;
      continue;
    }
    if (result.status === "reused") {
      files.push(result.file);
      fileTokens[relativePath] = result.token_counts;
      indexedFiles += 1;
      reusedFiles += 1;
      continue;
    }
    if (result.status !== "indexed") {
      continue;
    }

    files.push(result.file);
    fileTokens[relativePath] = result.token_counts;
    indexedFiles += 1;
    reindexedFiles += 1;
  }

  const oldIndexedPaths = Object.keys(oldFileTokens);
  const removedFiles = oldIndexedPaths.reduce(
    (acc, filePath) => (fileTokens[filePath] ? acc : acc + 1),
    0
  );

  const inverted = buildInverted(fileTokens);
  const stats = buildStats({
    discoveredFiles: discoveredPaths.length,
    indexedFiles,
    skippedLargeFiles,
    skippedBinaryFiles,
    inverted,
    incremental: true,
    reusedFiles,
    reindexedFiles,
    removedFiles
  });

  const payload = buildPayload(workspaceRoot, config, stats, files, fileTokens, inverted);
  await writeCodeIndex(workspaceRoot, payload);

  return buildResult(workspaceRoot, payload, { mode: "incremental" });
}

async function loadCodeIndex(workspaceRoot) {
  const fullPath = indexFilePath(workspaceRoot);
  const raw = await fs.readFile(fullPath, "utf8");
  return JSON.parse(raw);
}

function rankMatches(index, queryTokens) {
  const scores = new Map();
  for (const token of queryTokens) {
    const postings = index.inverted[token] || [];
    for (const [filePath, count] of postings) {
      if (!scores.has(filePath)) {
        scores.set(filePath, { score: 0, tokens: new Set() });
      }
      const entry = scores.get(filePath);
      entry.score += Math.log2(count + 1);
      entry.tokens.add(token);
    }
  }

  return Array.from(scores.entries())
    .map(([filePath, entry]) => ({
      path: filePath,
      score: Number(entry.score.toFixed(3)),
      matched_tokens: Array.from(entry.tokens)
    }))
    .sort((a, b) => b.score - a.score);
}

async function buildSnippet(workspaceRoot, relativePath, tokens) {
  const fullPath = resolveSafePath(workspaceRoot, relativePath);
  const content = await fs.readFile(fullPath, "utf8");
  const lines = content.split(/\r?\n/);
  let hitLine = 0;
  const tokenRegexes = tokens.map(
    (token) => new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`, "i")
  );

  for (let i = 0; i < lines.length; i += 1) {
    if (tokenRegexes.some((re) => re.test(lines[i]))) {
      hitLine = i;
      break;
    }
  }

  const start = Math.max(0, hitLine - 1);
  const end = Math.min(lines.length, hitLine + 2);
  const snippet = lines
    .slice(start, end)
    .map((line, idx) => `${start + idx + 1}: ${line}`)
    .join("\n");

  return {
    hit_line: hitLine + 1,
    snippet
  };
}

export async function queryCodeIndex(workspaceRoot, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, error: "query must be a non-empty string" };
  }

  let index;
  try {
    index = await loadCodeIndex(workspaceRoot);
  } catch {
    return {
      ok: false,
      error: "code index not found; run build_code_index first"
    };
  }

  const tokens = uniqueTokens(tokenize(query));
  if (tokens.length === 0) {
    return {
      ok: false,
      error: "query has no indexable tokens"
    };
  }

  const topK =
    Number.isFinite(args.top_k) && args.top_k > 0
      ? Math.min(50, Math.floor(args.top_k))
      : 8;
  const rankedAll = rankMatches(index, tokens);
  const ranked = rankedAll.slice(0, topK);

  const results = [];
  for (const item of ranked) {
    let snippetInfo = { hit_line: 1, snippet: "" };
    try {
      snippetInfo = await buildSnippet(workspaceRoot, item.path, item.matched_tokens);
    } catch {
      // Ignore unreadable files in result rendering.
    }

    results.push({
      path: item.path,
      score: item.score,
      matched_tokens: item.matched_tokens,
      hit_line: snippetInfo.hit_line,
      snippet: snippetInfo.snippet
    });
  }

  return {
    ok: true,
    query,
    query_tokens: tokens,
    total_hits: rankedAll.length,
    results
  };
}
