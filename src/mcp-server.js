import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildReport } from "../scripts/metrics-report.mjs";
import { buildTunerReport } from "../scripts/tuner-report.mjs";
import { loadConfig } from "./config.js";

const MCP_SERVER_NAME = "clawty-mcp";
const MCP_SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "failed_to_serialize" });
  }
}

function writeMessage(message) {
  process.stdout.write(`${safeStringify(message)}\n`);
}

function buildToolDefinitions() {
  return [
    {
      name: "metrics_report",
      description: "Build clawty metrics report for the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "Optional absolute/relative workspace path."
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
      name: "tuner_report",
      description: "Build online tuner report including reward distribution and arm stats.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "Optional absolute/relative workspace path."
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
      name: "monitor_report",
      description: "Build combined metrics+tuner monitoring report.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "Optional absolute/relative workspace path."
          },
          window_hours: {
            type: "number",
            description: "Optional report window in hours."
          }
        },
        additionalProperties: false
      }
    }
  ];
}

function parseWorkspaceAndWindow(args = {}, fallbackWorkspace) {
  const workspace =
    typeof args?.workspace === "string" && args.workspace.trim().length > 0
      ? path.resolve(args.workspace.trim())
      : path.resolve(fallbackWorkspace || process.cwd());
  const windowHoursRaw = Number(args?.window_hours);
  const window_hours =
    Number.isFinite(windowHoursRaw) && windowHoursRaw > 0 && windowHoursRaw <= 24 * 30
      ? windowHoursRaw
      : 24;
  return { workspace, window_hours };
}

async function callTool(name, args, serverOptions = {}) {
  const { workspace, window_hours } = parseWorkspaceAndWindow(
    args,
    serverOptions.workspaceRoot
  );
  if (name === "metrics_report") {
    return buildReport({
      workspaceRoot: workspace,
      windowHours: window_hours,
      format: "json"
    });
  }
  if (name === "tuner_report") {
    return buildTunerReport({
      workspaceRoot: workspace,
      windowHours: window_hours,
      format: "json"
    });
  }
  if (name === "monitor_report") {
    const [metrics, tuner] = await Promise.all([
      buildReport({
        workspaceRoot: workspace,
        windowHours: window_hours,
        format: "json"
      }),
      buildTunerReport({
        workspaceRoot: workspace,
        windowHours: window_hours,
        format: "json"
      })
    ]);
    return {
      generated_at: new Date().toISOString(),
      workspace_root: workspace,
      window_hours,
      metrics,
      tuner
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function buildRpcError(id, code, message, data = null) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

function normalizeServerOptions(options = {}) {
  const workspaceRoot =
    typeof options.workspaceRoot === "string" && options.workspaceRoot.trim().length > 0
      ? path.resolve(options.workspaceRoot)
      : path.resolve(process.cwd());
  return {
    workspaceRoot
  };
}

export async function runMcpServer(options = {}) {
  const serverOptions = normalizeServerOptions(options);
  const tools = buildToolDefinitions();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  for await (const line of rl) {
    const payload = line.trim();
    if (!payload) {
      continue;
    }

    let request;
    try {
      request = JSON.parse(payload);
    } catch {
      writeMessage(buildRpcError(null, -32700, "Parse error"));
      continue;
    }

    const id = request?.id;
    const method = request?.method;
    const params = request?.params || {};

    if (!method || typeof method !== "string") {
      writeMessage(buildRpcError(id, -32600, "Invalid Request"));
      continue;
    }

    if (method === "notifications/initialized") {
      continue;
    }

    if (method === "shutdown") {
      writeMessage({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {}
      });
      continue;
    }

    if (method === "exit") {
      rl.close();
      break;
    }

    if (method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION
          }
        }
      });
      continue;
    }

    if (method === "tools/list") {
      writeMessage({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          tools
        }
      });
      continue;
    }

    if (method === "tools/call") {
      try {
        const toolName = typeof params?.name === "string" ? params.name : "";
        const toolArgs =
          params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        const result = await callTool(toolName, toolArgs, serverOptions);
        writeMessage({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ],
            structuredContent: result
          }
        });
      } catch (error) {
        writeMessage(
          buildRpcError(id, -32603, error?.message || "Internal error", {
            tool: params?.name || null
          })
        );
      }
      continue;
    }

    writeMessage(buildRpcError(id, -32601, `Method not found: ${method}`));
  }
}

function parseMcpServerArgs(argv = []) {
  const options = {
    help: false,
    workspaceRoot: null
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--workspace") {
      const raw = argv[idx + 1];
      if (!raw) {
        throw new Error("Missing value for --workspace");
      }
      options.workspaceRoot = path.resolve(raw);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      options.workspaceRoot = path.resolve(arg.slice("--workspace=".length));
      continue;
    }
    throw new Error(`Unknown mcp-server argument: ${arg}`);
  }
  return options;
}

function printMcpHelp() {
  console.log("Usage: clawty mcp-server [--workspace <path>]");
  console.log("");
  console.log("Starts MCP stdio server with monitoring tools:");
  console.log("- metrics_report");
  console.log("- tuner_report");
  console.log("- monitor_report");
}

async function main() {
  const args = parseMcpServerArgs(process.argv.slice(2));
  if (args.help) {
    printMcpHelp();
    return;
  }
  const config = loadConfig({ allowMissingApiKey: true });
  await runMcpServer({
    workspaceRoot: args.workspaceRoot || config.workspaceRoot
  });
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(`mcp-server failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
