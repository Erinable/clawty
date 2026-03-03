import test from "node:test";
import assert from "node:assert/strict";
import { handleRpcRequestWithDeps } from "../src/mcp-server-rpc.js";

function createBaseDeps(overrides = {}) {
  const events = [];
  const deps = {
    events,
    callTool: async () => ({ ok: true }),
    logWith(logger, level, event, fields = {}) {
      events.push({ logger, level, event, fields });
    },
    protocolVersion: "2024-11-05",
    serverName: "clawty-mcp",
    serverVersion: "0.1.0",
    ...overrides
  };
  return deps;
}

test("handleRpcRequestWithDeps propagates trace into tool server options and logs", async () => {
  let receivedServerOptions = null;
  const deps = createBaseDeps({
    async callTool(name, args, serverOptions) {
      receivedServerOptions = serverOptions;
      return { ok: true, name, args };
    }
  });

  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "query_code_index",
      arguments: {
        query: "token"
      },
      trace: {
        trace_id: "trace-7",
        request_id: "req-7"
      }
    }
  };

  const { response, shouldExit } = await handleRpcRequestWithDeps(
    request,
    {
      serverOptions: { workspaceRoot: "/repo" },
      tools: [],
      logger: { name: "mock" }
    },
    deps
  );
  assert.equal(shouldExit, false);
  assert.equal(response?.result?.structuredContent?.ok, true);
  assert.equal(receivedServerOptions?.trace?.trace_id, "trace-7");
  assert.equal(receivedServerOptions?.trace?.request_id, "req-7");

  const toolLog = deps.events.find((item) => item.event === "mcp.tool_call");
  assert.ok(toolLog);
  assert.equal(toolLog.fields.trace_id, "trace-7");
  assert.equal(toolLog.fields.request_id, "req-7");
});

test("handleRpcRequestWithDeps generates request trace when absent", async () => {
  const deps = createBaseDeps();
  await handleRpcRequestWithDeps(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    },
    {
      serverOptions: {},
      tools: [],
      logger: { name: "mock" }
    },
    deps
  );

  const initLog = deps.events.find((item) => item.event === "mcp.initialize");
  assert.ok(initLog);
  assert.equal(typeof initLog.fields.trace_id, "string");
  assert.ok(initLog.fields.trace_id.length > 0);
  assert.equal(typeof initLog.fields.request_id, "string");
  assert.ok(initLog.fields.request_id.length > 0);
});
