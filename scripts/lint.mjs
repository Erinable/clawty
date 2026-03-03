#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT_DIRS = ["src", "tests", "scripts"];
const FILE_PATTERNS = [".js", ".mjs"];
const IGNORE_SEGMENTS = new Set(["node_modules", "dist", ".git", ".clawty"]);

function collectWithRipgrep() {
  const result = spawnSync(
    "rg",
    [
      "--files",
      ...ROOT_DIRS.flatMap((root) =>
        FILE_PATTERNS.flatMap((pattern) => ["-g", `${root}/**/*${pattern}`])
      )
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function collectFilesRecursively() {
  const files = [];

  async function walk(relativeDir) {
    const absoluteDir = path.resolve(process.cwd(), relativeDir);
    let entries = [];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextRelative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_SEGMENTS.has(entry.name)) {
          continue;
        }
        await walk(nextRelative);
        continue;
      }
      if (!FILE_PATTERNS.some((suffix) => entry.name.endsWith(suffix))) {
        continue;
      }
      files.push(nextRelative);
    }
  }

  for (const root of ROOT_DIRS) {
    await walk(root);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function runSyntaxCheck(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function printFailure(filePath, details) {
  const output = [details.stdout, details.stderr].filter(Boolean).join("\n").trim();
  console.error(`\n[lint] ${filePath}`);
  if (output) {
    console.error(output);
  }
}

async function main() {
  const files = collectWithRipgrep() || (await collectFilesRecursively());
  if (!Array.isArray(files) || files.length === 0) {
    console.log("lint: no JavaScript files found");
    return;
  }

  const failures = [];
  for (const filePath of files) {
    const result = runSyntaxCheck(filePath);
    if (!result.ok) {
      failures.push({
        filePath,
        result
      });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      printFailure(failure.filePath, failure.result);
    }
    console.error(`\nlint failed: ${failures.length} file(s) have syntax errors.`);
    process.exitCode = 1;
    return;
  }

  console.log(`lint passed: ${files.length} file(s) checked.`);
}

await main();
