import test from "node:test";
import assert from "node:assert/strict";

import {
  createBunServeHttpAdapter,
  createDenoServeHttpAdapter,
  startInstalledFlowBunHttpHost,
  startInstalledFlowDenoHttpHost,
  startInstalledFlowNodeHttpHost,
} from "../src/index.js";

function buildHttpWorkspace(bindingUrl = "http://127.0.0.1:9080/download") {
  return {
    workspaceId: "http-adapter-host",
    program: {
      programId: "com.digitalarsenal.examples.http-adapter-host",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.http-adapter",
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
      requiredPlugins: ["com.digitalarsenal.examples.memory.http-adapter"],
    },
    hostPlan: {
      hostId: "http-adapter-host",
      hostKind: "sdn-js",
      adapter: "sdn-js",
      engine: "deno",
      runtimes: [
        {
          runtimeId: "http-flow",
          kind: "flow",
          programId: "com.digitalarsenal.examples.http-adapter-host",
          startupPhase: "session",
          autoStart: true,
          bindings: [
            {
              bindingId: "catalog-http-listener",
              direction: "listen",
              transport: "http",
              url: bindingUrl,
            },
          ],
        },
      ],
    },
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.http-adapter",
          name: "In-Memory HTTP Adapter",
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
                    "x-runtime": "flow",
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

test("createDenoServeHttpAdapter binds host-plan URLs through a Deno.serve-compatible function", async () => {
  const serveCalls = [];
  const adapter = createDenoServeHttpAdapter({
    serve(options, handler) {
      serveCalls.push({
        options,
        handler,
      });
      return {
        shutdown() {
          serveCalls.push({
            type: "shutdown",
          });
        },
      };
    },
  });

  const handle = await adapter({
    binding: {
      url: "http://127.0.0.1:9080/download",
    },
    handler(request) {
      return new Response(request.method, {
        status: 200,
      });
    },
  });
  const response = await serveCalls[0].handler(
    new Request("http://127.0.0.1:9080/download", {
      method: "POST",
    }),
  );

  assert.deepEqual(serveCalls[0].options, {
    hostname: "127.0.0.1",
    port: 9080,
  });
  assert.equal(handle.platform, "deno");
  assert.equal(handle.url, "http://127.0.0.1:9080/download");
  assert.equal(await response.text(), "POST");

  await handle.close();

  assert.equal(serveCalls[1].type, "shutdown");
});

test("createBunServeHttpAdapter binds host-plan URLs through a Bun.serve-compatible function", async () => {
  const serveCalls = [];
  const adapter = createBunServeHttpAdapter({
    serve(options) {
      serveCalls.push(options);
      return {
        stop() {
          serveCalls.push({
            type: "stop",
          });
        },
      };
    },
  });

  const handle = await adapter({
    binding: {
      url: "http://127.0.0.1:9081/download",
    },
    handler(request) {
      return new Response(request.method, {
        status: 200,
      });
    },
  });
  const response = await serveCalls[0].fetch(
    new Request("http://127.0.0.1:9081/download", {
      method: "PUT",
    }),
  );

  assert.deepEqual(
    {
      hostname: serveCalls[0].hostname,
      port: serveCalls[0].port,
    },
    {
      hostname: "127.0.0.1",
      port: 9081,
    },
  );
  assert.equal(typeof serveCalls[0].fetch, "function");
  assert.equal(handle.platform, "bun");
  assert.equal(handle.url, "http://127.0.0.1:9081/download");
  assert.equal(await response.text(), "PUT");

  await handle.close();

  assert.equal(serveCalls[1].type, "stop");
});

test("startInstalledFlowDenoHttpHost uses the Deno adapter with an injected serve function", async () => {
  const serveCalls = [];
  const host = await startInstalledFlowDenoHttpHost({
    workspace: buildHttpWorkspace(),
    serve(options, handler) {
      serveCalls.push({
        options,
        handler,
      });
      return {
        shutdown() {
          serveCalls.push({
            type: "shutdown",
          });
        },
      };
    },
  });

  assert.equal(host.listeners.length, 1);
  assert.equal(serveCalls[0].options.port, 9080);

  const response = await serveCalls[0].handler(
    new Request("http://127.0.0.1:9080/download", {
      method: "GET",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "flow");

  await host.stop();

  assert.equal(serveCalls[1].type, "shutdown");
});

test("startInstalledFlowBunHttpHost uses the Bun adapter with an injected serve function", async () => {
  const serveCalls = [];
  const host = await startInstalledFlowBunHttpHost({
    workspace: buildHttpWorkspace(),
    serve(options) {
      serveCalls.push(options);
      return {
        stop() {
          serveCalls.push({
            type: "stop",
          });
        },
      };
    },
  });

  assert.equal(host.listeners.length, 1);
  assert.equal(serveCalls[0].port, 9080);

  const response = await serveCalls[0].fetch(
    new Request("http://127.0.0.1:9080/download", {
      method: "GET",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "flow");

  await host.stop();

  assert.equal(serveCalls[1].type, "stop");
});

test("startInstalledFlowNodeHttpHost starts a real Node HTTP listener from the host plan", async () => {
  const host = await startInstalledFlowNodeHttpHost({
    workspace: buildHttpWorkspace("http://127.0.0.1:0/download"),
  });

  assert.equal(host.listeners.length, 1);
  assert.equal(host.listeners[0].handle.platform, "node");
  assert.ok(host.listeners[0].handle.port > 0);

  const response = await fetch(host.listeners[0].handle.url, {
    method: "POST",
    body: "payload",
    headers: {
      "content-type": "text/plain",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "flow");
  assert.equal(await response.text(), "payload");

  await host.stop();
});
