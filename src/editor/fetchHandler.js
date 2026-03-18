import EmbeddedEditorAssets from "./embeddedAssets.generated.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function normalizeSdnFlowEditorBasePath(basePath = "/") {
  const normalized = normalizeString(basePath, "/") ?? "/";
  if (normalized === "/") {
    return "/";
  }
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function joinBasePath(basePath, route) {
  if (basePath === "/") {
    return route;
  }
  return `${basePath}${route}`;
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function resolveRequestRoute(requestPathname, basePath) {
  if (basePath === "/") {
    return requestPathname || "/";
  }
  if (requestPathname === basePath) {
    return "";
  }
  if (requestPathname.startsWith(`${basePath}/`)) {
    return requestPathname.slice(basePath.length);
  }
  return null;
}

function buildBootstrapConfig(options = {}) {
  const basePath = normalizeSdnFlowEditorBasePath(options.basePath);
  const bootstrap = {
    title: options.title ?? "sdn-flow Editor",
    engineLabel: options.engineLabel ?? "Portable runtime",
    initialFlow:
      options.initialFlow && typeof options.initialFlow === "object"
        ? structuredClone(options.initialFlow)
        : null,
    api: {},
    ...(options.bootstrap && typeof options.bootstrap === "object"
      ? structuredClone(options.bootstrap)
      : {}),
  };

  const bootstrapApi = {
    ...(bootstrap.api && typeof bootstrap.api === "object" ? bootstrap.api : {}),
  };

  if (typeof options.onExport === "function") {
    bootstrapApi.exportUrl = joinBasePath(basePath, "/api/export");
  }
  if (typeof options.onDeploy === "function") {
    bootstrapApi.deployUrl = joinBasePath(basePath, "/api/deploy");
  }

  bootstrap.api = bootstrapApi;
  return bootstrap;
}

export function listSdnFlowEditorEmbeddedAssets() {
  return Object.keys(EmbeddedEditorAssets);
}

export function createSdnFlowEditorFetchHandler(options = {}) {
  const basePath = normalizeSdnFlowEditorBasePath(options.basePath);
  const bootstrapFactory =
    typeof options.getBootstrap === "function"
      ? options.getBootstrap
      : () => buildBootstrapConfig(options);

  return async function handleEditorRequest(request) {
    const requestUrl = request instanceof Request ? new URL(request.url) : new URL(request.url);
    const route = resolveRequestRoute(requestUrl.pathname, basePath);

    if (route === null) {
      return textResponse("Not Found", { status: 404 });
    }

    if (route === "") {
      return Response.redirect(
        new URL(`${basePath === "/" ? "/" : `${basePath}/`}`, requestUrl),
        307,
      );
    }

    if (route === "/api/bootstrap" && request.method === "GET") {
      return jsonResponse(await bootstrapFactory({ request, requestUrl, basePath }));
    }

    if (route === "/api/export" && request.method === "POST") {
      if (typeof options.onExport !== "function") {
        return textResponse("Export hook not configured", { status: 404 });
      }
      const payload = await request.json();
      const result = await options.onExport(payload, {
        request,
        requestUrl,
        basePath,
      });
      return result instanceof Response
        ? result
        : jsonResponse(result ?? { ok: true }, { status: 200 });
    }

    if (route === "/api/deploy" && request.method === "POST") {
      if (typeof options.onDeploy !== "function") {
        return textResponse("Deploy hook not configured", { status: 404 });
      }
      const payload = await request.json();
      const result = await options.onDeploy(payload, {
        request,
        requestUrl,
        basePath,
      });
      return result instanceof Response
        ? result
        : jsonResponse(result ?? { ok: true }, { status: 200 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "GET, HEAD, POST",
        },
      });
    }

    const asset = EmbeddedEditorAssets[route];
    if (!asset) {
      return textResponse("Not Found", { status: 404 });
    }

    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "no-store",
      },
    });
  };
}

export default {
  createSdnFlowEditorFetchHandler,
  listSdnFlowEditorEmbeddedAssets,
  normalizeSdnFlowEditorBasePath,
};
