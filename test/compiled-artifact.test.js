import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCompiledArtifact } from "../src/index.js";

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
