import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  EmceptionCompilerAdapter,
  SignedArtifactCatalog,
} from "../src/index.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function wasmBytes(seed) {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, seed, seed + 1, seed + 2]);
}

test("emception compiler adapter prepares a single-source C++ compile plan with signed artifacts", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const catalog = new SignedArtifactCatalog();
  flow.artifactDependencies.forEach((dependency, index) => {
    catalog.registerArtifact({
      dependencyId: dependency.dependencyId,
      pluginId: dependency.pluginId,
      version: dependency.version,
      signature: dependency.signature,
      signerPublicKey: dependency.signerPublicKey,
      wasm: wasmBytes(index + 1),
      manifestBuffer: new Uint8Array([0x50, 0x4c, 0x55, 0x47, index + 1]),
    });
  });

  const files = new Map();
  const emception = {
    async init() {},
    async writeFile(path, data) {
      files.set(path, data);
    },
    async run(command) {
      assert.match(command, /^em\+\+/);
      files.set("/working/flow-runtime.wasm", wasmBytes(99));
      files.set("/working/flow-runtime.mjs", "export default function() {}");
      return {
        returncode: 0,
        stdout: "",
        stderr: "",
      };
    },
    async readFile(path, options = {}) {
      const value = files.get(path);
      if (options.encoding === "utf8") {
        return typeof value === "string"
          ? value
          : new TextDecoder().decode(value);
      }
      return typeof value === "string"
        ? new TextEncoder().encode(value)
        : value;
    },
  };

  const compiler = new EmceptionCompilerAdapter({
    emception,
    artifactCatalog: catalog,
    manifestBuilder: async () => new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
  });

  const prepared = await compiler.prepareCompile({ program: flow });
  assert.equal(prepared.dependencies.length, 6);
  assert.equal(prepared.runtimeModel, "compiled-cpp-wasm");
  assert.equal(
    prepared.runtimeExports.descriptorSymbol,
    "sdn_flow_get_runtime_descriptor",
  );
  assert.match(prepared.command, /\/working\/flow-runtime\.mjs$/);
  assert.match(prepared.source, /flow_get_manifest_flatbuffer/);
  assert.match(prepared.source, /struct FlowRuntimeDescriptor/);
  assert.match(prepared.source, /sdn_flow_get_runtime_descriptor/);
  assert.match(prepared.source, /sdn_flow_reset_runtime_state/);
  assert.match(prepared.source, /kNodeRuntimeStates/);
  assert.match(prepared.source, /sdn_flow_get_dependency_descriptors/);
  assert.match(prepared.source, /com\.digitalarsenal\.flatsql\.memory/);
  assert.match(prepared.command, /_sdn_flow_get_runtime_descriptor/);
  assert.match(prepared.command, /_sdn_flow_reset_runtime_state/);

  const artifact = await compiler.compile({ program: flow });
  assert.equal(artifact.programId, flow.programId);
  assert.equal(artifact.runtimeModel, "compiled-cpp-wasm");
  assert.equal(
    artifact.runtimeExports.descriptorSymbol,
    "sdn_flow_get_runtime_descriptor",
  );
  assert.equal(artifact.pluginVersions.length, 6);
  assert.equal(artifact.requiredCapabilities.includes("storage_query"), true);
  assert.equal(artifact.requiredCapabilities.includes("pubsub"), true);
  assert.ok(artifact.wasm instanceof Uint8Array);
  assert.equal(artifact.loaderModule.includes("export default"), true);
});
