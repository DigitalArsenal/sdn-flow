import { bindCompiledDescriptorAbi } from "./descriptorAbi.js";
import { DefaultInvokeExports } from "space-data-module-sdk/runtime";

function resolveDependencyImportObject(imports, descriptor) {
  if (typeof imports === "function") {
    return imports(descriptor) ?? {};
  }
  if (imports instanceof Map) {
    return (
      imports.get(descriptor.dependencyId) ??
      imports.get(descriptor.pluginId) ??
      imports.get("default") ??
      {}
    );
  }
  if (imports && typeof imports === "object") {
    return (
      imports[descriptor.dependencyId] ??
      imports[descriptor.pluginId] ??
      imports.default ??
      {}
    );
  }
  return {};
}

function resolveNamedExport(exports, symbol) {
  if (!symbol) {
    return null;
  }
  return exports?.[symbol] ?? exports?.[`_${symbol}`] ?? null;
}

function resolveNamedExportWithDefault(exports, symbol, fallbackSymbol = null) {
  if (symbol) {
    return resolveNamedExport(exports, symbol);
  }
  if (!fallbackSymbol) {
    return null;
  }
  return resolveNamedExport(exports, fallbackSymbol);
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new TypeError("Expected Uint8Array, ArrayBufferView, or ArrayBuffer.");
}

function cloneBytes(memory, offset, size) {
  const base = Number(offset) >>> 0;
  const length = Number(size) >>> 0;
  if (length === 0) {
    return new Uint8Array();
  }
  return new Uint8Array(new Uint8Array(memory.buffer, base, length));
}

function writeBytes(memory, pointer, data) {
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(toUint8Array(data), Number(pointer) >>> 0);
}

function getWasmExports(instanceResult) {
  if (instanceResult?.instance?.exports) {
    return instanceResult.instance.exports;
  }
  if (instanceResult?.exports) {
    return instanceResult.exports;
  }
  return {};
}

function createRawStreamInvoker(dependency) {
  const { resolvedExports, memory } = dependency;
  if (
    typeof resolvedExports?.streamInvoke !== "function" ||
    typeof resolvedExports?.malloc !== "function" ||
    typeof resolvedExports?.free !== "function" ||
    !memory
  ) {
    return null;
  }
  return function invokeRawStream(requestBytes) {
    const request = toUint8Array(requestBytes);
    const requestSize = request.length;
    const requestPointer =
      requestSize > 0 ? Number(resolvedExports.malloc(requestSize)) >>> 0 : 0;
    const sizePointer = Number(resolvedExports.malloc(4)) >>> 0;
    const view = new DataView(memory.buffer);
    try {
      if (requestSize > 0) {
        writeBytes(memory, requestPointer, request);
      }
      view.setUint32(sizePointer, 0, true);
      const responsePointer =
        Number(
          resolvedExports.streamInvoke(requestPointer, requestSize, sizePointer),
        ) >>> 0;
      const responseSize = view.getUint32(sizePointer, true);
      const responseBytes =
        responsePointer !== 0 && responseSize > 0
          ? cloneBytes(memory, responsePointer, responseSize)
          : new Uint8Array();
      if (responsePointer !== 0) {
        resolvedExports.free(responsePointer);
      }
      return responseBytes;
    } finally {
      if (requestPointer !== 0) {
        resolvedExports.free(requestPointer);
      }
      resolvedExports.free(sizePointer);
    }
  };
}

export async function instantiateEmbeddedDependencies({
  artifact,
  instance = null,
  wasmExports = null,
  memory = null,
  imports = {},
  instantiate = WebAssembly.instantiate,
} = {}) {
  if (typeof instantiate !== "function") {
    throw new TypeError(
      "instantiateEmbeddedDependencies requires an instantiate function.",
    );
  }
  const bound = await bindCompiledDescriptorAbi({
    artifact,
    instance,
    wasmExports,
    memory,
  });
  const descriptors = bound.readAllDependencyDescriptors();
  const instantiated = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const importObject = resolveDependencyImportObject(imports, descriptor);
    const instantiatedModule = await instantiate(descriptor.wasmBytes, importObject);
    const exports = getWasmExports(instantiatedModule);
    instantiated.push({
      index,
      dependencyId: descriptor.dependencyId,
      pluginId: descriptor.pluginId,
      descriptor,
      importObject,
      module: instantiatedModule?.module ?? null,
      instance: instantiatedModule?.instance ?? instantiatedModule ?? null,
      exports,
      resolvedExports: {
        init: resolveNamedExport(exports, descriptor.initSymbol),
        destroy: resolveNamedExport(exports, descriptor.destroySymbol),
        malloc: resolveNamedExportWithDefault(
          exports,
          descriptor.mallocSymbol,
          DefaultInvokeExports.allocSymbol,
        ),
        free: resolveNamedExportWithDefault(
          exports,
          descriptor.freeSymbol,
          DefaultInvokeExports.freeSymbol,
        ),
        streamInvoke: resolveNamedExportWithDefault(
          exports,
          descriptor.streamInvokeSymbol,
          DefaultInvokeExports.invokeSymbol,
        ),
        manifestBytes: resolveNamedExport(
          exports,
          descriptor.manifestBytesSymbol,
        ),
        manifestSize: resolveNamedExport(exports, descriptor.manifestSizeSymbol),
      },
      memory: exports?.memory ?? null,
    });
    instantiated[index].invokeRawStream = createRawStreamInvoker(instantiated[index]);
    instantiated[index].cloneBytes = (offset, size) =>
      cloneBytes(instantiated[index].memory, offset, size);
    instantiated[index].release = (pointer) => {
      if (!pointer || typeof instantiated[index].resolvedExports.free !== "function") {
        return null;
      }
      return instantiated[index].resolvedExports.free(Number(pointer) >>> 0);
    };
  }
  return {
    ...bound,
    descriptors,
    instantiated,
    byDependencyId: new Map(
      instantiated.map((dependency) => [dependency.dependencyId, dependency]),
    ),
    byPluginId: new Map(
      instantiated.map((dependency) => [dependency.pluginId, dependency]),
    ),
    getDependency(binding = {}) {
      if (binding.dependencyId && this.byDependencyId.has(binding.dependencyId)) {
        return this.byDependencyId.get(binding.dependencyId);
      }
      if (binding.pluginId && this.byPluginId.has(binding.pluginId)) {
        return this.byPluginId.get(binding.pluginId);
      }
      const normalizedIndex = Number(binding.index ?? binding.dependencyIndex);
      if (Number.isInteger(normalizedIndex) && normalizedIndex >= 0) {
        return this.instantiated[normalizedIndex] ?? null;
      }
      return null;
    },
    initializeDependency(binding = {}, ...args) {
      const dependency = this.getDependency(binding);
      if (!dependency?.resolvedExports?.init) {
        return null;
      }
      return dependency.resolvedExports.init(...args);
    },
    destroyDependency(binding = {}, ...args) {
      const dependency = this.getDependency(binding);
      if (!dependency?.resolvedExports?.destroy) {
        return null;
      }
      return dependency.resolvedExports.destroy(...args);
    },
    initializeAll(...args) {
      return this.instantiated.map((dependency) =>
        dependency.resolvedExports.init
          ? dependency.resolvedExports.init(...args)
          : null,
      );
    },
    destroyAll(...args) {
      return this.instantiated.map((dependency) =>
        dependency.resolvedExports.destroy
          ? dependency.resolvedExports.destroy(...args)
          : null,
      );
    },
  };
}

export default instantiateEmbeddedDependencies;
