import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDoctorCliArgs,
  runDoctor,
  formatDoctorReportText
} from "../src/doctor.js";
import { loadConfig } from "../src/config.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function findCheck(report, id) {
  return report.checks.find((item) => item.id === id);
}

test("parseDoctorCliArgs parses --json and --help", () => {
  assert.deepEqual(parseDoctorCliArgs([]), {
    format: "text",
    help: false
  });
  assert.deepEqual(parseDoctorCliArgs(["--json"]), {
    format: "json",
    help: false
  });
  assert.deepEqual(parseDoctorCliArgs(["--help"]), {
    format: "text",
    help: true
  });
  assert.throws(
    () => parseDoctorCliArgs(["--bad-flag"]),
    /Unknown doctor argument/
  );
});

test("runDoctor fails when OPENAI_API_KEY is missing", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {},
    allowMissingApiKey: true
  });
  const report = await runDoctor(config);

  const apiKeyCheck = findCheck(report, "openai_auth");
  assert.ok(apiKeyCheck);
  assert.equal(apiKeyCheck.status, "fail");
  assert.equal(report.ok, false);
});

test("runDoctor reports pass when api key is configured and emits text summary", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await writeWorkspaceFile(
    workspaceRoot,
    ".env",
    "OPENAI_API_KEY=sk-test\nCLAWTY_MODEL=gpt-4.1-mini\n"
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome
    },
    allowMissingApiKey: true
  });
  const report = await runDoctor(config);

  const apiKeyCheck = findCheck(report, "openai_auth");
  assert.ok(apiKeyCheck);
  assert.equal(apiKeyCheck.status, "pass");
  assert.ok(report.summary.total >= 8);
  const memoryDbCheck = findCheck(report, "memory_db");
  assert.ok(memoryDbCheck);
  assert.equal(memoryDbCheck.status, "pass");
  const memorySchemaCheck = findCheck(report, "memory_schema");
  assert.ok(memorySchemaCheck);
  assert.ok(["pass", "warn"].includes(memorySchemaCheck.status));

  const text = formatDoctorReportText(report);
  assert.match(text, /Clawty\.\.\. Doctor/);
  assert.match(text, /Summary/);
});

test("runDoctor resolves clawty installation version from tool package", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const packageJson = JSON.parse(packageRaw);
  const expectedVersion = String(packageJson.version || "").trim();
  assert.ok(expectedVersion);

  await writeWorkspaceFile(
    workspaceRoot,
    "package.json",
    JSON.stringify({ name: "workspace-app", version: "99.99.99" }, null, 2)
  );
  await writeWorkspaceFile(
    workspaceRoot,
    ".env",
    "OPENAI_API_KEY=sk-test\nCLAWTY_MODEL=gpt-4.1-mini\n"
  );

  const config = loadConfig({
    cwd: workspaceRoot,
    env: {},
    allowMissingApiKey: true
  });
  const report = await runDoctor(config);
  const installCheck = findCheck(report, "clawty_installation");

  assert.ok(installCheck);
  assert.equal(installCheck.status, "pass");
  assert.match(installCheck.message, new RegExp(`Version ${expectedVersion.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(installCheck.message, /99\.99\.99/);
});
