import path from "node:path";

export const WATCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".clawty"
]);

const WATCH_CODE_EXTENSIONS = new Set([
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

export function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

export function shouldTrackWatchPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return false;
  }
  const normalized = toPosixPath(relativePath.trim());
  const parts = normalized.split("/");
  if (parts.some((part) => WATCH_IGNORED_DIRS.has(part))) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  return WATCH_CODE_EXTENSIONS.has(ext);
}
