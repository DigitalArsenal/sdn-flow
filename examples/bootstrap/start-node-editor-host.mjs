import { startSdnFlowEditorNodeHost } from "../../src/editor/index.js";

export function createEditorBootstrapFlow() {
  return {
    programId: "com.digitalarsenal.examples.editor.bootstrap",
    name: "Editor Bootstrap Flow",
    version: "0.1.0",
    description: "Small example graph for the hosted editor runtime.",
    nodes: [
      {
        nodeId: "tick",
        pluginId: "",
        methodId: "",
        kind: "trigger",
        drainPolicy: "drain-until-yield",
        label: "Tick",
        ports: {
          inputs: [],
          outputs: [{ id: "out", label: "out" }],
        },
      },
      {
        nodeId: "debug",
        pluginId: "",
        methodId: "",
        kind: "debug",
        drainPolicy: "drain-until-yield",
        label: "Debug Sidebar",
        config: {
          target: "sidebar",
          path: "payload",
          includeCompleteMessage: true,
        },
        ports: {
          inputs: [{ id: "in", label: "msg" }],
          outputs: [],
        },
      },
    ],
    edges: [
      {
        edgeId: "tick-debug",
        fromNodeId: "tick",
        fromPortId: "out",
        toNodeId: "debug",
        toPortId: "in",
        backpressurePolicy: "latest",
        queueDepth: 1,
      },
    ],
    editor: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {
        tick: { x: 120, y: 220 },
        debug: { x: 420, y: 220 },
      },
    },
  };
}

export async function startNodeEditorBootstrapExample(options = {}) {
  const startEditorHost =
    options.startEditorHost ?? startSdnFlowEditorNodeHost;
  return startEditorHost({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 9082,
    basePath: options.basePath ?? "/editor",
    title: options.title ?? "sdn-flow Editor",
    initialFlow: options.initialFlow ?? createEditorBootstrapFlow(),
  });
}
