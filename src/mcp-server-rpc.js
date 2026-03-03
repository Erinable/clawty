import { createRequestTraceContext, pickTraceFields } from "./trace-context.js";

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRequestTraceSeed(request, params, serverOptions = {}) {
  const requestTrace = isPlainObject(request?.trace) ? request.trace : {};
  const paramsTrace = isPlainObject(params?.trace) ? params.trace : {};
  const metaTrace = isPlainObject(params?.meta?.trace) ? params.meta.trace : {};
  const serverTrace = isPlainObject(serverOptions?.trace) ? serverOptions.trace : {};
  return {
    trace_id:
      requestTrace.trace_id ||
      paramsTrace.trace_id ||
      metaTrace.trace_id ||
      serverTrace.trace_id ||
      null,
    request_id:
      requestTrace.request_id ||
      paramsTrace.request_id ||
      metaTrace.request_id ||
      serverTrace.request_id ||
      null
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
  const requestTrace = createRequestTraceContext(resolveRequestTraceSeed(request, params, serverOptions));
  const traceFields = pickTraceFields(requestTrace, {
    includeTurn: false
  });

  if (!method || typeof method !== "string") {
    logWith(logger, "warn", "mcp.invalid_request", { id, ...traceFields });
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
    logWith(logger, "info", "mcp.exit", traceFields);
    return { response: null, shouldExit: true };
  }

  if (method === "initialize") {
    logWith(logger, "info", "mcp.initialize", { id, ...traceFields });
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
    logWith(logger, "debug", "mcp.tools_list", {
      id,
      tool_count: tools.length,
      ...traceFields
    });
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
      const result = await callTool(toolName, toolArgs, {
        ...serverOptions,
        trace: {
          ...(isPlainObject(serverOptions?.trace) ? serverOptions.trace : {}),
          ...traceFields
        }
      });
      logWith(logger, "info", "mcp.tool_call", {
        id,
        tool_name: toolName,
        ok: result?.ok !== false,
        duration_ms: Math.max(0, Date.now() - toolStartedAt),
        ...traceFields
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
        ...traceFields,
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

  logWith(logger, "warn", "mcp.method_not_found", { id, method, ...traceFields });
  return {
    response: buildRpcErrorFn(id, -32601, `Method not found: ${method}`),
    shouldExit: false
  };
}
