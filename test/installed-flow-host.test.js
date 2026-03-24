import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  createInstalledFlowHost,
  createInstalledFlowHostedRuntimePlan,
  createInstalledFlowService,
  discoverInstalledPluginPackages,
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  summarizeHostedRuntimePlan,
} from "../src/index.js";
import { ensureManagedSecurityState } from "../src/host/managedSecurity.js";

async function readJson(relativeUrl) {
  return JSON.parse(
    await readFile(new URL(relativeUrl, import.meta.url), "utf8"),
  );
}

function createAuthenticatedHttpServiceOptions(extra = {}) {
  return {
    program: {
      programId: "com.digitalarsenal.examples.authenticated-http-service",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.auth-http",
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
      requiredPlugins: ["com.digitalarsenal.examples.memory.auth-http"],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.authenticated-http-service",
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
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.auth-http",
          name: "In-Memory Auth HTTP",
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
                  ...frame.metadata,
                  statusCode: 200,
                },
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
    ...extra,
  };
}

function createAuthenticatedIpfsServiceOptions(extra = {}) {
  return {
    program: {
      programId: "com.digitalarsenal.examples.authenticated-ipfs-service",
      nodes: [
        {
          nodeId: "retention",
          pluginId: "com.digitalarsenal.examples.memory.auth-ipfs",
          methodId: "apply_retention",
        },
      ],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: ["com.digitalarsenal.examples.memory.auth-ipfs"],
      externalInterfaces: [
        {
          interfaceId: "ipfs-pin-retention",
          kind: "host-service",
          direction: "bidirectional",
          capability: "ipfs",
          resource: "ipfs://pin-retention",
          description: "Retains and evicts pinned content.",
          properties: {
            operations: ["pin", "unpin"],
          },
        },
      ],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.authenticated-ipfs-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [
        {
          bindingId: "ipfs-pin-retention-binding",
          interfaceId: "ipfs-pin-retention",
          targetPluginId: "com.digitalarsenal.examples.memory.auth-ipfs",
          targetMethodId: "apply_retention",
          targetInputPortId: "request",
          sourceKind: "catalog-sync",
          description: "Local IPFS retention ingress",
        },
      ],
      publicationBindings: [],
      authPolicies: [
        {
          policyId: "approved-ipfs-peers",
          bindingMode: "local",
          targetKind: "ipfs-service",
          targetId: "ipfs-pin-retention",
          allowServerKeys: ["ed25519:approved"],
          requireSignedRequests: true,
          requireEncryptedTransport: true,
        },
      ],
      protocolInstallations: [],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.auth-ipfs",
          name: "In-Memory Auth IPFS",
          version: "1.0.0",
          pluginFamily: "transform",
          methods: [
            {
              methodId: "apply_retention",
              inputPorts: [{ portId: "request", required: true }],
              outputPorts: [{ portId: "response" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          apply_retention({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "response",
                metadata: {
                  ...frame.metadata,
                  statusCode: 200,
                },
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
    ...extra,
  };
}

test("host plan summaries track engine compatibility for the shared sdn-js family", () => {
  const summary = summarizeHostedRuntimePlan({
    hostId: "browser-host",
    hostKind: "browser",
    adapter: HostedRuntimeAdapter.SDN_JS,
    engine: HostedRuntimeEngine.BROWSER,
    runtimes: [
      {
        runtimeId: "browser-flow",
        kind: "flow",
        programId: "com.digitalarsenal.examples.browser",
        requiredCapabilities: ["http", "filesystem", "process_exec"],
      },
    ],
  });

  assert.equal(summary.engine, HostedRuntimeEngine.BROWSER);
  assert.deepEqual(summary.runtimeCompatibility, [
    {
      runtimeId: "browser-flow",
      adapter: HostedRuntimeAdapter.SDN_JS,
      engine: HostedRuntimeEngine.BROWSER,
      supportedCapabilities: summary.runtimeCompatibility[0].supportedCapabilities,
      requiredCapabilities: ["filesystem", "http", "process_exec"],
      unsupportedCapabilities: ["filesystem", "process_exec"],
      ok: false,
    },
  ]);
});

test("discoverInstalledPluginPackages finds example plugin packages and their JS entrypoints", async () => {
  const packages = await discoverInstalledPluginPackages({
    rootDirectories: [new URL("../examples/plugins", import.meta.url).pathname],
  });

  const propagator = packages.find(
    (item) =>
      item.pluginId === "com.digitalarsenal.examples.basic-propagator",
  );
  const sensor = packages.find(
    (item) => item.pluginId === "com.digitalarsenal.examples.basic-sensor",
  );

  assert.ok(propagator);
  assert.ok(sensor);
  assert.match(propagator.modulePath ?? "", /basic-propagator\/plugin\.js$/);
  assert.match(sensor.modulePath ?? "", /basic-sensor\/plugin\.js$/);
});

test("installed flow host can discover plugin packages, register them, and execute a flow", async () => {
  const flow = await readJson("../examples/flows/single-plugin-flow.json");
  const sinkOutputs = [];
  const host = createInstalledFlowHost({
    program: flow,
    pluginRootDirectories: [new URL("../examples/plugins", import.meta.url).pathname],
    runtimeOptions: {
      onSinkOutput(event) {
        sinkOutputs.push(event);
      },
    },
  });

  const startup = await host.start();
  host.enqueueTriggerFrames("manual-request", [
    {
      portId: "request",
      streamId: 1,
      sequence: 1,
      typeRef: {
        schemaName: "StateRequest.fbs",
        fileIdentifier: "SREQ",
      },
      payload: new Uint8Array([1, 2, 3]),
    },
  ]);
  const drain = await host.drain();

  assert.equal(startup.programId, flow.programId);
  assert.equal(
    startup.registeredPluginIds.includes(
      "com.digitalarsenal.examples.basic-propagator",
    ),
    true,
  );
  assert.equal(drain.idle, true);
  assert.equal(sinkOutputs.length, 1);
  assert.equal(sinkOutputs[0].frame.portId, "state");
});

test("installed flow host supports browser-style in-memory plugin packages", async () => {
  const host = createInstalledFlowHost({
    program: {
      programId: "com.digitalarsenal.examples.browser-memory-host",
      nodes: [
        {
          nodeId: "upper",
          pluginId: "com.digitalarsenal.examples.memory.upper",
          methodId: "transform",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "manual",
          kind: "manual",
        },
      ],
      triggerBindings: [
        {
          triggerId: "manual",
          targetNodeId: "upper",
          targetPortId: "input",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.upper"],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.upper",
          name: "In-Memory Upper",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "transform",
              inputPorts: [{ portId: "input" }],
              outputPorts: [{ portId: "output" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          transform({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "output",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("manual", [
    {
      payload: new Uint8Array([9]),
      streamId: 7,
      sequence: 1,
    },
  ]);
  const result = await host.drain();

  assert.equal(result.idle, true);
  assert.equal(
    host
      .getLoadedPackages()
      .some(
        (item) => item.pluginId === "com.digitalarsenal.examples.memory.upper",
      ),
    true,
  );
});

test("installed flow host defaults internal node execution to aligned-binary metadata", async () => {
  const sinkInputFormats = [];
  const host = createInstalledFlowHost({
    program: {
      programId: "com.digitalarsenal.examples.internal-aligned-host",
      nodes: [
        {
          nodeId: "processor",
          pluginId: "com.digitalarsenal.examples.memory.processor",
          methodId: "transform",
        },
        {
          nodeId: "sink",
          pluginId: "com.digitalarsenal.examples.memory.sink",
          methodId: "sink",
        },
      ],
      edges: [
        {
          edgeId: "processor-to-sink",
          fromNodeId: "processor",
          fromPortId: "output",
          toNodeId: "sink",
          toPortId: "input",
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
          targetPortId: "input",
        },
      ],
      requiredPlugins: [
        "com.digitalarsenal.examples.memory.processor",
        "com.digitalarsenal.examples.memory.sink",
      ],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.processor",
          name: "In-Memory Processor",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "transform",
              inputPorts: [{ portId: "input", required: true }],
              outputPorts: [{ portId: "output" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          transform({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "output",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.sink",
          name: "In-Memory Sink",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "sink",
              inputPorts: [{ portId: "input", required: true }],
              outputPorts: [{ portId: "done" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          sink({ inputs }) {
            sinkInputFormats.push(inputs[0].typeRef?.wireFormat ?? null);
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "done",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("manual", [
    {
      portId: "input",
      streamId: 1,
      sequence: 1,
      typeRef: {
        schemaName: "CatalogRecord.fbs",
        fileIdentifier: "CTLG",
      },
      payload: new Uint8Array([1, 2, 3]),
    },
  ]);
  const result = await host.drain();
  const outputs = host.getSinkOutputsSince(0);

  assert.equal(result.idle, true);
  assert.deepEqual(sinkInputFormats, ["aligned-binary"]);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].frame.typeRef.wireFormat, "aligned-binary");
  assert.equal(outputs[0].frame.typeRef.requiredAlignment, 8);
});

test("installed flow hosted runtime plans default to the Deno engine for sdn-js startup", () => {
  const plan = createInstalledFlowHostedRuntimePlan({
    program: {
      programId: "com.digitalarsenal.examples.catalog-gateway",
      nodes: [],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: [],
    },
  });

  assert.equal(plan.engine, HostedRuntimeEngine.DENO);
  assert.equal(plan.runtimes[0].engine, HostedRuntimeEngine.DENO);
  assert.equal(plan.runtimes[0].autoStart, true);
});

test("installed flow hosted runtime plans derive explicit delegated scheduler, HTTP, storage, and protocol bindings", () => {
  const plan = createInstalledFlowHostedRuntimePlan({
    engine: HostedRuntimeEngine.DENO,
    httpBaseUrl: "https://gateway.example.test/base/",
    program: {
      programId: "com.digitalarsenal.examples.binding-surface-plan",
      nodes: [],
      edges: [],
      triggers: [
        {
          triggerId: "catalog-refresh",
          kind: "timer",
          defaultIntervalMs: 60000,
        },
        {
          triggerId: "catalog-http",
          kind: "http-request",
          source: "/catalog/latest",
        },
      ],
      triggerBindings: [],
      requiredPlugins: [],
      externalInterfaces: [
        {
          interfaceId: "catalog-dir",
          kind: "filesystem",
          direction: "output",
          capability: "filesystem",
          resource: "file:///var/lib/sdn/catalog-cache",
          required: true,
        },
        {
          interfaceId: "flatsql-store",
          kind: "database",
          direction: "bidirectional",
          capability: "storage_query",
          resource: "storage://flatsql",
          required: true,
        },
        {
          interfaceId: "storage-adapter",
          kind: "host-service",
          direction: "bidirectional",
          capability: "storage_adapter",
          resource: "storage-adapter://flatsql",
          required: true,
        },
        {
          interfaceId: "pnm-outbound",
          kind: "protocol",
          direction: "output",
          capability: "protocol_dial",
          protocolId: "/sds/pnm/1.0.0",
          resource: "/sds/pnm/1.0.0",
          required: true,
        },
      ],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.binding-surface-plan",
      version: "1.0.0",
      scheduleBindings: [
        {
          scheduleId: "schedule-catalog-refresh",
          bindingMode: "delegated",
          triggerId: "catalog-refresh",
          scheduleKind: "interval",
          intervalMs: 60000,
        },
      ],
      serviceBindings: [
        {
          serviceId: "service-catalog-http",
          bindingMode: "delegated",
          serviceKind: "http-server",
          triggerId: "catalog-http",
          routePath: "/catalog/latest",
          remoteUrl: "https://gateway.example.test/catalog/latest",
        },
      ],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [
        {
          protocolId: "/sds/pnm/1.0.0",
          wireId: "pnm-wire",
          transportKind: "http",
          role: "dial",
          nodeInfoUrl: "https://node.example.test/pnm",
        },
      ],
    },
  });
  const summary = summarizeHostedRuntimePlan(plan);

  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "schedule-catalog-refresh:listen" &&
        binding.transport === "same-app" &&
        binding.url === "schedule://catalog-refresh",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "service-catalog-http:listen" &&
        binding.transport === "http" &&
        binding.url === "https://gateway.example.test/catalog/latest",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "catalog-dir:dial" &&
        binding.transport === "same-app" &&
        binding.url === "file:///var/lib/sdn/catalog-cache",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "flatsql-store:listen" &&
        binding.transport === "same-app" &&
        binding.url === "storage://flatsql",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "flatsql-store:dial" &&
        binding.transport === "same-app" &&
        binding.url === "storage://flatsql",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "storage-adapter:listen" &&
        binding.transport === "same-app" &&
        binding.url === "storage-adapter://flatsql",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "pnm-outbound:dial" &&
        binding.transport === "sdn-protocol" &&
        binding.protocolId === "/sds/pnm/1.0.0" &&
        binding.url === "https://node.example.test/pnm",
    ),
    true,
  );
});

test("installed flow hosted runtime plans describe Go IPFS host services with official Kubo RPC metadata", () => {
  const plan = createInstalledFlowHostedRuntimePlan({
    engine: HostedRuntimeEngine.GO,
    hostKind: "go-sdn",
    adapter: HostedRuntimeAdapter.GO_SDN,
    program: {
      programId: "com.digitalarsenal.examples.go-ipfs-binding-plan",
      nodes: [],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: [],
      externalInterfaces: [
        {
          interfaceId: "ipfs-publish",
          kind: "host-service",
          direction: "output",
          capability: "ipfs",
          resource: "ipfs://publish-and-pin",
          description: "Publishes synchronized artifacts to IPFS and requests pinning.",
          properties: {
            operations: ["pin", "put"],
            implementation: {
              apiBaseUrl: "http://127.0.0.1:5001/api/v0",
            },
          },
        },
      ],
    },
  });
  const summary = summarizeHostedRuntimePlan(plan);
  const binding = summary.bindings.find(
    (item) => item.bindingId === "ipfs-publish:dial",
  );

  assert.ok(binding);
  assert.equal(binding.transport, "same-app");
  assert.equal(binding.url, "ipfs://publish-and-pin");
  assert.deepEqual(binding.implementation, {
    kind: "rpc-client",
    clientPackage: "github.com/ipfs/kubo/client/rpc",
    constructor: "rpc.NewURLApiWithClient",
    apiBaseUrl: "http://127.0.0.1:5001/api/v0",
    operations: ["pin", "put"],
    notes: "Back this IPFS host service with the official Kubo Go RPC client.",
  });
});

test("installed flow hosted runtime plans carry HE assessor protocol and wallet bindings through the deployment-plan path", async () => {
  const program = await readJson("../examples/flows/he-conjunction-assessor/flow.json");
  const manifests = await Promise.all([
    readJson("../examples/plugins/flatbuffers-he-session/manifest.json"),
    readJson("../examples/plugins/flatbuffers-he-conjunction/manifest.json"),
  ]);
  const plan = createInstalledFlowHostedRuntimePlan({
    hostId: "sdn-js-he-assessor",
    hostKind: "sdn-js",
    adapter: HostedRuntimeAdapter.SDN_JS,
    engine: HostedRuntimeEngine.DENO,
    program,
    manifests,
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.he-conjunction-assessor",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [
        {
          protocolId: "/sds/he/conjunction/assessment/1.0.0",
          wireId: "he-assessment-wire",
          transportKind: "http",
          role: "handle",
          serviceName: "he-conjunction-assessor",
          nodeInfoUrl:
            "https://assessor.example.test/sds/he/conjunction/assessment/1.0.0",
        },
      ],
    },
  });
  const summary = summarizeHostedRuntimePlan(plan);

  assert.deepEqual(plan.runtimes[0].runtimeTargets, ["server"]);
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "assessment-request:listen" &&
        binding.transport === "sdn-protocol" &&
        binding.protocolId === "/sds/he/conjunction/assessment/1.0.0" &&
        binding.url ===
          "https://assessor.example.test/sds/he/conjunction/assessment/1.0.0",
    ),
    true,
  );
  assert.equal(
    summary.bindings.some(
      (binding) =>
        binding.bindingId === "wallet-active-key:dial" &&
        binding.transport === "same-app" &&
        binding.url === "wallet://active-key",
    ),
    true,
  );
});

test("installed flow service auto-starts timer triggers with positive intervals", async () => {
  const scheduledIntervals = [];
  const clearedHandles = [];
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.timer-service",
      nodes: [
        {
          nodeId: "ticker",
          pluginId: "com.digitalarsenal.examples.memory.timer",
          methodId: "emit_tick",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "tick",
          kind: "timer",
          defaultIntervalMs: 250,
          acceptedTypes: [
            {
              schemaName: "TimerTick.fbs",
              fileIdentifier: "TICK",
            },
          ],
        },
        {
          triggerId: "disabled",
          kind: "timer",
          defaultIntervalMs: 0,
          acceptedTypes: [
            {
              schemaName: "TimerTick.fbs",
              fileIdentifier: "TICK",
            },
          ],
        },
      ],
      triggerBindings: [
        {
          triggerId: "tick",
          targetNodeId: "ticker",
          targetPortId: "tick",
        },
        {
          triggerId: "disabled",
          targetNodeId: "ticker",
          targetPortId: "tick",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.timer"],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.timer",
          name: "In-Memory Timer",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "emit_tick",
              inputPorts: [{ portId: "tick", required: true }],
              outputPorts: [{ portId: "out" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          emit_tick({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "out",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
    nowFn() {
      return 1700000000000;
    },
    setIntervalFn(callback, intervalMs) {
      const handle = { callback, intervalMs };
      scheduledIntervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      clearedHandles.push(handle);
    },
  });

  const startup = await service.start();

  assert.equal(scheduledIntervals.length, 1);
  assert.equal(scheduledIntervals[0].intervalMs, 250);
  assert.deepEqual(startup.timerTriggers, [
    {
      triggerId: "tick",
      source: null,
      defaultIntervalMs: 250,
      description: null,
      active: true,
    },
    {
      triggerId: "disabled",
      source: null,
      defaultIntervalMs: 0,
      description: null,
      active: false,
    },
  ]);

  scheduledIntervals[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const outputs = service.host.getSinkOutputsSince(0);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].frame.portId, "out");
  assert.equal(outputs[0].frame.metadata.triggerId, "tick");
  assert.equal(outputs[0].frame.metadata.triggerKind, "timer");
  assert.equal(outputs[0].frame.metadata.firedAt, 1700000000000);

  service.stop();

  assert.equal(clearedHandles.length, 1);
  assert.equal(service.getServiceSummary().started, false);
  assert.deepEqual(service.listTimerTriggers(), [
    {
      triggerId: "tick",
      source: null,
      defaultIntervalMs: 250,
      description: null,
      active: false,
    },
    {
      triggerId: "disabled",
      source: null,
      defaultIntervalMs: 0,
      description: null,
      active: false,
    },
  ]);
});

test("installed flow service maps HTTP requests into portable trigger dispatch", async () => {
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.http-service",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.http",
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
      requiredPlugins: ["com.digitalarsenal.examples.memory.http"],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.http",
          name: "In-Memory HTTP",
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
                  ...frame.metadata,
                  statusCode: 200,
                },
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  const startup = await service.start();
  const response = await service.handleHttpRequest({
    path: "/download",
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array([7, 8, 9]),
  });

  assert.deepEqual(startup.httpRoutes, [
    {
      triggerId: "download",
      path: "/download",
      description: null,
    },
  ]);
  assert.deepEqual(service.listHttpRoutes(), startup.httpRoutes);
  assert.equal(response.triggerId, "download");
  assert.equal(response.route, "/download");
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].frame.portId, "response");
  assert.equal(response.outputs[0].frame.metadata.method, "POST");
  assert.equal(response.outputs[0].frame.metadata.path, "/download");
  assert.equal(response.outputs[0].frame.metadata.statusCode, 200);
  assert.deepEqual(Array.from(response.outputs[0].frame.payload), [7, 8, 9]);

  await assert.rejects(
    service.handleHttpRequest({
      path: "/missing",
    }),
    /No HTTP trigger matches/,
  );
});

test("installed flow service can refresh installed packages and timer bindings", async () => {
  const scheduledIntervals = [];
  const clearedHandles = [];
  const buildProgram = (triggerId, intervalMs) => ({
    programId: `com.digitalarsenal.examples.refresh-service.${triggerId}`,
    nodes: [
      {
        nodeId: "ticker",
        pluginId: "com.digitalarsenal.examples.memory.refreshable",
        methodId: "emit_tick",
      },
    ],
    edges: [],
    triggers: [
      {
        triggerId,
        kind: "timer",
        defaultIntervalMs: intervalMs,
        acceptedTypes: [
          {
            schemaName: "TimerTick.fbs",
            fileIdentifier: "TICK",
          },
        ],
      },
    ],
    triggerBindings: [
      {
        triggerId,
        targetNodeId: "ticker",
        targetPortId: "tick",
      },
    ],
    requiredPlugins: ["com.digitalarsenal.examples.memory.refreshable"],
  });
  const buildPluginPackage = (versionByte) => ({
    manifest: {
      pluginId: "com.digitalarsenal.examples.memory.refreshable",
      name: "Refreshable In-Memory Timer",
      version: "1.0.0",
      pluginFamily: "analysis",
      methods: [
        {
          methodId: "emit_tick",
          inputPorts: [{ portId: "tick", required: true }],
          outputPorts: [{ portId: "out" }],
          maxBatch: 8,
          drainPolicy: "drain-to-empty",
        },
      ],
    },
    handlers: {
      emit_tick({ inputs }) {
        return {
          outputs: inputs.map((frame) => ({
            ...frame,
            portId: "out",
            payload: Uint8Array.of(versionByte),
          })),
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  const service = createInstalledFlowService({
    program: buildProgram("tick", 100),
    discover: false,
    pluginPackages: [buildPluginPackage(1)],
    nowFn() {
      return 1700000000100;
    },
    setIntervalFn(callback, intervalMs) {
      const handle = { callback, intervalMs };
      scheduledIntervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      clearedHandles.push(handle);
    },
  });

  await service.start();

  assert.equal(scheduledIntervals.length, 1);
  assert.equal(scheduledIntervals[0].intervalMs, 100);

  const refreshResult = await service.refresh({
    program: buildProgram("tock", 500),
    pluginPackages: [buildPluginPackage(2)],
    clearSinkOutputs: true,
  });

  assert.equal(clearedHandles.length, 1);
  assert.equal(scheduledIntervals.length, 2);
  assert.equal(scheduledIntervals[1].intervalMs, 500);
  assert.deepEqual(refreshResult.timerTriggers, [
    {
      triggerId: "tock",
      source: null,
      defaultIntervalMs: 500,
      description: null,
      active: true,
    },
  ]);

  scheduledIntervals[1].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const outputs = service.host.getSinkOutputsSince(0);
  assert.equal(outputs.length, 1);
  assert.deepEqual(Array.from(outputs[0].frame.payload), [2]);
  assert.equal(outputs[0].frame.metadata.triggerId, "tock");
});

test("installed flow service only auto-starts locally bound schedules", async () => {
  const scheduledIntervals = [];
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.delegated-timer-service",
      nodes: [],
      edges: [],
      triggers: [
        {
          triggerId: "tick",
          kind: "timer",
          defaultIntervalMs: 250,
        },
      ],
      triggerBindings: [],
      requiredPlugins: [],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.delegated-timer-service",
      version: "1.0.0",
      scheduleBindings: [
        {
          scheduleId: "schedule-tick",
          triggerId: "tick",
          bindingMode: "delegated",
          scheduleKind: "interval",
          intervalMs: 250,
        },
      ],
      serviceBindings: [],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
    setIntervalFn(callback, intervalMs) {
      scheduledIntervals.push({ callback, intervalMs });
      return { callback, intervalMs };
    },
    clearIntervalFn() {},
  });

  const startup = await service.start();

  assert.equal(scheduledIntervals.length, 0);
  assert.deepEqual(startup.timerTriggers, [
    {
      triggerId: "tick",
      source: null,
      defaultIntervalMs: 250,
      description: null,
      active: false,
    },
  ]);
});

test("installed flow service rejects delegated HTTP bindings from the local host path", async () => {
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.delegated-http-service",
      nodes: [],
      edges: [],
      triggers: [
        {
          triggerId: "download",
          kind: "http-request",
          source: "/download",
        },
      ],
      triggerBindings: [],
      requiredPlugins: [],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.delegated-http-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [
        {
          serviceId: "service-download",
          triggerId: "download",
          bindingMode: "delegated",
          serviceKind: "http-server",
          routePath: "/download",
          method: "POST",
        },
      ],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
  });

  await service.start();

  await assert.rejects(
    service.handleHttpRequest({
      path: "/download",
      method: "POST",
    }),
    /No HTTP trigger matches/,
  );
});

test("installed flow service enforces local HTTP auth policies from the deployment plan", async () => {
  const service = createInstalledFlowService(createAuthenticatedHttpServiceOptions());

  const startup = await service.start();
  assert.equal(startup.deploymentBindings.authPolicies.local.length, 1);

  await assert.rejects(
    service.handleHttpRequest({
      path: "/secure-download",
      method: "GET",
      headers: {
        "x-sdn-server-key": "ed25519:approved",
      },
      metadata: {
        url: "https://example.test/secure-download",
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /signed requests/i);
      return true;
    },
  );

  const response = await service.handleHttpRequest({
    path: "/secure-download",
    method: "GET",
    headers: {
      "x-sdn-server-key": "ed25519:approved",
      "x-sdn-signed-request": "1",
    },
    metadata: {
      url: "https://example.test/secure-download",
    },
  });

  assert.equal(response.serviceId, "service-secure-download");
  assert.deepEqual(response.authPolicies, ["approved-keys"]);
  assert.equal(response.outputs[0].frame.metadata.statusCode, 200);
});

test("installed flow service enforces local IPFS auth policies from the deployment plan", async () => {
  const service = createInstalledFlowService(createAuthenticatedIpfsServiceOptions());

  const startup = await service.start();
  assert.deepEqual(startup.ipfsRoutes, [
    {
      bindingId: "ipfs-pin-retention-binding",
      interfaceId: "ipfs-pin-retention",
      resource: "ipfs://pin-retention",
      direction: "bidirectional",
      description: "Local IPFS retention ingress",
      operations: ["pin", "unpin"],
      authPolicies: ["approved-ipfs-peers"],
    },
  ]);

  await assert.rejects(
    service.handleIpfsRequest({
      interfaceId: "ipfs-pin-retention",
      operation: "pin",
      cid: "bafydenied",
      headers: {
        "x-sdn-server-key": "ed25519:approved",
      },
      metadata: {
        url: "https://example.test/ipfs/pin-retention",
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /signed requests/i);
      return true;
    },
  );

  const response = await service.handleIpfsRequest({
    interfaceId: "ipfs-pin-retention",
    operation: "pin",
    cid: "bafyapproved",
    headers: {
      "x-sdn-server-key": "ed25519:approved",
      "x-sdn-signed-request": "1",
    },
    metadata: {
      url: "https://example.test/ipfs/pin-retention",
    },
    frame: {
      streamId: 1,
      payload: new Uint8Array([1, 2, 3]),
    },
  });

  assert.equal(response.bindingId, "ipfs-pin-retention-binding");
  assert.equal(response.interfaceId, "ipfs-pin-retention");
  assert.equal(response.resource, "ipfs://pin-retention");
  assert.deepEqual(response.authPolicies, ["approved-ipfs-peers"]);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].frame.metadata.ipfsOperation, "pin");
  assert.equal(response.outputs[0].frame.metadata.cid, "bafyapproved");
  assert.equal(
    response.outputs[0].frame.metadata.inputBindingId,
    "ipfs-pin-retention-binding",
  );
});

test("installed flow service aligns HTTP ingress frames before node-to-node dispatch", async () => {
  const ingressFormats = [];
  const sinkFormats = [];
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.aligned-http-service",
      nodes: [
        {
          nodeId: "parser",
          pluginId: "com.digitalarsenal.examples.memory.http-parser",
          methodId: "parse_request",
        },
        {
          nodeId: "sink",
          pluginId: "com.digitalarsenal.examples.memory.aligned-sink",
          methodId: "capture",
        },
      ],
      edges: [
        {
          edgeId: "parser-to-sink",
          fromNodeId: "parser",
          fromPortId: "parsed",
          toNodeId: "sink",
          toPortId: "input",
        },
      ],
      triggers: [
        {
          triggerId: "catalog-http",
          kind: "http-request",
          source: "/catalog",
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
          triggerId: "catalog-http",
          targetNodeId: "parser",
          targetPortId: "request",
        },
      ],
      requiredPlugins: [
        "com.digitalarsenal.examples.memory.http-parser",
        "com.digitalarsenal.examples.memory.aligned-sink",
      ],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.aligned-http-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [
        {
          serviceId: "catalog-http-service",
          triggerId: "catalog-http",
          bindingMode: "local",
          serviceKind: "http-server",
          routePath: "/catalog",
          method: "POST",
        },
      ],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.http-parser",
          name: "In-Memory HTTP Parser",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "parse_request",
              inputPorts: [{ portId: "request", required: true }],
              outputPorts: [{ portId: "parsed" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          parse_request({ inputs }) {
            ingressFormats.push(inputs[0].typeRef?.wireFormat ?? null);
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "parsed",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.aligned-sink",
          name: "In-Memory Aligned Sink",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "capture",
              inputPorts: [{ portId: "input", required: true }],
              outputPorts: [{ portId: "response" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          capture({ inputs }) {
            sinkFormats.push(inputs[0].typeRef?.wireFormat ?? null);
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "response",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  await service.start();
  const response = await service.handleHttpRequest({
    path: "/catalog",
    method: "POST",
    typeRef: {
      schemaName: "HttpRequest.fbs",
      fileIdentifier: "HREQ",
    },
    payload: new Uint8Array([1, 2, 3]),
  });

  assert.equal(response.serviceId, "catalog-http-service");
  assert.deepEqual(ingressFormats, ["aligned-binary"]);
  assert.deepEqual(sinkFormats, ["aligned-binary"]);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].frame.typeRef.wireFormat, "aligned-binary");
  assert.equal(response.outputs[0].frame.typeRef.requiredAlignment, 8);
});

test("installed flow service resolves walletProfileId and trustMapId against managed wallet trust material", async () => {
  const securityDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-service-wallet-trust-"),
  );
  const securityState = await ensureManagedSecurityState({
    projectRoot: securityDirectory,
    scopeId: "trusted-client",
    security: {
      storageDir: path.join(securityDirectory, ".sdn-flow-security"),
      wallet: {
        enabled: true,
      },
      tls: {
        enabled: false,
      },
    },
    startup: {
      protocol: "https",
      hostname: "127.0.0.1",
    },
  });
  const trustedServerKey = `ed25519:${securityState.wallet.signingPublicKeyHex}`;
  const service = createInstalledFlowService(
    createAuthenticatedHttpServiceOptions({
      deploymentPlan: {
        pluginId: "com.digitalarsenal.examples.authenticated-http-service",
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
            authPolicyId: "wallet-trust",
          },
        ],
        inputBindings: [],
        publicationBindings: [],
        authPolicies: [
          {
            policyId: "wallet-trust",
            bindingMode: "local",
            targetKind: "service",
            targetId: "service-secure-download",
            walletProfileId: "trusted-client",
            trustMapId: "approved-callers",
            requireSignedRequests: true,
            requireEncryptedTransport: true,
          },
        ],
        protocolInstallations: [],
      },
      walletProfiles: {
        "trusted-client": {
          recordPath: securityState.wallet.recordPath,
        },
      },
      trustMaps: {
        "approved-callers": {
          walletProfileId: "trusted-client",
        },
      },
    }),
  );

  const startup = await service.start();
  assert.deepEqual(
    startup.deploymentBindings.authPolicies.local.map((policy) => policy.policyId),
    ["wallet-trust"],
  );

  await assert.rejects(
    service.handleHttpRequest({
      path: "/secure-download",
      method: "GET",
      headers: {
        "x-sdn-server-key": "ed25519:not-approved",
        "x-sdn-signed-request": "1",
      },
      metadata: {
        url: "https://example.test/secure-download",
      },
    }),
    /server key/i,
  );

  const response = await service.handleHttpRequest({
    path: "/secure-download",
    method: "GET",
    headers: {
      "x-sdn-server-key": trustedServerKey.toLowerCase(),
      "x-sdn-signed-request": "1",
    },
    metadata: {
      url: "https://example.test/secure-download",
    },
  });

  assert.equal(response.serviceId, "service-secure-download");
  assert.deepEqual(response.authPolicies, ["wallet-trust"]);
  assert.equal(response.outputs[0].frame.metadata.statusCode, 200);
});

test("installed flow service resolves walletProfileId and trustMapId against managed wallet trust material for IPFS services", async () => {
  const securityDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-service-ipfs-wallet-trust-"),
  );
  const securityState = await ensureManagedSecurityState({
    projectRoot: securityDirectory,
    scopeId: "trusted-client",
    security: {
      storageDir: path.join(securityDirectory, ".sdn-flow-security"),
      wallet: {
        enabled: true,
      },
      tls: {
        enabled: false,
      },
    },
    startup: {
      protocol: "https",
      hostname: "127.0.0.1",
    },
  });
  const trustedServerKey = `ed25519:${securityState.wallet.signingPublicKeyHex}`;
  const service = createInstalledFlowService(
    createAuthenticatedIpfsServiceOptions({
      baseDirectory: securityDirectory,
      deploymentPlan: {
        pluginId: "com.digitalarsenal.examples.authenticated-ipfs-service",
        version: "1.0.0",
        scheduleBindings: [],
        serviceBindings: [],
        inputBindings: [
          {
            bindingId: "ipfs-pin-retention-binding",
            interfaceId: "ipfs-pin-retention",
            targetPluginId: "com.digitalarsenal.examples.memory.auth-ipfs",
            targetMethodId: "apply_retention",
            targetInputPortId: "request",
            sourceKind: "catalog-sync",
            description: "Local IPFS retention ingress",
          },
        ],
        publicationBindings: [],
        authPolicies: [
          {
            policyId: "wallet-ipfs-trust",
            bindingMode: "local",
            targetKind: "ipfs-service",
            targetId: "ipfs-pin-retention",
            walletProfileId: "trusted-client",
            trustMapId: "approved-callers",
            requireSignedRequests: true,
            requireEncryptedTransport: true,
          },
        ],
        protocolInstallations: [],
      },
      walletProfiles: {
        "trusted-client": {
          recordPath: securityState.wallet.recordPath,
        },
      },
      trustMaps: {
        "approved-callers": {
          walletProfileId: "trusted-client",
        },
      },
    }),
  );

  const startup = await service.start();
  assert.deepEqual(startup.ipfsRoutes[0].authPolicies, ["wallet-ipfs-trust"]);

  await assert.rejects(
    service.handleIpfsRequest({
      interfaceId: "ipfs-pin-retention",
      operation: "pin",
      cid: "bafydenied",
      headers: {
        "x-sdn-server-key": "ed25519:not-approved",
        "x-sdn-signed-request": "1",
      },
      metadata: {
        url: "https://example.test/ipfs/pin-retention",
      },
    }),
    /server key/i,
  );

  const response = await service.handleIpfsRequest({
    interfaceId: "ipfs-pin-retention",
    operation: "pin",
    cid: "bafytrusted",
    headers: {
      "x-sdn-server-key": trustedServerKey.toLowerCase(),
      "x-sdn-signed-request": "1",
    },
    metadata: {
      url: "https://example.test/ipfs/pin-retention",
    },
    frame: {
      streamId: 1,
      payload: new Uint8Array([7, 8, 9]),
    },
  });

  assert.deepEqual(response.authPolicies, ["wallet-ipfs-trust"]);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].frame.metadata.cid, "bafytrusted");
});

test("installed flow service exposes delegated deployment bindings explicitly", async () => {
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.delegated-binding-summary",
      nodes: [],
      edges: [],
      triggers: [
        {
          triggerId: "tick",
          kind: "timer",
          defaultIntervalMs: 250,
        },
        {
          triggerId: "download",
          kind: "http-request",
          source: "/download",
        },
      ],
      triggerBindings: [],
      requiredPlugins: [],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.delegated-binding-summary",
      version: "1.0.0",
      scheduleBindings: [
        {
          scheduleId: "schedule-tick",
          triggerId: "tick",
          bindingMode: "delegated",
          scheduleKind: "interval",
          intervalMs: 250,
        },
      ],
      serviceBindings: [
        {
          serviceId: "service-download",
          triggerId: "download",
          bindingMode: "delegated",
          serviceKind: "http-server",
          routePath: "/download",
          method: "GET",
          authPolicyId: "gateway-auth",
        },
      ],
      inputBindings: [],
      publicationBindings: [
        {
          publicationId: "publication-catalog",
          interfaceId: "catalog-publication",
          bindingMode: "delegated",
          sourceKind: "node-output",
          sourceNodeId: "publisher",
        },
      ],
      authPolicies: [
        {
          policyId: "gateway-auth",
          bindingMode: "delegated",
          targetKind: "service",
          targetId: "service-download",
          allowServerKeys: ["ed25519:gateway"],
        },
      ],
      protocolInstallations: [],
    },
    discover: false,
  });

  const startup = await service.start();

  assert.equal(startup.deploymentBindings.schedules.local.length, 0);
  assert.equal(startup.deploymentBindings.schedules.delegated.length, 1);
  assert.equal(startup.deploymentBindings.services.delegated[0].serviceId, "service-download");
  assert.equal(startup.deploymentBindings.authPolicies.delegated[0].policyId, "gateway-auth");
  assert.equal(
    startup.deploymentBindings.publications.delegated[0].publicationId,
    "publication-catalog",
  );
});

test("installed flow service captures local publication bindings from trigger ingress and node outputs", async () => {
  const service = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.local-publication-service",
      nodes: [
        {
          nodeId: "publisher",
          pluginId: "com.digitalarsenal.examples.memory.publisher",
          methodId: "publish_records",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "manual",
          kind: "manual",
        },
      ],
      triggerBindings: [
        {
          triggerId: "manual",
          targetNodeId: "publisher",
          targetPortId: "records",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.publisher"],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.local-publication-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [],
      publicationBindings: [
        {
          publicationId: "publication-ingress",
          interfaceId: "manual-ingress-publication",
          bindingMode: "local",
          sourceKind: "trigger-ingress",
          sourceTriggerId: "manual",
        },
        {
          publicationId: "publication-local",
          interfaceId: "publisher-output-publication",
          bindingMode: "local",
          sourceKind: "node-output",
          sourceNodeId: "publisher",
          sourceOutputPortId: "published",
        },
      ],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.publisher",
          name: "In-Memory Publisher",
          version: "1.0.0",
          pluginFamily: "publisher",
          methods: [
            {
              methodId: "publish_records",
              inputPorts: [{ portId: "records", required: true }],
              outputPorts: [{ portId: "published" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          publish_records({ inputs }) {
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "published",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  const startup = await service.start();
  const response = await service.dispatchTriggerFrames("manual", [
    {
      portId: "records",
      streamId: 1,
      sequence: 1,
      typeRef: {
        schemaName: "CatalogRecord.fbs",
        fileIdentifier: "CTLG",
      },
      payload: new Uint8Array([1, 2, 3]),
    },
  ]);

  assert.deepEqual(
    startup.deploymentBindings.publications.local.map(
      (binding) => binding.publicationId,
    ),
    ["publication-ingress", "publication-local"],
  );
  assert.equal(response.outputs.length, 1);
  assert.equal(response.publications.length, 2);
  assert.deepEqual(
    response.publications.map((event) => event.publicationId),
    ["publication-ingress", "publication-local"],
  );
  assert.equal(response.publications[0].source.triggerId, "manual");
  assert.equal(response.publications[0].source.nodeId, null);
  assert.equal(response.publications[1].source.nodeId, "publisher");
  assert.equal(response.publications[1].source.methodId, "publish_records");
  assert.equal(response.publications[1].source.portId, "published");
  assert.deepEqual(
    Array.from(response.publications[1].frame.payload),
    [1, 2, 3],
  );
  assert.equal(service.getPublicationEventCount(), 2);
  service.clearPublicationEvents();
  assert.equal(service.getPublicationEventCount(), 0);
});

test("installed flow service dispatches local input bindings by interfaceId", async () => {
  const seenInputs = [];
  const inputBoundService = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.input-bound-ingress",
      nodes: [
        {
          nodeId: "consumer",
          pluginId: "com.digitalarsenal.examples.memory.input-consumer",
          methodId: "consume_input",
        },
      ],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: ["com.digitalarsenal.examples.memory.input-consumer"],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.input-bound-ingress",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [
        {
          bindingId: "catalog-feed",
          interfaceId: "catalog-input",
          targetPluginId: "com.digitalarsenal.examples.memory.input-consumer",
          targetMethodId: "consume_input",
          targetInputPortId: "request",
          sourceKind: "catalog-sync",
          description: "Catalog feed ingress",
        },
      ],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.input-consumer",
          name: "In-Memory Input Consumer",
          version: "1.0.0",
          pluginFamily: "analysis",
          methods: [
            {
              methodId: "consume_input",
              inputPorts: [
                {
                  portId: "request",
                  acceptedTypeSets: [
                    {
                      allowedTypes: [
                        {
                          schemaName: "CatalogRecord.fbs",
                          fileIdentifier: "CTLG",
                        },
                      ],
                    },
                  ],
                },
              ],
              outputPorts: [{ portId: "published" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          consume_input({ inputs }) {
            seenInputs.push(inputs[0]);
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "published",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  const startup = await inputBoundService.start();
  const response = await inputBoundService.dispatchInputBindingFrames(
    "catalog-input",
    [
      {
        streamId: 1,
        sequence: 1,
        payload: new Uint8Array([1, 2, 3]),
      },
    ],
  );

  assert.deepEqual(
    startup.deploymentBindings.inputBindings.map((binding) => binding.bindingId),
    ["catalog-feed"],
  );
  assert.equal(response.bindingId, "catalog-feed");
  assert.equal(response.interfaceId, "catalog-input");
  assert.equal(response.triggerId, "__sdn_input_binding__:catalog-feed");
  assert.equal(response.outputs.length, 1);
  assert.deepEqual(Array.from(response.outputs[0].frame.payload), [1, 2, 3]);
  assert.equal(seenInputs.length, 1);
  assert.equal(seenInputs[0].portId, "request");
  assert.equal(seenInputs[0].metadata.inputBindingId, "catalog-feed");
  assert.equal(seenInputs[0].metadata.interfaceId, "catalog-input");
  assert.equal(seenInputs[0].typeRef.schemaName, "CatalogRecord.fbs");
  assert.equal(seenInputs[0].typeRef.fileIdentifier, "CTLG");
});

test("installed flow service rejects input bindings without matching program nodes", async () => {
  const inputBoundService = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.input-bound-service",
      nodes: [],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: [],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.input-bound-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [
        {
          bindingId: "catalog-feed",
          interfaceId: "catalog-input",
          targetPluginId: "com.digitalarsenal.examples.memory.input-consumer",
          targetMethodId: "consume_input",
          targetInputPortId: "request",
          sourceKind: "catalog-sync",
        },
      ],
      publicationBindings: [],
      authPolicies: [],
      protocolInstallations: [],
    },
    discover: false,
  });

  await assert.rejects(
    inputBoundService.start(),
    /no program nodes match target method/i,
  );
});

test("installed flow service hosts local protocol installations by protocolId with auth enforcement", async () => {
  const seenProtocolIds = [];
  const protocolBoundService = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.protocol-bound-service",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.protocol",
          methodId: "handle_protocol",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "catalog-protocol",
          kind: "protocol-request",
          protocolId: "/com.digitalarsenal/catalog/1.0.0",
          source: "/com.digitalarsenal/catalog/1.0.0",
        },
      ],
      triggerBindings: [
        {
          triggerId: "catalog-protocol",
          targetNodeId: "responder",
          targetPortId: "request",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.protocol"],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.protocol-bound-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [
        {
          policyId: "approved-protocol-peers",
          bindingMode: "local",
          targetKind: "protocol",
          targetId: "/com.digitalarsenal/catalog/1.0.0",
          allowServerKeys: ["ed25519:approved"],
          requireSignedRequests: true,
          requireEncryptedTransport: true,
        },
      ],
      protocolInstallations: [
        {
          protocolId: "/com.digitalarsenal/catalog/1.0.0",
          wireId: "catalog-wire",
          transportKind: "http",
          role: "handle",
          serviceName: "catalog-protocol",
          nodeInfoUrl: "https://node.example.test/catalog",
        },
      ],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.protocol",
          name: "In-Memory Protocol",
          version: "1.0.0",
          pluginFamily: "responder",
          methods: [
            {
              methodId: "handle_protocol",
              inputPorts: [{ portId: "request", required: true }],
              outputPorts: [{ portId: "response" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          handle_protocol({ inputs }) {
            seenProtocolIds.push(
              inputs.map((frame) => frame.metadata?.protocolId ?? null),
            );
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "response",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  const startup = await protocolBoundService.start();
  assert.equal(startup.protocolRoutes.length, 1);
  assert.equal(startup.protocolRoutes[0].triggerId, "catalog-protocol");
  assert.equal(
    startup.protocolRoutes[0].protocolId,
    "/com.digitalarsenal/catalog/1.0.0",
  );
  assert.equal(startup.protocolRoutes[0].serviceName, "catalog-protocol");
  assert.deepEqual(startup.protocolRoutes[0].authPolicies, [
    "approved-protocol-peers",
  ]);

  await assert.rejects(
    protocolBoundService.handleProtocolRequest({
      protocolId: "/com.digitalarsenal/catalog/1.0.0",
      signedRequest: true,
      encryptedTransport: true,
      serverKey: "ed25519:denied",
      frames: [
        {
          streamId: 1,
          sequence: 1,
          typeRef: {
            schemaName: "CatalogRequest.fbs",
            fileIdentifier: "CREQ",
          },
          payload: new Uint8Array([1, 2, 3]),
        },
      ],
    }),
    (error) =>
      error?.statusCode === 403 && /server key/i.test(error.message),
  );

  const response = await protocolBoundService.handleProtocolRequest({
    protocolId: "/com.digitalarsenal/catalog/1.0.0",
    signedRequest: true,
    encryptedTransport: true,
    serverKey: "ed25519:approved",
    frames: [
      {
        streamId: 1,
        sequence: 1,
        typeRef: {
          schemaName: "CatalogRequest.fbs",
          fileIdentifier: "CREQ",
        },
        payload: new Uint8Array([4, 5, 6]),
      },
    ],
  });

  assert.equal(response.triggerId, "catalog-protocol");
  assert.equal(response.protocolId, "/com.digitalarsenal/catalog/1.0.0");
  assert.equal(response.serviceName, "catalog-protocol");
  assert.deepEqual(response.authPolicies, ["approved-protocol-peers"]);
  assert.equal(response.outputs.length, 1);
  assert.deepEqual(Array.from(response.outputs[0].frame.payload), [4, 5, 6]);
  assert.equal(response.outputs[0].frame.metadata.protocolId, "/com.digitalarsenal/catalog/1.0.0");
  assert.deepEqual(seenProtocolIds, [["/com.digitalarsenal/catalog/1.0.0"]]);
});

test("installed flow service keeps protocol identity in the manifest and uses deployment routes for local selection", async () => {
  const seenProtocolRequests = [];
  const protocolBoundService = createInstalledFlowService({
    program: {
      programId: "com.digitalarsenal.examples.protocol-route-service",
      nodes: [
        {
          nodeId: "responder",
          pluginId: "com.digitalarsenal.examples.memory.protocol-router",
          methodId: "handle_protocol",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "catalog-protocol",
          kind: "protocol-request",
          protocolId: "/com.digitalarsenal/catalog/1.0.0",
          source: "/com.digitalarsenal/catalog/1.0.0",
        },
      ],
      triggerBindings: [
        {
          triggerId: "catalog-protocol",
          targetNodeId: "responder",
          targetPortId: "request",
        },
      ],
      requiredPlugins: ["com.digitalarsenal.examples.memory.protocol-router"],
    },
    deploymentPlan: {
      pluginId: "com.digitalarsenal.examples.protocol-route-service",
      version: "1.0.0",
      scheduleBindings: [],
      serviceBindings: [],
      inputBindings: [],
      publicationBindings: [],
      authPolicies: [
        {
          policyId: "catalog-a-auth",
          bindingMode: "local",
          targetKind: "protocol-service",
          targetId: "catalog-a",
          allowServerKeys: ["ed25519:catalog-a"],
          requireSignedRequests: true,
          requireEncryptedTransport: true,
        },
        {
          policyId: "catalog-b-auth",
          bindingMode: "local",
          targetKind: "protocol-service",
          targetId: "catalog-b",
          allowServerKeys: ["ed25519:catalog-b"],
          requireSignedRequests: true,
          requireEncryptedTransport: true,
        },
      ],
      protocolInstallations: [
        {
          protocolId: "/com.digitalarsenal/catalog/1.0.0",
          transportKind: "http",
          role: "handle",
          serviceName: "catalog-a",
          nodeInfoUrl: "https://node.example.test/catalog-a",
        },
        {
          protocolId: "/com.digitalarsenal/catalog/1.0.0",
          transportKind: "http",
          role: "handle",
          serviceName: "catalog-b",
          nodeInfoUrl: "https://node.example.test/catalog-b",
        },
      ],
    },
    discover: false,
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.examples.memory.protocol-router",
          name: "In-Memory Protocol Router",
          version: "1.0.0",
          pluginFamily: "responder",
          methods: [
            {
              methodId: "handle_protocol",
              inputPorts: [{ portId: "request", required: true }],
              outputPorts: [{ portId: "response" }],
              maxBatch: 8,
              drainPolicy: "drain-to-empty",
            },
          ],
        },
        handlers: {
          handle_protocol({ inputs }) {
            seenProtocolRequests.push({
              protocolId: inputs[0].metadata?.protocolId ?? null,
              serviceName: inputs[0].metadata?.serviceName ?? null,
              nodeInfoUrl: inputs[0].metadata?.nodeInfoUrl ?? null,
            });
            return {
              outputs: inputs.map((frame) => ({
                ...frame,
                portId: "response",
              })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  const startup = await protocolBoundService.start();
  assert.deepEqual(
    startup.protocolRoutes.map((route) => ({
      protocolId: route.protocolId,
      serviceName: route.serviceName,
      nodeInfoUrl: route.nodeInfoUrl,
      authPolicies: route.authPolicies,
    })),
    [
      {
        protocolId: "/com.digitalarsenal/catalog/1.0.0",
        serviceName: "catalog-a",
        nodeInfoUrl: "https://node.example.test/catalog-a",
        authPolicies: ["catalog-a-auth"],
      },
      {
        protocolId: "/com.digitalarsenal/catalog/1.0.0",
        serviceName: "catalog-b",
        nodeInfoUrl: "https://node.example.test/catalog-b",
        authPolicies: ["catalog-b-auth"],
      },
    ],
  );

  await assert.rejects(
    protocolBoundService.handleProtocolRequest({
      protocolId: "/com.digitalarsenal/catalog/1.0.0",
      serviceName: "catalog-b",
      signedRequest: true,
      encryptedTransport: true,
      serverKey: "ed25519:catalog-a",
      frames: [
        {
          streamId: 1,
          sequence: 1,
          typeRef: {
            schemaName: "CatalogRequest.fbs",
            fileIdentifier: "CREQ",
          },
          payload: new Uint8Array([1, 2, 3]),
        },
      ],
    }),
    (error) =>
      error?.statusCode === 403 && /server key/i.test(error.message),
  );

  const response = await protocolBoundService.handleProtocolRequest({
    protocolId: "/com.digitalarsenal/catalog/1.0.0",
    nodeInfoUrl: "https://node.example.test/catalog-b",
    signedRequest: true,
    encryptedTransport: true,
    serverKey: "ed25519:catalog-b",
    frames: [
      {
        streamId: 1,
        sequence: 1,
        typeRef: {
          schemaName: "CatalogRequest.fbs",
          fileIdentifier: "CREQ",
        },
        payload: new Uint8Array([4, 5, 6]),
      },
    ],
  });

  assert.equal(response.protocolId, "/com.digitalarsenal/catalog/1.0.0");
  assert.equal(response.serviceName, "catalog-b");
  assert.equal(
    response.installation.nodeInfoUrl,
    "https://node.example.test/catalog-b",
  );
  assert.deepEqual(response.authPolicies, ["catalog-b-auth"]);
  assert.equal(response.outputs.length, 1);
  assert.equal(
    response.outputs[0].frame.metadata.protocolId,
    "/com.digitalarsenal/catalog/1.0.0",
  );
  assert.equal(response.outputs[0].frame.metadata.serviceName, "catalog-b");
  assert.equal(
    response.outputs[0].frame.metadata.nodeInfoUrl,
    "https://node.example.test/catalog-b",
  );
  assert.deepEqual(seenProtocolRequests, [
    {
      protocolId: "/com.digitalarsenal/catalog/1.0.0",
      serviceName: "catalog-b",
      nodeInfoUrl: "https://node.example.test/catalog-b",
    },
  ]);
});
