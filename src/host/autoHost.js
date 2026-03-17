import { HostedRuntimeEngine } from "./constants.js";
import {
  startInstalledFlowBrowserFetchHost,
} from "./browserHostAdapters.js";
import {
  startInstalledFlowBunHttpHost,
  startInstalledFlowDenoHttpHost,
  startInstalledFlowNodeHttpHost,
} from "./httpHostAdapters.js";
import { normalizeHostedRuntimeEngine } from "./profile.js";
import {
  readInstalledFlowWorkspace,
  resolveInstalledFlowWorkspace,
} from "./workspace.js";

function resolveGlobalEngineFallback(options = {}) {
  if (typeof globalThis.Bun?.serve === "function") {
    return HostedRuntimeEngine.BUN;
  }
  if (typeof globalThis.Deno?.serve === "function") {
    return HostedRuntimeEngine.DENO;
  }
  if (
    typeof options.addEventListener === "function" ||
    typeof globalThis.addEventListener === "function"
  ) {
    return HostedRuntimeEngine.BROWSER;
  }
  return HostedRuntimeEngine.NODE;
}

function resolveWorkspaceEngine(workspace = null) {
  return normalizeHostedRuntimeEngine(
    workspace?.engine ?? workspace?.hostPlan?.engine,
    null,
  );
}

export async function resolveInstalledFlowAutoHostEngine(options = {}) {
  const explicitEngine = normalizeHostedRuntimeEngine(options.engine, null);
  if (explicitEngine) {
    return explicitEngine;
  }

  if (typeof options.app?.getWorkspace === "function") {
    const appEngine = resolveWorkspaceEngine(options.app.getWorkspace());
    if (appEngine) {
      return appEngine;
    }
  }

  if (options.workspace !== undefined) {
    const workspace = await resolveInstalledFlowWorkspace(
      options.workspace,
      options,
    );
    const workspaceEngine = resolveWorkspaceEngine(workspace);
    if (workspaceEngine) {
      return workspaceEngine;
    }
  }

  if (typeof options.workspacePath === "string" && options.workspacePath.trim()) {
    const workspace = await readInstalledFlowWorkspace(options.workspacePath, options);
    const workspaceEngine = resolveWorkspaceEngine(workspace);
    if (workspaceEngine) {
      return workspaceEngine;
    }
  }

  return resolveGlobalEngineFallback(options);
}

export async function startInstalledFlowAutoHost(options = {}) {
  const engine = await resolveInstalledFlowAutoHostEngine(options);
  const startBrowserHost =
    options.startBrowserHost ?? startInstalledFlowBrowserFetchHost;
  const startDenoHost =
    options.startDenoHost ?? startInstalledFlowDenoHttpHost;
  const startBunHost =
    options.startBunHost ?? startInstalledFlowBunHttpHost;
  const startNodeHost =
    options.startNodeHost ?? startInstalledFlowNodeHttpHost;

  switch (engine) {
    case HostedRuntimeEngine.BROWSER:
      return startBrowserHost({
        ...options,
        engine,
      });
    case HostedRuntimeEngine.DENO:
      return startDenoHost({
        ...options,
        engine,
      });
    case HostedRuntimeEngine.BUN:
      return startBunHost({
        ...options,
        engine,
      });
    case HostedRuntimeEngine.NODE:
    default:
      return startNodeHost({
        ...options,
        engine,
      });
  }
}

export default {
  resolveInstalledFlowAutoHostEngine,
  startInstalledFlowAutoHost,
};
