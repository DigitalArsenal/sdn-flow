/**
 * app.mjs — Main application orchestrator for the sdn-flow hosted editor.
 */

import { FlowModel, canonicalBytes } from "./flow-model.mjs";
import { FlowCanvas } from "./flow-canvas.mjs";
import { EditorPanel } from "./editor-panel.mjs";

const vscode =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

const model = new FlowModel();
const svg = document.getElementById("flow-canvas");
const canvas = new FlowCanvas(svg, model);
const editorPanel = new EditorPanel("editor-container", "editor-lang");

const propsBody = document.getElementById("props-body");
const debugListEl = document.getElementById("debug-list");
const debugDetailEl = document.getElementById("debug-detail");
const debugCountEl = document.getElementById("debug-count");
const workspaceNameEl = document.getElementById("workspace-name");
const workspaceProgramIdEl = document.getElementById("workspace-program-id");
const workspaceEngineBadgeEl = document.getElementById("workspace-engine-badge");
const workspaceDebugSummaryEl = document.getElementById("workspace-debug-summary");

let bootstrapConfig = null;
let selectedDebugEntryId = null;
let activeSidebarView = "inspector";
let activeDebugNodeId = null;
let debugCounter = 0;

const debugEntries = [];

function safeStringify(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewValue(value) {
  const text = safeStringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setSidebarView(view) {
  activeSidebarView = view;
  document.querySelectorAll(".sidebar-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.sidebarView === view);
  });
  document.querySelectorAll(".sidebar-view").forEach((section) => {
    section.classList.toggle("active", section.dataset.sidebarView === view);
  });
}

function updateCounts() {
  document.getElementById("node-count").textContent = `${model.nodes.size} nodes`;
  document.getElementById("edge-count").textContent = `${model.edges.size} wires`;
  workspaceNameEl.textContent = model.name || "Untitled Flow";
  workspaceProgramIdEl.textContent = model.programId || "No program ID";
  workspaceDebugSummaryEl.textContent = `${debugEntries.length} debug ${debugEntries.length === 1 ? "entry" : "entries"}`;
}

function setStatus(message, type = "") {
  const bar = document.getElementById("statusbar");
  document.getElementById("status-msg").textContent = message;
  bar.className = type;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

function createDebugEntry(text, level = "info", options = {}) {
  const entry = {
    debugEntryId: `dbg-${Date.now().toString(36)}-${++debugCounter}`,
    level,
    title: typeof text === "string" ? text : "Debug event",
    payload: options.payload ?? null,
    preview:
      options.preview ??
      previewValue(options.payload !== undefined ? options.payload : text),
    source: options.source ?? "editor",
    nodeId: options.nodeId ?? null,
    debugNodeId: options.debugNodeId ?? null,
    timestamp: options.timestamp ?? Date.now(),
  };
  debugEntries.unshift(entry);
  if (!selectedDebugEntryId) {
    selectedDebugEntryId = entry.debugEntryId;
  }
  renderDebugEntries();
  updateCounts();
  return entry;
}

function renderDebugEntries() {
  const visibleEntries = activeDebugNodeId
    ? debugEntries.filter(
        (entry) =>
          entry.debugNodeId === activeDebugNodeId ||
          entry.nodeId === activeDebugNodeId,
      )
    : debugEntries;

  debugCountEl.textContent = `${visibleEntries.length} ${visibleEntries.length === 1 ? "entry" : "entries"}`;

  if (visibleEntries.length === 0) {
    debugListEl.innerHTML =
      '<div class="empty-state">No debug output for the current selection.</div>';
    debugDetailEl.innerHTML =
      '<div class="empty-state">Select a debug entry to inspect its payload.</div>';
    return;
  }

  if (!visibleEntries.some((entry) => entry.debugEntryId === selectedDebugEntryId)) {
    selectedDebugEntryId = visibleEntries[0].debugEntryId;
  }

  debugListEl.innerHTML = visibleEntries
    .map(
      (entry) => `
        <article class="debug-entry ${entry.debugEntryId === selectedDebugEntryId ? "active" : ""}" data-debug-entry-id="${entry.debugEntryId}">
          <div class="debug-entry-topline">
            <span class="debug-entry-title">${esc(entry.title)}</span>
            <span class="debug-level debug-level-${esc(entry.level)}">${esc(entry.level)}</span>
          </div>
          <div class="debug-entry-meta">
            <span>${esc(entry.source)}</span>
            <span>${formatTime(entry.timestamp)}</span>
          </div>
          <div class="debug-entry-preview">${esc(entry.preview)}</div>
        </article>
      `,
    )
    .join("");

  debugListEl.querySelectorAll(".debug-entry").forEach((element) => {
    element.addEventListener("click", () => {
      selectedDebugEntryId = element.dataset.debugEntryId;
      renderDebugEntries();
    });
  });

  const activeEntry = visibleEntries.find(
    (entry) => entry.debugEntryId === selectedDebugEntryId,
  );
  renderDebugDetail(activeEntry ?? visibleEntries[0]);
}

function renderDebugDetail(entry) {
  if (!entry) {
    debugDetailEl.innerHTML =
      '<div class="empty-state">Select a debug entry to inspect its payload.</div>';
    return;
  }

  const payloadText =
    entry.payload === null || entry.payload === undefined
      ? "No payload"
      : safeStringify(entry.payload);

  debugDetailEl.innerHTML = `
    <div class="debug-detail-shell">
      <div class="debug-detail-header">
        <div class="debug-detail-title">${esc(entry.title)}</div>
        <div class="debug-entry-meta">
          <span>${esc(entry.source)}</span>
          <span>${formatTime(entry.timestamp)}</span>
          <span class="debug-level debug-level-${esc(entry.level)}">${esc(entry.level)}</span>
        </div>
        <div class="debug-detail-copy">${
          activeDebugNodeId
            ? `Filtered to debug node ${esc(activeDebugNodeId)}.`
            : "Structured event payload"
        }</div>
      </div>
      <pre>${esc(payloadText)}</pre>
    </div>
  `;
}

function termLog(text, level = "info", options = {}) {
  createDebugEntry(text, level, options);
}

function termClear() {
  debugEntries.splice(0, debugEntries.length);
  selectedDebugEntryId = null;
  renderDebugEntries();
  updateCounts();
}

function workerRPC(worker) {
  let idCounter = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    if (data.log !== undefined) {
      termLog(data.log, data.level || "info", {
        source: "compiler",
      });
      return;
    }
    const { id, result, error } = data;
    const pendingRequest = pending.get(id);
    if (!pendingRequest) {
      return;
    }
    pending.delete(id);
    if (error) {
      pendingRequest.reject(new Error(error));
      return;
    }
    pendingRequest.resolve(result);
  };
  return (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++idCounter;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
}

function getDefaultPortsForKind(kind) {
  const map = {
    trigger: { inputs: [], outputs: [{ id: "out", label: "out" }] },
    transform: {
      inputs: [{ id: "in", label: "in" }],
      outputs: [{ id: "out", label: "out" }],
    },
    analyzer: {
      inputs: [{ id: "in", label: "in" }],
      outputs: [
        { id: "out", label: "out" },
        { id: "metrics", label: "metrics" },
      ],
    },
    publisher: { inputs: [{ id: "in", label: "in" }], outputs: [] },
    responder: {
      inputs: [{ id: "req", label: "req" }],
      outputs: [{ id: "res", label: "res" }],
    },
    renderer: { inputs: [{ id: "in", label: "in" }], outputs: [] },
    sink: { inputs: [{ id: "in", label: "in" }], outputs: [] },
    debug: { inputs: [{ id: "in", label: "msg" }], outputs: [] },
  };
  const selected = map[kind] || map.transform;
  return {
    inputs: selected.inputs.map((port) => ({ ...port })),
    outputs: selected.outputs.map((port) => ({ ...port })),
  };
}

function getDefaultConfigForKind(kind) {
  if (kind === "debug") {
    return {
      target: "sidebar",
      path: "payload",
      includeCompleteMessage: false,
    };
  }
  return {};
}

function updateNodeConfig(nodeId, changes) {
  const node = model.nodes.get(nodeId);
  if (!node) {
    return;
  }
  model.updateNode(nodeId, {
    config: {
      ...(node.config || {}),
      ...changes,
    },
  });
}

function publishToDebugNodes(eventTitle, payload, options = {}) {
  const debugNodes = [...model.nodes.values()].filter((node) => node.kind === "debug");
  for (const debugNode of debugNodes) {
    const target = debugNode.config?.target ?? "sidebar";
    if (target !== "sidebar" && target !== "both") {
      continue;
    }
    termLog(`${debugNode.label || "Debug"} captured ${eventTitle}`, options.level || "info", {
      source: debugNode.label || "debug",
      payload,
      preview: previewValue(payload),
      nodeId: options.nodeId ?? null,
      debugNodeId: debugNode.nodeId,
    });
  }
}

function renderProps(nodeId) {
  if (!nodeId) {
    propsBody.innerHTML =
      '<div class="empty-state">Select a node or wire to inspect.</div>';
    return;
  }

  const node = model.nodes.get(nodeId);
  if (!node) {
    return;
  }

  const isDebugNode = node.kind === "debug";
  const debugConfig = node.config || {};

  propsBody.innerHTML = `
    <div class="prop-group">
      <label class="prop-label">Label</label>
      <input class="prop-input" data-field="label" value="${esc(node.label)}">
    </div>
    <div class="prop-group">
      <label class="prop-label">Kind</label>
      <select class="prop-select" data-field="kind">
        ${[
          "trigger",
          "transform",
          "analyzer",
          "publisher",
          "responder",
          "renderer",
          "sink",
          "debug",
        ]
          .map(
            (kind) =>
              `<option value="${kind}" ${kind === node.kind ? "selected" : ""}>${kind}</option>`,
          )
          .join("")}
      </select>
    </div>
    <div class="prop-group">
      <label class="prop-label">Plugin ID</label>
      <input class="prop-input" data-field="pluginId" value="${esc(node.pluginId)}" placeholder="com.example.plugin">
    </div>
    <div class="prop-group">
      <label class="prop-label">Method ID</label>
      <input class="prop-input" data-field="methodId" value="${esc(node.methodId)}" placeholder="process">
    </div>
    <div class="prop-group">
      <label class="prop-label">Drain Policy</label>
      <select class="prop-select" data-field="drainPolicy">
        ${["single-shot", "drain-until-yield", "drain-to-empty"]
          .map(
            (policy) =>
              `<option value="${policy}" ${policy === node.drainPolicy ? "selected" : ""}>${policy}</option>`,
          )
          .join("")}
      </select>
    </div>
    <div class="prop-group">
      <label class="prop-label">Language</label>
      <select class="prop-select" data-field="lang">
        <option value="">None</option>
        ${["cpp", "python", "typescript", "javascript", "rust", "go", "c"]
          .map(
            (lang) =>
              `<option value="${lang}" ${lang === node.lang ? "selected" : ""}>${lang}</option>`,
          )
          .join("")}
      </select>
    </div>
    ${
      isDebugNode
        ? `
          <div class="prop-group">
            <label class="prop-label">Debug Target</label>
            <select class="prop-select" data-config-field="target">
              ${["sidebar", "console", "both"]
                .map(
                  (target) =>
                    `<option value="${target}" ${target === debugConfig.target ? "selected" : ""}>${target}</option>`,
                )
                .join("")}
            </select>
          </div>
          <div class="prop-group">
            <label class="prop-label">Debug Path</label>
            <input class="prop-input" data-config-field="path" value="${esc(debugConfig.path || "payload")}" placeholder="payload">
          </div>
          <div class="prop-group">
            <label class="prop-label">Capture Entire Message</label>
            <select class="prop-select" data-config-field="includeCompleteMessage">
              <option value="false" ${debugConfig.includeCompleteMessage ? "" : "selected"}>false</option>
              <option value="true" ${debugConfig.includeCompleteMessage ? "selected" : ""}>true</option>
            </select>
          </div>
        `
        : ""
    }
    <div class="prop-group">
      <label class="prop-label">Input Ports</label>
      <div class="port-list" data-dir="input">
        ${(node.ports?.inputs || [])
          .map(
            (port) => `
              <div class="port-row">
                <input class="prop-input port-name" value="${esc(port.id)}" data-port-id="${esc(port.id)}" placeholder="port id">
                <button class="icon-btn remove-port" data-port-id="${esc(port.id)}" type="button">-</button>
              </div>
            `,
          )
          .join("")}
        <button class="palette-btn add-port" data-dir="input" type="button">+ Add Input</button>
      </div>
    </div>
    <div class="prop-group">
      <label class="prop-label">Output Ports</label>
      <div class="port-list" data-dir="output">
        ${(node.ports?.outputs || [])
          .map(
            (port) => `
              <div class="port-row">
                <input class="prop-input port-name" value="${esc(port.id)}" data-port-id="${esc(port.id)}" placeholder="port id">
                <button class="icon-btn remove-port" data-port-id="${esc(port.id)}" type="button">-</button>
              </div>
            `,
          )
          .join("")}
        <button class="palette-btn add-port" data-dir="output" type="button">+ Add Output</button>
      </div>
    </div>
  `;

  propsBody
    .querySelectorAll(".prop-input[data-field], .prop-select[data-field]")
    .forEach((element) => {
      element.addEventListener("change", () => {
        if (element.dataset.field === "kind") {
          const nextKind = element.value || "transform";
          model.updateNode(nodeId, {
            kind: nextKind,
            ports: getDefaultPortsForKind(nextKind),
            config: getDefaultConfigForKind(nextKind),
          });
          renderProps(nodeId);
          if (nextKind === "debug") {
            activeDebugNodeId = nodeId;
            setSidebarView("debug");
            renderDebugEntries();
          }
          return;
        }
        model.updateNode(nodeId, {
          [element.dataset.field]: element.value || null,
        });
        if (element.dataset.field === "lang") {
          editorPanel.setNode(nodeId);
        }
      });
    });

  propsBody.querySelectorAll("[data-config-field]").forEach((element) => {
    element.addEventListener("change", () => {
      const value =
        element.dataset.configField === "includeCompleteMessage"
          ? element.value === "true"
          : element.value;
      updateNodeConfig(nodeId, {
        [element.dataset.configField]: value,
      });
    });
  });

  propsBody.querySelectorAll(".add-port").forEach((button) => {
    button.addEventListener("click", () => {
      const portId = prompt("Port ID:", `port-${Date.now().toString(36)}`);
      if (!portId) {
        return;
      }
      model.addPort(nodeId, button.dataset.dir, portId, portId);
      renderProps(nodeId);
    });
  });

  propsBody.querySelectorAll(".remove-port").forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.closest(".port-list").dataset.dir;
      model.removePort(nodeId, direction, button.dataset.portId);
      renderProps(nodeId);
    });
  });
}

canvas.onNodeSelect((nodeId) => {
  renderProps(nodeId);
  updateGeneratedSource();
  const node = nodeId ? model.nodes.get(nodeId) : null;
  if (node?.kind === "debug") {
    activeDebugNodeId = nodeId;
    setSidebarView("debug");
  } else {
    activeDebugNodeId = null;
  }
  renderDebugEntries();
});

canvas.onNodeDblClick(async (nodeId) => {
  const node = model.nodes.get(nodeId);
  if (!node) {
    return;
  }
  if (!node.pluginId) {
    termLog(`Node ${node.label}: no pluginId set, cannot load metadata.`, "warn", {
      source: node.label,
      nodeId,
    });
    return;
  }

  termLog(`Loading metadata for ${node.pluginId}`, "info", {
    source: node.label,
    nodeId,
  });

  const manifests = [
    `../examples/plugins/${node.pluginId.split(".").pop()}/manifest.json`,
    `../examples/plugins/${node.methodId}/manifest.json`,
  ];
  let found = false;
  for (const url of manifests) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const manifest = await response.json();
      if (manifest.methods) {
        const methods = Array.isArray(manifest.methods)
          ? manifest.methods
          : Object.values(manifest.methods);
        const method =
          methods.find((candidate) => candidate.methodId === node.methodId) ||
          methods[0];
        if (method) {
          const ports = { inputs: [], outputs: [] };
          if (Array.isArray(method.inputs)) {
            method.inputs.forEach((port) => {
              ports.inputs.push({
                id: port.portId || port.id,
                label: port.label || port.portId || port.id,
              });
            });
          }
          if (Array.isArray(method.outputs)) {
            method.outputs.forEach((port) => {
              ports.outputs.push({
                id: port.portId || port.id,
                label: port.label || port.portId || port.id,
              });
            });
          }
          if (ports.inputs.length > 0 || ports.outputs.length > 0) {
            model.updateNode(nodeId, { ports });
          }
        }
      }
      termLog(`Loaded manifest for ${manifest.pluginId || node.pluginId}`, "success", {
        source: node.label,
        nodeId,
        payload: manifest,
      });
      publishToDebugNodes("manifest load", manifest, {
        level: "success",
        nodeId,
      });
      found = true;
      break;
    } catch {}
  }

  if (!found) {
    termLog(`No local manifest found for ${node.pluginId}`, "warn", {
      source: node.label,
      nodeId,
      payload: {
        pluginId: node.pluginId,
        methodId: node.methodId,
        kind: node.kind,
        drainPolicy: node.drainPolicy,
      },
    });
  }
  renderProps(nodeId);
});

canvas.onEdgeSelect((edgeId) => {
  activeDebugNodeId = null;
  renderDebugEntries();
  if (!edgeId) {
    renderProps(null);
    return;
  }
  const edge = model.edges.get(edgeId);
  if (!edge) {
    return;
  }
  propsBody.innerHTML = `
    <div class="prop-group"><label class="prop-label">Edge</label><div>${esc(edge.edgeId)}</div></div>
    <div class="prop-group"><label class="prop-label">From</label><div>${esc(edge.fromNodeId)}:${esc(edge.fromPortId)}</div></div>
    <div class="prop-group"><label class="prop-label">To</label><div>${esc(edge.toNodeId)}:${esc(edge.toPortId)}</div></div>
    <div class="prop-group">
      <label class="prop-label">Backpressure</label>
      <select class="prop-select" id="edge-bp">
        ${[
          "drop",
          "latest",
          "queue",
          "block-request",
          "coalesce",
          "drain-to-empty",
        ]
          .map(
            (policy) =>
              `<option value="${policy}" ${policy === edge.backpressurePolicy ? "selected" : ""}>${policy}</option>`,
          )
          .join("")}
      </select>
    </div>
    <div class="prop-group">
      <label class="prop-label">Queue Depth</label>
      <input class="prop-input" id="edge-qd" type="number" value="${edge.queueDepth}">
    </div>
  `;
  document.getElementById("edge-bp")?.addEventListener("change", (event) => {
    edge.backpressurePolicy = event.target.value;
  });
  document.getElementById("edge-qd")?.addEventListener("change", (event) => {
    edge.queueDepth = Number.parseInt(event.target.value, 10) || 32;
  });
});

model.addEventListener("change", () => {
  const crc = model.computeCRC();
  document.getElementById("crc-badge").textContent = crc;
  updateCounts();
  updateGeneratedSource();
});

function updateGeneratedSource() {
  const json = model.toJSON();
  const nodes = json.nodes || [];
  const edges = json.edges || [];
  const triggers = json.triggers || [];
  const debugNodes = nodes.filter((node) => node.kind === "debug");

  const includes = [
    "#include <cstdint>",
    '#include "flatbuffers/flatbuffers.h"',
    "",
    `// Generated flow: ${json.name || "Untitled"}`,
    `// Program ID: ${json.programId || "(none)"}`,
    `// Nodes: ${nodes.length}  Edges: ${edges.length}  Triggers: ${triggers.length}`,
    `// Debug taps: ${debugNodes.length}`,
    `// CRC-32: ${model.computeCRC()}`,
    "",
  ];

  const manifest = [
    "static const uint8_t FLOW_MANIFEST[] = { /* built at compile time */ };",
    "static const uint32_t FLOW_MANIFEST_SIZE = sizeof(FLOW_MANIFEST);",
    "extern \"C\" const uint8_t* flow_get_manifest_flatbuffer() { return FLOW_MANIFEST; }",
    "extern \"C\" uint32_t flow_get_manifest_flatbuffer_size() { return FLOW_MANIFEST_SIZE; }",
    "",
  ];

  const topology = edges.length
    ? [
        "// Topology",
        ...edges.map(
          (edge) =>
            `// ${edge.fromNodeId}:${edge.fromPortId} -> ${edge.toNodeId}:${edge.toPortId} [${edge.backpressurePolicy}, depth=${edge.queueDepth}]`,
        ),
        "",
      ]
    : [];

  const debugSection = debugNodes.length
    ? [
        "// Debug taps",
        ...debugNodes.map(
          (node) =>
            `// ${node.label}: target=${node.config?.target || "sidebar"} path=${node.config?.path || "payload"} includeCompleteMessage=${node.config?.includeCompleteMessage ? "true" : "false"}`,
        ),
        "",
      ]
    : [];

  const entrypoints = [
    "extern \"C\" int flow_init() {",
    ...nodes.map((node) => `  // init ${node.nodeId} (${node.kind})`),
    "  return 0;",
    "}",
    "",
    "extern \"C\" int flow_step(const uint8_t* frame, uint32_t len) {",
    "  // dispatch one frame through the compiled topology",
    "  return 0;",
    "}",
  ];

  editorPanel.setGeneratedSource(
    [...includes, ...manifest, ...topology, ...debugSection, ...entrypoints].join("\n"),
    "cpp",
  );
}

document.querySelectorAll(".palette-item[draggable]").forEach((item) => {
  item.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/x-sdn-kind", item.dataset.kind);
    event.dataTransfer.setData("text/x-sdn-lang", item.dataset.lang || "");
    event.dataTransfer.effectAllowed = "copy";
  });
});

document.getElementById("palette-search")?.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll(".palette-item, .palette-btn").forEach((element) => {
    if (!query) {
      element.style.display = "";
      return;
    }
    const haystack = `${element.textContent || ""} ${element.dataset.kind || ""} ${
      element.dataset.lang || ""
    }`.toLowerCase();
    element.style.display = haystack.includes(query) ? "" : "none";
  });
});

document.querySelectorAll(".sidebar-tab").forEach((button) => {
  button.addEventListener("click", () => {
    setSidebarView(button.dataset.sidebarView);
  });
});

document.getElementById("btn-import").addEventListener("click", async () => {
  if (vscode) {
    vscode.postMessage({ command: "importFlow" });
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    try {
      const json = JSON.parse(await file.text());
      model.fromJSON(json);
      termLog(`Imported ${json.name || file.name}`, "success", {
        source: "workspace",
        payload: json,
      });
      setStatus(`Loaded ${json.name || file.name}`, "success");
    } catch (error) {
      termLog(`Import failed: ${error.message}`, "error", {
        source: "workspace",
      });
      setStatus("Import failed", "error");
    }
  };
  input.click();
});

document.getElementById("btn-export").addEventListener("click", async () => {
  try {
    const json = model.toJSON();
    const text = JSON.stringify(json, null, 2);

    if (bootstrapConfig?.api?.exportUrl) {
      const response = await fetch(bootstrapConfig.api.exportUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: text,
      });
      if (!response.ok) {
        throw new Error(`Export endpoint returned ${response.status}`);
      }
      termLog(`Exported ${json.name || "flow"} to embedded host`, "success", {
        source: "workspace",
        payload: json,
      });
      return;
    }

    if (vscode) {
      vscode.postMessage({ command: "exportFlow", data: text });
      return;
    }

    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${json.name || "flow"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    termLog(`Exported ${anchor.download}`, "success", {
      source: "workspace",
      payload: json,
    });
  } catch (error) {
    termLog(`Export failed: ${error.message}`, "error", {
      source: "workspace",
    });
    setStatus("Export failed", "error");
  }
});

document.getElementById("btn-crc").addEventListener("click", async () => {
  const crc = model.computeCRC();
  const sha = await model.computeSHA256();
  termLog(`Computed flow integrity`, "info", {
    source: "runtime",
    payload: {
      crc32: crc,
      sha256: sha,
    },
  });
  publishToDebugNodes(
    "integrity snapshot",
    {
      crc32: crc,
      sha256: sha,
    },
    {
      level: "info",
    },
  );
  setStatus(`CRC ${crc}`);
});

let emceptionWorker = null;
let emceptionRPC = null;
let emceptionReady = false;
let pyodideWorker = null;
let pyodideRPC = null;
let pyodideReady = false;

const WORKER_BASE = new URL("./workers/", import.meta.url).href;
const EMCEPTION_BASE =
  new URLSearchParams(location.search).get("emception") ||
  "https://digitalarsenal.github.io/emception/";

async function ensureEmception() {
  if (emceptionReady) {
    return;
  }
  if (!emceptionWorker) {
    emceptionWorker = new Worker(`${WORKER_BASE}emception.worker.js`);
    emceptionRPC = workerRPC(emceptionWorker);
  }
  setStatus("Loading emception...");
  await emceptionRPC("init", { baseUrl: EMCEPTION_BASE });
  emceptionReady = true;
  setStatus("Emception ready", "success");
}

async function ensurePyodide() {
  if (pyodideReady) {
    return;
  }
  if (!pyodideWorker) {
    pyodideWorker = new Worker(`${WORKER_BASE}pyodide.worker.js`);
    pyodideRPC = workerRPC(pyodideWorker);
  }
  setStatus("Loading Pyodide...");
  await pyodideRPC("init");
  pyodideReady = true;
  setStatus("Pyodide ready", "success");
}

async function runCompilePipeline() {
  const nodes = [...model.nodes.values()];
  const cppNodes = nodes.filter((node) => node.lang === "cpp" || node.lang === "c");
  const pythonNodes = nodes.filter((node) => node.lang === "python");

  if (cppNodes.length === 0 && pythonNodes.length === 0) {
    termLog("No compilable nodes found. Add C/C++ or Python module nodes.", "warn", {
      source: "compiler",
    });
    return null;
  }

  termLog("Compile started", "info", {
    source: "compiler",
    payload: {
      cppNodes: cppNodes.length,
      pythonNodes: pythonNodes.length,
    },
  });
  setStatus("Compiling...");

  try {
    if (cppNodes.length > 0) {
      await ensureEmception();
      for (const node of cppNodes) {
        const result = await emceptionRPC("compile", {
          source: node.source,
          lang: node.lang,
          flags: ["-O2", "-std=c++20", "-sWASM=1"],
          outputName: node.nodeId,
        });
        const nodeEl = canvas.nodeElements.get(node.nodeId);
        if (result.returncode === 0) {
          nodeEl?.querySelector(".node-status")?.classList.add("success");
          termLog(`Compiled ${node.label}`, "success", {
            source: node.label,
            nodeId: node.nodeId,
            payload: result,
          });
          publishToDebugNodes(
            `${node.label} compile result`,
            {
              nodeId: node.nodeId,
              lang: node.lang,
              returncode: result.returncode,
            },
            {
              level: "success",
              nodeId: node.nodeId,
            },
          );
        } else {
          nodeEl?.querySelector(".node-status")?.classList.add("error");
          termLog(`Compile failed for ${node.label}`, "error", {
            source: node.label,
            nodeId: node.nodeId,
            payload: result,
          });
        }
      }
    }

    if (pythonNodes.length > 0) {
      await ensurePyodide();
      for (const node of pythonNodes) {
        const result = await pyodideRPC("run", { code: node.source });
        const nodeEl = canvas.nodeElements.get(node.nodeId);
        nodeEl?.querySelector(".node-status")?.classList.add("success");
        termLog(`Executed ${node.label}`, "success", {
          source: node.label,
          nodeId: node.nodeId,
          payload: result,
        });
        publishToDebugNodes(
          `${node.label} runtime preview`,
          {
            nodeId: node.nodeId,
            stdout: result.stdout || "",
          },
          {
            level: "success",
            nodeId: node.nodeId,
          },
        );
      }
    }

    const sha = await model.computeSHA256();
    termLog("Compile finished", "success", {
      source: "compiler",
      payload: {
        sha256: sha,
      },
    });
    setStatus("Compile complete", "success");
    setSidebarView("debug");
    return {
      sha256: sha,
    };
  } catch (error) {
    termLog(`Compile error: ${error.message}`, "error", {
      source: "compiler",
    });
    setStatus("Compile failed", "error");
    throw error;
  }
}

document.getElementById("btn-compile").addEventListener("click", async () => {
  try {
    await runCompilePipeline();
  } catch {}
});

document.getElementById("btn-deploy").addEventListener("click", async () => {
  termLog("Deployment pipeline started", "info", {
    source: "deploy",
  });
  setStatus("Deploying...");

  try {
    const compileSummary = await runCompilePipeline();
    const crc = model.computeCRC();
    const sha = compileSummary?.sha256 ?? (await model.computeSHA256());
    const flowJson = model.toJSON();
    const payload = canonicalBytes(flowJson);

    const deployment = {
      version: 1,
      encrypted: false,
      payload: {
        version: 1,
        kind: "compiled-flow-wasm-deployment",
        artifact: {
          artifactId: `flow-${Date.now().toString(36)}`,
          programId: flowJson.programId,
          graphHash: sha,
          manifestHash: null,
          abiVersion: 1,
        },
        authorization: null,
        target: null,
        payloadLength: payload.length,
      },
    };

    if (bootstrapConfig?.api?.deployUrl) {
      const response = await fetch(bootstrapConfig.api.deployUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(deployment, null, 2),
      });
      if (!response.ok) {
        throw new Error(`Deploy endpoint returned ${response.status}`);
      }
    } else if (vscode) {
      vscode.postMessage({
        command: "deploy",
        data: JSON.stringify(deployment, null, 2),
      });
    } else {
      const blob = new Blob([JSON.stringify(deployment, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `deployment-${deployment.payload.artifact.artifactId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }

    termLog("Deployment package prepared", "success", {
      source: "deploy",
      payload: {
        crc32: crc,
        sha256: sha,
        artifactId: deployment.payload.artifact.artifactId,
      },
    });
    publishToDebugNodes(
      "deployment package",
      {
        crc32: crc,
        sha256: sha,
        artifactId: deployment.payload.artifact.artifactId,
      },
      {
        level: "success",
      },
    );
    setStatus("Deploy complete", "success");
    setSidebarView("debug");
  } catch (error) {
    termLog(`Deploy error: ${error.message}`, "error", {
      source: "deploy",
    });
    setStatus("Deploy failed", "error");
  }
});

document.getElementById("btn-wallet").addEventListener("click", () => {
  document.getElementById("wallet-dialog").showModal();
});

document.getElementById("btn-close-wallet").addEventListener("click", () => {
  document.getElementById("wallet-dialog").close();
});

document.getElementById("btn-delete-node").addEventListener("click", () => {
  for (const nodeId of [...canvas.selectedNodes]) {
    model.removeNode(nodeId);
  }
  canvas.selectedNodes.clear();
  activeDebugNodeId = null;
  renderProps(null);
  editorPanel.setNode(null);
  renderDebugEntries();
});

document.getElementById("btn-clear-debug").addEventListener("click", termClear);

document.getElementById("btn-load-iss").addEventListener("click", async () => {
  try {
    const response = await fetch("../examples/flows/iss-proximity-oem/flow.json");
    if (response.ok) {
      const json = await response.json();
      model.fromJSON(json);
      termLog(`Loaded template ${json.name}`, "success", {
        source: "templates",
        payload: json,
      });
      setStatus(`Loaded ${json.name}`, "success");
      return;
    }
  } catch {}
  loadISSExample();
});

function loadISSExample() {
  model.fromJSON({
    programId: "com.digitalarsenal.examples.iss-proximity-oem",
    name: "ISS Proximity OEM Flow",
    version: "0.1.0",
    description: "Stream OMMs, query proximity, propagate, generate OEMs.",
    nodes: [
      {
        nodeId: "db-ingest",
        pluginId: "com.digitalarsenal.flatsql.store",
        methodId: "upsert_records",
        kind: "transform",
        drainPolicy: "drain-until-yield",
        label: "DB Ingest",
        ports: {
          inputs: [{ id: "records", label: "records" }],
          outputs: [{ id: "out", label: "out" }],
        },
      },
      {
        nodeId: "build-query",
        pluginId: "com.digitalarsenal.flow.query-anchor",
        methodId: "build_radius_query",
        kind: "analyzer",
        drainPolicy: "drain-until-yield",
        label: "Build Query",
        ports: {
          inputs: [{ id: "tick", label: "tick" }],
          outputs: [{ id: "query", label: "query" }],
        },
      },
      {
        nodeId: "db-query",
        pluginId: "com.digitalarsenal.flatsql.store",
        methodId: "query_objects_within_radius",
        kind: "analyzer",
        drainPolicy: "drain-until-yield",
        label: "DB Query",
        ports: {
          inputs: [{ id: "query", label: "query" }],
          outputs: [{ id: "matches", label: "matches" }],
        },
      },
      {
        nodeId: "propagate",
        pluginId: "com.digitalarsenal.propagator.sgp4",
        methodId: "propagate_one_orbit_samples",
        kind: "transform",
        drainPolicy: "drain-until-yield",
        label: "Propagate",
        ports: {
          inputs: [{ id: "selection", label: "selection" }],
          outputs: [{ id: "samples", label: "samples" }],
        },
      },
      {
        nodeId: "generate-oem",
        pluginId: "com.digitalarsenal.oem.generator",
        methodId: "generate_oem",
        kind: "transform",
        drainPolicy: "drain-until-yield",
        label: "Gen OEM",
        ports: {
          inputs: [{ id: "samples", label: "samples" }],
          outputs: [{ id: "oems", label: "oems" }],
        },
      },
      {
        nodeId: "publish-oem",
        pluginId: "com.digitalarsenal.oem.publisher",
        methodId: "publish_oem",
        kind: "publisher",
        drainPolicy: "drain-until-yield",
        label: "Publish OEM",
        ports: {
          inputs: [{ id: "oems", label: "oems" }],
          outputs: [],
        },
      },
      {
        nodeId: "debug-oem",
        pluginId: "",
        methodId: "",
        kind: "debug",
        drainPolicy: "drain-until-yield",
        label: "Inspect OEM",
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
        edgeId: "e1",
        fromNodeId: "build-query",
        fromPortId: "query",
        toNodeId: "db-query",
        toPortId: "query",
        backpressurePolicy: "latest",
        queueDepth: 1,
      },
      {
        edgeId: "e2",
        fromNodeId: "db-query",
        fromPortId: "matches",
        toNodeId: "propagate",
        toPortId: "selection",
        backpressurePolicy: "queue",
        queueDepth: 32,
      },
      {
        edgeId: "e3",
        fromNodeId: "propagate",
        fromPortId: "samples",
        toNodeId: "generate-oem",
        toPortId: "samples",
        backpressurePolicy: "queue",
        queueDepth: 32,
      },
      {
        edgeId: "e4",
        fromNodeId: "generate-oem",
        fromPortId: "oems",
        toNodeId: "publish-oem",
        toPortId: "oems",
        backpressurePolicy: "queue",
        queueDepth: 32,
      },
      {
        edgeId: "e5",
        fromNodeId: "generate-oem",
        fromPortId: "oems",
        toNodeId: "debug-oem",
        toPortId: "in",
        backpressurePolicy: "latest",
        queueDepth: 4,
      },
    ],
    triggers: [
      {
        triggerId: "omm-subscription",
        kind: "pubsub-subscription",
        source: "/sdn/catalog/omm",
      },
      {
        triggerId: "refresh-query",
        kind: "timer",
        source: "refresh-query",
        defaultIntervalMs: 15000,
      },
    ],
    triggerBindings: [
      {
        triggerId: "omm-subscription",
        targetNodeId: "db-ingest",
        targetPortId: "records",
        backpressurePolicy: "queue",
        queueDepth: 4096,
      },
      {
        triggerId: "refresh-query",
        targetNodeId: "build-query",
        targetPortId: "tick",
        backpressurePolicy: "latest",
        queueDepth: 1,
      },
    ],
    editor: {
      viewport: { x: 0, y: 0, zoom: 0.85 },
      nodes: {
        "db-ingest": { x: 80, y: 140 },
        "build-query": { x: 80, y: 360 },
        "db-query": { x: 360, y: 360 },
        propagate: { x: 640, y: 360 },
        "generate-oem": { x: 920, y: 360 },
        "publish-oem": { x: 1210, y: 300 },
        "debug-oem": { x: 1210, y: 450 },
      },
    },
  });
  termLog("Loaded embedded ISS Proximity OEM template", "success", {
    source: "templates",
  });
  publishToDebugNodes(
    "template load",
    {
      template: "ISS Proximity OEM",
      nodeCount: model.nodes.size,
    },
    {
      level: "success",
    },
  );
  setStatus("Loaded ISS Proximity OEM template", "success");
}

function setupResize(handleId, getTarget) {
  const handle = document.getElementById(handleId);
  if (!handle) {
    return;
  }
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const target = getTarget();
    const startX = event.clientX;
    const startWidth = target.offsetWidth;

    const onMove = (moveEvent) => {
      const width = startWidth - (moveEvent.clientX - startX);
      target.style.width = `${Math.max(300, width)}px`;
      editorPanel.layout();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

setupResize("right-resize", () => document.getElementById("right-panel"));

if (vscode) {
  window.addEventListener("message", ({ data }) => {
    if (data.command !== "loadFlow") {
      return;
    }
    try {
      model.fromJSON(JSON.parse(data.data));
      termLog("Loaded flow from VS Code host", "success", {
        source: "workspace",
      });
    } catch (error) {
      termLog(`VS Code load error: ${error.message}`, "error", {
        source: "workspace",
      });
    }
  });
}

async function loadBootstrapConfig() {
  try {
    const response = await fetch(new URL("./api/bootstrap", window.location.href));
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  }
}

function applyBootstrapConfig(config) {
  if (!config) {
    return;
  }
  bootstrapConfig = config;
  document.title = config.title || "sdn-flow Editor";
  if (config.title) {
    workspaceNameEl.textContent = config.title;
  }
  if (config.engineLabel) {
    workspaceEngineBadgeEl.textContent = config.engineLabel;
  }
  if (config.initialFlow && typeof config.initialFlow === "object") {
    model.fromJSON(config.initialFlow);
    termLog(`Loaded embedded flow ${config.initialFlow.name || "Untitled Flow"}`, "success", {
      source: "bootstrap",
      payload: config.initialFlow,
    });
  }
}

async function init() {
  await editorPanel.ready();
  editorPanel.bindModel(model);
  setSidebarView("inspector");
  renderProps(null);
  renderDebugEntries();
  updateCounts();

  const config = await loadBootstrapConfig();
  applyBootstrapConfig(config);

  if (model.nodes.size === 0) {
    loadISSExample();
  }

  setStatus("Ready");
  termLog("Editor runtime ready", "success", {
    source: "editor",
    payload: {
      embeddable: true,
      singleFileReady: true,
    },
  });
}

init();
