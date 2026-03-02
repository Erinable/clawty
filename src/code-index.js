import path from "node:path";
import fs from "node:fs/promises";

const INDEX_DIR = ".clawty";
const INDEX_FILENAME = "code-index.json";
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_FILE_SIZE_KB = 512;

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

async function walkFiles(workspaceRoot, dirPath, state, options) {
  if (state.collected.length >= options.maxFiles) {
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (state.collected.length >= options.maxFiles) {
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
      await walkFiles(workspaceRoot, fullPath, state, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      continue;
    }

    const relativePath = toPosixPath(path.relative(workspaceRoot, fullPath));
    state.collected.push(relativePath);
  }
}

export async function buildCodeIndex(workspaceRoot, args = {}) {
  const maxFiles =
    Number.isFinite(args.max_files) && args.max_files > 0
      ? Math.floor(args.max_files)
      : DEFAULT_MAX_FILES;
  const maxFileSizeKb =
    Number.isFinite(args.max_file_size_kb) && args.max_file_size_kb > 0
      ? Math.floor(args.max_file_size_kb)
      : DEFAULT_MAX_FILE_SIZE_KB;
  const maxFileBytes = maxFileSizeKb * 1024;

  const state = { collected: [] };
  await walkFiles(workspaceRoot, workspaceRoot, state, { maxFiles });

  const files = [];
  const invertedMap = new Map();
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let indexedFiles = 0;

  for (const relativePath of state.collected) {
    const fullPath = resolveSafePath(workspaceRoot, relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.size > maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }

    let content;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    if (!isProbablyText(content)) {
      skippedBinaryFiles += 1;
      continue;
    }

    const lines = content.split(/\r?\n/).length;
    const tokens = tokenize(content);
    const fileTokenCounts = new Map();
    for (const token of tokens) {
      fileTokenCounts.set(token, (fileTokenCounts.get(token) || 0) + 1);
    }

    for (const [token, count] of fileTokenCounts.entries()) {
      if (!invertedMap.has(token)) {
        invertedMap.set(token, []);
      }
      invertedMap.get(token).push([relativePath, count]);
    }

    files.push({
      path: relativePath,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      line_count: lines,
      token_count: tokens.length
    });
    indexedFiles += 1;
  }

  const inverted = {};
  for (const [token, postings] of invertedMap.entries()) {
    inverted[token] = postings;
  }

  const payload = {
    version: 1,
    created_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    config: {
      max_files: maxFiles,
      max_file_size_kb: maxFileSizeKb
    },
    stats: {
      discovered_files: state.collected.length,
      indexed_files: indexedFiles,
      skipped_large_files: skippedLargeFiles,
      skipped_binary_files: skippedBinaryFiles,
      unique_tokens: Object.keys(inverted).length
    },
    files,
    inverted
  };

  const outputDir = path.join(workspaceRoot, INDEX_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = indexFilePath(workspaceRoot);
  await fs.writeFile(outputPath, JSON.stringify(payload), "utf8");

  return {
    ok: true,
    index_path: toPosixPath(path.relative(workspaceRoot, outputPath)),
    ...payload.stats
  };
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
  const ranked = rankMatches(index, tokens).slice(0, topK);

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
    total_hits: rankMatches(index, tokens).length,
    results
  };
}
