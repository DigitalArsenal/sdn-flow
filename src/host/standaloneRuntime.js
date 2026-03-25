import {
  canUseDirectFlowWasmInstantiation,
  describeFlowWasmImportContract,
} from "../runtime/index.js";
import {
  listCompiledArtifactRuntimeTargets,
  resolveCompiledArtifactEnvelope,
  resolveCompiledArtifactInput,
} from "../deploy/index.js";
import { bindCompiledFlowRuntimeHost } from "./compiledFlowRuntimeHost.js";
import { HostedRuntimeAdapter, HostedRuntimeEngine } from "./constants.js";
import { instantiateArtifactWithLoaderModule } from "./loaderModule.js";
import { evaluateHostedRuntimeTargetSupport } from "./profile.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value, null)?.toLowerCase() ?? null)
        .filter(Boolean),
    ),
  ).sort();
}

function defaultStandaloneTarget(runtimeTargets = []) {
  const normalizedTargets = normalizeStringArray(runtimeTargets);
  if (normalizedTargets.includes("wasmedge")) {
    return {
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    };
  }
  if (normalizedTargets.includes("wasi")) {
    return {
      hostKind: "standalone-wasi",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    };
  }
  return {
    hostKind: null,
    adapter: null,
    engine: null,
  };
}

function normalizeStandaloneTargetDescriptor(
  target = null,
  runtimeTargets = [],
) {
  const fallback = defaultStandaloneTarget(runtimeTargets);
  if (typeof target === "string") {
    return {
      runtimeId: null,
      hostKind: normalizeString(target, null) ?? fallback.hostKind,
      adapter: fallback.adapter,
      engine: fallback.engine,
      transport: null,
      kind: "local",
      runtimeTargets: normalizeStringArray(runtimeTargets),
    };
  }
  return {
    runtimeId:
      normalizeString(target?.runtimeId ?? target?.runtime_id, null) ?? null,
    hostKind:
      normalizeString(target?.hostKind ?? target?.host_kind, null) ??
      fallback.hostKind,
    adapter:
      normalizeString(target?.adapter ?? target?.hostAdapter, null) ??
      fallback.adapter,
    engine:
      normalizeString(
        target?.engine ?? target?.runtimeEngine ?? target?.runtime_engine,
        null,
      ) ?? fallback.engine,
    transport: normalizeString(target?.transport, null) ?? null,
    kind: normalizeString(target?.kind, "local"),
    runtimeTargets: normalizeStringArray(
      target?.runtimeTargets ?? target?.runtime_targets ?? runtimeTargets,
    ),
  };
}

function resolveStandaloneRuntimeTargets({
  artifact,
  target = null,
  deploymentTarget = null,
} = {}) {
  const embeddedTargets = normalizeStringArray(
    listCompiledArtifactRuntimeTargets(artifact),
  );
  if (embeddedTargets.length > 0) {
    return {
      runtimeTargets: embeddedTargets,
      source: "embedded",
    };
  }
  const targetTargets = normalizeStringArray(
    target?.runtimeTargets ?? target?.runtime_targets,
  );
  if (targetTargets.length > 0) {
    return {
      runtimeTargets: targetTargets,
      source: "metadata",
    };
  }
  const deploymentTargets = normalizeStringArray(
    deploymentTarget?.runtimeTargets ?? deploymentTarget?.runtime_targets,
  );
  return {
    runtimeTargets: deploymentTargets,
    source: deploymentTargets.length > 0 ? "metadata" : null,
  };
}

function evaluateStandaloneRuntimeCompatibility({
  artifact,
  target = null,
  deploymentTarget = null,
} = {}) {
  const { runtimeTargets, source } = resolveStandaloneRuntimeTargets({
    artifact,
    target,
    deploymentTarget,
  });
  const normalizedTarget = normalizeStandaloneTargetDescriptor(
    target ?? deploymentTarget,
    runtimeTargets,
  );
  const hasHostProfile = Boolean(
    normalizedTarget.hostKind ??
      normalizedTarget.adapter ??
      normalizedTarget.engine,
  );
  if (!hasHostProfile || runtimeTargets.length === 0) {
    return {
      target: normalizedTarget,
      runtimeTargets,
      compatibility: null,
    };
  }

  const compatibility = evaluateHostedRuntimeTargetSupport({
    hostKind: normalizedTarget.hostKind,
    adapter: normalizedTarget.adapter,
    engine: normalizedTarget.engine,
    runtimeTargets,
  });
  if (!compatibility.ok) {
    throw new Error(
      `Standalone runtime cannot satisfy ${source === "embedded" ? "embedded" : "runtime metadata"} runtimeTargets ${runtimeTargets.join(", ")} for host profile ${[
        compatibility.hostKind,
        compatibility.adapter,
        compatibility.engine,
      ]
        .filter(Boolean)
        .join("/")}. Unsupported targets: ${compatibility.unsupportedTargets.join(", ")}.`,
    );
  }

  return {
    target: normalizedTarget,
    runtimeTargets,
    compatibility,
  };
}

async function disposeStandaloneRuntime(host = null) {
  if (!host) {
    return;
  }
  try {
    if (typeof host.resetRuntimeState === "function") {
      host.resetRuntimeState();
    }
  } catch {
    // Ignore best-effort cleanup errors.
  }
  try {
    if (typeof host.destroyDependencies === "function") {
      await host.destroyDependencies();
    }
  } catch {
    // Ignore best-effort cleanup errors.
  }
}

export async function resolveStandaloneFlowRuntimeInput(
  input = {},
  options = {},
) {
  const envelope = await resolveCompiledArtifactEnvelope(input, options);
  const artifact = await resolveCompiledArtifactInput(envelope, options);
  const deployment =
    envelope?.kind === "compiled-flow-wasm-deployment" ? envelope : null;

  return {
    envelope,
    artifact,
    deploymentPlan: deployment?.deploymentPlan ?? null,
    deploymentTarget: deployment?.target ?? null,
    authorization: deployment?.authorization ?? null,
  };
}

export async function startStandaloneFlowRuntime(options = {}) {
  const resolvedInput = await resolveStandaloneFlowRuntimeInput(
    options.input ?? options.artifact ?? {},
    options.resolveOptions ?? {},
  );
  const compatibilityState = evaluateStandaloneRuntimeCompatibility({
    artifact: resolvedInput.artifact,
    target: options.target ?? resolvedInput.deploymentTarget,
    deploymentTarget: resolvedInput.deploymentTarget,
  });
  const prefersDirectInstantiation = canUseDirectFlowWasmInstantiation(
    resolvedInput.artifact?.wasm,
  );

  const instantiateArtifact =
    typeof options.instantiateArtifact === "function"
      ? options.instantiateArtifact
      : !prefersDirectInstantiation &&
          typeof resolvedInput.artifact?.loaderModule === "string" &&
          resolvedInput.artifact.loaderModule.length > 0
      ? (moduleBytes, imports) =>
          instantiateArtifactWithLoaderModule(
            resolvedInput.artifact.loaderModule,
            moduleBytes,
            imports,
          )
      : WebAssembly.instantiate;
  const bindRuntimeHost =
    options.bindRuntimeHost ?? bindCompiledFlowRuntimeHost;

  const runtimeHost = await bindRuntimeHost({
    artifact: resolvedInput.artifact,
    handlers: options.handlers ?? {},
    dependencyInvoker: options.dependencyInvoker ?? null,
    dependencyStreamBridge: options.dependencyStreamBridge ?? null,
    artifactImports: options.artifactImports ?? {},
    dependencyImports: options.dependencyImports ?? {},
    instantiateArtifact,
    instantiateDependency:
      options.instantiateDependency ?? WebAssembly.instantiate,
  });

  return {
    ...runtimeHost,
    artifact: resolvedInput.artifact,
    envelope: resolvedInput.envelope,
    deploymentPlan: resolvedInput.deploymentPlan,
    deploymentTarget: resolvedInput.deploymentTarget,
    authorization: resolvedInput.authorization,
    target: compatibilityState.target,
    runtimeTargets: compatibilityState.runtimeTargets,
    runtimeCompatibility: compatibilityState.compatibility,
    guestImportContract: describeFlowWasmImportContract(
      resolvedInput.artifact?.wasm,
    ),
    close() {
      return disposeStandaloneRuntime(runtimeHost);
    },
  };
}

export default {
  resolveStandaloneFlowRuntimeInput,
  startStandaloneFlowRuntime,
};
