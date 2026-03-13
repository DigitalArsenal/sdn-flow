import test from "node:test";
import assert from "node:assert/strict";

import {
  BackpressurePolicy,
  DrainPolicy,
  FlowRuntime,
  MethodRegistry,
} from "../src/index.js";

function createTypeRef(schemaName = "OMM.fbs", fileIdentifier = "OMM ") {
  return {
    schemaName,
    fileIdentifier,
    schemaHash: [1, 2, 3, 4],
    acceptsAnyFlatbuffer: false,
  };
}

function createFrame(sequence, overrides = {}) {
  return {
    typeRef: overrides.typeRef ?? createTypeRef(),
    portId: overrides.portId ?? "in",
    alignment: 8,
    offset: 4096 + sequence * 64,
    size: 64,
    ownership: "shared",
    generation: 0,
    mutability: "immutable",
    traceId: 100 + sequence,
    streamId: overrides.streamId ?? 1,
    sequence,
    endOfStream: false,
  };
}

function createManifest() {
  return {
    pluginId: "com.digitalarsenal.runtime.test",
    name: "Runtime Test",
    version: "0.1.0",
    pluginFamily: "analysis",
    methods: [
      {
        methodId: "process",
        displayName: "Process",
        inputPorts: [
          {
            portId: "in",
            acceptedTypeSets: [
              {
                setId: "orbital",
                allowedTypes: [createTypeRef()],
              },
            ],
            minStreams: 1,
            maxStreams: 1,
            required: true,
          },
        ],
        outputPorts: [
          {
            portId: "out",
            acceptedTypeSets: [
              {
                setId: "orbital",
                allowedTypes: [createTypeRef()],
              },
            ],
            minStreams: 1,
            maxStreams: 1,
            required: true,
          },
        ],
        maxBatch: 1,
        drainPolicy: DrainPolicy.DRAIN_UNTIL_YIELD,
      },
    ],
  };
}

test("single-record methods drain until queue is empty", async () => {
  const registry = new MethodRegistry();
  const seen = [];

  registry.registerPlugin({
    manifest: createManifest(),
    handlers: {
      process: ({ inputs }) => ({
        outputs: inputs.map((frame) => {
          seen.push(frame.sequence);
          return { ...frame, portId: "out" };
        }),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  const runtime = new FlowRuntime({
    registry,
    maxInvocationsPerDrain: 16,
  });
  runtime.loadProgram({
    programId: "flow.runtime.single",
    name: "Single",
    nodes: [
      {
        nodeId: "node-1",
        pluginId: "com.digitalarsenal.runtime.test",
        methodId: "process",
        drainPolicy: DrainPolicy.DRAIN_UNTIL_YIELD,
      },
    ],
    triggers: [
      {
        triggerId: "trigger-1",
        kind: "pubsub-subscription",
        source: "/sdn/omm",
      },
    ],
    triggerBindings: [
      {
        triggerId: "trigger-1",
        targetNodeId: "node-1",
        targetPortId: "in",
        backpressurePolicy: BackpressurePolicy.QUEUE,
        queueDepth: 8,
      },
    ],
  });

  runtime.enqueueTriggerFrames("trigger-1", [
    createFrame(1),
    createFrame(2),
    createFrame(3),
  ]);

  const result = await runtime.drain();

  assert.equal(result.invocations, 3);
  assert.equal(result.idle, true);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("outputs route across edges into downstream nodes", async () => {
  const registry = new MethodRegistry();
  const sinkSeen = [];

  registry.registerPlugin({
    manifest: createManifest(),
    handlers: {
      process: ({ inputs }) => ({
        outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });
  registry.registerPlugin({
    manifest: {
      pluginId: "com.digitalarsenal.runtime.sink",
      methods: [
        {
          methodId: "sink",
          inputPorts: [
            {
              portId: "in",
              acceptedTypeSets: [
                {
                  setId: "orbital",
                  allowedTypes: [createTypeRef()],
                },
              ],
            },
          ],
          outputPorts: [],
          maxBatch: 1,
        },
      ],
    },
    handlers: {
      sink: ({ inputs }) => {
        sinkSeen.push(inputs[0].sequence);
        return {
          outputs: [],
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  const runtime = new FlowRuntime({
    registry,
    maxInvocationsPerDrain: 16,
  });
  runtime.loadProgram({
    programId: "flow.runtime.route",
    name: "Route",
    nodes: [
      {
        nodeId: "processor",
        pluginId: "com.digitalarsenal.runtime.test",
        methodId: "process",
      },
      {
        nodeId: "sink",
        pluginId: "com.digitalarsenal.runtime.sink",
        methodId: "sink",
      },
    ],
    edges: [
      {
        edgeId: "edge-1",
        fromNodeId: "processor",
        fromPortId: "out",
        toNodeId: "sink",
        toPortId: "in",
        backpressurePolicy: BackpressurePolicy.QUEUE,
        queueDepth: 8,
      },
    ],
  });

  runtime.enqueueNodeFrames("processor", "in", [createFrame(9)]);
  const result = await runtime.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(sinkSeen, [9]);
});

test("registered plugins can be removed and cleared from the runtime registry", async () => {
  const registry = new MethodRegistry();

  registry.registerPlugin({
    manifest: createManifest(),
    handlers: {
      process: ({ inputs }) => ({
        outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  assert.equal(
    registry.getMethod("com.digitalarsenal.runtime.test", "process") !== null,
    true,
  );

  assert.equal(
    registry.unregisterPlugin("com.digitalarsenal.runtime.test"),
    true,
  );
  assert.equal(
    registry.getMethod("com.digitalarsenal.runtime.test", "process"),
    null,
  );
  assert.deepEqual(registry.listPlugins(), []);

  registry.registerPlugin({
    manifest: createManifest(),
    handlers: {
      process: ({ inputs }) => ({
        outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });
  registry.clear();
  assert.deepEqual(registry.listPlugins(), []);
});
