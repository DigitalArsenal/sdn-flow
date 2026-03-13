import test from "node:test";
import assert from "node:assert/strict";

import {
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
