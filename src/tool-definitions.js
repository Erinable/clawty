export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        max_chars: {
          type: "integer",
          description: "Optional max chars in output.",
          minimum: 100,
          maximum: 200000
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 text file to workspace (overwrite if exists).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        content: { type: "string", description: "Full file content." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_shell",
    description: "Run a shell command in workspace root with timeout and output capture.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
          minimum: 1000,
          maximum: 300000
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "apply_patch",
    description: "Apply a unified diff patch to workspace files.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff content." },
        check: {
          type: "boolean",
          description: "Only validate patch without applying changes."
        },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
          minimum: 1000,
          maximum: 300000
        }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_code_index",
    description:
      "Scan workspace code files and build a searchable SQLite index at .clawty/index.db.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap indexed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_file_size_kb: {
          type: "integer",
          description: "Optional max file size (KB) included in index.",
          minimum: 1,
          maximum: 8192
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_code_index",
    description: "Search the code index by keywords and return ranked file matches.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query such as symbol, module name, or feature keyword."
        },
        top_k: {
          type: "integer",
          description: "Optional number of top results to return.",
          minimum: 1,
          maximum: 50
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/ or tests/."
        },
        language: {
          type: "string",
          description: "Optional language filter, e.g. javascript, python, text."
        },
        explain: {
          type: "boolean",
          description: "Include score breakdown for each result."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_code_index",
    description:
      "Incrementally refresh SQLite code index. Optionally pass changed_paths/deleted_paths for event-driven updates.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap indexed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_file_size_kb: {
          type: "integer",
          description: "Optional max file size (KB) included in index.",
          minimum: 1,
          maximum: 8192
        },
        force_rebuild: {
          type: "boolean",
          description: "If true, bypass incremental mode and do a full rebuild."
        },
        changed_paths: {
          type: "array",
          description:
            "Optional changed file paths (workspace-relative). When provided, refresh runs in event mode.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description:
            "Optional deleted file paths (workspace-relative). Only used when event mode is enabled.",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_index_stats",
    description: "Return index health and coverage statistics from SQLite index.",
    parameters: {
      type: "object",
      properties: {
        top_files: {
          type: "integer",
          description: "Optional number of largest files to include.",
          minimum: 1,
          maximum: 50
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_semantic_graph",
    description:
      "Build semantic graph nodes/edges in SQLite from index symbols and optional LSP facts.",
    parameters: {
      type: "object",
      properties: {
        max_symbols: {
          type: "integer",
          description: "Maximum number of seed symbols loaded from code index.",
          minimum: 1,
          maximum: 5000
        },
        semantic_seed_lang_filter: {
          type: "string",
          description:
            "Optional seed language filter. Use '*' for all (default) or comma-separated values like 'javascript,python,go'."
        },
        max_references_per_symbol: {
          type: "integer",
          description: "Maximum reference locations collected per seed symbol.",
          minimum: 1,
          maximum: 200
        },
        include_definitions: {
          type: "boolean",
          description: "Collect definition edges from LSP."
        },
        include_references: {
          type: "boolean",
          description: "Collect reference edges from LSP."
        },
        include_syntax: {
          type: "boolean",
          description: "Ingest syntax index import/call edges as structural priors."
        },
        lsp_required: {
          type: "boolean",
          description: "Fail build if LSP is unavailable."
        },
        max_syntax_import_edges: {
          type: "integer",
          description: "Maximum syntax import edges ingested per build.",
          minimum: 1,
          maximum: 200000
        },
        max_syntax_call_edges: {
          type: "integer",
          description: "Maximum syntax call edges ingested per build.",
          minimum: 1,
          maximum: 200000
        },
        precise_preferred: {
          type: "boolean",
          description: "Prefer precise index import (SCIP) before LSP/index graph build."
        },
        precise_required: {
          type: "boolean",
          description: "Fail build when precise index is unavailable or import fails."
        },
        precise_index_path: {
          type: "string",
          description: "Optional primary precise index path."
        },
        precise_index_paths: {
          type: "array",
          description: "Optional precise index candidate paths, checked in order.",
          items: { type: "string" }
        },
        precise_mode: {
          type: "string",
          description: "Precise import mode when precise index is found.",
          enum: ["merge", "replace"]
        },
        precise_source: {
          type: "string",
          description: "Precise source label, default scip."
        },
        precise_max_nodes: {
          type: "integer",
          description: "Maximum precise nodes imported in preferred mode.",
          minimum: 1,
          maximum: 500000
        },
        precise_max_edges: {
          type: "integer",
          description: "Maximum precise edges imported in preferred mode.",
          minimum: 1,
          maximum: 1000000
        },
        max_lsp_errors: {
          type: "integer",
          description: "Abort LSP enrichment after this many request errors.",
          minimum: 1,
          maximum: 200
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_semantic_graph",
    description:
      "Refresh semantic graph incrementally using changed_paths/deleted_paths. Falls back to full build when event paths are not provided.",
    parameters: {
      type: "object",
      properties: {
        changed_paths: {
          type: "array",
          description: "Optional changed file paths relative to workspace root.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Optional deleted file paths relative to workspace root.",
          items: { type: "string" }
        },
        max_symbols: {
          type: "integer",
          description: "Maximum number of changed-path seed symbols loaded from code index.",
          minimum: 1,
          maximum: 5000
        },
        semantic_seed_lang_filter: {
          type: "string",
          description:
            "Optional seed language filter. Use '*' for all (default) or comma-separated values like 'javascript,python,go'."
        },
        max_references_per_symbol: {
          type: "integer",
          description: "Maximum reference locations collected per changed seed symbol.",
          minimum: 1,
          maximum: 200
        },
        include_definitions: {
          type: "boolean",
          description: "Collect definition edges from LSP."
        },
        include_references: {
          type: "boolean",
          description: "Collect reference edges from LSP."
        },
        include_syntax: {
          type: "boolean",
          description: "Rebuild syntax-derived semantic edges."
        },
        lsp_required: {
          type: "boolean",
          description: "Fail refresh if LSP is unavailable."
        },
        max_syntax_import_edges: {
          type: "integer",
          description: "Maximum syntax import edges ingested per refresh.",
          minimum: 1,
          maximum: 200000
        },
        max_syntax_call_edges: {
          type: "integer",
          description: "Maximum syntax call edges ingested per refresh.",
          minimum: 1,
          maximum: 200000
        },
        precise_preferred: {
          type: "boolean",
          description: "When true, refresh may fallback to full precise build."
        },
        precise_required: {
          type: "boolean",
          description: "Require precise import; refresh falls back to full precise mode."
        },
        precise_index_path: {
          type: "string",
          description: "Optional primary precise index path."
        },
        precise_index_paths: {
          type: "array",
          description: "Optional precise index candidate paths, checked in order.",
          items: { type: "string" }
        },
        precise_mode: {
          type: "string",
          description: "Precise import mode when precise index is found.",
          enum: ["merge", "replace"]
        },
        precise_source: {
          type: "string",
          description: "Precise source label, default scip."
        },
        precise_max_nodes: {
          type: "integer",
          description: "Maximum precise nodes imported in fallback precise mode.",
          minimum: 1,
          maximum: 500000
        },
        precise_max_edges: {
          type: "integer",
          description: "Maximum precise edges imported in fallback precise mode.",
          minimum: 1,
          maximum: 1000000
        },
        max_lsp_errors: {
          type: "integer",
          description: "Abort LSP enrichment after this many request errors.",
          minimum: 1,
          maximum: 200
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "import_precise_index",
    description:
      "Import precise index facts (SCIP-normalized JSON) into semantic graph as semantic nodes/edges.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to precise index JSON file."
        },
        mode: {
          type: "string",
          description: "Import mode: merge (default) or replace existing semantic graph.",
          enum: ["merge", "replace"]
        },
        source: {
          type: "string",
          description: "Fact source label, default scip."
        },
        max_nodes: {
          type: "integer",
          description: "Maximum nodes loaded from import payload.",
          minimum: 1,
          maximum: 500000
        },
        max_edges: {
          type: "integer",
          description: "Maximum edges loaded from import payload.",
          minimum: 1,
          maximum: 1000000
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_semantic_graph",
    description:
      "Query semantic graph seeds and return incoming/outgoing neighbors. Falls back to syntax index, then code index when graph is empty.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or file keyword to locate graph seeds."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed nodes returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum incoming/outgoing neighbors per seed.",
          minimum: 1,
          maximum: 100
        },
        max_hops: {
          type: "integer",
          description: "Optional max traversal hops per seed (default 1, max 4).",
          minimum: 1,
          maximum: 4
        },
        per_hop_limit: {
          type: "integer",
          description: "Optional edge expansion cap per hop during multi-hop traversal.",
          minimum: 1,
          maximum: 50
        },
        edge_type: {
          type: "string",
          description: "Optional edge type filter, e.g. definition or reference."
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_hybrid_index",
    description:
      "Hybrid retrieval across semantic graph, syntax index, and code index with lightweight re-ranking.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or file keyword to retrieve hybrid candidates."
        },
        top_k: {
          type: "integer",
          description: "Maximum merged candidates returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum neighbors requested from semantic graph per seed.",
          minimum: 1,
          maximum: 100
        },
        max_hops: {
          type: "integer",
          description: "Optional max traversal hops for semantic graph query.",
          minimum: 1,
          maximum: 4
        },
        per_hop_limit: {
          type: "integer",
          description: "Optional edge expansion cap per hop for semantic graph query.",
          minimum: 1,
          maximum: 50
        },
        edge_type: {
          type: "string",
          description: "Optional edge type filter for semantic graph query."
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix preference during fusion ranking."
        },
        language: {
          type: "string",
          description: "Optional language filter shared by index/vector retrieval."
        },
        include_vector: {
          type: "boolean",
          description: "Enable offline vector source during hybrid retrieval."
        },
        vector_max_candidates: {
          type: "integer",
          description: "Maximum vector chunk candidates scanned before ranking.",
          minimum: 1,
          maximum: 20000
        },
        vector_layers: {
          type: "array",
          description: "Vector layers included in retrieval (base and/or delta).",
          items: { type: "string", enum: ["base", "delta"] }
        },
        explain: {
          type: "boolean",
          description: "Include score feature breakdown for each returned candidate."
        },
        enable_embedding: {
          type: "boolean",
          description:
            "Enable optional embedding rerank for top hybrid candidates. Defaults to CLAWTY_EMBEDDING_ENABLED."
        },
        embedding_top_k: {
          type: "integer",
          description: "Maximum candidates to rerank with embeddings.",
          minimum: 1,
          maximum: 200
        },
        embedding_weight: {
          type: "number",
          description: "Blend weight for embedding score in final hybrid ranking (0-1).",
          minimum: 0,
          maximum: 1
        },
        embedding_model: {
          type: "string",
          description: "Optional embedding model override, e.g. text-embedding-3-small."
        },
        embedding_timeout_ms: {
          type: "integer",
          description: "Optional embedding request timeout override in milliseconds.",
          minimum: 1000,
          maximum: 120000
        },
        enable_freshness: {
          type: "boolean",
          description:
            "Enable freshness-based rerank using file mtime metadata. Defaults to CLAWTY_INDEX_FRESHNESS_ENABLED."
        },
        freshness_stale_after_ms: {
          type: "integer",
          description: "Age threshold in milliseconds after which candidates are treated as stale.",
          minimum: 1000,
          maximum: 86_400_000
        },
        freshness_weight: {
          type: "number",
          description: "Blend weight for freshness score in final hybrid ranking (0-1).",
          minimum: 0,
          maximum: 1
        },
        freshness_vector_stale_penalty: {
          type: "number",
          description:
            "Additional downweight factor for stale candidates supported by vector retrieval (0-1).",
          minimum: 0,
          maximum: 1
        },
        freshness_max_paths: {
          type: "integer",
          description: "Maximum unique candidate paths sampled for freshness metadata lookup.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_semantic_graph_stats",
    description:
      "Return semantic graph stats, including source mix and precise freshness metadata.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_syntax_index",
    description:
      "Build syntax index from indexed files and extract import/call edges for structural analysis.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap parsed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_calls_per_file: {
          type: "integer",
          description: "Optional per-file cap for extracted call edges.",
          minimum: 1,
          maximum: 2000
        },
        max_errors: {
          type: "integer",
          description: "Abort build after this many file parse errors.",
          minimum: 1,
          maximum: 1000
        },
        parser_provider: {
          type: "string",
          description: "Parser provider mode: auto (default), skeleton, or tree-sitter.",
          enum: ["skeleton", "tree-sitter", "auto"]
        },
        parser_strict: {
          type: "boolean",
          description: "When true with tree-sitter provider, fail instead of falling back."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_syntax_index",
    description:
      "Incrementally refresh syntax index. Optionally pass changed_paths/deleted_paths for event-driven updates.",
    parameters: {
      type: "object",
      properties: {
        max_files: {
          type: "integer",
          description: "Optional scan limit to cap parsed file count.",
          minimum: 1,
          maximum: 20000
        },
        max_calls_per_file: {
          type: "integer",
          description: "Optional per-file cap for extracted call edges.",
          minimum: 1,
          maximum: 2000
        },
        max_errors: {
          type: "integer",
          description: "Abort refresh after this many file parse errors.",
          minimum: 1,
          maximum: 1000
        },
        parser_provider: {
          type: "string",
          description: "Parser provider mode: auto (default), skeleton, or tree-sitter.",
          enum: ["skeleton", "tree-sitter", "auto"]
        },
        parser_strict: {
          type: "boolean",
          description: "When true with tree-sitter provider, fail instead of falling back."
        },
        changed_paths: {
          type: "array",
          description:
            "Optional changed file paths (workspace-relative). When provided, refresh runs in event mode.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description:
            "Optional deleted file paths (workspace-relative). Only used when event mode is enabled.",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_syntax_index",
    description:
      "Query syntax index by symbol/path keyword and return structural neighbors (imports/calls).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol or path keyword to locate syntax seed files."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed files returned.",
          minimum: 1,
          maximum: 30
        },
        max_neighbors: {
          type: "integer",
          description: "Maximum outgoing/incoming neighbors per seed.",
          minimum: 1,
          maximum: 100
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter, e.g. src/."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_syntax_index_stats",
    description: "Return syntax index coverage and structural edge statistics.",
    parameters: {
      type: "object",
      properties: {
        top_files: {
          type: "integer",
          description: "Optional number of top callers/imported targets to include.",
          minimum: 1,
          maximum: 50
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "build_vector_index",
    description:
      "Build offline vector index from code chunks. Writes vectors into base or delta layer in SQLite.",
    parameters: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description: "Target layer: base (default) or delta.",
          enum: ["base", "delta"]
        },
        max_chunks: {
          type: "integer",
          description: "Maximum chunk rows embedded per build run.",
          minimum: 1,
          maximum: 20000
        },
        batch_size: {
          type: "integer",
          description: "Embedding batch size.",
          minimum: 1,
          maximum: 128
        },
        model: {
          type: "string",
          description: "Embedding model override, e.g. text-embedding-3-small."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        },
        source_revision: {
          type: "string",
          description: "Optional source revision label for traceability."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "refresh_vector_index",
    description:
      "Incrementally refresh vector index for changed/deleted paths. Falls back to full build if event paths are missing.",
    parameters: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description: "Target layer for refresh. Defaults to delta.",
          enum: ["base", "delta"]
        },
        changed_paths: {
          type: "array",
          description: "Changed file paths relative to workspace root.",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Deleted file paths relative to workspace root.",
          items: { type: "string" }
        },
        max_chunks: {
          type: "integer",
          description: "Maximum changed chunk rows embedded per refresh run.",
          minimum: 1,
          maximum: 20000
        },
        batch_size: {
          type: "integer",
          description: "Embedding batch size.",
          minimum: 1,
          maximum: 128
        },
        model: {
          type: "string",
          description: "Embedding model override."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        },
        source_revision: {
          type: "string",
          description: "Optional source revision label for traceability."
        }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "query_vector_index",
    description:
      "Query offline vector index using semantic similarity against chunk embeddings.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language or code query."
        },
        top_k: {
          type: "integer",
          description: "Maximum vector hits returned.",
          minimum: 1,
          maximum: 100
        },
        max_candidates: {
          type: "integer",
          description: "Maximum candidate chunk vectors scanned before ranking.",
          minimum: 1,
          maximum: 20000
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        },
        layers: {
          type: "array",
          description: "Layer filter. Defaults to [base, delta].",
          items: { type: "string", enum: ["base", "delta"] }
        },
        model: {
          type: "string",
          description: "Embedding model override."
        },
        timeout_ms: {
          type: "integer",
          description: "Embedding request timeout.",
          minimum: 1000,
          maximum: 120000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "get_vector_index_stats",
    description: "Return offline vector index coverage and latest run stats.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "merge_vector_delta",
    description:
      "Merge delta layer vectors into base layer and clear merged delta rows.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_definition",
    description:
      "Find symbol definition using LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root."
        },
        line: {
          type: "integer",
          description: "1-based line number.",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "1-based column number.",
          minimum: 1
        },
        max_results: {
          type: "integer",
          description: "Optional maximum number of returned locations.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_references",
    description:
      "Find symbol references using LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root."
        },
        line: {
          type: "integer",
          description: "1-based line number.",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "1-based column number.",
          minimum: 1
        },
        include_declaration: {
          type: "boolean",
          description: "Include declaration sites in references."
        },
        max_results: {
          type: "integer",
          description: "Optional maximum number of returned locations.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_workspace_symbols",
    description:
      "Search workspace symbols via LSP (TypeScript/JavaScript). Falls back to index search when LSP is unavailable.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol query text."
        },
        max_results: {
          type: "integer",
          description: "Optional maximum number of returned symbols.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "lsp_health",
    description: "Return LSP service health, lifecycle status, and recent errors.",
    parameters: {
      type: "object",
      properties: {
        startup_check: {
          type: "boolean",
          description: "When true, try to start LSP server before reporting health."
        }
      },
      additionalProperties: false
    }
  }
];
