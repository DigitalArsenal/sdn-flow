import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DeploymentBindingMode } from "space-data-module-sdk";
import {
  EmceptionCompilerAdapter,
  buildDefaultFlowManifestBuffer,
  createSdkEmceptionSession,
  inferFlowRuntimeTargets,
} from "../compiler/index.js";
import { summarizeProgramRequirements } from "../designer/requirements.js";
import { findManifestFiles } from "../compliance/index.js";
import {
  BackpressurePolicy,
  ExternalInterfaceDirection,
  ExternalInterfaceKind,
  MethodRegistry,
  TriggerKind,
  normalizeFrame,
  normalizeManifest,
  normalizeProgram,
} from "../runtime/index.js";
import {
  createFlowDeploymentPlan,
  listCompiledArtifactRuntimeTargets,
  normalizeCompiledArtifact,
  resolveCompiledArtifactInput,
} from "../deploy/index.js";
import {
  HostedRuntimeAdapter,
  HostedRuntimeAuthority,
  HostedRuntimeBindingDirection,
  HostedRuntimeEngine,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
  HostedRuntimeTransport,
} from "./constants.js";
import { bindCompiledFlowRuntimeHost } from "./compiledFlowRuntimeHost.js";
import { instantiateArtifactWithLoaderModule } from "./loaderModule.js";
import { normalizeHostedRuntimePlan } from "./normalize.js";
import { evaluateHostedRuntimeTargetSupport } from "./profile.js";

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

function normalizeBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return fallback;
  }
  const lowered = normalized.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return false;
  }
  return fallback;
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

function normalizeHeaderRecord(headers) {
  if (!headers) {
    return {};
  }
  const entries =
    typeof headers.forEach === "function"
      ? (() => {
          const headerEntries = [];
          headers.forEach((value, key) => {
            headerEntries.push([key, value]);
          });
          return headerEntries;
        })()
      : Array.isArray(headers)
        ? headers
        : isObject(headers)
          ? Object.entries(headers)
          : [];
  const normalized = {};
  for (const [key, value] of entries) {
    const headerName = normalizeString(key, null);
    if (!headerName || value === null || value === undefined) {
      continue;
    }
    normalized[headerName.toLowerCase()] = Array.isArray(value)
      ? value.map((item) => String(item)).join(", ")
      : String(value);
  }
  return normalized;
}

function resolvePathLike(value, baseDirectory = process.cwd()) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return null;
  }
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(baseDirectory, normalized);
}

function normalizeNamedRecordCollection(values, idKey, normalizeEntry) {
  if (Array.isArray(values)) {
    return values
      .map((value) => normalizeEntry(value, null))
      .filter((value) => value?.[idKey]);
  }
  if (isObject(values)) {
    return Object.entries(values)
      .map(([key, value]) => normalizeEntry(value, key))
      .filter((value) => value?.[idKey]);
  }
  return [];
}

function normalizeServerKeyAliases(value) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return [];
  }
  const aliases = new Set([normalized]);
  const prefixedMatch = normalized.match(/^([a-z0-9._-]+):(.*)$/i);
  if (prefixedMatch) {
    const prefix = prefixedMatch[1].toLowerCase();
    const body = prefixedMatch[2].trim();
    aliases.add(`${prefix}:${body}`);
    if (/^[0-9a-f]+$/i.test(body)) {
      aliases.add(`${prefix}:${body.toUpperCase()}`);
      aliases.add(`${prefix}:${body.toLowerCase()}`);
      aliases.add(body.toUpperCase());
      aliases.add(body.toLowerCase());
    }
    return Array.from(aliases);
  }
  if (/^[0-9a-f]+$/i.test(normalized)) {
    aliases.add(normalized.toUpperCase());
    aliases.add(normalized.toLowerCase());
    aliases.add(`ed25519:${normalized.toUpperCase()}`);
    aliases.add(`ed25519:${normalized.toLowerCase()}`);
  }
  return Array.from(aliases);
}

function mergeStringSet(target, values) {
  for (const value of normalizeStringArray(values)) {
    target.add(value);
  }
}

function mergeServerKeySet(target, values) {
  for (const value of Array.isArray(values) ? values : []) {
    for (const alias of normalizeServerKeyAliases(value)) {
      target.add(alias);
    }
  }
}

function sortStringSet(values) {
  return Array.from(values).sort();
}

function toSortedUniqueStrings(values) {
  return Array.from(new Set(normalizeStringArray(values))).sort();
}

function normalizeBindingMode(value, fallback = DeploymentBindingMode.LOCAL) {
  const normalized = normalizeString(value, null)?.toLowerCase();
  if (
    normalized === DeploymentBindingMode.LOCAL ||
    normalized === DeploymentBindingMode.DELEGATED
  ) {
    return normalized;
  }
  return fallback;
}

function createHttpStatusError(statusCode, message, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (options.code) {
    error.code = options.code;
  }
  if (options.headers) {
    error.headers = options.headers;
  }
  return error;
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

function groupBy(items, keySelector) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keySelector(item);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}

function cloneJsonCompatibleValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON normalization.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizePayloadBytes(value) {
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
  return null;
}

function normalizeInstalledRuntimeFrame(frame = {}, defaultPortId = null) {
  const normalized = normalizeFrame(frame, defaultPortId);
  const payload =
    normalizePayloadBytes(
      frame.bytes ??
        frame.data ??
        frame.payloadBytes ??
        frame.payload_bytes ??
        normalized.payload,
    ) ?? new Uint8Array();
  const traceToken = Number(
    frame.traceToken ?? frame.trace_token ?? frame.traceId ?? frame.trace_id ?? 0,
  );

  return {
    ...normalized,
    portId: normalized.portId ?? defaultPortId,
    payload,
    bytes: payload,
    metadata: normalizeMetadata(normalized.metadata),
    typeRef: normalized.typeRef ?? {},
    traceToken: Number.isFinite(traceToken) ? Math.max(0, Math.trunc(traceToken)) : 0,
  };
}

function cloneInstalledRuntimeFrame(frame = {}, defaultPortId = null) {
  const normalized = normalizeInstalledRuntimeFrame(frame, defaultPortId);
  return {
    ...normalized,
    payload: new Uint8Array(normalized.payload),
    bytes: new Uint8Array(normalized.bytes),
    metadata: cloneJsonCompatibleValue(normalized.metadata),
    typeRef: cloneJsonCompatibleValue(normalized.typeRef) ?? {},
  };
}

function envelopeQueueKey(nodeId, portId) {
  return `${nodeId}:${portId}`;
}

function ensureEnvelopeQueue(envelopeQueues, nodeId, portId) {
  const key = envelopeQueueKey(nodeId, portId);
  const existing = envelopeQueues.get(key);
  if (existing) {
    return existing;
  }
  const queue = [];
  envelopeQueues.set(key, queue);
  return queue;
}

function applyQueueBackpressure(queue, frame, policy, queueDepth) {
  const cap = Number(queueDepth ?? 0);
  const bounded = cap > 0;
  switch (policy) {
    case BackpressurePolicy.DROP:
      if (!bounded || queue.length < cap) {
        queue.push(frame);
      }
      return;
    case BackpressurePolicy.LATEST:
    case BackpressurePolicy.COALESCE:
      if (!bounded || queue.length < cap) {
        queue.push(frame);
      } else {
        queue.splice(0, queue.length, frame);
      }
      return;
    case BackpressurePolicy.BLOCK_REQUEST:
      if (bounded && queue.length >= cap) {
        throw new Error("Backpressure queue is full.");
      }
      queue.push(frame);
      return;
    case BackpressurePolicy.DRAIN_TO_EMPTY:
    case BackpressurePolicy.QUEUE:
    default:
      if (bounded && queue.length >= cap) {
        queue.shift();
      }
      queue.push(frame);
  }
}

function snapshotEnvelopeQueues(envelopeQueues) {
  const snapshot = {};
  for (const [key, queue] of envelopeQueues.entries()) {
    if (queue.length === 0) {
      continue;
    }
    const separatorIndex = key.indexOf(":");
    const nodeId =
      separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
    const portId =
      separatorIndex >= 0 ? key.slice(separatorIndex + 1) : "";
    if (!snapshot[nodeId]) {
      snapshot[nodeId] = {};
    }
    snapshot[nodeId][portId] = queue.length;
  }
  return snapshot;
}

function translateDrainOptions(options = {}) {
  return {
    frameBudget: Number(options.frameBudget ?? options.frame_budget ?? 1),
    outputStreamCap: Number(
      options.outputStreamCap ?? options.output_stream_cap ?? 16,
    ),
    maxIterations: Number(
      options.maxIterations ?? options.max_iterations ?? options.maxInvocations ?? 1024,
    ),
  };
}

function buildCompiledFrameInput(frame = {}) {
  return {
    typeRef: frame.typeRef ?? {},
    alignment: frame.alignment ?? 8,
    streamId: frame.streamId ?? 0,
    sequence: frame.sequence ?? 0,
    traceToken: frame.traceToken ?? 0,
    endOfStream: frame.endOfStream ?? false,
    bytes: frame.bytes ?? frame.payload ?? new Uint8Array(),
  };
}

function resolveInstalledFlowDeploymentPlan(program, options = {}) {
  return createFlowDeploymentPlan(program, {
    deploymentPlan: options.deploymentPlan ?? null,
    pluginId: options.pluginId ?? null,
    version: options.version ?? null,
    environmentId: options.environmentId ?? null,
    scheduleBindingMode: options.scheduleBindingMode,
    serviceBindingMode: options.serviceBindingMode,
    delegatedServiceBaseUrl: options.delegatedServiceBaseUrl,
    defaultHttpAuthPolicyId: options.defaultHttpAuthPolicyId,
    httpAdapter: options.httpAdapter,
    timezone: options.timezone,
  });
}

function buildSyntheticInputBindingTriggerId(bindingId) {
  return `__sdn_input_binding__:${bindingId}`;
}

function resolveMethodInputPorts(registry, node) {
  if (!registry || !node) {
    return [];
  }
  const methodDescriptor = registry.getMethod(node.pluginId, node.methodId);
  return Array.isArray(methodDescriptor?.method?.inputPorts)
    ? methodDescriptor.method.inputPorts
    : [];
}

function listAllowedTypesForPort(port = {}) {
  const typeRefs = [];
  const seen = new Set();
  for (const typeSet of Array.isArray(port?.acceptedTypeSets)
    ? port.acceptedTypeSets
    : []) {
    for (const allowedType of Array.isArray(typeSet?.allowedTypes)
      ? typeSet.allowedTypes
      : []) {
      const clonedTypeRef = cloneJsonCompatibleValue(allowedType) ?? {};
      const key = JSON.stringify(clonedTypeRef);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      typeRefs.push(clonedTypeRef);
    }
  }
  return typeRefs;
}

function listProgramNodesMatchingInputBinding(program, binding) {
  const targetMethodId = normalizeString(binding?.targetMethodId, null);
  const targetPluginId = normalizeString(binding?.targetPluginId, null);
  if (!targetMethodId) {
    return [];
  }
  return (program?.nodes ?? []).filter((node) => {
    if (node.methodId !== targetMethodId) {
      return false;
    }
    if (targetPluginId && node.pluginId !== targetPluginId) {
      return false;
    }
    return true;
  });
}

function prepareProgramInputBindingRoutes({
  program,
  deploymentPlan,
  registry,
} = {}) {
  const normalizedProgram = normalizeProgram(program ?? {});
  const inputBindings = Array.isArray(deploymentPlan?.inputBindings)
    ? deploymentPlan.inputBindings
    : [];
  if (inputBindings.length === 0) {
    return {
      compiledProgram: normalizedProgram,
      inputBindingRoutes: [],
    };
  }

  const existingTriggerIds = new Set(
    (normalizedProgram.triggers ?? [])
      .map((trigger) => normalizeString(trigger?.triggerId, null))
      .filter(Boolean),
  );
  const syntheticTriggers = [];
  const syntheticTriggerBindings = [];
  const inputBindingRoutes = [];

  for (const binding of inputBindings) {
    const bindingId = normalizeString(binding?.bindingId, null);
    if (!bindingId) {
      continue;
    }
    const triggerId = buildSyntheticInputBindingTriggerId(bindingId);
    if (existingTriggerIds.has(triggerId)) {
      throw new Error(
        `Installed flow host cannot synthesize input binding "${bindingId}" because trigger id "${triggerId}" already exists.`,
      );
    }
    existingTriggerIds.add(triggerId);

    const targetInputPortId = normalizeString(binding?.targetInputPortId, null);
    const matchingNodes = listProgramNodesMatchingInputBinding(
      normalizedProgram,
      binding,
    );
    const targetNodes = matchingNodes.map((node) => {
      const inputPorts = resolveMethodInputPorts(registry, node);
      const inputPort =
        inputPorts.find((port) => port?.portId === targetInputPortId) ?? null;
      return {
        nodeId: node.nodeId,
        pluginId: node.pluginId,
        methodId: node.methodId,
        targetInputPortId,
        inputPortFound: inputPort !== null,
        acceptedTypes: inputPort ? listAllowedTypesForPort(inputPort) : [],
      };
    });
    const acceptedTypes = [];
    const acceptedTypeKeys = new Set();
    for (const targetNode of targetNodes) {
      for (const acceptedType of targetNode.acceptedTypes) {
        const key = JSON.stringify(acceptedType);
        if (acceptedTypeKeys.has(key)) {
          continue;
        }
        acceptedTypeKeys.add(key);
        acceptedTypes.push(cloneJsonCompatibleValue(acceptedType) ?? {});
      }
    }

    syntheticTriggers.push({
      triggerId,
      kind: TriggerKind.MANUAL,
      source: bindingId,
      acceptedTypes,
      description:
        normalizeString(binding?.description, null) ??
        `Deployment input binding ${bindingId}.`,
      metadata: {
        synthetic: true,
        inputBindingId: bindingId,
        sourceKind: normalizeString(binding?.sourceKind, null),
      },
    });
    for (const targetNode of targetNodes) {
      if (!targetNode.inputPortFound || !targetNode.targetInputPortId) {
        continue;
      }
      syntheticTriggerBindings.push({
        triggerId,
        targetNodeId: targetNode.nodeId,
        targetPortId: targetNode.targetInputPortId,
      });
    }

    inputBindingRoutes.push({
      bindingId,
      triggerId,
      sourceKind: normalizeString(binding?.sourceKind, null),
      targetMethodId: normalizeString(binding?.targetMethodId, null),
      targetPluginId: normalizeString(binding?.targetPluginId, null),
      targetInputPortId,
      description: normalizeString(binding?.description, null),
      acceptedTypes,
      targetNodes,
    });
  }

  return {
    compiledProgram: normalizeProgram({
      ...normalizedProgram,
      triggers: [...normalizedProgram.triggers, ...syntheticTriggers],
      triggerBindings: [
        ...normalizedProgram.triggerBindings,
        ...syntheticTriggerBindings,
      ],
    }),
    inputBindingRoutes,
  };
}

function resolveHostProfiles(hostPlan, programId) {
  if (!hostPlan) {
    return [];
  }
  const normalizedPlan = normalizeHostedRuntimePlan(hostPlan);
  const matchingRuntimes = normalizedPlan.runtimes.filter(
    (runtime) => !runtime.programId || runtime.programId === programId,
  );
  if (matchingRuntimes.length === 0) {
    return [
      {
        runtimeId: normalizedPlan.hostId,
        hostId: normalizedPlan.hostId,
        hostKind: normalizedPlan.hostKind,
        adapter: normalizedPlan.adapter,
        engine: normalizedPlan.engine,
      },
    ];
  }
  return matchingRuntimes.map((runtime) => ({
    runtimeId: runtime.runtimeId,
    hostId: normalizedPlan.hostId,
    hostKind: normalizedPlan.hostKind,
    adapter: runtime.adapter ?? normalizedPlan.adapter,
    engine: runtime.engine ?? normalizedPlan.engine,
  }));
}

function assertInstalledArtifactRuntimeTargets({
  artifact,
  program,
  hostPlan = null,
} = {}) {
  const runtimeTargets = listCompiledArtifactRuntimeTargets(artifact);
  if (runtimeTargets.length === 0 || !hostPlan) {
    return;
  }
  for (const profile of resolveHostProfiles(hostPlan, program?.programId ?? null)) {
    const compatibility = evaluateHostedRuntimeTargetSupport({
      hostKind: profile.hostKind,
      adapter: profile.adapter,
      engine: profile.engine,
      runtimeTargets,
    });
    if (!compatibility.ok) {
      throw new Error(
        `Installed flow host cannot start runtime "${profile.runtimeId}" on host "${profile.hostId}" because embedded runtimeTargets ${runtimeTargets.join(", ")} require ${compatibility.unsupportedTargets.join(", ")} support.`,
      );
    }
  }
}

async function compileInstalledFlowArtifact({
  program,
  manifests = [],
  registry = null,
  artifactOptions = {},
} = {}) {
  const explicitArtifact =
    artifactOptions.artifact ??
    artifactOptions.compiledArtifact ??
    artifactOptions.serializedArtifact ??
    null;
  if (explicitArtifact) {
    return resolveCompiledArtifactInput(explicitArtifact);
  }

  if (typeof artifactOptions.compileArtifact === "function") {
    return normalizeCompiledArtifact(
      await artifactOptions.compileArtifact({
        program,
        manifests,
        registry,
        metadata: artifactOptions.metadata ?? null,
      }),
    );
  }

  let compiler = artifactOptions.compiler ?? null;
  let emception = artifactOptions.emception ?? null;
  let ownsSession = false;
  let workingDirectory = normalizeString(
    artifactOptions.workingDirectory,
    null,
  );

  if (!compiler) {
    if (!emception) {
      workingDirectory =
        workingDirectory ?? `/working/sdn-flow-installed-${randomUUID()}`;
      const sessionFactory =
        artifactOptions.emceptionSessionFactory ?? createSdkEmceptionSession;
      emception = await sessionFactory({
        workingDirectory,
      });
      ownsSession = true;
    }
    compiler = new EmceptionCompilerAdapter({
      emception,
      artifactCatalog: artifactOptions.artifactCatalog,
      manifestBuilder:
        artifactOptions.manifestBuilder ??
        (({ program: manifestProgram, metadata, dependencies }) =>
          buildDefaultFlowManifestBuffer({
            program: manifestProgram,
            manifests,
            registry,
            dependencies,
            deploymentPlan: metadata?.deploymentPlan ?? null,
            hostPlan: metadata?.hostPlan ?? null,
            runtimeTargets: metadata?.runtimeTargets ?? null,
            pluginId: metadata?.pluginId ?? null,
            version: metadata?.version ?? null,
          })),
      outputName: artifactOptions.outputName ?? "installed-flow-runtime",
      sourceGenerator: artifactOptions.sourceGenerator,
    });
  }

  try {
    return normalizeCompiledArtifact(
      await compiler.compile({
        program,
        metadata: {
          outputName: artifactOptions.outputName ?? "installed-flow-runtime",
          workingDirectory,
          deploymentPlan: artifactOptions.deploymentPlan ?? null,
          hostPlan: artifactOptions.hostPlan ?? null,
          runtimeTargets: artifactOptions.runtimeTargets ?? null,
          pluginId:
            artifactOptions.pluginId ?? program?.programId ?? null,
          version: artifactOptions.version ?? program?.version ?? null,
        },
      }),
    );
  } finally {
    if (ownsSession && emception) {
      try {
        if (typeof emception.removeDirectory === "function" && workingDirectory) {
          await emception.removeDirectory(workingDirectory);
        }
      } finally {
        if (typeof emception.dispose === "function") {
          await emception.dispose();
        }
      }
    }
  }
}

async function bindInstalledCompiledRuntimeHost({
  artifact,
  handlers,
  runtimeOptions = {},
} = {}) {
  const instantiateArtifact =
    typeof artifact?.loaderModule === "string" && artifact.loaderModule.length > 0
      ? (moduleBytes, imports) =>
          instantiateArtifactWithLoaderModule(
            artifact.loaderModule,
            moduleBytes,
            imports,
          )
      : runtimeOptions.instantiateArtifact ?? WebAssembly.instantiate;
  const createCompiledHost =
    runtimeOptions.createCompiledHost ?? bindCompiledFlowRuntimeHost;

  return createCompiledHost({
    artifact,
    handlers,
    dependencyInvoker: runtimeOptions.dependencyInvoker ?? null,
    dependencyStreamBridge: runtimeOptions.dependencyStreamBridge ?? null,
    artifactImports: runtimeOptions.artifactImports ?? {},
    dependencyImports: runtimeOptions.dependencyImports ?? {},
    instantiateArtifact,
    instantiateDependency:
      runtimeOptions.instantiateDependency ?? WebAssembly.instantiate,
  });
}

async function disposeInstalledCompiledRuntime(runtimeState = null) {
  if (!runtimeState?.runtimeHost) {
    return;
  }
  try {
    if (typeof runtimeState.runtimeHost.resetRuntimeState === "function") {
      runtimeState.runtimeHost.resetRuntimeState();
    }
  } catch {
    // Ignore best-effort cleanup errors during runtime replacement.
  }
  try {
    if (typeof runtimeState.runtimeHost.destroyDependencies === "function") {
      await runtimeState.runtimeHost.destroyDependencies();
    }
  } catch {
    // Ignore best-effort dependency cleanup failures.
  }
}

function hasUriScheme(value) {
  const normalized = normalizeString(value, null);
  return normalized ? /^[a-z][a-z0-9+.-]*:/i.test(normalized) : false;
}

function defaultHostedHttpBaseUrl(engine) {
  return engine === HostedRuntimeEngine.BROWSER
    ? "https://browser.invalid"
    : "http://127.0.0.1";
}

function buildHostedHttpBindingUrl(pathOrUrl, options = {}) {
  const normalizedPathOrUrl = normalizeString(pathOrUrl, null);
  if (!normalizedPathOrUrl) {
    return null;
  }
  if (hasUriScheme(normalizedPathOrUrl)) {
    return normalizedPathOrUrl;
  }
  const baseUrl =
    normalizeString(options.httpBaseUrl, null) ??
    defaultHostedHttpBaseUrl(options.engine);
  try {
    return new URL(normalizedPathOrUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function buildHostedInterfaceResourceUrl(externalInterface = {}, options = {}) {
  const resource = normalizeString(externalInterface.resource, null);
  const path = normalizeString(externalInterface.path, null);
  const interfaceId =
    normalizeString(externalInterface.interfaceId, null) ?? "binding";

  if (externalInterface.kind === ExternalInterfaceKind.HTTP) {
    return buildHostedHttpBindingUrl(path ?? resource, options);
  }
  if (resource && hasUriScheme(resource)) {
    return resource;
  }

  switch (externalInterface.kind) {
    case ExternalInterfaceKind.TIMER:
    case ExternalInterfaceKind.SCHEDULE:
      return `schedule://${resource ?? interfaceId}`;
    case ExternalInterfaceKind.PIPE:
      return `pipe://${resource ?? interfaceId}`;
    case ExternalInterfaceKind.PROTOCOL:
      return null;
    default:
      return resource;
  }
}

function bindingDescriptionPrefix(bindingMode, noun) {
  const normalizedMode = normalizeBindingMode(bindingMode, null);
  if (!normalizedMode) {
    return noun;
  }
  return `${normalizedMode === DeploymentBindingMode.DELEGATED ? "Delegated" : "Local"} ${noun}`;
}

function buildHostedBindingDescription({
  externalInterface = null,
  bindingMode = null,
  noun = "binding",
} = {}) {
  const baseDescription = normalizeString(externalInterface?.description, null);
  const prefix = bindingDescriptionPrefix(bindingMode, noun);
  return baseDescription ? `${prefix}: ${baseDescription}` : prefix;
}

function normalizeProtocolRole(value, fallback = null) {
  return normalizeString(value, fallback)?.toLowerCase() ?? fallback;
}

function resolveInstallationProtocolId(installation = {}) {
  return normalizeString(installation?.protocolId, null);
}

function resolveTriggerProtocolId(trigger = {}) {
  return (
    normalizeString(trigger?.protocolId, null) ??
    normalizeString(trigger?.source, null)
  );
}

function protocolTriggerMatchesInstallation(trigger = {}, installation = {}) {
  const installationProtocolId = resolveInstallationProtocolId(installation);
  const triggerProtocolId = resolveTriggerProtocolId(trigger);
  return Boolean(
    installationProtocolId &&
      triggerProtocolId &&
      installationProtocolId === triggerProtocolId,
  );
}

function listProtocolInstallationTargetIds(installation = {}) {
  return [
    resolveInstallationProtocolId(installation),
    normalizeString(installation?.serviceName, null),
    normalizeString(installation?.nodeInfoUrl, null),
  ].filter(Boolean);
}

function extractTriggerOwners(externalInterface = {}) {
  return (Array.isArray(externalInterface.owners) ? externalInterface.owners : [])
    .filter((owner) => typeof owner === "string" && owner.startsWith("trigger:"))
    .map((owner) => owner.slice(8));
}

function resolveMatchingScheduleBinding(externalInterface, deploymentPlan) {
  const triggerIds = new Set(extractTriggerOwners(externalInterface));
  if (externalInterface.kind === ExternalInterfaceKind.TIMER) {
    const resource = normalizeString(externalInterface.resource, null);
    if (resource) {
      triggerIds.add(resource);
    }
    const interfaceId = normalizeString(externalInterface.interfaceId, null);
    if (interfaceId) {
      triggerIds.add(interfaceId);
    }
  }
  return (deploymentPlan?.scheduleBindings ?? []).find((binding) =>
    triggerIds.has(binding.triggerId),
  );
}

function resolveMatchingServiceBinding(externalInterface, deploymentPlan) {
  const triggerIds = new Set(extractTriggerOwners(externalInterface));
  const interfacePath =
    normalizeString(externalInterface.path, null) ??
    (externalInterface.kind === ExternalInterfaceKind.HTTP
      ? normalizeString(externalInterface.resource, null)
      : null);

  return (deploymentPlan?.serviceBindings ?? []).find((binding) => {
    if (
      normalizeString(binding.serviceKind, "")?.toLowerCase() !== "http-server"
    ) {
      return false;
    }
    if (binding.triggerId && triggerIds.has(binding.triggerId)) {
      return true;
    }
    return Boolean(
      interfacePath &&
        normalizeString(binding.routePath, null) === interfacePath,
    );
  });
}

function resolveMatchingProtocolInstallations(externalInterface, deploymentPlan) {
  const interfaceProtocolId =
    normalizeString(externalInterface.protocolId, null) ??
    normalizeString(externalInterface.resource, null);
  if (!interfaceProtocolId) {
    return [];
  }
  return (deploymentPlan?.protocolInstallations ?? []).filter(
    (installation) => installation.protocolId === interfaceProtocolId,
  );
}

function resolveHostedProtocolBindingUrl(installation = {}) {
  return (
    normalizeString(installation.nodeInfoUrl, null) ??
    normalizeString(installation.serviceName, null) ??
    null
  );
}

function createHostedBindingRecord(binding, bindingMap) {
  const key = [
    normalizeString(binding.bindingId, null) ?? "",
    normalizeString(binding.direction, null) ?? "",
    normalizeString(binding.transport, null) ?? "",
    normalizeString(binding.protocolId, null) ?? "",
    normalizeString(binding.url, null) ?? "",
    normalizeString(binding.audience, null) ?? "",
  ].join("::");
  if (!bindingMap.has(key)) {
    bindingMap.set(key, binding);
  }
}

function createHostedBindingsForDirection({
  externalInterface,
  bindingIdPrefix,
  direction,
  transport,
  url = null,
  protocolId = null,
  audience = null,
  description = null,
  required = true,
} = {}) {
  return {
    bindingId: `${bindingIdPrefix}:${direction}`,
    direction,
    transport,
    protocolId,
    audience,
    url,
    required,
    description,
  };
}

function createHostedBindingsForExternalInterface(
  externalInterface,
  { runtimeId, engine, deploymentPlan, httpBaseUrl } = {},
) {
  const directions = [];
  switch (externalInterface.direction) {
    case ExternalInterfaceDirection.INPUT:
      directions.push(HostedRuntimeBindingDirection.LISTEN);
      break;
    case ExternalInterfaceDirection.OUTPUT:
      directions.push(HostedRuntimeBindingDirection.DIAL);
      break;
    case ExternalInterfaceDirection.BIDIRECTIONAL:
      directions.push(
        HostedRuntimeBindingDirection.LISTEN,
        HostedRuntimeBindingDirection.DIAL,
      );
      break;
    default:
      return [];
  }

  const bindingIdPrefix =
    normalizeString(externalInterface.interfaceId, null) ??
    `${runtimeId}:${externalInterface.kind}`;
  const required = externalInterface.required !== false;

  switch (externalInterface.kind) {
    case ExternalInterfaceKind.TIMER:
    case ExternalInterfaceKind.SCHEDULE: {
      const scheduleBinding = resolveMatchingScheduleBinding(
        externalInterface,
        deploymentPlan,
      );
      return [
        createHostedBindingsForDirection({
          externalInterface,
          bindingIdPrefix:
            normalizeString(scheduleBinding?.scheduleId, null) ?? bindingIdPrefix,
          direction: HostedRuntimeBindingDirection.LISTEN,
          transport: HostedRuntimeTransport.SAME_APP,
          url: buildHostedInterfaceResourceUrl(externalInterface),
          description: buildHostedBindingDescription({
            externalInterface,
            bindingMode: scheduleBinding?.bindingMode ?? DeploymentBindingMode.DELEGATED,
            noun: "scheduler binding",
          }),
          required,
        }),
      ];
    }

    case ExternalInterfaceKind.HTTP: {
      const serviceBinding = resolveMatchingServiceBinding(
        externalInterface,
        deploymentPlan,
      );
      return directions.map((direction) =>
        createHostedBindingsForDirection({
          externalInterface,
          bindingIdPrefix:
            normalizeString(serviceBinding?.serviceId, null) ?? bindingIdPrefix,
          direction,
          transport: HostedRuntimeTransport.HTTP,
          url:
            direction === HostedRuntimeBindingDirection.LISTEN
              ? buildHostedHttpBindingUrl(
                  serviceBinding?.remoteUrl ??
                    serviceBinding?.routePath ??
                    externalInterface.path ??
                    externalInterface.resource,
                  {
                    httpBaseUrl,
                    engine,
                  },
                )
              : buildHostedHttpBindingUrl(
                  externalInterface.resource ?? externalInterface.path,
                  {
                    httpBaseUrl,
                    engine,
                  },
                ),
          description: buildHostedBindingDescription({
            externalInterface,
            bindingMode:
              serviceBinding?.bindingMode ??
              (direction === HostedRuntimeBindingDirection.LISTEN
                ? DeploymentBindingMode.DELEGATED
                : null),
            noun:
              direction === HostedRuntimeBindingDirection.LISTEN
                ? "HTTP listener binding"
                : "HTTP outbound binding",
          }),
          required,
        }),
      );
    }

    case ExternalInterfaceKind.PROTOCOL: {
      const protocolInstallations = resolveMatchingProtocolInstallations(
        externalInterface,
        deploymentPlan,
      );
      const defaultProtocolId =
        normalizeString(externalInterface.protocolId, null) ??
        normalizeString(externalInterface.resource, null);
      const bindings = [];

      for (const direction of directions) {
        const matchingInstallation =
          direction === HostedRuntimeBindingDirection.LISTEN
            ? protocolInstallations.find(
                (installation) =>
                  normalizeString(installation.role, null) === "handle",
              ) ?? protocolInstallations[0]
            : protocolInstallations.find(
                (installation) =>
                  normalizeString(installation.role, null) !== "handle",
              ) ?? protocolInstallations[0];

        bindings.push(
          createHostedBindingsForDirection({
            externalInterface,
            bindingIdPrefix,
            direction,
            transport: HostedRuntimeTransport.SDN_PROTOCOL,
            protocolId:
              normalizeString(matchingInstallation?.protocolId, null) ??
              defaultProtocolId,
            url: resolveHostedProtocolBindingUrl(matchingInstallation),
            audience:
              normalizeString(matchingInstallation?.peerId, null) ??
              normalizeString(matchingInstallation?.serviceName, null) ??
              (direction === HostedRuntimeBindingDirection.DIAL
                ? "sdn-peers"
                : null),
            description: buildHostedBindingDescription({
              externalInterface,
              noun:
                direction === HostedRuntimeBindingDirection.LISTEN
                  ? "protocol host binding"
                  : "protocol dial binding",
            }),
            required,
          }),
        );
      }

      return bindings;
    }

    case ExternalInterfaceKind.FILESYSTEM:
    case ExternalInterfaceKind.DATABASE:
    case ExternalInterfaceKind.HOST_SERVICE:
    case ExternalInterfaceKind.PIPE:
    case ExternalInterfaceKind.CONTEXT: {
      return directions.map((direction) =>
        createHostedBindingsForDirection({
          externalInterface,
          bindingIdPrefix,
          direction,
          transport: HostedRuntimeTransport.SAME_APP,
          url: buildHostedInterfaceResourceUrl(externalInterface, {
            httpBaseUrl,
            engine,
          }),
          description: buildHostedBindingDescription({
            externalInterface,
            noun: `${externalInterface.kind} binding`,
          }),
          required,
        }),
      );
    }

    case ExternalInterfaceKind.TCP:
    case ExternalInterfaceKind.UDP:
    case ExternalInterfaceKind.TLS:
    case ExternalInterfaceKind.WEBSOCKET:
    case ExternalInterfaceKind.MQTT:
    case ExternalInterfaceKind.NETWORK: {
      return directions.map((direction) =>
        createHostedBindingsForDirection({
          externalInterface,
          bindingIdPrefix,
          direction,
          transport: HostedRuntimeTransport.DIRECT,
          url: buildHostedInterfaceResourceUrl(externalInterface, {
            httpBaseUrl,
            engine,
          }),
          description: buildHostedBindingDescription({
            externalInterface,
            noun: `${externalInterface.kind} binding`,
          }),
          required,
        }),
      );
    }

    default:
      return [];
  }
}

function deriveHostedRuntimeBindings({
  runtimeId,
  requirements,
  deploymentPlan,
  engine,
  httpBaseUrl,
} = {}) {
  const bindingMap = new Map();
  for (const externalInterface of Array.isArray(requirements?.externalInterfaces)
    ? requirements.externalInterfaces
    : []) {
    for (const binding of createHostedBindingsForExternalInterface(externalInterface, {
      runtimeId,
      engine,
      deploymentPlan,
      httpBaseUrl,
    })) {
      createHostedBindingRecord(binding, bindingMap);
    }
  }
  return Array.from(bindingMap.values());
}

export function createInstalledFlowHostedRuntimePlan(options = {}) {
  const program = normalizeProgram(options.program ?? {});
  const requirements = summarizeProgramRequirements({
    program,
    manifests: options.manifests ?? [],
    registry: options.registry ?? null,
  });
  const runtimeId =
    options.runtimeId ?? `${program.programId ?? "flow-program"}:runtime`;
  const engine = options.engine ?? HostedRuntimeEngine.DENO;
  const deploymentPlan =
    options.deploymentPlan ??
    resolveInstalledFlowDeploymentPlan(program, {
      ...options,
      deploymentPlan: options.deploymentPlan ?? null,
    });

  return normalizeHostedRuntimePlan({
    hostId: options.hostId ?? "sdn-js-local",
    hostKind: options.hostKind ?? "sdn-js",
    adapter: options.adapter ?? HostedRuntimeAdapter.SDN_JS,
    engine,
    description:
      options.description ??
      `Auto-start flow host for ${program.programId ?? "flow-program"}.`,
    runtimes: [
      {
        runtimeId,
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
        runtimeTargets:
          options.runtimeTargets ??
          inferFlowRuntimeTargets({
            program,
            requirements,
            hostPlan: options.hostPlan ?? null,
            deploymentPlan,
          }),
        bindings:
          options.bindings ??
          deriveHostedRuntimeBindings({
            runtimeId,
            requirements,
            deploymentPlan,
            engine,
            httpBaseUrl: options.httpBaseUrl,
          }),
      },
    ],
  });
}

export function createInstalledFlowHost(options = {}) {
  const registry = options.registry ?? new MethodRegistry();
  const sinkEvents = [];
  const nodeOutputListeners = new Set();
  const triggerFrameListeners = new Set();
  const userOnSinkOutput =
    options.onSinkOutput ?? options.runtimeOptions?.onSinkOutput ?? null;
  let started = false;
  let discoveredPackages = [];
  let loadedPackages = [];
  let program =
    options.program !== undefined && options.program !== null
      ? normalizeProgram(options.program)
      : null;
  let runtimeState = null;

  function emitSinkEvent(event = {}) {
    const sinkEvent = {
      index: sinkEvents.length,
      ...event,
    };
    sinkEvents.push(sinkEvent);
    if (typeof userOnSinkOutput === "function") {
      userOnSinkOutput(sinkEvent);
    }
    return sinkEvent;
  }

  function subscribeRuntimeListener(listeners, listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function emitRuntimeEvent(listeners, event = {}) {
    for (const listener of listeners) {
      listener(event);
    }
    return event;
  }

  const runtime = {
    getProgram() {
      return runtimeState?.program ?? program ?? null;
    },
    getCompiledProgram() {
      return runtimeState?.compiledProgram ?? null;
    },
    getArtifact() {
      return runtimeState?.artifact ?? null;
    },
    getDeploymentPlan() {
      return runtimeState?.deploymentPlan ?? null;
    },
    enqueueTriggerFrames(triggerId, frames) {
      if (!runtimeState) {
        throw new Error(
          "Installed flow host has no compiled runtime. Call start() first.",
        );
      }
      return runtimeState.enqueueTriggerFrames(triggerId, frames);
    },
    enqueueNodeFrames() {
      throw new Error(
        "Installed flow host only supports trigger ingress for compiled runtime execution.",
      );
    },
    drain(drainOptions = {}) {
      if (!runtimeState) {
        throw new Error(
          "Installed flow host has no compiled runtime. Call start() first.",
        );
      }
      return runtimeState.drain(drainOptions);
    },
    isIdle() {
      return runtimeState ? runtimeState.isIdle() : true;
    },
    inspectQueues() {
      return runtimeState ? runtimeState.inspectQueues() : {};
    },
    resetRuntimeState() {
      if (runtimeState?.runtimeHost?.resetRuntimeState) {
        runtimeState.runtimeHost.resetRuntimeState();
      }
    },
  };

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
      runtimeTargets: runtimeState?.artifact
        ? listCompiledArtifactRuntimeTargets(runtimeState.artifact)
        : [],
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

    const nextDeploymentPlan = nextProgram
      ? resolveInstalledFlowDeploymentPlan(nextProgram, {
          ...options,
          ...refreshOptions,
          deploymentPlan:
            refreshOptions.deploymentPlan ?? options.deploymentPlan ?? null,
        })
      : null;
    const {
      compiledProgram: nextCompiledProgram,
      inputBindingRoutes,
    } = nextProgram
      ? prepareProgramInputBindingRoutes({
          program: nextProgram,
          deploymentPlan: nextDeploymentPlan,
          registry: validationRegistry,
        })
      : {
          compiledProgram: null,
          inputBindingRoutes: [],
        };

    let nextRuntimeState = null;
    if (nextProgram) {
      const nextArtifact = await compileInstalledFlowArtifact({
        program: nextCompiledProgram,
        manifests: nextLoadedPackages.map((loaded) => loaded.manifest),
        registry: validationRegistry,
        artifactOptions: {
          ...options,
          ...refreshOptions,
          artifact:
            refreshOptions.artifact ??
            options.artifact ??
            refreshOptions.compiledArtifact ??
            options.compiledArtifact ??
            refreshOptions.serializedArtifact ??
            options.serializedArtifact ??
            null,
          deploymentPlan: nextDeploymentPlan,
          hostPlan: refreshOptions.hostPlan ?? options.hostPlan ?? null,
          runtimeTargets:
            refreshOptions.runtimeTargets ??
            options.runtimeTargets ??
            nextProgram.runtimeTargets,
          pluginId:
            refreshOptions.pluginId ??
            options.pluginId ??
            nextProgram.programId ??
            null,
          version:
            refreshOptions.version ??
            options.version ??
            nextProgram.version ??
            null,
        },
      });

      assertInstalledArtifactRuntimeTargets({
        artifact: nextArtifact,
        program: nextProgram,
        hostPlan: refreshOptions.hostPlan ?? options.hostPlan ?? null,
      });

      nextRuntimeState = {
        program: nextProgram,
        compiledProgram: nextCompiledProgram,
        artifact: nextArtifact,
        deploymentPlan: nextDeploymentPlan,
        inputBindingRoutes,
        registry: validationRegistry,
        triggerBindings: groupBy(
          nextCompiledProgram.triggerBindings,
          (binding) => binding.triggerId,
        ),
        edgesBySource: groupBy(
          nextCompiledProgram.edges,
          (edge) => `${edge.fromNodeId}:${edge.fromPortId}`,
        ),
        envelopeQueues: new Map(),
        runtimeHost: null,
        enqueueEnvelope(nodeId, portId, frame, backpressurePolicy, queueDepth) {
          const queue = ensureEnvelopeQueue(this.envelopeQueues, nodeId, portId);
          applyQueueBackpressure(queue, frame, backpressurePolicy, queueDepth);
        },
        consumeInvocationInputs(nodeId, inputs = []) {
          return (Array.isArray(inputs) ? inputs : []).map((input) => {
            const queue =
              nodeId && input?.portId
                ? ensureEnvelopeQueue(this.envelopeQueues, nodeId, input.portId)
                : null;
            const envelope = queue?.shift() ?? null;
            const payload =
              input?.bytes instanceof Uint8Array
                ? input.bytes
                : normalizePayloadBytes(input?.bytes) ?? new Uint8Array();
            return {
              ...normalizeInstalledRuntimeFrame(
                {
                  ...input,
                  payload,
                  bytes: payload,
                },
                input?.portId ?? null,
              ),
              payload,
              bytes: payload,
              metadata:
                cloneJsonCompatibleValue(envelope?.metadata) ?? null,
              typeRef: cloneJsonCompatibleValue(envelope?.typeRef) ?? {},
              traceId: envelope?.traceId ?? null,
            };
          });
        },
        routeInvocationOutputs(nodeId, outputs = []) {
          for (const output of Array.isArray(outputs) ? outputs : []) {
            const normalizedOutput = cloneInstalledRuntimeFrame(output);
            emitRuntimeEvent(nodeOutputListeners, {
              nodeId,
              frame: cloneInstalledRuntimeFrame(normalizedOutput),
            });
            const sourceKey = `${nodeId}:${normalizedOutput.portId}`;
            const edges = this.edgesBySource.get(sourceKey) ?? [];
            if (edges.length === 0) {
              emitSinkEvent({
                nodeId,
                frame: normalizedOutput,
              });
              continue;
            }
            for (const edge of edges) {
              this.enqueueEnvelope(
                edge.toNodeId,
                edge.toPortId,
                {
                  ...cloneInstalledRuntimeFrame(
                    normalizedOutput,
                    edge.toPortId,
                  ),
                  portId: edge.toPortId,
                },
                edge.backpressurePolicy,
                edge.queueDepth,
              );
            }
          }
        },
        enqueueTriggerFrames(triggerId, frames) {
          const bindings = this.triggerBindings.get(triggerId) ?? [];
          if (bindings.length === 0) {
            throw new Error(
              `Trigger "${triggerId}" is not bound to any node input.`,
            );
          }
          const triggerIndex = this.compiledProgram.triggers.findIndex(
            (trigger) => trigger.triggerId === triggerId,
          );
          if (triggerIndex < 0) {
            throw new Error(`Unknown trigger "${triggerId}".`);
          }
          for (const frameInput of Array.isArray(frames) ? frames : [frames]) {
            const normalizedFrame = normalizeInstalledRuntimeFrame(frameInput);
            emitRuntimeEvent(triggerFrameListeners, {
              triggerId,
              frame: cloneInstalledRuntimeFrame(normalizedFrame),
            });
            for (const binding of bindings) {
              this.enqueueEnvelope(
                binding.targetNodeId,
                binding.targetPortId,
                {
                  ...cloneInstalledRuntimeFrame(
                    normalizedFrame,
                    binding.targetPortId,
                  ),
                  portId: binding.targetPortId,
                },
                binding.backpressurePolicy,
                binding.queueDepth,
              );
            }
            this.runtimeHost.enqueueTriggerFrame(
              triggerIndex,
              buildCompiledFrameInput(normalizedFrame),
            );
          }
        },
        async drain(drainOptions = {}) {
          const result = await this.runtimeHost.drain(
            translateDrainOptions(drainOptions),
          );
          return {
            invocations: result.iterations ?? 0,
            yielded: result.maxIterationsReached === true,
            idle: result.idle,
            executions: result.executions ?? [],
            maxIterationsReached: result.maxIterationsReached === true,
          };
        },
        isIdle() {
          for (const queue of this.envelopeQueues.values()) {
            if (queue.length > 0) {
              return false;
            }
          }
          const readyNodeSymbol = this.runtimeHost?.resolvedByRole?.readyNodeSymbol;
          if (typeof readyNodeSymbol !== "function") {
            return true;
          }
          return (Number(readyNodeSymbol() ?? 0xffffffff) >>> 0) === 0xffffffff;
        },
        inspectQueues() {
          return snapshotEnvelopeQueues(this.envelopeQueues);
        },
      };

      const handlers = {};
      for (const pluginRecord of validationRegistry.listPlugins()) {
        for (const methodId of pluginRecord.methods.keys()) {
          handlers[`${pluginRecord.pluginId}:${methodId}`] = async ({
            pluginId,
            methodId: invokedMethodId,
            dispatchDescriptor,
            inputs = [],
            outputStreamCap = 0,
          }) => {
            const nodeId = dispatchDescriptor?.nodeId ?? null;
            const adaptedInputs = nextRuntimeState.consumeInvocationInputs(
              nodeId,
              inputs,
            );
            const result = await validationRegistry.invoke({
              pluginId,
              methodId: invokedMethodId,
              inputs: adaptedInputs,
              outputStreamCap,
              context: {
                nodeId,
                programId: nextProgram.programId,
                internalTransport: true,
              },
            });
            nextRuntimeState.routeInvocationOutputs(nodeId, result.outputs ?? []);
            return result;
          };
        }
      }

      nextRuntimeState.runtimeHost =
        refreshOptions.runtimeHost ??
        options.runtimeHost ??
        options.runtime ??
        (await bindInstalledCompiledRuntimeHost({
          artifact: nextArtifact,
          handlers,
          runtimeOptions: {
            ...options.runtimeOptions,
            ...refreshOptions.runtimeOptions,
            ...options,
            ...refreshOptions,
          },
        }));
    }

    const previousRuntimeState = runtimeState;
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
    runtimeState = nextRuntimeState;
    if (refreshOptions.clearSinkOutputs === true) {
      sinkEvents.splice(0, sinkEvents.length);
    }
    await disposeInstalledCompiledRuntime(previousRuntimeState);
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
    getArtifact() {
      return runtime.getArtifact();
    },
    getDeploymentPlan() {
      return runtime.getDeploymentPlan();
    },
    getInputBindingRoutes() {
      return cloneJsonCompatibleValue(runtimeState?.inputBindingRoutes ?? []);
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
    subscribeNodeOutputs(listener) {
      return subscribeRuntimeListener(nodeOutputListeners, listener);
    },
    subscribeTriggerFrames(listener) {
      return subscribeRuntimeListener(triggerFrameListeners, listener);
    },
  };
}

export function createInstalledFlowService(options = {}) {
  const host = options.host ?? createInstalledFlowHost(options);
  const timerHandles = new Map();
  const authBaseDirectory =
    resolvePathLike(options.baseDirectory ?? options.cwd, process.cwd()) ??
    process.cwd();
  const configuredWalletProfiles = normalizeNamedRecordCollection(
    options.walletProfiles ?? options.auth?.walletProfiles,
    "walletProfileId",
    (value, inferredId) => ({
      walletProfileId:
        normalizeString(
          value?.walletProfileId ?? value?.profileId ?? inferredId,
          null,
        ) ?? null,
      recordPath: resolvePathLike(
        value?.recordPath ?? value?.walletRecordPath ?? value?.path,
        authBaseDirectory,
      ),
      allowPeerIds: toSortedUniqueStrings([
        value?.peerId,
        ...(value?.peerIds ?? []),
        ...(value?.allowPeerIds ?? []),
      ]),
      allowServerKeys: toSortedUniqueStrings([
        value?.serverKey,
        ...(value?.serverKeys ?? []),
        ...(value?.allowServerKeys ?? []),
      ]),
      allowEntityIds: toSortedUniqueStrings([
        value?.entityId,
        ...(value?.entityIds ?? []),
        ...(value?.allowEntityIds ?? []),
      ]),
      signingPublicKeyHex: normalizeString(
        value?.signingPublicKeyHex ?? value?.publicKeyHex,
        null,
      ),
    }),
  );
  const configuredTrustMaps = normalizeNamedRecordCollection(
    options.trustMaps ?? options.auth?.trustMaps,
    "trustMapId",
    (value, inferredId) => ({
      trustMapId:
        normalizeString(
          value?.trustMapId ?? value?.mapId ?? inferredId,
          null,
        ) ?? null,
      allowPeerIds: toSortedUniqueStrings([
        ...(value?.allowPeerIds ?? []),
      ]),
      allowServerKeys: toSortedUniqueStrings([
        ...(value?.allowServerKeys ?? []),
      ]),
      allowEntityIds: toSortedUniqueStrings([
        ...(value?.allowEntityIds ?? []),
      ]),
      walletProfileIds: toSortedUniqueStrings([
        value?.walletProfileId,
        ...(value?.walletProfileIds ?? []),
      ]),
    }),
  );
  const walletProfilesById = new Map(
    configuredWalletProfiles.map((profile) => [profile.walletProfileId, profile]),
  );
  const trustMapsById = new Map(
    configuredTrustMaps.map((trustMap) => [trustMap.trustMapId, trustMap]),
  );
  const walletProfileTrustCache = new Map();
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
  const publicationEvents = [];
  const userOnPublication = options.onPublication ?? null;
  let started = false;
  let verifiedBindingsPlan = null;
  let resolvedLocalAuthPoliciesById = new Map();

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

  function getDeploymentPlan() {
    return (
      host.getDeploymentPlan?.() ??
      resolveInstalledFlowDeploymentPlan(getProgram(), {
        ...options,
        deploymentPlan: options.deploymentPlan ?? null,
      })
    );
  }

  function filterBindingsByMode(bindings, mode) {
    return (Array.isArray(bindings) ? bindings : []).filter(
      (binding) =>
        normalizeBindingMode(
          binding?.bindingMode,
          DeploymentBindingMode.LOCAL,
        ) === mode,
    );
  }

  function listScheduleBindingsFromPlan(deploymentPlan) {
    return deploymentPlan?.scheduleBindings ?? [];
  }

  function listServiceBindingsFromPlan(deploymentPlan) {
    return deploymentPlan?.serviceBindings ?? [];
  }

  function listAuthPoliciesFromPlan(deploymentPlan) {
    return deploymentPlan?.authPolicies ?? [];
  }

  function listPublicationBindingsFromPlan(deploymentPlan) {
    return deploymentPlan?.publicationBindings ?? [];
  }

  function listInputBindingsFromPlan(deploymentPlan) {
    return deploymentPlan?.inputBindings ?? [];
  }

  function listProtocolInstallationsFromPlan(deploymentPlan) {
    return deploymentPlan?.protocolInstallations ?? [];
  }

  function listInputBindingRoutes() {
    return Array.isArray(host.getInputBindingRoutes?.())
      ? host.getInputBindingRoutes()
      : [];
  }

  function listLocalScheduleBindings() {
    return filterBindingsByMode(
      listScheduleBindingsFromPlan(getDeploymentPlan()),
      DeploymentBindingMode.LOCAL,
    );
  }

  function listScheduleBindings() {
    return listScheduleBindingsFromPlan(getDeploymentPlan());
  }

  function listLocalServiceBindings() {
    return filterBindingsByMode(
      listServiceBindingsFromPlan(getDeploymentPlan()),
      DeploymentBindingMode.LOCAL,
    );
  }

  function listServiceBindings() {
    return listServiceBindingsFromPlan(getDeploymentPlan());
  }

  function listLocalPublicationBindings() {
    return filterBindingsByMode(
      listPublicationBindingsFromPlan(getDeploymentPlan()),
      DeploymentBindingMode.LOCAL,
    );
  }

  function listHandleProtocolInstallations(deploymentPlan = getDeploymentPlan()) {
    return listProtocolInstallationsFromPlan(deploymentPlan).filter(
      (installation) =>
        normalizeProtocolRole(installation?.role, null) === "handle",
    );
  }

  function invalidateResolvedBindingCaches() {
    walletProfileTrustCache.clear();
    verifiedBindingsPlan = null;
    resolvedLocalAuthPoliciesById = new Map();
  }

  async function readWalletProfileRecord(profile) {
    if (!profile?.recordPath) {
      return null;
    }
    try {
      return await readJsonFile(profile.recordPath);
    } catch (error) {
      throw new Error(
        `Installed flow service could not read wallet profile "${profile.walletProfileId}" from "${profile.recordPath}": ${error?.message ?? error}`,
      );
    }
  }

  async function resolveWalletProfileTrust(profileId) {
    const normalizedProfileId = normalizeString(profileId, null);
    if (!normalizedProfileId) {
      return {
        allowPeerIds: [],
        allowServerKeys: [],
        allowEntityIds: [],
      };
    }
    const cachedTrust = walletProfileTrustCache.get(normalizedProfileId);
    if (cachedTrust) {
      return cachedTrust;
    }

    const profile = walletProfilesById.get(normalizedProfileId);
    if (!profile) {
      throw new Error(
        `Installed flow service cannot resolve wallet profile "${normalizedProfileId}" for local auth enforcement.`,
      );
    }

    const trustPromise = (async () => {
      const record = await readWalletProfileRecord(profile);
      const allowPeerIds = new Set(profile.allowPeerIds);
      const allowServerKeys = new Set();
      const allowEntityIds = new Set(profile.allowEntityIds);
      mergeServerKeySet(allowServerKeys, profile.allowServerKeys);
      mergeServerKeySet(allowServerKeys, [profile.signingPublicKeyHex]);
      mergeStringSet(allowPeerIds, [
        record?.peerId,
        ...(record?.peerIds ?? []),
      ]);
      mergeStringSet(allowEntityIds, [
        record?.entityId,
        ...(record?.entityIds ?? []),
      ]);
      mergeServerKeySet(allowServerKeys, [
        record?.serverKey,
        ...(record?.serverKeys ?? []),
        record?.signingPublicKeyHex,
      ]);
      return {
        allowPeerIds: sortStringSet(allowPeerIds),
        allowServerKeys: sortStringSet(allowServerKeys),
        allowEntityIds: sortStringSet(allowEntityIds),
      };
    })();

    walletProfileTrustCache.set(normalizedProfileId, trustPromise);
    return trustPromise;
  }

  async function resolveTrustMapTrust(trustMapId) {
    const normalizedTrustMapId = normalizeString(trustMapId, null);
    if (!normalizedTrustMapId) {
      return {
        allowPeerIds: [],
        allowServerKeys: [],
        allowEntityIds: [],
      };
    }
    const trustMap = trustMapsById.get(normalizedTrustMapId);
    if (!trustMap) {
      throw new Error(
        `Installed flow service cannot resolve trust map "${normalizedTrustMapId}" for local auth enforcement.`,
      );
    }
    const allowPeerIds = new Set(trustMap.allowPeerIds);
    const allowServerKeys = new Set();
    const allowEntityIds = new Set(trustMap.allowEntityIds);
    mergeServerKeySet(allowServerKeys, trustMap.allowServerKeys);

    for (const walletProfileId of trustMap.walletProfileIds) {
      const walletTrust = await resolveWalletProfileTrust(walletProfileId);
      mergeStringSet(allowPeerIds, walletTrust.allowPeerIds);
      mergeServerKeySet(allowServerKeys, walletTrust.allowServerKeys);
      mergeStringSet(allowEntityIds, walletTrust.allowEntityIds);
    }

    return {
      allowPeerIds: sortStringSet(allowPeerIds),
      allowServerKeys: sortStringSet(allowServerKeys),
      allowEntityIds: sortStringSet(allowEntityIds),
    };
  }

  async function resolveEffectiveLocalAuthPolicy(authPolicy) {
    const allowPeerIds = new Set(authPolicy.allowPeerIds ?? []);
    const allowServerKeys = new Set();
    const allowEntityIds = new Set(authPolicy.allowEntityIds ?? []);
    mergeServerKeySet(allowServerKeys, authPolicy.allowServerKeys ?? []);

    if (authPolicy.walletProfileId) {
      const walletTrust = await resolveWalletProfileTrust(authPolicy.walletProfileId);
      mergeStringSet(allowPeerIds, walletTrust.allowPeerIds);
      mergeServerKeySet(allowServerKeys, walletTrust.allowServerKeys);
      mergeStringSet(allowEntityIds, walletTrust.allowEntityIds);
    }
    if (authPolicy.trustMapId) {
      const trustMapTrust = await resolveTrustMapTrust(authPolicy.trustMapId);
      mergeStringSet(allowPeerIds, trustMapTrust.allowPeerIds);
      mergeServerKeySet(allowServerKeys, trustMapTrust.allowServerKeys);
      mergeStringSet(allowEntityIds, trustMapTrust.allowEntityIds);
    }

    return {
      ...authPolicy,
      allowPeerIds: sortStringSet(allowPeerIds),
      allowServerKeys: sortStringSet(allowServerKeys),
      allowEntityIds: sortStringSet(allowEntityIds),
    };
  }

  function resolveLocalAuthPoliciesForServiceBinding(
    serviceBinding,
    deploymentPlan = getDeploymentPlan(),
  ) {
    if (!serviceBinding) {
      return [];
    }
    const authPolicies = listAuthPoliciesFromPlan(deploymentPlan);
    const authPoliciesById = new Map(
      authPolicies
        .filter((policy) => typeof policy?.policyId === "string")
        .map((policy) => [policy.policyId, policy]),
    );
    const resolvedPolicies = [];
    const seenPolicyIds = new Set();
    const serviceId = normalizeString(serviceBinding.serviceId, null);
    const referencedPolicyId = normalizeString(serviceBinding.authPolicyId, null);

    if (referencedPolicyId) {
      const referencedPolicy = authPoliciesById.get(referencedPolicyId);
      if (!referencedPolicy) {
        throw new Error(
          `Installed flow service cannot resolve auth policy "${referencedPolicyId}" for local service binding "${serviceBinding.serviceId}".`,
        );
      }
      if (
        normalizeBindingMode(
          referencedPolicy.bindingMode,
          DeploymentBindingMode.LOCAL,
        ) !== DeploymentBindingMode.LOCAL
      ) {
        throw new Error(
          `Installed flow service cannot enforce delegated auth policy "${referencedPolicyId}" on local service binding "${serviceBinding.serviceId}".`,
        );
      }
      resolvedPolicies.push(referencedPolicy);
      seenPolicyIds.add(referencedPolicy.policyId);
    }

    for (const policy of filterBindingsByMode(
      authPolicies,
      DeploymentBindingMode.LOCAL,
    )) {
      const targetKind = normalizeString(policy.targetKind, null)?.toLowerCase();
      if (targetKind !== "service" && targetKind !== "http-service") {
        continue;
      }
      const targetId = normalizeString(policy.targetId, null);
      if (targetId && serviceId && targetId !== serviceId) {
        continue;
      }
      if (seenPolicyIds.has(policy.policyId)) {
        continue;
      }
      resolvedPolicies.push(policy);
      seenPolicyIds.add(policy.policyId);
    }

    return resolvedPolicies;
  }

  function resolveEffectiveLocalAuthPoliciesForServiceBinding(
    serviceBinding,
    deploymentPlan = getDeploymentPlan(),
  ) {
    return resolveLocalAuthPoliciesForServiceBinding(
      serviceBinding,
      deploymentPlan,
    ).map(
      (policy) => resolvedLocalAuthPoliciesById.get(policy.policyId) ?? policy,
    );
  }

  function resolveLocalAuthPoliciesForProtocolInstallation(
    installation,
    deploymentPlan = getDeploymentPlan(),
  ) {
    if (!installation) {
      return [];
    }
    const authPolicies = listAuthPoliciesFromPlan(deploymentPlan);
    const installationTargetIds = new Set(
      listProtocolInstallationTargetIds(installation),
    );
    return filterBindingsByMode(authPolicies, DeploymentBindingMode.LOCAL).filter(
      (policy) => {
        const targetKind = normalizeString(policy.targetKind, null)?.toLowerCase();
        if (targetKind !== "protocol" && targetKind !== "protocol-service") {
          return false;
        }
        const targetId = normalizeString(policy.targetId, null);
        return !targetId || installationTargetIds.has(targetId);
      },
    );
  }

  function resolveEffectiveLocalAuthPoliciesForProtocolInstallation(
    installation,
    deploymentPlan = getDeploymentPlan(),
  ) {
    return resolveLocalAuthPoliciesForProtocolInstallation(
      installation,
      deploymentPlan,
    ).map(
      (policy) => resolvedLocalAuthPoliciesById.get(policy.policyId) ?? policy,
    );
  }

  function resolveRequestSecurityContext(request = {}) {
    const headers = normalizeHeaderRecord(request.headers);
    const metadata = normalizeMetadata(request.metadata);
    const forwardedProtocol = normalizeString(
      headers["x-forwarded-proto"] ?? headers["x-sdn-forwarded-proto"],
      null,
    )?.toLowerCase();
    const metadataUrl =
      normalizeString(
        metadata.url ?? metadata.href ?? metadata.origin ?? request.url,
        null,
      ) ?? null;
    let requestProtocol = null;
    if (metadataUrl) {
      try {
        requestProtocol = new URL(metadataUrl).protocol.replace(/:$/, "");
      } catch {
        requestProtocol = null;
      }
    }

    return {
      peerId:
        normalizeString(
          metadata.peerId ??
            metadata.peer_id ??
            request.peerId ??
            request.peer_id ??
            headers["x-sdn-peer-id"] ??
            headers["x-peer-id"],
          null,
        ) ?? null,
      serverKey:
        normalizeString(
          metadata.serverKey ??
            metadata.server_key ??
            request.serverKey ??
            request.server_key ??
            headers["x-sdn-server-key"] ??
            headers["x-server-key"],
          null,
        ) ?? null,
      entityId:
        normalizeString(
          metadata.entityId ??
            metadata.entity_id ??
            request.entityId ??
            request.entity_id ??
            headers["x-sdn-entity-id"] ??
            headers["x-entity-id"],
          null,
        ) ?? null,
      signedRequest: normalizeBooleanLike(
        metadata.signedRequest ??
          metadata.signed_request ??
          request.signedRequest ??
          request.signed_request ??
          headers["x-sdn-signed-request"] ??
          headers["x-signed-request"],
        false,
      ),
      encryptedTransport:
        normalizeBooleanLike(
          metadata.encryptedTransport ??
            metadata.encrypted_transport ??
            request.encryptedTransport ??
            request.encrypted_transport ??
            headers["x-sdn-encrypted-transport"],
          false,
        ) ||
        forwardedProtocol === "https" ||
        forwardedProtocol === "wss" ||
        requestProtocol === "https" ||
        requestProtocol === "wss",
    };
  }

  function isAllowedServerKey(allowedValues, requestedValue) {
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
      return true;
    }
    const allowedAliases = new Set();
    mergeServerKeySet(allowedAliases, allowedValues);
    return normalizeServerKeyAliases(requestedValue).some((value) =>
      allowedAliases.has(value),
    );
  }

  async function assertLocalHttpRequestAuthorized(serviceBinding, request = {}) {
    await assertSupportedLocalBindings();
    const authPolicies = resolveEffectiveLocalAuthPoliciesForServiceBinding(
      serviceBinding,
    );
    if (authPolicies.length === 0) {
      return;
    }
    const securityContext = resolveRequestSecurityContext(request);

    for (const authPolicy of authPolicies) {
      if (
        authPolicy.requireEncryptedTransport &&
        !securityContext.encryptedTransport
      ) {
        throw createHttpStatusError(
          403,
          `HTTP service "${serviceBinding.serviceId}" requires encrypted transport by auth policy "${authPolicy.policyId}".`,
          {
            code: "encrypted-transport-required",
          },
        );
      }
      if (authPolicy.requireSignedRequests && !securityContext.signedRequest) {
        throw createHttpStatusError(
          403,
          `HTTP service "${serviceBinding.serviceId}" requires signed requests by auth policy "${authPolicy.policyId}".`,
          {
            code: "signed-request-required",
          },
        );
      }
      if (
        authPolicy.allowPeerIds.length > 0 &&
        !authPolicy.allowPeerIds.includes(securityContext.peerId ?? "")
      ) {
        throw createHttpStatusError(
          403,
          `HTTP service "${serviceBinding.serviceId}" rejected an unapproved peer id under auth policy "${authPolicy.policyId}".`,
          {
            code: "peer-id-not-approved",
          },
        );
      }
      if (
        authPolicy.allowServerKeys.length > 0 &&
        !isAllowedServerKey(
          authPolicy.allowServerKeys,
          securityContext.serverKey ?? "",
        )
      ) {
        throw createHttpStatusError(
          403,
          `HTTP service "${serviceBinding.serviceId}" rejected an unapproved server key under auth policy "${authPolicy.policyId}".`,
          {
            code: "server-key-not-approved",
          },
        );
      }
      if (
        authPolicy.allowEntityIds.length > 0 &&
        !authPolicy.allowEntityIds.includes(securityContext.entityId ?? "")
      ) {
        throw createHttpStatusError(
          403,
          `HTTP service "${serviceBinding.serviceId}" rejected an unapproved entity id under auth policy "${authPolicy.policyId}".`,
          {
            code: "entity-id-not-approved",
          },
        );
      }
    }
  }

  async function assertLocalProtocolRequestAuthorized(
    installation,
    request = {},
  ) {
    await assertSupportedLocalBindings();
    const authPolicies =
      resolveEffectiveLocalAuthPoliciesForProtocolInstallation(installation);
    if (authPolicies.length === 0) {
      return;
    }
    const securityContext = resolveRequestSecurityContext(request);
    const protocolLabel =
      normalizeString(installation?.serviceName, null) ??
      resolveInstallationProtocolId(installation) ??
      "protocol";

    for (const authPolicy of authPolicies) {
      if (
        authPolicy.requireEncryptedTransport &&
        !securityContext.encryptedTransport
      ) {
        throw createHttpStatusError(
          403,
          `Protocol service "${protocolLabel}" requires encrypted transport by auth policy "${authPolicy.policyId}".`,
          {
            code: "encrypted-transport-required",
          },
        );
      }
      if (authPolicy.requireSignedRequests && !securityContext.signedRequest) {
        throw createHttpStatusError(
          403,
          `Protocol service "${protocolLabel}" requires signed requests by auth policy "${authPolicy.policyId}".`,
          {
            code: "signed-request-required",
          },
        );
      }
      if (
        authPolicy.allowPeerIds.length > 0 &&
        !authPolicy.allowPeerIds.includes(securityContext.peerId ?? "")
      ) {
        throw createHttpStatusError(
          403,
          `Protocol service "${protocolLabel}" rejected an unapproved peer id under auth policy "${authPolicy.policyId}".`,
          {
            code: "peer-id-not-approved",
          },
        );
      }
      if (
        authPolicy.allowServerKeys.length > 0 &&
        !isAllowedServerKey(
          authPolicy.allowServerKeys,
          securityContext.serverKey ?? "",
        )
      ) {
        throw createHttpStatusError(
          403,
          `Protocol service "${protocolLabel}" rejected an unapproved server key under auth policy "${authPolicy.policyId}".`,
          {
            code: "server-key-not-approved",
          },
        );
      }
      if (
        authPolicy.allowEntityIds.length > 0 &&
        !authPolicy.allowEntityIds.includes(securityContext.entityId ?? "")
      ) {
        throw createHttpStatusError(
          403,
          `Protocol service "${protocolLabel}" rejected an unapproved entity id under auth policy "${authPolicy.policyId}".`,
          {
            code: "entity-id-not-approved",
          },
        );
      }
    }
  }

  function buildDeploymentBindingSummary(deploymentPlan = getDeploymentPlan()) {
    return {
      schedules: {
        local: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listScheduleBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.LOCAL,
          ),
        ),
        delegated: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listScheduleBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.DELEGATED,
          ),
        ),
      },
      services: {
        local: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listServiceBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.LOCAL,
          ),
        ),
        delegated: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listServiceBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.DELEGATED,
          ),
        ),
      },
      authPolicies: {
        local: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listAuthPoliciesFromPlan(deploymentPlan),
            DeploymentBindingMode.LOCAL,
          ),
        ),
        delegated: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listAuthPoliciesFromPlan(deploymentPlan),
            DeploymentBindingMode.DELEGATED,
          ),
        ),
      },
      publications: {
        local: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listPublicationBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.LOCAL,
          ),
        ),
        delegated: cloneJsonCompatibleValue(
          filterBindingsByMode(
            listPublicationBindingsFromPlan(deploymentPlan),
            DeploymentBindingMode.DELEGATED,
          ),
        ),
      },
      inputBindings: cloneJsonCompatibleValue(
        listInputBindingsFromPlan(deploymentPlan),
      ),
      protocolInstallations: cloneJsonCompatibleValue(
        listProtocolInstallationsFromPlan(deploymentPlan),
      ),
    };
  }

  function findProgramNode(nodeId) {
    return (
      getProgram().nodes.find((candidate) => candidate.nodeId === nodeId) ?? null
    );
  }

  function listProgramNodesByMethodId(methodId) {
    return getProgram().nodes.filter((candidate) => candidate.methodId === methodId);
  }

  function resolveMethodInputPorts(node) {
    if (!node) {
      return [];
    }
    const methodDescriptor = host.registry?.getMethod(node.pluginId, node.methodId);
    return Array.isArray(methodDescriptor?.method?.inputPorts)
      ? methodDescriptor.method.inputPorts
      : [];
  }

  function resolveMethodOutputPorts(node) {
    if (!node) {
      return [];
    }
    const methodDescriptor = host.registry?.getMethod(node.pluginId, node.methodId);
    return Array.isArray(methodDescriptor?.method?.outputPorts)
      ? methodDescriptor.method.outputPorts
      : [];
  }

  function buildPublicationSourceForNodeOutput(nodeId, frame = {}) {
    const node = findProgramNode(nodeId);
    return {
      nodeId,
      pluginId: node?.pluginId ?? null,
      methodId: node?.methodId ?? null,
      portId: normalizeString(frame.portId, null),
      triggerId: null,
    };
  }

  function buildPublicationSourceForTrigger(triggerId, frame = {}) {
    return {
      nodeId: null,
      pluginId: null,
      methodId: null,
      portId: normalizeString(frame.portId, null),
      triggerId,
    };
  }

  function emitPublicationEvent({ binding, source, frame } = {}) {
    const publicationEvent = {
      index: publicationEvents.length,
      publicationId: binding?.publicationId ?? null,
      bindingMode: binding?.bindingMode ?? null,
      sourceKind: binding?.sourceKind ?? null,
      source: cloneJsonCompatibleValue(source) ?? null,
      binding: cloneJsonCompatibleValue(binding) ?? null,
      frame: frame ? cloneInstalledRuntimeFrame(frame) : null,
    };
    publicationEvents.push(publicationEvent);
    if (typeof userOnPublication === "function") {
      userOnPublication(publicationEvent);
    }
    return publicationEvent;
  }

  function matchesNodeOutputPublicationBinding(binding, nodeId, frame = {}) {
    if (normalizeString(binding?.sourceTriggerId, null)) {
      return false;
    }
    const expectedNodeId = normalizeString(binding?.sourceNodeId, null);
    if (expectedNodeId && expectedNodeId !== nodeId) {
      return false;
    }
    const expectedMethodId = normalizeString(binding?.sourceMethodId, null);
    const node = findProgramNode(nodeId);
    if (expectedMethodId && expectedMethodId !== node?.methodId) {
      return false;
    }
    const expectedPortId = normalizeString(binding?.sourceOutputPortId, null);
    if (expectedPortId && expectedPortId !== normalizeString(frame?.portId, null)) {
      return false;
    }
    return Boolean(expectedNodeId || expectedMethodId);
  }

  function matchesTriggerPublicationBinding(binding, triggerId) {
    const expectedTriggerId = normalizeString(binding?.sourceTriggerId, null);
    if (!expectedTriggerId || expectedTriggerId !== triggerId) {
      return false;
    }
    if (
      normalizeString(binding?.sourceNodeId, null) ||
      normalizeString(binding?.sourceMethodId, null) ||
      normalizeString(binding?.sourceOutputPortId, null)
    ) {
      return false;
    }
    return true;
  }

  function captureNodeOutputPublications(event = {}) {
    const nodeId = normalizeString(event.nodeId, null);
    if (!nodeId) {
      return;
    }
    for (const binding of listLocalPublicationBindings()) {
      if (!matchesNodeOutputPublicationBinding(binding, nodeId, event.frame)) {
        continue;
      }
      emitPublicationEvent({
        binding,
        source: buildPublicationSourceForNodeOutput(nodeId, event.frame),
        frame: event.frame,
      });
    }
  }

  function captureTriggerPublications(event = {}) {
    const triggerId = normalizeString(event.triggerId, null);
    if (!triggerId) {
      return;
    }
    for (const binding of listLocalPublicationBindings()) {
      if (!matchesTriggerPublicationBinding(binding, triggerId)) {
        continue;
      }
      emitPublicationEvent({
        binding,
        source: buildPublicationSourceForTrigger(triggerId, event.frame),
        frame: event.frame,
      });
    }
  }

  async function assertSupportedLocalBindings(deploymentPlan = getDeploymentPlan()) {
    if (verifiedBindingsPlan === deploymentPlan) {
      return;
    }
    const localScheduleBindings = filterBindingsByMode(
      listScheduleBindingsFromPlan(deploymentPlan),
      DeploymentBindingMode.LOCAL,
    );
    for (const scheduleBinding of localScheduleBindings) {
      if (!normalizeString(scheduleBinding.triggerId, null)) {
        throw new Error(
          `Installed flow service cannot auto-start local schedule binding "${scheduleBinding.scheduleId}" because method-target schedules are not supported in the local host path.`,
        );
      }
    }

    const localServiceBindings = filterBindingsByMode(
      listServiceBindingsFromPlan(deploymentPlan),
      DeploymentBindingMode.LOCAL,
    );
    const localServiceIds = new Set(
      localServiceBindings
        .map((binding) => normalizeString(binding.serviceId, null))
        .filter(Boolean),
    );
    for (const serviceBinding of localServiceBindings) {
      if (
        normalizeString(serviceBinding.serviceKind, "")?.toLowerCase() !==
        "http-server"
      ) {
        throw new Error(
          `Installed flow service cannot host local service binding "${serviceBinding.serviceId}" because only http-server bindings are supported in the local host path.`,
        );
      }
      if (!normalizeString(serviceBinding.triggerId, null)) {
        throw new Error(
          `Installed flow service cannot host local service binding "${serviceBinding.serviceId}" without a triggerId.`,
        );
      }
      resolveLocalAuthPoliciesForServiceBinding(serviceBinding, deploymentPlan);
    }

    const protocolTriggers = listTriggersByKind(TriggerKind.PROTOCOL_REQUEST);
    const localHandleProtocolInstallations =
      listHandleProtocolInstallations(deploymentPlan);
    const localProtocolTargetIds = new Set(
      protocolTriggers
        .map((trigger) => resolveTriggerProtocolId(trigger))
        .filter(Boolean),
    );
    for (const installation of localHandleProtocolInstallations) {
      for (const targetId of listProtocolInstallationTargetIds(installation)) {
        localProtocolTargetIds.add(targetId);
      }
    }

    const nextResolvedLocalAuthPoliciesById = new Map();
    for (const authPolicy of filterBindingsByMode(
      listAuthPoliciesFromPlan(deploymentPlan),
      DeploymentBindingMode.LOCAL,
    )) {
      const targetKind = normalizeString(authPolicy.targetKind, "")?.toLowerCase();
      if (
        targetKind !== "service" &&
        targetKind !== "http-service" &&
        targetKind !== "protocol" &&
        targetKind !== "protocol-service"
      ) {
        throw new Error(
          `Installed flow service cannot enforce local auth policy "${authPolicy.policyId}" for targetKind "${authPolicy.targetKind}".`,
        );
      }
      const targetId = normalizeString(authPolicy.targetId, null);
      if (targetKind === "service" || targetKind === "http-service") {
        if (targetId && !localServiceIds.has(targetId)) {
          throw new Error(
            `Installed flow service cannot enforce local auth policy "${authPolicy.policyId}" because targetId "${targetId}" is not a local HTTP service binding.`,
          );
        }
      } else if (targetId && !localProtocolTargetIds.has(targetId)) {
        throw new Error(
          `Installed flow service cannot enforce local auth policy "${authPolicy.policyId}" because targetId "${targetId}" is not a local protocol surface.`,
        );
      }
      nextResolvedLocalAuthPoliciesById.set(
        authPolicy.policyId,
        await resolveEffectiveLocalAuthPolicy(authPolicy),
      );
    }

    const localPublicationBindings = filterBindingsByMode(
      listPublicationBindingsFromPlan(deploymentPlan),
      DeploymentBindingMode.LOCAL,
    );
    if (
      localPublicationBindings.length > 0 &&
      (typeof host.subscribeNodeOutputs !== "function" ||
        typeof host.subscribeTriggerFrames !== "function")
    ) {
      throw new Error(
        "Installed flow service cannot host local publicationBindings because the host does not expose publication event subscriptions.",
      );
    }
    for (const binding of localPublicationBindings) {
      const sourceTriggerId = normalizeString(binding.sourceTriggerId, null);
      const sourceNodeId = normalizeString(binding.sourceNodeId, null);
      const sourceMethodId = normalizeString(binding.sourceMethodId, null);
      const sourceOutputPortId = normalizeString(binding.sourceOutputPortId, null);

      if (sourceTriggerId) {
        const trigger = getProgram().triggers.find(
          (candidate) => candidate.triggerId === sourceTriggerId,
        );
        if (!trigger) {
          throw new Error(
            `Installed flow service cannot host local publication binding "${binding.publicationId}" because trigger "${sourceTriggerId}" is not present in the program.`,
          );
        }
      }

      if (sourceNodeId) {
        const node = findProgramNode(sourceNodeId);
        if (!node) {
          throw new Error(
            `Installed flow service cannot host local publication binding "${binding.publicationId}" because node "${sourceNodeId}" is not present in the program.`,
          );
        }
        if (sourceMethodId && sourceMethodId !== node.methodId) {
          throw new Error(
            `Installed flow service cannot host local publication binding "${binding.publicationId}" because node "${sourceNodeId}" does not use method "${sourceMethodId}".`,
          );
        }
        if (sourceOutputPortId) {
          const outputPorts = resolveMethodOutputPorts(node);
          if (!outputPorts.some((port) => port?.portId === sourceOutputPortId)) {
            throw new Error(
              `Installed flow service cannot host local publication binding "${binding.publicationId}" because node "${sourceNodeId}" does not declare output port "${sourceOutputPortId}".`,
            );
          }
        }
        continue;
      }

      if (sourceMethodId) {
        const matchingNodes = listProgramNodesByMethodId(sourceMethodId);
        if (matchingNodes.length === 0) {
          throw new Error(
            `Installed flow service cannot host local publication binding "${binding.publicationId}" because no program node uses method "${sourceMethodId}".`,
          );
        }
        if (
          sourceOutputPortId &&
          !matchingNodes.some((node) =>
            resolveMethodOutputPorts(node).some(
              (port) => port?.portId === sourceOutputPortId,
            ),
          )
        ) {
          throw new Error(
            `Installed flow service cannot host local publication binding "${binding.publicationId}" because no matching method output port "${sourceOutputPortId}" is present in the program.`,
          );
        }
      }
    }

    const inputBindingRoutesById = new Map(
      listInputBindingRoutes().map((route) => [route.bindingId, route]),
    );
    for (const binding of listInputBindingsFromPlan(deploymentPlan)) {
      const bindingId = normalizeString(binding?.bindingId, null);
      const route = bindingId ? inputBindingRoutesById.get(bindingId) : null;
      if (!route) {
        throw new Error(
          `Installed flow service cannot host input binding "${bindingId ?? "binding"}" because no matching program nodes were compiled for target method "${binding?.targetMethodId ?? "<unknown>"}".`,
        );
      }
      if (route.targetNodes.length === 0) {
        throw new Error(
          `Installed flow service cannot host input binding "${bindingId}" because no program nodes match target method "${binding.targetMethodId}".`,
        );
      }
      const missingPortTargets = route.targetNodes.filter(
        (targetNode) => targetNode.inputPortFound !== true,
      );
      if (missingPortTargets.length > 0) {
        throw new Error(
          `Installed flow service cannot host input binding "${bindingId}" because target input port "${binding.targetInputPortId}" is not declared on node ${missingPortTargets
            .map((targetNode) => `"${targetNode.nodeId}"`)
            .join(", ")}.`,
        );
      }
    }

    const protocolInstallations = listProtocolInstallationsFromPlan(
      deploymentPlan,
    );
    for (const installation of protocolInstallations) {
      if (normalizeProtocolRole(installation?.role, null) !== "handle") {
        continue;
      }
      if (
        !protocolTriggers.some((trigger) =>
          protocolTriggerMatchesInstallation(trigger, installation),
        )
      ) {
        throw new Error(
          `Installed flow service cannot host local protocol installation "${resolveInstallationProtocolId(installation) ?? "protocol"}" because no matching protocol-request trigger is present in the program.`,
        );
      }
    }

    resolvedLocalAuthPoliciesById = nextResolvedLocalAuthPoliciesById;
    verifiedBindingsPlan = deploymentPlan;
  }

  function resolveHttpTrigger(request = {}) {
    const program = getProgram();
    const requestedTriggerId = normalizeString(request.triggerId, null);
    const requestedPath = normalizeString(request.path, null);
    const requestedMethod = (
      normalizeString(request.method, "GET") ?? "GET"
    ).toUpperCase();
    const serviceBindings = listServiceBindings();
    const localServiceBindings = listLocalServiceBindings();
    const localBindingsByTriggerId = new Map(
      localServiceBindings.map((binding) => [binding.triggerId, binding]),
    );
    let trigger = program.triggers.find((candidate) => {
      if (candidate.kind !== TriggerKind.HTTP_REQUEST) {
        return false;
      }
      const binding = localBindingsByTriggerId.get(candidate.triggerId);
      if (serviceBindings.length > 0 && !binding) {
        return false;
      }
      if (requestedTriggerId) {
        return candidate.triggerId === requestedTriggerId;
      }
      const routePath =
        normalizeString(binding?.routePath, null) ??
        normalizeString(candidate.source, null);
      if (routePath !== requestedPath) {
        return false;
      }
      if (!binding?.method) {
        return true;
      }
      return binding.method.toUpperCase() === requestedMethod;
    });
    if (!trigger && !requestedTriggerId && requestedPath) {
      trigger = program.triggers.find((candidate) => {
        if (candidate.kind !== TriggerKind.HTTP_REQUEST) {
          return false;
        }
        const binding = localBindingsByTriggerId.get(candidate.triggerId);
        if (serviceBindings.length > 0 && !binding) {
          return false;
        }
        const routePath =
          normalizeString(binding?.routePath, null) ??
          normalizeString(candidate.source, null);
        return routePath === requestedPath;
      });
    }
    if (!trigger) {
      throw createHttpStatusError(
        404,
        `No HTTP trigger matches ${requestedTriggerId ?? requestedPath ?? "<unknown>"}.`,
        {
          code: "http-trigger-not-found",
        },
      );
    }
    return {
      trigger,
      binding: localBindingsByTriggerId.get(trigger.triggerId) ?? null,
    };
  }

  function protocolInstallationMatchesRequest(installation, request = {}) {
    const requestedProtocolId = normalizeString(request.protocolId, null);
    const requestedServiceName = normalizeString(request.serviceName, null);
    const requestedNodeInfoUrl = normalizeString(request.nodeInfoUrl, null);
    if (
      requestedProtocolId &&
      resolveInstallationProtocolId(installation) !== requestedProtocolId
    ) {
      return false;
    }
    if (
      requestedServiceName &&
      normalizeString(installation?.serviceName, null) !== requestedServiceName
    ) {
      return false;
    }
    if (
      requestedNodeInfoUrl &&
      normalizeString(installation?.nodeInfoUrl, null) !== requestedNodeInfoUrl
    ) {
      return false;
    }
    return true;
  }

  function resolveProtocolTrigger(request = {}) {
    const protocolTriggers = listTriggersByKind(TriggerKind.PROTOCOL_REQUEST);
    const requestedTriggerId = normalizeString(request.triggerId, null);
    const requestedProtocolId = normalizeString(request.protocolId, null);
    const handleInstallations = listHandleProtocolInstallations();
    const matchingInstallations =
      handleInstallations.length > 0
        ? handleInstallations.filter((installation) =>
            protocolInstallationMatchesRequest(installation, request),
          )
        : [];

    if (handleInstallations.length > 0 && matchingInstallations.length === 0) {
      throw createHttpStatusError(
        404,
        `No local protocol installation matches "${requestedProtocolId ?? requestedTriggerId ?? "request"}".`,
        {
          code: "protocol-installation-not-found",
        },
      );
    }

    const candidateTriggers = protocolTriggers.filter((trigger) => {
      if (requestedTriggerId && trigger.triggerId !== requestedTriggerId) {
        return false;
      }
      if (
        requestedProtocolId &&
        resolveTriggerProtocolId(trigger) !== requestedProtocolId
      ) {
        return false;
      }
      if (matchingInstallations.length === 0) {
        return true;
      }
      return matchingInstallations.some((installation) =>
        protocolTriggerMatchesInstallation(trigger, installation),
      );
    });

    if (candidateTriggers.length === 0) {
      throw createHttpStatusError(
        404,
        `No local protocol trigger matches "${requestedProtocolId ?? requestedTriggerId ?? "request"}".`,
        {
          code: "protocol-trigger-not-found",
        },
      );
    }
    if (!requestedTriggerId && candidateTriggers.length > 1) {
      throw createHttpStatusError(
        400,
        `Protocol request "${requestedProtocolId ?? "request"}" matches multiple local triggers. Specify triggerId explicitly.`,
        {
          code: "protocol-trigger-ambiguous",
        },
      );
    }

    const trigger = candidateTriggers[0];
    return {
      trigger,
      installation:
        matchingInstallations.find((installation) =>
          protocolTriggerMatchesInstallation(trigger, installation),
        ) ?? {
          protocolId: resolveTriggerProtocolId(trigger),
        },
    };
  }

  function listProtocolRequestFrames(request = {}) {
    if (Array.isArray(request.frames) && request.frames.length > 0) {
      return request.frames;
    }
    if (request.frame && typeof request.frame === "object") {
      return [request.frame];
    }
    return [request];
  }

  function buildProtocolRequestTriggerFrame(
    trigger,
    input = {},
    installation = null,
  ) {
    const protocolId =
      normalizeString(input.protocolId, null) ??
      resolveInstallationProtocolId(installation) ??
      resolveTriggerProtocolId(trigger);
    const requestId =
      normalizeString(input.requestId, null) ??
      `protocol:${protocolId ?? trigger.triggerId}:${Date.now()}`;
    return buildBaseTriggerFrame(trigger, {
      ...input,
      traceId: input.traceId ?? requestId,
      sequence: input.sequence ?? 1,
      payload: input.payload ?? input.body ?? null,
      metadata: {
        requestId,
        protocolId,
        peerId:
          normalizeString(input.peerId, null) ??
          normalizeString(input.metadata?.peerId, null) ??
          null,
        serverKey:
          normalizeString(input.serverKey, null) ??
          normalizeString(input.metadata?.serverKey, null) ??
          null,
        entityId:
          normalizeString(input.entityId, null) ??
          normalizeString(input.metadata?.entityId, null) ??
          null,
        signedRequest: normalizeBooleanLike(
          input.signedRequest ?? input.metadata?.signedRequest,
          false,
        ),
        encryptedTransport: normalizeBooleanLike(
          input.encryptedTransport ?? input.metadata?.encryptedTransport,
          false,
        ),
        serviceName:
          normalizeString(input.serviceName, null) ??
          normalizeString(installation?.serviceName, null),
        nodeInfoUrl:
          normalizeString(input.nodeInfoUrl, null) ??
          normalizeString(installation?.nodeInfoUrl, null),
        listenMultiaddrs: cloneJsonCompatibleValue(
          input.listenMultiaddrs ?? installation?.listenMultiaddrs ?? [],
        ),
        advertisedMultiaddrs: cloneJsonCompatibleValue(
          input.advertisedMultiaddrs ?? installation?.advertisedMultiaddrs ?? [],
        ),
        description: trigger.description ?? null,
        ...(input.metadata ?? {}),
      },
    });
  }

  function listInputBindingFrames(frames) {
    if (Array.isArray(frames) && frames.length > 0) {
      return frames;
    }
    if (frames && typeof frames === "object") {
      return [frames];
    }
    return [{}];
  }

  function resolveInputBindingRoute(bindingId) {
    const normalizedBindingId = normalizeString(bindingId, null);
    const route =
      normalizedBindingId === null
        ? null
        : listInputBindingRoutes().find(
            (candidate) => candidate.bindingId === normalizedBindingId,
          ) ?? null;
    if (!route) {
      throw createHttpStatusError(
        404,
        `No local input binding matches "${normalizedBindingId ?? "binding"}".`,
        {
          code: "input-binding-not-found",
        },
      );
    }
    return route;
  }

  function buildInputBindingFrame(route, input = {}) {
    const bindingId = normalizeString(route?.bindingId, null);
    const traceId =
      normalizeString(input.traceId, null) ??
      `input:${bindingId ?? "binding"}:${Date.now()}`;
    return normalizeFrame({
      typeRef: input.typeRef ?? route?.acceptedTypes?.[0] ?? {},
      traceId,
      streamId: Number(input.streamId ?? 0),
      sequence: Number(input.sequence ?? 0),
      payload: input.payload ?? input.body ?? null,
      metadata: {
        interfaceId: bindingId,
        inputBindingId: bindingId,
        inputBindingSourceKind: normalizeString(route?.sourceKind, null),
        description: normalizeString(route?.description, null),
        ...(normalizeMetadata(input.metadata) ?? {}),
      },
    });
  }

  async function dispatchTriggerFrames(triggerId, frames) {
    await host.start();
    await assertSupportedLocalBindings();
    const startIndex = host.getSinkEventCount();
    const startPublicationIndex = publicationEvents.length;
    host.enqueueTriggerFrames(triggerId, frames);
    const drainResult = await host.drain(options.drainOptions);
    return {
      triggerId,
      outputs: host.getSinkOutputsSince(startIndex),
      publications: publicationEvents.slice(startPublicationIndex),
      ...drainResult,
    };
  }

  async function dispatchInputBindingFrames(bindingId, frames) {
    await host.start();
    await assertSupportedLocalBindings();
    const route = resolveInputBindingRoute(bindingId);
    const startIndex = host.getSinkEventCount();
    const startPublicationIndex = publicationEvents.length;
    host.enqueueTriggerFrames(
      route.triggerId,
      listInputBindingFrames(frames).map((frame) =>
        buildInputBindingFrame(route, frame),
      ),
    );
    const drainResult = await host.drain(options.drainOptions);
    return {
      bindingId: route.bindingId,
      triggerId: route.triggerId,
      outputs: host.getSinkOutputsSince(startIndex),
      publications: publicationEvents.slice(startPublicationIndex),
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
    await host.start();
    const { trigger, binding } = resolveHttpTrigger(request);
    if (binding) {
      await assertLocalHttpRequestAuthorized(binding, request);
    }
    const response = await dispatchTriggerFrames(trigger.triggerId, [
      buildHttpRequestTriggerFrame(trigger, request),
    ]);
    return {
      triggerId: trigger.triggerId,
      route: trigger.source ?? null,
      serviceId: binding?.serviceId ?? null,
      authPolicies: binding
        ? resolveLocalAuthPoliciesForServiceBinding(binding).map(
            (policy) => policy.policyId,
          )
        : [],
      ...response,
    };
  }

  async function handleProtocolRequest(request = {}) {
    await host.start();
    await assertSupportedLocalBindings();
    const { trigger, installation } = resolveProtocolTrigger(request);
    await assertLocalProtocolRequestAuthorized(installation, request);
    const response = await dispatchTriggerFrames(
      trigger.triggerId,
      listProtocolRequestFrames(request).map((frameInput, index) =>
        buildProtocolRequestTriggerFrame(
          trigger,
          {
            ...frameInput,
            sequence:
              frameInput?.sequence ??
              request.sequence ??
              index + 1,
            metadata: {
              ...(normalizeMetadata(request.metadata) ?? {}),
              ...(normalizeMetadata(frameInput?.metadata) ?? {}),
            },
          },
          installation,
        ),
      ),
    );
    return {
      triggerId: trigger.triggerId,
      protocolId:
        resolveInstallationProtocolId(installation) ??
        resolveTriggerProtocolId(trigger),
      serviceName: normalizeString(installation?.serviceName, null),
      authPolicies: resolveLocalAuthPoliciesForProtocolInstallation(
        installation,
      ).map((policy) => policy.policyId),
      installation: cloneJsonCompatibleValue(installation),
      ...response,
    };
  }

  function listTimerTriggers() {
    const activeTriggerIds = new Set(
      Array.from(timerHandles.values()).map((record) => record.triggerId),
    );
    return listTriggersByKind(TriggerKind.TIMER).map((trigger) => ({
      triggerId: trigger.triggerId,
      source: trigger.source,
      defaultIntervalMs: trigger.defaultIntervalMs,
      description: trigger.description,
      active: activeTriggerIds.has(trigger.triggerId),
    }));
  }

  function listHttpRoutes() {
    const localBindingsByTriggerId = new Map(
      listLocalServiceBindings().map((binding) => [binding.triggerId, binding]),
    );
    const serviceBindings = listServiceBindings();
    return listTriggersByKind(TriggerKind.HTTP_REQUEST)
      .filter(
        (trigger) =>
          serviceBindings.length === 0 ||
          localBindingsByTriggerId.has(trigger.triggerId),
      )
      .map((trigger) => ({
        triggerId: trigger.triggerId,
        path:
          localBindingsByTriggerId.get(trigger.triggerId)?.routePath ??
          trigger.source ??
          null,
        description: trigger.description,
      }));
  }

  function listProtocolRoutes() {
    const protocolTriggers = listTriggersByKind(TriggerKind.PROTOCOL_REQUEST);
    const handleInstallations = listHandleProtocolInstallations();
    if (handleInstallations.length === 0) {
      return protocolTriggers.map((trigger) => {
        const installation = {
          protocolId: resolveTriggerProtocolId(trigger),
        };
        return {
          triggerId: trigger.triggerId,
          protocolId: resolveTriggerProtocolId(trigger),
          serviceName: null,
          nodeInfoUrl: null,
          description: trigger.description,
          authPolicies: resolveLocalAuthPoliciesForProtocolInstallation(
            installation,
          ).map((policy) => policy.policyId),
        };
      });
    }
    return handleInstallations.flatMap((installation) =>
      protocolTriggers
        .filter((trigger) =>
          protocolTriggerMatchesInstallation(trigger, installation),
        )
        .map((trigger) => ({
          triggerId: trigger.triggerId,
          protocolId:
            resolveInstallationProtocolId(installation) ??
            resolveTriggerProtocolId(trigger),
          serviceName: normalizeString(installation?.serviceName, null),
          nodeInfoUrl: normalizeString(installation?.nodeInfoUrl, null),
          description: trigger.description ?? installation.description ?? null,
          authPolicies: resolveLocalAuthPoliciesForProtocolInstallation(
            installation,
          ).map((policy) => policy.policyId),
        })),
    );
  }

  function startTimerServices() {
    if (setIntervalFn === null || clearIntervalFn === null) {
      return;
    }
    const timerTriggersById = new Map(
      listTriggersByKind(TriggerKind.TIMER).map((trigger) => [
        trigger.triggerId,
        trigger,
      ]),
    );
    const scheduleBindings = listScheduleBindings();
    const localScheduleBindings = listLocalScheduleBindings();
    const scheduleRecords =
      scheduleBindings.length > 0
        ? localScheduleBindings
        : listTriggersByKind(TriggerKind.TIMER).map((trigger) => ({
            scheduleId: trigger.triggerId,
            triggerId: trigger.triggerId,
            intervalMs: trigger.defaultIntervalMs,
          }));

    for (const schedule of scheduleRecords) {
      const trigger = timerTriggersById.get(schedule.triggerId);
      if (!trigger) {
        continue;
      }
      const timerHandleKey = schedule.scheduleId ?? trigger.triggerId;
      if (timerHandles.has(timerHandleKey)) {
        continue;
      }
      const configuredIntervalMs = Number(schedule.intervalMs ?? 0);
      const intervalMs =
        Number.isFinite(configuredIntervalMs) && configuredIntervalMs > 0
          ? configuredIntervalMs
          : Number(trigger.defaultIntervalMs ?? 0);
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
      timerHandles.set(timerHandleKey, {
        handle,
        triggerId: trigger.triggerId,
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

  if (typeof host.subscribeNodeOutputs === "function") {
    host.subscribeNodeOutputs(captureNodeOutputPublications);
  }
  if (typeof host.subscribeTriggerFrames === "function") {
    host.subscribeTriggerFrames(captureTriggerPublications);
  }

  return {
    host,
    async start() {
      const startup = await host.start();
      await assertSupportedLocalBindings();
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
        protocolRoutes: listProtocolRoutes(),
        deploymentBindings: buildDeploymentBindingSummary(),
      };
    },
    async refresh(refreshOptions = {}) {
      const restartTimers = started && options.autoStartTimers !== false;
      stopTimerServices();
      const refreshResult = await host.refreshPlugins(refreshOptions);
      invalidateResolvedBindingCaches();
      await assertSupportedLocalBindings();
      if (restartTimers) {
        startTimerServices();
      }
      return {
        ...refreshResult,
        timerTriggers: listTimerTriggers(),
        httpRoutes: listHttpRoutes(),
        protocolRoutes: listProtocolRoutes(),
        deploymentBindings: buildDeploymentBindingSummary(),
      };
    },
    stop() {
      stopTimerServices();
      started = false;
    },
    dispatchInputBindingFrames,
    dispatchTriggerFrames,
    dispatchTimerTrigger,
    handleHttpRequest,
    handleProtocolRequest,
    listTimerTriggers,
    listHttpRoutes,
    listProtocolRoutes,
    getPublicationEventCount() {
      return publicationEvents.length;
    },
    getPublicationEventsSince(index = 0) {
      return publicationEvents.slice(Math.max(0, Number(index) || 0));
    },
    clearPublicationEvents() {
      publicationEvents.splice(0, publicationEvents.length);
    },
    getDeploymentBindingSummary() {
      return buildDeploymentBindingSummary();
    },
    getServiceSummary() {
      return {
        started,
        timerTriggers: listTimerTriggers(),
        httpRoutes: listHttpRoutes(),
        protocolRoutes: listProtocolRoutes(),
        publicationEvents: publicationEvents.length,
        deploymentBindings: buildDeploymentBindingSummary(),
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
