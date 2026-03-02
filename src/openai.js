async function safeParseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

export async function createResponse({ apiKey, baseUrl, payload }) {
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
    throw new Error(
      `Network error calling OpenAI API: ${error.message || String(error)}. ` +
        "Check internet connectivity and OPENAI_BASE_URL."
    );
  }

  const data = await safeParseJson(response);
  if (!response.ok) {
    throw new Error(
      `OpenAI API error (${response.status}): ${JSON.stringify(data, null, 2)}`
    );
  }
  return data;
}
