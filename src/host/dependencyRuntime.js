import { bindCompiledDescriptorAbi } from "./descriptorAbi.js";

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

function getWasmExports(instanceResult) {
  if (instanceResult?.instance?.exports) {
    return instanceResult.instance.exports;
  }
  if (instanceResult?.exports) {
    return instanceResult.exports;
  }
  return {};
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
        malloc: resolveNamedExport(exports, descriptor.mallocSymbol),
        free: resolveNamedExport(exports, descriptor.freeSymbol),
        streamInvoke: resolveNamedExport(exports, descriptor.streamInvokeSymbol),
        manifestBytes: resolveNamedExport(
          exports,
          descriptor.manifestBytesSymbol,
        ),
        manifestSize: resolveNamedExport(exports, descriptor.manifestSizeSymbol),
      },
      memory: exports?.memory ?? null,
    });
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
