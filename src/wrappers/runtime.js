import { startStandaloneFlowRuntime } from "../host/standaloneRuntime.js";

function normalizeWrapperTarget(target = {}) {
  return {
    targetId: String(target?.targetId ?? "").trim() || null,
    runtimeFamily: String(target?.runtimeFamily ?? "").trim() || null,
    supportMode: String(target?.supportMode ?? "").trim() || null,
    installableWrapper:
      String(target?.installableWrapper ?? "").trim() || null,
  };
}

export async function startWasmEdgeLikeRuntime(
  options = {},
  wrapperTarget = {},
) {
  const startRuntime =
    typeof options.startRuntime === "function"
      ? options.startRuntime
      : startStandaloneFlowRuntime;
  const runtimeOptions = {
    ...options,
  };
  delete runtimeOptions.startRuntime;

  const runtime = await startRuntime(runtimeOptions);
  const descriptor = normalizeWrapperTarget(wrapperTarget);
  return {
    ...runtime,
    wrapperCompatibilityProfile: "wasmedge-like",
    wrapperTarget: descriptor.targetId,
    wrapperRuntimeFamily: descriptor.runtimeFamily,
    wrapperSupportMode: descriptor.supportMode,
    wrapperPackage: descriptor.installableWrapper,
    usesNativeWebAssembly: true,
  };
}

export default {
  startWasmEdgeLikeRuntime,
};
