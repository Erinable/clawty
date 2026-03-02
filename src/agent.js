import { createResponse } from "./openai.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

const SYSTEM_PROMPT = [
  "You are Clawty, a CLI coding assistant.",
  "Focus on software engineering tasks in the workspace.",
  "For repository exploration, build_code_index once, then use refresh_code_index + query_code_index.",
  "Use get_index_stats when you need index health or coverage details.",
  "For semantic code navigation in TS/JS, use lsp_definition, lsp_references, and lsp_workspace_symbols.",
  "Use lsp_health to diagnose language server problems.",
  "Before editing, inspect relevant files first.",
  "Prefer minimal, correct changes.",
  "For focused edits, prefer apply_patch over full-file overwrite.",
  "Use run_shell for checks when useful.",
  "Avoid destructive operations and do not access paths outside workspace root.",
  "When finished, provide a concise summary and any follow-up steps."
].join(" ");

function extractText(response) {
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

function extractFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

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

async function callModel(config, state, input) {
  const payload = {
    model: config.model,
    instructions: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
    input
  };

  if (state.previousResponseId) {
    payload.previous_response_id = state.previousResponseId;
  }

  return createResponse({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    payload
  });
}

export async function runAgentTurn({ config, state, userInput, onText, onTool }) {
  let response = await callModel(config, state, userInput);

  for (let i = 0; i < config.maxToolIterations; i += 1) {
    const text = extractText(response);
    if (text) {
      onText(text);
    }

    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      state.previousResponseId = response.id;
      return;
    }

    const outputs = [];
    for (const call of calls) {
      let result;
      try {
        const args = parseArguments(call.arguments);
        result = await runTool(call.name, args, {
          workspaceRoot: config.workspaceRoot,
          defaultTimeoutMs: config.toolTimeoutMs,
          lsp: config.lsp
        });
      } catch (error) {
        result = {
          ok: false,
          error: error.message || String(error)
        };
      }
      onTool(call.name, result);
      outputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }

    state.previousResponseId = response.id;
    response = await callModel(config, state, outputs);
  }

  throw new Error(
    `Tool loop exceeded ${config.maxToolIterations} rounds. Increase CLAWTY_MAX_TOOL_ITERATIONS if needed.`
  );
}
