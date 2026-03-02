function normalizeNumberArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const output = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isFinite(n)) {
      return null;
    }
    output.push(n);
  }
  return output;
}

export class EmbeddingError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryable = Boolean(options.retryable);
  }
}

function normalizeEmbeddingVectors(payload, expectedCount) {
  if (Array.isArray(payload)) {
    const vectors = payload.map((item) => normalizeNumberArray(item)).filter(Boolean);
    if (vectors.length !== expectedCount) {
      throw new EmbeddingError(
        "EMBEDDING_RESPONSE_INVALID",
        `Embedding client returned ${vectors.length} vectors, expected ${expectedCount}`
      );
    }
    return vectors;
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const vectors = rows
    .map((row) => normalizeNumberArray(row?.embedding))
    .filter(Boolean);
  if (vectors.length !== expectedCount) {
    throw new EmbeddingError(
      "EMBEDDING_RESPONSE_INVALID",
      `Embedding API returned ${vectors.length} vectors, expected ${expectedCount}`
    );
  }
  return vectors;
}

async function safeParseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string") {
    return "https://api.openai.com/v1";
  }
  const cleaned = baseUrl.trim().replace(/\/+$/, "");
  return cleaned || "https://api.openai.com/v1";
}

export async function createEmbeddings({
  apiKey,
  baseUrl,
  model,
  input,
  timeoutMs = 15_000,
  client = null
}) {
  const inputs = Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
  if (inputs.length === 0) {
    throw new EmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "embedding input must be a non-empty string array"
    );
  }

  if (typeof client === "function") {
    const output = await client({
      apiKey,
      baseUrl: normalizeBaseUrl(baseUrl),
      model,
      input: inputs,
      timeoutMs
    });
    return normalizeEmbeddingVectors(output, inputs.length);
  }

  if (!apiKey || typeof apiKey !== "string") {
    throw new EmbeddingError("EMBEDDING_API_KEY_MISSING", "embedding api key is missing");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: inputs
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new EmbeddingError(
        "EMBEDDING_REQUEST_TIMEOUT",
        `embedding request timeout after ${timeoutMs}ms`,
        { retryable: true }
      );
    }
    throw new EmbeddingError(
      "EMBEDDING_REQUEST_NETWORK",
      `embedding request failed: ${error.message || String(error)}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await safeParseJson(response);
  if (!response.ok) {
    throw new EmbeddingError(
      "EMBEDDING_API_HTTP_ERROR",
      `embedding API error (${response.status}): ${JSON.stringify(data)}`,
      {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429
      }
    );
  }
  return normalizeEmbeddingVectors(data, inputs.length);
}
