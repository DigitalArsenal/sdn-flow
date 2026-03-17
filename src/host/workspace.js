import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeProgram } from "../runtime/index.js";
import {
  createInstalledFlowFetchHandler,
} from "./fetchService.js";
import {
  createInstalledFlowService,
  discoverInstalledPluginPackages,
  normalizeInstalledPluginPackage,
} from "./installedFlowHost.js";
import { normalizeHostedRuntimePlan } from "./normalize.js";

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

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value, null))
        .filter((value) => value !== null),
    ),
  );
}

function resolvePathLike(value, baseDirectory) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return null;
  }
  return path.resolve(baseDirectory ?? process.cwd(), normalized);
}

function relativizePathLike(value, baseDirectory) {
  if (!value) {
    return null;
  }
  return path.relative(baseDirectory, value) || ".";
}

function normalizeMetadata(value) {
  return isObject(value) ? { ...value } : {};
}

function normalizeWorkspacePluginPackage(pluginPackage = {}, baseDirectory = null) {
  const normalizedPackage = normalizeInstalledPluginPackage(pluginPackage);
  return {
    ...normalizedPackage,
    packageRoot: resolvePathLike(
      pluginPackage.packageRoot ?? normalizedPackage.packageRoot,
      baseDirectory,
    ),
    manifestPath: resolvePathLike(
      pluginPackage.manifestPath ?? normalizedPackage.manifestPath,
      baseDirectory,
    ),
    modulePath: resolvePathLike(
      pluginPackage.modulePath ?? normalizedPackage.modulePath,
      baseDirectory,
    ),
  };
}

function serializeWorkspacePluginPackage(pluginPackage, baseDirectory) {
  return {
    packageId: pluginPackage.packageId,
    packageName: pluginPackage.packageName,
    pluginId: pluginPackage.pluginId,
    packageRoot: relativizePathLike(pluginPackage.packageRoot, baseDirectory),
    manifestPath: relativizePathLike(pluginPackage.manifestPath, baseDirectory),
    modulePath: relativizePathLike(pluginPackage.modulePath, baseDirectory),
    runtimeTargets: pluginPackage.runtimeTargets,
    capabilities: pluginPackage.capabilities,
    startupPhase: pluginPackage.startupPhase,
    autoStart: pluginPackage.autoStart,
    metadata: pluginPackage.metadata,
  };
}

async function resolveWorkspacePluginPackageInput(
  pluginPackage,
  baseDirectory,
) {
  const normalizedPackage = normalizeWorkspacePluginPackage(
    pluginPackage,
    baseDirectory,
  );
  if (
    normalizedPackage.manifestPath ||
    normalizedPackage.modulePath ||
    normalizedPackage.manifest ||
    normalizedPackage.module ||
    normalizedPackage.handlers
  ) {
    return normalizedPackage;
  }
  if (!normalizedPackage.packageRoot) {
    return normalizedPackage;
  }

  const discoveredPackages = await discoverInstalledPluginPackages({
    rootDirectories: [normalizedPackage.packageRoot],
  });
  const discoveredPackage =
    discoveredPackages.find(
      (item) =>
        item.pluginId === normalizedPackage.pluginId ||
        item.packageId === normalizedPackage.packageId,
    ) ??
    (discoveredPackages.length === 1 ? discoveredPackages[0] : null);

  if (!discoveredPackage) {
    throw new Error(
      `Could not resolve an installed plugin package from "${normalizedPackage.packageRoot}".`,
    );
  }

  return normalizeWorkspacePluginPackage(
    {
      ...discoveredPackage,
      ...pluginPackage,
      packageRoot:
        pluginPackage.packageRoot ?? discoveredPackage.packageRoot,
      manifestPath:
        pluginPackage.manifestPath ?? discoveredPackage.manifestPath,
      modulePath: pluginPackage.modulePath ?? discoveredPackage.modulePath,
    },
    baseDirectory,
  );
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function normalizeInstalledFlowWorkspace(workspace = {}, options = {}) {
  const baseDirectory = path.resolve(
    normalizeString(
      options.baseDirectory ??
        workspace.baseDirectory ??
        workspace.workspaceRoot ??
        process.cwd(),
      process.cwd(),
    ),
  );
  const program =
    workspace.program && isObject(workspace.program)
      ? normalizeProgram(workspace.program)
      : null;
  const hostPlan =
    workspace.hostPlan && isObject(workspace.hostPlan)
      ? normalizeHostedRuntimePlan(workspace.hostPlan)
      : null;
  const flowPath = resolvePathLike(
    workspace.flowPath ?? workspace.programPath,
    baseDirectory,
  );
  const hostPlanPath = resolvePathLike(workspace.hostPlanPath, baseDirectory);
  const pluginRootDirectories = normalizeStringArray(
    workspace.pluginRootDirectories ?? workspace.rootDirectories,
  ).map((directory) => resolvePathLike(directory, baseDirectory));
  const pluginPackages = Array.isArray(workspace.pluginPackages)
    ? workspace.pluginPackages.map((pluginPackage) =>
        normalizeWorkspacePluginPackage(pluginPackage, baseDirectory),
      )
    : [];

  return {
    workspaceId:
      normalizeString(
        workspace.workspaceId ?? workspace.id ?? workspace.name,
        null,
      ) ?? "installed-flow-workspace",
    description: normalizeString(workspace.description, null),
    baseDirectory,
    flowPath,
    hostPlanPath,
    pluginRootDirectories,
    pluginPackages,
    moduleCandidates: normalizeStringArray(workspace.moduleCandidates),
    discover: workspace.discover !== false,
    adapter: normalizeString(workspace.adapter ?? hostPlan?.adapter, null),
    engine: normalizeString(workspace.engine ?? hostPlan?.engine, null),
    program,
    hostPlan,
    fetch: normalizeMetadata(workspace.fetch),
    service: normalizeMetadata(workspace.service),
    metadata: normalizeMetadata(workspace.metadata),
  };
}

export async function resolveInstalledFlowWorkspace(workspace = {}, options = {}) {
  const normalizedWorkspace = normalizeInstalledFlowWorkspace(workspace, options);
  let program = normalizedWorkspace.program;
  let hostPlan = normalizedWorkspace.hostPlan;

  if (!program && normalizedWorkspace.flowPath) {
    program = normalizeProgram(await readJsonFile(normalizedWorkspace.flowPath));
  }
  if (!hostPlan && normalizedWorkspace.hostPlanPath) {
    hostPlan = normalizeHostedRuntimePlan(
      await readJsonFile(normalizedWorkspace.hostPlanPath),
    );
  }

  return {
    ...normalizedWorkspace,
    adapter: normalizedWorkspace.adapter ?? hostPlan?.adapter ?? null,
    engine: normalizedWorkspace.engine ?? hostPlan?.engine ?? null,
    program,
    hostPlan,
  };
}

export async function readInstalledFlowWorkspace(workspacePath, options = {}) {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspace = await readJsonFile(resolvedWorkspacePath);
  return resolveInstalledFlowWorkspace(workspace, {
    ...options,
    baseDirectory: path.dirname(resolvedWorkspacePath),
    workspacePath: resolvedWorkspacePath,
  });
}

export async function writeInstalledFlowWorkspace(workspacePath, workspace, options = {}) {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const baseDirectory = path.dirname(resolvedWorkspacePath);
  const normalizedWorkspace = normalizeInstalledFlowWorkspace(workspace, {
    ...options,
    baseDirectory,
  });
  const payload = {
    workspaceId: normalizedWorkspace.workspaceId,
    description: normalizedWorkspace.description,
    flowPath: relativizePathLike(normalizedWorkspace.flowPath, baseDirectory),
    hostPlanPath: relativizePathLike(
      normalizedWorkspace.hostPlanPath,
      baseDirectory,
    ),
    pluginRootDirectories: normalizedWorkspace.pluginRootDirectories.map(
      (directory) => relativizePathLike(directory, baseDirectory),
    ),
    pluginPackages: normalizedWorkspace.pluginPackages.map((pluginPackage) =>
      serializeWorkspacePluginPackage(pluginPackage, baseDirectory),
    ),
    moduleCandidates: normalizedWorkspace.moduleCandidates,
    discover: normalizedWorkspace.discover,
    adapter: normalizedWorkspace.adapter,
    engine: normalizedWorkspace.engine,
    fetch: normalizedWorkspace.fetch,
    service: normalizedWorkspace.service,
    metadata: normalizedWorkspace.metadata,
  };

  if (normalizedWorkspace.program) {
    payload.program = normalizedWorkspace.program;
  }
  if (normalizedWorkspace.hostPlan) {
    payload.hostPlan = normalizedWorkspace.hostPlan;
  }

  await mkdir(baseDirectory, { recursive: true });
  await writeFile(
    resolvedWorkspacePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return resolvedWorkspacePath;
}

export async function installWorkspacePluginPackage(
  workspace,
  pluginPackage,
  options = {},
) {
  const normalizedWorkspace = await resolveInstalledFlowWorkspace(
    workspace,
    options,
  );
  const resolvedPackage = await resolveWorkspacePluginPackageInput(
    pluginPackage,
    normalizedWorkspace.baseDirectory,
  );
  const packageKey =
    resolvedPackage.pluginId ??
    resolvedPackage.packageId ??
    resolvedPackage.manifestPath ??
    resolvedPackage.packageRoot;
  const pluginPackages = normalizedWorkspace.pluginPackages.filter((item) => {
    const itemKey =
      item.pluginId ?? item.packageId ?? item.manifestPath ?? item.packageRoot;
    return itemKey !== packageKey;
  });
  pluginPackages.push(resolvedPackage);
  pluginPackages.sort((left, right) =>
    `${left.packageName ?? ""}:${left.pluginId ?? left.packageId}`.localeCompare(
      `${right.packageName ?? ""}:${right.pluginId ?? right.packageId}`,
    ),
  );

  return {
    ...normalizedWorkspace,
    pluginPackages,
  };
}

export async function uninstallWorkspacePluginPackage(
  workspace,
  selector,
  options = {},
) {
  const normalizedWorkspace = await resolveInstalledFlowWorkspace(
    workspace,
    options,
  );
  const normalizedSelector = isObject(selector)
    ? {
        pluginId: normalizeString(selector.pluginId, null),
        packageId: normalizeString(selector.packageId, null),
        packageRoot: resolvePathLike(selector.packageRoot, normalizedWorkspace.baseDirectory),
        manifestPath: resolvePathLike(selector.manifestPath, normalizedWorkspace.baseDirectory),
        modulePath: resolvePathLike(selector.modulePath, normalizedWorkspace.baseDirectory),
      }
    : {
        pluginId: normalizeString(selector, null),
        packageId: normalizeString(selector, null),
        packageRoot: null,
        manifestPath: null,
        modulePath: null,
      };
  const pluginPackages = normalizedWorkspace.pluginPackages.filter((item) => {
    if (normalizedSelector.pluginId && item.pluginId === normalizedSelector.pluginId) {
      return false;
    }
    if (normalizedSelector.packageId && item.packageId === normalizedSelector.packageId) {
      return false;
    }
    if (
      normalizedSelector.packageRoot &&
      item.packageRoot === normalizedSelector.packageRoot
    ) {
      return false;
    }
    if (
      normalizedSelector.manifestPath &&
      item.manifestPath === normalizedSelector.manifestPath
    ) {
      return false;
    }
    if (
      normalizedSelector.modulePath &&
      item.modulePath === normalizedSelector.modulePath
    ) {
      return false;
    }
    return true;
  });

  return {
    ...normalizedWorkspace,
    pluginPackages,
  };
}

export async function createInstalledFlowApp(options = {}) {
  const workspacePath = normalizeString(options.workspacePath, null)
    ? path.resolve(options.workspacePath)
    : null;
  let workspace =
    options.workspace !== undefined
      ? await resolveInstalledFlowWorkspace(options.workspace, options)
      : workspacePath
        ? await readInstalledFlowWorkspace(workspacePath, options)
        : await resolveInstalledFlowWorkspace({}, options);

  const service = createInstalledFlowService({
    program: workspace.program,
    pluginRootDirectories: workspace.pluginRootDirectories,
    pluginPackages: workspace.pluginPackages,
    discover: workspace.discover,
    moduleCandidates:
      workspace.moduleCandidates.length > 0
        ? workspace.moduleCandidates
        : undefined,
    ...(workspace.service ?? {}),
    ...(options.serviceOptions ?? {}),
    importModule: options.importModule,
    context: options.context ?? null,
    runtimeOptions: options.runtimeOptions,
    onSinkOutput: options.onSinkOutput,
  });
  const fetchHandler = async (request, context = {}) =>
    createInstalledFlowFetchHandler({
      service,
      ...(workspace.fetch ?? {}),
      ...(options.fetchOptions ?? {}),
    })(request, context);
  fetchHandler.service = service;
  fetchHandler.start = () => service.start();
  fetchHandler.stop = () => service.stop();

  async function reloadWorkspace(reloadOptions = {}) {
    if (!workspacePath) {
      return workspace;
    }
    workspace = await readInstalledFlowWorkspace(workspacePath, {
      ...options,
      ...reloadOptions,
    });
    return workspace;
  }

  return {
    workspacePath,
    host: service.host,
    service,
    fetchHandler,
    getWorkspace() {
      return workspace;
    },
    getSummary() {
      return {
        workspaceId: workspace.workspaceId,
        programId: workspace.program?.programId ?? null,
        adapter: workspace.adapter,
        engine: workspace.engine,
        pluginRootDirectories: workspace.pluginRootDirectories,
        hostId: workspace.hostPlan?.hostId ?? null,
      };
    },
    async start() {
      const startup = await service.start();
      return {
        ...startup,
        workspace: this.getSummary(),
      };
    },
    stop() {
      return service.stop();
    },
    async refresh(refreshOptions = {}) {
      if (refreshOptions.reloadWorkspace !== false && workspacePath) {
        await reloadWorkspace(refreshOptions);
      }
      const refreshResult = await service.refresh({
        ...refreshOptions,
        program: workspace.program,
        pluginRootDirectories: workspace.pluginRootDirectories,
        pluginPackages: workspace.pluginPackages,
        discover: workspace.discover,
        moduleCandidates:
          workspace.moduleCandidates.length > 0
            ? workspace.moduleCandidates
            : undefined,
      });
      return {
        ...refreshResult,
        workspace: this.getSummary(),
      };
    },
    async reloadWorkspace(reloadOptions = {}) {
      return reloadWorkspace(reloadOptions);
    },
    async save(saveOptions = {}) {
      if (!workspacePath) {
        throw new Error(
          "Installed flow app cannot save workspace state without workspacePath.",
        );
      }
      return writeInstalledFlowWorkspace(workspacePath, workspace, saveOptions);
    },
    async installPluginPackage(pluginPackage, installOptions = {}) {
      workspace = await installWorkspacePluginPackage(
        workspace,
        pluginPackage,
        installOptions,
      );
      if (workspacePath && installOptions.save !== false) {
        await writeInstalledFlowWorkspace(workspacePath, workspace, installOptions);
      }
      if (installOptions.refresh === false) {
        return workspace;
      }
      return this.refresh({
        ...installOptions,
        reloadWorkspace: workspacePath ? installOptions.save !== false : false,
      });
    },
    async uninstallPluginPackage(selector, uninstallOptions = {}) {
      workspace = await uninstallWorkspacePluginPackage(
        workspace,
        selector,
        uninstallOptions,
      );
      if (workspacePath && uninstallOptions.save !== false) {
        await writeInstalledFlowWorkspace(
          workspacePath,
          workspace,
          uninstallOptions,
        );
      }
      if (uninstallOptions.refresh === false) {
        return workspace;
      }
      return this.refresh({
        ...uninstallOptions,
        reloadWorkspace: workspacePath ? uninstallOptions.save !== false : false,
      });
    },
  };
}

export default {
  createInstalledFlowApp,
  installWorkspacePluginPackage,
  normalizeInstalledFlowWorkspace,
  readInstalledFlowWorkspace,
  resolveInstalledFlowWorkspace,
  uninstallWorkspacePluginPackage,
  writeInstalledFlowWorkspace,
};
