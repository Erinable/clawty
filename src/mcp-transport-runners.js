import http from "node:http";

export async function runStdioTransportWithDeps(
  serverOptions,
  tools,
  logger,
  deps = {}
) {
  const {
    handleRpcRequest,
    buildRpcError,
    writeMessage,
    logWith,
    findHeaderTerminator,
    parseContentLength
  } = deps;
  let rawBuffer = Buffer.alloc(0);
  let shouldExit = false;

  const handlePayload = async (payloadText) => {
    const payload = payloadText.trim();
    if (!payload) {
      return;
    }

    let request;
    try {
      request = JSON.parse(payload);
    } catch {
      writeMessage(buildRpcError(null, -32700, "Parse error"));
      logWith(logger, "warn", "mcp.parse_error");
      return;
    }

    const { response, shouldExit: shouldClose } = await handleRpcRequest(
      request,
      serverOptions,
      tools,
      logger
    );
    if (response) {
      writeMessage(response);
    }
    if (shouldClose) {
      shouldExit = true;
    }
  };

  const parseNextPayload = () => {
    if (rawBuffer.length === 0) {
      return null;
    }

    let skip = 0;
    while (skip < rawBuffer.length) {
      const code = rawBuffer[skip];
      if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) {
        break;
      }
      skip += 1;
    }
    if (skip > 0) {
      rawBuffer = rawBuffer.slice(skip);
    }
    if (rawBuffer.length === 0) {
      return null;
    }

    const firstByte = rawBuffer[0];
    if (firstByte === 0x7b || firstByte === 0x5b) {
      const newlineIndex = rawBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return null;
      }
      const payload = rawBuffer.slice(0, newlineIndex).toString("utf8");
      rawBuffer = rawBuffer.slice(newlineIndex + 1);
      return payload;
    }

    const headerTerminator = findHeaderTerminator(rawBuffer);
    if (!headerTerminator) {
      return null;
    }
    const headerEnd = headerTerminator.index;
    const headerBlock = rawBuffer.slice(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headerBlock);
    if (contentLength === null) {
      rawBuffer = rawBuffer.slice(headerEnd + headerTerminator.delimiterLength);
      writeMessage(buildRpcError(null, -32600, "Invalid Content-Length header"));
      return "";
    }

    const bodyStart = headerEnd + headerTerminator.delimiterLength;
    const bodyEnd = bodyStart + contentLength;
    if (rawBuffer.length < bodyEnd) {
      return null;
    }
    const payload = rawBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    rawBuffer = rawBuffer.slice(bodyEnd);
    return payload;
  };

  for await (const chunk of process.stdin) {
    rawBuffer = Buffer.concat([rawBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      const payload = parseNextPayload();
      if (payload === null) {
        break;
      }
      await handlePayload(payload);
      if (shouldExit) {
        logWith(logger, "info", "mcp.server_stop", { transport: "stdio" });
        return;
      }
    }
  }
}

function writeHtmlResponse(res, statusCode, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

export async function runHttpTransportWithDeps(
  serverOptions,
  tools,
  logger,
  deps = {}
) {
  const {
    handleRpcRequest,
    buildRpcError,
    readHttpRequestBody,
    writeJsonResponse,
    writeNoContent,
    logWith,
    renderDashboardPage,
    createDashboardRouter
  } = deps;
  const host = serverOptions.host;
  const port = serverOptions.port;
  let serverRef = null;
  let closing = false;

  const dashboardRouter =
    typeof createDashboardRouter === "function"
      ? createDashboardRouter(serverOptions, tools, logger)
      : null;

  let cachedDashboardHtml = null;
  const getDashboardHtml = () => {
    if (!cachedDashboardHtml && typeof renderDashboardPage === "function") {
      cachedDashboardHtml = renderDashboardPage();
    }
    return cachedDashboardHtml;
  };

  await new Promise((resolve, reject) => {
    const cleanupHandlers = [];
    const registerCleanup = (fn) => {
      cleanupHandlers.push(fn);
    };
    const runCleanup = () => {
      for (const fn of cleanupHandlers.splice(0)) {
        try {
          fn();
        } catch {
          // Best-effort cleanup.
        }
      }
    };
    const closeServer = () => {
      if (closing || !serverRef) {
        return;
      }
      closing = true;
      serverRef.close((error) => {
        runCleanup();
        if (error) {
          reject(error);
          return;
        }
        logWith(logger, "info", "mcp.server_stop", { transport: "http" });
        resolve();
      });
    };

    const handleSignal = () => {
      closeServer();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    registerCleanup(() => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    });

    const server = http.createServer(async (req, res) => {
      try {
        const method = String(req.method || "").toUpperCase();
        const url = String(req.url || "/");

        if (method === "GET" && (url === "/" || url === "/healthz")) {
          writeJsonResponse(res, 200, {
            ok: true,
            transport: "http",
            host,
            port,
            dashboard: "/dashboard"
          });
          return;
        }

        if (method === "GET" && (url === "/dashboard" || url.startsWith("/dashboard/"))) {
          const html = getDashboardHtml();
          if (html) {
            writeHtmlResponse(res, 200, html);
          } else {
            writeJsonResponse(res, 501, { ok: false, error: "Dashboard not available" });
          }
          return;
        }

        if (method === "GET" && url.startsWith("/api/dashboard")) {
          if (dashboardRouter) {
            const { statusCode, body } = await dashboardRouter(url);
            writeJsonResponse(res, statusCode, body);
          } else {
            writeJsonResponse(res, 501, { ok: false, error: "Dashboard API not available" });
          }
          return;
        }

        if (method !== "POST") {
          writeJsonResponse(res, 405, {
            ok: false,
            error: "Method not allowed. Use POST for JSON-RPC payloads or GET /dashboard for the web UI."
          });
          return;
        }

        const rawBody = await readHttpRequestBody(req);
        let request;
        try {
          request = JSON.parse(rawBody || "");
        } catch {
          logWith(logger, "warn", "mcp.parse_error");
          writeJsonResponse(res, 400, buildRpcError(null, -32700, "Parse error"));
          return;
        }

        const { response, shouldExit } = await handleRpcRequest(request, serverOptions, tools, logger);
        if (response) {
          writeJsonResponse(res, 200, response);
        } else {
          writeNoContent(res);
        }
        if (shouldExit) {
          setTimeout(closeServer, 0);
        }
      } catch (error) {
        logWith(logger, "error", "mcp.http_request_failed", { error });
        if (!res.headersSent) {
          writeJsonResponse(res, 500, buildRpcError(null, -32603, "Internal error"));
        } else {
          res.end();
        }
      }
    });

    serverRef = server;
    server.on("error", (error) => {
      runCleanup();
      reject(error);
    });
    server.listen(port, host, () => {
      logWith(logger, "info", "mcp.http_listening", { host, port });
    });
  });
}
