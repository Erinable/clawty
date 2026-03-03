#!/usr/bin/env node

const CONTRACTS = [
  {
    modulePath: "../src/agent.js",
    required: {
      runAgentTurn: "function",
      collectIncrementalContext: "function",
      formatIncrementalContextForPrompt: "function"
    }
  },
  {
    modulePath: "../src/tools.js",
    required: {
      runTool: "function",
      TOOL_DEFINITIONS: "object"
    }
  },
  {
    modulePath: "../src/tool-query-handlers.js",
    required: {
      createQueryToolHandlers: "function"
    }
  },
  {
    modulePath: "../src/retrieval-result-protocol.js",
    required: {
      buildRetrievalResultProtocol: "function"
    }
  },
  {
    modulePath: "../src/trace-context.js",
    required: {
      createTraceContext: "function",
      createTurnTraceContext: "function",
      createRequestTraceContext: "function",
      pickTraceFields: "function"
    }
  }
];

function validateType(value, expected) {
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "null") {
    return value === null;
  }
  return typeof value === expected;
}

async function verifyContract(contract) {
  const loaded = await import(new URL(contract.modulePath, import.meta.url).href);
  const failures = [];
  for (const [key, expectedType] of Object.entries(contract.required)) {
    if (!Object.prototype.hasOwnProperty.call(loaded, key)) {
      failures.push(`missing export \`${key}\``);
      continue;
    }
    if (!validateType(loaded[key], expectedType)) {
      failures.push(`export \`${key}\` expected type ${expectedType}, got ${typeof loaded[key]}`);
    }
  }
  return failures;
}

async function main() {
  const failures = [];
  for (const contract of CONTRACTS) {
    try {
      const contractFailures = await verifyContract(contract);
      if (contractFailures.length > 0) {
        failures.push({
          modulePath: contract.modulePath,
          errors: contractFailures
        });
      }
    } catch (error) {
      failures.push({
        modulePath: contract.modulePath,
        errors: [error.message || String(error)]
      });
    }
  }

  if (failures.length > 0) {
    console.error("typecheck failed:");
    for (const failure of failures) {
      console.error(`- ${failure.modulePath}`);
      for (const message of failure.errors) {
        console.error(`  - ${message}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(`typecheck passed: ${CONTRACTS.length} module contract(s) verified.`);
}

await main();
