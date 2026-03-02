import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { validatePreciseIndexPayload } from "../scripts/check-precise-index.mjs";

test("validatePreciseIndexPayload accepts valid SCIP normalized payload", async () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "tests/fixtures/precise/scip.normalized.json"
  );
  const payload = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const result = validatePreciseIndexPayload(payload, {});
  assert.equal(result.ok, true);
  assert.equal(result.summary.counts.nodes, 2);
  assert.equal(result.summary.counts.edges, 1);
});

test("validatePreciseIndexPayload rejects empty graph by default", () => {
  const payload = {
    format: "scip-normalized/v1",
    nodes: [],
    edges: []
  };
  const result = validatePreciseIndexPayload(payload, {});
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /empty/i);
});

test("validatePreciseIndexPayload rejects malformed nodes and edges", () => {
  const payload = {
    format: "scip-normalized/v1",
    nodes: [{ symbol: "n1" }],
    edges: [{ edge_type: "call" }]
  };
  const result = validatePreciseIndexPayload(payload, {});
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /nodes missing path/i);
  assert.match(result.errors.join(" | "), /edges missing from\/to endpoint/i);
});
