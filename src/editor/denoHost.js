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

export async function startSdnFlowEditorDenoHost(options = {}) {
  const serve =
    options.serve ??
    (globalThis.Deno && typeof globalThis.Deno.serve === "function"
      ? globalThis.Deno.serve.bind(globalThis.Deno)
      : null);
  if (typeof serve !== "function") {
    throw new Error(
      "startSdnFlowEditorDenoHost requires a Deno.serve-compatible function.",
    );
  }

  const hostname = normalizeHost(options.hostname, "127.0.0.1");
  const port = normalizePort(options.port, 8080);
  const handler =
    options.handler ?? createSdnFlowEditorFetchHandler(options);

  const server = await serve(
    {
      hostname,
      port,
    },
    handler,
  );

  return {
    platform: "deno",
    hostname,
    port,
    url: `http://${hostname}:${port}${options.basePath && options.basePath !== "/" ? options.basePath : "/"}`,
    handler,
    server,
    async close() {
      if (typeof server?.shutdown === "function") {
        await server.shutdown();
        return;
      }
      if (typeof server?.stop === "function") {
        await server.stop();
      }
    },
  };
}

export default {
  startSdnFlowEditorDenoHost,
};
