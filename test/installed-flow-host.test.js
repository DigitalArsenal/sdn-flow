import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createInstalledFlowHost,
  createInstalledFlowHostedRuntimePlan,
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
