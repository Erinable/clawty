import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CASES_PATH = path.resolve(process.cwd(), "tests/fixtures/hybrid-cases/expected.json");
const DEFAULT_FAILURES_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/hybrid-cases/failure-samples.json"
);
const DEFAULT_REQUIREMENTS = Object.freeze({
  minCases: 5,
  minLanguages: 2,
  minIntents: 3,
  minQueryPatterns: 4,
  minFileTypes: 2,
  minFailureSamples: 1
});

function parseNonNegativeInt(raw, argName) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${argName} argument`);
  }
  return Math.floor(value);
}

function normalizeLabel(value, fallback = "unknown") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function incrementCount(map, key) {
  map.set(key, Number(map.get(key) || 0) + 1);
}

function toSortedObject(map) {
  return Object.fromEntries(
    Array.from(map.entries()).sort((a, b) => {
      const countDiff = Number(b[1] || 0) - Number(a[1] || 0);
      if (countDiff !== 0) {
        return countDiff;
      }
      return String(a[0]).localeCompare(String(b[0]));
    })
  );
}

function parseArgs(argv) {
  const options = {
    casesPath: DEFAULT_CASES_PATH,
    failuresPath: DEFAULT_FAILURES_PATH,
    format: "text",
    requirements: {
      ...DEFAULT_REQUIREMENTS
    }
  };

  for (const arg of argv) {
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
      continue;
    }
    if (arg === "--format=text") {
      options.format = "text";
      continue;
    }
    if (arg.startsWith("--cases=")) {
      const value = arg.slice("--cases=".length).trim();
      if (!value) {
        throw new Error("Invalid --cases argument");
      }
      options.casesPath = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg.startsWith("--failures=")) {
      const value = arg.slice("--failures=".length).trim();
      if (!value) {
        throw new Error("Invalid --failures argument");
      }
      options.failuresPath = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg.startsWith("--min-cases=")) {
      options.requirements.minCases = parseNonNegativeInt(
        arg.slice("--min-cases=".length),
        "--min-cases"
      );
      continue;
    }
    if (arg.startsWith("--min-languages=")) {
      options.requirements.minLanguages = parseNonNegativeInt(
        arg.slice("--min-languages=".length),
        "--min-languages"
      );
      continue;
    }
    if (arg.startsWith("--min-intents=")) {
      options.requirements.minIntents = parseNonNegativeInt(
        arg.slice("--min-intents=".length),
        "--min-intents"
      );
      continue;
    }
    if (arg.startsWith("--min-query-patterns=")) {
      options.requirements.minQueryPatterns = parseNonNegativeInt(
        arg.slice("--min-query-patterns=".length),
        "--min-query-patterns"
      );
      continue;
    }
    if (arg.startsWith("--min-file-types=")) {
      options.requirements.minFileTypes = parseNonNegativeInt(
        arg.slice("--min-file-types=".length),
        "--min-file-types"
      );
      continue;
    }
    if (arg.startsWith("--min-failure-samples=")) {
      options.requirements.minFailureSamples = parseNonNegativeInt(
        arg.slice("--min-failure-samples=".length),
        "--min-failure-samples"
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function validateCases(cases) {
  const caseRows = Array.isArray(cases) ? cases : [];
  const languageCounts = new Map();
  const intentCounts = new Map();
  const queryPatternCounts = new Map();
  const fileTypeCounts = new Map();
  const caseNameSet = new Set();
  const duplicateCaseNames = [];
  const invalidCases = [];

  for (let index = 0; index < caseRows.length; index += 1) {
    const item = caseRows[index] || {};
    const errors = [];
    const name = normalizeLabel(item.name, "");
    if (!name) {
      errors.push("missing name");
    } else if (caseNameSet.has(name)) {
      errors.push("duplicate name");
      duplicateCaseNames.push(name);
    } else {
      caseNameSet.add(name);
    }

    const query = normalizeLabel(item?.args?.query, "");
    if (!query) {
      errors.push("missing args.query");
    }

    const language = normalizeLabel(item.language, "");
    if (!language) {
      errors.push("missing language");
    } else {
      incrementCount(languageCounts, language);
    }

    const intent = normalizeLabel(item.intent, "");
    if (!intent) {
      errors.push("missing intent");
    } else {
      incrementCount(intentCounts, intent);
    }

    const queryPattern = normalizeLabel(item.query_pattern, "");
    if (!queryPattern) {
      errors.push("missing query_pattern");
    } else {
      incrementCount(queryPatternCounts, queryPattern);
    }

    const fileType = normalizeLabel(item.file_type, "");
    if (!fileType) {
      errors.push("missing file_type");
    } else {
      incrementCount(fileTypeCounts, fileType);
    }

    if (errors.length > 0) {
      invalidCases.push({
        index,
        name: name || `__index_${index}`,
        errors
      });
    }
  }

  return {
    caseCount: caseRows.length,
    languageCounts,
    intentCounts,
    queryPatternCounts,
    fileTypeCounts,
    invalidCases,
    duplicateCaseNames
  };
}

function failureSampleKey(sample) {
  const name = normalizeLabel(sample?.name, "unknown_case");
  const primaryPath = normalizeLabel(sample?.primary_path, "");
  return `${name}::${primaryPath}`;
}

function validateFailures(failuresPayload) {
  const presets = Array.isArray(failuresPayload?.presets) ? failuresPayload.presets : [];
  const presetNameSet = new Set();
  const duplicatePresetNames = [];
  const duplicateFailureKeys = [];
  const invalidFailureSamples = [];
  const byPresetCounts = new Map();
  let totalFailureSamples = 0;

  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index] || {};
    const presetName = normalizeLabel(preset.name, "");
    if (!presetName) {
      invalidFailureSamples.push({
        preset: `__index_${index}`,
        name: "unknown",
        errors: ["missing preset name"]
      });
      continue;
    }
    if (presetNameSet.has(presetName)) {
      duplicatePresetNames.push(presetName);
    } else {
      presetNameSet.add(presetName);
    }

    const samples = Array.isArray(preset.failure_samples) ? preset.failure_samples : [];
    byPresetCounts.set(presetName, samples.length);
    totalFailureSamples += samples.length;

    const declaredFailureCount = Number(preset.failure_count);
    if (
      Number.isFinite(declaredFailureCount) &&
      Math.floor(declaredFailureCount) !== samples.length
    ) {
      invalidFailureSamples.push({
        preset: presetName,
        name: "__summary__",
        errors: [
          `failure_count mismatch: declared=${Math.floor(declaredFailureCount)} actual=${samples.length}`
        ]
      });
    }

    const sampleKeySet = new Set();
    for (const sample of samples) {
      const errors = [];
      const sampleName = normalizeLabel(sample?.name, "");
      if (!sampleName) {
        errors.push("missing sample name");
      }
      const reasons = Array.isArray(sample?.failure_reasons) ? sample.failure_reasons : [];
      if (reasons.length === 0) {
        errors.push("missing failure_reasons");
      }
      const key = failureSampleKey(sample);
      if (sampleKeySet.has(key)) {
        errors.push("duplicate failure sample key");
        duplicateFailureKeys.push(`${presetName}:${key}`);
      } else {
        sampleKeySet.add(key);
      }

      if (errors.length > 0) {
        invalidFailureSamples.push({
          preset: presetName,
          name: sampleName || "unknown_case",
          errors
        });
      }
    }
  }

  return {
    presetCount: presets.length,
    totalFailureSamples,
    byPresetCounts,
    invalidFailureSamples,
    duplicatePresetNames,
    duplicateFailureKeys
  };
}

function buildThresholdChecks(dataset, requirements) {
  return [
    {
      name: "case_count",
      current: dataset.caseCount,
      min: requirements.minCases
    },
    {
      name: "language_count",
      current: dataset.languageCounts.size,
      min: requirements.minLanguages
    },
    {
      name: "intent_count",
      current: dataset.intentCounts.size,
      min: requirements.minIntents
    },
    {
      name: "query_pattern_count",
      current: dataset.queryPatternCounts.size,
      min: requirements.minQueryPatterns
    },
    {
      name: "file_type_count",
      current: dataset.fileTypeCounts.size,
      min: requirements.minFileTypes
    },
    {
      name: "failure_sample_count",
      current: dataset.totalFailureSamples,
      min: requirements.minFailureSamples
    }
  ].map((item) => ({
    ...item,
    ok: item.current >= item.min
  }));
}

function buildIntegrityChecks(caseValidation, failureValidation) {
  return [
    {
      name: "invalid_case_rows",
      ok: caseValidation.invalidCases.length === 0,
      current: caseValidation.invalidCases.length,
      max: 0
    },
    {
      name: "duplicate_case_names",
      ok: caseValidation.duplicateCaseNames.length === 0,
      current: caseValidation.duplicateCaseNames.length,
      max: 0
    },
    {
      name: "invalid_failure_samples",
      ok: failureValidation.invalidFailureSamples.length === 0,
      current: failureValidation.invalidFailureSamples.length,
      max: 0
    },
    {
      name: "duplicate_failure_keys",
      ok: failureValidation.duplicateFailureKeys.length === 0,
      current: failureValidation.duplicateFailureKeys.length,
      max: 0
    },
    {
      name: "duplicate_failure_presets",
      ok: failureValidation.duplicatePresetNames.length === 0,
      current: failureValidation.duplicatePresetNames.length,
      max: 0
    }
  ];
}

export function evaluateHybridReplayCoverage(casesPayload, failuresPayload, requirements) {
  const normalizedRequirements = {
    ...DEFAULT_REQUIREMENTS,
    ...(requirements && typeof requirements === "object" ? requirements : {})
  };
  const caseValidation = validateCases(casesPayload?.cases);
  const failureValidation = validateFailures(failuresPayload);

  const thresholdChecks = buildThresholdChecks(
    {
      ...caseValidation,
      totalFailureSamples: failureValidation.totalFailureSamples
    },
    normalizedRequirements
  );
  const integrityChecks = buildIntegrityChecks(caseValidation, failureValidation);
  const checks = [...thresholdChecks, ...integrityChecks];

  const ok = checks.every((item) => item.ok);

  return {
    ok,
    requirements: normalizedRequirements,
    checks,
    dataset: {
      case_count: caseValidation.caseCount,
      language_count: caseValidation.languageCounts.size,
      intent_count: caseValidation.intentCounts.size,
      query_pattern_count: caseValidation.queryPatternCounts.size,
      file_type_count: caseValidation.fileTypeCounts.size,
      failure_sample_count: failureValidation.totalFailureSamples,
      failure_preset_count: failureValidation.presetCount,
      distribution: {
        language: toSortedObject(caseValidation.languageCounts),
        intent: toSortedObject(caseValidation.intentCounts),
        query_pattern: toSortedObject(caseValidation.queryPatternCounts),
        file_type: toSortedObject(caseValidation.fileTypeCounts),
        failure_preset: toSortedObject(failureValidation.byPresetCounts)
      }
    },
    validation: {
      invalid_case_rows: caseValidation.invalidCases,
      duplicate_case_names: caseValidation.duplicateCaseNames,
      invalid_failure_samples: failureValidation.invalidFailureSamples,
      duplicate_failure_keys: failureValidation.duplicateFailureKeys,
      duplicate_failure_presets: failureValidation.duplicatePresetNames
    }
  };
}

function printTextReport(result, options) {
  console.log("Hybrid replay coverage gate");
  console.log(`- cases path: ${path.relative(process.cwd(), options.casesPath)}`);
  console.log(`- failures path: ${path.relative(process.cwd(), options.failuresPath)}`);
  console.log(
    `- cases=${result.dataset.case_count}, languages=${result.dataset.language_count}, intents=${result.dataset.intent_count}, query_patterns=${result.dataset.query_pattern_count}, file_types=${result.dataset.file_type_count}`
  );
  console.log(
    `- failure samples=${result.dataset.failure_sample_count}, failure presets=${result.dataset.failure_preset_count}`
  );
  console.log("");
  for (const item of result.checks) {
    if (Object.hasOwn(item, "min")) {
      const label = item.ok ? "OK" : "FAIL";
      console.log(`- ${label} ${item.name}: current=${item.current}, required>=${item.min}`);
      continue;
    }
    const label = item.ok ? "OK" : "FAIL";
    console.log(`- ${label} ${item.name}: current=${item.current}, required<=${item.max}`);
  }

  if (result.ok) {
    console.log("Hybrid replay coverage gate passed.");
    return;
  }

  console.log("Hybrid replay coverage gate failed.");
}

export async function runHybridReplayCoverageCheck(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const [casesPayload, failuresPayload] = await Promise.all([
    readJson(options.casesPath),
    readJson(options.failuresPath)
  ]);

  const result = evaluateHybridReplayCoverage(
    casesPayload,
    failuresPayload,
    options.requirements
  );
  const payload = {
    generated_at: new Date().toISOString(),
    inputs: {
      cases_path: path.relative(process.cwd(), options.casesPath),
      failures_path: path.relative(process.cwd(), options.failuresPath)
    },
    ...result
  };

  if (options.format === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printTextReport(payload, options);
  }

  if (!payload.ok) {
    throw new Error("Hybrid replay coverage requirements not met");
  }
  return payload;
}

const isDirectExecution = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isDirectExecution) {
  runHybridReplayCoverageCheck().catch((error) => {
    console.error(`Hybrid replay coverage check failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

export { parseArgs };
