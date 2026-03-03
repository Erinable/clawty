import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

async function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env || {})
  };
  return execFileAsync("node", [CLI_PATH, ...args], {
    cwd: options.cwd || process.cwd(),
    env,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

test("monitor report returns combined metrics+tuner payload", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-monitor-report-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const { stdout } = await runCli(["monitor", "report", "--json"], {
    cwd: workspaceRoot
  });
  const payload = JSON.parse(stdout);
  assert.ok(payload.metrics);
  assert.ok(payload.tuner);
  const expectedWorkspace = await realpath(workspaceRoot);
  assert.equal(await realpath(payload.metrics.workspace_root), expectedWorkspace);
  assert.equal(await realpath(payload.tuner.workspace_root), expectedWorkspace);
});

test("monitor help includes subcommands and watch options", async () => {
  const { stdout } = await runCli(["monitor", "--help"]);
  assert.match(stdout, /clawty monitor report/);
  assert.match(stdout, /clawty monitor metrics/);
  assert.match(stdout, /clawty monitor tuner/);
  assert.match(stdout, /--watch/);
  assert.match(stdout, /--interval-ms <n>/);
});

test("mcp-server help includes workspace option", async () => {
  const { stdout } = await runCli(["mcp-server", "--help"]);
  assert.match(stdout, /clawty mcp-server/);
  assert.match(stdout, /--workspace <path>/);
  assert.match(stdout, /--toolset <name>/);
  assert.match(stdout, /--expose-low-level/);
});
