export function buildRpcError(id, code, message, data = null) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

export async function handleRpcRequestWithDeps(request, context = {}, deps = {}) {
  const { serverOptions = {}, tools = [], logger = null } = context;
  const {
    callTool,
    logWith,
    protocolVersion,
    serverName,
    serverVersion,
    buildRpcError: buildRpcErrorFn = buildRpcError
  } = deps;
  const id = request?.id;
  const method = request?.method;
  const params = request?.params || {};

  if (!method || typeof method !== "string") {
    logWith(logger, "warn", "mcp.invalid_request", { id });
    return {
      response: buildRpcErrorFn(id, -32600, "Invalid Request"),
      shouldExit: false
    };
  }

  if (method === "notifications/initialized") {
    return { response: null, shouldExit: false };
  }

  if (method === "shutdown") {
    return {
      response: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {}
      },
      shouldExit: false
    };
  }

  if (method === "exit") {
    logWith(logger, "info", "mcp.exit");
    return { response: null, shouldExit: true };
  }

  if (method === "initialize") {
    logWith(logger, "info", "mcp.initialize", { id });
    return {
      response: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: serverName,
            version: serverVersion
          }
        }
      },
      shouldExit: false
    };
  }

  if (method === "tools/list") {
    logWith(logger, "debug", "mcp.tools_list", { id, tool_count: tools.length });
    return {
      response: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          tools
        }
      },
      shouldExit: false
    };
  }

  if (method === "tools/call") {
    try {
      const toolName = typeof params?.name === "string" ? params.name : "";
      const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const toolStartedAt = Date.now();
      const result = await callTool(toolName, toolArgs, serverOptions);
      logWith(logger, "info", "mcp.tool_call", {
        id,
        tool_name: toolName,
        ok: result?.ok !== false,
        duration_ms: Math.max(0, Date.now() - toolStartedAt)
      });
      return {
        response: {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ],
            structuredContent: result
          }
        },
        shouldExit: false
      };
    } catch (error) {
      logWith(logger, "error", "mcp.tool_call_failed", {
        id,
        tool_name: params?.name || null,
        error
      });
      return {
        response: buildRpcErrorFn(id, -32603, error?.message || "Internal error", {
          tool: params?.name || null
        }),
        shouldExit: false
      };
    }
  }

  logWith(logger, "warn", "mcp.method_not_found", { id, method });
  return {
    response: buildRpcErrorFn(id, -32601, `Method not found: ${method}`),
    shouldExit: false
  };
}
