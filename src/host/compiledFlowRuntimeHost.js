import { decodePluginManifest } from "space-data-module-sdk/manifest";

import { InvokeSurface } from "../runtime/constants.js";
import {
  assertSupportedFlowWasmImportContract,
  createDefaultWasiPreview1CompatImports,
  describeFlowWasmImportContract,
  filterImportObjectToWasmModules,
  mergeWasmImportObjects,
} from "../runtime/wasmCompatibility.js";
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

function resolveArtifactImportObject(
  imports,
  artifact,
  additionalImports = {},
) {
  const importContract = describeFlowWasmImportContract(artifact?.wasm);
  const mergeAndFilter = (resolvedImports = {}) => {
    const merged = mergeWasmImportObjects(resolvedImports, additionalImports);
    if (!importContract.valid) {
      return merged;
    }
    return filterImportObjectToWasmModules(merged, importContract.modules);
  };
  if (typeof imports === "function") {
    return mergeAndFilter(imports(artifact) ?? {});
  }
  if (imports instanceof Map) {
    return mergeAndFilter(
      imports.get(artifact?.programId) ??
        imports.get(artifact?.artifactId) ??
        imports.get("default") ??
        {},
    );
  }
  if (imports && typeof imports === "object") {
    if (
      "env" in imports ||
      "wasi_snapshot_preview1" in imports ||
      "sdn_flow_host" in imports ||
      "default" in imports
    ) {
      return mergeAndFilter(imports);
    }
    return mergeAndFilter(
      imports[artifact?.programId] ??
        imports[artifact?.artifactId] ??
        imports.default ??
        {},
    );
  }
  return mergeAndFilter({});
}

function resolveNamedExport(exports, symbol) {
  if (!symbol || !exports || typeof exports !== "object") {
    return null;
  }
  if (typeof exports[symbol] === "function") {
    return {
      name: symbol,
      value: exports[symbol],
    };
  }
  const underscored = `_${symbol}`;
  if (typeof exports[underscored] === "function") {
    return {
      name: underscored,
      value: exports[underscored],
    };
  }
  return null;
}

function readCString(memory, pointer) {
  const base = Number(pointer) >>> 0;
  if (!memory || !(memory.buffer instanceof ArrayBuffer) || base === 0) {
    return null;
  }
  const bytes = new Uint8Array(memory.buffer);
  let end = base;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(base, end));
}

function writeCString(memory, pointer, value) {
  const bytes = new Uint8Array(memory.buffer);
  const encoded = new TextEncoder().encode(`${String(value ?? "")}\0`);
  bytes.set(encoded, Number(pointer) >>> 0);
}

function allocateCString(bound, memory, value) {
  const encoded = new TextEncoder().encode(`${String(value ?? "")}\0`);
  const pointer =
    Number(bound.resolvedByRole.mallocSymbol(encoded.length)) >>> 0;
  writeCString(memory, pointer, value);
  return pointer;
}

function allocateArgv(bound, memory, argv = []) {
  const pointers = argv.map((value) => allocateCString(bound, memory, value));
  const argvPointer =
    Number(bound.resolvedByRole.mallocSymbol((pointers.length + 1) * 4)) >>> 0;
  const view = new DataView(memory.buffer);
  pointers.forEach((pointer, index) => {
    view.setUint32(argvPointer + index * 4, pointer, true);
  });
  view.setUint32(argvPointer + pointers.length * 4, 0, true);
  return {
    argvPointer,
    stringPointers: pointers,
  };
}

function releaseArgv(bound, allocation = null) {
  if (!allocation) {
    return;
  }
  for (const pointer of allocation.stringPointers ?? []) {
    bound.resolvedByRole.freeSymbol(pointer);
  }
  if (allocation.argvPointer) {
    bound.resolvedByRole.freeSymbol(allocation.argvPointer);
  }
}

async function resolveCompiledArtifactRuntime({
  artifact,
  instance = null,
  wasmExports = null,
  artifactImports = {},
  internalImports = {},
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
  assertSupportedFlowWasmImportContract(artifact.wasm, {
    sourceName: artifact?.programId
      ? `Compiled flow artifact ${artifact.programId}`
      : "Compiled flow artifact",
  });
  const instantiated = await instantiateArtifact(
    artifact.wasm,
    resolveArtifactImportObject(artifactImports, artifact, internalImports),
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

function isPromiseLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.then === "function"
  );
}

function normalizeInvokeSurfaces(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(
          (value) =>
            value === InvokeSurface.DIRECT || value === InvokeSurface.COMMAND,
        ),
    ),
  );
}

function decodeDependencyInvokeSurfaces(dependencyDescriptor = null) {
  const manifestBytes = dependencyDescriptor?.manifestBytes;
  if (!(manifestBytes instanceof Uint8Array) || manifestBytes.length === 0) {
    return [];
  }
  try {
    return normalizeInvokeSurfaces(
      decodePluginManifest(manifestBytes)?.invokeSurfaces ?? [],
    );
  } catch {
    return [];
  }
}

function resolveDependencyInvokeSurfaces({
  dispatchDescriptor = null,
  dependencyDescriptor = null,
  instantiatedDependency = null,
} = {}) {
  const instantiatedSurfaces = normalizeInvokeSurfaces(
    instantiatedDependency?.invokeSurfaces,
  );
  if (instantiatedSurfaces.length > 0) {
    return instantiatedSurfaces;
  }

  const decodedSurfaces = decodeDependencyInvokeSurfaces(dependencyDescriptor);
  if (decodedSurfaces.length > 0) {
    if (
      instantiatedDependency &&
      !Array.isArray(instantiatedDependency.invokeSurfaces)
    ) {
      instantiatedDependency.invokeSurfaces = [...decodedSurfaces];
    }
    return decodedSurfaces;
  }

  const directAvailable =
    typeof instantiatedDependency?.resolvedExports?.streamInvoke === "function" ||
    Boolean(
      dispatchDescriptor?.streamInvokeSymbol ??
        dependencyDescriptor?.streamInvokeSymbol,
    );
  return [
    directAvailable ? InvokeSurface.DIRECT : InvokeSurface.COMMAND,
  ];
}

function resolveDependencyDispatcher({
  dispatchDescriptor = null,
  dependencyDescriptor = null,
  instantiatedDependency = null,
  dependencyInvoker = null,
  dependencyStreamBridge = null,
} = {}) {
  const invokeSurfaces = resolveDependencyInvokeSurfaces({
    dispatchDescriptor,
    dependencyDescriptor,
    instantiatedDependency,
  });
  if (
    invokeSurfaces.includes(InvokeSurface.DIRECT) &&
    typeof dependencyInvoker === "function"
  ) {
    return dependencyInvoker;
  }
  if (
    invokeSurfaces.includes(InvokeSurface.COMMAND) &&
    typeof dependencyStreamBridge === "function"
  ) {
    return dependencyStreamBridge;
  }
  if (typeof dependencyInvoker === "function") {
    return dependencyInvoker;
  }
  if (typeof dependencyStreamBridge === "function") {
    return dependencyStreamBridge;
  }
  return null;
}

function resolveInvocationBinding(host, invocation = null) {
  const dispatchDescriptor =
    invocation?.dispatchDescriptorIndex === INVALID_INDEX
      ? null
      : host.readNodeDispatchDescriptorAt(invocation?.dispatchDescriptorIndex);
  const dependencyDescriptor =
    dispatchDescriptor?.dependencyIndex === INVALID_INDEX
      ? null
      : host.readDependencyDescriptorAt(dispatchDescriptor?.dependencyIndex);
  return {
    dispatchDescriptor,
    dependencyDescriptor,
    handler: host.findHandler({
      pluginId: invocation?.pluginId,
      methodId: invocation?.methodId,
      dependencyId:
        dispatchDescriptor?.dependencyId ?? dependencyDescriptor?.dependencyId,
      nodeId: dispatchDescriptor?.nodeId ?? null,
    }),
  };
}

async function executeCurrentInvocationInternal(
  host,
  {
    nodeIndex = INVALID_INDEX,
    outputStreamCap = 16,
    consumed = 0,
    dependencyInvoker = null,
    dependencyStreamBridge = null,
  } = {},
) {
  const invocation = host.readCurrentInvocation();
  const { dispatchDescriptor, dependencyDescriptor, handler } =
    resolveInvocationBinding(host, invocation);
  const instantiatedDependency =
    (typeof dependencyInvoker === "function" ||
      typeof dependencyStreamBridge === "function") &&
    dependencyDescriptor
      ? await host.getInstantiatedDependency({
          dependencyId:
            dispatchDescriptor?.dependencyId ??
            dependencyDescriptor?.dependencyId,
          pluginId: invocation?.pluginId,
          dependencyIndex:
            dispatchDescriptor?.dependencyIndex ??
            dependencyDescriptor?.dependencyIndex,
        })
      : null;
  const dependencyDispatcher = resolveDependencyDispatcher({
    dispatchDescriptor,
    dependencyDescriptor,
    instantiatedDependency,
    dependencyInvoker,
    dependencyStreamBridge,
  });
  const canDispatchLinkedInvocationInModule =
    host.handlers?.size === 0 &&
    dispatchDescriptor?.dispatchModel === "linked-direct" &&
    typeof host.dispatchCurrentInvocationDirect === "function";

  if (
    typeof handler !== "function" &&
    typeof dependencyDispatcher !== "function"
  ) {
    if (canDispatchLinkedInvocationInModule) {
      const routedOutputs = Number(
        host.dispatchCurrentInvocationDirect({ outputStreamCap }),
      );
      return {
        executed: true,
        idle: false,
        nodeIndex,
        pluginId: invocation?.pluginId,
        methodId: invocation?.methodId,
        dispatchDescriptor,
        dependencyDescriptor,
        instantiatedDependency,
        consumed,
        routedOutputs,
        outputs: [],
      };
    }
    throw new Error(
      `No compiled flow host handler is registered for ${invocation?.pluginId}:${invocation?.methodId}.`,
    );
  }

  const inputs = (invocation.frames ?? []).map((frame) => ({
    ...frame,
    bytes: host.readFrameBytes(frame),
  }));
  const invocationArgs = {
    nodeIndex,
    pluginId: invocation?.pluginId,
    methodId: invocation?.methodId,
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
      : await dependencyDispatcher(invocationArgs);
  const routedOutputs = Number(
    host.applyNodeInvocationResult(nodeIndex, {
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
    pluginId: invocation?.pluginId,
    methodId: invocation?.methodId,
    dispatchDescriptor,
    dependencyDescriptor,
    instantiatedDependency,
    consumed,
    routedOutputs,
    outputs: result?.outputs ?? [],
  };
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
  const artifactRuntimeRef = {
    instance,
    exports: wasmExports,
    memory,
  };
  const internalImports = createDefaultWasiPreview1CompatImports({
    getMemory: () =>
      artifactRuntimeRef.exports?.memory ?? artifactRuntimeRef.memory ?? null,
  });
  const resolvedRuntime = await resolveCompiledArtifactRuntime({
    artifact,
    instance,
    wasmExports,
    artifactImports,
    internalImports,
    instantiateArtifact,
  });
  const resolvedInstance = resolvedRuntime.instance ?? instance;
  const resolvedWasmExports = resolvedRuntime.wasmExports ?? wasmExports;
  const resolvedMemory = memory ?? resolvedWasmExports?.memory ?? null;
  artifactRuntimeRef.instance = resolvedInstance;
  artifactRuntimeRef.exports = resolvedWasmExports;
  artifactRuntimeRef.memory = resolvedMemory;
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

  const host = {
    ...bound,
    descriptors,
    handlers: normalizedHandlers,
    instance: resolvedInstance,
    wasmExports: resolvedWasmExports,
    memory: resolvedMemory,
    artifactImports: resolveArtifactImportObject(
      artifactImports,
      artifact,
      internalImports,
    ),
    guestImportContract: describeFlowWasmImportContract(artifact?.wasm),
    instantiateArtifact,
    dependencyInvoker,
    dependencyStreamBridge,
    dependencyImports,
    resolveEntrypoint(entrypoint = artifact?.entrypoint ?? "main") {
      return resolveNamedExport(resolvedWasmExports, entrypoint);
    },
    readEmbeddedEditorMetadata() {
      if (!resolvedMemory || !(resolvedMemory.buffer instanceof ArrayBuffer)) {
        return null;
      }
      const metadataExport = resolveNamedExport(
        resolvedWasmExports,
        bound.artifact?.runtimeExports?.editorMetadataJsonSymbol,
      );
      if (!metadataExport) {
        return null;
      }
      const metadataPointer = Number(metadataExport.value() ?? 0) >>> 0;
      if (metadataPointer === 0) {
        return null;
      }
      const sizeExport = resolveNamedExport(
        resolvedWasmExports,
        bound.artifact?.runtimeExports?.editorMetadataSizeSymbol,
      );
      const metadataText =
        sizeExport && typeof sizeExport.value === "function"
          ? new TextDecoder().decode(
              new Uint8Array(
                resolvedMemory.buffer,
                metadataPointer,
                Number(sizeExport.value() ?? 0) >>> 0,
              ),
            )
          : readCString(resolvedMemory, metadataPointer);
      if (!metadataText) {
        return null;
      }
      try {
        return JSON.parse(metadataText);
      } catch {
        return metadataText;
      }
    },
    runEntrypoint({
      entrypoint = artifact?.entrypoint ?? "main",
      args = [],
      argv = null,
      programName = artifact?.programId ??
        artifact?.artifactId ??
        "flow-runtime",
    } = {}) {
      const resolvedEntrypoint = this.resolveEntrypoint(entrypoint);
      if (!resolvedEntrypoint) {
        throw new Error(
          `Compiled flow host entrypoint "${entrypoint}" is not present on the instantiated runtime.`,
        );
      }
      if (
        resolvedEntrypoint.name === "_start" ||
        resolvedEntrypoint.name === "start" ||
        resolvedEntrypoint.value.length === 0
      ) {
        return {
          entrypoint: resolvedEntrypoint.name,
          argc: 0,
          argv: [],
          exitCode: Number(resolvedEntrypoint.value() ?? 0),
        };
      }

      const normalizedArgv = Array.isArray(argv)
        ? argv.map((value) => String(value))
        : [String(programName), ...args.map((value) => String(value))];
      const allocation = allocateArgv(bound, resolvedMemory, normalizedArgv);
      try {
        const exitCode = Number(
          resolvedEntrypoint.value(
            normalizedArgv.length,
            allocation.argvPointer,
          ) ?? 0,
        );
        return {
          entrypoint: resolvedEntrypoint.name,
          argc: normalizedArgv.length,
          argv: normalizedArgv,
          exitCode,
        };
      } finally {
        releaseArgv(bound, allocation);
      }
    },
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
    getInstantiatedDependencySync(binding = {}) {
      if (!dependencyRuntime) {
        return null;
      }
      return dependencyRuntime.getDependency(binding);
    },
    async getInstantiatedDependency(binding = {}) {
      const runtime = await getDependencyRuntime();
      return runtime.getDependency(binding);
    },
    dispatchCurrentInvocationDirect({ outputStreamCap = 16 } = {}) {
      const directDispatchExport = this.resolveEntrypoint(
        artifact?.runtimeExports?.dispatchCurrentInvocationSymbol ??
          "sdn_flow_dispatch_current_invocation_direct",
      );
      if (!directDispatchExport) {
        return null;
      }
      return Number(directDispatchExport.value(outputStreamCap) ?? 0) >>> 0;
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
      return executeCurrentInvocationInternal(this, {
        nodeIndex,
        outputStreamCap,
        consumed,
        dependencyInvoker,
        dependencyStreamBridge,
      });
    },
    async dispatchNextReadyNodeWithHost({
      frameBudget = 1,
      outputStreamCap = 16,
    } = {}) {
      return this.executeNextReadyNode({
        frameBudget,
        outputStreamCap,
      });
    },
    async drainWithHostDispatch({
      frameBudget = 1,
      outputStreamCap = 16,
      maxIterations = 1024,
    } = {}) {
      return this.drain({
        frameBudget,
        outputStreamCap,
        maxIterations,
      });
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
  if (
    typeof dependencyInvoker === "function" ||
    typeof dependencyStreamBridge === "function"
  ) {
    await getDependencyRuntime();
  }
  return host;
}

export default bindCompiledFlowRuntimeHost;
