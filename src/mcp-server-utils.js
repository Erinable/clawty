export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toFiniteInteger(
  value,
  fallback,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER
) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const rounded = Math.trunc(number);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

export function logWith(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, fields);
}
