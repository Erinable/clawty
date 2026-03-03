import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolveMcpServerRuntimeOptions } from "../src/mcp-server.js";
import { runTool } from "../src/tools.js";
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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", (error) => {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port || null);
      });
    });
  });
}

function httpRequest({ method = "GET", host = "127.0.0.1", port, pathName = "/", body = null }) {
  return new Promise((resolve, reject) => {
    const bodyText = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (bodyText !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(bodyText, "utf8");
    }
    const req = http.request(
      {
        method,
        host,
        port,
        path: pathName,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({
            statusCode: res.statusCode || 0,
            text,
            json
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("HTTP request timeout"));
    });
    if (bodyText !== null) {
      req.write(bodyText);
    }
    req.end();
  });
}

async function waitForHttpReady(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest({
        method: "GET",
        port,
        pathName: "/healthz"
      });
      if (response.statusCode === 200) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mcp http transport did not become ready on port ${port}`);
}

test("resolveMcpServerRuntimeOptions infers http transport when config provides port", () => {
  const resolved = resolveMcpServerRuntimeOptions(
    {
      toolsets: []
    },
    {
      workspaceRoot: path.resolve("tmp-clawty-test"),
      mcpServer: {
        host: "127.0.0.1",
        port: 9010
      }
    }
  );
  assert.equal(resolved.transport, "http");
  assert.equal(resolved.port, 9010);
});

test("resolveMcpServerRuntimeOptions rejects --transport stdio with --port", () => {
  assert.throws(
    () =>
      resolveMcpServerRuntimeOptions(
        {
          transport: "stdio",
          port: 9011
        },
        {
          workspaceRoot: path.resolve("tmp-clawty-test")
        }
      ),
    /--port cannot be used with --transport stdio/
  );
});

test("mcp-server exposes facade tools by default", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "src", "mcp-indexable.js"),
    "export const mcpSymbolAlpha = true;\n",
    "utf8"
  );
  const buildContext = {
    workspaceRoot,
    toolTimeoutMs: 30_000,
    lsp: { enabled: false },
    embedding: { enabled: false },
    metrics: { enabled: false, persistHybrid: false, queryPreviewChars: 0 },
    onlineTuner: { enabled: false, mode: "off" }
  };
  const builtIndex = await runTool("build_code_index", {}, buildContext);
  assert.equal(builtIndex.ok, true);
  const builtSyntax = await runTool("build_syntax_index", {}, buildContext);
  assert.equal(builtSyntax.ok, true);
  const builtSemantic = await runTool(
    "build_semantic_graph",
    {
      include_definitions: false,
      include_references: false,
      include_syntax: true
    },
    buildContext
  );
  assert.equal(builtSemantic.ok, true);

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
  const toolNames = new Set(toolsList.result.tools.map((tool) => tool.name));
  assert.ok(toolNames.has("search_code"));
  assert.ok(toolNames.has("go_to_definition"));
  assert.ok(toolNames.has("find_references"));
  assert.ok(toolNames.has("get_code_context"));
  assert.ok(toolNames.has("explain_code"));
  assert.ok(toolNames.has("trace_call_chain"));
  assert.ok(toolNames.has("impact_analysis"));
  assert.equal(toolNames.has("reindex_codebase"), false);
  assert.ok(toolNames.has("monitor_system"));
  assert.equal(toolNames.has("build_code_index"), false);
  assert.equal(toolNames.has("query_code_index"), false);
  assert.equal(toolNames.has("monitor_report"), false);

  const monitorReport = await rpc.call("tools/call", {
    name: "monitor_system",
    arguments: {
      workspace: workspaceRoot,
      window_hours: 24
    }
  });
  assert.ok(monitorReport.result?.structuredContent);
  assert.ok(monitorReport.result.structuredContent.metrics);
  assert.ok(monitorReport.result.structuredContent.tuner);

  const reindexDenied = await rpc.call("tools/call", {
    name: "reindex_codebase",
    arguments: {}
  });
  assert.ok(reindexDenied.error);
  assert.match(String(reindexDenied.error.message), /not exposed/i);

  const searched = await rpc.call("tools/call", {
    name: "search_code",
    arguments: {
      query: "mcpSymbolAlpha",
      top_k: 1
    }
  });
  assert.equal(searched.result?.structuredContent?.ok, true);
  assert.ok(["keyword", "hybrid"].includes(searched.result?.structuredContent?.strategy_used));
  assert.equal(
    searched.result?.structuredContent?.results?.[0]?.path,
    "src/mcp-indexable.js"
  );

  const explained = await rpc.call("tools/call", {
    name: "explain_code",
    arguments: {
      path: "src/mcp-indexable.js",
      max_chars: 500
    }
  });
  assert.equal(explained.result?.structuredContent?.ok, true);
  assert.match(explained.result?.structuredContent?.content || "", /mcpSymbolAlpha/);

  const traced = await rpc.call("tools/call", {
    name: "trace_call_chain",
    arguments: {
      query: "mcpSymbolAlpha",
      top_k: 3
    }
  });
  assert.equal(traced.result?.structuredContent?.ok, true);
  assert.equal(typeof traced.result?.structuredContent?.summary, "object");

  const impacted = await rpc.call("tools/call", {
    name: "impact_analysis",
    arguments: {
      query: "mcpSymbolAlpha",
      top_k: 3
    }
  });
  assert.equal(impacted.result?.structuredContent?.ok, true);
  assert.ok(Array.isArray(impacted.result?.structuredContent?.impacted_paths));
  assert.ok(impacted.result?.structuredContent?.impacted_paths.includes("src/mcp-indexable.js"));

  rpc.notify("exit", {});
});

test("mcp-server exposes edit-safe toolset when requested", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-edit-safe-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "src", "reindex-target.js"),
    "export const reindexTarget = true;\n",
    "utf8"
  );

  const child = spawn(
    "node",
    [CLI_PATH, "mcp-server", `--workspace=${workspaceRoot}`, "--toolset", "edit-safe"],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  t.after(async () => {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => {});
  });

  const rpc = createJsonRpcClient(child);
  await rpc.call("initialize", {});
  const toolsList = await rpc.call("tools/list", {});
  const toolNames = new Set(toolsList.result.tools.map((tool) => tool.name));
  assert.ok(toolNames.has("reindex_codebase"));
  assert.equal(toolNames.has("search_code"), false);
  assert.equal(toolNames.has("monitor_system"), false);

  const reindex = await rpc.call("tools/call", {
    name: "reindex_codebase",
    arguments: {}
  });
  assert.equal(reindex.result?.structuredContent?.ok, true);

  rpc.notify("exit", {});
});

test("mcp-server can expose low-level tools via flag", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-low-level-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const child = spawn(
    "node",
    [CLI_PATH, "mcp-server", `--workspace=${workspaceRoot}`, "--expose-low-level"],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  t.after(async () => {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => {});
  });

  const rpc = createJsonRpcClient(child);
  await rpc.call("initialize", {});
  const toolsList = await rpc.call("tools/list", {});
  const toolNames = new Set(toolsList.result.tools.map((tool) => tool.name));
  assert.ok(toolNames.has("search_code"));
  assert.ok(toolNames.has("build_code_index"));
  assert.ok(toolNames.has("query_code_index"));
  assert.ok(toolNames.has("monitor_report"));

  rpc.notify("exit", {});
});

test("mcp-server supports HTTP transport with explicit port", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-http-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const port = await findFreePort();
  if (!port) {
    t.skip("sandbox disallows opening local TCP listeners");
    return;
  }
  const child = spawn(
    "node",
    [
      CLI_PATH,
      "mcp-server",
      `--workspace=${workspaceRoot}`,
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
  });

  await waitForHttpReady(port);
  const initialize = await httpRequest({
    method: "POST",
    port,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }
  });
  assert.equal(initialize.statusCode, 200);
  assert.equal(initialize.json?.result?.serverInfo?.name, "clawty-mcp");

  const toolsList = await httpRequest({
    method: "POST",
    port,
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }
  });
  assert.equal(toolsList.statusCode, 200);
  const toolNames = new Set((toolsList.json?.result?.tools || []).map((tool) => tool.name));
  assert.ok(toolNames.has("search_code"));
  assert.ok(toolNames.has("monitor_system"));

  const exitNotification = await httpRequest({
    method: "POST",
    port,
    body: {
      jsonrpc: "2.0",
      method: "exit",
      params: {}
    }
  });
  assert.equal(exitNotification.statusCode, 204);
  await once(child, "close");
});

test("mcp-server can read HTTP host/port from config", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-http-config-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const port = await findFreePort();
  if (!port) {
    t.skip("sandbox disallows opening local TCP listeners");
    return;
  }
  await fs.mkdir(path.join(workspaceRoot, ".clawty"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".clawty", "config.json"),
    JSON.stringify(
      {
        mcpServer: {
          transport: "http",
          host: "127.0.0.1",
          port
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const child = spawn("node", [CLI_PATH, "mcp-server"], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
  });

  await waitForHttpReady(port);
  const toolsList = await httpRequest({
    method: "POST",
    port,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    }
  });
  assert.equal(toolsList.statusCode, 200);
  const toolNames = new Set((toolsList.json?.result?.tools || []).map((tool) => tool.name));
  assert.ok(toolNames.has("search_code"));
  assert.ok(toolNames.has("monitor_system"));

  const exitNotification = await httpRequest({
    method: "POST",
    port,
    body: {
      jsonrpc: "2.0",
      method: "exit",
      params: {}
    }
  });
  assert.equal(exitNotification.statusCode, 204);
  await once(child, "close");
});

test("mcp-server writes logs to dedicated log file", async (t) => {
  const workspaceRoot = await createWorkspace("clawty-mcp-server-logs-");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });
  const logPath = path.join(workspaceRoot, "mcp-custom.log");
  const child = spawn(
    "node",
    [CLI_PATH, "mcp-server", `--workspace=${workspaceRoot}`, "--log-path", logPath],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
  });

  const rpc = createJsonRpcClient(child);
  await rpc.call("initialize", {});
  rpc.notify("exit", {});
  await once(child, "close");

  const content = await fs.readFile(logPath, "utf8");
  assert.match(content, /"event":"mcp\.server_start"/);
});
