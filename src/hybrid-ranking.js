import path from "node:path";
import { buildRetrievalResultProtocol } from "./retrieval-result-protocol.js";

const HYBRID_SOURCE_SCORE = Object.freeze({
  scip: 1,
  lsif: 0.95,
  lsp: 0.92,
  semantic: 0.9,
  vector: 0.82,
  syntax: 0.78,
  index_seed: 0.7,
  lsp_anchor: 0.62,
  syntax_fallback: 0.6,
  index: 0.5,
  index_fallback: 0.46,
  unknown: 0.4
});

export function roundHybridMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(4));
}

export function normalizeHybridSource(source) {
  if (typeof source !== "string") {
    return "unknown";
  }
  const normalized = source.trim().toLowerCase();
  return normalized || "unknown";
}

function hybridSourceScore(source) {
  const normalized = normalizeHybridSource(source);
  return HYBRID_SOURCE_SCORE[normalized] ?? HYBRID_SOURCE_SCORE.unknown;
}

function tokenizeHybridQuery(raw) {
  if (typeof raw !== "string") {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ).slice(0, 16);
}

function normalizeHybridPathPrefix(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) {
    return null;
  }
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function hybridPathScore(pathValue, pathPrefix) {
  if (!pathPrefix) {
    return 0.5;
  }
  const candidatePath = typeof pathValue === "string" ? pathValue : "";
  if (!candidatePath) {
    return 0;
  }
  if (candidatePath.startsWith(pathPrefix)) {
    return 1;
  }
  if (candidatePath.includes(pathPrefix)) {
    return 0.65;
  }
  return 0.05;
}

function hybridOverlapScore(queryTokens, candidate) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
    return 0;
  }
  const haystack = [
    String(candidate?.name || ""),
    String(candidate?.path || ""),
    String(candidate?.kind || "")
  ]
    .join(" ")
    .toLowerCase();
  let hitCount = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      hitCount += 1;
    }
  }
  return hitCount / queryTokens.length;
}

function hybridHopPenalty(candidate) {
  const source = normalizeHybridSource(candidate?.source);
  if (source === "lsp_anchor") {
    return 0.15;
  }
  return 0;
}

export function hybridCandidateKey(candidate) {
  const candidatePath = String(candidate?.path || "").trim();
  if (candidatePath) {
    return `path:${candidatePath}`;
  }
  return [
    "fallback",
    String(candidate?.kind || ""),
    String(candidate?.name || "").toLowerCase()
  ].join("::");
}

export function attachHybridRetrievalProtocol(candidates) {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.map((candidate) => ({
    ...candidate,
    retrieval: buildRetrievalResultProtocol(candidate, {
      normalizeSource: normalizeHybridSource,
      roundMetric: roundHybridMetric,
      getDedupKey: hybridCandidateKey
    })
  }));
}

export function buildHybridEmbeddingText(candidate) {
  const outgoingNames = (candidate?.outgoing || [])
    .slice(0, 4)
    .map((item) => String(item?.node?.name || "").trim())
    .filter(Boolean)
    .join(" ");
  const incomingNames = (candidate?.incoming || [])
    .slice(0, 4)
    .map((item) => String(item?.node?.name || "").trim())
    .filter(Boolean)
    .join(" ");
  const providers = (candidate?.supporting_providers || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ");

  return [
    `path: ${String(candidate?.path || "")}`,
    `name: ${String(candidate?.name || "")}`,
    `kind: ${String(candidate?.kind || "")}`,
    `source: ${String(candidate?.source || "")}`,
    outgoingNames ? `outgoing: ${outgoingNames}` : "",
    incomingNames ? `incoming: ${incomingNames}` : "",
    providers ? `providers: ${providers}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let idx = 0; idx < size; idx += 1) {
    const av = Number(a[idx] || 0);
    const bv = Number(b[idx] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizedCosineScore(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const clipped = Math.max(-1, Math.min(1, numeric));
  return roundHybridMetric((clipped + 1) / 2);
}

export function sortHybridCandidates(a, b) {
  if (b.hybrid_score !== a.hybrid_score) {
    return b.hybrid_score - a.hybrid_score;
  }
  const sourceDiff = hybridSourceScore(b.source) - hybridSourceScore(a.source);
  if (sourceDiff !== 0) {
    return sourceDiff;
  }
  const pathDiff = String(a.path || "").localeCompare(String(b.path || ""));
  if (pathDiff !== 0) {
    return pathDiff;
  }
  return Number(a.line || 1) - Number(b.line || 1);
}

export function mapIndexResultToHybridSeed(item) {
  const filePath = String(item?.path || "");
  return {
    path: filePath,
    name: path.basename(filePath || ""),
    kind: "file",
    line: Number(item?.hit_line || 1),
    column: 1,
    lang: item?.language || null,
    source: "index",
    outgoing: [],
    incoming: []
  };
}

export function mapVectorResultToHybridSeed(item) {
  const filePath = String(item?.path || "");
  return {
    path: filePath,
    name: path.basename(filePath || ""),
    kind: "chunk",
    line: Number(item?.start_line || 1),
    column: 1,
    lang: item?.language || null,
    source: "vector",
    outgoing: [],
    incoming: [],
    vector_score: Number(item?.score || 0),
    vector_layer: item?.layer || null
  };
}

export function addHybridCandidate(map, candidate, provider) {
  const key = hybridCandidateKey(candidate);
  if (!key || key === "::") {
    return;
  }

  const source = normalizeHybridSource(candidate?.source);
  const providerToken = typeof provider === "string" && provider ? provider : "unknown";
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      candidate,
      providers: new Set([providerToken]),
      source_score: hybridSourceScore(source)
    });
    return;
  }

  existing.providers.add(providerToken);
  const currentSourceScore = hybridSourceScore(source);
  if (currentSourceScore > existing.source_score) {
    existing.candidate = candidate;
    existing.source_score = currentSourceScore;
  }
}

export function rankHybridCandidates(entries, options) {
  const queryTokens = tokenizeHybridQuery(options?.query || "");
  const pathPrefix = normalizeHybridPathPrefix(options?.path_prefix || null);
  const explain = Boolean(options?.explain);

  const ranked = entries.map((entry) => {
    const candidate = entry.candidate;
    const sourceScore = entry.source_score;
    const overlapScore = hybridOverlapScore(queryTokens, candidate);
    const pathScore = hybridPathScore(candidate?.path, pathPrefix);
    const supportScore = Math.min(1, Math.max(0, (entry.providers.size - 1) / 2));
    const hopPenalty = hybridHopPenalty(candidate);
    const finalScore = roundHybridMetric(
      sourceScore * 0.42 + overlapScore * 0.33 + pathScore * 0.15 + supportScore * 0.1 - hopPenalty
    );

    const merged = {
      ...candidate,
      hybrid_score: finalScore,
      supporting_providers: Array.from(entry.providers.values()).sort()
    };
    if (explain) {
      merged.hybrid_explain = {
        source_score: roundHybridMetric(sourceScore),
        overlap_score: roundHybridMetric(overlapScore),
        path_score: roundHybridMetric(pathScore),
        support_score: roundHybridMetric(supportScore),
        hop_penalty: roundHybridMetric(hopPenalty),
        final_score: finalScore
      };
    }
    return merged;
  });

  ranked.sort(sortHybridCandidates);
  return ranked;
}
