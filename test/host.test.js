import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  bindCompiledDescriptorAbi,
  bindCompiledFlowRuntimeHost,
  bindCompiledInvocationAbi,
  bindCompiledRuntimeAbi,
  DefaultRequiredRuntimeExportRoles,
  FlowDeploymentClient,
  FlowNodeDispatchDescriptorLayout,
  HostedRuntimeAdapter,
  HostedRuntimeAuthority,
  HostedRuntimeBindingDirection,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
  HostedRuntimeTransport,
  instantiateEmbeddedDependencies,
  normalizeHostedRuntimePlan,
  SignedArtifactDependencyDescriptorLayout,
  summarizeHostedRuntimePlan,
} from "../src/index.js";
import { generateRuntimeAbiLayoutsSource } from "../scripts/build-runtime-abi.mjs";

const INVALID_INDEX = 0xffffffff;

function compiledArtifactStub() {
  return {
    programId: "com.digitalarsenal.license.local",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
    requiredCapabilities: ["protocol_handle", "protocol_dial", "timers"],
  };
}

test("host plan models an early-start local licensing runtime for disconnected OrbPro", () => {
  const plan = normalizeHostedRuntimePlan({
    hostId: "orbpro-browser",
    hostKind: "orbpro",
    adapter: HostedRuntimeAdapter.SDN_JS,
    runtimes: [
      {
        runtimeId: "license-service",
        kind: HostedRuntimeKind.SERVICE,
        programId: "com.orbpro.license.local",
        startupPhase: HostedRuntimeStartupPhase.EARLY,
        autoStart: true,
        authority: HostedRuntimeAuthority.LOCAL,
        execution: "compiled-wasm",
        bindings: [
          {
            bindingId: "license-loopback",
            direction: HostedRuntimeBindingDirection.LISTEN,
            transport: HostedRuntimeTransport.SAME_APP,
            protocolId: "/orbpro/licensing/1.0.0",
          },
          {
            bindingId: "license-webrtc",
            direction: HostedRuntimeBindingDirection.LISTEN,
            transport: HostedRuntimeTransport.WEBRTC,
            protocolId: "/orbpro/licensing/1.0.0",
          },
        ],
      },
      {
        runtimeId: "orbpro-session",
        kind: HostedRuntimeKind.FLOW,
        programId: "com.orbpro.session",
        startupPhase: HostedRuntimeStartupPhase.SESSION,
        autoStart: true,
        authority: HostedRuntimeAuthority.LOCAL,
        dependsOn: ["license-service"],
        bindings: [
          {
            bindingId: "license-client",
            direction: HostedRuntimeBindingDirection.DIAL,
            transport: HostedRuntimeTransport.SAME_APP,
            protocolId: "/orbpro/licensing/1.0.0",
            targetRuntimeId: "license-service",
            required: true,
          },
        ],
      },
    ],
  });
  const summary = summarizeHostedRuntimePlan(plan);

  assert.deepEqual(
    summary.startupOrder.map((runtime) => runtime.runtimeId),
    ["license-service", "orbpro-session"],
  );
  assert.deepEqual(summary.earlyStartRuntimes, ["license-service"]);
  assert.deepEqual(summary.localServices, [
    {
      runtimeId: "license-service",
      startupPhase: HostedRuntimeStartupPhase.EARLY,
      adapter: HostedRuntimeAdapter.SDN_JS,
    },
  ]);
  assert.equal(summary.adapters.includes(HostedRuntimeAdapter.SDN_JS), true);
  assert.equal(
    summary.transports.includes(HostedRuntimeTransport.SAME_APP),
    true,
  );
  assert.equal(
    summary.transports.includes(HostedRuntimeTransport.WEBRTC),
    true,
  );
  assert.equal(summary.disconnectedCapable, true);
});

test("plugin hosted runtimes default to compiled-wasm execution", () => {
  const plan = normalizeHostedRuntimePlan({
    hostId: "orbpro-browser",
    runtimes: [
      {
        runtimeId: "single-plugin-runtime",
        kind: HostedRuntimeKind.PLUGIN,
        pluginId: "com.orbpro.sgp4",
      },
    ],
  });

  assert.equal(plan.runtimes[0].execution, "compiled-wasm");
});

test("deployment client preserves hosted runtime target details", async () => {
  const client = new FlowDeploymentClient();
  const deployment = await client.prepareDeployment({
    artifact: compiledArtifactStub(),
    target: {
      kind: "same-app",
      runtimeId: "license-service",
      transport: HostedRuntimeTransport.SAME_APP,
      protocolId: "/orbpro/licensing/1.0.0",
      startupPhase: HostedRuntimeStartupPhase.EARLY,
      adapter: HostedRuntimeAdapter.SDN_JS,
      disconnected: true,
    },
  });

  assert.equal(deployment.encrypted, false);
  assert.equal(deployment.payload.target.kind, "same-app");
  assert.equal(deployment.payload.target.runtimeId, "license-service");
  assert.equal(
    deployment.payload.target.transport,
    HostedRuntimeTransport.SAME_APP,
  );
  assert.equal(deployment.payload.target.protocolId, "/orbpro/licensing/1.0.0");
  assert.equal(
    deployment.payload.target.startupPhase,
    HostedRuntimeStartupPhase.EARLY,
  );
  assert.equal(deployment.payload.target.adapter, HostedRuntimeAdapter.SDN_JS);
  assert.equal(deployment.payload.target.disconnected, true);
});

test("host runtime abi binder resolves compiled descriptor exports from a wasm instance", async () => {
  const runtimeDescriptor = () => {};
  const nodeDescriptors = () => {};
  const externalInterfaces = () => {};
  const bound = await bindCompiledRuntimeAbi({
    artifact: {
      ...compiledArtifactStub(),
      runtimeExports: {
        descriptorSymbol: "sdn_flow_get_runtime_descriptor",
        resetStateSymbol: "sdn_flow_reset_runtime_state",
        enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
        enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
        readyNodeSymbol: "sdn_flow_get_ready_node_index",
        beginInvocationSymbol: "sdn_flow_begin_node_invocation",
        completeInvocationSymbol: "sdn_flow_complete_node_invocation",
        applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
        nodeDescriptorsSymbol: "sdn_flow_get_node_descriptors",
        nodeDescriptorCountSymbol: "sdn_flow_get_node_descriptor_count",
        nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
        nodeDispatchDescriptorCountSymbol:
          "sdn_flow_get_node_dispatch_descriptor_count",
        ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
        ingressFrameDescriptorCountSymbol:
          "sdn_flow_get_ingress_frame_descriptor_count",
        currentInvocationDescriptorSymbol:
          "sdn_flow_get_current_invocation_descriptor",
        prepareInvocationDescriptorSymbol:
          "sdn_flow_prepare_node_invocation_descriptor",
        enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
        enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
        externalInterfaceDescriptorsSymbol:
          "sdn_flow_get_external_interface_descriptors",
        externalInterfaceDescriptorCountSymbol:
          "sdn_flow_get_external_interface_descriptor_count",
      },
    },
    wasmExports: {
      sdn_flow_get_runtime_descriptor: runtimeDescriptor,
      sdn_flow_reset_runtime_state() {},
      sdn_flow_enqueue_trigger_frames() {},
      sdn_flow_enqueue_edge_frames() {},
      sdn_flow_get_ready_node_index() {},
      sdn_flow_begin_node_invocation() {},
      sdn_flow_complete_node_invocation() {},
      sdn_flow_apply_node_invocation_result() {
        return 0;
      },
      sdn_flow_get_node_descriptors: nodeDescriptors,
      sdn_flow_get_node_descriptor_count() {
        return 1;
      },
      sdn_flow_get_node_dispatch_descriptors() {},
      sdn_flow_get_node_dispatch_descriptor_count() {
        return 1;
      },
      sdn_flow_get_ingress_frame_descriptors() {},
      sdn_flow_get_ingress_frame_descriptor_count() {
        return 1;
      },
      sdn_flow_get_current_invocation_descriptor() {},
      sdn_flow_prepare_node_invocation_descriptor() {
        return 1;
      },
      sdn_flow_enqueue_trigger_frame() {},
      sdn_flow_enqueue_edge_frame() {},
      sdn_flow_get_external_interface_descriptors: externalInterfaces,
      sdn_flow_get_external_interface_descriptor_count() {
        return 2;
      },
    },
  });

  assert.deepEqual(
    bound.requiredRoles,
    Array.from(DefaultRequiredRuntimeExportRoles),
  );
  assert.equal(bound.resolvedByRole.descriptorSymbol, runtimeDescriptor);
  assert.equal(bound.resolvedByRole.nodeDescriptorsSymbol, nodeDescriptors);
  assert.equal(
    typeof bound.resolvedByRole.nodeDispatchDescriptorsSymbol,
    "function",
  );
  assert.equal(
    typeof bound.resolvedByRole.prepareInvocationDescriptorSymbol,
    "function",
  );
  assert.equal(
    bound.resolvedByRole.externalInterfaceDescriptorsSymbol,
    externalInterfaces,
  );
  assert.equal(
    bound.resolvedBySymbol.sdn_flow_get_runtime_descriptor,
    runtimeDescriptor,
  );
});

test("generated runtime abi layouts stay in sync with the canonical fbs schema", async () => {
  const expected = await generateRuntimeAbiLayoutsSource();
  const actual = await readFile(
    new URL("../src/generated/runtimeAbiLayouts.js", import.meta.url),
    "utf8",
  );
  assert.equal(actual, expected);
});

test("compiled invocation abi can stage a frame and decode the current invocation", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const pluginIdPointer = 512;
  const methodIdPointer = 576;
  const inputPortPointer = 640;
  const ingressFramePointer = 1024;
  const invocationFramePointer = 1152;
  const invocationPointer = 1280;
  const allocPointer = 2048;

  const writeCString = (pointer, value) => {
    const encoded = new TextEncoder().encode(`${value}\0`);
    bytes.set(encoded, pointer);
  };
  writeCString(pluginIdPointer, "com.digitalarsenal.propagator.sgp4");
  writeCString(methodIdPointer, "propagate_one_orbit_samples");
  writeCString(inputPortPointer, "in");

  const copyFrame = (sourcePointer, targetPointer, ingressIndex = 0) => {
    bytes.copyWithin(targetPointer, sourcePointer, sourcePointer + 48);
    view.setUint32(targetPointer, ingressIndex, true);
    view.setUint8(targetPointer + 41, 1);
  };

  const bound = await bindCompiledInvocationAbi({
    artifact: {
      ...compiledArtifactStub(),
      runtimeExports: {
        mallocSymbol: "malloc",
        freeSymbol: "free",
        descriptorSymbol: "sdn_flow_get_runtime_descriptor",
        resetStateSymbol: "sdn_flow_reset_runtime_state",
        enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
        enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
        enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
        enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
        readyNodeSymbol: "sdn_flow_get_ready_node_index",
        beginInvocationSymbol: "sdn_flow_begin_node_invocation",
        completeInvocationSymbol: "sdn_flow_complete_node_invocation",
        ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
        ingressFrameDescriptorCountSymbol:
          "sdn_flow_get_ingress_frame_descriptor_count",
        currentInvocationDescriptorSymbol:
          "sdn_flow_get_current_invocation_descriptor",
        prepareInvocationDescriptorSymbol:
          "sdn_flow_prepare_node_invocation_descriptor",
        applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
      },
    },
    wasmExports: {
      memory,
      _malloc() {
        return allocPointer;
      },
      _free() {},
      _sdn_flow_get_runtime_descriptor() {
        return 64;
      },
      _sdn_flow_reset_runtime_state() {},
      _sdn_flow_enqueue_trigger_frames() {},
      _sdn_flow_enqueue_trigger_frame(_triggerIndex, framePointer) {
        copyFrame(framePointer, ingressFramePointer, 0);
        return 1;
      },
      _sdn_flow_enqueue_edge_frames() {},
      _sdn_flow_enqueue_edge_frame() {
        return 1;
      },
      _sdn_flow_get_ready_node_index() {
        return 3;
      },
      _sdn_flow_begin_node_invocation() {
        return 1;
      },
      _sdn_flow_complete_node_invocation() {},
      _sdn_flow_get_ingress_frame_descriptors() {
        return ingressFramePointer;
      },
      _sdn_flow_get_ingress_frame_descriptor_count() {
        return 1;
      },
      _sdn_flow_get_current_invocation_descriptor() {
        return invocationPointer;
      },
      _sdn_flow_prepare_node_invocation_descriptor(nodeIndex) {
        copyFrame(ingressFramePointer, invocationFramePointer, 0);
        view.setUint32(invocationFramePointer + 8, inputPortPointer, true);
        view.setUint32(invocationPointer, nodeIndex, true);
        view.setUint32(invocationPointer + 4, nodeIndex, true);
        view.setUint32(invocationPointer + 8, pluginIdPointer, true);
        view.setUint32(invocationPointer + 12, methodIdPointer, true);
        view.setUint32(invocationPointer + 16, invocationFramePointer, true);
        view.setUint32(invocationPointer + 20, 1, true);
        return 1;
      },
      _sdn_flow_apply_node_invocation_result() {
        return 0;
      },
    },
  });

  const enqueueCount = bound.enqueueTriggerFrame(0, {
    typeDescriptorIndex: 2,
    alignment: 8,
    offset: 1234,
    size: 64,
    streamId: 9,
    sequence: 7,
    traceToken: 55,
    endOfStream: true,
  });
  assert.equal(enqueueCount, 1);

  const ingressFrames = bound.readIngressFrameDescriptors();
  assert.equal(ingressFrames.length, 1);
  assert.equal(ingressFrames[0].offset, 1234);
  assert.equal(ingressFrames[0].traceToken, 55);

  const invocation = bound.prepareNodeInvocationDescriptor(3, 1);
  assert.equal(invocation.nodeIndex, 3);
  assert.equal(invocation.pluginId, "com.digitalarsenal.propagator.sgp4");
  assert.equal(invocation.methodId, "propagate_one_orbit_samples");
  assert.equal(invocation.frameCount, 1);
  assert.equal(invocation.frames[0].portId, "in");
  assert.equal(invocation.frames[0].offset, 1234);
  assert.equal(invocation.frames[0].sequence, 7);
  assert.equal(invocation.frames[0].endOfStream, true);
});

test("compiled descriptor abi decodes node dispatch and embedded dependency records", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const strings = {
    nodeId: 512,
    dependencyId: 560,
    pluginId: 624,
    methodId: 704,
    dispatchModel: 768,
    entrypoint: 832,
    manifestBytesSymbol: 896,
    manifestSizeSymbol: 960,
    initSymbol: 1024,
    destroySymbol: 1088,
    mallocSymbol: 1152,
    freeSymbol: 1216,
    streamInvokeSymbol: 1280,
    version: 1344,
    sha256: 1408,
    signature: 1472,
    signerPublicKey: 1568,
  };
  const nodeDispatchPointer = 2048;
  const dependencyPointer = 4096;
  const wasmBytesPointer = 4608;
  const manifestBytesPointer = 4704;

  const writeCString = (pointer, value) => {
    bytes.set(new TextEncoder().encode(`${value}\0`), pointer);
  };
  for (const [key, pointer] of Object.entries(strings)) {
    const values = {
      nodeId: "node-propagate",
      dependencyId: "dep-sgp4",
      pluginId: "com.digitalarsenal.propagator.sgp4",
      methodId: "propagate_one_orbit_samples",
      dispatchModel: "stream-invoke",
      entrypoint: "main",
      manifestBytesSymbol: "plugin_get_manifest_flatbuffer",
      manifestSizeSymbol: "plugin_get_manifest_flatbuffer_size",
      initSymbol: "plugin_init",
      destroySymbol: "plugin_destroy",
      mallocSymbol: "malloc",
      freeSymbol: "free",
      streamInvokeSymbol: "plugin_stream_invoke",
      version: "1.2.3",
      sha256: "deadbeef",
      signature: "sig-1",
      signerPublicKey: "pub-1",
    };
    writeCString(pointer, values[key]);
  }
  bytes.set([0x00, 0x61, 0x73, 0x6d], wasmBytesPointer);
  bytes.set([0x46, 0x4c, 0x4f, 0x57], manifestBytesPointer);

  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIdPointer.offset,
    strings.nodeId,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIdPointer.offset,
    strings.dependencyId,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.pluginIdPointer.offset,
    strings.pluginId,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.methodIdPointer.offset,
    strings.methodId,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dispatchModelPointer.offset,
    strings.dispatchModel,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.entrypointPointer.offset,
    strings.entrypoint,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.manifestBytesSymbolPointer.offset,
    strings.manifestBytesSymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.manifestSizeSymbolPointer.offset,
    strings.manifestSizeSymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.initSymbolPointer.offset,
    strings.initSymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.destroySymbolPointer.offset,
    strings.destroySymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.mallocSymbolPointer.offset,
    strings.mallocSymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.freeSymbolPointer.offset,
    strings.freeSymbol,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.streamInvokeSymbolPointer.offset,
    strings.streamInvokeSymbol,
    true,
  );

  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.dependencyIdPointer
        .offset,
    strings.dependencyId,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.pluginIdPointer.offset,
    strings.pluginId,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.versionPointer.offset,
    strings.version,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.sha256Pointer.offset,
    strings.sha256,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.signaturePointer.offset,
    strings.signature,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.signerPublicKeyPointer
        .offset,
    strings.signerPublicKey,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.entrypointPointer.offset,
    strings.entrypoint,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestBytesSymbolPointer
        .offset,
    strings.manifestBytesSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestSizeSymbolPointer
        .offset,
    strings.manifestSizeSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.initSymbolPointer.offset,
    strings.initSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.destroySymbolPointer
        .offset,
    strings.destroySymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.mallocSymbolPointer
        .offset,
    strings.mallocSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.freeSymbolPointer.offset,
    strings.freeSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.streamInvokeSymbolPointer
        .offset,
    strings.streamInvokeSymbol,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmBytesPointer.offset,
    wasmBytesPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmSize.offset,
    4,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestBytesPointer
        .offset,
    manifestBytesPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestSize.offset,
    4,
    true,
  );

  const bound = await bindCompiledDescriptorAbi({
    artifact: {
      ...compiledArtifactStub(),
      runtimeExports: {
        descriptorSymbol: "sdn_flow_get_runtime_descriptor",
        resetStateSymbol: "sdn_flow_reset_runtime_state",
        enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
        enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
        readyNodeSymbol: "sdn_flow_get_ready_node_index",
        beginInvocationSymbol: "sdn_flow_begin_node_invocation",
        completeInvocationSymbol: "sdn_flow_complete_node_invocation",
        applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
        nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
        nodeDispatchDescriptorCountSymbol:
          "sdn_flow_get_node_dispatch_descriptor_count",
        dependencyDescriptorsSymbol: "sdn_flow_get_dependency_descriptors",
        dependencyCountSymbol: "sdn_flow_get_dependency_count",
      },
    },
    wasmExports: {
      memory,
      sdn_flow_get_runtime_descriptor() {
        return 64;
      },
      sdn_flow_reset_runtime_state() {},
      sdn_flow_enqueue_trigger_frames() {},
      sdn_flow_enqueue_edge_frames() {},
      sdn_flow_get_ready_node_index() {
        return 0xffffffff;
      },
      sdn_flow_begin_node_invocation() {
        return 0;
      },
      sdn_flow_complete_node_invocation() {},
      sdn_flow_apply_node_invocation_result() {
        return 0;
      },
      sdn_flow_get_node_dispatch_descriptors() {
        return nodeDispatchPointer;
      },
      sdn_flow_get_node_dispatch_descriptor_count() {
        return 1;
      },
      sdn_flow_get_dependency_descriptors() {
        return dependencyPointer;
      },
      sdn_flow_get_dependency_count() {
        return 1;
      },
    },
  });

  const dispatch = bound.readNodeDispatchDescriptorAt(0);
  const dependency = bound.readDependencyDescriptorAt(0);

  assert.equal(dispatch.nodeId, "node-propagate");
  assert.equal(dispatch.dependencyId, "dep-sgp4");
  assert.equal(dispatch.streamInvokeSymbol, "plugin_stream_invoke");
  assert.equal(dependency.pluginId, "com.digitalarsenal.propagator.sgp4");
  assert.equal(dependency.version, "1.2.3");
  assert.deepEqual(Array.from(dependency.wasmBytes), [0x00, 0x61, 0x73, 0x6d]);
  assert.deepEqual(
    Array.from(dependency.manifestBytes),
    [0x46, 0x4c, 0x4f, 0x57],
  );
});

test("compiled flow runtime host executes a ready node through bound handlers", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const pluginIdPointer = 512;
  const methodIdPointer = 576;
  const inputPortPointer = 640;
  const nodeIdPointer = 704;
  const dependencyIdPointer = 768;
  const invocationFramePointer = 1152;
  const invocationPointer = 1280;
  const nodeDispatchPointer = 1408;
  const dependencyPointer = 1536;
  const dependencyWasmPointer = 1664;
  const dependencyManifestPointer = 1728;
  let allocPointer = 2048;
  let ready = true;
  let routedOutputs = 0;
  let lastOutputPort = null;
  let lastOutputBytes = null;
  let resetCalls = 0;
  let lastDependencyId = null;
  const freedPointers = [];
  const inputPayload = new Uint8Array([1, 2, 3, 4]);

  const writeCString = (pointer, value) => {
    const encoded = new TextEncoder().encode(`${value}\0`);
    bytes.set(encoded, pointer);
  };
  writeCString(pluginIdPointer, "com.digitalarsenal.propagator.sgp4");
  writeCString(methodIdPointer, "propagate_one_orbit_samples");
  writeCString(inputPortPointer, "in");
  writeCString(nodeIdPointer, "node-propagate");
  writeCString(dependencyIdPointer, "dep-sgp4");
  bytes.set(inputPayload, 1234);
  bytes.set([0x00, 0x61, 0x73, 0x6d], dependencyWasmPointer);
  bytes.set([0x46, 0x4c, 0x4f, 0x57], dependencyManifestPointer);

  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIdPointer.offset,
    nodeIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIdPointer.offset,
    dependencyIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.pluginIdPointer.offset,
    pluginIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.methodIdPointer.offset,
    methodIdPointer,
    true,
  );

  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.dependencyIdPointer
        .offset,
    dependencyIdPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.pluginIdPointer.offset,
    pluginIdPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmBytesPointer.offset,
    dependencyWasmPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmSize.offset,
    4,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestBytesPointer
        .offset,
    dependencyManifestPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.manifestSize.offset,
    4,
    true,
  );

  const host = await bindCompiledFlowRuntimeHost({
    artifact: {
      ...compiledArtifactStub(),
      runtimeExports: {
        mallocSymbol: "malloc",
        freeSymbol: "free",
        descriptorSymbol: "sdn_flow_get_runtime_descriptor",
        resetStateSymbol: "sdn_flow_reset_runtime_state",
        enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
        enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
        enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
        enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
        readyNodeSymbol: "sdn_flow_get_ready_node_index",
        beginInvocationSymbol: "sdn_flow_begin_node_invocation",
        completeInvocationSymbol: "sdn_flow_complete_node_invocation",
        ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
        ingressFrameDescriptorCountSymbol:
          "sdn_flow_get_ingress_frame_descriptor_count",
        currentInvocationDescriptorSymbol:
          "sdn_flow_get_current_invocation_descriptor",
        prepareInvocationDescriptorSymbol:
          "sdn_flow_prepare_node_invocation_descriptor",
        applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
        nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
        nodeDispatchDescriptorCountSymbol:
          "sdn_flow_get_node_dispatch_descriptor_count",
        dependencyDescriptorsSymbol: "sdn_flow_get_dependency_descriptors",
        dependencyCountSymbol: "sdn_flow_get_dependency_count",
      },
    },
    wasmExports: {
      memory,
      _malloc(size) {
        const pointer = allocPointer;
        allocPointer += Number(size);
        return pointer;
      },
      _free(pointer) {
        freedPointers.push(Number(pointer));
      },
      _sdn_flow_get_runtime_descriptor() {
        return 64;
      },
      _sdn_flow_reset_runtime_state() {
        resetCalls += 1;
      },
      _sdn_flow_enqueue_trigger_frames() {},
      _sdn_flow_enqueue_trigger_frame() {
        return 1;
      },
      _sdn_flow_enqueue_edge_frames() {},
      _sdn_flow_enqueue_edge_frame() {
        return 1;
      },
      _sdn_flow_get_ready_node_index() {
        return ready ? 0 : 0xffffffff;
      },
      _sdn_flow_begin_node_invocation(nodeIndex) {
        view.setUint32(invocationFramePointer + 0, 0, true);
        view.setUint32(invocationFramePointer + 4, 2, true);
        view.setUint32(invocationFramePointer + 8, inputPortPointer, true);
        view.setUint32(invocationFramePointer + 12, 8, true);
        view.setUint32(invocationFramePointer + 16, 1234, true);
        view.setUint32(invocationFramePointer + 20, 4, true);
        view.setUint32(invocationFramePointer + 24, 9, true);
        view.setUint32(invocationFramePointer + 28, 7, true);
        view.setBigUint64(invocationFramePointer + 32, BigInt(55), true);
        view.setUint8(invocationFramePointer + 40, 1);
        view.setUint8(invocationFramePointer + 41, 1);

        view.setUint32(invocationPointer + 0, nodeIndex, true);
        view.setUint32(invocationPointer + 4, nodeIndex, true);
        view.setUint32(invocationPointer + 8, pluginIdPointer, true);
        view.setUint32(invocationPointer + 12, methodIdPointer, true);
        view.setUint32(invocationPointer + 16, invocationFramePointer, true);
        view.setUint32(invocationPointer + 20, 1, true);
        return 1;
      },
      _sdn_flow_complete_node_invocation() {},
      _sdn_flow_get_ingress_frame_descriptors() {
        return invocationFramePointer;
      },
      _sdn_flow_get_ingress_frame_descriptor_count() {
        return 1;
      },
      _sdn_flow_get_current_invocation_descriptor() {
        return invocationPointer;
      },
      _sdn_flow_prepare_node_invocation_descriptor() {
        return 1;
      },
      _sdn_flow_get_node_dispatch_descriptors() {
        return nodeDispatchPointer;
      },
      _sdn_flow_get_node_dispatch_descriptor_count() {
        return 1;
      },
      _sdn_flow_get_dependency_descriptors() {
        return dependencyPointer;
      },
      _sdn_flow_get_dependency_count() {
        return 1;
      },
      _sdn_flow_apply_node_invocation_result(
        _nodeIndex,
        _statusCode,
        _backlogRemaining,
        _yielded,
        outputsPointer,
        outputCount,
      ) {
        ready = false;
        if (outputCount > 0) {
          const payloadOffset = view.getUint32(outputsPointer + 16, true);
          const payloadSize = view.getUint32(outputsPointer + 20, true);
          const portPointer = view.getUint32(outputsPointer + 8, true);
          let end = portPointer;
          while (bytes[end] !== 0) {
            end += 1;
          }
          lastOutputPort = new TextDecoder().decode(
            bytes.subarray(portPointer, end),
          );
          lastOutputBytes = Array.from(
            bytes.subarray(payloadOffset, payloadOffset + payloadSize),
          );
        }
        routedOutputs = Number(outputCount);
        return outputCount;
      },
    },
    handlers: {
      "dep-sgp4:propagate_one_orbit_samples": ({
        dependencyDescriptor,
        inputs,
      }) => {
        lastDependencyId = dependencyDescriptor?.dependencyId ?? null;
        return {
          statusCode: 0,
          backlogRemaining: 0,
          yielded: false,
          outputs: [
            {
              portId: "out",
              typeDescriptorIndex: inputs[0].typeDescriptorIndex,
              alignment: inputs[0].alignment,
              streamId: 12,
              sequence: 8,
              traceToken: 77,
              endOfStream: false,
              bytes: new Uint8Array([...inputs[0].bytes, 9, 10]),
            },
          ],
        };
      },
    },
  });

  const execution = await host.executeNextReadyNode({ frameBudget: 1 });
  assert.equal(execution.executed, true);
  assert.equal(execution.pluginId, "com.digitalarsenal.propagator.sgp4");
  assert.equal(execution.methodId, "propagate_one_orbit_samples");
  assert.equal(execution.dispatchDescriptor?.dependencyId, "dep-sgp4");
  assert.deepEqual(
    Array.from(execution.dependencyDescriptor?.wasmBytes ?? []),
    [0x00, 0x61, 0x73, 0x6d],
  );
  assert.equal(lastDependencyId, "dep-sgp4");
  assert.equal(execution.routedOutputs, 1);
  assert.equal(routedOutputs, 1);
  assert.equal(lastOutputPort, "out");
  assert.deepEqual(lastOutputBytes, [1, 2, 3, 4, 9, 10]);

  const idle = await host.executeNextReadyNode();
  assert.equal(idle.executed, false);
  assert.equal(idle.idle, true);

  host.resetRuntimeState();
  assert.equal(resetCalls, 1);
  assert.equal(freedPointers.length > 0, true);
});

test("compiled flow runtime host can instantiate the root artifact when exports are not preloaded", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const pluginIdPointer = 512;
  const methodIdPointer = 576;
  const inputPortPointer = 640;
  const nodeIdPointer = 704;
  const invocationFramePointer = 1152;
  const invocationPointer = 1280;
  const nodeDispatchPointer = 1408;
  let allocPointer = 2048;
  let ready = true;
  let instantiateCalls = 0;
  let lastOutputPort = null;
  let lastOutputBytes = null;

  const writeCString = (pointer, value) => {
    bytes.set(new TextEncoder().encode(`${value}\0`), pointer);
  };
  writeCString(pluginIdPointer, "com.digitalarsenal.propagator.sgp4");
  writeCString(methodIdPointer, "catalog_query");
  writeCString(inputPortPointer, "query");
  writeCString(nodeIdPointer, "catalog-node");
  bytes.set([1, 2, 3], 1234);

  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIdPointer.offset,
    nodeIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIdPointer.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIndex.offset,
    INVALID_INDEX,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.pluginIdPointer.offset,
    pluginIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.methodIdPointer.offset,
    methodIdPointer,
    true,
  );

  const artifact = {
    ...compiledArtifactStub(),
    programId: "com.digitalarsenal.compiled.host.instantiate",
    runtimeExports: {
      mallocSymbol: "malloc",
      freeSymbol: "free",
      descriptorSymbol: "sdn_flow_get_runtime_descriptor",
      resetStateSymbol: "sdn_flow_reset_runtime_state",
      enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
      enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
      enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
      enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
      readyNodeSymbol: "sdn_flow_get_ready_node_index",
      beginInvocationSymbol: "sdn_flow_begin_node_invocation",
      completeInvocationSymbol: "sdn_flow_complete_node_invocation",
      ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
      ingressFrameDescriptorCountSymbol:
        "sdn_flow_get_ingress_frame_descriptor_count",
      currentInvocationDescriptorSymbol:
        "sdn_flow_get_current_invocation_descriptor",
      prepareInvocationDescriptorSymbol:
        "sdn_flow_prepare_node_invocation_descriptor",
      applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
      nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
      nodeDispatchDescriptorCountSymbol:
        "sdn_flow_get_node_dispatch_descriptor_count",
      dependencyDescriptorsSymbol: "sdn_flow_get_dependency_descriptors",
      dependencyCountSymbol: "sdn_flow_get_dependency_count",
    },
  };

  const wasmExports = {
    memory,
    _malloc(size) {
      const pointer = allocPointer;
      allocPointer += Number(size);
      return pointer;
    },
    _free() {},
    _sdn_flow_get_runtime_descriptor() {
      return 64;
    },
    _sdn_flow_reset_runtime_state() {},
    _sdn_flow_enqueue_trigger_frames() {},
    _sdn_flow_enqueue_trigger_frame() {
      return 1;
    },
    _sdn_flow_enqueue_edge_frames() {},
    _sdn_flow_enqueue_edge_frame() {
      return 1;
    },
    _sdn_flow_get_ready_node_index() {
      return ready ? 0 : 0xffffffff;
    },
    _sdn_flow_begin_node_invocation(nodeIndex) {
      view.setUint32(invocationFramePointer + 0, 0, true);
      view.setUint32(invocationFramePointer + 4, 0xffffffff, true);
      view.setUint32(invocationFramePointer + 8, inputPortPointer, true);
      view.setUint32(invocationFramePointer + 12, 8, true);
      view.setUint32(invocationFramePointer + 16, 1234, true);
      view.setUint32(invocationFramePointer + 20, 3, true);
      view.setUint32(invocationFramePointer + 24, 1, true);
      view.setUint32(invocationFramePointer + 28, 1, true);
      view.setBigUint64(invocationFramePointer + 32, BigInt(9), true);
      view.setUint8(invocationFramePointer + 40, 0);
      view.setUint8(invocationFramePointer + 41, 1);

      view.setUint32(invocationPointer + 0, nodeIndex, true);
      view.setUint32(invocationPointer + 4, 0, true);
      view.setUint32(invocationPointer + 8, pluginIdPointer, true);
      view.setUint32(invocationPointer + 12, methodIdPointer, true);
      view.setUint32(invocationPointer + 16, invocationFramePointer, true);
      view.setUint32(invocationPointer + 20, 1, true);
      return 1;
    },
    _sdn_flow_complete_node_invocation() {},
    _sdn_flow_get_ingress_frame_descriptors() {
      return invocationFramePointer;
    },
    _sdn_flow_get_ingress_frame_descriptor_count() {
      return 1;
    },
    _sdn_flow_get_current_invocation_descriptor() {
      return invocationPointer;
    },
    _sdn_flow_prepare_node_invocation_descriptor() {
      return 1;
    },
    _sdn_flow_get_node_dispatch_descriptors() {
      return nodeDispatchPointer;
    },
    _sdn_flow_get_node_dispatch_descriptor_count() {
      return 1;
    },
    _sdn_flow_get_dependency_descriptors() {
      return 0;
    },
    _sdn_flow_get_dependency_count() {
      return 0;
    },
    _sdn_flow_apply_node_invocation_result(
      _nodeIndex,
      _statusCode,
      _backlogRemaining,
      _yielded,
      outputsPointer,
      outputCount,
    ) {
      ready = false;
      if (outputCount > 0) {
        const payloadOffset = view.getUint32(outputsPointer + 16, true);
        const payloadSize = view.getUint32(outputsPointer + 20, true);
        const portPointer = view.getUint32(outputsPointer + 8, true);
        let end = portPointer;
        while (bytes[end] !== 0) {
          end += 1;
        }
        lastOutputPort = new TextDecoder().decode(
          bytes.subarray(portPointer, end),
        );
        lastOutputBytes = Array.from(
          bytes.subarray(payloadOffset, payloadOffset + payloadSize),
        );
      }
      return outputCount;
    },
  };

  const host = await bindCompiledFlowRuntimeHost({
    artifact,
    instantiateArtifact: async (moduleBytes, imports) => {
      instantiateCalls += 1;
      assert.deepEqual(Array.from(moduleBytes), Array.from(artifact.wasm));
      assert.deepEqual(imports, {});
      return {
        instance: {
          exports: wasmExports,
        },
      };
    },
    handlers: {
      "com.digitalarsenal.propagator.sgp4:catalog_query": ({ inputs }) => ({
        outputs: [
          {
            portId: "results",
            bytes: new Uint8Array([...inputs[0].bytes, 9, 10]),
            alignment: 8,
          },
        ],
      }),
    },
  });

  const execution = await host.executeNextReadyNode();
  assert.equal(instantiateCalls, 1);
  assert.equal(execution.executed, true);
  assert.equal(execution.pluginId, "com.digitalarsenal.propagator.sgp4");
  assert.equal(execution.methodId, "catalog_query");
  assert.equal(lastOutputPort, "results");
  assert.deepEqual(lastOutputBytes, [1, 2, 3, 9, 10]);
});

test("embedded dependencies can be instantiated from the compiled bundle and used by a dependency stream bridge", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const pluginIdPointer = 512;
  const methodIdPointer = 576;
  const inputPortPointer = 640;
  const nodeIdPointer = 704;
  const dependencyIdPointer = 768;
  const streamInvokeSymbolPointer = 832;
  const destroySymbolPointer = 896;
  const invocationFramePointer = 1152;
  const invocationPointer = 1280;
  const nodeDispatchPointer = 1408;
  const dependencyPointer = 1536;
  const dependencyWasmPointer = 1664;
  let allocPointer = 2048;
  let ready = true;
  let instantiateCalls = 0;
  let bridgeCalls = 0;
  let destroyCalls = 0;
  const inputPayload = new Uint8Array([5, 6, 7]);
  const fakeDependencyStreamInvoke = () => 99;
  const fakeDependencyDestroy = () => {
    destroyCalls += 1;
  };

  const writeCString = (pointer, value) => {
    bytes.set(new TextEncoder().encode(`${value}\0`), pointer);
  };
  writeCString(pluginIdPointer, "com.digitalarsenal.propagator.sgp4");
  writeCString(methodIdPointer, "propagate_one_orbit_samples");
  writeCString(inputPortPointer, "in");
  writeCString(nodeIdPointer, "node-propagate");
  writeCString(dependencyIdPointer, "dep-sgp4");
  writeCString(streamInvokeSymbolPointer, "plugin_stream_invoke");
  writeCString(destroySymbolPointer, "plugin_destroy");
  bytes.set(inputPayload, 1234);
  bytes.set([0x00, 0x61, 0x73, 0x6d], dependencyWasmPointer);

  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIdPointer.offset,
    nodeIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.nodeIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIdPointer.offset,
    dependencyIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.dependencyIndex.offset,
    0,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.pluginIdPointer.offset,
    pluginIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.methodIdPointer.offset,
    methodIdPointer,
    true,
  );
  view.setUint32(
    nodeDispatchPointer +
      FlowNodeDispatchDescriptorLayout.fields.streamInvokeSymbolPointer.offset,
    streamInvokeSymbolPointer,
    true,
  );

  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.dependencyIdPointer
        .offset,
    dependencyIdPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.pluginIdPointer.offset,
    pluginIdPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.destroySymbolPointer
        .offset,
    destroySymbolPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.streamInvokeSymbolPointer
        .offset,
    streamInvokeSymbolPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmBytesPointer.offset,
    dependencyWasmPointer,
    true,
  );
  view.setUint32(
    dependencyPointer +
      SignedArtifactDependencyDescriptorLayout.fields.wasmSize.offset,
    4,
    true,
  );

  const artifact = {
    ...compiledArtifactStub(),
    runtimeExports: {
      mallocSymbol: "malloc",
      freeSymbol: "free",
      descriptorSymbol: "sdn_flow_get_runtime_descriptor",
      resetStateSymbol: "sdn_flow_reset_runtime_state",
      enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
      enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
      enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
      enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
      readyNodeSymbol: "sdn_flow_get_ready_node_index",
      beginInvocationSymbol: "sdn_flow_begin_node_invocation",
      completeInvocationSymbol: "sdn_flow_complete_node_invocation",
      ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
      ingressFrameDescriptorCountSymbol:
        "sdn_flow_get_ingress_frame_descriptor_count",
      currentInvocationDescriptorSymbol:
        "sdn_flow_get_current_invocation_descriptor",
      prepareInvocationDescriptorSymbol:
        "sdn_flow_prepare_node_invocation_descriptor",
      applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
      nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
      nodeDispatchDescriptorCountSymbol:
        "sdn_flow_get_node_dispatch_descriptor_count",
      dependencyDescriptorsSymbol: "sdn_flow_get_dependency_descriptors",
      dependencyCountSymbol: "sdn_flow_get_dependency_count",
    },
  };

  const wasmExports = {
    memory,
    _malloc(size) {
      const pointer = allocPointer;
      allocPointer += Number(size);
      return pointer;
    },
    _free() {},
    _sdn_flow_get_runtime_descriptor() {
      return 64;
    },
    _sdn_flow_reset_runtime_state() {},
    _sdn_flow_enqueue_trigger_frames() {},
    _sdn_flow_enqueue_trigger_frame() {
      return 1;
    },
    _sdn_flow_enqueue_edge_frames() {},
    _sdn_flow_enqueue_edge_frame() {
      return 1;
    },
    _sdn_flow_get_ready_node_index() {
      return ready ? 0 : 0xffffffff;
    },
    _sdn_flow_begin_node_invocation(nodeIndex) {
      view.setUint32(invocationFramePointer + 0, 0, true);
      view.setUint32(invocationFramePointer + 4, 2, true);
      view.setUint32(invocationFramePointer + 8, inputPortPointer, true);
      view.setUint32(invocationFramePointer + 12, 8, true);
      view.setUint32(invocationFramePointer + 16, 1234, true);
      view.setUint32(invocationFramePointer + 20, 3, true);
      view.setUint32(invocationFramePointer + 24, 9, true);
      view.setUint32(invocationFramePointer + 28, 7, true);
      view.setBigUint64(invocationFramePointer + 32, BigInt(55), true);
      view.setUint8(invocationFramePointer + 40, 0);
      view.setUint8(invocationFramePointer + 41, 1);

      view.setUint32(invocationPointer + 0, nodeIndex, true);
      view.setUint32(invocationPointer + 4, 0, true);
      view.setUint32(invocationPointer + 8, pluginIdPointer, true);
      view.setUint32(invocationPointer + 12, methodIdPointer, true);
      view.setUint32(invocationPointer + 16, invocationFramePointer, true);
      view.setUint32(invocationPointer + 20, 1, true);
      return 1;
    },
    _sdn_flow_complete_node_invocation() {},
    _sdn_flow_get_ingress_frame_descriptors() {
      return invocationFramePointer;
    },
    _sdn_flow_get_ingress_frame_descriptor_count() {
      return 1;
    },
    _sdn_flow_get_current_invocation_descriptor() {
      return invocationPointer;
    },
    _sdn_flow_prepare_node_invocation_descriptor() {
      return 1;
    },
    _sdn_flow_get_node_dispatch_descriptors() {
      return nodeDispatchPointer;
    },
    _sdn_flow_get_node_dispatch_descriptor_count() {
      return 1;
    },
    _sdn_flow_get_dependency_descriptors() {
      return dependencyPointer;
    },
    _sdn_flow_get_dependency_count() {
      return 1;
    },
    _sdn_flow_apply_node_invocation_result() {
      ready = false;
      return 0;
    },
  };

  const dependencyRuntime = await instantiateEmbeddedDependencies({
    artifact,
    wasmExports,
    instantiate: async (moduleBytes) => {
      instantiateCalls += 1;
      assert.deepEqual(Array.from(moduleBytes), [0x00, 0x61, 0x73, 0x6d]);
      return {
        instance: {
          exports: {
            plugin_stream_invoke: fakeDependencyStreamInvoke,
            plugin_destroy: fakeDependencyDestroy,
          },
        },
      };
    },
  });
  assert.equal(
    dependencyRuntime.byDependencyId.get("dep-sgp4").resolvedExports
      .streamInvoke,
    fakeDependencyStreamInvoke,
  );
  dependencyRuntime.destroyAll();
  assert.equal(destroyCalls, 1);

  const host = await bindCompiledFlowRuntimeHost({
    artifact,
    wasmExports,
    instantiateDependency: async (moduleBytes) => {
      instantiateCalls += 1;
      assert.deepEqual(Array.from(moduleBytes), [0x00, 0x61, 0x73, 0x6d]);
      return {
        instance: {
          exports: {
            plugin_stream_invoke: fakeDependencyStreamInvoke,
            plugin_destroy: fakeDependencyDestroy,
          },
        },
      };
    },
    dependencyStreamBridge: ({ instantiatedDependency, inputs }) => {
      bridgeCalls += 1;
      assert.equal(
        instantiatedDependency.resolvedExports.streamInvoke,
        fakeDependencyStreamInvoke,
      );
      assert.equal(instantiatedDependency.dependencyId, "dep-sgp4");
      assert.deepEqual(Array.from(inputs[0].bytes), [5, 6, 7]);
      return {
        statusCode: 0,
        backlogRemaining: 0,
        yielded: false,
        outputs: [],
      };
    },
  });

  const execution = await host.executeNextReadyNode();
  assert.equal(execution.executed, true);
  assert.equal(execution.instantiatedDependency?.dependencyId, "dep-sgp4");
  assert.equal(bridgeCalls, 1);
  assert.equal(instantiateCalls, 2);
  await host.destroyDependencies();
  assert.equal(destroyCalls, 2);
});

test("host runtime abi binder fails closed when a required export is missing", async () => {
  await assert.rejects(
    bindCompiledRuntimeAbi({
      artifact: {
        ...compiledArtifactStub(),
        runtimeExports: {
          descriptorSymbol: "sdn_flow_get_runtime_descriptor",
          resetStateSymbol: "sdn_flow_reset_runtime_state",
          enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
          enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
          readyNodeSymbol: "sdn_flow_get_ready_node_index",
          beginInvocationSymbol: "sdn_flow_begin_node_invocation",
          completeInvocationSymbol: "sdn_flow_complete_node_invocation",
        },
      },
      wasmExports: {
        sdn_flow_get_runtime_descriptor() {},
        sdn_flow_reset_runtime_state() {},
        sdn_flow_enqueue_trigger_frames() {},
        sdn_flow_enqueue_edge_frames() {},
        sdn_flow_get_ready_node_index() {},
        sdn_flow_begin_node_invocation() {},
      },
    }),
    /sdn_flow_complete_node_invocation/,
  );
});
