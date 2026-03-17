import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import { findManifestFiles } from "../compliance/index.js";
import { FlowRuntime, MethodRegistry, normalizeManifest, normalizeProgram } from "../runtime/index.js";
import {
  HostedRuntimeAdapter,
  HostedRuntimeAuthority,
  HostedRuntimeEngine,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
} from "./constants.js";
import { normalizeHostedRuntimePlan } from "./normalize.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeString(value, null))
    .filter((value) => value !== null);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toSortedUniqueStrings(values) {
  return Array.from(new Set(normalizeStringArray(values))).sort();
}

function normalizeMetadata(value) {
  return isObject(value) ? { ...value } : {};
}

function resolveHandlerRecord(moduleExports, manifest, pluginPackage, options = {}) {
  if (isObject(pluginPackage.handlers)) {
    return pluginPackage.handlers;
  }
  if (typeof pluginPackage.createHandlers === "function") {
    return pluginPackage.createHandlers({
      manifest,
      pluginPackage,
      context: options.context ?? null,
    });
  }

  const defaultExport = moduleExports?.default;
  if (isObject(moduleExports?.handlers)) {
    return moduleExports.handlers;
  }
  if (typeof moduleExports?.createHandlers === "function") {
    return moduleExports.createHandlers({
      manifest,
      pluginPackage,
      context: options.context ?? null,
    });
  }
  if (isObject(defaultExport?.handlers)) {
    return defaultExport.handlers;
  }
  if (typeof defaultExport?.createHandlers === "function") {
    return defaultExport.createHandlers({
      manifest,
      pluginPackage,
      context: options.context ?? null,
    });
  }
  return null;
}

async function resolvePluginModule(pluginPackage, options = {}) {
  if (pluginPackage.module) {
    return pluginPackage.module;
  }
  if (!pluginPackage.modulePath) {
    return null;
  }
  const importModule =
    options.importModule ??
    (async (specifier) => import(specifier));
  return importModule(pathToFileURL(pluginPackage.modulePath).href);
}

export function normalizeInstalledPluginPackage(pluginPackage = {}) {
  const manifest =
    pluginPackage.manifest && isObject(pluginPackage.manifest)
      ? normalizeManifest(pluginPackage.manifest)
      : null;
  const packageRoot =
    normalizeString(pluginPackage.packageRoot, null) ??
    (pluginPackage.manifestPath
      ? path.dirname(path.resolve(pluginPackage.manifestPath))
      : null);
  const rawModulePath = normalizeString(pluginPackage.modulePath, null);
  const modulePath = rawModulePath
    ? path.resolve(packageRoot ?? process.cwd(), rawModulePath)
    : null;
  const manifestPath = normalizeString(pluginPackage.manifestPath, null)
    ? path.resolve(pluginPackage.manifestPath)
    : null;

  return {
    packageId:
      normalizeString(
        pluginPackage.packageId ??
          pluginPackage.packageName ??
          pluginPackage.pluginId ??
          manifest?.pluginId,
        null,
      ) ?? "plugin-package",
    packageName: normalizeString(
      pluginPackage.packageName ?? pluginPackage.packageJson?.name,
      null,
    ),
    pluginId: normalizeString(pluginPackage.pluginId ?? manifest?.pluginId, ""),
    packageRoot: packageRoot ? path.resolve(packageRoot) : null,
    manifestPath,
    modulePath,
    runtimeTargets: toSortedUniqueStrings(
      pluginPackage.runtimeTargets ?? manifest?.runtimeTargets,
    ),
    capabilities: toSortedUniqueStrings(
      pluginPackage.capabilities ?? manifest?.capabilities,
    ),
    startupPhase:
      normalizeString(
        pluginPackage.startupPhase ?? pluginPackage.startup_phase,
        null,
      ) ?? HostedRuntimeStartupPhase.ON_DEMAND,
    autoStart: Boolean(pluginPackage.autoStart ?? pluginPackage.auto_start),
    manifest,
    module: pluginPackage.module ?? null,
    handlers: pluginPackage.handlers ?? null,
    metadata: normalizeMetadata(pluginPackage.metadata),
  };
}

export async function discoverInstalledPluginPackages(options = {}) {
  const rootDirectories = toSortedUniqueStrings(
    options.rootDirectories ??
      options.pluginRootDirectories ??
      options.directories,
  );
  const moduleCandidates = Array.isArray(options.moduleCandidates)
    ? options.moduleCandidates
    : ["plugin.js", "index.js", "mod.js"];
  const packages = [];

  for (const rootDirectory of rootDirectories) {
    const manifestPaths = await findManifestFiles(rootDirectory);
    for (const manifestPath of manifestPaths) {
      const packageRoot = path.dirname(manifestPath);
      const manifest = await readJsonFile(manifestPath);
      const packageJsonPath = path.join(packageRoot, "package.json");
      const packageJson = (await fileExists(packageJsonPath))
        ? await readJsonFile(packageJsonPath)
        : null;

      let modulePath = null;
      const packageEntrypoints = [
        packageJson?.module,
        packageJson?.main,
        ...moduleCandidates,
      ]
        .map((value) => normalizeString(value, null))
        .filter(Boolean);

      for (const candidate of packageEntrypoints) {
        const resolved = path.resolve(packageRoot, candidate);
        if (await fileExists(resolved)) {
          modulePath = resolved;
          break;
        }
      }

      packages.push(
        normalizeInstalledPluginPackage({
          packageName: packageJson?.name ?? manifest.pluginId,
          pluginId: manifest.pluginId,
          packageRoot,
          manifestPath,
          modulePath,
          manifest,
          metadata: {
            packageJson,
          },
        }),
      );
    }
  }

  packages.sort((left, right) =>
    `${left.packageName ?? ""}:${left.pluginId}`.localeCompare(
      `${right.packageName ?? ""}:${right.pluginId}`,
    ),
  );
  return packages;
}

export async function loadInstalledPluginPackage(pluginPackage, options = {}) {
  const normalizedPackage = normalizeInstalledPluginPackage(pluginPackage);
  let manifest = normalizedPackage.manifest;
  if (!manifest && normalizedPackage.manifestPath) {
    manifest = normalizeManifest(await readJsonFile(normalizedPackage.manifestPath));
  }

  const moduleExports = await resolvePluginModule(normalizedPackage, options);
  if (!manifest && isObject(moduleExports?.manifest)) {
    manifest = normalizeManifest(moduleExports.manifest);
  } else if (!manifest && isObject(moduleExports?.default?.manifest)) {
    manifest = normalizeManifest(moduleExports.default.manifest);
  }

  if (!manifest?.pluginId) {
    throw new Error(
      `Installed plugin package "${normalizedPackage.packageId}" could not resolve a plugin manifest.`,
    );
  }

  const resolvedHandlers = await resolveHandlerRecord(
    moduleExports,
    manifest,
    normalizedPackage,
    options,
  );
  if (!isObject(resolvedHandlers)) {
    throw new Error(
      `Installed plugin package "${manifest.pluginId}" did not expose handlers or createHandlers().`,
    );
  }

  return {
    pluginPackage: {
      ...normalizedPackage,
      pluginId: manifest.pluginId,
      runtimeTargets: toSortedUniqueStrings(
        normalizedPackage.runtimeTargets.length > 0
          ? normalizedPackage.runtimeTargets
          : manifest.runtimeTargets,
      ),
      capabilities: toSortedUniqueStrings(
        normalizedPackage.capabilities.length > 0
          ? normalizedPackage.capabilities
          : manifest.capabilities,
      ),
      manifest,
      module: moduleExports,
      handlers: resolvedHandlers,
    },
    manifest,
    handlers: resolvedHandlers,
    module: moduleExports,
  };
}

export async function registerInstalledPluginPackage({
  registry,
  pluginPackage,
  importModule,
  context = null,
} = {}) {
  if (!(registry instanceof MethodRegistry)) {
    throw new TypeError(
      "registerInstalledPluginPackage requires a MethodRegistry instance.",
    );
  }

  const loaded = await loadInstalledPluginPackage(pluginPackage, {
    importModule,
    context,
  });
  registry.registerPlugin({
    manifest: loaded.manifest,
    handlers: loaded.handlers,
    plugin: loaded.module ?? loaded.pluginPackage,
  });
  return loaded;
}

export async function registerInstalledPluginPackages({
  registry,
  pluginPackages = [],
  importModule,
  context = null,
} = {}) {
  const loadedPackages = [];
  for (const pluginPackage of Array.isArray(pluginPackages) ? pluginPackages : []) {
    loadedPackages.push(
      await registerInstalledPluginPackage({
        registry,
        pluginPackage,
        importModule,
        context,
      }),
    );
  }
  return loadedPackages;
}

export function createInstalledFlowHostedRuntimePlan(options = {}) {
  const program = normalizeProgram(options.program ?? {});
  const requirements = summarizeProgramRequirements({
    program,
    manifests: options.manifests ?? [],
    registry: options.registry ?? null,
  });

  return normalizeHostedRuntimePlan({
    hostId: options.hostId ?? "sdn-js-local",
    hostKind: options.hostKind ?? "sdn-js",
    adapter: options.adapter ?? HostedRuntimeAdapter.SDN_JS,
    engine: options.engine ?? HostedRuntimeEngine.DENO,
    description:
      options.description ??
      `Auto-start flow host for ${program.programId ?? "flow-program"}.`,
    runtimes: [
      {
        runtimeId:
          options.runtimeId ??
          `${program.programId ?? "flow-program"}:runtime`,
        kind: HostedRuntimeKind.FLOW,
        programId: program.programId ?? null,
        description: options.runtimeDescription ?? program.description ?? null,
        execution: options.execution ?? "compiled-wasm",
        authority: options.authority ?? HostedRuntimeAuthority.LOCAL,
        startupPhase:
          options.startupPhase ?? HostedRuntimeStartupPhase.SESSION,
        autoStart: options.autoStart ?? true,
        dependsOn: options.dependsOn ?? [],
        requiredCapabilities:
          options.requiredCapabilities ?? requirements.capabilities,
        bindings: options.bindings ?? [],
      },
    ],
  });
}

export function createInstalledFlowHost(options = {}) {
  const registry = options.registry ?? new MethodRegistry();
  const runtime =
    options.runtime ??
    new FlowRuntime({
      registry,
      ...(options.runtimeOptions ?? {}),
      onSinkOutput:
        options.onSinkOutput ?? options.runtimeOptions?.onSinkOutput ?? null,
    });

  let started = false;
  let discoveredPackages = [];
  let loadedPackages = [];
  let program =
    options.program !== undefined && options.program !== null
      ? normalizeProgram(options.program)
      : null;

  function dedupePackages(pluginPackages) {
    const packagesByPluginId = new Map();
    for (const pluginPackage of pluginPackages) {
      const normalizedPackage = normalizeInstalledPluginPackage(pluginPackage);
      const key =
        normalizedPackage.pluginId ||
        normalizedPackage.manifest?.pluginId ||
        normalizedPackage.packageId;
      packagesByPluginId.set(key, normalizedPackage);
    }
    return Array.from(packagesByPluginId.values());
  }

  function collectRequiredPluginIds() {
    if (!program) {
      return null;
    }
    const requiredPluginIds = new Set(
      normalizeStringArray(program.requiredPlugins),
    );
    for (const node of program.nodes ?? []) {
      if (node.pluginId) {
        requiredPluginIds.add(node.pluginId);
      }
    }
    return requiredPluginIds;
  }

  function isLoadablePluginPackage(pluginPackage) {
    return Boolean(
      pluginPackage.handlers ||
        pluginPackage.createHandlers ||
        pluginPackage.module ||
        pluginPackage.modulePath,
    );
  }

  async function start() {
    if (!started) {
      const explicitPackages = Array.isArray(options.pluginPackages)
        ? options.pluginPackages
        : [];
      discoveredPackages =
        options.discover === false
          ? []
          : await discoverInstalledPluginPackages({
              rootDirectories:
                options.pluginRootDirectories ?? options.rootDirectories ?? [],
              moduleCandidates: options.moduleCandidates,
            });
      const allPackages = dedupePackages([
        ...discoveredPackages,
        ...explicitPackages,
      ]);
      const requiredPluginIds = collectRequiredPluginIds();
      const selectedPackages = allPackages.filter((pluginPackage) => {
        if (requiredPluginIds && requiredPluginIds.size > 0) {
          return requiredPluginIds.has(pluginPackage.pluginId);
        }
        return isLoadablePluginPackage(pluginPackage);
      });
      loadedPackages = await registerInstalledPluginPackages({
        registry,
        pluginPackages: selectedPackages,
        importModule: options.importModule,
        context: options.context ?? null,
      });
      if (program) {
        runtime.loadProgram(program);
      }
      started = true;
    }

    return {
      started,
      programId: runtime.getProgram()?.programId ?? program?.programId ?? null,
      discoveredPackages: discoveredPackages.map((item) => item.pluginId),
      registeredPluginIds: registry.listPlugins().map((item) => item.pluginId),
    };
  }

  return {
    registry,
    runtime,
    getProgram() {
      return runtime.getProgram() ?? program;
    },
    getLoadedPackages() {
      return loadedPackages.map((item) => item.pluginPackage);
    },
    async start() {
      return start();
    },
    loadProgram(nextProgram) {
      program = normalizeProgram(nextProgram);
      if (started) {
        return runtime.loadProgram(program);
      }
      return program;
    },
    enqueueTriggerFrames(triggerId, frames) {
      return runtime.enqueueTriggerFrames(triggerId, frames);
    },
    enqueueNodeFrames(nodeId, portId, frames, backpressurePolicy, queueDepth) {
      return runtime.enqueueNodeFrames(
        nodeId,
        portId,
        frames,
        backpressurePolicy,
        queueDepth,
      );
    },
    drain(options) {
      return runtime.drain(options);
    },
    isIdle() {
      return runtime.isIdle();
    },
    inspectQueues() {
      return runtime.inspectQueues();
    },
  };
}

export default {
  createInstalledFlowHost,
  createInstalledFlowHostedRuntimePlan,
  discoverInstalledPluginPackages,
  loadInstalledPluginPackage,
  normalizeInstalledPluginPackage,
  registerInstalledPluginPackage,
  registerInstalledPluginPackages,
};
