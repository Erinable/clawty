import { DEFAULT_TOOLSETS } from "./mcp-toolset-policy.js";

export const FACADE_TOOL_DEFINITIONS = [
  {
    name: "search_code",
    description:
      "Search code with strategy routing (hybrid/index/vector) and automatic fallback.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Search query."
        },
        top_k: {
          type: "integer",
          description: "Maximum result count.",
          minimum: 1,
          maximum: 50
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        },
        strategy: {
          type: "string",
          description: "Routing strategy: auto|hybrid|keyword|vector.",
          enum: ["auto", "hybrid", "keyword", "vector"]
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "go_to_definition",
    description: "Find symbol definition using LSP-first navigation.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Workspace-relative file path."
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
          description: "Maximum locations returned.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    name: "find_references",
    description: "Find symbol references using LSP-first navigation.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Workspace-relative file path."
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
          description: "Include declaration in reference results."
        },
        max_results: {
          type: "integer",
          description: "Maximum locations returned.",
          minimum: 1,
          maximum: 1000
        }
      },
      required: ["path", "line", "column"],
      additionalProperties: false
    }
  },
  {
    name: "get_code_context",
    description:
      "Return combined code context for a query (search hits + semantic neighbors).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Context query."
        },
        top_k: {
          type: "integer",
          description: "Maximum context hits returned.",
          minimum: 1,
          maximum: 30
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "reindex_codebase",
    description:
      "Run code-intelligence refresh pipeline (code index + syntax index + semantic graph).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        force_full: {
          type: "boolean",
          description: "When true, run full rebuild instead of incremental refresh."
        },
        changed_paths: {
          type: "array",
          description: "Changed file paths (workspace-relative).",
          items: { type: "string" }
        },
        deleted_paths: {
          type: "array",
          description: "Deleted file paths (workspace-relative).",
          items: { type: "string" }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "monitor_system",
    description: "Return combined runtime monitoring report (metrics + tuner).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        window_hours: {
          type: "number",
          description: "Optional report window in hours."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "explain_code",
    description:
      "Read and explain a target file context by path or query (auto-locates best matching file).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file path."
        },
        query: {
          type: "string",
          description: "Optional query used to locate target file when path is not provided."
        },
        max_chars: {
          type: "integer",
          description: "Maximum file chars to return.",
          minimum: 200,
          maximum: 100000
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "trace_call_chain",
    description:
      "Trace call relationships using semantic graph + syntax index for a symbol/query.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Symbol or keyword to trace."
        },
        top_k: {
          type: "integer",
          description: "Maximum seed nodes/files returned.",
          minimum: 1,
          maximum: 20
        },
        max_hops: {
          type: "integer",
          description: "Maximum semantic traversal hops.",
          minimum: 1,
          maximum: 4
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "impact_analysis",
    description:
      "Estimate change impact from a location (path+line+column) or query across references and semantic neighbors.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path override."
        },
        query: {
          type: "string",
          description: "Optional symbol/keyword when location is not provided."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file path."
        },
        line: {
          type: "integer",
          description: "Optional 1-based line number (with path+column).",
          minimum: 1
        },
        column: {
          type: "integer",
          description: "Optional 1-based column number (with path+line).",
          minimum: 1
        },
        top_k: {
          type: "integer",
          description: "Maximum search hits.",
          minimum: 1,
          maximum: 30
        },
        max_paths: {
          type: "integer",
          description: "Maximum impacted paths returned.",
          minimum: 1,
          maximum: 200
        },
        path_prefix: {
          type: "string",
          description: "Optional path prefix filter."
        },
        language: {
          type: "string",
          description: "Optional language filter."
        }
      },
      additionalProperties: false
    }
  }
];

export const FACADE_TOOL_NAME_SET = new Set(FACADE_TOOL_DEFINITIONS.map((tool) => tool.name));

const LOW_LEVEL_CODE_TOOL_NAMES = new Set([
  "read_file",
  "build_code_index",
  "refresh_code_index",
  "query_code_index",
  "get_index_stats",
  "build_semantic_graph",
  "refresh_semantic_graph",
  "import_precise_index",
  "query_semantic_graph",
  "get_semantic_graph_stats",
  "build_syntax_index",
  "refresh_syntax_index",
  "query_syntax_index",
  "get_syntax_index_stats",
  "build_vector_index",
  "refresh_vector_index",
  "query_vector_index",
  "get_vector_index_stats",
  "merge_vector_delta",
  "query_hybrid_index",
  "lsp_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_health"
]);

export function buildLowLevelCodeToolDefinitions(toolDefinitions = []) {
  return toolDefinitions
    .filter((tool) => tool?.type === "function" && LOW_LEVEL_CODE_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters
    }));
}

export function buildToolDefinitionsWithDeps(serverOptions = {}, deps = {}) {
  const {
    resolveFacadeToolNamesForToolsets,
    monitorToolDefinitions,
    lowLevelCodeToolDefinitions
  } = deps;
  const exposedFacadeToolNames =
    serverOptions.exposedFacadeToolNames instanceof Set
      ? serverOptions.exposedFacadeToolNames
      : resolveFacadeToolNamesForToolsets(new Set(DEFAULT_TOOLSETS));
  const exposedFacadeTools = FACADE_TOOL_DEFINITIONS.filter((tool) =>
    exposedFacadeToolNames.has(tool.name)
  );
  if (serverOptions.exposeLowLevel) {
    return [...exposedFacadeTools, ...monitorToolDefinitions, ...lowLevelCodeToolDefinitions];
  }
  return exposedFacadeTools;
}
