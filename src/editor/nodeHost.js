import { createServer } from "node:http";

import { createSdnFlowEditorFetchHandler } from "./fetchHandler.js";

function normalizeHost(value, fallback = "127.0.0.1") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePort(value, fallback = 8080) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

function normalizeNodeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return normalized;
}

async function readNodeBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return Buffer.concat(chunks);
}

async function toFetchRequest(request, options = {}) {
  const origin = new URL(options.origin ?? "http://127.0.0.1");
  const requestUrl = new URL(request.url ?? "/", origin);
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? null : await readNodeBody(request);

  return new Request(requestUrl, {
    method,
    headers: normalizeNodeHeaders(request.headers),
    body,
  });
}

async function writeFetchResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    nodeResponse.setHeader(key, value);
  }
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(buffer);
}

async function listen(server, options) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startSdnFlowEditorNodeHost(options = {}) {
  const hostname = normalizeHost(options.hostname, "127.0.0.1");
  const port = normalizePort(options.port, 8080);
  const handler =
    options.handler ?? createSdnFlowEditorFetchHandler(options);
  const server = createServer(async (request, response) => {
    try {
      const fetchRequest = await toFetchRequest(request, {
        origin: `http://${hostname}:${port}`,
      });
      const fetchResponse = await handler(fetchRequest);
      await writeFetchResponse(fetchResponse, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(
        typeof error?.message === "string"
          ? error.message
          : "Internal Server Error",
      );
    }
  });

  await listen(server, {
    host: hostname,
    port,
  });
  const address = server.address();
  const actualPort =
    address && typeof address === "object" && "port" in address
      ? address.port
      : port;

  return {
    platform: "node",
    hostname,
    port: actualPort,
    url: `http://${hostname}:${actualPort}${
      options.basePath && options.basePath !== "/" ? options.basePath : "/"
    }`,
    handler,
    server,
    async close() {
      await close(server);
    },
  };
}

export default {
  startSdnFlowEditorNodeHost,
};
