import test from "node:test";
import assert from "node:assert/strict";
import { callToolWithDeps } from "../src/mcp-tool-dispatch.js";

function createDeps(overrides = {}) {
  return {
    facadeToolNameSet: new Set(["search_code"]),
    facadeToolHandlers: {
      search_code: async () => ({ ok: true, provider: "facade" })
    },
    monitorToolNameSet: new Set(["monitor_report"]),
    lowLevelCodeToolNameSet: new Set(["query_code_index"]),
    resolveDefaultFacadeToolNames: () => new Set(["search_code"]),
    callMonitorTool: async () => ({ ok: true, provider: "monitor" }),
    callLowLevelCodeTool: async () => ({ ok: true, provider: "low-level" }),
    ...overrides
  };
}

test("callToolWithDeps dispatches facade handler when exposed", async () => {
  const result = await callToolWithDeps("search_code", {}, {}, createDeps());
  assert.equal(result.provider, "facade");
});

test("callToolWithDeps blocks facade tool not in exposed policy", async () => {
  await assert.rejects(
    () =>
      callToolWithDeps(
        "search_code",
        {},
        { exposedFacadeToolNames: new Set() },
        createDeps()
      ),
    /Tool not exposed by current policy: search_code/
  );
});

test("callToolWithDeps blocks low-level tool when exposeLowLevel is false", async () => {
  await assert.rejects(
    () => callToolWithDeps("query_code_index", {}, { exposeLowLevel: false }, createDeps()),
    /Tool not exposed by current policy: query_code_index/
  );
});

test("callToolWithDeps dispatches monitor and low-level tools when exposeLowLevel is true", async () => {
  const monitorResult = await callToolWithDeps(
    "monitor_report",
    {},
    { exposeLowLevel: true },
    createDeps()
  );
  assert.equal(monitorResult.provider, "monitor");

  const lowLevelResult = await callToolWithDeps(
    "query_code_index",
    {},
    { exposeLowLevel: true },
    createDeps()
  );
  assert.equal(lowLevelResult.provider, "low-level");
});

test("callToolWithDeps throws unknown tool for unmapped name", async () => {
  await assert.rejects(
    () => callToolWithDeps("not_exist_tool", {}, {}, createDeps()),
    /Unknown tool: not_exist_tool/
  );
});
