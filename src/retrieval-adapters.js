import path from "node:path";
import { buildRetrievalResultProtocol } from "./retrieval-result-protocol.js";

function roundScore(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(4));
}

function normalizeSource(source) {
  if (typeof source !== "string") {
    return "unknown";
  }
  const normalized = source.trim().toLowerCase();
  return normalized || "unknown";
}

function normalizeCodeConfidence(rawScore) {
  const numeric = Number(rawScore || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return roundScore(numeric / (numeric + 4));
}

function normalizeScore01(rawScore, fallback = 0) {
  const numeric = Number(rawScore);
  if (!Number.isFinite(numeric)) {
    return roundScore(fallback);
  }
  return roundScore(Math.max(0, Math.min(1, numeric)));
}

function normalizeSyntaxConfidence(seed) {
  const importCount = Number(seed?.import_count || 0);
  const callCount = Number(seed?.call_count || 0);
  const incomingImporters = Array.isArray(seed?.incoming_importers)
    ? seed.incoming_importers.length
    : 0;
  const incomingCallers = Array.isArray(seed?.incoming_callers)
    ? seed.incoming_callers.length
    : 0;
  const totalSignals = importCount + callCount + incomingImporters + incomingCallers;
  if (totalSignals <= 0) {
    return 0.46;
  }
  return roundScore(Math.min(0.9, 0.46 + totalSignals / 20));
}

function resolveSemanticConfidence(seed) {
  const source = normalizeSource(seed?.source);
  if (source === "semantic" || source === "lsp" || source === "scip") {
    return 0.9;
  }
  if (source === "syntax_fallback" || source === "lsp_anchor") {
    return 0.65;
  }
  if (source === "index_fallback" || source === "index") {
    return 0.52;
  }
  return 0.5;
}

function semanticDedupKey(seed) {
  const candidatePath = String(seed?.path || "").trim();
  if (candidatePath) {
    return `path:${candidatePath}`;
  }
  return [
    "semantic",
    String(seed?.kind || ""),
    String(seed?.name || "").toLowerCase()
  ].join("::");
}

function indexResultRetrieval(item) {
  const candidatePath = String(item?.path || "").trim();
  return buildRetrievalResultProtocol(
    {
      source: "index",
      hybrid_score: normalizeCodeConfidence(item?.score),
      supporting_providers: ["index"]
    },
    {
      normalizeSource,
      roundMetric: roundScore,
      dedupKey: candidatePath ? `path:${candidatePath}` : `index:${path.basename(candidatePath)}`
    }
  );
}

function syntaxSeedRetrieval(seed) {
  const candidatePath = String(seed?.path || "").trim();
  return buildRetrievalResultProtocol(
    {
      source: "syntax",
      hybrid_score: normalizeSyntaxConfidence(seed),
      supporting_providers: ["syntax"]
    },
    {
      normalizeSource,
      roundMetric: roundScore,
      dedupKey: candidatePath ? `path:${candidatePath}` : "syntax"
    }
  );
}

function semanticSeedRetrieval(seed, provider = null) {
  const source = normalizeSource(seed?.source || provider || "semantic");
  const providers = [source];
  if (provider && !providers.includes(provider)) {
    providers.push(provider);
  }
  return buildRetrievalResultProtocol(
    {
      source,
      hybrid_score: resolveSemanticConfidence(seed),
      supporting_providers: providers
    },
    {
      normalizeSource,
      roundMetric: roundScore,
      dedupKey: semanticDedupKey(seed)
    }
  );
}

function vectorResultRetrieval(item) {
  const candidatePath = String(item?.path || "").trim();
  const startLine = Number(item?.start_line || 1);
  const endLine = Number(item?.end_line || startLine);
  return buildRetrievalResultProtocol(
    {
      source: "vector",
      hybrid_score: normalizeScore01(item?.score, 0.5),
      supporting_providers: ["vector"]
    },
    {
      normalizeSource,
      roundMetric: roundScore,
      dedupKey:
        candidatePath
          ? `vector:${candidatePath}:${Math.max(1, startLine)}:${Math.max(1, endLine)}`
          : `vector:${String(item?.chunk_id || "")}`
    }
  );
}

function hybridSeedRetrieval(seed) {
  const candidatePath = String(seed?.path || "").trim();
  return buildRetrievalResultProtocol(
    {
      source: normalizeSource(seed?.source || "hybrid"),
      hybrid_score: normalizeScore01(seed?.hybrid_score, 0.5),
      freshness_score: Number.isFinite(Number(seed?.freshness_score))
        ? Number(seed.freshness_score)
        : null,
      freshness_age_ms: Number.isFinite(Number(seed?.freshness_age_ms))
        ? Number(seed.freshness_age_ms)
        : null,
      freshness_stale:
        typeof seed?.freshness_stale === "boolean" ? seed.freshness_stale : null,
      supporting_providers: Array.isArray(seed?.supporting_providers)
        ? seed.supporting_providers
        : [normalizeSource(seed?.source || "hybrid")]
    },
    {
      normalizeSource,
      roundMetric: roundScore,
      dedupKey: candidatePath ? `path:${candidatePath}` : `hybrid:${String(seed?.name || "")}`
    }
  );
}

export function attachIndexRetrievalProtocol(result) {
  if (!result?.ok || !Array.isArray(result.results)) {
    return result;
  }
  return {
    ...result,
    results: result.results.map((item) => ({
      ...item,
      retrieval: indexResultRetrieval(item)
    }))
  };
}

export function attachSyntaxRetrievalProtocol(result) {
  if (!result?.ok || !Array.isArray(result.seeds)) {
    return result;
  }
  return {
    ...result,
    seeds: result.seeds.map((seed) => ({
      ...seed,
      retrieval: syntaxSeedRetrieval(seed)
    }))
  };
}

export function attachSemanticRetrievalProtocol(result) {
  if (!result?.ok || !Array.isArray(result.seeds)) {
    return result;
  }
  return {
    ...result,
    seeds: result.seeds.map((seed) => ({
      ...seed,
      retrieval: semanticSeedRetrieval(seed, result.provider || null)
    }))
  };
}

export function attachVectorRetrievalProtocol(result) {
  if (!result?.ok || !Array.isArray(result.results)) {
    return result;
  }
  return {
    ...result,
    results: result.results.map((item) => ({
      ...item,
      retrieval: vectorResultRetrieval(item)
    }))
  };
}

export function attachHybridRetrievalProtocol(result) {
  if (!result?.ok || !Array.isArray(result.seeds)) {
    return result;
  }
  return {
    ...result,
    seeds: result.seeds.map((seed) => {
      if (seed?.retrieval && typeof seed.retrieval === "object") {
        return seed;
      }
      return {
        ...seed,
        retrieval: hybridSeedRetrieval(seed)
      };
    })
  };
}
