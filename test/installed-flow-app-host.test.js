import test from "node:test";
import assert from "node:assert/strict";

import {
  createInstalledFlowHost,
  listInstalledFlowHttpBindings,
  serializeCompiledArtifact,
  startInstalledFlowAppHost,
} from "../src/index.js";

function buildHttpWorkspace() {
  return {
    workspaceId: "http-app-host",
    program: {
      programId: "com.digitalarsenal.examples.http-app-host",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.host-http",
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
      requiredPlugins: ["com.digitalarsenal.examples.memory.host-http"],
    },
    hostPlan: {
      hostId: "http-host",
      hostKind: "sdn-js",
      adapter: "sdn-js",
      engine: "deno",
      runtimes: [
        {
          runtimeId: "http-flow",
          kind: "flow",
          programId: "com.digitalarsenal.examples.http-app-host",
          startupPhase: "session",
          autoStart: true,
          bindings: [
            {
              bindingId: "catalog-http-listener",
              direction: "listen",
              transport: "http",
              url: "http://127.0.0.1:9080/download",
            },
          ],
        },
      ],
    },
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.host-http",
          name: "In-Memory Host HTTP",
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
                    "x-binding": "catalog-http-listener",
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
    fetch: {
      baseUrl: "http://127.0.0.1:9080",
    },
  };
}

async function buildRuntimeHttpWorkspace() {
  const workspace = buildHttpWorkspace();
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

test("listInstalledFlowHttpBindings extracts host-plan HTTP listen bindings for the active program", () => {
  const bindings = listInstalledFlowHttpBindings({
    workspace: buildHttpWorkspace(),
  });

  assert.deepEqual(bindings, [
    {
      runtimeId: "http-flow",
      programId: "com.digitalarsenal.examples.http-app-host",
      adapter: "sdn-js",
      engine: "deno",
      delegated: false,
      delegationReasons: [],
      binding: {
        bindingId: "catalog-http-listener",
        direction: "listen",
        transport: "http",
        protocolId: null,
        targetRuntimeId: null,
        audience: null,
        peerId: null,
        url: "http://127.0.0.1:9080/download",
        required: true,
        description: null,
      },
    },
  ]);
});

test("startInstalledFlowAppHost binds HTTP listeners through the injected serve adapter", async () => {
  const serveCalls = [];
  const closedBindings = [];
  const host = await startInstalledFlowAppHost({
    workspace: await buildRuntimeHttpWorkspace(),
    serveHttp({ binding, handler }) {
      serveCalls.push({
        binding,
        handler,
      });
      return {
        close() {
          closedBindings.push(binding.bindingId);
        },
      };
    },
  });

  assert.equal(host.listeners.length, 1);
  assert.equal(host.listeners[0].delegated, false);
  assert.equal(serveCalls.length, 1);
  assert.equal(serveCalls[0].binding.bindingId, "catalog-http-listener");

  const response = await serveCalls[0].handler(
    new Request("http://127.0.0.1:9080/download", {
      method: "GET",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-binding"), "catalog-http-listener");

  await host.stop();

  assert.deepEqual(closedBindings, ["catalog-http-listener"]);
});
