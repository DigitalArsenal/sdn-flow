import test from "node:test";
import assert from "node:assert/strict";

import {
  createFlowDeploymentPlan,
  deserializeCompiledArtifact,
  FlowDeploymentClient,
  normalizeCompiledArtifact,
  resolveCompiledArtifactEnvelope,
  resolveCompiledArtifactInput,
  serializeCompiledArtifact,
} from "../src/index.js";

test("compiled artifacts require an embedded manifest and default manifest exports", async () => {
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.test",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });

  assert.equal(artifact.programId, "flow.artifact.test");
  assert.equal(artifact.runtimeModel, "compiled-cpp-wasm");
  assert.equal(
    artifact.manifestExports.bytesSymbol,
    "flow_get_manifest_flatbuffer",
  );
  assert.equal(
    artifact.manifestExports.sizeSymbol,
    "flow_get_manifest_flatbuffer_size",
  );
  assert.equal(artifact.runtimeExports.descriptorSymbol, null);
});

test("compiled artifacts reject missing embedded manifest bytes", async () => {
  await assert.rejects(
    normalizeCompiledArtifact({
      programId: "flow.artifact.invalid",
      wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    }),
    /embedded FlatBuffer manifest/,
  );
});

test("compiled artifacts normalize extended runtime descriptor exports", async () => {
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.exports",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
    runtime_exports: {
      node_descriptors_symbol: "sdn_flow_get_node_descriptors",
      node_descriptor_count_symbol: "sdn_flow_get_node_descriptor_count",
      node_dispatch_descriptors_symbol:
        "sdn_flow_get_node_dispatch_descriptors",
      node_dispatch_descriptor_count_symbol:
        "sdn_flow_get_node_dispatch_descriptor_count",
      ingress_frame_descriptors_symbol:
        "sdn_flow_get_ingress_frame_descriptors",
      ingress_frame_descriptor_count_symbol:
        "sdn_flow_get_ingress_frame_descriptor_count",
      current_invocation_descriptor_symbol:
        "sdn_flow_get_current_invocation_descriptor",
      prepare_invocation_descriptor_symbol:
        "sdn_flow_prepare_node_invocation_descriptor",
      apply_invocation_result_symbol: "sdn_flow_apply_node_invocation_result",
      dispatch_host_invocation_symbol:
        "sdn_flow_dispatch_next_ready_node_with_host",
      drain_with_host_dispatch_symbol: "sdn_flow_drain_with_host_dispatch",
      editor_metadata_json_symbol: "sdn_flow_get_editor_metadata_json",
      editor_metadata_size_symbol: "sdn_flow_get_editor_metadata_size",
      enqueue_trigger_frame_symbol: "sdn_flow_enqueue_trigger_frame",
      enqueue_edge_frame_symbol: "sdn_flow_enqueue_edge_frame",
      external_interface_descriptors_symbol:
        "sdn_flow_get_external_interface_descriptors",
      external_interface_descriptor_count_symbol:
        "sdn_flow_get_external_interface_descriptor_count",
      node_ingress_indices_symbol: "sdn_flow_get_node_ingress_indices",
      node_ingress_index_count_symbol: "sdn_flow_get_node_ingress_index_count",
    },
  });

  assert.equal(
    artifact.runtimeExports.nodeDescriptorsSymbol,
    "sdn_flow_get_node_descriptors",
  );
  assert.equal(
    artifact.runtimeExports.nodeDescriptorCountSymbol,
    "sdn_flow_get_node_descriptor_count",
  );
  assert.equal(
    artifact.runtimeExports.nodeDispatchDescriptorsSymbol,
    "sdn_flow_get_node_dispatch_descriptors",
  );
  assert.equal(
    artifact.runtimeExports.nodeDispatchDescriptorCountSymbol,
    "sdn_flow_get_node_dispatch_descriptor_count",
  );
  assert.equal(
    artifact.runtimeExports.ingressFrameDescriptorsSymbol,
    "sdn_flow_get_ingress_frame_descriptors",
  );
  assert.equal(
    artifact.runtimeExports.ingressFrameDescriptorCountSymbol,
    "sdn_flow_get_ingress_frame_descriptor_count",
  );
  assert.equal(
    artifact.runtimeExports.currentInvocationDescriptorSymbol,
    "sdn_flow_get_current_invocation_descriptor",
  );
  assert.equal(
    artifact.runtimeExports.prepareInvocationDescriptorSymbol,
    "sdn_flow_prepare_node_invocation_descriptor",
  );
  assert.equal(
    artifact.runtimeExports.applyInvocationResultSymbol,
    "sdn_flow_apply_node_invocation_result",
  );
  assert.equal(
    artifact.runtimeExports.dispatchHostInvocationSymbol,
    "sdn_flow_dispatch_next_ready_node_with_host",
  );
  assert.equal(
    artifact.runtimeExports.drainWithHostDispatchSymbol,
    "sdn_flow_drain_with_host_dispatch",
  );
  assert.equal(
    artifact.runtimeExports.editorMetadataJsonSymbol,
    "sdn_flow_get_editor_metadata_json",
  );
  assert.equal(
    artifact.runtimeExports.editorMetadataSizeSymbol,
    "sdn_flow_get_editor_metadata_size",
  );
  assert.equal(
    artifact.runtimeExports.enqueueTriggerFrameSymbol,
    "sdn_flow_enqueue_trigger_frame",
  );
  assert.equal(
    artifact.runtimeExports.enqueueEdgeFrameSymbol,
    "sdn_flow_enqueue_edge_frame",
  );
  assert.equal(
    artifact.runtimeExports.externalInterfaceDescriptorsSymbol,
    "sdn_flow_get_external_interface_descriptors",
  );
  assert.equal(
    artifact.runtimeExports.externalInterfaceDescriptorCountSymbol,
    "sdn_flow_get_external_interface_descriptor_count",
  );
  assert.equal(
    artifact.runtimeExports.nodeIngressIndicesSymbol,
    "sdn_flow_get_node_ingress_indices",
  );
  assert.equal(
    artifact.runtimeExports.nodeIngressIndexCountSymbol,
    "sdn_flow_get_node_ingress_index_count",
  );
});

test("serialized compiled artifacts can be decoded back into runtime artifacts", async () => {
  const normalized = await normalizeCompiledArtifact({
    programId: "flow.artifact.serialized",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
    runtimeExports: {
      readyNodeSymbol: "sdn_flow_get_ready_node_index",
      drainWithHostDispatchSymbol: "sdn_flow_drain_with_host_dispatch",
    },
  });
  const serialized = serializeCompiledArtifact(normalized);
  const decoded = await deserializeCompiledArtifact(serialized);

  assert.equal(decoded.programId, normalized.programId);
  assert.deepEqual(Array.from(decoded.wasm), Array.from(normalized.wasm));
  assert.deepEqual(
    Array.from(decoded.manifestBuffer),
    Array.from(normalized.manifestBuffer),
  );
  assert.equal(
    decoded.runtimeExports.readyNodeSymbol,
    "sdn_flow_get_ready_node_index",
  );
  assert.equal(
    decoded.runtimeExports.drainWithHostDispatchSymbol,
    "sdn_flow_drain_with_host_dispatch",
  );
});

test("deployment payloads can be resolved into compiled runtime artifacts", async () => {
  const client = new FlowDeploymentClient();
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.deployment",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });
  const deployment = await client.prepareDeployment({
    artifact,
    deploymentPlan: createFlowDeploymentPlan({
      programId: "flow.artifact.deployment",
      version: "0.1.0",
      triggers: [
        {
          triggerId: "trigger-http-in-1",
          kind: "http-request",
          source: "/catalog",
        },
      ],
      editor: {
        nodes: {
          "http-in-1": {
            type: "http in",
            config: {
              method: "get",
              url: "/catalog",
            },
          },
        },
      },
    }),
    target: {
      kind: "local",
      runtimeId: "runtime-deploy-test",
      transport: "same-app",
    },
  });

  assert.equal(deployment.payload.deploymentPlan.serviceBindings.length, 1);
  const resolved = await resolveCompiledArtifactInput(deployment);

  assert.equal(resolved.programId, artifact.programId);
  assert.equal(resolved.runtimeModel, "compiled-cpp-wasm");
  assert.deepEqual(Array.from(resolved.wasm), Array.from(artifact.wasm));
});

test("serialized deployment json can be resolved into compiled runtime artifacts", async () => {
  const client = new FlowDeploymentClient();
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.serialized.deployment",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });
  const deployment = await client.prepareDeployment({
    artifact,
    target: {
      kind: "local",
      runtimeId: "runtime-json-deployment",
    },
  });

  const resolved = await resolveCompiledArtifactInput(
    JSON.stringify(deployment),
  );

  assert.equal(resolved.programId, artifact.programId);
  assert.deepEqual(Array.from(resolved.wasm), Array.from(artifact.wasm));
});

test("encrypted deployment payloads fail closed during host artifact resolution", async () => {
  await assert.rejects(
    resolveCompiledArtifactInput({
      encrypted: true,
      envelope: {
        ciphertextBase64: "abc",
      },
    }),
    /must be decrypted before host startup/,
  );
});

test("encrypted deployment payloads can be resolved with an explicit decryptor", async () => {
  const client = new FlowDeploymentClient();
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.encrypted",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });
  const deployment = await client.prepareDeployment({
    artifact,
    target: {
      kind: "local",
      runtimeId: "runtime-encrypted-test",
      transport: "same-app",
    },
  });

  const resolved = await resolveCompiledArtifactInput(
    {
      encrypted: true,
      envelope: {
        opaque: true,
      },
    },
    {
      async decrypt(envelope) {
        assert.equal(envelope.opaque, true);
        return deployment;
      },
    },
  );

  assert.equal(resolved.programId, artifact.programId);
  assert.deepEqual(Array.from(resolved.wasm), Array.from(artifact.wasm));
});

test("deployment envelope resolution preserves authorization metadata after decryption", async () => {
  const client = new FlowDeploymentClient();
  const issuedAt = Date.now();
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.authorized",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });
  const deployment = await client.prepareDeployment({
    artifact,
    signer: {
      algorithm: "test",
      publicKeyHex: "abc123",
      async sign(bytes) {
        return bytes.subarray(0, Math.min(bytes.length, 8));
      },
    },
    authorization: {
      version: 1,
      action: "deploy-flow",
      artifactId: artifact.artifactId,
      programId: artifact.programId,
      graphHash: artifact.graphHash,
      manifestHash: artifact.manifestHash,
      target: {
        kind: "local",
        id: "runtime-auth",
      },
      capabilities: [],
      issuedAt,
      expiresAt: issuedAt + 60_000,
      nonce: "abc123",
    },
  });

  const resolved = await resolveCompiledArtifactEnvelope(
    {
      encrypted: true,
      envelope: {
        opaque: true,
      },
    },
    {
      async decrypt(envelope) {
        assert.equal(envelope.opaque, true);
        return deployment;
      },
    },
  );

  assert.equal(resolved.kind, "compiled-flow-wasm-deployment");
  assert.equal(resolved.authorization.payload.programId, artifact.programId);
  assert.equal(resolved.target.kind, "remote");
});
