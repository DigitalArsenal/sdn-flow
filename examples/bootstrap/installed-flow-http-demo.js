const Encoder = new TextEncoder();

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function buildResponsePayload(frame) {
  if (frame.payload instanceof Uint8Array && frame.payload.length > 0) {
    return frame.payload;
  }
  const method = normalizeString(frame.metadata?.method, "GET");
  const path = normalizeString(frame.metadata?.path, "/demo");
  return Encoder.encode(`${method} ${path}`);
}

export function createBootstrapDemoWorkspace(options = {}) {
  const url = new URL(
    normalizeString(options.url, "http://127.0.0.1:9080/demo"),
  );

  return {
    workspaceId:
      normalizeString(options.workspaceId, null) ??
      `bootstrap-demo-${options.engine ?? "js"}`,
    program: {
      programId:
        normalizeString(options.programId, null) ??
        "com.digitalarsenal.examples.bootstrap.http-host",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.bootstrap.http-responder",
          methodId: "serve_http_request",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "demo-http",
          kind: "http-request",
          source: url.pathname,
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
          triggerId: "demo-http",
          targetNodeId: "responder",
          targetPortId: "request",
        },
      ],
      requiredPlugins: [
        "com.digitalarsenal.examples.bootstrap.http-responder",
      ],
    },
    hostPlan: {
      hostId:
        normalizeString(options.hostId, null) ??
        `bootstrap-host-${options.engine ?? "js"}`,
      hostKind: options.hostKind ?? "sdn-js",
      adapter: options.adapter ?? "sdn-js",
      engine: options.engine ?? null,
      runtimes: [
        {
          runtimeId:
            normalizeString(options.runtimeId, null) ??
            "bootstrap-runtime",
          kind: "flow",
          programId:
            normalizeString(options.programId, null) ??
            "com.digitalarsenal.examples.bootstrap.http-host",
          startupPhase: "session",
          autoStart: true,
          bindings: [
            {
              bindingId: "bootstrap-http-listener",
              direction: "listen",
              transport: "http",
              url: url.href,
            },
          ],
        },
      ],
    },
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.bootstrap.http-responder",
          name: "Bootstrap HTTP Responder",
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
                payload: buildResponsePayload(frame),
                metadata: {
                  statusCode: 200,
                  responseHeaders: {
                    "content-type": "text/plain; charset=utf-8",
                    "x-bootstrap-engine": options.engine ?? "js",
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
      baseUrl: url.origin,
    },
    engine: options.engine ?? null,
  };
}

export default {
  createBootstrapDemoWorkspace,
};
