import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("uninstall ignores malformed project config and still cleans clawty home", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  const clawtyHome = path.join(fakeHome, ".clawty");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, path.join(".clawty", "config.json"), "{ invalid ");
  await writeWorkspaceFile(workspaceRoot, path.join("fake-home", ".clawty", "bin", "clawty"), "stub");
  await writeWorkspaceFile(workspaceRoot, path.join("fake-home", ".clawty", "config.json"), "{}");

  const { stdout } = await runCli(["uninstall", "--yes", "--skip-npm"], {
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome
    }
  });
  assert.match(stdout, /clawty uninstalled/);

  await assert.rejects(async () => fs.access(clawtyHome), /ENOENT/);
});

