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
  let buffer = Buffer.alloc(0);

  function parseFrames() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerBlock = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = headerBlock.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        return;
      }
      const payloadText = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);
      let payload = null;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        payload = null;
      }
      if (payload && payload.id !== undefined && pending.has(payload.id)) {
        const resolver = pending.get(payload.id);
        pending.delete(payload.id);
        resolver(payload);
      }
    }
  }

  function writeJsonRpc(payload) {
    const body = JSON.stringify(payload);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    child.stdin.write(frame);
  }

  child.stdout.on("data", (chunk) => {
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, normalized]);
    parseFrames();
  });

  function call(method, params = {}) {
    const id = seq++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    writeJsonRpc(request);
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
    writeJsonRpc({ jsonrpc: "2.0", method, params });
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
