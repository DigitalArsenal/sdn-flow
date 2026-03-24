import test from "node:test";
import assert from "node:assert/strict";

import {
  createInstalledFlowApp,
  createInstalledFlowBrowserFetchEventListener,
  matchesInstalledFlowHttpBindingRequest,
  startInstalledFlowBrowserFetchHost,
} from "../src/index.js";

function buildBrowserWorkspace() {
  return {
    workspaceId: "browser-fetch-host",
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
    fetch: {
      baseUrl: "https://app.example",
    },
  };
}

test("matchesInstalledFlowHttpBindingRequest matches fetch requests by bound path", () => {
  const bindingContext = {
    binding: {
      url: "https://app.example/download",
    },
  };

  assert.equal(
    matchesInstalledFlowHttpBindingRequest(
      bindingContext,
      new Request("https://app.example/download"),
    ),
    true,
  );
  assert.equal(
    matchesInstalledFlowHttpBindingRequest(
      bindingContext,
      new Request("https://app.example/other"),
    ),
    false,
  );
});

test("createInstalledFlowBrowserFetchEventListener routes matching fetch events into the installed flow app", async () => {
  const app = await createInstalledFlowApp({
    workspace: buildBrowserWorkspace(),
  });
  await app.start();
  const listener = createInstalledFlowBrowserFetchEventListener({
    app,
  });
  let matchedResponse = null;
  const matched = listener({
    request: new Request("https://app.example/download", {
      method: "POST",
      body: "payload",
    }),
    respondWith(responsePromise) {
      matchedResponse = responsePromise;
    },
  });
  const unmatched = listener({
    request: new Request("https://app.example/other"),
    respondWith() {
      throw new Error("respondWith should not run for unmatched bindings.");
    },
  });

  assert.equal(matched, true);
  assert.equal(unmatched, false);
  assert.ok(matchedResponse instanceof Promise);
  const response = await matchedResponse;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "browser");
  assert.equal(await response.text(), "payload");
});

test("startInstalledFlowBrowserFetchHost registers and removes a fetch listener", async () => {
  const registeredListeners = [];
  const removedListeners = [];
  const host = await startInstalledFlowBrowserFetchHost({
    workspace: buildBrowserWorkspace(),
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
  assert.deepEqual(host.bindingContexts[0].delegationReasons, [
    "browser-host-surface",
    "browser-inbound-listener",
    "browser-fetch-handler",
  ]);
  assert.equal(registeredListeners.length, 1);
  assert.equal(registeredListeners[0].eventType, "fetch");

  let responsePromise = null;
  registeredListeners[0].listener({
    request: new Request("https://app.example/download"),
    respondWith(nextResponsePromise) {
      responsePromise = nextResponsePromise;
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-runtime"), "browser");

  host.stop();

  assert.deepEqual(removedListeners, [
    {
      eventType: "fetch",
      listener: registeredListeners[0].listener,
    },
  ]);
});
