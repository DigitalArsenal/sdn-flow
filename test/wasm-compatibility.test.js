import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  bindCompiledFlowRuntimeHost,
  describeFlowWasmImportContract,
  listWasmImportModules,
  RuntimeTarget,
} from "../src/index.js";
import { compileLinkedFlowArtifact } from "../test-support/linkedFlowArtifact.js";

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function encodeString(value) {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...encodeU32(bytes.length), ...bytes];
}

function createSection(sectionId, payload) {
  return [sectionId, ...encodeU32(payload.length), ...payload];
}

function buildWasmWithImportedFunction(moduleName, importName = "invoke") {
  const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const typeSection = createSection(1, [
    ...encodeU32(1),
    0x60,
    ...encodeU32(0),
    ...encodeU32(0),
  ]);
  const importSection = createSection(2, [
    ...encodeU32(1),
    ...encodeString(moduleName),
    ...encodeString(importName),
    0x00,
    ...encodeU32(0),
  ]);
  return new Uint8Array([
    ...magicAndVersion,
    ...typeSection,
    ...importSection,
  ]);
}

test("describeFlowWasmImportContract classifies fully linked flow artifacts as wasmedge-compatible", async () => {
  const { artifact } = await compileLinkedFlowArtifact({
    runtimeTargets: [RuntimeTarget.WASMEDGE],
    workingDirectory: `/working/wasm-compat-contract-${randomUUID()}`,
  });

  assert.deepEqual(listWasmImportModules(artifact.wasm), [
    "wasi_snapshot_preview1",
  ]);
  assert.deepEqual(describeFlowWasmImportContract(artifact.wasm), {
    valid: true,
    modules: ["wasi_snapshot_preview1"],
    compatibilityProfile: "wasmedge-compatible",
    isWasmEdgeCompatible: true,
    isHostCompatible: true,
  });
});

test("describeFlowWasmImportContract treats any non-wasi guest imports as custom and unsupported", () => {
  const flowHostContract = describeFlowWasmImportContract(
    buildWasmWithImportedFunction(
      "sdn_flow_host",
      "dispatch_current_invocation",
    ),
  );
  assert.deepEqual(flowHostContract, {
    valid: true,
    modules: ["sdn_flow_host"],
    compatibilityProfile: "custom",
    isWasmEdgeCompatible: false,
    isHostCompatible: false,
  });

  const customContract = describeFlowWasmImportContract(
    buildWasmWithImportedFunction("custom_runtime", "dispatch"),
  );
  assert.deepEqual(customContract, {
    valid: true,
    modules: ["custom_runtime"],
    compatibilityProfile: "custom",
    isWasmEdgeCompatible: false,
    isHostCompatible: false,
  });
});

test("bindCompiledFlowRuntimeHost rejects unsupported custom guest import modules before instantiation", async () => {
  let instantiateCalls = 0;
  await assert.rejects(
    bindCompiledFlowRuntimeHost({
      artifact: {
        programId: "com.digitalarsenal.tests.custom-runtime-imports",
        wasm: buildWasmWithImportedFunction("custom_runtime", "dispatch"),
        manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
      },
      instantiateArtifact: async () => {
        instantiateCalls += 1;
        return {
          instance: {
            exports: {},
          },
        };
      },
    }),
    /unsupported guest modules custom_runtime/i,
  );
  assert.equal(instantiateCalls, 0);
});
