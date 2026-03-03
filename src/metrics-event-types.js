import path from "node:path";

export const METRICS_SUBDIR = path.join(".clawty", "metrics");
export const HYBRID_QUERY_METRICS_FILE = "hybrid-query.jsonl";
export const WATCH_FLUSH_METRICS_FILE = "watch-flush.jsonl";
export const WATCH_RUN_METRICS_FILE = "watch-run.jsonl";
export const MEMORY_SEARCH_METRICS_FILE = "memory.jsonl";

export const HYBRID_QUERY_EVENT_TYPE = "hybrid_query";
export const WATCH_FLUSH_EVENT_TYPE = "watch_flush";
export const WATCH_RUN_EVENT_TYPE = "watch_run";
export const MEMORY_SEARCH_EVENT_TYPE = "memory_search";
