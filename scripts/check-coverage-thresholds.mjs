import { spawn } from "node:child_process";

const GLOBAL_THRESHOLDS = {
  line: 80,
  branch: 65,
  funcs: 85
};

const CORE_FILE_LINE_THRESHOLDS = {
  "code-index.js": 88,
  "syntax-index.js": 82,
  "semantic-graph.js": 72,
  "tools.js": 90
};

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

function checkThresholds(rows) {
  const failures = [];

  const all = rows.get("all files");
  if (!all) {
    failures.push("missing 'all files' coverage summary row");
  } else {
    if (all.line < GLOBAL_THRESHOLDS.line) {
      failures.push(
        `global line coverage ${formatPct(all.line)}% < ${GLOBAL_THRESHOLDS.line}%`
      );
    }
    if (all.branch < GLOBAL_THRESHOLDS.branch) {
      failures.push(
        `global branch coverage ${formatPct(all.branch)}% < ${GLOBAL_THRESHOLDS.branch}%`
      );
    }
    if (all.funcs < GLOBAL_THRESHOLDS.funcs) {
      failures.push(
        `global funcs coverage ${formatPct(all.funcs)}% < ${GLOBAL_THRESHOLDS.funcs}%`
      );
    }
  }

  for (const [fileName, threshold] of Object.entries(CORE_FILE_LINE_THRESHOLDS)) {
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
  const result = await runCoverage();
  if (result.code !== 0) {
    process.exit(result.code);
  }

  const rows = parseCoverageRows(result.outputText);
  const failures = checkThresholds(rows);

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
