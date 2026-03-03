import { randomUUID } from "node:crypto";

function normalizeTraceToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function resolveTraceToken(value, fallbackFactory = null) {
  const normalized = normalizeTraceToken(value);
  if (normalized) {
    return normalized;
  }
  if (typeof fallbackFactory === "function") {
    return fallbackFactory();
  }
  return null;
}

export function createTraceContext(seed = {}) {
  return {
    trace_id: resolveTraceToken(seed?.trace_id ?? seed?.traceId, randomUUID)
  };
}

export function createTurnTraceContext(seed = {}) {
  const trace_id = resolveTraceToken(seed?.trace_id ?? seed?.traceId, randomUUID);
  const turn_id = resolveTraceToken(seed?.turn_id ?? seed?.turnId, randomUUID);
  return {
    trace_id,
    turn_id
  };
}

export function createRequestTraceContext(seed = {}) {
  const trace_id = resolveTraceToken(seed?.trace_id ?? seed?.traceId, randomUUID);
  const turn_id = resolveTraceToken(seed?.turn_id ?? seed?.turnId, randomUUID);
  const request_id = resolveTraceToken(seed?.request_id ?? seed?.requestId, randomUUID);
  return {
    trace_id,
    turn_id,
    request_id
  };
}

export function pickTraceFields(seed = {}, options = {}) {
  const includeTurn = options.includeTurn !== false;
  const includeRequest = options.includeRequest !== false;
  const fields = {};
  const traceId = normalizeTraceToken(seed?.trace_id ?? seed?.traceId);
  const turnId = normalizeTraceToken(seed?.turn_id ?? seed?.turnId);
  const requestId = normalizeTraceToken(seed?.request_id ?? seed?.requestId);
  if (traceId) {
    fields.trace_id = traceId;
  }
  if (includeTurn && turnId) {
    fields.turn_id = turnId;
  }
  if (includeRequest && requestId) {
    fields.request_id = requestId;
  }
  return fields;
}
