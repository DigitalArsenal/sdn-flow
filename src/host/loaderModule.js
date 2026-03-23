import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function mergeImportObjects(base = {}, extra = {}) {
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
          mergeImportObjects(baseImports, imports),
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
  instantiateArtifactWithLoaderModule,
};
