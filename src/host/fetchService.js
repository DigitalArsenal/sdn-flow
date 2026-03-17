import { createInstalledFlowService } from "./installedFlowHost.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeHeaderEntries(headers) {
  if (!headers) {
    return [];
  }
  if (typeof headers.forEach === "function") {
    const entries = [];
    headers.forEach((value, key) => {
      entries.push([key, value]);
    });
    return entries;
  }
  if (typeof headers.entries === "function") {
    return Array.from(headers.entries());
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  if (isObject(headers)) {
    return Object.entries(headers);
  }
  return [];
}

function normalizeHeadersObject(headers) {
  const normalized = {};
  for (const [key, value] of normalizeHeaderEntries(headers)) {
    const headerName = normalizeString(key, null);
    if (!headerName) {
      continue;
    }
    if (Array.isArray(value)) {
      normalized[headerName.toLowerCase()] = value
        .map((item) => String(item))
        .join(", ");
      continue;
    }
    normalized[headerName.toLowerCase()] = String(value);
  }
  return normalized;
}

function normalizeHeadersInit(headers) {
  const normalized = new Headers();
  for (const [key, value] of normalizeHeaderEntries(headers)) {
    const headerName = normalizeString(key, null);
    if (!headerName || value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(headerName, String(item));
      }
      continue;
    }
    normalized.set(headerName, String(value));
  }
  return normalized;
}

function normalizeUrlDetails(urlValue, baseUrl) {
  if (!urlValue) {
    return {
      href: null,
      origin: null,
      path: "/",
      query: {},
    };
  }

  const url = baseUrl ? new URL(urlValue, baseUrl) : new URL(urlValue);
  return {
    href: url.href,
    origin: url.origin,
    path: url.pathname || "/",
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

function normalizeBodyBytes(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return value;
}

async function readRequestBodyBytes(request) {
  if (!request || typeof request.arrayBuffer !== "function") {
    return normalizeBodyBytes(request?.body ?? request?.payload ?? null);
  }

  if (request.bodyUsed) {
    throw new Error("Fetch request body has already been consumed.");
  }

  const method = normalizeString(request.method, "GET");
  if (method === "GET" || method === "HEAD") {
    return null;
  }

  const bodyBuffer = await request.arrayBuffer();
  return bodyBuffer.byteLength > 0 ? new Uint8Array(bodyBuffer) : null;
}

export async function normalizeFetchRequest(request, options = {}) {
  const baseUrl = normalizeString(options.baseUrl, "http://localhost");
  const urlValue =
    normalizeString(request?.url, null) ??
    normalizeString(request?.href, null) ??
    normalizeString(request?.path, null);
  const urlDetails = normalizeUrlDetails(urlValue, baseUrl);
  const requestId =
    normalizeString(request?.requestId, null) ??
    normalizeString(request?.headers?.get?.("x-request-id"), null);

  return {
    triggerId: normalizeString(request?.triggerId, null),
    requestId,
    method: normalizeString(request?.method, "GET"),
    path: urlDetails.path,
    query: urlDetails.query,
    headers: normalizeHeadersObject(request?.headers),
    body: await readRequestBodyBytes(request),
    metadata: {
      url: urlDetails.href,
      origin: urlDetails.origin,
      ...((isObject(options.metadata) && options.metadata) || {}),
      ...((isObject(request?.metadata) && request.metadata) || {}),
    },
  };
}

function resolveHttpResponseFrame(result) {
  if (!Array.isArray(result?.outputs) || result.outputs.length === 0) {
    return null;
  }
  return result.outputs[0]?.frame ?? null;
}

export function createFetchResponse(result, options = {}) {
  const frame = resolveHttpResponseFrame(result);
  const metadata = isObject(frame?.metadata) ? frame.metadata : {};
  const headers = normalizeHeadersInit(
    metadata.responseHeaders ?? metadata.headers ?? {},
  );
  const contentType = normalizeString(
    metadata.contentType ?? metadata.content_type,
    null,
  );
  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  const statusCode = Number(
    metadata.statusCode ?? metadata.status ?? metadata.status_code ?? 200,
  );
  const status = Number.isInteger(statusCode) && statusCode >= 100
    ? statusCode
    : 200;
  const body =
    frame?.payload !== undefined && frame?.payload !== null
      ? normalizeBodyBytes(frame.payload)
      : null;

  if (frame === null) {
    return new Response(null, {
      status:
        Number.isInteger(options.emptyStatus) && options.emptyStatus >= 100
          ? options.emptyStatus
          : 204,
      headers,
    });
  }

  return new Response(body, {
    status,
    headers,
  });
}

export function createInstalledFlowFetchHandler(options = {}) {
  const service = options.service ?? createInstalledFlowService(options);
  const requestMapper = options.requestMapper ?? normalizeFetchRequest;
  const responseMapper = options.responseMapper ?? createFetchResponse;

  const handler = async (request, context = {}) => {
    await service.start();
    const mappedRequest = await requestMapper(request, {
      ...options,
      context,
    });
    const result = await service.handleHttpRequest(mappedRequest);
    return responseMapper(result, {
      request,
      context,
      service,
      ...options,
    });
  };

  handler.service = service;
  handler.start = () => service.start();
  handler.stop = () => service.stop();

  return handler;
}

export default {
  createFetchResponse,
  createInstalledFlowFetchHandler,
  normalizeFetchRequest,
};
