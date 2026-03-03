import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOOLSETS,
  parseToolsetTokens,
  resolveEnabledToolsets,
  resolveFacadeToolNamesForToolsets
} from "../src/mcp-toolset-policy.js";

test("parseToolsetTokens normalizes csv and array inputs", () => {
  const tokens = parseToolsetTokens(["Analysis, ops", " edit-safe ", null]);
  assert.deepEqual(tokens, ["analysis", "ops", "edit-safe"]);
});

test("resolveEnabledToolsets returns defaults when input is empty", () => {
  const enabled = resolveEnabledToolsets(undefined);
  assert.deepEqual(Array.from(enabled).sort(), [...DEFAULT_TOOLSETS].sort());
});

test("resolveEnabledToolsets expands all", () => {
  const enabled = resolveEnabledToolsets("all");
  assert.deepEqual(Array.from(enabled).sort(), ["analysis", "edit-safe", "ops"]);
});

test("resolveEnabledToolsets rejects unknown token", () => {
  assert.throws(
    () => resolveEnabledToolsets("analysis,unknown"),
    /Unknown toolset: unknown/
  );
});

test("resolveFacadeToolNamesForToolsets maps toolsets to expected facade tools", () => {
  const names = resolveFacadeToolNamesForToolsets(new Set(["analysis", "ops"]));
  assert.equal(names.has("search_code"), true);
  assert.equal(names.has("monitor_system"), true);
  assert.equal(names.has("reindex_codebase"), false);
});
