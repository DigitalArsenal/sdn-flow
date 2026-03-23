import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultFlowManifestBuffer,
  decodeCompiledArtifactManifest,
  evaluateHostedRuntimeTargetSupport,
  FlowDeploymentClient,
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  listCompiledArtifactRuntimeTargets,
  normalizeCompiledArtifact,
  RuntimeTarget,
  summarizeHostedRuntimePlan,
} from "../src/index.js";

function createProgram(overrides = {}) {
  return {
    programId: "com.digitalarsenal.tests.runtime-targets",
    version: "0.2.8",
    nodes: [],
    edges: [],
    triggers: [],
    triggerBindings: [],
    requiredPlugins: [],
    ...overrides,
  };
}

test("buildDefaultFlowManifestBuffer infers standalone wasi for pure manual flows", () => {
  const manifestBuffer = buildDefaultFlowManifestBuffer({
    program: createProgram({
      triggers: [
        {
          triggerId: "manual",
          kind: "manual",
        },
      ],
    }),
  });

  const manifest = decodeCompiledArtifactManifest({ manifestBuffer });
  assert.equal(manifest?.pluginId, "com.digitalarsenal.tests.runtime-targets");
  assert.deepEqual(manifest?.invokeSurfaces, ["direct", "command"]);
  assert.deepEqual(manifest?.runtimeTargets, [RuntimeTarget.WASI]);
});

test("buildDefaultFlowManifestBuffer infers hosted server targets and honors explicit wasmedge overrides", () => {
  const hostedManifest = decodeCompiledArtifactManifest({
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram({
        triggers: [
          {
            triggerId: "tick",
            kind: "timer",
          },
          {
            triggerId: "http-in",
            kind: "http-request",
            source: "/catalog",
          },
        ],
      }),
    }),
  });
  assert.deepEqual(hostedManifest?.runtimeTargets, [RuntimeTarget.SERVER]);

  const wasmedgeManifest = decodeCompiledArtifactManifest({
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram(),
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
  });
  assert.deepEqual(wasmedgeManifest?.runtimeTargets, [RuntimeTarget.WASMEDGE]);
});

test("evaluateHostedRuntimeTargetSupport classifies browser, server, wasi, and wasmedge hosts", () => {
  assert.deepEqual(
    evaluateHostedRuntimeTargetSupport({
      hostKind: "orbpro",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
      runtimeTargets: [RuntimeTarget.BROWSER],
    }),
    {
      hostKind: "orbpro",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
      runtimeTargets: [RuntimeTarget.BROWSER],
      supportedTargets: [RuntimeTarget.BROWSER],
      unsupportedTargets: [],
      ok: true,
    },
  );

  assert.deepEqual(
    evaluateHostedRuntimeTargetSupport({
      hostKind: "sdn-js",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.DENO,
      runtimeTargets: [RuntimeTarget.SERVER],
    }),
    {
      hostKind: "sdn-js",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.DENO,
      runtimeTargets: [RuntimeTarget.SERVER],
      supportedTargets: [RuntimeTarget.SERVER],
      unsupportedTargets: [],
      ok: true,
    },
  );

  assert.deepEqual(
    evaluateHostedRuntimeTargetSupport({
      hostKind: "standalone-wasi",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.WASI],
    }),
    {
      hostKind: "standalone-wasi",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.WASI],
      supportedTargets: [RuntimeTarget.WASI],
      unsupportedTargets: [],
      ok: true,
    },
  );

  assert.deepEqual(
    evaluateHostedRuntimeTargetSupport({
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
    {
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.WASMEDGE],
      supportedTargets: [
        RuntimeTarget.EDGE,
        RuntimeTarget.SERVER,
        RuntimeTarget.WASI,
        RuntimeTarget.WASMEDGE,
      ],
      unsupportedTargets: [],
      ok: true,
    },
  );
});

test("summarizeHostedRuntimePlan exposes runtime target compatibility from host plans", () => {
  const summary = summarizeHostedRuntimePlan({
    hostId: "wasmedge-edge-node",
    hostKind: "wasmedge",
    adapter: HostedRuntimeAdapter.HOST_INTERNAL,
    engine: HostedRuntimeEngine.WASI,
    runtimes: [
      {
        runtimeId: "guest-service",
        kind: "flow",
        programId: "guest-service",
        runtimeTargets: [RuntimeTarget.WASMEDGE],
      },
      {
        runtimeId: "browser-only",
        kind: "flow",
        programId: "browser-only",
        runtimeTargets: [RuntimeTarget.BROWSER],
      },
    ],
  });

  assert.deepEqual(summary.runtimeTargetCompatibility, [
    {
      runtimeId: "browser-only",
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.BROWSER],
      supportedTargets: [
        RuntimeTarget.EDGE,
        RuntimeTarget.SERVER,
        RuntimeTarget.WASI,
        RuntimeTarget.WASMEDGE,
      ],
      unsupportedTargets: [RuntimeTarget.BROWSER],
      ok: false,
    },
    {
      runtimeId: "guest-service",
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
      runtimeTargets: [RuntimeTarget.WASMEDGE],
      supportedTargets: [
        RuntimeTarget.EDGE,
        RuntimeTarget.SERVER,
        RuntimeTarget.WASI,
        RuntimeTarget.WASMEDGE,
      ],
      unsupportedTargets: [],
      ok: true,
    },
  ]);
});

test("FlowDeploymentClient.prepareDeployment reads embedded PMAN runtimeTargets and rejects incompatible host profiles", async () => {
  const client = new FlowDeploymentClient();
  const artifact = await normalizeCompiledArtifact({
    programId: "com.digitalarsenal.tests.wasmedge-only",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram({
        programId: "com.digitalarsenal.tests.wasmedge-only",
      }),
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
  });

  assert.deepEqual(listCompiledArtifactRuntimeTargets(artifact), [
    RuntimeTarget.WASMEDGE,
  ]);

  await assert.rejects(
    client.prepareDeployment({
      artifact,
      target: {
        kind: "local",
        runtimeId: "sdn-js-local",
        hostKind: "sdn-js",
        adapter: HostedRuntimeAdapter.SDN_JS,
        engine: HostedRuntimeEngine.DENO,
      },
    }),
    /cannot satisfy embedded runtimeTargets wasmedge/i,
  );

  await assert.doesNotReject(
    client.prepareDeployment({
      artifact,
      target: {
        kind: "local",
        runtimeId: "wasmedge-edge-node",
        hostKind: "wasmedge",
        adapter: HostedRuntimeAdapter.HOST_INTERNAL,
        engine: HostedRuntimeEngine.WASI,
      },
    }),
  );
});
