import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

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
    maxBuffer: 1024 * 1024
  });
}

test("config show returns effective config JSON", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    path.join(".clawty", "config.json"),
    JSON.stringify(
      {
        model: "gpt-4.1-mini",
        logging: {
          level: "warn"
        }
      },
      null,
      2
    )
  );

  const { stdout } = await runCli(["config", "show"], {
    cwd: workspaceRoot,
    env: {
      OPENAI_API_KEY: "sk-test"
    }
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.model, "gpt-4.1-mini");
  assert.equal(payload.logging.level, "warn");
});

test("config path and validate are removed from public CLI", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await assert.rejects(
    async () => runCli(["config", "path"], { cwd: workspaceRoot }),
    /removed from public CLI/
  );
  await assert.rejects(
    async () => runCli(["config", "validate"], { cwd: workspaceRoot }),
    /removed from public CLI/
  );
});
