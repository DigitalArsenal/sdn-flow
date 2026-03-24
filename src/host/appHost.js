import { createInstalledFlowApp } from "./workspace.js";
import {
  HostedRuntimeBindingDirection,
  HostedRuntimeTransport,
} from "./constants.js";
import {
  describeHostedBindingDelegation,
  normalizeHostedRuntimePlan,
} from "./normalize.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function listInstalledFlowHttpBindings(options = {}) {
  const workspace = options.workspace ?? null;
  const rawHostPlan = options.hostPlan ?? workspace?.hostPlan ?? null;
  const hostPlan = rawHostPlan ? normalizeHostedRuntimePlan(rawHostPlan) : null;
  const programId =
    normalizeString(options.programId, null) ??
    normalizeString(workspace?.program?.programId, null);
  const runtimeBindings = [];

  for (const runtime of hostPlan?.runtimes ?? []) {
    if (programId && runtime.programId && runtime.programId !== programId) {
      continue;
    }
    for (const binding of runtime.bindings ?? []) {
      if (binding.direction !== HostedRuntimeBindingDirection.LISTEN) {
        continue;
      }
      if (binding.transport !== HostedRuntimeTransport.HTTP) {
        continue;
      }
      runtimeBindings.push({
        runtimeId: runtime.runtimeId,
        programId: runtime.programId ?? null,
        adapter: runtime.adapter ?? hostPlan?.adapter ?? null,
        engine: runtime.engine ?? hostPlan?.engine ?? null,
        ...describeHostedBindingDelegation({
          engine: runtime.engine ?? hostPlan?.engine ?? null,
          binding,
        }),
        binding,
      });
    }
  }

  return runtimeBindings;
}

function toListenerRecord(bindingContext, handle) {
  const close =
    typeof handle === "function"
      ? handle
      : typeof handle?.close === "function"
        ? handle.close.bind(handle)
        : async () => {};
  return {
    ...bindingContext,
    handle: handle ?? null,
    async close() {
      await close();
    },
  };
}

export async function startInstalledFlowAppHost(options = {}) {
  const app = options.app ?? (await createInstalledFlowApp(options));
  const startup = await app.start();
  const serveHttp = options.serveHttp ?? null;
  const bindingContexts = listInstalledFlowHttpBindings({
    workspace: app.getWorkspace(),
  });
  const listeners = [];

  if (typeof serveHttp === "function") {
    for (const bindingContext of bindingContexts) {
      const handle = await serveHttp({
        ...bindingContext,
        app,
        workspace: app.getWorkspace(),
        handler: app.fetchHandler,
      });
      listeners.push(toListenerRecord(bindingContext, handle));
    }
  }

  return {
    app,
    startup,
    listeners,
    listBindings() {
      return bindingContexts;
    },
    async stop() {
      for (const listener of listeners) {
        await listener.close();
      }
      app.stop();
    },
  };
}

export default {
  listInstalledFlowHttpBindings,
  startInstalledFlowAppHost,
};
