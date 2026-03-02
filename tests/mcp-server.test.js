import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWorkspace, removeWorkspace } from "./helpers/workspace.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const CLI_PATH = path.join(repoRoot, "src", "index.js");

function createJsonRpcClient(child) {
  let seq = 1;
  const pending = new Map();
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let payload = null;
        try {
          payload = JSON.parse(line);
        } catch {
          payload = null;
        }
        if (payload && payload.id !== undefined && pending.has(payload.id)) {
          const resolver = pending.get(payload.id);
          pending.delete(payload.id);
          resolver(payload);
        }
      }
      index = buffer.indexOf("\n");
    }
  });

  function call(method, params = {}) {
    const id = seq++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 10_000);
      pending.set(id, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  return {
    call,
    notify
  };
}

test("mcp-server exposes monitoring tools via JSON-RPC", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const child = spawn("node", [CLI_PATH, "mcp-server", `--workspace=${workspaceRoot}`], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });

  t.after(async () => {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => {});
  });

  const rpc = createJsonRpcClient(child);

  const initialize = await rpc.call("initialize", {});
  assert.ok(initialize.result);
  assert.equal(initialize.result.serverInfo.name, "clawty-mcp");

  const toolsList = await rpc.call("tools/list", {});
  assert.ok(Array.isArray(toolsList.result.tools));
  assert.ok(toolsList.result.tools.some((tool) => tool.name === "metrics_report"));
  assert.ok(toolsList.result.tools.some((tool) => tool.name === "tuner_report"));
  assert.ok(toolsList.result.tools.some((tool) => tool.name === "monitor_report"));

  const monitorReport = await rpc.call("tools/call", {
    name: "monitor_report",
    arguments: {
      workspace: workspaceRoot,
      window_hours: 24
    }
  });
  assert.ok(monitorReport.result?.structuredContent);
  assert.ok(monitorReport.result.structuredContent.metrics);
  assert.ok(monitorReport.result.structuredContent.tuner);

  rpc.notify("exit", {});
});
