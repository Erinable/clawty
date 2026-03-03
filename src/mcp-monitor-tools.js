import path from "node:path";
import { buildReport } from "../scripts/metrics-report.mjs";
import { buildTunerReport } from "../scripts/tuner-report.mjs";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

export const MONITOR_TOOL_DEFINITIONS = [
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

export const MONITOR_TOOL_NAME_SET = new Set(
  MONITOR_TOOL_DEFINITIONS.map((tool) => tool.name)
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseWorkspaceAndWindow(args = {}, fallbackWorkspace) {
  const normalizedArgs = isPlainObject(args) ? args : {};
  const workspace =
    typeof normalizedArgs.workspace === "string" && normalizedArgs.workspace.trim().length > 0
      ? path.resolve(normalizedArgs.workspace.trim())
      : path.resolve(fallbackWorkspace || process.cwd());
  const windowHoursRaw = Number(normalizedArgs.window_hours);
  const window_hours =
    Number.isFinite(windowHoursRaw) && windowHoursRaw > 0 && windowHoursRaw <= MAX_WINDOW_HOURS
      ? windowHoursRaw
      : DEFAULT_WINDOW_HOURS;
  return { workspace, window_hours };
}

export async function callMonitorTool(name, args, fallbackWorkspace) {
  const { workspace, window_hours } = parseWorkspaceAndWindow(args, fallbackWorkspace);
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
