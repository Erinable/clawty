import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

test("uninstall command is removed from public CLI", async () => {
  await assert.rejects(
    async () => execFileAsync("node", [CLI_PATH, "uninstall", "--yes", "--skip-npm"]),
    /removed from public CLI/
  );
});
