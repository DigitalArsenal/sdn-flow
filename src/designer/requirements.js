import {
  ExternalInterfaceDirection,
  ExternalInterfaceKind,
  TriggerKind,
  normalizeManifest,
  normalizeProgram,
} from "../runtime/index.js";

function canonicalInterfaceKey(externalInterface) {
  return [
    externalInterface.kind,
    externalInterface.direction,
    externalInterface.capability,
    externalInterface.resource,
    externalInterface.protocolId,
    externalInterface.topic,
    externalInterface.path,
  ]
    .map((value) => value ?? "")
    .join("::");
}

function mergeInterfaces(targetMap, interfaces, owner) {
  for (const externalInterface of interfaces) {
    const key = canonicalInterfaceKey(externalInterface);
    const existing = targetMap.get(key);
    if (existing) {
      existing.owners.add(owner);
      continue;
    }
    targetMap.set(key, {
      ...externalInterface,
      owners: new Set([owner]),
    });
  }
}

function triggerToExternalInterface(trigger) {
  switch (trigger.kind) {
    case TriggerKind.TIMER:
      return {
        interfaceId: trigger.triggerId,
        kind: ExternalInterfaceKind.TIMER,
        direction: ExternalInterfaceDirection.INPUT,
        capability: "timers",
        resource: trigger.source ?? trigger.triggerId,
        description: trigger.description,
        required: true,
        acceptedTypes: trigger.acceptedTypes,
        properties: {
          defaultIntervalMs: trigger.defaultIntervalMs,
        },
      };
    case TriggerKind.PUBSUB_SUBSCRIPTION:
      return {
        interfaceId: trigger.triggerId,
        kind: ExternalInterfaceKind.PUBSUB,
        direction: ExternalInterfaceDirection.INPUT,
        capability: "pubsub",
        resource: trigger.source ?? trigger.triggerId,
        topic: trigger.source ?? null,
        description: trigger.description,
        required: true,
        acceptedTypes: trigger.acceptedTypes,
        properties: {},
      };
    case TriggerKind.PROTOCOL_REQUEST:
      return {
        interfaceId: trigger.triggerId,
        kind: ExternalInterfaceKind.PROTOCOL,
        direction: ExternalInterfaceDirection.INPUT,
        capability: "protocol_handle",
        resource: trigger.protocolId ?? trigger.source ?? trigger.triggerId,
        protocolId: trigger.protocolId,
        description: trigger.description,
        required: true,
        acceptedTypes: trigger.acceptedTypes,
        properties: {},
      };
    case TriggerKind.HTTP_REQUEST:
      return {
        interfaceId: trigger.triggerId,
        kind: ExternalInterfaceKind.HTTP,
        direction: ExternalInterfaceDirection.INPUT,
        capability: "http",
        resource: trigger.source ?? trigger.triggerId,
        path: trigger.source ?? null,
        description: trigger.description,
        required: true,
        acceptedTypes: trigger.acceptedTypes,
        properties: {},
      };
    default:
      return null;
  }
}

export function summarizeProgramRequirements({
  program,
  registry = null,
  manifests = [],
} = {}) {
  const normalizedProgram = normalizeProgram(program);
  const interfaceMap = new Map();
  const capabilities = new Set();
  const pluginSummaries = [];
  const seenPluginIds = new Set();

  mergeInterfaces(interfaceMap, normalizedProgram.externalInterfaces, "program");
  for (const trigger of normalizedProgram.triggers) {
    const externalInterface = triggerToExternalInterface(trigger);
    if (externalInterface) {
      mergeInterfaces(interfaceMap, [externalInterface], `trigger:${trigger.triggerId}`);
    }
  }

  const availableManifests = new Map();
  for (const manifest of manifests) {
    const normalizedManifest = normalizeManifest(manifest);
    availableManifests.set(normalizedManifest.pluginId, normalizedManifest);
  }
  if (registry && typeof registry.listPlugins === "function") {
    for (const pluginRecord of registry.listPlugins()) {
      availableManifests.set(pluginRecord.pluginId, pluginRecord.manifest);
    }
  }

  for (const pluginId of normalizedProgram.requiredPlugins) {
    seenPluginIds.add(pluginId);
  }
  for (const node of normalizedProgram.nodes) {
    seenPluginIds.add(node.pluginId);
  }

  for (const pluginId of seenPluginIds) {
    const manifest = availableManifests.get(pluginId);
    if (!manifest) {
      pluginSummaries.push({
        pluginId,
        resolved: false,
        capabilities: [],
        externalInterfaces: [],
      });
      continue;
    }
    pluginSummaries.push({
      pluginId,
      resolved: true,
      capabilities: manifest.capabilities,
      externalInterfaces: manifest.externalInterfaces,
    });
    for (const capability of manifest.capabilities) {
      capabilities.add(capability);
    }
    mergeInterfaces(interfaceMap, manifest.externalInterfaces, `plugin:${pluginId}`);
  }

  for (const dependency of normalizedProgram.artifactDependencies) {
    for (const capability of dependency.requiredCapabilities) {
      capabilities.add(capability);
    }
  }

  return {
    programId: normalizedProgram.programId,
    capabilities: Array.from(capabilities).sort(),
    externalInterfaces: Array.from(interfaceMap.values())
      .map((externalInterface) => ({
        ...externalInterface,
        owners: Array.from(externalInterface.owners).sort(),
      }))
      .sort((left, right) =>
        `${left.kind}:${left.direction}:${left.resource ?? ""}`.localeCompare(
          `${right.kind}:${right.direction}:${right.resource ?? ""}`,
        ),
      ),
    artifactDependencies: normalizedProgram.artifactDependencies,
    plugins: pluginSummaries.sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId),
    ),
  };
}

export default summarizeProgramRequirements;
