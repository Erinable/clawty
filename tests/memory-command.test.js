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
import { recordLesson } from "../src/memory.js";

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

test("memory search and feedback commands work with json output", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    path.join(".clawty", "config.json"),
    JSON.stringify({ memory: { enabled: true } }, null, 2)
  );

  await recordLesson(
    workspaceRoot,
    {
      title: "CLI memory case",
      lesson: "Use memory search to find historical fixes for auth timeout in oauth-2 ci-cd flow.",
      tags: ["cli", "memory", "oauth-2", "ci-cd"]
    },
    {
      homeDir: fakeHome,
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome
      }
    }
  );

  const { stdout: searchStdout } = await runCli(["memory", "search", "auth timeout", "--json"], {
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome
    }
  });
  const searchPayload = JSON.parse(searchStdout);
  assert.equal(searchPayload.ok, true);
  assert.ok(Array.isArray(searchPayload.items));
  assert.ok(searchPayload.items.length >= 1);

  const { stdout: hyphenSearchStdout } = await runCli(["memory", "search", "oauth-2 ci-cd", "--json"], {
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome
    }
  });
  const hyphenPayload = JSON.parse(hyphenSearchStdout);
  assert.equal(hyphenPayload.ok, true);
  assert.ok(Array.isArray(hyphenPayload.items));
  assert.ok(hyphenPayload.items.length >= 1);

  const targetId = searchPayload.items[0].id;
  const { stdout: feedbackStdout } = await runCli(
    ["memory", "feedback", String(targetId), "--vote", "up", "--json"],
    {
      cwd: workspaceRoot,
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome
      }
    }
  );
  const feedbackPayload = JSON.parse(feedbackStdout);
  assert.equal(feedbackPayload.ok, true);
});
