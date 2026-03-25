import { encodePluginManifest } from "space-data-module-sdk";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import {
  ExternalInterfaceKind,
  InvokeSurface,
  RuntimeTarget,
  TriggerKind,
  normalizeProgram,
} from "../runtime/index.js";

function normalizeString(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value, null))
        .filter(Boolean),
    ),
  ).sort();
}

function hasGuestLinkMetadata(dependency = {}) {
  const guestLink = dependency?.guestLink ?? dependency?.guest_link ?? null;
  if (!guestLink || typeof guestLink !== "object") {
    return false;
  }
  const methodSymbols =
    guestLink.methodSymbols ?? guestLink.method_symbols ?? null;
  if (
    methodSymbols &&
    typeof methodSymbols === "object" &&
    Object.keys(methodSymbols).length > 0
  ) {
    return true;
  }
  const objectBytes = guestLink.objectBytes ?? guestLink.object_bytes ?? null;
  if (objectBytes instanceof Uint8Array) {
    return objectBytes.length > 0;
  }
  if (ArrayBuffer.isView(objectBytes)) {
    return objectBytes.byteLength > 0;
  }
  if (objectBytes instanceof ArrayBuffer) {
    return objectBytes.byteLength > 0;
  }
  return false;
}

function flowContainsHostedOnlyNodes(program, dependencies = []) {
  const normalizedProgram = normalizeProgram(program ?? {});
  const guestLinkablePluginIds = new Set(
    normalizeStringArray(
      dependencies
        .map((dependency) =>
          hasGuestLinkMetadata(dependency) ? dependency?.pluginId : null,
        )
        .filter(Boolean),
    ),
  );

  for (const node of normalizedProgram.nodes) {
    const pluginId = normalizeString(node?.pluginId, null);
    if (!pluginId) {
      return true;
    }
    if (!guestLinkablePluginIds.has(pluginId)) {
      return true;
    }
  }
  return false;
}

const BrowserOnlyCapabilities = new Set([
  "entity_access",
  "render_hooks",
  "scene_access",
]);

const GuestNetworkingCapabilities = new Set([
  "ipfs",
  "mqtt",
  "network",
  "protocol_dial",
  "protocol_handle",
  "tcp",
  "tls",
  "udp",
  "websocket",
]);

const GuestNetworkingInterfaceKinds = new Set([
  ExternalInterfaceKind.MQTT,
  ExternalInterfaceKind.NETWORK,
  ExternalInterfaceKind.PROTOCOL,
  ExternalInterfaceKind.TCP,
  ExternalInterfaceKind.TLS,
  ExternalInterfaceKind.UDP,
  ExternalInterfaceKind.WEBSOCKET,
]);

const DelegatedHostCapabilities = new Set([
  "http",
  "process_exec",
  "pubsub",
  "schedule_cron",
  "timers",
]);

const DelegatedHostInterfaceKinds = new Set([
  ExternalInterfaceKind.HTTP,
  ExternalInterfaceKind.PUBSUB,
  ExternalInterfaceKind.SCHEDULE,
  ExternalInterfaceKind.TIMER,
]);

function inferRuntimeTargetsFromHostPlan(hostPlan = null) {
  const hostKind = normalizeString(hostPlan?.hostKind ?? hostPlan?.host_kind, null);
  const engine = normalizeString(
    hostPlan?.engine ?? hostPlan?.runtimeEngine ?? hostPlan?.runtime_engine,
    null,
  );

  if (hostKind === "wasmedge") {
    return [RuntimeTarget.WASMEDGE];
  }
  if (engine === "browser") {
    return [RuntimeTarget.BROWSER];
  }
  if (engine === "wasi") {
    return [RuntimeTarget.WASI];
  }
  if (engine === "node") {
    return [RuntimeTarget.NODE];
  }
  if (engine === "deno" || engine === "bun" || engine === "go") {
    return [RuntimeTarget.SERVER];
  }
  return [];
}

function deploymentPlanUsesHostedBindings(deploymentPlan = null) {
  if (!deploymentPlan || typeof deploymentPlan !== "object") {
    return false;
  }
  return [
    "authPolicies",
    "inputBindings",
    "protocolInstallations",
    "publicationBindings",
    "scheduleBindings",
    "serviceBindings",
  ].some(
    (key) =>
      Array.isArray(deploymentPlan[key]) && deploymentPlan[key].length > 0,
  );
}

function normalizeInvokeSurfaceList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const ordered = [];
  for (const value of values) {
    const normalized = normalizeString(value, null);
    if (
      (normalized === InvokeSurface.DIRECT ||
        normalized === InvokeSurface.COMMAND) &&
      !ordered.includes(normalized)
    ) {
      ordered.push(normalized);
    }
  }
  ordered.sort((left, right) => {
    const order = {
      [InvokeSurface.DIRECT]: 0,
      [InvokeSurface.COMMAND]: 1,
    };
    return (order[left] ?? 99) - (order[right] ?? 99);
  });
  return ordered;
}

function collectDependencyInvokeSurfaces(dependencies = []) {
  const surfaces = [];
  if (!Array.isArray(dependencies)) {
    return surfaces;
  }
  for (const dependency of dependencies) {
    const dependencySurfaces = normalizeInvokeSurfaceList(
      dependency?.invokeSurfaces ?? dependency?.invoke_surfaces,
    );
    const normalizedSurfaces =
      dependencySurfaces.length > 0
        ? dependencySurfaces
        : normalizeInvokeSurfaceList([
            dependency?.invokeSurface ?? dependency?.invoke_surface,
          ]);
    for (const surface of normalizedSurfaces) {
      if (!surfaces.includes(surface)) {
        surfaces.push(surface);
      }
    }
  }
  return surfaces;
}

function inferFlowInvokeSurfaces(options = {}) {
  const explicitSurfaces = normalizeInvokeSurfaceList(
    options.invokeSurfaces ?? options.invoke_surfaces,
  );
  if (explicitSurfaces.length > 0) {
    return explicitSurfaces;
  }
  const dependencySurfaces = collectDependencyInvokeSurfaces(
    options.dependencies ?? [],
  );
  if (dependencySurfaces.length > 0) {
    return dependencySurfaces;
  }
  return [InvokeSurface.DIRECT, InvokeSurface.COMMAND];
}

export function inferFlowRuntimeTargets(options = {}) {
  const normalizedProgram = normalizeProgram(options.program ?? {});
  const explicitTargets = normalizeStringArray(
    options.runtimeTargets ??
      options.runtime_targets ??
      options.manifest?.runtimeTargets ??
      normalizedProgram.runtimeTargets,
  );
  if (explicitTargets.length > 0) {
    return explicitTargets;
  }

  const requirements =
    options.requirements ??
    summarizeProgramRequirements({
      program: normalizedProgram,
      registry: options.registry ?? null,
      manifests: options.manifests ?? [],
    });
  const capabilities = new Set(
    normalizeStringArray(requirements.capabilities),
  );
  const externalInterfaces = Array.isArray(requirements.externalInterfaces)
    ? requirements.externalInterfaces
    : [];

  if (Array.from(capabilities).some((capability) => BrowserOnlyCapabilities.has(capability))) {
    return [RuntimeTarget.BROWSER];
  }

  const hostPlanTargets = inferRuntimeTargetsFromHostPlan(options.hostPlan);
  if (hostPlanTargets.includes(RuntimeTarget.BROWSER)) {
    return [RuntimeTarget.BROWSER];
  }

  if (flowContainsHostedOnlyNodes(normalizedProgram, options.dependencies ?? [])) {
    return [RuntimeTarget.SERVER];
  }
  if (hostPlanTargets.length > 0) {
    return hostPlanTargets;
  }

  const usesGuestNetworking =
    Array.from(capabilities).some((capability) =>
      GuestNetworkingCapabilities.has(capability),
    ) ||
    externalInterfaces.some(
      (externalInterface) =>
        GuestNetworkingCapabilities.has(
          normalizeString(externalInterface.capability, ""),
        ) ||
        GuestNetworkingInterfaceKinds.has(
          normalizeString(externalInterface.kind, ""),
        ),
    );
  if (usesGuestNetworking) {
    return [RuntimeTarget.WASMEDGE];
  }

  const needsHostedBindings =
    deploymentPlanUsesHostedBindings(options.deploymentPlan) ||
    Array.from(capabilities).some((capability) =>
      DelegatedHostCapabilities.has(capability),
    ) ||
    externalInterfaces.some(
      (externalInterface) =>
        DelegatedHostCapabilities.has(
          normalizeString(externalInterface.capability, ""),
        ) ||
        DelegatedHostInterfaceKinds.has(
          normalizeString(externalInterface.kind, ""),
        ),
    ) ||
    normalizedProgram.triggers.some((trigger) =>
      [
        TriggerKind.HTTP_REQUEST,
        TriggerKind.PROTOCOL_REQUEST,
        TriggerKind.PUBSUB_SUBSCRIPTION,
        TriggerKind.TIMER,
      ].includes(trigger.kind),
    );
  if (needsHostedBindings) {
    return [RuntimeTarget.SERVER];
  }

  return [RuntimeTarget.WASI];
}

export function inferFlowRuntimeTargetProfile(options = {}) {
  const normalizedProgram = normalizeProgram(options.program ?? {});
  const runtimeTargets = normalizeStringArray(
    options.runtimeTargets ??
      options.runtime_targets ??
      options.manifest?.runtimeTargets ??
      normalizedProgram.runtimeTargets,
  );
  const explicitClass = normalizeString(
    options.runtimeTargetClass ??
      options.runtime_target_class ??
      normalizedProgram.runtimeTargetClass,
    null,
  );
  const explicitStandardTarget = normalizeString(
    options.standardRuntimeTarget ??
      options.standard_runtime_target ??
      normalizedProgram.standardRuntimeTarget,
    null,
  );
  const inferredTarget = runtimeTargets[0] ?? null;

  if (explicitClass || explicitStandardTarget) {
    return {
      runtimeTargetClass:
        explicitClass ??
        (explicitStandardTarget === RuntimeTarget.BROWSER
          ? "delegated"
          : explicitStandardTarget === RuntimeTarget.WASI
            ? "standalone"
            : "server-side"),
      standardRuntimeTarget:
        explicitStandardTarget ??
        (runtimeTargets.includes(RuntimeTarget.WASMEDGE)
          ? RuntimeTarget.WASMEDGE
          : inferredTarget),
    };
  }

  if (runtimeTargets.includes(RuntimeTarget.WASMEDGE)) {
    return {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.WASMEDGE,
    };
  }
  if (runtimeTargets.includes(RuntimeTarget.SERVER)) {
    return {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.SERVER,
    };
  }
  if (runtimeTargets.includes(RuntimeTarget.WASI)) {
    return {
      runtimeTargetClass: "standalone",
      standardRuntimeTarget: RuntimeTarget.WASI,
    };
  }
  if (runtimeTargets.includes(RuntimeTarget.BROWSER)) {
    return {
      runtimeTargetClass: "delegated",
      standardRuntimeTarget: RuntimeTarget.BROWSER,
    };
  }

  return {
    runtimeTargetClass: null,
    standardRuntimeTarget: inferredTarget,
  };
}

export function buildDefaultFlowManifest(options = {}) {
  const normalizedProgram = normalizeProgram(options.program ?? {});
  const requirements =
    options.requirements ??
    summarizeProgramRequirements({
      program: normalizedProgram,
      registry: options.registry ?? null,
      manifests: options.manifests ?? [],
    });

  return {
    pluginId:
      normalizeString(options.pluginId, null) ??
      normalizeString(normalizedProgram.programId, null) ??
      "sdn-flow-runtime",
    name:
      normalizeString(options.name, null) ??
      normalizeString(normalizedProgram.name, null) ??
      normalizeString(normalizedProgram.programId, null) ??
      "sdn-flow runtime",
    version:
      normalizeString(options.version, null) ??
      normalizeString(normalizedProgram.version, null) ??
      "0.1.0",
    pluginFamily: "flow",
    capabilities: normalizeStringArray(requirements.capabilities),
    invokeSurfaces: inferFlowInvokeSurfaces(options),
    runtimeTargets: inferFlowRuntimeTargets({
      ...options,
      program: normalizedProgram,
      requirements,
    }),
    abiVersion: Number(options.abiVersion ?? 1),
  };
}

export function buildDefaultFlowManifestBuffer(options = {}) {
  return encodePluginManifest(buildDefaultFlowManifest(options));
}

export default {
  buildDefaultFlowManifest,
  buildDefaultFlowManifestBuffer,
  inferFlowRuntimeTargets,
  inferFlowRuntimeTargetProfile,
};
