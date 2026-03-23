import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createInstalledFlowHost,
  createInstalledFlowHostedRuntimePlan,
  createInstalledFlowService,
  discoverInstalledPluginPackages,
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  summarizeHostedRuntimePlan,
} from "../src/index.js";

async function readJson(relativeUrl) {
  return JSON.parse(
    await readFile(new URL(relativeUrl, import.meta.url), "utf8"),
  );
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
