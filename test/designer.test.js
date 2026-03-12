import test from "node:test";
import assert from "node:assert/strict";

import {
  FlowDeploymentClient,
  FlowDesignerSession,
  createHdWalletSigner,
} from "../src/index.js";

test("single-plugin flows compile and deploy as compiled wasm artifacts", async () => {
  const session = FlowDesignerSession.fromSinglePlugin({
    programId: "flow.single.plugin",
    pluginId: "com.digitalarsenal.example.plugin",
    methodId: "process",
    trigger: {
      kind: "manual",
    },
  });

  const compiler = {
    async compile({ program }) {
      assert.equal(program.nodes.length, 1);
      return {
        artifactId: "artifact-1",
        programId: program.programId,
        wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
        manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
        requiredCapabilities: ["pubsub"],
      };
    },
  };

  const signer = createHdWalletSigner({
    publicKeyHex: "02010203",
    async signDigest(digest) {
      return digest;
    },
  });

  const deploymentClient = new FlowDeploymentClient();
  const deployment = await session.deploy({
    compiler,
    deploymentClient,
    signer,
    target: {
      kind: "local",
      async deploy(payload) {
        return payload;
      },
    },
  });

  assert.equal(deployment.encrypted, false);
  assert.equal(deployment.payload.kind, "compiled-flow-wasm-deployment");
  assert.equal(deployment.payload.artifact.programId, "flow.single.plugin");
  assert.equal(typeof deployment.payload.artifact.wasmBase64, "string");
  assert.equal(typeof deployment.payload.artifact.manifestBase64, "string");
  assert.equal(
    deployment.payload.artifact.manifestExports.bytesSymbol,
    "flow_get_manifest_flatbuffer",
  );
});
