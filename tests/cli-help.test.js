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
  assert.match(stdout, /clawty completion \[shell\]/);
  assert.match(stdout, /clawty config <command>/);
  assert.match(stdout, /-h, --help/);
  assert.match(stdout, /-v, --version/);
});

test("config help exposes normalized subcommands", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "config", "--help"]);
  assert.match(stdout, /^== clawty ==/);
  assert.match(stdout, /clawty config show/);
  assert.match(stdout, /clawty config path/);
  assert.match(stdout, /clawty config validate/);
});

test("memory help exposes inspect/reindex and reason option", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "memory", "--help"]);
  assert.match(stdout, /^== clawty ==/);
  assert.match(stdout, /clawty memory inspect <lessonId>/);
  assert.match(stdout, /clawty memory reindex/);
  assert.match(stdout, /--explain/);
  assert.match(stdout, /--reason <wrong\|stale\|unsafe\|irrelevant\|good>/);
});

test("completion command emits shell script", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "completion", "bash"]);
  assert.match(stdout, /complete -F _clawty_completion clawty/);
});

test("version flag prints semantic version", async () => {
  const { stdout } = await execFileAsync("node", [CLI_PATH, "--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});
