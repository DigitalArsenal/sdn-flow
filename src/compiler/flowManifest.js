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

  const hostPlanTargets = inferRuntimeTargetsFromHostPlan(options.hostPlan);
  if (hostPlanTargets.length > 0) {
    return hostPlanTargets;
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
    invokeSurfaces: [InvokeSurface.DIRECT, InvokeSurface.COMMAND],
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
};
