import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import EmbeddedEditorAssets from "./embeddedAssets.generated.js";
import {
  NodeRedEditorLocales,
  NodeRedIconSets,
  NodeRedNodeConfigs,
  NodeRedNodeMessages,
  NodeRedNodeSets,
} from "./nodeRedRegistry.generated.js";
import {
  createSdnFlowEditorCompilePreviewInSubprocess,
} from "./compilePreviewSubprocess.js";
import { normalizeSdnFlowEditorInitialFlows } from "./flowFormat.js";
import {
  createFetchResponse,
  normalizeFetchRequest,
} from "../host/fetchService.js";

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
      "access-control-allow-origin": "*",
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "access-control-allow-origin": "*",
      "content-type": "text/plain; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function binaryResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "access-control-allow-origin": "*",
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

function decodeAssetBody(asset) {
  if (asset.encoding === "base64") {
    return Uint8Array.from(Buffer.from(asset.body, "base64"));
  }
  return asset.body;
}

function renderIndexHtml(asset, title) {
  const html = String(asset?.body ?? "");
  return html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(target, source) {
  if (!isPlainObject(source)) {
    return target;
  }
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value)) {
      const existing = isPlainObject(target[key]) ? target[key] : {};
      target[key] = mergeObjects({ ...existing }, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function formatErrorMessage(error) {
  if (typeof error?.stack === "string" && error.stack.trim().length > 0) {
    return error.stack;
  }
  if (typeof error?.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function readRequestJson(request) {
  const text = await request.text();
  if (!text || text.trim().length === 0) {
    return null;
  }
  return JSON.parse(text);
}

async function readRequestState(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await readRequestJson(request);
    return normalizeString(payload?.state, null);
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return normalizeString(formData.get("state"), null);
  }
  const text = await request.text();
  if (!text || text.trim().length === 0) {
    return null;
  }
  const params = new URLSearchParams(text);
  return normalizeString(params.get("state"), null);
}

async function readRequestNodeIds(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await readRequestJson(request);
    return Array.isArray(payload?.nodes)
      ? payload.nodes.map((value) => normalizeString(value, null)).filter(Boolean)
      : [];
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return [...formData.getAll("nodes"), ...formData.getAll("nodes[]")]
      .map((value) => normalizeString(value, null))
      .filter(Boolean);
  }
  const text = await request.text();
  if (!text || text.trim().length === 0) {
    return [];
  }
  const params = new URLSearchParams(text);
  return [...params.getAll("nodes"), ...params.getAll("nodes[]")]
    .map((value) => normalizeString(value, null))
    .filter(Boolean);
}

function buildBootstrapConfig(options = {}, flowState, runtimeStatus) {
  const basePath = normalizeSdnFlowEditorBasePath(options.basePath);
  return {
    title: options.title ?? "sdn-flow Editor",
    engineLabel: options.engineLabel ?? "sdn-flow editor",
    initialFlow: structuredClone(flowState.flows),
    runtimeStatus,
    api: {
      bootstrapUrl: joinBasePath(basePath, "/api/bootstrap"),
      compilePreviewUrl: joinBasePath(basePath, "/api/compile-preview"),
      runtimeStatusUrl: joinBasePath(basePath, "/api/runtime-status"),
      runtimeArtifactUrl: joinBasePath(basePath, "/api/runtime-artifact"),
      runtimeSettingsUrl: joinBasePath(basePath, "/api/runtime-settings"),
      archivesUrl: joinBasePath(basePath, "/api/archives"),
      downloadWasmUrl: joinBasePath(basePath, "/api/download/wasm"),
      downloadExecutableUrl: joinBasePath(basePath, "/api/download/executable"),
    },
  };
}

function detectPreferredLanguage(request) {
  const acceptLanguage = request.headers.get("accept-language") ?? "";
  if (/\ben-US\b/i.test(acceptLanguage)) {
    return "en-US";
  }
  return "en-US";
}

function getSettingsPayload(options, runtimeStatus) {
  const startup = runtimeStatus?.startup ?? {};
  return {
    httpNodeRoot: startup.basePath ?? "/",
    version: options.version ?? "0.2.0",
    user: {
      anonymous: false,
      username: "sdn-flow",
      permissions: "*",
    },
    context: {
      default: "memory",
      stores: [
        {
          value: "memory",
          label: "memory",
        },
      ],
    },
    libraries: [],
    paletteCategories: ["common", "function", "network", "sequence", "parsers", "storage"],
    flowFilePretty: true,
    externalModules: {
      palette: {
        allowInstall: false,
        allowUpload: false,
      },
    },
    diagnostics: {
      enabled: false,
      ui: false,
    },
    telemetryEnabled: false,
    runtimeState: {
      enabled: true,
      ui: true,
    },
    sdnFlow: {
      runtime: startup,
      activeRuntime: runtimeStatus?.activeStartup ?? startup,
      security: runtimeStatus?.security ?? null,
      activeSecurity: runtimeStatus?.activeSecurity ?? null,
      securityStatus: runtimeStatus?.securityStatus ?? null,
      restartUrl: runtimeStatus?.restartUrl ?? null,
    },
    editorTheme: {
      tours: false,
      languages: ["en-US"],
      projects: {
        enabled: false,
      },
      codeEditor: {
        lib: "ace",
        options: {},
      },
      palette: {
        editable: false,
        upload: false,
        catalogues: [],
      },
      deployButton: {
        type: "default",
        label: "Compile",
        icon: "red/images/deploy-full-o.svg",
      },
      menu: {
        "menu-item-import-library": false,
        "menu-item-export-library": false,
        "menu-item-help": false,
        "menu-item-keyboard-shortcuts": false,
        "menu-item-node-red-version": false,
      },
      sdnFlow: runtimeStatus,
    },
  };
}

function getThemePayload(options) {
  return {
    header: {
      title: options.title ?? "sdn-flow Editor",
      url: "https://github.com/DigitalArsenal/sdn-flow",
    },
  };
}

function createFlowState(initialFlow) {
  return {
    rev: `rev-${Date.now().toString(36)}`,
    flows: normalizeSdnFlowEditorInitialFlows(initialFlow),
  };
}

function resolveInitialEditorFlows(initialFlow, runtimeManager) {
  if (initialFlow !== undefined && initialFlow !== null) {
    return initialFlow;
  }
  const activeBuild =
    runtimeManager &&
    typeof runtimeManager.getActiveBuild === "function"
      ? runtimeManager.getActiveBuild()
      : null;
  if (Array.isArray(activeBuild?.flows) && activeBuild.flows.length > 0) {
    return activeBuild.flows;
  }
  return initialFlow;
}

function buildNodeConfigResponse() {
  return Object.values(NodeRedNodeConfigs).join("\n");
}

function createEmbeddedAssetResponse(route, asset, request, options) {
  const body =
    route === "/" || route === "/index.html"
      ? renderIndexHtml(asset, options.title ?? "sdn-flow Editor")
      : decodeAssetBody(asset);

  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "access-control-allow-origin": "*",
      "content-type": asset.contentType,
      "cache-control": "no-store",
    },
  });
}

async function tryHandleRuntimeHttpRequest(runtimeManager, request, requestUrl, route, basePath) {
  if (!runtimeManager || typeof runtimeManager.handleHttpRequest !== "function") {
    return null;
  }

  const mappedRequest = await normalizeFetchRequest(request, {
    baseUrl: requestUrl.origin,
    metadata: {
      originalUrl: requestUrl.href,
      basePath,
    },
  });

  try {
    const runtimeResult = await runtimeManager.handleHttpRequest({
      ...mappedRequest,
      path: route || "/",
      metadata: {
        ...(mappedRequest.metadata ?? {}),
        originalUrl: requestUrl.href,
        basePath,
      },
    });
    return createFetchResponse(runtimeResult, {
      request,
    });
  } catch (error) {
    if (error?.code === "SDN_FLOW_HTTP_TRIGGER_NOT_FOUND") {
      return null;
    }
    return textResponse(formatErrorMessage(error), {
      status: Number.isInteger(error?.status) ? error.status : 500,
    });
  }
}

export function listSdnFlowEditorEmbeddedAssets() {
  return Object.keys(EmbeddedEditorAssets);
}

export function createSdnFlowEditorFetchHandler(options = {}) {
  const basePath = normalizeSdnFlowEditorBasePath(options.basePath);
  const userSettings = {};
  const compilePreviewFactory =
    options.compilePreviewFactory ?? createSdnFlowEditorCompilePreviewInSubprocess;
  const runtimeManager =
    options.runtimeManager ??
    {
      getRuntimeStatus() {
        return {
          runtimeId: "runtime-static",
          flowState: "start",
          startup: {
            hostname: "127.0.0.1",
            port: 1990,
            basePath: "/",
            title: "sdn-flow Editor",
          },
          artifactArchiveLimit: 100,
          compilePending: false,
          compileId: null,
        };
      },
      getStartupSettings() {
        return {
          hostname: "127.0.0.1",
          port: 1990,
          basePath: "/",
          title: "sdn-flow Editor",
        };
      },
      getFlowState() {
        return "start";
      },
      async updateStartupSettings() {
        const startup = this.getStartupSettings();
        return {
          startup,
          activeStartup: startup,
          restartUrl: "http://127.0.0.1:1990/",
          artifactArchiveLimit: 100,
        };
      },
      setFlowState(state) {
        return {
          state,
        };
      },
      async listArchives() {
        return [];
      },
      async deleteArchive(id) {
        return {
          deleted: true,
          id,
        };
      },
      getActiveBuild() {
        return null;
      },
      async readActiveArtifactWasm() {
        return null;
      },
      getTargetExecutablePath() {
        return null;
      },
      async dispatchInject(nodeId) {
        return {
          injected: true,
          nodeId,
        };
      },
      setDebugNodeState(nodeIds, active) {
        return {
          ok: true,
          nodes: Array.isArray(nodeIds) ? nodeIds : [],
          active: active !== false,
        };
      },
      async scheduleCompile() {
        return {
          compileId: null,
          restartPending: false,
        };
      },
    };
  const flowState = createFlowState(resolveInitialEditorFlows(options.initialFlow, runtimeManager));

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

    const runtimeStatus = runtimeManager.getRuntimeStatus();

    if (route === "/api/bootstrap" && request.method === "GET") {
      return jsonResponse(buildBootstrapConfig(options, flowState, runtimeStatus));
    }

    if (route === "/api/compile-preview" && request.method === "GET") {
      try {
        return jsonResponse(
          await compilePreviewFactory(flowState.flows, {
            request,
            requestUrl,
            basePath,
            cwd: runtimeManager.runtimePaths?.projectRoot,
            projectRoot: runtimeManager.runtimePaths?.projectRoot,
          }),
        );
      } catch (error) {
        return jsonResponse(
          {
            message: formatErrorMessage(error),
          },
          { status: 500 },
        );
      }
    }

    if (route === "/api/compile-preview" && request.method === "POST") {
      const payload = (await readRequestJson(request)) ?? {};
      const previewFlows = normalizeSdnFlowEditorInitialFlows(payload?.flows ?? flowState.flows);
      try {
        return jsonResponse(
          await compilePreviewFactory(previewFlows, {
            request,
            requestUrl,
            basePath,
            cwd: runtimeManager.runtimePaths?.projectRoot,
            projectRoot: runtimeManager.runtimePaths?.projectRoot,
          }),
        );
      } catch (error) {
        return jsonResponse(
          {
            message: formatErrorMessage(error),
          },
          { status: 500 },
        );
      }
    }

    if (route === "/api/runtime-status" && request.method === "GET") {
      return jsonResponse(runtimeStatus);
    }

    if (route === "/api/runtime-artifact" && request.method === "GET") {
      return jsonResponse({
        build: runtimeManager.getActiveBuild?.() ?? null,
        status: runtimeStatus.activeBuild ?? null,
      });
    }

    if (route === "/api/runtime-settings" && request.method === "GET") {
      return jsonResponse({
        startup: runtimeManager.getStartupSettings(),
        activeStartup: runtimeStatus.activeStartup ?? runtimeStatus.startup ?? null,
        security:
          runtimeManager.getSecuritySettings?.() ??
          runtimeStatus.security ??
          null,
        activeSecurity: runtimeStatus.activeSecurity ?? null,
        securityStatus: runtimeStatus.securityStatus ?? null,
        restartUrl: runtimeStatus.restartUrl ?? null,
        artifactArchiveLimit: runtimeStatus.artifactArchiveLimit ?? 100,
      });
    }

    if (route === "/api/download/wasm" && request.method === "GET") {
      const wasmBytes = await runtimeManager.readActiveArtifactWasm?.();
      const activeBuild = runtimeManager.getActiveBuild?.();
      if (!(wasmBytes instanceof Uint8Array) || wasmBytes.length === 0) {
        return textResponse("No compiled wasm artifact is available.", { status: 404 });
      }
      const downloadName = `${activeBuild?.outputName ?? "sdn-flow-flow-runtime"}.wasm`;
      return binaryResponse(wasmBytes, {
        headers: {
          "content-type": "application/wasm",
          "content-disposition": `attachment; filename="${downloadName}"`,
          "content-length": String(wasmBytes.byteLength),
        },
      });
    }

    if (route === "/api/download/executable" && request.method === "GET") {
      const executablePath = runtimeManager.getTargetExecutablePath?.() ?? null;
      if (!executablePath) {
        return textResponse("No standalone executable is available.", { status: 404 });
      }
      try {
        const executableBytes = await fs.readFile(executablePath);
        return binaryResponse(executableBytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${path.basename(executablePath)}"`,
            "content-length": String(executableBytes.byteLength),
          },
        });
      } catch (error) {
        if (error?.code === "ENOENT") {
          return textResponse("No standalone executable is available.", { status: 404 });
        }
        throw error;
      }
    }

    if (route === "/api/runtime-settings" && request.method === "POST") {
      const payload = (await readRequestJson(request)) ?? {};
      return jsonResponse(await runtimeManager.updateStartupSettings(payload));
    }

    if (route === "/api/archives" && request.method === "GET") {
      return jsonResponse(await runtimeManager.listArchives());
    }

    if (route.startsWith("/api/archives/") && request.method === "DELETE") {
      const archiveId = decodeURIComponent(route.slice("/api/archives/".length));
      return jsonResponse(await runtimeManager.deleteArchive(archiveId));
    }

    if (route === "/api/export" && request.method === "POST") {
      if (typeof options.onExport !== "function") {
        return textResponse("Export hook not configured", { status: 404 });
      }
      const payload = await readRequestJson(request);
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
      const payload = await readRequestJson(request);
      const result = await options.onDeploy(payload, {
        request,
        requestUrl,
        basePath,
      });
      return result instanceof Response
        ? result
        : jsonResponse(result ?? { ok: true }, { status: 200 });
    }

    if (route === "/theme" && request.method === "GET") {
      return jsonResponse(getThemePayload(options));
    }

    if (route === "/settings" && request.method === "GET") {
      return jsonResponse(getSettingsPayload(options, runtimeStatus));
    }

    if (route === "/settings/user" && request.method === "GET") {
      return jsonResponse(
        mergeObjects(structuredClone(userSettings), {
          sdnFlow: {
            runtime: runtimeManager.getStartupSettings(),
            security:
              runtimeManager.getSecuritySettings?.() ??
              runtimeStatus.security ??
              null,
          },
        }),
      );
    }

    if (route === "/settings/user" && request.method === "POST") {
      const payload = (await readRequestJson(request)) ?? {};
      mergeObjects(userSettings, payload);
      if (payload?.sdnFlow?.runtime) {
        await runtimeManager.updateStartupSettings(payload.sdnFlow.runtime);
      }
      return jsonResponse({ ok: true });
    }

    if (route === "/settings/user/keys" && request.method === "GET") {
      return jsonResponse([]);
    }

    if (route === "/plugins" && request.method === "GET") {
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/json")) {
        return jsonResponse([]);
      }
      return new Response("", {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (route === "/plugins/messages" && request.method === "GET") {
      return jsonResponse({});
    }

    if (route === "/nodes" && request.method === "GET") {
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/json")) {
        return jsonResponse(NodeRedNodeSets);
      }
      return new Response(buildNodeConfigResponse(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (route === "/nodes/messages" && request.method === "GET") {
      return jsonResponse(NodeRedNodeMessages);
    }

    if (route.startsWith("/nodes/") && route.endsWith("/messages") && request.method === "GET") {
      const namespace = route.slice("/nodes/".length, -"/messages".length);
      return jsonResponse(NodeRedNodeMessages[namespace] ?? {});
    }

    if (route === "/icons" && request.method === "GET") {
      return jsonResponse(NodeRedIconSets);
    }

    if (route === "/flows" && request.method === "GET") {
      return jsonResponse({
        rev: flowState.rev,
        flows: flowState.flows,
      });
    }

    if (route === "/flows" && request.method === "POST") {
      const payload = await readRequestJson(request);
      flowState.flows = normalizeSdnFlowEditorInitialFlows(payload?.flows ?? flowState.flows);
      flowState.rev = `rev-${Date.now().toString(36)}`;
      const compileResult = await runtimeManager.scheduleCompile(flowState.flows);
      const headers =
        compileResult?.restartPending === true
          ? {
              "x-sdn-flow-compile-pending": "1",
              "x-sdn-flow-restart-pending": "1",
              "x-sdn-flow-restart-url":
                compileResult?.restartUrl ?? runtimeManager.getRuntimeStatus().restartUrl ?? "",
            }
          : {
              "x-sdn-flow-compile-pending": "1",
            };
      return jsonResponse(
        {
          rev: flowState.rev,
          compileId: compileResult?.compileId ?? null,
          restartPending: compileResult?.restartPending === true,
          restartUrl: compileResult?.restartUrl ?? runtimeManager.getRuntimeStatus().restartUrl ?? null,
        },
        {
          headers,
        },
      );
    }

    if (route === "/flows/state" && request.method === "GET") {
      return jsonResponse({
        state: runtimeManager.getFlowState(),
      });
    }

    if (route === "/flows/state" && request.method === "POST") {
      const nextState = await readRequestState(request);
      return jsonResponse(runtimeManager.setFlowState(nextState, { deploy: false }));
    }

    if (/^\/inject\/[^/]+$/.test(route) && request.method === "POST") {
      if (runtimeManager.getFlowState() !== "start") {
        return jsonResponse(
          {
            message: "Flows are stopped.",
          },
          { status: 409 },
        );
      }
      const nodeId = decodeURIComponent(route.slice("/inject/".length));
      const injectPayload = (await readRequestJson(request)) ?? null;
      try {
        return jsonResponse(await runtimeManager.dispatchInject(nodeId, injectPayload));
      } catch (error) {
        return jsonResponse(
          {
            message: formatErrorMessage(error),
          },
          { status: 409 },
        );
      }
    }

    if (
      (route === "/debug/enable" || route === "/debug/disable") &&
      request.method === "POST"
    ) {
      const nodeIds = await readRequestNodeIds(request);
      return jsonResponse(
        runtimeManager.setDebugNodeState(nodeIds, route.endsWith("/enable")),
        { status: route.endsWith("/disable") ? 201 : 200 },
      );
    }

    if (/^\/debug\/[^/]+\/(enable|disable)$/.test(route) && request.method === "POST") {
      const segments = route.split("/");
      const nodeId = decodeURIComponent(segments[2] ?? "");
      return jsonResponse(
        runtimeManager.setDebugNodeState([nodeId], route.endsWith("/enable")),
        { status: route.endsWith("/disable") ? 201 : 200 },
      );
    }

    if (route.startsWith("/locales/") && request.method === "GET") {
      const namespace = route.slice("/locales/".length);
      const language = detectPreferredLanguage(request);
      const catalog = language === "en-US" ? NodeRedEditorLocales[namespace] ?? {} : {};
      return jsonResponse(catalog);
    }

    const asset = EmbeddedEditorAssets[route];
    if ((request.method === "GET" || request.method === "HEAD") && asset) {
      return createEmbeddedAssetResponse(route, asset, request, options);
    }

    const runtimeHttpResponse = await tryHandleRuntimeHttpRequest(
      runtimeManager,
      request,
      requestUrl,
      route,
      basePath,
    );
    if (runtimeHttpResponse) {
      return runtimeHttpResponse;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "GET, HEAD, POST, DELETE",
        },
      });
    }

    if (!asset) {
      return textResponse("Not Found", { status: 404 });
    }
    return createEmbeddedAssetResponse(route, asset, request, options);
  };
}

export default {
  createSdnFlowEditorFetchHandler,
  listSdnFlowEditorEmbeddedAssets,
  normalizeSdnFlowEditorBasePath,
};
