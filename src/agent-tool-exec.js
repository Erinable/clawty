import { runTool } from "./tools.js";
import { pickTraceFields } from "./trace-context.js";

function parseArguments(rawArgs) {
  if (!rawArgs) {
    return {};
  }
  if (typeof rawArgs === "object") {
    return rawArgs;
  }
  if (typeof rawArgs === "string") {
    return JSON.parse(rawArgs);
  }
  return {};
}

export function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

export function extractFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

export async function executeFunctionCalls({
  calls,
  config,
  requestTrace,
  onTool,
  onToolCallResult
}) {
  const outputs = [];
  const toolCalls = [];
  const traceFields = pickTraceFields(requestTrace || {});

  for (const call of calls) {
    let result;
    const toolStartedAt = Date.now();
    try {
      const args = parseArguments(call.arguments);
      result = await runTool(call.name, args, {
        workspaceRoot: config.workspaceRoot,
        defaultTimeoutMs: config.toolTimeoutMs,
        lsp: config.lsp,
        index: config.index,
        embedding: config.embedding,
        metrics: config.metrics,
        onlineTuner: config.onlineTuner,
        memory: config.memory,
        sources: config.sources,
        trace: {
          ...traceFields,
          tool_call_id: call.call_id || null,
          tool_name: call.name
        }
      });
    } catch (error) {
      result = {
        ok: false,
        error: error.message || String(error)
      };
    }

    const durationMs = Math.max(0, Date.now() - toolStartedAt);
    const summary = {
      name: call.name,
      ok: result.ok !== false,
      error: result.ok === false ? result.error : null
    };
    toolCalls.push(summary);
    if (typeof onTool === "function") {
      onTool(call.name, result);
    }
    if (typeof onToolCallResult === "function") {
      onToolCallResult(call, result, durationMs);
    }
    outputs.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(result)
    });
  }

  return {
    outputs,
    toolCalls
  };
}
