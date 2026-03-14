import {
  bindCompiledRuntimeAbi,
  DefaultRequiredRuntimeExportRoles,
} from "./runtimeAbi.js";
import {
  FlowNodeDispatchDescriptorLayout,
  SignedArtifactDependencyDescriptorLayout,
} from "../generated/runtimeAbiLayouts.js";

export {
  FlowNodeDispatchDescriptorLayout,
  SignedArtifactDependencyDescriptorLayout,
};

export const DefaultRequiredDescriptorExportRoles = Object.freeze([
  ...DefaultRequiredRuntimeExportRoles,
  "nodeDispatchDescriptorsSymbol",
  "nodeDispatchDescriptorCountSymbol",
  "dependencyDescriptorsSymbol",
  "dependencyCountSymbol",
]);

function resolveMemory(bound, explicitMemory = null) {
  const memory =
    explicitMemory ??
    bound?.wasmExports?.memory ??
    bound?.artifact?.wasmMemory ??
    null;
  if (!memory || !(memory.buffer instanceof ArrayBuffer)) {
    throw new Error(
      "Compiled descriptor ABI requires a WebAssembly.Memory export.",
    );
  }
  return memory;
}

function readCString(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer >>> 0;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(pointer >>> 0, end));
}

function cloneBytes(memory, offset, size) {
  const base = Number(offset) >>> 0;
  const length = Number(size) >>> 0;
  if (length === 0) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(memory.buffer, base, length);
  return new Uint8Array(bytes);
}

function readNodeDispatchDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  const nodeIdPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.nodeIdPointer.offset,
    true,
  );
  const dependencyIdPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.dependencyIdPointer.offset,
    true,
  );
  const pluginIdPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.pluginIdPointer.offset,
    true,
  );
  const methodIdPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.methodIdPointer.offset,
    true,
  );
  const dispatchModelPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.dispatchModelPointer.offset,
    true,
  );
  const entrypointPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.entrypointPointer.offset,
    true,
  );
  const manifestBytesSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.manifestBytesSymbolPointer.offset,
    true,
  );
  const manifestSizeSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.manifestSizeSymbolPointer.offset,
    true,
  );
  const initSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.initSymbolPointer.offset,
    true,
  );
  const destroySymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.destroySymbolPointer.offset,
    true,
  );
  const mallocSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.mallocSymbolPointer.offset,
    true,
  );
  const freeSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.freeSymbolPointer.offset,
    true,
  );
  const streamInvokeSymbolPointer = view.getUint32(
    base + FlowNodeDispatchDescriptorLayout.fields.streamInvokeSymbolPointer.offset,
    true,
  );
  return {
    nodeIdPointer,
    nodeIndex: view.getUint32(
      base + FlowNodeDispatchDescriptorLayout.fields.nodeIndex.offset,
      true,
    ),
    dependencyIdPointer,
    dependencyIndex: view.getUint32(
      base + FlowNodeDispatchDescriptorLayout.fields.dependencyIndex.offset,
      true,
    ),
    pluginIdPointer,
    methodIdPointer,
    dispatchModelPointer,
    entrypointPointer,
    manifestBytesSymbolPointer,
    manifestSizeSymbolPointer,
    initSymbolPointer,
    destroySymbolPointer,
    mallocSymbolPointer,
    freeSymbolPointer,
    streamInvokeSymbolPointer,
    nodeId: readCString(memory, nodeIdPointer),
    dependencyId: readCString(memory, dependencyIdPointer),
    pluginId: readCString(memory, pluginIdPointer),
    methodId: readCString(memory, methodIdPointer),
    dispatchModel: readCString(memory, dispatchModelPointer),
    entrypoint: readCString(memory, entrypointPointer),
    manifestBytesSymbol: readCString(memory, manifestBytesSymbolPointer),
    manifestSizeSymbol: readCString(memory, manifestSizeSymbolPointer),
    initSymbol: readCString(memory, initSymbolPointer),
    destroySymbol: readCString(memory, destroySymbolPointer),
    mallocSymbol: readCString(memory, mallocSymbolPointer),
    freeSymbol: readCString(memory, freeSymbolPointer),
    streamInvokeSymbol: readCString(memory, streamInvokeSymbolPointer),
  };
}

function readSignedArtifactDependencyDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  const dependencyIdPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.dependencyIdPointer.offset,
    true,
  );
  const pluginIdPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.pluginIdPointer.offset,
    true,
  );
  const versionPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.versionPointer.offset,
    true,
  );
  const sha256Pointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.sha256Pointer.offset,
    true,
  );
  const signaturePointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.signaturePointer.offset,
    true,
  );
  const signerPublicKeyPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.signerPublicKeyPointer.offset,
    true,
  );
  const entrypointPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.entrypointPointer.offset,
    true,
  );
  const manifestBytesSymbolPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.manifestBytesSymbolPointer.offset,
    true,
  );
  const manifestSizeSymbolPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.manifestSizeSymbolPointer.offset,
    true,
  );
  const initSymbolPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.initSymbolPointer.offset,
    true,
  );
  const destroySymbolPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.destroySymbolPointer.offset,
    true,
  );
  const mallocSymbolPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.mallocSymbolPointer.offset,
    true,
  );
  const freeSymbolPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.freeSymbolPointer.offset,
    true,
  );
  const streamInvokeSymbolPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.streamInvokeSymbolPointer.offset,
    true,
  );
  const wasmBytesPointer = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.wasmBytesPointer.offset,
    true,
  );
  const wasmSize = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.wasmSize.offset,
    true,
  );
  const manifestBytesPointer = view.getUint32(
    base +
      SignedArtifactDependencyDescriptorLayout.fields.manifestBytesPointer.offset,
    true,
  );
  const manifestSize = view.getUint32(
    base + SignedArtifactDependencyDescriptorLayout.fields.manifestSize.offset,
    true,
  );
  return {
    dependencyIdPointer,
    pluginIdPointer,
    versionPointer,
    sha256Pointer,
    signaturePointer,
    signerPublicKeyPointer,
    entrypointPointer,
    manifestBytesSymbolPointer,
    manifestSizeSymbolPointer,
    initSymbolPointer,
    destroySymbolPointer,
    mallocSymbolPointer,
    freeSymbolPointer,
    streamInvokeSymbolPointer,
    wasmBytesPointer,
    wasmSize,
    manifestBytesPointer,
    manifestSize,
    dependencyId: readCString(memory, dependencyIdPointer),
    pluginId: readCString(memory, pluginIdPointer),
    version: readCString(memory, versionPointer),
    sha256: readCString(memory, sha256Pointer),
    signature: readCString(memory, signaturePointer),
    signerPublicKey: readCString(memory, signerPublicKeyPointer),
    entrypoint: readCString(memory, entrypointPointer),
    manifestBytesSymbol: readCString(memory, manifestBytesSymbolPointer),
    manifestSizeSymbol: readCString(memory, manifestSizeSymbolPointer),
    initSymbol: readCString(memory, initSymbolPointer),
    destroySymbol: readCString(memory, destroySymbolPointer),
    mallocSymbol: readCString(memory, mallocSymbolPointer),
    freeSymbol: readCString(memory, freeSymbolPointer),
    streamInvokeSymbol: readCString(memory, streamInvokeSymbolPointer),
    wasmBytes: cloneBytes(memory, wasmBytesPointer, wasmSize),
    manifestBytes: cloneBytes(memory, manifestBytesPointer, manifestSize),
  };
}

export async function bindCompiledDescriptorAbi({
  artifact,
  instance = null,
  wasmExports = null,
  memory = null,
  requiredRoles = DefaultRequiredDescriptorExportRoles,
} = {}) {
  const bound = await bindCompiledRuntimeAbi({
    artifact,
    instance,
    wasmExports,
    requiredRoles,
  });
  const resolvedMemory = resolveMemory(bound, memory);

  return {
    ...bound,
    memory: resolvedMemory,
    readNodeDispatchDescriptor(pointer) {
      return readNodeDispatchDescriptor(resolvedMemory, pointer);
    },
    readDependencyDescriptor(pointer) {
      return readSignedArtifactDependencyDescriptor(resolvedMemory, pointer);
    },
    getNodeDispatchDescriptorsPointer() {
      return Number(bound.resolvedByRole.nodeDispatchDescriptorsSymbol()) >>> 0;
    },
    getNodeDispatchDescriptorCount() {
      return (
        Number(bound.resolvedByRole.nodeDispatchDescriptorCountSymbol()) >>> 0
      );
    },
    getDependencyDescriptorsPointer() {
      return Number(bound.resolvedByRole.dependencyDescriptorsSymbol()) >>> 0;
    },
    getDependencyDescriptorCount() {
      return Number(bound.resolvedByRole.dependencyCountSymbol()) >>> 0;
    },
    readNodeDispatchDescriptorAt(index) {
      const normalizedIndex = Number(index) >>> 0;
      if (normalizedIndex >= this.getNodeDispatchDescriptorCount()) {
        return null;
      }
      return this.readNodeDispatchDescriptor(
        this.getNodeDispatchDescriptorsPointer() +
          normalizedIndex * FlowNodeDispatchDescriptorLayout.size,
      );
    },
    readDependencyDescriptorAt(index) {
      const normalizedIndex = Number(index) >>> 0;
      if (normalizedIndex >= this.getDependencyDescriptorCount()) {
        return null;
      }
      return this.readDependencyDescriptor(
        this.getDependencyDescriptorsPointer() +
          normalizedIndex * SignedArtifactDependencyDescriptorLayout.size,
      );
    },
    readAllNodeDispatchDescriptors() {
      return Array.from(
        { length: this.getNodeDispatchDescriptorCount() },
        (_unused, index) => this.readNodeDispatchDescriptorAt(index),
      );
    },
    readAllDependencyDescriptors() {
      return Array.from(
        { length: this.getDependencyDescriptorCount() },
        (_unused, index) => this.readDependencyDescriptorAt(index),
      );
    },
  };
}

export default bindCompiledDescriptorAbi;
