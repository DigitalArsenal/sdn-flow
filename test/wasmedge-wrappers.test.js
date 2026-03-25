import test from "node:test";
import assert from "node:assert/strict";

import {
  getWasmEdgeTargetSupport,
  listInstallableWasmEdgeLikeWrappers,
  listWasmEdgeTargetSupport,
  startBrowserWasmEdgeLikeRuntime,
  startBunWasmEdgeLikeRuntime,
  startDenoWasmEdgeLikeRuntime,
  WasmEdgeSupportMode,
} from "../src/index.js";

test("listInstallableWasmEdgeLikeWrappers only exposes runtimes that cannot embed WasmEdge directly", () => {
  const wrappers = listInstallableWasmEdgeLikeWrappers();

  assert.deepEqual(
    wrappers.map((entry) => entry.targetId),
    ["browser", "bun", "deno"],
  );
  assert.deepEqual(
    wrappers.map((entry) => entry.installableWrapper),
    [
      "sdn-flow/wrappers/browser",
      "sdn-flow/wrappers/bun",
      "sdn-flow/wrappers/deno",
    ],
  );
  assert.equal(
    wrappers.every(
      (entry) => entry.supportMode === WasmEdgeSupportMode.WRAPPER_REQUIRED,
    ),
    true,
  );
});

test("WasmEdge target support catalog distinguishes direct SDKs, direct interop, and wrapper-only runtimes", () => {
  const support = listWasmEdgeTargetSupport();
  assert.equal(support.length > 0, true);

  assert.deepEqual(getWasmEdgeTargetSupport("go"), {
    targetId: "go",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportMode.DIRECT_SDK,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: true,
    inferred: false,
    reason: "Use the WasmEdge Go SDK directly.",
  });
  assert.deepEqual(getWasmEdgeTargetSupport("kotlin"), {
    targetId: "kotlin",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportMode.DIRECT_JVM,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: false,
    inferred: true,
    reason:
      "Use Kotlin/JVM interop on top of the WasmEdge Java SDK instead of a separate wrapper package.",
  });
  assert.deepEqual(getWasmEdgeTargetSupport("csharp"), {
    targetId: "csharp",
    runtimeFamily: "language",
    supportMode: WasmEdgeSupportMode.DIRECT_C_ABI,
    installableWrapper: null,
    usesNativeWebAssembly: false,
    officialSdk: false,
    inferred: true,
    reason:
      "Use .NET native interop against the WasmEdge C API instead of a separate wrapper package.",
  });
  assert.equal(getWasmEdgeTargetSupport("missing-target"), null);
});

async function assertWrapperForwarding(startWrapper, targetId, wrapperPackage) {
  const received = [];
  const runtime = await startWrapper({
    input: {
      artifactId: `${targetId}-artifact`,
    },
    artifactImports: {
      wasi_snapshot_preview1: {
        fd_write() {
          return 0;
        },
      },
    },
    startRuntime: async (options) => {
      received.push(options);
      return {
        runEntrypoint() {
          return {
            exitCode: 0,
          };
        },
      };
    },
  });

  assert.deepEqual(received, [
    {
      input: {
        artifactId: `${targetId}-artifact`,
      },
      artifactImports: {
        wasi_snapshot_preview1: {
          fd_write: received[0]?.artifactImports?.wasi_snapshot_preview1?.fd_write,
        },
      },
    },
  ]);
  assert.equal(runtime.wrapperCompatibilityProfile, "wasmedge-like");
  assert.equal(runtime.wrapperTarget, targetId);
  assert.equal(runtime.wrapperPackage, wrapperPackage);
  assert.equal(runtime.usesNativeWebAssembly, true);
  assert.equal(runtime.runEntrypoint().exitCode, 0);
}

test("browser bun and deno wrappers forward directly into the standalone runtime contract", async () => {
  await assertWrapperForwarding(
    startBrowserWasmEdgeLikeRuntime,
    "browser",
    "sdn-flow/wrappers/browser",
  );
  await assertWrapperForwarding(
    startBunWasmEdgeLikeRuntime,
    "bun",
    "sdn-flow/wrappers/bun",
  );
  await assertWrapperForwarding(
    startDenoWasmEdgeLikeRuntime,
    "deno",
    "sdn-flow/wrappers/deno",
  );
});
