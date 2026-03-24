import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultFlowManifestBuffer,
  createFlowDeploymentPlan,
  createInstalledFlowHost,
  decodeCompiledArtifactManifest,
  evaluateHostedRuntimeTargetSupport,
  FlowDeploymentClient,
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  listCompiledArtifactRuntimeTargets,
  normalizeCompiledArtifact,
  RuntimeTarget,
  startStandaloneFlowRuntime,
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

  const deployment = await client.prepareDeployment({
    artifact,
    target: {
      kind: "local",
      runtimeId: "runtime-metadata-stamp",
    },
  });
  assert.deepEqual(deployment.payload.target.runtimeTargets, [
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

test("createInstalledFlowHost enforces configured runtimeTargets when explicit artifacts omit embedded targets", async () => {
  const runtimeHost = {
    enqueueTriggerFrame() {},
    async drain() {
      return {
        idle: true,
        iterations: 0,
        executions: [],
      };
    },
    resetRuntimeState() {},
    async destroyDependencies() {},
    resolvedByRole: {
      readyNodeSymbol() {
        return 0xffffffff;
      },
    },
  };
  const program = createProgram({
    triggers: [
      {
        triggerId: "manual",
        kind: "manual",
      },
    ],
    runtimeTargets: [RuntimeTarget.WASMEDGE],
  });
  const artifactWithoutTargets = await normalizeCompiledArtifact({
    programId: program.programId,
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });

  const incompatibleHost = createInstalledFlowHost({
    program,
    discover: false,
    artifact: artifactWithoutTargets,
    runtimeHost,
    runtimeTargets: [RuntimeTarget.WASMEDGE],
    hostPlan: {
      hostId: "browser-host",
      hostKind: "orbpro",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
      runtimes: [
        {
          runtimeId: "browser-runtime",
          kind: "flow",
          programId: program.programId,
        },
      ],
    },
  });

  await assert.rejects(
    incompatibleHost.start(),
    /configured runtimeTargets wasmedge/i,
  );
});

test("createInstalledFlowHost enforces browser, server, wasi, and wasmedge host plans from embedded runtimeTargets", async () => {
  const runtimeHost = {
    enqueueTriggerFrame() {},
    async drain() {
      return {
        idle: true,
        iterations: 0,
        executions: [],
      };
    },
    resetRuntimeState() {},
    async destroyDependencies() {},
    resolvedByRole: {
      readyNodeSymbol() {
        return 0xffffffff;
      },
    },
  };
  const program = createProgram({
    triggers: [
      {
        triggerId: "manual",
        kind: "manual",
      },
    ],
  });
  const cases = [
    {
      runtimeTarget: RuntimeTarget.BROWSER,
      hostKind: "orbpro",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
    },
    {
      runtimeTarget: RuntimeTarget.SERVER,
      hostKind: "sdn-js",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.DENO,
    },
    {
      runtimeTarget: RuntimeTarget.WASI,
      hostKind: "standalone-wasi",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    },
    {
      runtimeTarget: RuntimeTarget.WASMEDGE,
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    },
  ];

  for (const testCase of cases) {
    const artifact = await normalizeCompiledArtifact({
      programId: program.programId,
      wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
      manifestBuffer: buildDefaultFlowManifestBuffer({
        program,
        runtimeTargets: [testCase.runtimeTarget],
      }),
    });
    const host = createInstalledFlowHost({
      program,
      discover: false,
      artifact,
      runtimeHost,
      hostPlan: {
        hostId: `${testCase.hostKind}-host`,
        hostKind: testCase.hostKind,
        adapter: testCase.adapter,
        engine: testCase.engine,
        runtimes: [
          {
            runtimeId: `${testCase.runtimeTarget}-runtime`,
            kind: "flow",
            programId: program.programId,
          },
        ],
      },
    });

    await assert.doesNotReject(host.start());
  }

  const incompatibleArtifact = await normalizeCompiledArtifact({
    programId: program.programId,
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program,
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
  });
  const incompatibleHost = createInstalledFlowHost({
    program,
    discover: false,
    artifact: incompatibleArtifact,
    runtimeHost,
    hostPlan: {
      hostId: "browser-host",
      hostKind: "orbpro",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
      runtimes: [
        {
          runtimeId: "browser-runtime",
          kind: "flow",
          programId: program.programId,
        },
      ],
    },
  });

  await assert.rejects(
    incompatibleHost.start(),
    /cannot start runtime "browser-runtime".*wasmedge/i,
  );
});

test("startStandaloneFlowRuntime resolves a compiled deployment into a strict standalone wasi runtime without installed-host wrappers", async () => {
  const client = new FlowDeploymentClient();
  const deploymentPlan = createFlowDeploymentPlan({
    programId: "com.digitalarsenal.tests.standalone-wasi",
    version: "0.3.1",
    triggers: [
      {
        triggerId: "manual",
        kind: "manual",
      },
    ],
  });
  const artifact = await normalizeCompiledArtifact({
    programId: "com.digitalarsenal.tests.standalone-wasi",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram({
        programId: "com.digitalarsenal.tests.standalone-wasi",
        triggers: [
          {
            triggerId: "manual",
            kind: "manual",
          },
        ],
      }),
      runtimeTargets: [RuntimeTarget.WASI],
    }),
  });
  const deployment = await client.prepareDeployment({
    artifact,
    deploymentPlan,
    target: {
      kind: "local",
      runtimeId: "standalone-wasi-runtime",
      hostKind: "standalone-wasi",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    },
  });

  const boundArtifacts = [];
  const runtime = await startStandaloneFlowRuntime({
    input: deployment,
    bindRuntimeHost: async (options) => {
      boundArtifacts.push(options.artifact.programId);
      return {
        runEntrypoint() {
          return {
            entrypoint: "_start",
            argc: 0,
            argv: [],
            exitCode: 0,
          };
        },
        resetRuntimeState() {},
        async destroyDependencies() {},
      };
    },
  });

  assert.deepEqual(boundArtifacts, [
    "com.digitalarsenal.tests.standalone-wasi",
  ]);
  assert.equal(runtime.deploymentPlan?.programId, deploymentPlan.programId);
  assert.equal(runtime.target.hostKind, "standalone-wasi");
  assert.equal(runtime.target.adapter, HostedRuntimeAdapter.HOST_INTERNAL);
  assert.equal(runtime.target.engine, HostedRuntimeEngine.WASI);
  assert.deepEqual(runtime.runtimeTargets, [RuntimeTarget.WASI]);
  assert.equal(runtime.runtimeCompatibility?.ok, true);
  assert.deepEqual(runtime.runEntrypoint(), {
    entrypoint: "_start",
    argc: 0,
    argv: [],
    exitCode: 0,
  });

  await assert.doesNotReject(runtime.close());
});

test("startStandaloneFlowRuntime defaults wasmedge artifacts onto the host-internal wasi runtime and rejects incompatible standalone targets", async () => {
  const artifact = await normalizeCompiledArtifact({
    programId: "com.digitalarsenal.tests.standalone-wasmedge",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram({
        programId: "com.digitalarsenal.tests.standalone-wasmedge",
      }),
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
  });

  const runtime = await startStandaloneFlowRuntime({
    artifact,
    bindRuntimeHost: async () => ({
      runEntrypoint() {
        return {
          entrypoint: "_start",
          argc: 0,
          argv: [],
          exitCode: 0,
        };
      },
      resetRuntimeState() {},
      async destroyDependencies() {},
    }),
  });

  assert.equal(runtime.target.hostKind, "wasmedge");
  assert.equal(runtime.target.adapter, HostedRuntimeAdapter.HOST_INTERNAL);
  assert.equal(runtime.target.engine, HostedRuntimeEngine.WASI);
  assert.deepEqual(runtime.runtimeTargets, [RuntimeTarget.WASMEDGE]);
  assert.equal(runtime.runtimeCompatibility?.ok, true);

  await assert.rejects(
    startStandaloneFlowRuntime({
      artifact,
      target: {
        hostKind: "orbpro",
        adapter: HostedRuntimeAdapter.SDN_JS,
        engine: HostedRuntimeEngine.BROWSER,
      },
      bindRuntimeHost: async () => ({
        resetRuntimeState() {},
        async destroyDependencies() {},
      }),
    }),
    /Standalone runtime cannot satisfy embedded runtimeTargets wasmedge/i,
  );
});

test("startStandaloneFlowRuntime enforces deployment runtime-target metadata when embedded targets are unavailable", async () => {
  const client = new FlowDeploymentClient();
  const artifactWithoutTargets = await normalizeCompiledArtifact({
    programId: "com.digitalarsenal.tests.standalone-metadata-only",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });
  const deployment = await client.prepareDeployment({
    artifact: artifactWithoutTargets,
    target: {
      kind: "local",
      runtimeId: "metadata-runtime",
      runtimeTargets: [RuntimeTarget.WASI],
    },
  });

  await assert.rejects(
    startStandaloneFlowRuntime({
      input: deployment,
      target: {
        hostKind: "orbpro",
        adapter: HostedRuntimeAdapter.SDN_JS,
        engine: HostedRuntimeEngine.BROWSER,
      },
      bindRuntimeHost: async () => ({
        resetRuntimeState() {},
        async destroyDependencies() {},
      }),
    }),
    /Standalone runtime cannot satisfy runtime metadata runtimeTargets wasi/i,
  );

  const runtime = await startStandaloneFlowRuntime({
    input: deployment,
    bindRuntimeHost: async () => ({
      runEntrypoint() {
        return {
          entrypoint: "_start",
          argc: 0,
          argv: [],
          exitCode: 0,
        };
      },
      resetRuntimeState() {},
      async destroyDependencies() {},
    }),
  });

  assert.equal(runtime.target.hostKind, "standalone-wasi");
  assert.deepEqual(runtime.target.runtimeTargets, [RuntimeTarget.WASI]);
  assert.deepEqual(runtime.runtimeTargets, [RuntimeTarget.WASI]);
  assert.equal(runtime.runtimeCompatibility?.ok, true);

  await runtime.close();
});
