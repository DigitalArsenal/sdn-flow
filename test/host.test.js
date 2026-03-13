import test from "node:test";
import assert from "node:assert/strict";

import {
  bindCompiledInvocationAbi,
  bindCompiledRuntimeAbi,
  DefaultRequiredRuntimeExportRoles,
  FlowDeploymentClient,
  HostedRuntimeAdapter,
  HostedRuntimeAuthority,
  HostedRuntimeBindingDirection,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
  HostedRuntimeTransport,
  normalizeHostedRuntimePlan,
  summarizeHostedRuntimePlan,
} from "../src/index.js";

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

test("compiled invocation abi can stage a frame and decode the current invocation", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const pluginIdPointer = 512;
  const methodIdPointer = 576;
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
        view.setUint32(invocationPointer, nodeIndex, true);
        view.setUint32(invocationPointer + 4, nodeIndex, true);
        view.setUint32(invocationPointer + 8, pluginIdPointer, true);
        view.setUint32(invocationPointer + 12, methodIdPointer, true);
        view.setUint32(invocationPointer + 16, invocationFramePointer, true);
        view.setUint32(invocationPointer + 20, 1, true);
        return 1;
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
  assert.equal(invocation.frames[0].offset, 1234);
  assert.equal(invocation.frames[0].sequence, 7);
  assert.equal(invocation.frames[0].endOfStream, true);
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
