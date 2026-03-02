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

test("config path reports global/project locations with json", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    path.join("fake-home", ".clawty", "config.json"),
    JSON.stringify({ model: "global-model" }, null, 2)
  );
  await writeWorkspaceFile(
    workspaceRoot,
    path.join(".clawty", "config.json"),
    JSON.stringify({ model: "project-model" }, null, 2)
  );

  const { stdout } = await runCli(["config", "path", "--json"], {
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome
    }
  });

  const payload = JSON.parse(stdout);
  assert.match(payload.project_config_path || "", /\.clawty\/config\.json$/);
  assert.match(payload.global_config_path || "", /fake-home\/\.clawty\/config\.json$/);
  assert.match(payload.active_config_path || "", /\.clawty\/config\.json$/);
});

test("config validate returns warning for missing api key and no failure", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    path.join("fake-home", ".clawty", "config.json"),
    JSON.stringify({ model: "global-model" }, null, 2)
  );

  const { stdout } = await runCli(["config", "validate", "--json"], {
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      OPENAI_API_KEY: ""
    }
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.summary.warn >= 1);
});

test("config validate fails for invalid project config json", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(workspaceRoot, path.join(".clawty", "config.json"), "{ invalid ");

  await assert.rejects(
    async () =>
      runCli(["config", "validate", "--json"], {
        cwd: workspaceRoot,
        env: {
          HOME: fakeHome,
          USERPROFILE: fakeHome
        }
      }),
    /Command failed/
  );
});
