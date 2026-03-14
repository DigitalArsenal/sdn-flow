import { bindCompiledInvocationAbi } from "./invocationAbi.js";
import { bindCompiledDescriptorAbi } from "./descriptorAbi.js";
import { instantiateEmbeddedDependencies } from "./dependencyRuntime.js";

const INVALID_INDEX = 0xffffffff;

function getInstantiatedExports(target = null) {
  if (
    target?.instance?.exports &&
    typeof target.instance.exports === "object"
  ) {
    return target.instance.exports;
  }
  if (target?.exports && typeof target.exports === "object") {
    return target.exports;
  }
  if (target && typeof target === "object") {
    return target;
  }
  return null;
}

function resolveArtifactImportObject(imports, artifact) {
  if (typeof imports === "function") {
    return imports(artifact) ?? {};
  }
  if (imports instanceof Map) {
    return (
      imports.get(artifact?.programId) ??
      imports.get(artifact?.artifactId) ??
      imports.get("default") ??
      {}
    );
  }
  if (imports && typeof imports === "object") {
    if (
      "env" in imports ||
      "wasi_snapshot_preview1" in imports ||
      "default" in imports
    ) {
      return imports;
    }
    return (
      imports[artifact?.programId] ??
      imports[artifact?.artifactId] ??
      imports.default ??
      {}
    );
  }
  return {};
}

async function resolveCompiledArtifactRuntime({
  artifact,
  instance = null,
  wasmExports = null,
  artifactImports = {},
  instantiateArtifact = WebAssembly.instantiate,
} = {}) {
  if (instance || wasmExports) {
    return {
      instance,
      wasmExports,
    };
  }
  if (!(artifact?.wasm instanceof Uint8Array)) {
    throw new Error(
      "Compiled flow host requires artifact.wasm bytes when no instance or wasmExports are supplied.",
    );
  }
  if (typeof instantiateArtifact !== "function") {
    throw new TypeError(
      "bindCompiledFlowRuntimeHost requires instantiateArtifact to be a function when instantiating the root artifact.",
    );
  }
  const instantiated = await instantiateArtifact(
    artifact.wasm,
    resolveArtifactImportObject(artifactImports, artifact),
  );
  return {
    instance: instantiated?.instance ?? instantiated ?? null,
    wasmExports: getInstantiatedExports(instantiated),
  };
}

function normalizeHandlers(handlers = {}) {
  if (handlers instanceof Map) {
    return handlers;
  }
  return new Map(Object.entries(handlers));
}

function createHandlerKeys({
  pluginId = null,
  methodId = null,
  dependencyId = null,
  nodeId = null,
} = {}) {
  return [
    dependencyId && methodId ? `${dependencyId}:${methodId}` : null,
    pluginId && methodId ? `${pluginId}:${methodId}` : null,
    nodeId && methodId ? `${nodeId}:${methodId}` : null,
    dependencyId,
    pluginId,
    nodeId,
    methodId,
  ].filter(Boolean);
}

function resolveHandler(
  handlers,
  { pluginId = null, methodId = null, dependencyId = null, nodeId = null } = {},
) {
  for (const key of createHandlerKeys({
    pluginId,
    methodId,
    dependencyId,
    nodeId,
  })) {
    if (handlers.has(key)) {
      return handlers.get(key);
    }
  }
  return null;
}

export async function bindCompiledFlowRuntimeHost({
  artifact,
  instance = null,
  wasmExports = null,
  memory = null,
  artifactImports = {},
  instantiateArtifact = WebAssembly.instantiate,
  handlers = {},
  dependencyInvoker = null,
  dependencyStreamBridge = null,
  dependencyImports = {},
  instantiateDependency = WebAssembly.instantiate,
} = {}) {
  const resolvedRuntime = await resolveCompiledArtifactRuntime({
    artifact,
    instance,
    wasmExports,
    artifactImports,
    instantiateArtifact,
  });
  const resolvedInstance = resolvedRuntime.instance ?? instance;
  const resolvedWasmExports = resolvedRuntime.wasmExports ?? wasmExports;
  const resolvedMemory = memory ?? resolvedWasmExports?.memory ?? null;
  const [bound, descriptors] = await Promise.all([
    bindCompiledInvocationAbi({
      artifact,
      instance: resolvedInstance,
      wasmExports: resolvedWasmExports,
      memory: resolvedMemory,
    }),
    bindCompiledDescriptorAbi({
      artifact,
      instance: resolvedInstance,
      wasmExports: resolvedWasmExports,
      memory: resolvedMemory,
    }),
  ]);
  const normalizedHandlers = normalizeHandlers(handlers);
  let dependencyRuntime = null;

  async function getDependencyRuntime() {
    if (!dependencyRuntime) {
      dependencyRuntime = await instantiateEmbeddedDependencies({
        artifact,
        instance: resolvedInstance,
        wasmExports: resolvedWasmExports,
        memory: resolvedMemory,
        imports: dependencyImports,
        instantiate: instantiateDependency,
      });
    }
    return dependencyRuntime;
  }

  return {
    ...bound,
    descriptors,
    handlers: normalizedHandlers,
    instance: resolvedInstance,
    wasmExports: resolvedWasmExports,
    memory: resolvedMemory,
    artifactImports,
    instantiateArtifact,
    dependencyInvoker,
    dependencyStreamBridge,
    dependencyImports,
    readNodeDispatchDescriptorAt(index) {
      return descriptors.readNodeDispatchDescriptorAt(index);
    },
    readDependencyDescriptorAt(index) {
      return descriptors.readDependencyDescriptorAt(index);
    },
    findHandler(binding = {}) {
      return resolveHandler(normalizedHandlers, binding);
    },
    async instantiateDependencies() {
      return getDependencyRuntime();
    },
    async destroyDependencies(...args) {
      const runtime = await getDependencyRuntime();
      return runtime.destroyAll(...args);
    },
    async getInstantiatedDependency(binding = {}) {
      const runtime = await getDependencyRuntime();
      return runtime.getDependency(binding);
    },
    async executeNextReadyNode({ frameBudget = 1, outputStreamCap = 16 } = {}) {
      const nodeIndex = Number(bound.resolvedByRole.readyNodeSymbol()) >>> 0;
      if (nodeIndex === INVALID_INDEX) {
        return {
          executed: false,
          idle: true,
          nodeIndex,
        };
      }
      const consumed = Number(
        bound.resolvedByRole.beginInvocationSymbol(nodeIndex, frameBudget),
      );
      const invocation = this.readCurrentInvocation();
      const dispatchDescriptor =
        invocation?.dispatchDescriptorIndex === INVALID_INDEX
          ? null
          : this.readNodeDispatchDescriptorAt(
              invocation?.dispatchDescriptorIndex,
            );
      const dependencyDescriptor =
        dispatchDescriptor?.dependencyIndex === INVALID_INDEX
          ? null
          : this.readDependencyDescriptorAt(
              dispatchDescriptor?.dependencyIndex,
            );
      const handler = this.findHandler({
        pluginId: invocation?.pluginId,
        methodId: invocation?.methodId,
        dependencyId:
          dispatchDescriptor?.dependencyId ??
          dependencyDescriptor?.dependencyId,
        nodeId: dispatchDescriptor?.nodeId ?? null,
      });
      const instantiatedDependency =
        (typeof dependencyInvoker === "function" ||
          typeof dependencyStreamBridge === "function") &&
        dependencyDescriptor
          ? await this.getInstantiatedDependency({
              dependencyId:
                dispatchDescriptor?.dependencyId ??
                dependencyDescriptor?.dependencyId,
              pluginId: invocation?.pluginId,
              dependencyIndex:
                dispatchDescriptor?.dependencyIndex ??
                dependencyDescriptor?.dependencyIndex,
            })
          : null;
      if (
        typeof handler !== "function" &&
        typeof dependencyInvoker !== "function" &&
        typeof dependencyStreamBridge !== "function"
      ) {
        throw new Error(
          `No compiled flow host handler is registered for ${invocation?.pluginId}:${invocation?.methodId}.`,
        );
      }
      const inputs = (invocation.frames ?? []).map((frame) => ({
        ...frame,
        bytes: this.readFrameBytes(frame),
      }));
      const invocationArgs = {
        nodeIndex,
        pluginId: invocation.pluginId,
        methodId: invocation.methodId,
        dispatchDescriptor,
        dependencyDescriptor,
        instantiatedDependency,
        inputs,
        outputStreamCap,
        invocation,
      };
      const result =
        typeof handler === "function"
          ? await handler(invocationArgs)
          : typeof dependencyInvoker === "function"
            ? await dependencyInvoker(invocationArgs)
            : await dependencyStreamBridge(invocationArgs);
      const routedOutputs = Number(
        this.applyNodeInvocationResult(nodeIndex, {
          statusCode:
            result?.statusCode ?? result?.status_code ?? result?.errorCode ?? 0,
          backlogRemaining:
            result?.backlogRemaining ?? result?.backlog_remaining ?? 0,
          yielded: result?.yielded ?? false,
          outputs: result?.outputs ?? [],
        }),
      );
      return {
        executed: true,
        idle: false,
        nodeIndex,
        pluginId: invocation.pluginId,
        methodId: invocation.methodId,
        dispatchDescriptor,
        dependencyDescriptor,
        instantiatedDependency,
        consumed,
        routedOutputs,
        outputs: result?.outputs ?? [],
      };
    },
    async drain({
      frameBudget = 1,
      outputStreamCap = 16,
      maxIterations = 1024,
    } = {}) {
      const executions = [];
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const execution = await this.executeNextReadyNode({
          frameBudget,
          outputStreamCap,
        });
        if (!execution.executed) {
          return {
            idle: execution.idle,
            iterations: executions.length,
            executions,
          };
        }
        executions.push(execution);
      }
      return {
        idle: false,
        iterations: executions.length,
        executions,
        maxIterationsReached: true,
      };
    },
  };
}

export default bindCompiledFlowRuntimeHost;
