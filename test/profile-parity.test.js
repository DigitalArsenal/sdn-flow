import test from "node:test";
import assert from "node:assert/strict";

import {
  bindCompiledFlowRuntimeHost,
  createInstalledFlowHost,
  serializeCompiledArtifact,
  startInstalledFlowBrowserFetchHost,
  startStandaloneFlowRuntime,
} from "../src/index.js";
import {
  handlers as basicPropagatorHandlers,
  manifest as basicPropagatorManifest,
} from "../examples/plugins/basic-propagator/plugin.js";

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

function buildStandaloneWorkspace() {
  return {
    workspaceId: "parity-single-plugin",
    program: {
      programId: "com.digitalarsenal.examples.single-plugin-flow",
      nodes: [
        {
          nodeId: "processor",
          pluginId: "com.digitalarsenal.examples.basic-propagator",
          methodId: "propagate",
          kind: "transform",
          drainPolicy: "drain-to-empty",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "manual-request",
          kind: "manual",
          source: "user",
        },
      ],
      triggerBindings: [
        {
          triggerId: "manual-request",
          targetNodeId: "processor",
          targetPortId: "request",
          backpressurePolicy: "queue",
          queueDepth: 16,
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.basic-propagator"],
    },
    hostPlan: {
      hostId: "parity-single-plugin",
      hostKind: "standalone-wasi",
      adapter: "host-internal",
      engine: "wasi",
      runtimes: [],
    },
    pluginPackages: [
      {
        manifest: basicPropagatorManifest,
        handlers: basicPropagatorHandlers,
      },
    ],
  };
}

function buildBrowserWorkspace() {
  return {
    workspaceId: "parity-browser",
    program: {
      programId: "com.digitalarsenal.examples.browser-fetch-host",
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

async function compileWorkspace(workspace) {
  const host = createInstalledFlowHost({
    allowLiveProgramCompilation: true,
    program: workspace.program,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  await host.start();
  return {
    ...workspace,
    serializedArtifact: serializeCompiledArtifact(host.getArtifact()),
  };
}

test("compiled artifacts stay compatible across standalone and runtime-host profiles", async () => {
  const workspace = await compileWorkspace(buildStandaloneWorkspace());
  const outputs = [];
  const installedHost = createInstalledFlowHost({
    program: workspace.program,
    serializedArtifact: workspace.serializedArtifact,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
    runtimeOptions: {
      onSinkOutput(event) {
        outputs.push(event);
      },
    },
  });

  const runtimeHost = await startStandaloneFlowRuntime({
    input: workspace.serializedArtifact,
    handlers: basicPropagatorHandlers,
    bindRuntimeHost: bindCompiledFlowRuntimeHost,
  });

  const installedStartup = await installedHost.start();

  installedHost.enqueueTriggerFrames("manual-request", [
    createTestFrame(new Uint8Array([1, 2, 3]), {
      traceId: "installed-trace",
    }),
  ]);
  const installedDrain = await installedHost.drain();

  assert.equal(installedStartup.programId, workspace.program.programId);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].frame.portId, "state");
  assert.equal(installedDrain.idle, true);
  assert.equal(installedDrain.executions.length, 1);
  assert.equal(installedDrain.executions[0].outputs[0].portId, "state");
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
