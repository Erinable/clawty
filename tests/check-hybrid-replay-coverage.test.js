import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateHybridReplayCoverage,
  parseArgs
} from "../scripts/check-hybrid-replay-coverage.mjs";

function createValidCases() {
  return {
    cases: [
      {
        name: "ts_baseline",
        language: "typescript",
        intent: "baseline",
        query_pattern: "identifier_exact",
        file_type: "source",
        args: { query: "token_a" }
      },
      {
        name: "ts_rerank",
        language: "typescript",
        intent: "rerank",
        query_pattern: "cross_file_semantic",
        file_type: "test",
        args: { query: "token_b" }
      },
      {
        name: "ts_timeout",
        language: "typescript",
        intent: "degrade_timeout",
        query_pattern: "timeout_resilience",
        file_type: "source",
        args: { query: "token_c" }
      },
      {
        name: "py_lookup",
        language: "python",
        intent: "baseline",
        query_pattern: "cross_language_identifier",
        file_type: "source",
        args: { query: "token_d" }
      },
      {
        name: "py_rerank",
        language: "python",
        intent: "rerank",
        query_pattern: "cross_file_semantic",
        file_type: "test",
        args: { query: "token_e" }
      }
    ]
  };
}

function createValidFailures() {
  return {
    presets: [
      {
        name: "baseline_fixture",
        failure_count: 0,
        failure_samples: []
      },
      {
        name: "embedding_light",
        failure_count: 1,
        failure_samples: [
          {
            name: "ts_baseline",
            primary_path: "src/a.ts",
            failure_reasons: ["embedding_status_mismatch"]
          }
        ]
      }
    ]
  };
}

test("evaluateHybridReplayCoverage passes when requirements are met", () => {
  const result = evaluateHybridReplayCoverage(createValidCases(), createValidFailures(), {
    minCases: 5,
    minLanguages: 2,
    minIntents: 3,
    minQueryPatterns: 4,
    minFileTypes: 2,
    minFailureSamples: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.dataset.case_count, 5);
  assert.equal(result.dataset.language_count, 2);
  assert.equal(result.dataset.intent_count, 3);
  assert.equal(result.dataset.query_pattern_count, 4);
  assert.equal(result.dataset.file_type_count, 2);
  assert.equal(result.dataset.failure_sample_count, 1);
});

test("evaluateHybridReplayCoverage fails on invalid rows and missing depth", () => {
  const badCases = {
    cases: [
      {
        name: "dup_case",
        language: "typescript",
        intent: "baseline",
        query_pattern: "identifier_exact",
        file_type: "source",
        args: { query: "token_a" }
      },
      {
        name: "dup_case",
        language: "",
        intent: "baseline",
        query_pattern: "",
        file_type: "source",
        args: {}
      }
    ]
  };
  const badFailures = {
    presets: [
      {
        name: "embedding_light",
        failure_count: 2,
        failure_samples: [
          {
            name: "dup_case",
            primary_path: "src/a.ts",
            failure_reasons: []
          },
          {
            name: "dup_case",
            primary_path: "src/a.ts",
            failure_reasons: ["embedding_status_mismatch"]
          }
        ]
      }
    ]
  };

  const result = evaluateHybridReplayCoverage(badCases, badFailures, {
    minCases: 5,
    minLanguages: 2,
    minIntents: 3,
    minQueryPatterns: 4,
    minFileTypes: 2,
    minFailureSamples: 1
  });

  assert.equal(result.ok, false);
  assert.ok(result.validation.invalid_case_rows.length > 0);
  assert.ok(result.validation.duplicate_case_names.length > 0);
  assert.ok(result.validation.invalid_failure_samples.length > 0);
  assert.ok(result.validation.duplicate_failure_keys.length > 0);
  assert.ok(result.checks.some((item) => item.name === "case_count" && item.ok === false));
});

test("parseArgs supports requirement overrides and json format", () => {
  const parsed = parseArgs([
    "--json",
    "--cases=tests/fixtures/hybrid-cases/expected.json",
    "--failures=tests/fixtures/hybrid-cases/failure-samples.json",
    "--min-cases=8",
    "--min-languages=3",
    "--min-intents=4",
    "--min-query-patterns=6",
    "--min-file-types=2",
    "--min-failure-samples=2"
  ]);

  assert.equal(parsed.format, "json");
  assert.equal(parsed.requirements.minCases, 8);
  assert.equal(parsed.requirements.minLanguages, 3);
  assert.equal(parsed.requirements.minIntents, 4);
  assert.equal(parsed.requirements.minQueryPatterns, 6);
  assert.equal(parsed.requirements.minFileTypes, 2);
  assert.equal(parsed.requirements.minFailureSamples, 2);
  assert.ok(parsed.casesPath.endsWith("tests/fixtures/hybrid-cases/expected.json"));
  assert.ok(parsed.failuresPath.endsWith("tests/fixtures/hybrid-cases/failure-samples.json"));
});
