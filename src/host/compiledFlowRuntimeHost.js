import { bindCompiledInvocationAbi } from "./invocationAbi.js";
import { bindCompiledDescriptorAbi } from "./descriptorAbi.js";
import { instantiateEmbeddedDependencies } from "./dependencyRuntime.js";

const INVALID_INDEX = 0xffffffff;

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
  handlers = {},
  dependencyInvoker = null,
  dependencyStreamBridge = null,
  dependencyImports = {},
  instantiateDependency = WebAssembly.instantiate,
} = {}) {
  const [bound, descriptors] = await Promise.all([
    bindCompiledInvocationAbi({
      artifact,
      instance,
      wasmExports,
      memory,
    }),
    bindCompiledDescriptorAbi({
      artifact,
      instance,
      wasmExports,
      memory,
    }),
  ]);
  const normalizedHandlers = normalizeHandlers(handlers);
  let dependencyRuntime = null;

  async function getDependencyRuntime() {
    if (!dependencyRuntime) {
      dependencyRuntime = await instantiateEmbeddedDependencies({
        artifact,
        instance,
        wasmExports,
        memory,
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
          : this.readNodeDispatchDescriptorAt(invocation?.dispatchDescriptorIndex);
      const dependencyDescriptor =
        dispatchDescriptor?.dependencyIndex === INVALID_INDEX
          ? null
          : this.readDependencyDescriptorAt(dispatchDescriptor?.dependencyIndex);
      const handler = this.findHandler({
        pluginId: invocation?.pluginId,
        methodId: invocation?.methodId,
        dependencyId:
          dispatchDescriptor?.dependencyId ?? dependencyDescriptor?.dependencyId,
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
    async drain({ frameBudget = 1, outputStreamCap = 16, maxIterations = 1024 } = {}) {
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
