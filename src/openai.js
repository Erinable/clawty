async function safeParseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

function logWith(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, fields);
}

function summarizePayload(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return {
    model: typeof safePayload.model === "string" ? safePayload.model : null,
    has_previous_response_id: Boolean(safePayload.previous_response_id),
    tools_count: Array.isArray(safePayload.tools) ? safePayload.tools.length : 0,
    input_type: Array.isArray(safePayload.input) ? "array" : typeof safePayload.input
  };
}

export async function createResponse({ apiKey, baseUrl, payload, logger = null }) {
  const startedAt = Date.now();
  logWith(logger, "debug", "openai.request_start", {
    base_url: baseUrl,
    ...summarizePayload(payload)
  });

  let response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    logWith(logger, "error", "openai.network_error", {
      duration_ms: Math.max(0, Date.now() - startedAt),
      error
    });
    throw new Error(
      `Network error calling OpenAI API: ${error.message || String(error)}. ` +
        "Check internet connectivity and OPENAI_BASE_URL."
    );
  }

  const data = await safeParseJson(response);
  if (!response.ok) {
    logWith(logger, "error", "openai.http_error", {
      duration_ms: Math.max(0, Date.now() - startedAt),
      status: response.status,
      response_body: data
    });
    throw new Error(
      `OpenAI API error (${response.status}): ${JSON.stringify(data, null, 2)}`
    );
  }
  logWith(logger, "debug", "openai.request_success", {
    duration_ms: Math.max(0, Date.now() - startedAt),
    status: response.status,
    response_id: typeof data?.id === "string" ? data.id : null
  });
  return data;
}
