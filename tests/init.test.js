import test from "node:test";
import assert from "node:assert/strict";
import { parseInitCliArgs, runInit, formatInitReportText } from "../src/init.js";

function createConfig() {
  return {
    workspaceRoot: "/tmp/clawty-workspace",
    lsp: {
      enabled: true
    },
    embedding: {
      enabled: false
    }
  };
}

test("parseInitCliArgs parses defaults and flags", () => {
  assert.deepEqual(parseInitCliArgs([]), {
    help: false,
    format: "text",
    includeDoctor: true,
    includeSyntax: true,
    includeSemantic: true,
    includeVector: false,
    vectorLayer: "base",
    maxFiles: null,
    maxFileSizeKb: null,
    semanticSeedLangFilter: null
  });

  assert.deepEqual(
    parseInitCliArgs([
      "--json",
      "--no-doctor",
      "--no-syntax",
      "--no-semantic",
      "--include-vector",
      "--vector-layer",
      "delta",
      "--max-files",
      "123",
      "--max-file-size-kb=256",
      "--semantic-seed-lang-filter",
      "javascript,python"
    ]),
    {
      help: false,
      format: "json",
      includeDoctor: false,
      includeSyntax: false,
      includeSemantic: false,
      includeVector: true,
      vectorLayer: "delta",
      maxFiles: 123,
      maxFileSizeKb: 256,
      semanticSeedLangFilter: "javascript,python"
    }
  );

  assert.throws(() => parseInitCliArgs(["--bad-flag"]), /Unknown init argument/);
  assert.throws(() => parseInitCliArgs(["--vector-layer", "bad"]), /Invalid --vector-layer/);
});

test("runInit executes default pipeline and returns pass summary", async () => {
  const report = await runInit(
    createConfig(),
    {},
    {
      runDoctor: async () => ({
        ok: true,
        summary: { pass: 8, fail: 0, warn: 0 }
      }),
      buildCodeIndex: async () => ({
        ok: true,
        indexed_files: 120,
        chunk_count: 890,
        symbol_count: 320
      }),
      buildSyntaxIndex: async () => ({
        ok: true,
        parsed_files: 110,
        total_import_edges: 210,
        total_call_edges: 530
      }),
      buildSemanticGraph: async () => ({
        ok: true,
        total_nodes: 480,
        total_edges: 1400,
        lsp: { available: true }
      }),
      buildVectorIndex: async () => ({
        ok: true
      })
    }
  );

  assert.equal(report.ok, true);
  assert.equal(report.summary.pass, 4);
  assert.equal(report.summary.skip, 1);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.steps.find((item) => item.id === "vector_index")?.status, "skip");

  const text = formatInitReportText(report);
  assert.match(text, /Clawty\.\.\. Init/);
  assert.match(text, /Summary/);
});

test("runInit marks code index failure as hard failure and blocks dependent steps", async () => {
  let syntaxCalled = 0;
  let semanticCalled = 0;
  let vectorCalled = 0;
  const report = await runInit(
    createConfig(),
    {
      includeVector: true
    },
    {
      runDoctor: async () => ({
        ok: true,
        summary: { pass: 1, fail: 0, warn: 0 }
      }),
      buildCodeIndex: async () => ({
        ok: false,
        error: "index build failed"
      }),
      buildSyntaxIndex: async () => {
        syntaxCalled += 1;
        return { ok: true };
      },
      buildSemanticGraph: async () => {
        semanticCalled += 1;
        return { ok: true };
      },
      buildVectorIndex: async () => {
        vectorCalled += 1;
        return { ok: true };
      }
    }
  );

  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.skip, 3);
  assert.equal(syntaxCalled, 0);
  assert.equal(semanticCalled, 0);
  assert.equal(vectorCalled, 0);
});

test("runInit treats vector failure as warning when vector is optional", async () => {
  const report = await runInit(
    createConfig(),
    {
      includeVector: true
    },
    {
      runDoctor: async () => ({
        ok: true,
        summary: { pass: 1, fail: 0, warn: 0 }
      }),
      buildCodeIndex: async () => ({
        ok: true,
        indexed_files: 3,
        chunk_count: 9,
        symbol_count: 6
      }),
      buildSyntaxIndex: async () => ({
        ok: true,
        parsed_files: 3,
        total_import_edges: 4,
        total_call_edges: 10
      }),
      buildSemanticGraph: async () => ({
        ok: true,
        total_nodes: 8,
        total_edges: 15,
        lsp: { available: false }
      }),
      buildVectorIndex: async () => ({
        ok: false,
        error: "embedding api key is missing"
      })
    }
  );

  assert.equal(report.ok, true);
  assert.equal(report.summary.warn, 1);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.steps.find((item) => item.id === "vector_index")?.status, "warn");
});
