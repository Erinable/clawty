import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { buildCodeIndex, queryCodeIndex } from "../src/code-index.js";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures/index-cases");
const INPUT_ROOT = path.join(FIXTURE_ROOT, "input");
const EXPECTED_FILE = path.join(FIXTURE_ROOT, "expected.json");

async function copyDirContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

function assertQualityCase(caseDef, result) {
  const expect = caseDef.expect || {};

  if (typeof expect.total_hits === "number") {
    assert.equal(result.total_hits, expect.total_hits, `${caseDef.name}: total_hits mismatch`);
  }

  if (typeof expect.min_total_hits === "number") {
    assert.ok(
      result.total_hits >= expect.min_total_hits,
      `${caseDef.name}: total_hits should be >= ${expect.min_total_hits}, got ${result.total_hits}`
    );
  }

  if (expect.top_path) {
    assert.equal(
      result.results[0]?.path,
      expect.top_path,
      `${caseDef.name}: top_path mismatch`
    );
  }

  if (expect.filter_path_prefix) {
    assert.equal(
      result.filters?.path_prefix,
      expect.filter_path_prefix,
      `${caseDef.name}: filter path_prefix mismatch`
    );
  }

  if (expect.filter_language) {
    assert.equal(
      result.filters?.language,
      expect.filter_language,
      `${caseDef.name}: filter language mismatch`
    );
  }

  if (expect.all_path_prefix) {
    assert.ok(
      result.results.every((item) => item.path.startsWith(expect.all_path_prefix)),
      `${caseDef.name}: some paths are outside prefix ${expect.all_path_prefix}`
    );
  }

  if (expect.require_explain) {
    assert.ok(
      result.results.length > 0 && result.results.every((item) => Boolean(item.explain)),
      `${caseDef.name}: explain payload missing`
    );
  }
}

test("code index quality regression cases", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await copyDirContents(INPUT_ROOT, workspaceRoot);
  const build = await buildCodeIndex(workspaceRoot, {});
  assert.equal(build.ok, true);
  assert.ok(build.indexed_files >= 5);

  const expected = JSON.parse(await fs.readFile(EXPECTED_FILE, "utf8"));
  assert.ok(Array.isArray(expected.queries));
  assert.ok(expected.queries.length > 0);

  for (const caseDef of expected.queries) {
    const result = await queryCodeIndex(workspaceRoot, caseDef.args || {});
    assert.equal(result.ok, true, `${caseDef.name}: query should succeed`);
    assertQualityCase(caseDef, result);
  }
});
