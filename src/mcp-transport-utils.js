export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "failed_to_serialize" });
  }
}

export function writeMessage(message, output = process.stdout) {
  const payload = safeStringify(message);
  const byteLength = Buffer.byteLength(payload, "utf8");
  output.write(`Content-Length: ${byteLength}\r\n\r\n${payload}`);
}

export function parseContentLength(headerBlock) {
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== "content-length") {
      continue;
    }
    const value = Number(line.slice(separatorIndex + 1).trim());
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
    return null;
  }
  return null;
}

export function findHeaderTerminator(buffer) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (crlfIndex >= 0) {
    return { index: crlfIndex, delimiterLength: 4 };
  }
  const lfIndex = buffer.indexOf("\n\n");
  if (lfIndex >= 0) {
    return { index: lfIndex, delimiterLength: 2 };
  }
  return null;
}

export function readHttpRequestBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += normalized.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(normalized);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function writeJsonResponse(res, statusCode, payload) {
  const body = safeStringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8")
  });
  res.end(body);
}

export function writeNoContent(res) {
  res.statusCode = 204;
  res.end();
}
