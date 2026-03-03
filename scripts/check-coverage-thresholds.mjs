import { spawn } from "node:child_process";

const DEFAULT_GLOBAL_THRESHOLDS = {
  line: 78,
  branch: 62,
  funcs: 85
};

const DEFAULT_CORE_FILE_LINE_THRESHOLDS = {
  "code-index.js": 88,
  "syntax-index.js": 82,
  "semantic-graph.js": 72,
  "tools.js": 90
};
const CORE_FILE_THRESHOLDS_ENV = "COVERAGE_CORE_LINE_THRESHOLDS";

function parseCoverageRows(outputText) {
  const rows = new Map();
  const lines = outputText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[\s]*ℹ\s?/, "").trimEnd();
    if (!line.includes("|")) {
      continue;
    }

    const parts = line.split("|").map((item) => item.trim());
    if (parts.length < 4) {
      continue;
    }

    const label = parts[0];
    const linePct = Number(parts[1]);
    const branchPct = Number(parts[2]);
    const funcsPct = Number(parts[3]);

    if (!label || !Number.isFinite(linePct) || !Number.isFinite(branchPct) || !Number.isFinite(funcsPct)) {
      continue;
    }

    rows.set(label, {
      line: linePct,
      branch: branchPct,
      funcs: funcsPct
    });
  }
  return rows;
}

function runCoverage() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--experimental-test-coverage"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let outputText = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      outputText += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      outputText += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      resolve({
        code: Number(code || 0),
        outputText
      });
    });
  });
}

function formatPct(value) {
  return Number(value).toFixed(2);
}

function parsePercentageValue(rawValue, envName) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid ${envName}: expected number in [0, 100], got "${rawValue}"`);
  }
  return parsed;
}

function readGlobalThresholds() {
  const line =
    typeof process.env.COVERAGE_MIN_LINE === "string"
      ? parsePercentageValue(process.env.COVERAGE_MIN_LINE, "COVERAGE_MIN_LINE")
      : DEFAULT_GLOBAL_THRESHOLDS.line;
  const branch =
    typeof process.env.COVERAGE_MIN_BRANCH === "string"
      ? parsePercentageValue(process.env.COVERAGE_MIN_BRANCH, "COVERAGE_MIN_BRANCH")
      : DEFAULT_GLOBAL_THRESHOLDS.branch;
  const funcs =
    typeof process.env.COVERAGE_MIN_FUNCS === "string"
      ? parsePercentageValue(process.env.COVERAGE_MIN_FUNCS, "COVERAGE_MIN_FUNCS")
      : DEFAULT_GLOBAL_THRESHOLDS.funcs;
  return { line, branch, funcs };
}

function parseCoreFileThresholdOverrides(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return {};
  }
  const overrides = {};
  const pairs = rawValue.split(",");
  for (const pair of pairs) {
    const item = pair.trim();
    if (!item) {
      continue;
    }
    const equalIndex = item.indexOf("=");
    if (equalIndex <= 0 || equalIndex >= item.length - 1) {
      throw new Error(
        `Invalid ${CORE_FILE_THRESHOLDS_ENV} entry "${item}". Expected format "file.js=80".`
      );
    }
    const fileName = item.slice(0, equalIndex).trim();
    const thresholdText = item.slice(equalIndex + 1).trim();
    if (!fileName) {
      throw new Error(
        `Invalid ${CORE_FILE_THRESHOLDS_ENV} entry "${item}". File name is empty.`
      );
    }
    overrides[fileName] = parsePercentageValue(
      thresholdText,
      `${CORE_FILE_THRESHOLDS_ENV}(${fileName})`
    );
  }
  return overrides;
}

function readCoreFileLineThresholds() {
  const thresholds = { ...DEFAULT_CORE_FILE_LINE_THRESHOLDS };
  const overrides = parseCoreFileThresholdOverrides(process.env[CORE_FILE_THRESHOLDS_ENV]);
  for (const [fileName, threshold] of Object.entries(overrides)) {
    thresholds[fileName] = threshold;
  }
  return thresholds;
}

function resolveThresholds() {
  return {
    global: readGlobalThresholds(),
    core_file_line: readCoreFileLineThresholds()
  };
}

function printThresholds(thresholds) {
  console.log(
    `Coverage thresholds: global(line=${thresholds.global.line}%, branch=${thresholds.global.branch}%, funcs=${thresholds.global.funcs}%)`
  );
  const fileEntries = Object.entries(thresholds.core_file_line).map(
    ([fileName, line]) => `${fileName}=${line}%`
  );
  if (fileEntries.length > 0) {
    console.log(`Coverage thresholds: core file line (${fileEntries.join(", ")})`);
  }
}

function checkThresholds(rows, thresholds) {
  const failures = [];

  const all = rows.get("all files");
  if (!all) {
    failures.push("missing 'all files' coverage summary row");
  } else {
    if (all.line < thresholds.global.line) {
      failures.push(
        `global line coverage ${formatPct(all.line)}% < ${thresholds.global.line}%`
      );
    }
    if (all.branch < thresholds.global.branch) {
      failures.push(
        `global branch coverage ${formatPct(all.branch)}% < ${thresholds.global.branch}%`
      );
    }
    if (all.funcs < thresholds.global.funcs) {
      failures.push(
        `global funcs coverage ${formatPct(all.funcs)}% < ${thresholds.global.funcs}%`
      );
    }
  }

  for (const [fileName, threshold] of Object.entries(thresholds.core_file_line)) {
    const row = rows.get(fileName);
    if (!row) {
      failures.push(`missing coverage row for ${fileName}`);
      continue;
    }
    if (row.line < threshold) {
      failures.push(
        `${fileName} line coverage ${formatPct(row.line)}% < ${threshold}%`
      );
    }
  }

  return failures;
}

async function main() {
  const thresholds = resolveThresholds();
  printThresholds(thresholds);

  const result = await runCoverage();
  if (result.code !== 0) {
    process.exit(result.code);
  }

  const rows = parseCoverageRows(result.outputText);
  const failures = checkThresholds(rows, thresholds);

  if (failures.length > 0) {
    console.error("Coverage gate failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  const all = rows.get("all files");
  console.log(
    `Coverage gate passed (all files line=${formatPct(all.line)}%, branch=${formatPct(all.branch)}%, funcs=${formatPct(all.funcs)}%).`
  );
}

main().catch((error) => {
  console.error(`Coverage gate failed: ${error.message || String(error)}`);
  process.exit(1);
});
