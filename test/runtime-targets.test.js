import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  InvokeSurface,
  inferFlowRuntimeTargetProfile,
  RuntimeTarget,
  startStandaloneFlowRuntime,
  summarizeHostedRuntimePlan,
} from "../src/index.js";
import { compileLinkedFlowArtifact } from "../test-support/linkedFlowArtifact.js";

const execFile = promisify(execFileCallback);

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

test("buildDefaultFlowManifestBuffer narrows invoke surfaces from dependency metadata", () => {
  const manifestBuffer = buildDefaultFlowManifestBuffer({
    program: createProgram(),
    dependencies: [
      {
        dependencyId: "dep-command",
        pluginId: "com.digitalarsenal.runtime.command",
        invokeSurface: InvokeSurface.COMMAND,
      },
    ],
  });

  const manifest = decodeCompiledArtifactManifest({ manifestBuffer });
  assert.deepEqual(manifest?.invokeSurfaces, [InvokeSurface.COMMAND]);
});

test("buildDefaultFlowManifestBuffer infers hosted server targets for package-hosted nodes without guest-link artifacts", () => {
  const manifest = decodeCompiledArtifactManifest({
    manifestBuffer: buildDefaultFlowManifestBuffer({
      program: createProgram({
        nodes: [
          {
            nodeId: "processor",
            pluginId: "com.digitalarsenal.examples.basic-propagator",
            methodId: "propagate",
          },
        ],
        triggers: [
          {
            triggerId: "manual",
            kind: "manual",
          },
        ],
        triggerBindings: [
          {
            triggerId: "manual",
            targetNodeId: "processor",
            targetPortId: "request",
          },
        ],
        requiredPlugins: ["com.digitalarsenal.examples.basic-propagator"],
      }),
    }),
  });

  assert.deepEqual(manifest?.runtimeTargets, [RuntimeTarget.SERVER]);
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

test("inferFlowRuntimeTargetProfile labels WasmEdge guest-network flows as server-side", () => {
  assert.deepEqual(
    inferFlowRuntimeTargetProfile({
      runtimeTargets: [RuntimeTarget.WASMEDGE],
    }),
    {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.WASMEDGE,
    },
  );
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
      runtimeTargetClass: "delegated",
      standardRuntimeTarget: RuntimeTarget.BROWSER,
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
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.WASMEDGE,
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

test("startStandaloneFlowRuntime executes fully linked wasi and wasmedge artifacts without a host dispatch shim import", async () => {
  const cases = [
    {
      runtimeTarget: RuntimeTarget.WASI,
      hostKind: "standalone-wasi",
      runtimeId: "linked-wasi-runtime",
    },
    {
      runtimeTarget: RuntimeTarget.WASMEDGE,
      hostKind: "wasmedge",
      runtimeId: "linked-wasmedge-runtime",
    },
  ];

  for (const testCase of cases) {
    const { artifact } = await compileLinkedFlowArtifact({
      runtimeTargets: [testCase.runtimeTarget],
      workingDirectory: `/working/runtime-targets-linked-${testCase.runtimeTarget}-${randomUUID()}`,
    });
    const imports = WebAssembly.Module.imports(
      new WebAssembly.Module(artifact.wasm),
    );

    assert.equal(
      imports.some(
        (entry) =>
          entry.module === "sdn_flow_host" &&
          entry.name === "dispatch_current_invocation",
      ),
      false,
    );
    assert.deepEqual(
      Array.from(new Set(imports.map((entry) => entry.module))).sort(),
      ["wasi_snapshot_preview1"],
    );

    const runtime = await startStandaloneFlowRuntime({
      artifact,
      target: {
        runtimeId: testCase.runtimeId,
        hostKind: testCase.hostKind,
        adapter: HostedRuntimeAdapter.HOST_INTERNAL,
        engine: HostedRuntimeEngine.WASI,
      },
    });

    assert.equal(runtime.target.hostKind, testCase.hostKind);
    assert.deepEqual(runtime.runtimeTargets, [testCase.runtimeTarget]);
    assert.equal(
      runtime.enqueueTriggerFrame(0, {
        typeDescriptorIndex: 0,
        alignment: 8,
        bytes: new Uint8Array([1, 2, 3, 4]),
        streamId: 1,
        sequence: 1,
        traceToken: 7,
      }),
      1,
    );

    const execution = await runtime.dispatchNextReadyNodeWithHost({
      frameBudget: 1,
      outputStreamCap: 16,
    });
    assert.equal(execution.executed, true);
    assert.equal(execution.nodeIndex, 0);

    const idleExecution = await runtime.dispatchNextReadyNodeWithHost({
      frameBudget: 1,
      outputStreamCap: 16,
    });
    assert.equal(idleExecution.idle, true);
  }
});

test("startStandaloneFlowRuntime prefers direct instantiation for host-compatible artifacts even when a loader module is present", async () => {
  const { artifact } = await compileLinkedFlowArtifact({
    runtimeTargets: [RuntimeTarget.WASMEDGE],
    workingDirectory: `/working/runtime-targets-direct-preferred-${randomUUID()}`,
  });
  artifact.loaderModule = "export default 1;";

  const runtime = await startStandaloneFlowRuntime({
    artifact,
    target: {
      runtimeId: "linked-direct-preferred-runtime",
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    },
  });

  assert.deepEqual(runtime.guestImportContract?.modules, [
    "wasi_snapshot_preview1",
  ]);
  assert.equal(runtime.target.hostKind, "wasmedge");
  assert.equal(
    runtime.enqueueTriggerFrame(0, {
      typeDescriptorIndex: 0,
      alignment: 8,
      bytes: new Uint8Array([9, 8, 7, 6]),
      streamId: 1,
      sequence: 1,
      traceToken: 5,
    }),
    1,
  );
  const execution = await runtime.dispatchNextReadyNodeWithHost({
    frameBudget: 1,
    outputStreamCap: 16,
  });
  assert.equal(execution.executed, true);
});

test("WasmEdge can start a fully linked standalone flow artifact directly when the CLI is available", async (t) => {
  try {
    await execFile("wasmedge", ["--version"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("wasmedge CLI is not installed");
      return;
    }
    throw error;
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "sdn-flow-wasmedge-"),
  );
  try {
    const { artifact } = await compileLinkedFlowArtifact({
      runtimeTargets: [RuntimeTarget.WASMEDGE],
      workingDirectory: `/working/runtime-targets-wasmedge-cli-${randomUUID()}`,
    });
    const wasmPath = path.join(tempDirectory, "flow-runtime.wasm");
    await writeFile(wasmPath, artifact.wasm);

    const { stdout, stderr } = await execFile("wasmedge", [wasmPath]);
    assert.equal(stdout.trim(), "");
    assert.equal(stderr.trim(), "");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
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
