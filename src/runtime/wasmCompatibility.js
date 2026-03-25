import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FLOW_WASM_WASMEDGE_IMPORT_MODULES = Object.freeze([
  "wasi_snapshot_preview1",
]);

export const FLOW_WASM_HOST_COMPAT_IMPORT_MODULES = Object.freeze([
  ...FLOW_WASM_WASMEDGE_IMPORT_MODULES,
  "sdn_flow_host",
]);

function getMemoryFromResolver(getMemory = null) {
  if (typeof getMemory !== "function") {
    return null;
  }
  const memory = getMemory();
  return memory && memory.buffer instanceof ArrayBuffer ? memory : null;
}

function writeCompatU32(getMemory, pointer, value) {
  const memory = getMemoryFromResolver(getMemory);
  if (!memory || !pointer) {
    return;
  }
  new DataView(memory.buffer).setUint32(Number(pointer) >>> 0, Number(value) >>> 0, true);
}

function writeCompatU64(getMemory, pointer, value) {
  const memory = getMemoryFromResolver(getMemory);
  if (!memory || !pointer) {
    return;
  }
  new DataView(memory.buffer).setBigUint64(Number(pointer) >>> 0, BigInt(value), true);
}

export function createDefaultWasiPreview1CompatImports({ getMemory } = {}) {
  return {
    wasi_snapshot_preview1: {
      args_sizes_get() {
        return 0;
      },
      args_get() {
        return 0;
      },
      proc_exit() {
        return 0;
      },
      fd_close() {
        return 0;
      },
      fd_seek(_fd, _offsetLow, _offsetHigh, _whence, newOffsetPtr) {
        writeCompatU64(getMemory, newOffsetPtr, 0n);
        return 0;
      },
      fd_write(_fd, iovs, iovsLen, bytesWrittenPtr) {
        const memory = getMemoryFromResolver(getMemory);
        if (!memory) {
          writeCompatU32(getMemory, bytesWrittenPtr, 0);
          return 0;
        }
        const view = new DataView(memory.buffer);
        let written = 0;
        for (let index = 0; index < Number(iovsLen ?? 0); index += 1) {
          const base = (Number(iovs) >>> 0) + index * 8;
          written += view.getUint32(base + 4, true);
        }
        writeCompatU32(getMemory, bytesWrittenPtr, written);
        return 0;
      },
    },
  };
}

export function createDefaultFlowWasmCompatImports({
  getMemory,
  dispatchCurrentInvocation = null,
} = {}) {
  const imports = createDefaultWasiPreview1CompatImports({ getMemory });
  if (typeof dispatchCurrentInvocation === "function") {
    imports.sdn_flow_host = {
      dispatch_current_invocation(outputStreamCap = 16) {
        return Number(dispatchCurrentInvocation(outputStreamCap)) >>> 0;
      },
    };
  }
  return imports;
}

export function mergeWasmImportObjects(base = {}, extra = {}) {
  const merged = { ...(base ?? {}) };
  for (const [moduleName, moduleValue] of Object.entries(extra ?? {})) {
    const existing = merged[moduleName];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      moduleValue &&
      typeof moduleValue === "object" &&
      !Array.isArray(moduleValue)
    ) {
      merged[moduleName] = {
        ...existing,
        ...moduleValue,
      };
      continue;
    }
    merged[moduleName] = moduleValue;
  }
  return merged;
}

function toWasmModule(value) {
  if (value instanceof WebAssembly.Module) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new WebAssembly.Module(value);
  }
  if (value instanceof ArrayBuffer) {
    return new WebAssembly.Module(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return new WebAssembly.Module(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return null;
}

export function listWasmImportModules(value) {
  const module = toWasmModule(value);
  if (!module) {
    return [];
  }
  return Array.from(
    new Set(
      WebAssembly.Module.imports(module)
        .map((entry) => String(entry?.module ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function describeFlowWasmImportContract(value) {
  try {
    const modules = listWasmImportModules(value);
    const requiresFlowHostDispatch = modules.includes("sdn_flow_host");
    const wasiOnly = modules.every((moduleName) =>
      FLOW_WASM_WASMEDGE_IMPORT_MODULES.includes(moduleName),
    );
    const hostCompatible = modules.every((moduleName) =>
      FLOW_WASM_HOST_COMPAT_IMPORT_MODULES.includes(moduleName),
    );
    return {
      valid: true,
      modules,
      requiresFlowHostDispatch,
      compatibilityProfile: wasiOnly
        ? "wasmedge-compatible"
        : hostCompatible
          ? "flow-host-compatible"
          : "custom",
      isWasmEdgeCompatible: wasiOnly,
      isHostCompatible: hostCompatible,
    };
  } catch (error) {
    return {
      valid: false,
      modules: [],
      requiresFlowHostDispatch: false,
      compatibilityProfile: "invalid",
      isWasmEdgeCompatible: false,
      isHostCompatible: false,
      error,
    };
  }
}

export function canUseDirectFlowWasmInstantiation(value) {
  const contract = describeFlowWasmImportContract(value);
  return contract.valid && contract.isHostCompatible;
}

export function assertSupportedFlowWasmImportContract(
  value,
  {
    allowFlowHostDispatch = true,
    sourceName = "Compiled flow artifact",
  } = {},
) {
  const contract = describeFlowWasmImportContract(value);
  if (!contract.valid) {
    return contract;
  }
  const allowedModules = allowFlowHostDispatch
    ? FLOW_WASM_HOST_COMPAT_IMPORT_MODULES
    : FLOW_WASM_WASMEDGE_IMPORT_MODULES;
  const unsupportedModules = contract.modules.filter(
    (moduleName) => !allowedModules.includes(moduleName),
  );
  if (unsupportedModules.length > 0) {
    throw new Error(
      `${sourceName} imports unsupported guest modules ${unsupportedModules.join(", ")}. Supported modules: ${allowedModules.join(", ")}.`,
    );
  }
  return contract;
}

export function filterImportObjectToWasmModules(imports = {}, modules = []) {
  if (!imports || typeof imports !== "object") {
    return {};
  }
  const moduleSet = new Set(
    Array.isArray(modules) ? modules.filter(Boolean) : [],
  );
  if (moduleSet.size === 0) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(imports).filter(([moduleName]) => moduleSet.has(moduleName)),
  );
}

export async function instantiateArtifactWithLoaderModule(
  loaderModuleSource,
  moduleBytes,
  imports = {},
) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "sdn-flow-loader-"));
  const loaderPath = path.join(tempDirectory, "flow-loader.mjs");
  await writeFile(loaderPath, String(loaderModuleSource ?? ""), "utf8");
  try {
    const importedModule = await import(
      `${pathToFileURL(loaderPath).href}?v=${Date.now()}`
    );
    const factory = importedModule?.default ?? importedModule;
    if (typeof factory !== "function") {
      throw new Error("Compiled loader module did not export a default factory.");
    }

    let wasmExports = null;
    const emscriptenModule = await factory({
      noInitialRun: true,
      wasmBinary: moduleBytes,
      print() {},
      printErr() {},
      instantiateWasm(baseImports, receiveInstance) {
        return WebAssembly.instantiate(
          moduleBytes,
          mergeWasmImportObjects(baseImports, imports),
        ).then((instantiated) => {
          wasmExports = instantiated.instance.exports;
          receiveInstance(instantiated.instance, instantiated.module);
          return instantiated.instance.exports;
        });
      },
    });

    const exports = {
      ...(wasmExports ?? {}),
      ...(emscriptenModule ?? {}),
      memory:
        wasmExports?.memory ??
        emscriptenModule?.memory ??
        emscriptenModule?.wasmMemory ??
        null,
    };
    return {
      instance: {
        exports,
      },
      exports,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export default {
  FLOW_WASM_HOST_COMPAT_IMPORT_MODULES,
  FLOW_WASM_WASMEDGE_IMPORT_MODULES,
  assertSupportedFlowWasmImportContract,
  canUseDirectFlowWasmInstantiation,
  createDefaultFlowWasmCompatImports,
  createDefaultWasiPreview1CompatImports,
  describeFlowWasmImportContract,
  filterImportObjectToWasmModules,
  instantiateArtifactWithLoaderModule,
  listWasmImportModules,
  mergeWasmImportObjects,
};
