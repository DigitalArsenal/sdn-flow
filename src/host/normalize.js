import {
  HostedRuntimeAdapter,
  HostedRuntimeAuthority,
  HostedRuntimeBindingDirection,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
  HostedRuntimeTransport,
} from "./constants.js";
import {
  evaluateHostedCapabilitySupport,
  evaluateHostedRuntimeTargetSupport,
  normalizeHostedRuntimeEngine,
} from "./profile.js";

const STARTUP_PHASE_ORDER = Object.freeze({
  [HostedRuntimeStartupPhase.BOOTSTRAP]: 0,
  [HostedRuntimeStartupPhase.EARLY]: 1,
  [HostedRuntimeStartupPhase.SESSION]: 2,
  [HostedRuntimeStartupPhase.ON_DEMAND]: 3,
});

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
  const normalized = values
    .map((value) => normalizeString(value, null))
    .filter((value) => value !== null);
  return Array.from(new Set(normalized));
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return fallback;
  }
  return Object.values(allowedValues).includes(normalized)
    ? normalized
    : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeHostedBindingSecurity(binding = {}) {
  const security = isPlainObject(binding.security) ? cloneJsonCompatibleValue(binding.security) : null;
  const tls = isPlainObject(binding.tls) ? cloneJsonCompatibleValue(binding.tls) : null;
  if (!security && !tls) {
    return null;
  }
  return {
    ...(security ?? {}),
    ...(tls
      ? {
          tls: {
            ...(isPlainObject(security?.tls) ? security.tls : {}),
            ...tls,
          },
        }
      : {}),
  };
}

function defaultRuntimeExecution(kind) {
  return "compiled-wasm";
}

export function normalizeHostedBinding(binding = {}) {
  const direction = normalizeEnum(
    binding.direction,
    HostedRuntimeBindingDirection,
    HostedRuntimeBindingDirection.DIAL,
  );
  const transport = normalizeEnum(
    binding.transport,
    HostedRuntimeTransport,
    HostedRuntimeTransport.SAME_APP,
  );
  const bindingId =
    normalizeString(binding.bindingId ?? binding.binding_id, null) ??
    [
      direction,
      transport,
      normalizeString(binding.protocolId ?? binding.protocol_id, null),
      normalizeString(
        binding.targetRuntimeId ?? binding.target_runtime_id,
        null,
      ),
      normalizeString(binding.url, null),
    ]
      .filter(Boolean)
      .join(":");

  const normalizedSecurity = normalizeHostedBindingSecurity(binding);
  const normalizedImplementation = isPlainObject(binding.implementation)
    ? cloneJsonCompatibleValue(binding.implementation)
    : null;

  return {
    bindingId: bindingId || `${direction}:${transport}`,
    direction,
    transport,
    protocolId: normalizeString(
      binding.protocolId ?? binding.protocol_id,
      null,
    ),
    targetRuntimeId: normalizeString(
      binding.targetRuntimeId ?? binding.target_runtime_id,
      null,
    ),
    audience: normalizeString(binding.audience, null),
    peerId: normalizeString(binding.peerId ?? binding.peer_id, null),
    url: normalizeString(binding.url, null),
    required: normalizeBoolean(binding.required, true),
    description: normalizeString(binding.description, null),
    ...(normalizedSecurity ? { security: normalizedSecurity } : {}),
    ...(normalizedImplementation
      ? { implementation: normalizedImplementation }
      : {}),
  };
}

export function normalizeHostedRuntime(runtime = {}) {
  const defaultEngine = normalizeHostedRuntimeEngine(runtime.defaultEngine, null);
  const kind = normalizeEnum(
    runtime.kind,
    HostedRuntimeKind,
    HostedRuntimeKind.FLOW,
  );
  const pluginId = normalizeString(runtime.pluginId ?? runtime.plugin_id, null);
  const programId = normalizeString(
    runtime.programId ?? runtime.program_id,
    null,
  );
  const runtimeId = normalizeString(
    runtime.runtimeId ??
      runtime.runtime_id ??
      runtime.serviceId ??
      programId ??
      pluginId,
    null,
  );

  if (!runtimeId) {
    throw new Error(
      "Hosted runtime requires runtimeId, programId, or pluginId.",
    );
  }

  const startupPhase = normalizeEnum(
    runtime.startupPhase ?? runtime.startup_phase,
    HostedRuntimeStartupPhase,
    HostedRuntimeStartupPhase.ON_DEMAND,
  );
  const autoStart = normalizeBoolean(
    runtime.autoStart ?? runtime.auto_start,
    startupPhase !== HostedRuntimeStartupPhase.ON_DEMAND,
  );

  return {
    runtimeId,
    kind,
    pluginId,
    programId,
    description: normalizeString(runtime.description, null),
    execution: normalizeString(
      runtime.execution ?? runtime.executionMode ?? runtime.execution_mode,
      defaultRuntimeExecution(kind),
    ),
    authority: normalizeEnum(
      runtime.authority,
      HostedRuntimeAuthority,
      HostedRuntimeAuthority.LOCAL,
    ),
    adapter: normalizeEnum(
      runtime.adapter ?? runtime.hostAdapter ?? runtime.host_adapter,
      HostedRuntimeAdapter,
      null,
    ),
    engine:
      normalizeHostedRuntimeEngine(
        runtime.engine ?? runtime.runtimeEngine ?? runtime.runtime_engine,
        null,
      ) ?? defaultEngine,
    startupPhase,
    autoStart,
    dependsOn: normalizeStringArray(runtime.dependsOn ?? runtime.depends_on),
    requiredCapabilities: normalizeStringArray(
      runtime.requiredCapabilities ?? runtime.required_capabilities,
    ),
    runtimeTargets: normalizeStringArray(
      runtime.runtimeTargets ?? runtime.runtime_targets,
    ),
    bindings: Array.isArray(runtime.bindings)
      ? runtime.bindings.map((binding) => normalizeHostedBinding(binding))
      : [],
  };
}

export function normalizeHostedRuntimePlan(plan = {}) {
  const planEngine = normalizeHostedRuntimeEngine(
    plan.engine ?? plan.runtimeEngine ?? plan.runtime_engine,
    null,
  );
  const runtimes = Array.isArray(plan.runtimes)
    ? plan.runtimes.map((runtime) =>
        normalizeHostedRuntime({
          ...runtime,
          defaultEngine: planEngine,
        }),
      )
    : [];
  return {
    hostId: normalizeString(plan.hostId ?? plan.host_id, "host"),
    hostKind: normalizeString(plan.hostKind ?? plan.host_kind, "host"),
    description: normalizeString(plan.description, null),
    adapter: normalizeEnum(
      plan.adapter ?? plan.hostAdapter ?? plan.host_adapter,
      HostedRuntimeAdapter,
      null,
    ),
    engine: planEngine,
    disconnectedCapable: normalizeBoolean(
      plan.disconnectedCapable ?? plan.disconnected_capable,
      false,
    ),
    runtimes,
  };
}

function compareRuntimePriority(left, right) {
  const leftPhaseOrder = STARTUP_PHASE_ORDER[left.startupPhase] ?? 99;
  const rightPhaseOrder = STARTUP_PHASE_ORDER[right.startupPhase] ?? 99;
  if (leftPhaseOrder !== rightPhaseOrder) {
    return leftPhaseOrder - rightPhaseOrder;
  }
  if (left.autoStart !== right.autoStart) {
    return left.autoStart ? -1 : 1;
  }
  return left.runtimeId.localeCompare(right.runtimeId);
}

function sortReadyRuntimes(runtimes) {
  return runtimes.sort(compareRuntimePriority);
}

function buildStartupOrder(runtimes) {
  const runtimeMap = new Map(
    runtimes.map((runtime) => [runtime.runtimeId, runtime]),
  );
  const dependents = new Map();
  const inDegree = new Map();

  for (const runtime of runtimes) {
    inDegree.set(runtime.runtimeId, 0);
    dependents.set(runtime.runtimeId, []);
  }

  for (const runtime of runtimes) {
    for (const dependencyId of runtime.dependsOn) {
      if (!runtimeMap.has(dependencyId)) {
        continue;
      }
      dependents.get(dependencyId).push(runtime.runtimeId);
      inDegree.set(runtime.runtimeId, inDegree.get(runtime.runtimeId) + 1);
    }
  }

  const ready = sortReadyRuntimes(
    runtimes.filter((runtime) => inDegree.get(runtime.runtimeId) === 0),
  );
  const ordered = [];

  while (ready.length > 0) {
    const runtime = ready.shift();
    ordered.push(runtime);
    for (const dependentId of dependents.get(runtime.runtimeId)) {
      const nextDegree = inDegree.get(dependentId) - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        ready.push(runtimeMap.get(dependentId));
        sortReadyRuntimes(ready);
      }
    }
  }

  if (ordered.length !== runtimes.length) {
    throw new Error("Hosted runtime plan contains a dependency cycle.");
  }

  return ordered;
}

function bindingSupportsDisconnectedOperation(binding) {
  return (
    binding.transport !== HostedRuntimeTransport.HTTP && binding.url === null
  );
}

export function summarizeHostedRuntimePlan(planInput = {}) {
  const plan = normalizeHostedRuntimePlan(planInput);
  const startupOrder = buildStartupOrder(plan.runtimes);
  const bindings = [];
  const adapters = new Set();
  const transports = new Set();

  if (plan.adapter) {
    adapters.add(plan.adapter);
  }

  for (const runtime of plan.runtimes) {
    if (runtime.adapter) {
      adapters.add(runtime.adapter);
    }
    for (const binding of runtime.bindings) {
      bindings.push({
        ownerRuntimeId: runtime.runtimeId,
        startupPhase: runtime.startupPhase,
        ...binding,
      });
      transports.add(binding.transport);
    }
  }

  const disconnectedCapable =
    plan.disconnectedCapable ||
    bindings.every((binding) =>
      binding.required ? bindingSupportsDisconnectedOperation(binding) : true,
    );

  return {
    hostId: plan.hostId,
    hostKind: plan.hostKind,
    adapter: plan.adapter,
    engine: plan.engine,
    adapters: Array.from(adapters).sort(),
    transports: Array.from(transports).sort(),
    disconnectedCapable,
    startupOrder: startupOrder.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      kind: runtime.kind,
      programId: runtime.programId,
      pluginId: runtime.pluginId,
      startupPhase: runtime.startupPhase,
      autoStart: runtime.autoStart,
      authority: runtime.authority,
      adapter: runtime.adapter ?? plan.adapter,
      engine: runtime.engine ?? plan.engine,
      dependsOn: runtime.dependsOn,
      runtimeTargets: runtime.runtimeTargets,
    })),
    earlyStartRuntimes: startupOrder
      .filter(
        (runtime) =>
          runtime.autoStart &&
          (runtime.startupPhase === HostedRuntimeStartupPhase.BOOTSTRAP ||
            runtime.startupPhase === HostedRuntimeStartupPhase.EARLY),
      )
      .map((runtime) => runtime.runtimeId),
    localServices: startupOrder
      .filter(
        (runtime) =>
          runtime.authority === HostedRuntimeAuthority.LOCAL &&
          runtime.kind === HostedRuntimeKind.SERVICE,
      )
      .map((runtime) => ({
        runtimeId: runtime.runtimeId,
        startupPhase: runtime.startupPhase,
        adapter: runtime.adapter ?? plan.adapter,
        engine: runtime.engine ?? plan.engine,
      })),
    runtimeCompatibility: startupOrder.map((runtime) =>
      ({
        runtimeId: runtime.runtimeId,
        adapter: runtime.adapter ?? plan.adapter,
        engine: runtime.engine ?? plan.engine,
        ...evaluateHostedCapabilitySupport({
          adapter: runtime.adapter ?? plan.adapter,
          engine: runtime.engine ?? plan.engine,
          requiredCapabilities: runtime.requiredCapabilities,
        }),
      })),
    runtimeTargetCompatibility: startupOrder.map((runtime) =>
      ({
        runtimeId: runtime.runtimeId,
        ...evaluateHostedRuntimeTargetSupport({
          hostKind: plan.hostKind,
          adapter: runtime.adapter ?? plan.adapter,
          engine: runtime.engine ?? plan.engine,
          runtimeTargets: runtime.runtimeTargets,
        }),
      })),
    bindings: bindings.sort((left, right) =>
      `${left.ownerRuntimeId}:${left.direction}:${left.transport}:${left.protocolId ?? ""}`.localeCompare(
        `${right.ownerRuntimeId}:${right.direction}:${right.transport}:${right.protocolId ?? ""}`,
      ),
    ),
  };
}

export default {
  normalizeHostedBinding,
  normalizeHostedRuntime,
  normalizeHostedRuntimePlan,
  summarizeHostedRuntimePlan,
};
