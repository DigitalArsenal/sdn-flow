import { listInstalledFlowHttpBindings } from "./appHost.js";
import { createInstalledFlowApp } from "./workspace.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function resolveRequestUrl(request) {
  if (request instanceof Request) {
    return new URL(request.url);
  }
  const requestUrl = normalizeString(request?.url, null);
  if (!requestUrl) {
    throw new Error("Browser fetch host requires a Request or request-like object with url.");
  }
  return new URL(requestUrl);
}

export function matchesInstalledFlowHttpBindingRequest(bindingContext, request) {
  const requestUrl = resolveRequestUrl(request);
  const bindingUrl = new URL(bindingContext.binding.url);
  return requestUrl.pathname === bindingUrl.pathname;
}

export function createInstalledFlowBrowserFetchEventListener(options = {}) {
  const app = options.app;
  if (!app) {
    throw new Error(
      "createInstalledFlowBrowserFetchEventListener requires an installed flow app.",
    );
  }
  const bindingContexts =
    options.bindingContexts ??
    listInstalledFlowHttpBindings({
      workspace: app.getWorkspace(),
    });
  const handler = options.handler ?? app.fetchHandler;

  return function onFetch(event) {
    const request = event?.request ?? event;
    const bindingContext = bindingContexts.find((candidate) =>
      matchesInstalledFlowHttpBindingRequest(candidate, request),
    );
    if (!bindingContext) {
      return false;
    }
    const responsePromise = Promise.resolve(
      handler(request, {
        event,
        bindingContext,
      }),
    );
    if (typeof event?.respondWith === "function") {
      event.respondWith(responsePromise);
      return true;
    }
    return responsePromise;
  };
}

export async function startInstalledFlowBrowserFetchHost(options = {}) {
  const app = options.app ?? (await createInstalledFlowApp(options));
  const startup = await app.start();
  const bindingContexts = listInstalledFlowHttpBindings({
    workspace: app.getWorkspace(),
  });
  const listener = createInstalledFlowBrowserFetchEventListener({
    app,
    bindingContexts,
    handler: options.handler,
  });
  const addEventListenerFn =
    options.addEventListener ??
    globalThis.addEventListener?.bind(globalThis) ??
    null;
  const removeEventListenerFn =
    options.removeEventListener ??
    globalThis.removeEventListener?.bind(globalThis) ??
    null;

  if (typeof addEventListenerFn === "function") {
    addEventListenerFn("fetch", listener);
  }

  return {
    app,
    startup,
    bindingContexts,
    handler: app.fetchHandler,
    listener,
    stop() {
      if (typeof removeEventListenerFn === "function") {
        removeEventListenerFn("fetch", listener);
      }
      app.stop();
    },
  };
}

export default {
  createInstalledFlowBrowserFetchEventListener,
  matchesInstalledFlowHttpBindingRequest,
  startInstalledFlowBrowserFetchHost,
};
