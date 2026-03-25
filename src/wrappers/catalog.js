const WasmEdgeSupportModes = Object.freeze({
  DIRECT_SDK: "direct-sdk",
  DIRECT_JVM: "direct-jvm",
  DIRECT_C_ABI: "direct-c-abi",
  WRAPPER_REQUIRED: "wrapper-required",
});

const WasmEdgeTargetSupportCatalog = Object.freeze([
  {
    targetId: "browser",
    runtimeFamily: "browser",
    supportMode: WasmEdgeSupportModes.WRAPPER_REQUIRED,
    installableWrapper: "sdn-flow/wrappers/browser",
    usesNativeWebAssembly: true,
    officialSdk: false,
    inferred: false,
    reason:
      "Browsers do not embed the WasmEdge native runtime directly, so they need a native WebAssembly compatibility wrapper.",
  },
  {
    targetId: "bun",
    runtimeFamily: "javascript-runtime",
    supportMode: WasmEdgeSupportModes.WRAPPER_REQUIRED,
    installableWrapper: "sdn-flow/wrappers/bun",
    usesNativeWebAssembly: true,
    officialSdk: false,
    inferred: false,
    reason:
      "Bun is not a documented WasmEdge embed host, so it should use the same thin WebAssembly compatibility wrapper contract as the browser.",
  },
  {
    targetId: "deno",
    runtimeFamily: "javascript-runtime",
    supportMode: WasmEdgeSupportModes.WRAPPER_REQUIRED,
    installableWrapper: "sdn-flow/wrappers/deno",
    usesNativeWebAssembly: true,
    officialSdk: false,
    inferred: false,
    reason:
      "Deno is not a documented WasmEdge embed host, so it should use the same thin WebAssembly compatibility wrapper contract as the browser.",
  },
  {
    targetId: "c",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge C API directly.",
  },
  {
    targetId: "c++",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge C/C++ SDK directly.",
  },
  {
    targetId: "csharp",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_C_ABI,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: false,
    inferred: true,
    reason:
      "Use .NET native interop against the WasmEdge C API instead of a separate wrapper package.",
  },
  {
    targetId: "go",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge Go SDK directly.",
  },
  {
    targetId: "java",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge Java SDK directly.",
  },
  {
    targetId: "kotlin",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_JVM,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: false,
    inferred: true,
    reason:
      "Use Kotlin/JVM interop on top of the WasmEdge Java SDK instead of a separate wrapper package.",
  },
  {
    targetId: "node",
    runtimeFamily: "javascript-runtime",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the documented Node.js embed path through WasmEdge NAPI.",
  },
  {
    targetId: "python",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge Python SDK directly.",
  },
  {
    targetId: "rust",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge Rust SDK directly.",
  },
  {
    targetId: "swift",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportModes.DIRECT_C_ABI,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: false,
    inferred: true,
    reason:
      "Use Swift C interop against the WasmEdge C API instead of a separate wrapper package.",
  },
]);

function cloneTargetSupport(value) {
  return {
    ...value,
  };
}

export const WasmEdgeSupportMode = WasmEdgeSupportModes;

export function listWasmEdgeTargetSupport() {
  return WasmEdgeTargetSupportCatalog.map((entry) => cloneTargetSupport(entry));
}

export function getWasmEdgeTargetSupport(targetId) {
  const normalizedTargetId = String(targetId ?? "").trim().toLowerCase();
  const descriptor = WasmEdgeTargetSupportCatalog.find(
    (entry) => entry.targetId === normalizedTargetId,
  );
  return descriptor ? cloneTargetSupport(descriptor) : null;
}

export function listInstallableWasmEdgeLikeWrappers() {
  return WasmEdgeTargetSupportCatalog.filter(
    (entry) => entry.supportMode === WasmEdgeSupportModes.WRAPPER_REQUIRED,
  ).map((entry) => cloneTargetSupport(entry));
}

export default {
  WasmEdgeSupportMode,
  getWasmEdgeTargetSupport,
  listInstallableWasmEdgeLikeWrappers,
  listWasmEdgeTargetSupport,
};
