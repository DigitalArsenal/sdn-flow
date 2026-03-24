import test from "node:test";
import assert from "node:assert/strict";

import {
  BackpressurePolicy,
  createInstalledFlowHost,
  DefaultInvokeExports,
  DefaultManifestExports,
  DrainPolicy,
  InvokeSurface,
  MethodRegistry,
  normalizeArtifactDependency,
} from "../src/index.js";

function createTypeRef(
  schemaName = "OMM.fbs",
  fileIdentifier = "OMM ",
  overrides = {},
) {
  return {
    schemaName,
    fileIdentifier,
    schemaHash: [1, 2, 3, 4],
    acceptsAnyFlatbuffer: false,
    ...overrides,
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

function createProgramCompilingInstalledFlowHost(options = {}) {
  return createInstalledFlowHost({
    allowLiveProgramCompilation: true,
    discover: false,
    ...options,
  });
}

test("single-record methods drain until queue is empty through the installed host runtime", async () => {
  const seen = [];

  const host = createProgramCompilingInstalledFlowHost({
    program: {
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
      edges: [],
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
    },
    pluginPackages: [
      {
        manifest: createManifest(),
        handlers: {
          process: ({ inputs }) => ({
            outputs: inputs.map((frame) => {
              seen.push(frame.traceId);
              return { ...frame, portId: "out" };
            }),
            backlogRemaining: 0,
            yielded: false,
          }),
        },
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("trigger-1", [
    createFrame(1),
    createFrame(2),
    createFrame(3),
  ]);

  const result = await host.drain();

  assert.equal(result.invocations, 3);
  assert.equal(result.idle, true);
  assert.deepEqual(seen, [101, 102, 103]);
});

test("installed host runtime routes outputs across edges into downstream nodes", async () => {
  const sinkSeen = [];

  const host = createProgramCompilingInstalledFlowHost({
    program: {
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
      triggers: [
        {
          triggerId: "trigger-1",
          kind: "manual",
        },
      ],
      triggerBindings: [
        {
          triggerId: "trigger-1",
          targetNodeId: "processor",
          targetPortId: "in",
        },
      ],
    },
    pluginPackages: [
      {
        manifest: createManifest(),
        handlers: {
          process: ({ inputs }) => ({
            outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
            backlogRemaining: 0,
            yielded: false,
          }),
        },
      },
      {
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
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("trigger-1", [createFrame(9)]);
  const result = await host.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(sinkSeen, [9]);
});

test("installed host runtime defaults internal node execution to aligned-binary while preserving schema compatibility", async () => {
  const processorInputFormats = [];
  const sinkInputTypes = [];

  const host = createProgramCompilingInstalledFlowHost({
    program: {
      programId: "flow.runtime.internal-aligned-default",
      nodes: [
        {
          nodeId: "processor",
          pluginId: "com.digitalarsenal.runtime.test",
          methodId: "process",
        },
        {
          nodeId: "sink",
          pluginId: "com.digitalarsenal.runtime.aligned-sink",
          methodId: "sink",
        },
      ],
      edges: [
        {
          edgeId: "processor-to-sink",
          fromNodeId: "processor",
          fromPortId: "out",
          toNodeId: "sink",
          toPortId: "in",
        },
      ],
      triggers: [
        {
          triggerId: "trigger-1",
          kind: "manual",
        },
      ],
      triggerBindings: [
        {
          triggerId: "trigger-1",
          targetNodeId: "processor",
          targetPortId: "in",
        },
      ],
    },
    pluginPackages: [
      {
        manifest: createManifest(),
        handlers: {
          process: ({ inputs }) => {
            processorInputFormats.push(inputs[0].typeRef?.wireFormat ?? null);
            return {
              outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
      {
        manifest: {
          pluginId: "com.digitalarsenal.runtime.aligned-sink",
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
                  minStreams: 1,
                  maxStreams: 1,
                  required: true,
                },
              ],
              outputPorts: [],
              maxBatch: 1,
            },
          ],
        },
        handlers: {
          sink: ({ inputs }) => {
            sinkInputTypes.push(inputs[0].typeRef);
            return {
              outputs: [],
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("trigger-1", [createFrame(1)]);
  const result = await host.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(processorInputFormats, ["aligned-binary"]);
  assert.equal(sinkInputTypes.length, 1);
  assert.equal(sinkInputTypes[0].wireFormat, "aligned-binary");
  assert.equal(sinkInputTypes[0].requiredAlignment, 8);
});

test("installed host runtime leaves filesystem and storage exception plugins on their declared wire format", async () => {
  const sinkInputFormats = [];

  const host = createProgramCompilingInstalledFlowHost({
    program: {
      programId: "flow.runtime.filesystem-exception",
      nodes: [
        {
          nodeId: "writer",
          pluginId: "com.digitalarsenal.runtime.filesystem-sink",
          methodId: "write_records",
        },
      ],
      edges: [],
      triggers: [
        {
          triggerId: "trigger-1",
          kind: "manual",
        },
      ],
      triggerBindings: [
        {
          triggerId: "trigger-1",
          targetNodeId: "writer",
          targetPortId: "records",
        },
      ],
    },
    pluginPackages: [
      {
        manifest: {
          pluginId: "com.digitalarsenal.runtime.filesystem-sink",
          name: "Filesystem Sink",
          version: "0.1.0",
          pluginFamily: "sink",
          capabilities: ["filesystem"],
          externalInterfaces: [
            {
              interfaceId: "filesystem-output",
              kind: "filesystem",
              direction: "output",
              capability: "filesystem",
              resource: "file:///tmp/runtime-test-output",
            },
          ],
          methods: [
            {
              methodId: "write_records",
              inputPorts: [
                {
                  portId: "records",
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
              outputPorts: [],
              maxBatch: 1,
              drainPolicy: DrainPolicy.DRAIN_UNTIL_YIELD,
            },
          ],
        },
        handlers: {
          write_records: ({ inputs }) => {
            sinkInputFormats.push(inputs[0].typeRef?.wireFormat ?? null);
            return {
              outputs: [],
              backlogRemaining: 0,
              yielded: false,
            };
          },
        },
      },
    ],
  });

  await host.start();
  host.enqueueTriggerFrames("trigger-1", [
    createFrame(1, {
      portId: "records",
    }),
  ]);
  const result = await host.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(sinkInputFormats, [null]);
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

test("runtime preserves aligned type metadata and does not treat aligned bytes as plain flatbuffers", async () => {
  const alignedTypeRef = createTypeRef("StateVector.fbs", "STVC", {
    wireFormat: "aligned-binary",
    rootTypeName: "StateVector",
    byteLength: 64,
    requiredAlignment: 16,
  });
  const regularManifest = {
    ...createManifest(),
    methods: [
      {
        ...createManifest().methods[0],
        inputPorts: [
          {
            ...createManifest().methods[0].inputPorts[0],
            acceptedTypeSets: [
              {
                setId: "state-vector",
                allowedTypes: [createTypeRef("StateVector.fbs", "STVC")],
              },
            ],
          },
        ],
      },
    ],
  };
  const regularOnlyRegistry = new MethodRegistry();
  regularOnlyRegistry.registerPlugin({
    manifest: regularManifest,
    handlers: {
      process: ({ inputs }) => ({
        outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  await assert.rejects(
    regularOnlyRegistry.invoke({
      pluginId: regularManifest.pluginId,
      methodId: "process",
      inputs: [
        createFrame(1, {
          typeRef: alignedTypeRef,
        }),
      ],
    }),
    /rejected frame type "StateVector\.fbs"/,
  );

  const dualFormatInputsSeen = [];
  const dualFormatRegistry = new MethodRegistry();
  dualFormatRegistry.registerPlugin({
    manifest: {
      ...regularManifest,
      methods: [
        {
          ...regularManifest.methods[0],
          inputPorts: [
            {
              ...regularManifest.methods[0].inputPorts[0],
              acceptedTypeSets: [
                {
                  setId: "state-vector",
                  allowedTypes: [
                    createTypeRef("StateVector.fbs", "STVC"),
                    alignedTypeRef,
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    handlers: {
      process: ({ inputs }) => {
        dualFormatInputsSeen.push(inputs[0].typeRef);
        return {
          outputs: inputs.map((frame) => ({ ...frame, portId: "out" })),
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  const result = await dualFormatRegistry.invoke({
    pluginId: regularManifest.pluginId,
    methodId: "process",
    inputs: [
      createFrame(1, {
        typeRef: alignedTypeRef,
      }),
    ],
  });

  assert.equal(dualFormatInputsSeen[0].wireFormat, "aligned-binary");
  assert.equal(dualFormatInputsSeen[0].rootTypeName, "StateVector");
  assert.equal(dualFormatInputsSeen[0].byteLength, 64);
  assert.equal(dualFormatInputsSeen[0].requiredAlignment, 16);
  assert.equal(result.outputs[0].typeRef.wireFormat, "aligned-binary");
});

test("artifact dependency normalization uses SDK direct invoke defaults", () => {
  const normalized = normalizeArtifactDependency({
    dependencyId: "dep-runtime",
    pluginId: "com.digitalarsenal.runtime.test",
  });

  assert.deepEqual(normalized.manifestExports, {
    bytesSymbol: DefaultManifestExports.pluginBytesSymbol,
    sizeSymbol: DefaultManifestExports.pluginSizeSymbol,
  });
  assert.deepEqual(normalized.runtimeExports, {
    initSymbol: null,
    destroySymbol: null,
    mallocSymbol: DefaultInvokeExports.allocSymbol,
    freeSymbol: DefaultInvokeExports.freeSymbol,
    streamInvokeSymbol: DefaultInvokeExports.invokeSymbol,
  });
});

test("artifact dependency normalization does not force direct invoke defaults for command-only dependencies", () => {
  const normalized = normalizeArtifactDependency({
    dependencyId: "dep-command",
    pluginId: "com.digitalarsenal.runtime.command",
    invokeSurface: InvokeSurface.COMMAND,
  });

  assert.equal(normalized.invokeSurface, InvokeSurface.COMMAND);
  assert.deepEqual(normalized.invokeSurfaces, [InvokeSurface.COMMAND]);
  assert.deepEqual(normalized.runtimeExports, {
    initSymbol: null,
    destroySymbol: null,
    mallocSymbol: null,
    freeSymbol: null,
    streamInvokeSymbol: null,
  });
});

test("artifact dependency normalization prefers direct when both invoke surfaces are declared", () => {
  const normalized = normalizeArtifactDependency({
    dependencyId: "dep-dual",
    pluginId: "com.digitalarsenal.runtime.dual",
    invokeSurfaces: [InvokeSurface.COMMAND, InvokeSurface.DIRECT],
  });

  assert.equal(normalized.invokeSurface, InvokeSurface.DIRECT);
  assert.deepEqual(normalized.invokeSurfaces, [
    InvokeSurface.COMMAND,
    InvokeSurface.DIRECT,
  ]);
  assert.deepEqual(normalized.runtimeExports, {
    initSymbol: null,
    destroySymbol: null,
    mallocSymbol: DefaultInvokeExports.allocSymbol,
    freeSymbol: DefaultInvokeExports.freeSymbol,
    streamInvokeSymbol: DefaultInvokeExports.invokeSymbol,
  });
});
