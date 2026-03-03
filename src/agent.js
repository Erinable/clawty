import { createResponse } from "./openai.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { randomUUID } from "node:crypto";
import {
  createRequestTraceContext,
  createTurnTraceContext,
  pickTraceFields
} from "./trace-context.js";
import {
  collectIncrementalContext
} from "./agent-context.js";
import {
  SYSTEM_PROMPT,
  appendContextBlock,
  buildTurnInputWithIncrementalContext
} from "./agent-prompt.js";
import {
  executeFunctionCalls,
  extractFunctionCalls,
  extractText
} from "./agent-tool-exec.js";
import {
  loadMemoryContext,
  formatMemoryContextForPrompt,
  recordEpisode,
  recordLessonFromTurn
} from "./memory.js";

export {
  collectIncrementalContext,
  formatIncrementalContextForPrompt
} from "./agent-context.js";

function logWith(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, fields);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, Math.floor(n));
}

function clampText(input, maxChars) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const keep = Math.max(0, maxChars - 48);
  return `${text.slice(0, keep)}\n...[truncated ${text.length - keep} chars]`;
}

function summarizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      return {
        name: String(item.name || ""),
        ok: item.ok !== false,
        error: item.error ? String(item.error) : null
      };
    })
    .filter((item) => item && item.name)
    .slice(0, 200);
}

function buildTurnSummaryText(chunks, fallback = "") {
  if (Array.isArray(chunks) && chunks.length > 0) {
    return clampText(chunks.join("\n\n"), 8000);
  }
  return clampText(fallback, 8000);
}

async function persistTurnMemory({
  config,
  state,
  userInput,
  toolCalls,
  textChunks,
  outcome,
  fallbackSummary = ""
}) {
  if (typeof userInput !== "string") {
    return;
  }
  if (!config?.memory?.enabled || !config?.memory?.autoWrite) {
    return;
  }

  const summary = buildTurnSummaryText(textChunks, fallbackSummary);
  const changedPaths = Array.isArray(state?.incremental_context?.changed_paths)
    ? state.incremental_context.changed_paths
    : [];
  const normalizedOutcome = outcome === "success" ? "success" : outcome === "failed" ? "failed" : "partial";

  const recordOptions = {
    homeDir: config?.sources?.homeDir,
    dedupeEnabled: config?.memory?.dedupeEnabled,
    writeGateEnabled: config?.memory?.writeGateEnabled,
    minLessonChars: config?.memory?.minLessonChars,
    quarantineThreshold: config?.memory?.quarantineThreshold
  };

  try {
    await recordEpisode(
      config.workspaceRoot,
      {
        session_id: String(state.session_id || ""),
        turn_no: Number(state.turn_no || 0),
        user_query: userInput,
        assistant_summary: summary,
        outcome: normalizedOutcome,
        tool_calls: summarizeToolCalls(toolCalls)
      },
      recordOptions
    );
  } catch {
    // Memory persistence must never break agent execution.
  }

  if (normalizedOutcome !== "success" || !summary) {
    return;
  }

  try {
    await recordLessonFromTurn(
      config.workspaceRoot,
      {
        user_query: userInput,
        assistant_summary: summary,
        outcome: normalizedOutcome,
        changed_paths: changedPaths
      },
      recordOptions
    );
  } catch {
    // Memory lesson extraction is best-effort.
  }
}

async function callModel(config, state, input, logger = null, traceContext = {}) {
  const requestTrace = createRequestTraceContext(traceContext);
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

  const response = await createResponse({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    payload,
    logger,
    trace: requestTrace
  });
  return {
    response,
    requestTrace
  };
}

export async function runAgentTurn({ config, state, userInput, onText, onTool, logger = null }) {
  let initialInput = userInput;
  const toolCalls = [];
  const textChunks = [];

  const currentTurn = clampInt(state.turn_no, 0, 0, 1_000_000) + 1;
  state.turn_no = currentTurn;
  const turnTrace = createTurnTraceContext({
    trace_id: state.trace_id
  });
  state.trace_id = turnTrace.trace_id;
  state.turn_id = turnTrace.turn_id;
  if (!state.session_id) {
    state.session_id = randomUUID();
  }
  const turnLogger = logger?.child
    ? logger.child({
        component: "agent",
        context: {
          session_id: state.session_id,
          turn_no: currentTurn,
          ...pickTraceFields(turnTrace, {
            includeRequest: false
          })
        }
      })
    : logger;

  logWith(turnLogger, "info", "agent.turn_start", {
    user_input_chars: typeof userInput === "string" ? userInput.length : 0
  });

  if (typeof userInput === "string") {
    try {
      const incrementalContext = await collectIncrementalContext(config.workspaceRoot, {
        enabled: config?.agentContext?.incrementalContextEnabled,
        maxPaths: config?.agentContext?.incrementalContextMaxPaths,
        maxDiffChars: config?.agentContext?.incrementalContextMaxDiffChars,
        timeoutMs: config?.agentContext?.incrementalContextTimeoutMs
      });
      state.incremental_context = incrementalContext;
      initialInput = buildTurnInputWithIncrementalContext(userInput, incrementalContext);
      logWith(turnLogger, "debug", "agent.incremental_context", {
        available: incrementalContext.available === true,
        reason: incrementalContext.reason || null,
        changed_paths: Array.isArray(incrementalContext.changed_paths)
          ? incrementalContext.changed_paths.length
          : 0
      });
    } catch (error) {
      state.incremental_context = {
        enabled: true,
        available: false,
        reason: "context_collection_failed",
        error: error.message || String(error)
      };
      initialInput = userInput;
      logWith(turnLogger, "warn", "agent.incremental_context_failed", { error });
    }

    if (config?.memory?.enabled) {
      try {
        const memoryContext = await loadMemoryContext(config.workspaceRoot, userInput, {
          homeDir: config?.sources?.homeDir,
          scope: config?.memory?.scope,
          maxItems: config?.memory?.maxInjectedItems,
          maxChars: config?.memory?.maxInjectedChars,
          ranking: config?.memory?.ranking,
          metrics: config?.metrics,
          trace: pickTraceFields(turnTrace, {
            includeRequest: false
          })
        });
        state.memory_context = memoryContext;
        const memoryPrompt = formatMemoryContextForPrompt(memoryContext, {
          maxChars: config?.memory?.maxInjectedChars
        });
        initialInput = appendContextBlock(initialInput, memoryPrompt);
        logWith(turnLogger, "debug", "agent.memory_context", {
          ok: memoryContext?.ok !== false,
          injected_items: Array.isArray(memoryContext?.items) ? memoryContext.items.length : 0
        });
      } catch (error) {
        state.memory_context = {
          ok: false,
          error: error.message || String(error)
        };
        logWith(turnLogger, "warn", "agent.memory_context_failed", { error });
      }
    }
  }

  try {
    let modelCall = await callModel(
      config,
      state,
      initialInput,
      turnLogger?.child ? turnLogger.child({ component: "openai" }) : turnLogger,
      turnTrace
    );
    let response = modelCall.response;
    let requestTrace = modelCall.requestTrace;

    for (let i = 0; i < config.maxToolIterations; i += 1) {
      const text = extractText(response);
      if (text) {
        textChunks.push(text);
        onText(text);
      }

      const calls = extractFunctionCalls(response);
      logWith(turnLogger, "debug", "agent.model_round", {
        iteration: i + 1,
        response_id: response?.id || null,
        ...pickTraceFields(requestTrace),
        tool_calls: calls.length,
        text_chars: text ? text.length : 0
      });
      if (calls.length === 0) {
        state.previousResponseId = response.id;
        await persistTurnMemory({
          config,
          state,
          userInput,
          toolCalls,
          textChunks,
          outcome: "success"
        });
        logWith(turnLogger, "info", "agent.turn_complete", {
          tool_calls: toolCalls.length,
          text_chunks: textChunks.length
        });
        return;
      }

      const { outputs, toolCalls: executedToolCalls } = await executeFunctionCalls({
        calls,
        config,
        requestTrace,
        onTool,
        onToolCallResult(call, result, durationMs) {
          logWith(turnLogger, result.ok === false ? "warn" : "info", "agent.tool_call", {
            tool_name: call.name,
            ...pickTraceFields(requestTrace),
            ok: result.ok !== false,
            duration_ms: durationMs,
            error: result.ok === false ? result.error : null
          });
        }
      });
      toolCalls.push(...executedToolCalls);

      state.previousResponseId = response.id;
      modelCall = await callModel(
        config,
        state,
        outputs,
        turnLogger?.child ? turnLogger.child({ component: "openai" }) : turnLogger,
        turnTrace
      );
      response = modelCall.response;
      requestTrace = modelCall.requestTrace;
    }

    throw new Error(
      `Tool loop exceeded ${config.maxToolIterations} rounds. Increase CLAWTY_MAX_TOOL_ITERATIONS if needed.`
    );
  } catch (error) {
    await persistTurnMemory({
      config,
      state,
      userInput,
      toolCalls,
      textChunks,
      outcome: "failed",
      fallbackSummary: error.message || String(error)
    });
    logWith(turnLogger, "error", "agent.turn_failed", {
      tool_calls: toolCalls.length,
      text_chunks: textChunks.length,
      error
    });
    throw error;
  }
}
