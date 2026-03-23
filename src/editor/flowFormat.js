function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function createTabId() {
  return `flow-${Date.now().toString(36)}`;
}

function createNodeId(prefix = "node") {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneEditorValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON normalization.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function createDefaultNodeRedFlows(label = "Flow 1") {
  return [
    {
      id: createTabId(),
      type: "tab",
      label,
      disabled: false,
      info: "",
    },
  ];
}

export function isNodeRedFlowArray(value) {
  return Array.isArray(value) && value.every((entry) => entry && typeof entry === "object");
}

function getNodeRedFlowArray(value) {
  if (isNodeRedFlowArray(value)) {
    return structuredClone(value);
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray(value.flows)
  ) {
    return structuredClone(value.flows);
  }
  return null;
}

function inferNodeRedType(node = {}) {
  if (node.kind === "debug") {
    return "debug";
  }
  if (node.kind === "trigger") {
    return "inject";
  }
  if (node.pluginId === "http" || /http/i.test(node.pluginId ?? "")) {
    return "http request";
  }
  if (node.kind === "responder") {
    return "http response";
  }
  return "function";
}

function getOutputCount(type) {
  if (type === "switch") {
    return 2;
  }
  if (type === "debug" || type === "http response" || type === "comment") {
    return 0;
  }
  return 1;
}

function getEditorNodeState(editorNode = null) {
  if (!editorNode || typeof editorNode !== "object") {
    return {
      type: null,
      position: null,
      config: {},
    };
  }
  return {
    type: normalizeString(editorNode.type, null),
    position: {
      x: Number(editorNode.x ?? 160),
      y: Number(editorNode.y ?? 120),
    },
    config:
      editorNode.config && typeof editorNode.config === "object"
        ? cloneEditorValue(editorNode.config)
        : {},
  };
}

function convertSdnNode(node, tabId, editorNode = null) {
  const editorState = getEditorNodeState(editorNode);
  const type = editorState.type ?? inferNodeRedType(node);
  const base = {
    ...editorState.config,
    id: normalizeString(node.nodeId, createNodeId("node")),
    z: tabId,
    type,
    x: Number(editorState.position?.x ?? 160),
    y: Number(editorState.position?.y ?? 120),
    wires: Array.from({ length: getOutputCount(type) }, () => []),
  };

  if (type === "inject") {
    return {
      name: normalizeString(node.label, ""),
      props: [{ p: "payload" }, { p: "topic", vt: "str" }],
      repeat: "",
      crontab: "",
      once: false,
      onceDelay: 0.1,
      topic: "",
      payload: "",
      payloadType: "date",
      ...base,
    };
  }

  if (type === "debug") {
    return {
      name: normalizeString(node.label, ""),
      active: true,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      align: "right",
      ...base,
    };
  }

  if (type === "http request") {
    return {
      name: normalizeString(node.label, ""),
      method: "GET",
      ret: "txt",
      paytoqs: "ignore",
      url: "",
      tls: "",
      persist: false,
      proxy: "",
      insecureHTTPParser: false,
      authType: "",
      senderr: false,
      headers: [],
      ...base,
    };
  }

  if (type === "http response") {
    return {
      name: normalizeString(node.label, ""),
      statusCode: "",
      headers: {},
      align: "right",
      ...base,
    };
  }

  return {
    name: normalizeString(node.label, ""),
    func:
      typeof node.source === "string" && node.source.trim().length > 0
        ? node.source
        : `return msg;`,
      outputs: 1,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      ...base,
    };
}

export function convertSdnFlowProgramToNodeRedFlows(program = {}) {
  const flowLabel = normalizeString(program.name, "Flow 1");
  const tabId = createTabId();
  const flows = [
    {
      id: tabId,
      type: "tab",
      label: flowLabel,
      disabled: false,
      info: normalizeString(program.description, ""),
    },
  ];

  const nodeMap = new Map();
  const editorNodes =
    program.editor && typeof program.editor === "object" && program.editor.nodes
      ? program.editor.nodes
      : {};

  for (const node of asArray(program.nodes)) {
    const converted = convertSdnNode(node, tabId, editorNodes[node.nodeId]);
    nodeMap.set(node.nodeId, converted);
    flows.push(converted);
  }

  for (const edge of asArray(program.edges)) {
    const fromNode = nodeMap.get(edge.fromNodeId);
    const toNode = nodeMap.get(edge.toNodeId);
    if (!fromNode || !toNode || !Array.isArray(fromNode.wires) || fromNode.wires.length === 0) {
      continue;
    }
    const outputIndex = 0;
    fromNode.wires[outputIndex].push(toNode.id);
  }

  return flows;
}

export function normalizeSdnFlowEditorInitialFlows(value) {
  const directFlows = getNodeRedFlowArray(value);
  if (directFlows) {
    return directFlows.length > 0 ? directFlows : createDefaultNodeRedFlows();
  }

  if (value && typeof value === "object") {
    return convertSdnFlowProgramToNodeRedFlows(value);
  }

  return createDefaultNodeRedFlows();
}

export default {
  convertSdnFlowProgramToNodeRedFlows,
  createDefaultNodeRedFlows,
  isNodeRedFlowArray,
  normalizeSdnFlowEditorInitialFlows,
};
