import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createInstalledFlowHost,
  RuntimeTarget,
  serializeCompiledArtifact,
  startInstalledFlowBrowserFetchHost,
  startStandaloneFlowRuntime,
  normalizeProgram,
} from "../src/index.js";
import { compileLinkedFlowArtifact } from "../test-support/linkedFlowArtifact.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function createTestFrame(payload, overrides = {}) {
  return {
    portId: overrides.portId ?? "request",
    typeRef: overrides.typeRef ?? {
      schemaName: "StateRequest.fbs",
      fileIdentifier: "SREQ",
    },
    alignment: 8,
    offset: overrides.offset ?? 4096,
    size: overrides.size ?? 64,
    ownership: "shared",
    generation: 0,
    mutability: "immutable",
    traceId: overrides.traceId ?? "trace-1",
    streamId: overrides.streamId ?? 1,
    sequence: overrides.sequence ?? 1,
    payload,
  };
}

function createLinkedTestFrame(payload, overrides = {}) {
  return createTestFrame(payload, {
    typeRef: {
      schemaName: "PluginManifest.fbs",
      fileIdentifier: "PMAN",
    },
    ...overrides,
  });
}

function createNoopPluginPackage(manifest) {
  const handlers = {};
  for (const method of manifest.methods ?? []) {
    if (!method?.methodId) {
      continue;
    }
    handlers[method.methodId] = () => ({
      outputs: [],
      backlogRemaining: 0,
      yielded: false,
    });
  }
  return {
    manifest,
    handlers,
  };
}

function stripArtifactDependencies(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  delete clone.artifactDependencies;
  delete clone.artifact_dependencies;
  return clone;
}

async function buildStandaloneWorkspace() {
  const { artifact, program, manifest } = await compileLinkedFlowArtifact({
    runtimeTargets: [RuntimeTarget.WASI],
    workingDirectory: "/working/parity-linked-standalone",
  });
  return {
    workspaceId: "parity-single-plugin",
    program,
    hostPlan: {
      hostId: "parity-single-plugin",
      hostKind: "standalone-wasi",
      adapter: "host-internal",
      engine: "wasi",
      runtimes: [],
    },
    pluginPackages: [
      {
        manifest,
        handlers: {
          tick() {
            return {
              outputs: [],
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
    serializedArtifact: serializeCompiledArtifact(artifact),
  };
}

function buildBrowserWorkspace() {
  return {
    workspaceId: "parity-browser",
    program: {
      programId: "com.digitalarsenal.examples.browser-fetch-host",
      runtimeTargets: ["browser"],
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.browser-http",
          methodId: "serve_http_request",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "download",
          kind: "http-request",
          source: "/download",
          acceptedTypes: [
            {
              schemaName: "HttpRequest.fbs",
              fileIdentifier: "HREQ",
            },
          ],
        },
      ],
      triggerBindings: [
        {
          triggerId: "download",
          targetNodeId: "responder",
          targetPortId: "request",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.browser-http"],
    },
    hostPlan: {
      hostId: "browser-fetch-host",
      hostKind: "browser",
      adapter: "sdn-js",
      engine: "browser",
      runtimes: [
        {
          runtimeId: "browser-flow",
          kind: "flow",
          programId: "com.digitalarsenal.examples.browser-fetch-host",
          startupPhase: "session",
          autoStart: true,
          bindings: [
            {
              bindingId: "browser-http-listener",
              direction: "listen",
              transport: "http",
              url: "https://app.example/download",
            },
          ],
        },
      ],
    },
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.browser-http",
          name: "In-Memory Browser HTTP",
          version: "1.0.0",
          pluginFamily: "responder",
          methods: [
            {
              methodId: "serve_http_request",
              inputPorts: [{ portId: "request", required: true }],
              outputPorts: [{ portId: "response" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          serve_http_request({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "response",
                metadata: {
                  statusCode: 200,
                  responseHeaders: {
                    "content-type": "text/plain",
                    "x-runtime": "browser",
                  },
                },
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  };
}

async function buildWasmedgeServerWorkspace() {
  const flow = stripArtifactDependencies(
    await readJson(
    "../examples/flows/csv-omm-query-service/flow.json",
    ),
  );
  const [httpFetcherManifest, flatsqlStoreManifest, sqlHttpBridgeManifest] =
    await Promise.all([
      readJson("../examples/plugins/http-fetcher/manifest.json"),
      readJson("../examples/plugins/flatsql-store/manifest.json"),
      readJson("../examples/plugins/sql-http-bridge/manifest.json"),
    ]);

  return {
    workspaceId: "parity-wasmedge-server",
    program: flow,
    deploymentPlan: {
      pluginId: flow.programId,
      version: flow.version,
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [
        {
          bindingId: "query-http-binding",
          interfaceId: "query-http",
          targetPluginId: "com.digitalarsenal.flow.sql-http-bridge",
          targetMethodId: "build_sql_query_from_http_request",
          targetInputPortId: "request",
          sourceKind: "catalog-sync",
          description: "Local HTTP query ingress for the WasmEdge server profile.",
        },
      ],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    hostPlan: {
      hostId: "wasmedge-server-host",
      hostKind: "wasmedge",
      adapter: "host-internal",
      engine: "wasi",
      runtimes: [
        {
          runtimeId: "wasmedge-server",
          kind: "flow",
          programId: flow.programId,
          startupPhase: "session",
          autoStart: true,
          execution: "compiled-wasm",
          authority: "local",
          adapter: "host-internal",
          requiredCapabilities: ["http", "storage_query"],
          runtimeTargets: ["wasmedge"],
          bindings: [
            {
              bindingId: "query-http-listener",
              direction: "listen",
              transport: "http",
              url: "http://127.0.0.1:4171/catalog/omm/query",
            },
          ],
        },
      ],
    },
    pluginPackages: [
      createNoopPluginPackage(stripArtifactDependencies(httpFetcherManifest)),
      createNoopPluginPackage(stripArtifactDependencies(flatsqlStoreManifest)),
      createNoopPluginPackage(stripArtifactDependencies(sqlHttpBridgeManifest)),
    ],
  };
}

async function buildWasmedgeUdpWorkspace() {
  const flow = stripArtifactDependencies(
    await readJson(
    "../examples/environments/wasmedge-udp-spooler/flow.json",
    ),
  );
  const udpSpoolerManifest = await readJson(
    "../examples/plugins/udp-spooler/manifest.json",
  );

  return {
    workspaceId: "parity-wasmedge-udp",
    program: flow,
    deploymentPlan: {
      pluginId: flow.programId,
      version: flow.version,
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [
        {
          bindingId: "udp-packet-ready-binding",
          interfaceId: "udp-socket",
          targetPluginId: "com.digitalarsenal.flow.udp-spooler",
          targetMethodId: "spool_packets",
          targetInputPortId: "packet",
          sourceKind: "catalog-sync",
          description: "Local UDP ingress for the WasmEdge guest-network profile.",
        },
      ],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    hostPlan: {
      hostId: "wasmedge-udp-host",
      hostKind: "wasmedge",
      adapter: "host-internal",
      engine: "wasi",
      runtimes: [
        {
          runtimeId: "wasmedge-udp",
          kind: "flow",
          programId: flow.programId,
          startupPhase: "session",
          autoStart: true,
          execution: "compiled-wasm",
          authority: "local",
          adapter: "host-internal",
          requiredCapabilities: ["network", "filesystem"],
          runtimeTargets: ["wasmedge"],
          bindings: [
            {
              bindingId: "udp-ingest-direct",
              direction: "listen",
              transport: "direct",
              url: "udp://0.0.0.0:40123",
            },
          ],
        },
      ],
    },
    pluginPackages: [
      createNoopPluginPackage(stripArtifactDependencies(udpSpoolerManifest)),
    ],
  };
}

async function compileWorkspace(workspace) {
  if (workspace.serializedArtifact) {
    return workspace;
  }
  const host = createInstalledFlowHost({
    allowLiveProgramCompilation: true,
    program: workspace.program,
    hostPlan: workspace.hostPlan,
    deploymentPlan: workspace.deploymentPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  await host.start();
  return {
    ...workspace,
    serializedArtifact: serializeCompiledArtifact(host.getArtifact()),
  };
}

test("wasmedge server example reuses compiled artifacts on a WasmEdge host plan", async () => {
  const workspace = await compileWorkspace(
    await buildWasmedgeServerWorkspace(),
  );
  const normalizedProgram = normalizeProgram(workspace.program);
  const host = createInstalledFlowHost({
    program: workspace.program,
    serializedArtifact: workspace.serializedArtifact,
    deploymentPlan: workspace.deploymentPlan,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  const startup = await host.start();
  const deploymentPlan = host.getDeploymentPlan();

  assert.equal(startup.started, true);
  assert.equal(startup.programId, workspace.program.programId);
  assert.equal(normalizedProgram.runtimeTargetClass, null);
  assert.deepEqual(startup.runtimeTargets, ["server"]);
  assert.equal(startup.runtimeTargetClass, "server-side");
  assert.equal(startup.standardRuntimeTarget, "server");
  assert.deepEqual(
    deploymentPlan.inputBindings.map(
      (binding) => binding.bindingId,
    ),
    ["query-http-binding"],
  );
});

test("wasmedge guest-network example reuses compiled artifacts on a WasmEdge host plan", async () => {
  const workspace = await compileWorkspace(await buildWasmedgeUdpWorkspace());
  const normalizedProgram = normalizeProgram(workspace.program);
  const host = createInstalledFlowHost({
    program: workspace.program,
    serializedArtifact: workspace.serializedArtifact,
    deploymentPlan: workspace.deploymentPlan,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  const startup = await host.start();
  const deploymentPlan = host.getDeploymentPlan();

  assert.equal(startup.started, true);
  assert.equal(startup.programId, workspace.program.programId);
  assert.equal(normalizedProgram.runtimeTargetClass, "server-side");
  assert.equal(normalizedProgram.standardRuntimeTarget, "server");
  assert.deepEqual(startup.runtimeTargets, ["server"]);
  assert.equal(startup.runtimeTargetClass, "server-side");
  assert.equal(startup.standardRuntimeTarget, "server");
  assert.deepEqual(
    deploymentPlan.inputBindings.map(
      (binding) => binding.bindingId,
    ),
    ["udp-packet-ready-binding"],
  );
});

test("compiled artifacts stay compatible across standalone and runtime-host profiles", async () => {
  const workspace = await compileWorkspace(await buildStandaloneWorkspace());
  const installedHost = createInstalledFlowHost({
    program: workspace.program,
    serializedArtifact: workspace.serializedArtifact,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  const runtimeHost = await startStandaloneFlowRuntime({
    input: workspace.serializedArtifact,
  });

  const installedStartup = await installedHost.start();

  installedHost.enqueueTriggerFrames("manual-request", [
    createLinkedTestFrame(new Uint8Array([1, 2, 3]), {
      traceId: "installed-trace",
    }),
  ]);
  const installedDrain = await installedHost.drain();

  assert.equal(installedStartup.programId, workspace.program.programId);
  assert.equal(installedDrain.idle, true);
  assert.equal(installedDrain.executions.length, 1);
  assert.deepEqual(installedDrain.executions[0].outputs, []);
  assert.equal(runtimeHost.target.hostKind, "standalone-wasi");
  assert.deepEqual(runtimeHost.runtimeTargets, ["wasi"]);
  assert.equal(runtimeHost.runtimeCompatibility?.ok, true);

  await runtimeHost.close();
});

test("delegated browser host adapters reuse the same compiled artifact", async () => {
  const workspace = await compileWorkspace(buildBrowserWorkspace());
  const registeredListeners = [];
  const removedListeners = [];

  const host = await startInstalledFlowBrowserFetchHost({
    workspace,
    addEventListener(eventType, listener) {
      registeredListeners.push({
        eventType,
        listener,
      });
    },
    removeEventListener(eventType, listener) {
      removedListeners.push({
        eventType,
        listener,
      });
    },
  });

  assert.equal(host.bindingContexts.length, 1);
  assert.equal(host.bindingContexts[0].delegated, true);
  assert.equal(registeredListeners.length, 1);

  let responsePromise = null;
  registeredListeners[0].listener({
    request: new Request("https://app.example/download", {
      method: "POST",
      body: "payload",
    }),
    respondWith(nextResponsePromise) {
      responsePromise = nextResponsePromise;
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "browser");
  assert.equal(await response.text(), "payload");

  host.stop();

  assert.deepEqual(removedListeners, [
    {
      eventType: "fetch",
      listener: registeredListeners[0].listener,
    },
  ]);
});
