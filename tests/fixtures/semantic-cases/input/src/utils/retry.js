export async function withRetry(fn, options = {}) {
  const retries = Number(options.retries || 0);
  let attempts = 0;
  let lastError = null;

  while (attempts <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempts += 1;
    }
  }

  throw lastError;
}
