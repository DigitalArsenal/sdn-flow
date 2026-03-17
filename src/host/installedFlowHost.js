import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import { findManifestFiles } from "../compliance/index.js";
import {
  FlowRuntime,
  MethodRegistry,
  TriggerKind,
  normalizeFrame,
  normalizeManifest,
  normalizeProgram,
} from "../runtime/index.js";
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

function firstAcceptedTypeForTrigger(trigger) {
  return Array.isArray(trigger?.acceptedTypes) && trigger.acceptedTypes.length > 0
    ? trigger.acceptedTypes[0]
    : null;
}

function buildBaseTriggerFrame(trigger, input = {}) {
  const normalizedMetadata = normalizeMetadata(input.metadata);
  return normalizeFrame({
    typeRef: input.typeRef ?? firstAcceptedTypeForTrigger(trigger) ?? {},
    traceId: input.traceId ?? null,
    streamId: Number(input.streamId ?? 0),
    sequence: Number(input.sequence ?? 0),
    payload: input.payload ?? null,
    metadata: {
      triggerId: trigger.triggerId,
      triggerKind: trigger.kind,
      triggerSource: trigger.source ?? null,
      ...normalizedMetadata,
    },
  });
}

function buildTimerTriggerFrame(trigger, input = {}) {
  const firedAt = Number(input.firedAt ?? Date.now());
  return buildBaseTriggerFrame(trigger, {
    ...input,
    traceId: input.traceId ?? `timer:${trigger.triggerId}:${firedAt}`,
    sequence: input.sequence ?? firedAt,
    metadata: {
      firedAt,
      description: trigger.description ?? null,
      ...(input.metadata ?? {}),
    },
  });
}

function buildHttpRequestTriggerFrame(trigger, request = {}) {
  const method = normalizeString(request.method, "GET");
  const pathName =
    normalizeString(request.path, null) ?? trigger.source ?? "/";
  const requestId =
    normalizeString(request.requestId, null) ??
    `http:${method}:${pathName}:${Date.now()}`;
  return buildBaseTriggerFrame(trigger, {
    ...request,
    traceId: request.traceId ?? requestId,
    sequence: request.sequence ?? 1,
    payload: request.payload ?? request.body ?? null,
    metadata: {
      requestId,
      method,
      path: pathName,
      headers: isObject(request.headers) ? { ...request.headers } : {},
      query: isObject(request.query) ? { ...request.query } : {},
      description: trigger.description ?? null,
      ...(request.metadata ?? {}),
    },
  });
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
  const sinkEvents = [];
  const userOnSinkOutput =
    options.onSinkOutput ?? options.runtimeOptions?.onSinkOutput ?? null;
  const runtime =
    options.runtime ??
    new FlowRuntime({
      registry,
      ...(options.runtimeOptions ?? {}),
      onSinkOutput(event) {
        const sinkEvent = {
          index: sinkEvents.length,
          ...event,
        };
        sinkEvents.push(sinkEvent);
        if (typeof userOnSinkOutput === "function") {
          userOnSinkOutput(sinkEvent);
        }
      },
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

  function collectRequiredPluginIds(programValue = program) {
    if (!programValue) {
      return null;
    }
    const requiredPluginIds = new Set(
      normalizeStringArray(programValue.requiredPlugins),
    );
    for (const node of programValue.nodes ?? []) {
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

  function buildStartupSummary() {
    return {
      started,
      programId: runtime.getProgram()?.programId ?? program?.programId ?? null,
      discoveredPackages: discoveredPackages.map((item) => item.pluginId),
      registeredPluginIds: registry.listPlugins().map((item) => item.pluginId),
    };
  }

  async function resolveSelectedPluginPackages(refreshOptions = {}) {
    const nextProgram =
      refreshOptions.program !== undefined && refreshOptions.program !== null
        ? normalizeProgram(refreshOptions.program)
        : program;
    const explicitPackages = Array.isArray(refreshOptions.pluginPackages)
      ? refreshOptions.pluginPackages
      : Array.isArray(options.pluginPackages)
        ? options.pluginPackages
        : [];
    const shouldDiscover =
      refreshOptions.discover ?? options.discover ?? true;
    const nextDiscoveredPackages =
      shouldDiscover === false
        ? []
        : await discoverInstalledPluginPackages({
            rootDirectories:
              refreshOptions.pluginRootDirectories ??
              refreshOptions.rootDirectories ??
              options.pluginRootDirectories ??
              options.rootDirectories ??
              [],
            moduleCandidates:
              refreshOptions.moduleCandidates ?? options.moduleCandidates,
          });
    const allPackages = dedupePackages([
      ...nextDiscoveredPackages,
      ...explicitPackages,
    ]);
    const requiredPluginIds = collectRequiredPluginIds(nextProgram);
    const selectedPackages = allPackages.filter((pluginPackage) => {
      if (requiredPluginIds && requiredPluginIds.size > 0) {
        return requiredPluginIds.has(pluginPackage.pluginId);
      }
      return isLoadablePluginPackage(pluginPackage);
    });

    return {
      nextProgram,
      nextDiscoveredPackages,
      selectedPackages,
    };
  }

  async function refreshPlugins(refreshOptions = {}) {
    const {
      nextProgram,
      nextDiscoveredPackages,
      selectedPackages,
    } = await resolveSelectedPluginPackages(refreshOptions);
    const importModule = refreshOptions.importModule ?? options.importModule;
    const context =
      refreshOptions.context !== undefined
        ? refreshOptions.context
        : options.context ?? null;
    const nextLoadedPackages = [];

    for (const pluginPackage of selectedPackages) {
      nextLoadedPackages.push(
        await loadInstalledPluginPackage(pluginPackage, {
          importModule,
          context,
        }),
      );
    }

    const managedPluginIds = new Set(
      loadedPackages.map(
        (item) => item.manifest?.pluginId ?? item.pluginPackage?.pluginId,
      ),
    );
    for (const loaded of nextLoadedPackages) {
      const pluginId = loaded.manifest.pluginId;
      if (!managedPluginIds.has(pluginId) && registry.getPlugin(pluginId)) {
        throw new Error(
          `Installed flow host cannot refresh plugin "${pluginId}" because the registry already contains an externally managed plugin with the same id.`,
        );
      }
    }

    const validationRegistry = new MethodRegistry();
    for (const loaded of nextLoadedPackages) {
      validationRegistry.registerPlugin({
        manifest: loaded.manifest,
        handlers: loaded.handlers,
        plugin: loaded.module ?? loaded.pluginPackage,
      });
    }

    for (const pluginId of managedPluginIds) {
      registry.unregisterPlugin(pluginId);
    }
    for (const loaded of nextLoadedPackages) {
      registry.registerPlugin({
        manifest: loaded.manifest,
        handlers: loaded.handlers,
        plugin: loaded.module ?? loaded.pluginPackage,
      });
    }

    discoveredPackages = nextDiscoveredPackages;
    loadedPackages = nextLoadedPackages;
    program = nextProgram;
    if (program) {
      runtime.loadProgram(program);
    }
    if (refreshOptions.clearSinkOutputs === true) {
      sinkEvents.splice(0, sinkEvents.length);
    }
    started = true;

    return buildStartupSummary();
  }

  async function start() {
    if (!started) {
      await refreshPlugins();
    }
    return buildStartupSummary();
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
    getSinkEventCount() {
      return sinkEvents.length;
    },
    getSinkOutputsSince(index = 0) {
      return sinkEvents.slice(Math.max(0, Number(index) || 0));
    },
    clearSinkOutputs() {
      sinkEvents.splice(0, sinkEvents.length);
    },
    async start() {
      return start();
    },
    async refreshPlugins(refreshOptions = {}) {
      return refreshPlugins(refreshOptions);
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

export function createInstalledFlowService(options = {}) {
  const host = options.host ?? createInstalledFlowHost(options);
  const timerHandles = new Map();
  const setIntervalFn =
    options.setIntervalFn ??
    globalThis.setInterval?.bind(globalThis) ??
    null;
  const clearIntervalFn =
    options.clearIntervalFn ??
    globalThis.clearInterval?.bind(globalThis) ??
    null;
  const nowFn = options.nowFn ?? Date.now;
  const onError = options.onError ?? null;
  let started = false;

  function getProgram() {
    const program = host.getProgram();
    if (!program) {
      throw new Error("Installed flow service has no loaded program.");
    }
    return program;
  }

  function listTriggersByKind(kind) {
    return getProgram().triggers.filter((trigger) => trigger.kind === kind);
  }

  function resolveHttpTrigger(request = {}) {
    const program = getProgram();
    const requestedTriggerId = normalizeString(request.triggerId, null);
    const requestedPath = normalizeString(request.path, null);
    const trigger = program.triggers.find((candidate) => {
      if (candidate.kind !== TriggerKind.HTTP_REQUEST) {
        return false;
      }
      if (requestedTriggerId) {
        return candidate.triggerId === requestedTriggerId;
      }
      return normalizeString(candidate.source, null) === requestedPath;
    });
    if (!trigger) {
      throw new Error(
        `No HTTP trigger matches ${requestedTriggerId ?? requestedPath ?? "<unknown>"}.`,
      );
    }
    return trigger;
  }

  async function dispatchTriggerFrames(triggerId, frames) {
    await host.start();
    const startIndex = host.getSinkEventCount();
    host.enqueueTriggerFrames(triggerId, frames);
    const drainResult = await host.drain(options.drainOptions);
    return {
      triggerId,
      outputs: host.getSinkOutputsSince(startIndex),
      ...drainResult,
    };
  }

  async function dispatchTimerTrigger(triggerId, input = {}) {
    const trigger = listTriggersByKind(TriggerKind.TIMER).find(
      (candidate) => candidate.triggerId === triggerId,
    );
    if (!trigger) {
      throw new Error(`Unknown timer trigger "${triggerId}".`);
    }
    return dispatchTriggerFrames(triggerId, [
      buildTimerTriggerFrame(trigger, {
        ...input,
        firedAt: input.firedAt ?? nowFn(),
      }),
    ]);
  }

  async function handleHttpRequest(request = {}) {
    const trigger = resolveHttpTrigger(request);
    const response = await dispatchTriggerFrames(trigger.triggerId, [
      buildHttpRequestTriggerFrame(trigger, request),
    ]);
    return {
      triggerId: trigger.triggerId,
      route: trigger.source ?? null,
      ...response,
    };
  }

  function listTimerTriggers() {
    return listTriggersByKind(TriggerKind.TIMER).map((trigger) => ({
      triggerId: trigger.triggerId,
      source: trigger.source,
      defaultIntervalMs: trigger.defaultIntervalMs,
      description: trigger.description,
      active: timerHandles.has(trigger.triggerId),
    }));
  }

  function listHttpRoutes() {
    return listTriggersByKind(TriggerKind.HTTP_REQUEST).map((trigger) => ({
      triggerId: trigger.triggerId,
      path: trigger.source ?? null,
      description: trigger.description,
    }));
  }

  function startTimerServices() {
    if (setIntervalFn === null || clearIntervalFn === null) {
      return;
    }
    for (const trigger of listTriggersByKind(TriggerKind.TIMER)) {
      if (timerHandles.has(trigger.triggerId)) {
        continue;
      }
      const intervalMs = Number(trigger.defaultIntervalMs ?? 0);
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        continue;
      }
      const normalizedIntervalMs = Math.max(1, Math.trunc(intervalMs));
      const handle = setIntervalFn(() => {
        void dispatchTimerTrigger(trigger.triggerId).catch((error) => {
          if (typeof onError === "function") {
            onError(error, {
              source: "timer",
              triggerId: trigger.triggerId,
            });
          }
        });
      }, normalizedIntervalMs);
      timerHandles.set(trigger.triggerId, {
        handle,
        intervalMs: normalizedIntervalMs,
      });
    }
  }

  function stopTimerServices() {
    if (clearIntervalFn === null) {
      timerHandles.clear();
      return;
    }
    for (const { handle } of timerHandles.values()) {
      clearIntervalFn(handle);
    }
    timerHandles.clear();
  }

  return {
    host,
    async start() {
      const startup = await host.start();
      if (!started) {
        if (options.autoStartTimers !== false) {
          startTimerServices();
        }
        started = true;
      }
      return {
        ...startup,
        timerTriggers: listTimerTriggers(),
        httpRoutes: listHttpRoutes(),
      };
    },
    async refresh(refreshOptions = {}) {
      const restartTimers = started && options.autoStartTimers !== false;
      stopTimerServices();
      const refreshResult = await host.refreshPlugins(refreshOptions);
      if (restartTimers) {
        startTimerServices();
      }
      return {
        ...refreshResult,
        timerTriggers: listTimerTriggers(),
        httpRoutes: listHttpRoutes(),
      };
    },
    stop() {
      stopTimerServices();
      started = false;
    },
    dispatchTriggerFrames,
    dispatchTimerTrigger,
    handleHttpRequest,
    listTimerTriggers,
    listHttpRoutes,
    getServiceSummary() {
      return {
        started,
        timerTriggers: listTimerTriggers(),
        httpRoutes: listHttpRoutes(),
      };
    },
  };
}

export default {
  createInstalledFlowHost,
  createInstalledFlowService,
  createInstalledFlowHostedRuntimePlan,
  discoverInstalledPluginPackages,
  loadInstalledPluginPackage,
  normalizeInstalledPluginPackage,
  registerInstalledPluginPackage,
  registerInstalledPluginPackages,
};
