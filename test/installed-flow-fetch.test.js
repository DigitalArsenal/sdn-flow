import test from "node:test";
import assert from "node:assert/strict";

import {
  createFetchResponse,
  createInstalledFlowHost,
  createInstalledFlowFetchHandler,
  normalizeFetchRequest,
  serializeCompiledArtifact,
} from "../src/index.js";

async function compileSerializedArtifact(options = {}) {
  const host = createInstalledFlowHost({
    allowLiveProgramCompilation: true,
    ...options,
  });
  await host.start();
  return serializeCompiledArtifact(host.getArtifact());
}

test("normalizeFetchRequest maps Request objects into portable HTTP trigger input", async () => {
  const request = new Request(
    "https://example.test/download?file=alpha&format=text",
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-request-id": "req-123",
      },
      body: "payload",
    },
  );
  const normalized = await normalizeFetchRequest(request);

  assert.equal(normalized.requestId, "req-123");
  assert.equal(normalized.method, "POST");
  assert.equal(normalized.path, "/download");
  assert.deepEqual(normalized.query, {
    file: "alpha",
    format: "text",
  });
  assert.equal(normalized.headers["content-type"], "text/plain");
  assert.equal(normalized.metadata.url, "https://example.test/download?file=alpha&format=text");
  assert.equal(new TextDecoder().decode(normalized.body), "payload");
});

test("installed flow fetch handler returns a web Response from flow output", async () => {
  const program = {
    programId: "com.digitalarsenal.examples.fetch-service",
    nodes: [
      {
        nodeId: "responder",
        pluginId: "com.digitalarsenal.examples.memory.fetch",
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
    requiredPlugins: ["com.digitalarsenal.examples.memory.fetch"],
  };
  const pluginPackages = [
    {
      manifest: {
        pluginId: "com.digitalarsenal.examples.memory.fetch",
        name: "In-Memory Fetch",
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
                statusCode: 201,
                responseHeaders: {
                  "content-type": "text/plain",
                  "x-flow-trigger": frame.metadata.triggerId,
                  "x-query-file": frame.metadata.query.file,
                },
              },
            })),
            backlogRemaining: 0,
            yielded: false,
          };
        },
      },
    },
  ];
  const serializedArtifact = await compileSerializedArtifact({
    program,
    discover: false,
    pluginPackages,
  });
  const handler = createInstalledFlowFetchHandler({
    program,
    serializedArtifact,
    discover: false,
    pluginPackages,
  });

  const response = await handler(
    new Request("https://example.test/download?file=alpha", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "payload",
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("x-flow-trigger"), "download");
  assert.equal(response.headers.get("x-query-file"), "alpha");
  assert.equal(await response.text(), "payload");
  assert.deepEqual(handler.service.listHttpRoutes(), [
    {
      triggerId: "download",
      path: "/download",
      description: null,
    },
  ]);
});

test("createFetchResponse defaults to 204 when a flow emits no HTTP response frame", async () => {
  const response = createFetchResponse({
    outputs: [],
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("installed flow fetch handler converts auth policy failures into HTTP error responses", async () => {
  const program = {
    programId: "com.digitalarsenal.examples.fetch-auth-service",
    nodes: [
      {
        nodeId: "responder",
        pluginId: "com.digitalarsenal.examples.memory.fetch-auth",
        methodId: "serve_http_request",
      },
    ],
    edges: [],
    triggers: [
      {
        triggerId: "secure-download",
        kind: "http-request",
        source: "/secure-download",
      },
    ],
    triggerBindings: [
      {
        triggerId: "secure-download",
        targetNodeId: "responder",
        targetPortId: "request",
      },
    ],
    requiredPlugins: ["com.digitalarsenal.examples.memory.fetch-auth"],
  };
  const deploymentPlan = {
    pluginId: "com.digitalarsenal.examples.fetch-auth-service",
    version: "1.0.0",
    scheduleBindings: [],
    serviceBindings: [
      {
        serviceId: "service-secure-download",
        triggerId: "secure-download",
        bindingMode: "local",
        serviceKind: "http-server",
        routePath: "/secure-download",
        method: "GET",
        authPolicyId: "approved-keys",
      },
    ],
    inputBindings: [],
    publicationBindings: [],
    authPolicies: [
      {
        policyId: "approved-keys",
        bindingMode: "local",
        targetKind: "service",
        targetId: "service-secure-download",
        allowServerKeys: ["ed25519:approved"],
        requireSignedRequests: true,
        requireEncryptedTransport: true,
      },
    ],
    protocolInstallations: [],
  };
  const pluginPackages = [
    {
      manifest: {
        pluginId: "com.digitalarsenal.examples.memory.fetch-auth",
        name: "In-Memory Fetch Auth",
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
              },
            })),
            backlogRemaining: 0,
            yielded: false,
          };
        },
      },
    },
  ];
  const serializedArtifact = await compileSerializedArtifact({
    program,
    deploymentPlan,
    discover: false,
    pluginPackages,
  });
  const handler = createInstalledFlowFetchHandler({
    program,
    deploymentPlan,
    serializedArtifact,
    discover: false,
    pluginPackages,
  });

  const rejected = await handler(
    new Request("https://example.test/secure-download", {
      method: "GET",
      headers: {
        "x-sdn-server-key": "ed25519:approved",
      },
    }),
  );

  assert.equal(rejected.status, 403);
  assert.match(await rejected.text(), /signed requests/i);

  const accepted = await handler(
    new Request("https://example.test/secure-download", {
      method: "GET",
      headers: {
        "x-sdn-server-key": "ed25519:approved",
        "x-sdn-signed-request": "1",
      },
    }),
  );

  assert.equal(accepted.status, 200);
});
