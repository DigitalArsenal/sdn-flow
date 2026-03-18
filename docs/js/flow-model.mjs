/**
 * flow-model.mjs — Flow data model with CRC-32 and SHA-256 integrity.
 *
 * Mirrors the sdn-flow JSON schema: nodes, edges, triggers, triggerBindings,
 * externalInterfaces, artifactDependencies, and editor layout metadata.
 */

// ── CRC-32 (ISO 3309 / ITU-T V.42) ──

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

export function crc32(bytes) {
  if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function crc32Hex(bytes) {
  return crc32(bytes).toString(16).padStart(8, "0");
}

// ── SHA-256 ──

export async function sha256(bytes) {
  if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is not available in this runtime.");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Canonical JSON ──

export function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return JSON.stringify({ __type: "bytes", base64: btoa(String.fromCharCode(...value)) });
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}

// ── Kind colors ──

export const KIND_COLORS = {
  trigger:   "#c586c0",
  transform: "#569cd6",
  analyzer:  "#4ec9b0",
  publisher: "#ce9178",
  responder: "#dcdcaa",
  renderer:  "#d16969",
  sink:      "#d7ba7d",
  debug:     "#f07178",
};

// ── Default ports per kind ──

const DEFAULT_PORTS = {
  trigger:   { inputs: [],                      outputs: [{ id: "out", label: "out" }] },
  transform: { inputs: [{ id: "in", label: "in" }], outputs: [{ id: "out", label: "out" }] },
  analyzer:  { inputs: [{ id: "in", label: "in" }], outputs: [{ id: "out", label: "out" }, { id: "metrics", label: "metrics" }] },
  publisher: { inputs: [{ id: "in", label: "in" }], outputs: [] },
  responder: { inputs: [{ id: "req", label: "req" }], outputs: [{ id: "res", label: "res" }] },
  renderer:  { inputs: [{ id: "in", label: "in" }], outputs: [] },
  sink:      { inputs: [{ id: "in", label: "in" }], outputs: [] },
  debug:     { inputs: [{ id: "in", label: "msg" }], outputs: [] },
};

const DEFAULT_CONFIGS = {
  debug: {
    target: "sidebar",
    path: "payload",
    includeCompleteMessage: false,
  },
};

// ── ID generation ──

let _idCounter = 0;
function genId(prefix = "n") {
  return `${prefix}-${Date.now().toString(36)}-${(++_idCounter).toString(36)}`;
}

// ── FlowModel ──

export class FlowModel extends EventTarget {
  constructor() {
    super();
    this.programId = "";
    this.name = "Untitled Flow";
    this.version = "0.1.0";
    this.description = "";
    this.nodes = new Map();
    this.edges = new Map();
    this.triggers = new Map();
    this.triggerBindings = [];
    this.externalInterfaces = [];
    this.artifactDependencies = [];
    this.requiredPlugins = [];
    this.editorMeta = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} };
  }

  // ── Nodes ──

  addNode({ kind, pluginId, methodId, label, lang, x, y, source, ports, config }) {
    const nodeId = genId("node");
    const defaultPorts = DEFAULT_PORTS[kind] || DEFAULT_PORTS.transform;
    const node = {
      nodeId,
      pluginId: pluginId || "",
      methodId: methodId || "",
      kind,
      label: label || `${kind}-${nodeId.slice(-4)}`,
      drainPolicy: "drain-until-yield",
      lang: lang || null,
      source: source || this._defaultSource(kind, lang),
      ports: ports || {
        inputs: defaultPorts.inputs.map(p => ({ ...p })),
        outputs: defaultPorts.outputs.map(p => ({ ...p })),
      },
      config: this._createDefaultConfig(kind, config),
    };
    this.nodes.set(nodeId, node);
    this.editorMeta.nodes[nodeId] = { x: x || 200, y: y || 200 };
    this._emit("node-add", { node });
    return node;
  }

  updateNode(nodeId, changes) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    Object.assign(node, changes);
    this._emit("node-update", { node });
  }

  removeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // Remove connected edges
    for (const [edgeId, edge] of this.edges) {
      if (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) {
        this.edges.delete(edgeId);
        this._emit("edge-remove", { edgeId });
      }
    }
    // Remove trigger bindings
    this.triggerBindings = this.triggerBindings.filter(b => b.targetNodeId !== nodeId);
    this.nodes.delete(nodeId);
    delete this.editorMeta.nodes[nodeId];
    this._emit("node-remove", { nodeId });
  }

  moveNode(nodeId, x, y) {
    if (this.editorMeta.nodes[nodeId]) {
      this.editorMeta.nodes[nodeId].x = x;
      this.editorMeta.nodes[nodeId].y = y;
      this._emit("node-move", { nodeId, x, y });
    }
  }

  addPort(nodeId, direction, portId, label) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const list = direction === "input" ? node.ports.inputs : node.ports.outputs;
    if (!list.find(p => p.id === portId)) {
      list.push({ id: portId, label: label || portId });
      this._emit("node-update", { node });
    }
  }

  removePort(nodeId, direction, portId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const list = direction === "input" ? node.ports.inputs : node.ports.outputs;
    const idx = list.findIndex(p => p.id === portId);
    if (idx >= 0) {
      list.splice(idx, 1);
      // Remove connected edges
      for (const [edgeId, edge] of this.edges) {
        if ((direction === "input" && edge.toNodeId === nodeId && edge.toPortId === portId) ||
            (direction === "output" && edge.fromNodeId === nodeId && edge.fromPortId === portId)) {
          this.edges.delete(edgeId);
          this._emit("edge-remove", { edgeId });
        }
      }
      this._emit("node-update", { node });
    }
  }

  // ── Edges ──

  addEdge({ fromNodeId, fromPortId, toNodeId, toPortId, backpressurePolicy, queueDepth }) {
    // Prevent duplicate edges
    for (const edge of this.edges.values()) {
      if (edge.fromNodeId === fromNodeId && edge.fromPortId === fromPortId &&
          edge.toNodeId === toNodeId && edge.toPortId === toPortId) return edge;
    }
    const edgeId = genId("edge");
    const edge = {
      edgeId, fromNodeId, fromPortId, toNodeId, toPortId,
      backpressurePolicy: backpressurePolicy || "queue",
      queueDepth: queueDepth || 32,
    };
    this.edges.set(edgeId, edge);
    this._emit("edge-add", { edge });
    return edge;
  }

  removeEdge(edgeId) {
    if (this.edges.delete(edgeId)) {
      this._emit("edge-remove", { edgeId });
    }
  }

  // ── Serialization ──

  toJSON() {
    return {
      programId: this.programId,
      name: this.name,
      version: this.version,
      description: this.description,
      nodes: [...this.nodes.values()].map(n => ({
        nodeId: n.nodeId,
        pluginId: n.pluginId,
        methodId: n.methodId,
        kind: n.kind,
        drainPolicy: n.drainPolicy,
        label: n.label,
        lang: n.lang,
        source: n.source,
        ports: n.ports,
        config: n.config,
      })),
      edges: [...this.edges.values()].map(e => ({
        edgeId: e.edgeId,
        fromNodeId: e.fromNodeId,
        fromPortId: e.fromPortId,
        toNodeId: e.toNodeId,
        toPortId: e.toPortId,
        backpressurePolicy: e.backpressurePolicy,
        queueDepth: e.queueDepth,
      })),
      triggers: [...this.triggers.values()],
      triggerBindings: this.triggerBindings,
      externalInterfaces: this.externalInterfaces,
      artifactDependencies: this.artifactDependencies,
      requiredPlugins: this.requiredPlugins,
      editor: this.editorMeta,
    };
  }

  fromJSON(json) {
    this.clear();
    this.programId = json.programId || "";
    this.name = json.name || "Untitled";
    this.version = json.version || "0.1.0";
    this.description = json.description || "";
    if (json.editor) {
      this.editorMeta = JSON.parse(JSON.stringify(json.editor));
    }
    for (const n of (json.nodes || [])) {
      const node = {
        nodeId: n.nodeId,
        pluginId: n.pluginId || "",
        methodId: n.methodId || "",
        kind: n.kind || "transform",
        label: n.label || n.nodeId,
        drainPolicy: n.drainPolicy || "drain-until-yield",
        lang: n.lang || null,
        source: n.source || "",
        ports: n.ports || (DEFAULT_PORTS[n.kind] || DEFAULT_PORTS.transform),
        config: this._createDefaultConfig(n.kind || "transform", n.config),
      };
      this.nodes.set(node.nodeId, node);
      if (!this.editorMeta.nodes[node.nodeId]) {
        this.editorMeta.nodes[node.nodeId] = { x: 200, y: 200 };
      }
    }
    for (const e of (json.edges || [])) {
      this.edges.set(e.edgeId, { ...e });
    }
    for (const t of (json.triggers || [])) {
      this.triggers.set(t.triggerId, { ...t });
    }
    this.triggerBindings = (json.triggerBindings || []).map(b => ({ ...b }));
    this.externalInterfaces = (json.externalInterfaces || []).map(i => ({ ...i }));
    this.artifactDependencies = (json.artifactDependencies || []).map(d => ({ ...d }));
    this.requiredPlugins = [...(json.requiredPlugins || [])];
    this._emit("load");
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.triggers.clear();
    this.triggerBindings = [];
    this.externalInterfaces = [];
    this.artifactDependencies = [];
    this.requiredPlugins = [];
    this.editorMeta = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} };
    this._emit("clear");
  }

  // ── Integrity ──

  computeCRC() {
    const json = this.toJSON();
    delete json.editor; // editor layout doesn't affect integrity
    return crc32Hex(canonicalBytes(json));
  }

  async computeSHA256() {
    const json = this.toJSON();
    delete json.editor;
    return sha256(canonicalBytes(json));
  }

  // ── Default source templates ──

  _defaultSource(kind, lang) {
    if (!lang) return "";
    const templates = {
      cpp: `#include <cstdint>
#include <cstring>

// sdn-flow plugin method
// Input frames arrive as FlatBuffer byte spans.
// Return 0 on success.

extern "C" int process(const uint8_t* input, uint32_t input_len,
                        uint8_t* output, uint32_t* output_len) {
    // TODO: implement
    *output_len = 0;
    return 0;
}
`,
      python: `"""sdn-flow plugin method (Pyodide/pybind11)"""

def process(input_bytes: bytes) -> bytes:
    """Process a FlatBuffer frame and return the output frame."""
    # TODO: implement
    return b""
`,
      rust: `//! sdn-flow plugin method

#[no_mangle]
pub extern "C" fn process(
    input: *const u8, input_len: u32,
    output: *mut u8, output_len: *mut u32,
) -> i32 {
    // TODO: implement
    unsafe { *output_len = 0; }
    0
}
`,
      typescript: `// sdn-flow plugin method

export function process(input: Uint8Array): Uint8Array {
  // TODO: implement
  return new Uint8Array(0);
}
`,
    };
    return templates[lang] || "";
  }

  _createDefaultConfig(kind, config) {
    const defaultConfig = DEFAULT_CONFIGS[kind] || {};
    return {
      ...JSON.parse(JSON.stringify(defaultConfig)),
      ...(config && typeof config === "object" ? JSON.parse(JSON.stringify(config)) : {}),
    };
  }

  // ── Events ──

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    this.dispatchEvent(new CustomEvent("change", { detail: { type, ...detail } }));
  }
}
