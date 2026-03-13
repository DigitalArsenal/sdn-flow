import { normalizeCompiledArtifact } from "../deploy/FlowDeploymentClient.js";

export const DefaultRequiredRuntimeExportRoles = Object.freeze([
  "descriptorSymbol",
  "resetStateSymbol",
  "enqueueTriggerSymbol",
  "enqueueEdgeSymbol",
  "readyNodeSymbol",
  "beginInvocationSymbol",
  "completeInvocationSymbol",
]);

function getWasmExports(target = null) {
  if (target && typeof target === "object") {
    if (
      target.instance?.exports &&
      typeof target.instance.exports === "object"
    ) {
      return target.instance.exports;
    }
    if (target.exports && typeof target.exports === "object") {
      return target.exports;
    }
    return target;
  }
  return null;
}

function resolveRuntimeExport({ role, symbol, wasmExports, requiredRoles }) {
  const required = requiredRoles.has(role);
  if (!symbol) {
    if (required) {
      throw new Error(
        `Compiled runtime ABI is missing the symbol name for ${role}.`,
      );
    }
    return null;
  }
  const candidateSymbols = [symbol, `_${symbol}`];
  const resolvedSymbol = candidateSymbols.find(
    (candidate) => candidate in wasmExports,
  );
  if (!resolvedSymbol) {
    throw new Error(
      `Compiled runtime ABI export "${symbol}" for ${role} is not present on the wasm instance.`,
    );
  }
  return {
    role,
    symbol,
    resolvedSymbol,
    value: wasmExports[resolvedSymbol],
  };
}

export async function bindCompiledRuntimeAbi({
  artifact,
  instance = null,
  wasmExports = null,
  requiredRoles = DefaultRequiredRuntimeExportRoles,
} = {}) {
  const normalizedArtifact = await normalizeCompiledArtifact(artifact);
  const resolvedWasmExports = getWasmExports(wasmExports ?? instance);

  if (!resolvedWasmExports || typeof resolvedWasmExports !== "object") {
    throw new Error(
      "bindCompiledRuntimeAbi requires a WebAssembly instance or exports object.",
    );
  }

  const requiredRoleSet = new Set(
    Array.isArray(requiredRoles)
      ? requiredRoles
      : DefaultRequiredRuntimeExportRoles,
  );
  const resolvedByRole = {};
  const resolvedBySymbol = {};

  for (const [role, symbol] of Object.entries(
    normalizedArtifact.runtimeExports,
  )) {
    const binding = resolveRuntimeExport({
      role,
      symbol,
      wasmExports: resolvedWasmExports,
      requiredRoles: requiredRoleSet,
    });
    resolvedByRole[role] = binding?.value ?? null;
    if (binding) {
      resolvedBySymbol[binding.symbol] = binding.value;
      resolvedBySymbol[binding.resolvedSymbol] = binding.value;
    }
  }

  return {
    artifact: normalizedArtifact,
    runtimeExports: normalizedArtifact.runtimeExports,
    requiredRoles: Array.from(requiredRoleSet),
    wasmExports: resolvedWasmExports,
    resolvedByRole,
    resolvedBySymbol,
  };
}

export default bindCompiledRuntimeAbi;
