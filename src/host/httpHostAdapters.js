import { startInstalledFlowAppHost } from "./appHost.js";
import { ensureManagedSecurityState } from "./managedSecurity.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function resolveBindingUrl(binding = {}) {
  const rawUrl = normalizeString(binding.url, null);
  if (!rawUrl) {
    throw new Error("HTTP binding is missing a url.");
  }
  return new URL(rawUrl);
}

function normalizeNodeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
      continue;
    }
    normalized[key] = String(value);
  }
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeManagedSecuritySettings(base = {}, extra = {}) {
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(extra) ? extra : {}),
    wallet: {
      ...(isPlainObject(base?.wallet) ? base.wallet : {}),
      ...(isPlainObject(extra?.wallet) ? extra.wallet : {}),
    },
    tls: {
      ...(isPlainObject(base?.tls) ? base.tls : {}),
      ...(isPlainObject(extra?.tls) ? extra.tls : {}),
    },
  };
}

function resolveNodeBindingSecurity(binding = {}, options = {}) {
  const optionSecurity = isPlainObject(options.security) ? options.security : {};
  const bindingSecurity = isPlainObject(binding.security) ? binding.security : {};
  return mergeManagedSecuritySettings(optionSecurity, bindingSecurity);
}

async function readNodeRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return Buffer.concat(chunks);
}

async function createFetchRequestFromNodeIncomingMessage(request, binding) {
  const bindingUrl = resolveBindingUrl(binding);
  const requestUrl = new URL(request.url ?? bindingUrl.pathname, bindingUrl);
  const method = normalizeString(request.method, "GET");
  const headers = normalizeNodeHeaders(request.headers);
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : await readNodeRequestBody(request);

  return new Request(requestUrl, {
    method,
    headers,
    body,
  });
}

async function writeFetchResponseToNodeResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    nodeResponse.setHeader(key, value);
  }
  if (response.body === null) {
    nodeResponse.end();
    return;
  }
  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(bodyBuffer);
}

function closeHandle(handle) {
  if (typeof handle === "function") {
    return handle();
  }
  if (typeof handle?.stop === "function") {
    return handle.stop();
  }
  if (typeof handle?.shutdown === "function") {
    return handle.shutdown();
  }
  if (typeof handle?.abort === "function") {
    return handle.abort();
  }
  if (typeof handle?.close === "function") {
    return handle.close();
  }
  return undefined;
}

export function createDenoServeHttpAdapter(options = {}) {
  const serve =
    options.serve ??
    (globalThis.Deno && typeof globalThis.Deno.serve === "function"
      ? globalThis.Deno.serve.bind(globalThis.Deno)
      : null);
  if (typeof serve !== "function") {
    throw new Error(
      "createDenoServeHttpAdapter requires a Deno.serve-compatible function.",
    );
  }

  return async function serveHttp({ binding, handler }) {
    const url = resolveBindingUrl(binding);
    const port = url.port ? Number(url.port) : 80;
    const result = await serve(
      {
        hostname: url.hostname,
        port,
      },
      handler,
    );
    return {
      platform: "deno",
      url: url.href,
      hostname: url.hostname,
      port,
      server: result ?? null,
      async close() {
        await closeHandle(result);
      },
    };
  };
}

export function createBunServeHttpAdapter(options = {}) {
  const serve =
    options.serve ??
    (globalThis.Bun && typeof globalThis.Bun.serve === "function"
      ? globalThis.Bun.serve.bind(globalThis.Bun)
      : null);
  if (typeof serve !== "function") {
    throw new Error(
      "createBunServeHttpAdapter requires a Bun.serve-compatible function.",
    );
  }

  return async function serveHttp({ binding, handler }) {
    const url = resolveBindingUrl(binding);
    const port = url.port ? Number(url.port) : 80;
    const result = await serve({
      hostname: url.hostname,
      port,
      fetch: handler,
    });
    return {
      platform: "bun",
      url: url.href,
      hostname: url.hostname,
      port,
      server: result ?? null,
      async close() {
        await closeHandle(result);
      },
    };
  };
}

async function listenNodeServer(server, listenOptions) {
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
    server.listen(listenOptions);
  });
}

async function closeNodeServer(server) {
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

export function createNodeServeHttpAdapter(options = {}) {
  return async function serveHttp({ binding, handler, runtimeId, programId }) {
    const [{ createServer: createHttpServer }, { createServer: createHttpsServer }] =
      await Promise.all([import("node:http"), import("node:https")]);
    const url = resolveBindingUrl(binding);
    if (url.protocol && url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `createNodeServeHttpAdapter only supports http and https bindings, received ${url.protocol}.`,
      );
    }
    const protocol = url.protocol === "https:" ? "https" : "http";
    const securityState =
      protocol === "https"
        ? await ensureManagedSecurityState({
            projectRoot: options.projectRoot ?? options.cwd,
            startup: {
              protocol,
              hostname: url.hostname,
            },
            security: resolveNodeBindingSecurity(binding, options),
            scopeId:
              binding.bindingId ??
              runtimeId ??
              programId ??
              `${url.hostname || "127.0.0.1"}-${url.port || "443"}`,
            scopeLabel:
              programId ??
              runtimeId ??
              normalizeString(binding.description, "Installed Flow HTTP Listener") ??
              "Installed Flow HTTP Listener",
          })
        : null;
    if (protocol === "https" && !securityState?.serverOptions) {
      throw new Error("HTTPS bindings require managed TLS server options.");
    }

    const requestListener = async (request, response) => {
      try {
        const fetchRequest = await createFetchRequestFromNodeIncomingMessage(
          request,
          binding,
        );
        const fetchResponse = await handler(fetchRequest, {
          nodeRequest: request,
          nodeResponse: response,
          binding,
        });
        await writeFetchResponseToNodeResponse(fetchResponse, response);
      } catch (error) {
        response.statusCode = 500;
        response.end(
          typeof error?.message === "string"
            ? error.message
            : "Internal Server Error",
        );
      }
    };
    const server =
      protocol === "https"
        ? (options.createHttpsServer ?? createHttpsServer)(
            securityState.serverOptions,
            requestListener,
          )
        : (options.createHttpServer ?? options.createServer ?? createHttpServer)(
            requestListener,
          );

    await listenNodeServer(server, {
      host: url.hostname,
      port: url.port
        ? Number(url.port)
        : protocol === "https"
          ? 443
          : 80,
    });
    const address = server.address();
    const actualPort =
      address && typeof address === "object" && "port" in address
        ? address.port
        : url.port
          ? Number(url.port)
          : protocol === "https"
            ? 443
            : 80;
    const actualUrl = new URL(url.href);
    actualUrl.port = String(actualPort);

    return {
      platform: "node",
      protocol,
      url: actualUrl.href,
      hostname: url.hostname,
      port: actualPort,
      security: securityState
        ? {
            wallet: securityState.wallet,
            tls: securityState.tls,
          }
        : null,
      server,
      async close() {
        await closeNodeServer(server);
      },
    };
  };
}

export async function startInstalledFlowDenoHttpHost(options = {}) {
  return startInstalledFlowAppHost({
    ...options,
    serveHttp:
      options.serveHttp ?? createDenoServeHttpAdapter(options),
  });
}

export async function startInstalledFlowBunHttpHost(options = {}) {
  return startInstalledFlowAppHost({
    ...options,
    serveHttp:
      options.serveHttp ?? createBunServeHttpAdapter(options),
  });
}

export async function startInstalledFlowNodeHttpHost(options = {}) {
  return startInstalledFlowAppHost({
    ...options,
    serveHttp:
      options.serveHttp ?? createNodeServeHttpAdapter(options),
  });
}

export default {
  createBunServeHttpAdapter,
  createDenoServeHttpAdapter,
  createNodeServeHttpAdapter,
  startInstalledFlowBunHttpHost,
  startInstalledFlowDenoHttpHost,
  startInstalledFlowNodeHttpHost,
};
