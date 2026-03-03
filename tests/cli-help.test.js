import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

test("root help follows normalized sections and logo", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "--help"]);
  assert.match(stdout, /^== clawty ==/);
  assert.match(stdout, /Commands:/);
  assert.match(stdout, /Options:/);
  assert.match(stdout, /clawty config \[show\]/);
  assert.match(stdout, /clawty memory \[search\|stats\]/);
  assert.match(stdout, /clawty monitor \[report\]/);
  assert.match(stdout, /clawty mcp-server/);
  assert.doesNotMatch(stdout, /clawty completion \[shell\]/);
  assert.doesNotMatch(stdout, /clawty upgrade/);
  assert.doesNotMatch(stdout, /clawty uninstall/);
  assert.match(stdout, /-h, --help/);
  assert.match(stdout, /-v, --version/);
});

test("config help exposes simplified command", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "config", "--help"]);
  assert.match(stdout, /^== clawty ==/);
  assert.match(stdout, /clawty config \[show\]/);
  assert.doesNotMatch(stdout, /clawty config path/);
  assert.doesNotMatch(stdout, /clawty config validate/);
});

test("memory help exposes simplified public commands", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "memory", "--help"]);
  assert.match(stdout, /^== clawty ==/);
  assert.match(stdout, /clawty memory search <query>/);
  assert.match(stdout, /clawty memory stats/);
  assert.match(stdout, /--explain/);
  assert.doesNotMatch(stdout, /--reason <wrong\|stale\|unsafe\|irrelevant\|good>/);
  assert.doesNotMatch(stdout, /clawty memory inspect/);
  assert.doesNotMatch(stdout, /clawty memory reindex/);
});

test("removed maintenance commands return clear error", async () => {
  await assert.rejects(
    async () => execFileAsync("node", [CLI_PATH, "completion", "bash"]),
    /removed from public CLI/
  );
  await assert.rejects(
    async () => execFileAsync("node", [CLI_PATH, "upgrade"]),
    /removed from public CLI/
  );
  await assert.rejects(
    async () => execFileAsync("node", [CLI_PATH, "uninstall", "--yes", "--skip-npm"]),
    /removed from public CLI/
  );
});

test("version flag prints semantic version", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});
