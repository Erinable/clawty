#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const tscPath = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  isWindows ? "tsc.cmd" : "tsc"
);

if (!fs.existsSync(tscPath)) {
  console.error(
    "typecheck failed: local TypeScript compiler not found. Run `npm install` to install dev dependencies."
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(tscPath, ["-p", "tsconfig.checkjs.json", "--noEmit"], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  process.exitCode = Number.isFinite(result.status) ? result.status : 1;
}
