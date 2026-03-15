/**
 * app.mjs — Main application orchestrator for the sdn-flow IDE.
 *
 * Binds the flow model, canvas, Monaco editor, compilation workers,
 * toolbar actions (import/export/CRC/compile/deploy), and VS Code
 * webview communication.
 */

import { FlowModel, crc32Hex, canonicalBytes } from "./flow-model.mjs";
import { FlowCanvas } from "./flow-canvas.mjs";
import { EditorPanel } from "./editor-panel.mjs";

// ── VS Code webview API (if running inside VS Code) ──
const vscode = (typeof acquireVsCodeApi === "function") ? acquireVsCodeApi() : null;

// ── Worker RPC helper ──
function workerRPC(worker) {
  let idCounter = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    if (data.log !== undefined) {
      termLog(data.log, data.level || "info");
      return;
    }
    const { id, result, error } = data;
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    }
  };
  return (method, args) => new Promise((resolve, reject) => {
    const id = ++idCounter;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

// ── Terminal ──
const termEl = document.getElementById("terminal");

function termLog(text, level = "info") {
  const span = document.createElement("span");
  span.className = `term-${level}`;
  span.textContent = text + "\n";
  termEl.appendChild(span);
  termEl.scrollTop = termEl.scrollHeight;
}

function termClear() { termEl.innerHTML = ""; }

// ── Status bar ──
function setStatus(msg, type = "") {
  const bar = document.getElementById("statusbar");
  document.getElementById("status-msg").textContent = msg;
  bar.className = type; // "", "error", "success"
}

function updateCounts() {
  document.getElementById("node-count").textContent = `${model.nodes.size} nodes`;
  document.getElementById("edge-count").textContent = `${model.edges.size} wires`;
}

// ── Model + Canvas + Editor ──
const model = new FlowModel();
const svg = document.getElementById("flow-canvas");
const canvas = new FlowCanvas(svg, model);
const editorPanel = new EditorPanel("editor-container", "editor-lang");

// ── Properties Panel ──
const propsBody = document.getElementById("props-body");

function renderProps(nodeId) {
  if (!nodeId) {
    propsBody.innerHTML = '<div class="empty-state">Select a node to edit</div>';
    return;
  }
  const node = model.nodes.get(nodeId);
  if (!node) return;

  propsBody.innerHTML = `
    <div class="prop-group">
      <label class="prop-label">Label</label>
      <input class="prop-input" data-field="label" value="${esc(node.label)}">
    </div>
    <div class="prop-group">
      <label class="prop-label">Kind</label>
      <select class="prop-select" data-field="kind">
        ${["trigger","transform","analyzer","publisher","responder","renderer","sink"]
          .map(k => `<option value="${k}" ${k === node.kind ? "selected" : ""}>${k}</option>`).join("")}
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
        ${["single-shot","drain-until-yield","drain-to-empty"]
          .map(d => `<option value="${d}" ${d === node.drainPolicy ? "selected" : ""}>${d}</option>`).join("")}
      </select>
    </div>
    <div class="prop-group">
      <label class="prop-label">Language</label>
      <select class="prop-select" data-field="lang">
        <option value="">None</option>
        ${["cpp","python","typescript","javascript","rust","go","c"]
          .map(l => `<option value="${l}" ${l === node.lang ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="prop-group">
      <label class="prop-label">Input Ports</label>
      <div class="port-list" data-dir="input">
        ${(node.ports?.inputs || []).map(p => `
          <div class="port-row">
            <input class="prop-input port-name" value="${esc(p.id)}" data-port-id="${esc(p.id)}" placeholder="port id">
            <button class="icon-btn remove-port" data-port-id="${esc(p.id)}">-</button>
          </div>
        `).join("")}
        <button class="palette-btn add-port" data-dir="input">+ Add Input</button>
      </div>
    </div>
    <div class="prop-group">
      <label class="prop-label">Output Ports</label>
      <div class="port-list" data-dir="output">
        ${(node.ports?.outputs || []).map(p => `
          <div class="port-row">
            <input class="prop-input port-name" value="${esc(p.id)}" data-port-id="${esc(p.id)}" placeholder="port id">
            <button class="icon-btn remove-port" data-port-id="${esc(p.id)}">-</button>
          </div>
        `).join("")}
        <button class="palette-btn add-port" data-dir="output">+ Add Output</button>
      </div>
    </div>
  `;

  // Bind property changes
  propsBody.querySelectorAll(".prop-input[data-field], .prop-select[data-field]").forEach(el => {
    el.addEventListener("change", () => {
      model.updateNode(nodeId, { [el.dataset.field]: el.value || null });
      if (el.dataset.field === "lang") {
        editorPanel.setNode(nodeId); // refresh editor language
      }
    });
  });

  // Add/remove port buttons
  propsBody.querySelectorAll(".add-port").forEach(btn => {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.dir;
      const portId = prompt("Port ID:", `port-${Date.now().toString(36)}`);
      if (portId) {
        model.addPort(nodeId, dir, portId, portId);
        renderProps(nodeId);
      }
    });
  });
  propsBody.querySelectorAll(".remove-port").forEach(btn => {
    btn.addEventListener("click", () => {
      const portId = btn.dataset.portId;
      const dir = btn.closest(".port-list").dataset.dir;
      model.removePort(nodeId, dir, portId);
      renderProps(nodeId);
    });
  });
}

function esc(s) { return (s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// ── Wire canvas + editor + props ──
canvas.onNodeSelect((nodeId) => {
  renderProps(nodeId);
  updateGeneratedSource();
});

// Double-click node → load plugin metadata from manifest
canvas.onNodeDblClick(async (nodeId) => {
  const node = model.nodes.get(nodeId);
  if (!node) return;
  if (!node.pluginId) {
    termLog(`Node ${node.label}: no pluginId set, cannot load metadata.`, "warn");
    return;
  }
  termLog(`Loading metadata for plugin: ${node.pluginId}...`, "info");

  // Try fetching manifest from examples
  const manifests = [
    `../examples/plugins/${node.pluginId.split(".").pop()}/manifest.json`,
    `../examples/plugins/${node.methodId}/manifest.json`,
  ];
  let found = false;
  for (const url of manifests) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const manifest = await resp.json();
        termLog(`Plugin manifest loaded: ${manifest.pluginId || node.pluginId}`, "success");
        termLog(JSON.stringify(manifest, null, 2), "info");
        // Update node with manifest data
        if (manifest.methods) {
          const methods = Array.isArray(manifest.methods) ? manifest.methods : Object.values(manifest.methods);
          const method = methods.find(m => m.methodId === node.methodId) || methods[0];
          if (method) {
            const ports = { inputs: [], outputs: [] };
            if (method.inputs) method.inputs.forEach(p => ports.inputs.push({ id: p.portId || p.id, label: p.label || p.portId || p.id }));
            if (method.outputs) method.outputs.forEach(p => ports.outputs.push({ id: p.portId || p.id, label: p.label || p.portId || p.id }));
            if (ports.inputs.length || ports.outputs.length) {
              model.updateNode(nodeId, { ports });
              termLog(`  Updated ports from manifest`, "success");
            }
          }
        }
        found = true;
        break;
      }
    } catch (e) { /* try next */ }
  }
  if (!found) {
    // Show what we know in the terminal
    termLog(`  pluginId: ${node.pluginId}`, "info");
    termLog(`  methodId: ${node.methodId}`, "info");
    termLog(`  kind: ${node.kind}`, "info");
    termLog(`  drainPolicy: ${node.drainPolicy}`, "info");
    termLog(`  (manifest not found locally — set up artifact catalog for remote resolution)`, "warn");
  }
  renderProps(nodeId);
});

canvas.onEdgeSelect((edgeId) => {
  renderProps(null);
  if (edgeId) {
    const edge = model.edges.get(edgeId);
    if (edge) {
      propsBody.innerHTML = `
        <div class="prop-group"><label class="prop-label">Edge</label><span style="color:#ccc">${edge.edgeId}</span></div>
        <div class="prop-group"><label class="prop-label">From</label><span style="color:#ccc">${edge.fromNodeId}:${edge.fromPortId}</span></div>
        <div class="prop-group"><label class="prop-label">To</label><span style="color:#ccc">${edge.toNodeId}:${edge.toPortId}</span></div>
        <div class="prop-group">
          <label class="prop-label">Backpressure</label>
          <select class="prop-select" id="edge-bp">
            ${["drop","latest","queue","block-request","coalesce","drain-to-empty"]
              .map(b => `<option value="${b}" ${b === edge.backpressurePolicy ? "selected" : ""}>${b}</option>`).join("")}
          </select>
        </div>
        <div class="prop-group">
          <label class="prop-label">Queue Depth</label>
          <input class="prop-input" id="edge-qd" type="number" value="${edge.queueDepth}">
        </div>
      `;
      document.getElementById("edge-bp")?.addEventListener("change", (e) => { edge.backpressurePolicy = e.target.value; });
      document.getElementById("edge-qd")?.addEventListener("change", (e) => { edge.queueDepth = parseInt(e.target.value) || 32; });
    }
  }
});

model.addEventListener("change", () => {
  updateCounts();
  // Update CRC badge
  const crc = model.computeCRC();
  document.getElementById("crc-badge").textContent = crc;
  updateGeneratedSource();
});

// ── Generated Source (read-only view of the compiled flow) ──

function updateGeneratedSource() {
  const json = model.toJSON();
  const nodes = json.nodes || [];
  const edges = json.edges || [];
  const triggers = json.triggers || [];

  // Generate a C++ source preview of the flow runtime
  const includes = [
    '#include <cstdint>',
    '#include <cstring>',
    '#include "flatbuffers/flatbuffers.h"',
    '#include "flow_manifest_generated.h"',
    '',
    '// ═══════════════════════════════════════════════════',
    `// Generated flow: ${json.name || "Untitled"}`,
    `// Program ID:     ${json.programId || "(none)"}`,
    `// Nodes: ${nodes.length}  Edges: ${edges.length}  Triggers: ${triggers.length}`,
    `// CRC-32: ${model.computeCRC()}`,
    '// ═══════════════════════════════════════════════════',
    '',
  ];

  // Manifest embed
  const manifest = [
    '// ── Embedded FlatBuffer manifest ──',
    'static const uint8_t FLOW_MANIFEST[] = { /* built at compile time */ };',
    'static const uint32_t FLOW_MANIFEST_SIZE = sizeof(FLOW_MANIFEST);',
    '',
    'extern "C" const uint8_t* flow_get_manifest_flatbuffer() { return FLOW_MANIFEST; }',
    'extern "C" uint32_t flow_get_manifest_flatbuffer_size() { return FLOW_MANIFEST_SIZE; }',
    '',
  ];

  // Plugin artifact imports
  const plugins = [...new Set(nodes.map(n => n.pluginId).filter(Boolean))];
  const pluginDecls = plugins.length > 0 ? [
    '// ── Plugin artifact imports ──',
    ...plugins.map((p, i) => `static const uint8_t* PLUGIN_${i}_WASM = nullptr;  // ${p}`),
    ...plugins.map((p, i) => `static uint32_t PLUGIN_${i}_SIZE = 0;`),
    '',
  ] : [];

  // Node declarations
  const nodeDecls = [
    '// ── Node declarations ──',
    ...nodes.map(n => {
      const kind = n.kind.toUpperCase();
      return `// [${kind}] ${n.label}  (${n.pluginId || "inline"} :: ${n.methodId || "process"})`;
    }),
    '',
  ];

  // Topology (edges)
  const topo = edges.length > 0 ? [
    '// ── Topology ──',
    ...edges.map(e =>
      `//   ${e.fromNodeId}:${e.fromPortId} ──► ${e.toNodeId}:${e.toPortId}  [${e.backpressurePolicy}, depth=${e.queueDepth}]`
    ),
    '',
  ] : [];

  // Trigger bindings
  const trigBindings = (json.triggerBindings || []).length > 0 ? [
    '// ── Trigger bindings ──',
    ...(json.triggerBindings || []).map(b =>
      `//   ${b.triggerId} ──► ${b.targetNodeId}:${b.targetPortId}  [${b.backpressurePolicy}]`
    ),
    '',
  ] : [];

  // Main entry
  const main = [
    '// ── Runtime entry ──',
    'extern "C" int flow_init() {',
    '    // Initialize node state, wire topology, register triggers',
    ...nodes.map(n => `    // init_node("${n.nodeId}", ${n.kind});`),
    ...edges.map(e => `    // wire("${e.fromNodeId}:${e.fromPortId}", "${e.toNodeId}:${e.toPortId}");`),
    '    return 0;',
    '}',
    '',
    'extern "C" int flow_step(const uint8_t* frame, uint32_t len) {',
    '    // Dispatch frame through topology',
    '    return 0;',
    '}',
  ];

  const source = [...includes, ...manifest, ...pluginDecls, ...nodeDecls, ...topo, ...trigBindings, ...main].join('\n');

  editorPanel.setGeneratedSource(source);
}

// ── Palette drag ──
document.querySelectorAll(".palette-item[draggable]").forEach(item => {
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/x-sdn-kind", item.dataset.kind);
    e.dataTransfer.setData("text/x-sdn-lang", item.dataset.lang || "");
    e.dataTransfer.effectAllowed = "copy";
  });
});

// ── Toolbar: Import ──
document.getElementById("btn-import").addEventListener("click", async () => {
  if (vscode) {
    // VS Code: request file from extension host
    vscode.postMessage({ command: "importFlow" });
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      model.fromJSON(json);
      setStatus(`Loaded: ${json.name || file.name}`, "success");
      termLog(`Imported flow: ${json.name || file.name}`, "success");
    } catch (err) {
      setStatus("Import failed", "error");
      termLog(`Import error: ${err.message}`, "error");
    }
  };
  input.click();
});

// ── Toolbar: Export ──
document.getElementById("btn-export").addEventListener("click", () => {
  const json = model.toJSON();
  const text = JSON.stringify(json, null, 2);

  if (vscode) {
    vscode.postMessage({ command: "exportFlow", data: text });
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${json.name || "flow"}.json`;
  a.click();
  URL.revokeObjectURL(url);
  termLog(`Exported: ${a.download}`, "success");
});

// ── Toolbar: CRC ──
document.getElementById("btn-crc").addEventListener("click", async () => {
  const crc = model.computeCRC();
  const sha = await model.computeSHA256();
  termLog(`CRC-32:  ${crc}`, "info");
  termLog(`SHA-256: ${sha}`, "info");
  setStatus(`CRC: ${crc}`);
});

// ── Compilation Workers ──
let emceptionWorker = null;
let emceptionRPC = null;
let emceptionReady = false;

let pyodideWorker = null;
let pyodideRPC = null;
let pyodideReady = false;

// Resolve worker URLs relative to this module, not the page
const WORKER_BASE = new URL("./workers/", import.meta.url).href;

// Emception base URL — override via ?emception=<url> query param
const EMCEPTION_BASE = new URLSearchParams(location.search).get("emception") || "https://digitalarsenal.github.io/emception/";

async function ensureEmception() {
  if (emceptionReady) return;
  if (!emceptionWorker) {
    emceptionWorker = new Worker(WORKER_BASE + "emception.worker.js");
    emceptionRPC = workerRPC(emceptionWorker);
  }
  setStatus("Loading emception...");
  await emceptionRPC("init", { baseUrl: EMCEPTION_BASE });
  emceptionReady = true;
  setStatus("Emception ready", "success");
}

async function ensurePyodide() {
  if (pyodideReady) return;
  if (!pyodideWorker) {
    pyodideWorker = new Worker(WORKER_BASE + "pyodide.worker.js");
    pyodideRPC = workerRPC(pyodideWorker);
  }
  setStatus("Loading Pyodide...");
  await pyodideRPC("init");
  pyodideReady = true;
  setStatus("Pyodide ready", "success");
}

// ── Toolbar: Compile ──
document.getElementById("btn-compile").addEventListener("click", async () => {
  const nodes = [...model.nodes.values()];
  const cppNodes = nodes.filter(n => n.lang === "cpp" || n.lang === "c");
  const pyNodes = nodes.filter(n => n.lang === "python");

  if (cppNodes.length === 0 && pyNodes.length === 0) {
    termLog("No compilable nodes (add C++ or Python modules).", "warn");
    return;
  }

  termLog("=== Compile started ===", "info");
  setStatus("Compiling...");

  try {
    // Compile C++ nodes via emception
    if (cppNodes.length > 0) {
      await ensureEmception();
      for (const node of cppNodes) {
        termLog(`Compiling ${node.label} (${node.lang})...`, "info");
        const result = await emceptionRPC("compile", {
          source: node.source,
          lang: node.lang,
          flags: ["-O2", "-std=c++20", "-sWASM=1"],
          outputName: node.nodeId,
        });
        if (result.returncode === 0) {
          termLog(`  ${node.label}: OK`, "success");
          // Set node status
          const el = canvas.nodeElements.get(node.nodeId);
          el?.querySelector(".node-status")?.classList.add("success");
        } else {
          termLog(`  ${node.label}: FAILED (exit ${result.returncode})`, "error");
          if (result.stderr) termLog(result.stderr, "error");
          const el = canvas.nodeElements.get(node.nodeId);
          el?.querySelector(".node-status")?.classList.add("error");
        }
      }
    }

    // Run Python nodes via Pyodide
    if (pyNodes.length > 0) {
      await ensurePyodide();
      for (const node of pyNodes) {
        termLog(`Running ${node.label} (Python)...`, "info");
        const result = await pyodideRPC("run", { code: node.source });
        termLog(`  ${node.label}: OK`, "success");
        if (result.stdout) termLog(result.stdout, "info");
        const el = canvas.nodeElements.get(node.nodeId);
        el?.querySelector(".node-status")?.classList.add("success");
      }
    }

    // Compute final artifact hash
    const sha = await model.computeSHA256();
    termLog(`Graph SHA-256: ${sha}`, "info");
    setStatus("Compile complete", "success");
    termLog("=== Compile finished ===", "success");
  } catch (err) {
    termLog(`Compile error: ${err.message}`, "error");
    setStatus("Compile failed", "error");
  }
});

// ── Toolbar: Deploy ──
document.getElementById("btn-deploy").addEventListener("click", async () => {
  termLog("=== Deploy pipeline started ===", "info");
  setStatus("Deploying...");

  try {
    // Step 1: Compile (reuse compile logic)
    document.getElementById("btn-compile").click();

    // Step 2: Compute integrity
    const crc = model.computeCRC();
    const sha = await model.computeSHA256();
    termLog(`Artifact CRC-32: ${crc}`, "info");
    termLog(`Artifact SHA-256: ${sha}`, "info");

    // Step 3: Sign with HD-wallet (if wallet is available)
    const flowJson = model.toJSON();
    const payload = canonicalBytes(flowJson);

    termLog("Preparing deployment authorization...", "info");
    termLog(`  programId: ${flowJson.programId || "(unnamed)"}`, "info");
    termLog(`  graphHash: ${sha}`, "info");
    termLog(`  nodes: ${flowJson.nodes.length}, edges: ${flowJson.edges.length}`, "info");

    // The actual signing would integrate with hd-wallet-wasm:
    //   const wallet = await initHDWallet();
    //   const master = wallet.hdkey.fromSeed(seed);
    //   const signingKey = getSigningKey(master, WellKnownCoinType.SDN);
    //   const digest = wallet.utils.sha256(payload);
    //   const signature = wallet.curves.secp256k1.sign(digest, signingKey.privateKey());
    //
    // For now, log the authorization shape:
    termLog("  [wallet integration point: sign authorization envelope]", "warn");
    termLog("  [wallet integration point: encrypt with recipient public key]", "warn");

    // Step 4: Package
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
        authorization: null, // would be signed envelope
        target: null,
      },
    };

    if (vscode) {
      // In VS Code, send to extension host to save
      vscode.postMessage({ command: "deploy", data: JSON.stringify(deployment, null, 2) });
      termLog("Deployment package sent to VS Code host.", "success");
    } else {
      // In browser, offer download
      const blob = new Blob([JSON.stringify(deployment, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deployment-${deployment.payload.artifact.artifactId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      termLog(`Deployment package downloaded: ${a.download}`, "success");
    }

    setStatus("Deploy complete", "success");
    termLog("=== Deploy pipeline finished ===", "success");
  } catch (err) {
    termLog(`Deploy error: ${err.message}`, "error");
    setStatus("Deploy failed", "error");
  }
});

// ── Toolbar: Wallet ──
document.getElementById("btn-wallet").addEventListener("click", () => {
  document.getElementById("wallet-dialog").showModal();
});
document.getElementById("btn-close-wallet").addEventListener("click", () => {
  document.getElementById("wallet-dialog").close();
});

// ── Toolbar: Delete node ──
document.getElementById("btn-delete-node").addEventListener("click", () => {
  for (const nodeId of [...canvas.selectedNodes]) {
    model.removeNode(nodeId);
  }
  canvas.selectedNodes.clear();
  renderProps(null);
  editorPanel.setNode(null);
});

// ── Terminal: Clear ──
document.getElementById("btn-clear-term").addEventListener("click", termClear);

// ── Template: ISS Proximity OEM ──
document.getElementById("btn-load-iss").addEventListener("click", async () => {
  try {
    const resp = await fetch("../examples/flows/iss-proximity-oem/flow.json");
    if (!resp.ok) {
      // Try embedded example
      loadISSExample();
      return;
    }
    const json = await resp.json();
    model.fromJSON(json);
    setStatus(`Loaded: ${json.name}`, "success");
    termLog(`Loaded template: ${json.name}`, "success");
  } catch (e) {
    loadISSExample();
  }
});

function loadISSExample() {
  // Embedded minimal version of ISS Proximity flow
  model.fromJSON({
    programId: "com.digitalarsenal.examples.iss-proximity-oem",
    name: "ISS Proximity OEM Flow",
    version: "0.1.0",
    description: "Stream OMMs, query proximity, propagate, generate OEMs.",
    nodes: [
      { nodeId: "db-ingest", pluginId: "com.digitalarsenal.flatsql.store", methodId: "upsert_records", kind: "transform", drainPolicy: "drain-until-yield", label: "DB Ingest", ports: { inputs: [{ id: "records", label: "records" }], outputs: [{ id: "out", label: "out" }] } },
      { nodeId: "build-query", pluginId: "com.digitalarsenal.flow.query-anchor", methodId: "build_radius_query", kind: "analyzer", drainPolicy: "drain-until-yield", label: "Build Query", ports: { inputs: [{ id: "tick", label: "tick" }], outputs: [{ id: "query", label: "query" }] } },
      { nodeId: "db-query", pluginId: "com.digitalarsenal.flatsql.store", methodId: "query_objects_within_radius", kind: "analyzer", drainPolicy: "drain-until-yield", label: "DB Query", ports: { inputs: [{ id: "query", label: "query" }], outputs: [{ id: "matches", label: "matches" }] } },
      { nodeId: "propagate", pluginId: "com.digitalarsenal.propagator.sgp4", methodId: "propagate_one_orbit_samples", kind: "transform", drainPolicy: "drain-until-yield", label: "Propagate", ports: { inputs: [{ id: "selection", label: "selection" }], outputs: [{ id: "samples", label: "samples" }] } },
      { nodeId: "generate-oem", pluginId: "com.digitalarsenal.oem.generator", methodId: "generate_oem", kind: "transform", drainPolicy: "drain-until-yield", label: "Gen OEM", ports: { inputs: [{ id: "samples", label: "samples" }], outputs: [{ id: "oems", label: "oems" }] } },
      { nodeId: "write-oem", pluginId: "com.digitalarsenal.oem.file-writer", methodId: "write_oem_files", kind: "sink", drainPolicy: "drain-until-yield", label: "Write OEM", ports: { inputs: [{ id: "oems", label: "oems" }], outputs: [] } },
      { nodeId: "publish-oem", pluginId: "com.digitalarsenal.oem.publisher", methodId: "publish_oem", kind: "publisher", drainPolicy: "drain-until-yield", label: "Publish OEM", ports: { inputs: [{ id: "oems", label: "oems" }], outputs: [] } },
    ],
    edges: [
      { edgeId: "e1", fromNodeId: "build-query", fromPortId: "query", toNodeId: "db-query", toPortId: "query", backpressurePolicy: "latest", queueDepth: 1 },
      { edgeId: "e2", fromNodeId: "db-query", fromPortId: "matches", toNodeId: "propagate", toPortId: "selection", backpressurePolicy: "queue", queueDepth: 32 },
      { edgeId: "e3", fromNodeId: "propagate", fromPortId: "samples", toNodeId: "generate-oem", toPortId: "samples", backpressurePolicy: "queue", queueDepth: 32 },
      { edgeId: "e4", fromNodeId: "generate-oem", fromPortId: "oems", toNodeId: "write-oem", toPortId: "oems", backpressurePolicy: "queue", queueDepth: 32 },
      { edgeId: "e5", fromNodeId: "generate-oem", fromPortId: "oems", toNodeId: "publish-oem", toPortId: "oems", backpressurePolicy: "queue", queueDepth: 32 },
    ],
    triggers: [
      { triggerId: "omm-subscription", kind: "pubsub-subscription", source: "/sdn/catalog/omm" },
      { triggerId: "refresh-query", kind: "timer", source: "refresh-query", defaultIntervalMs: 15000 },
    ],
    triggerBindings: [
      { triggerId: "omm-subscription", targetNodeId: "db-ingest", targetPortId: "records", backpressurePolicy: "queue", queueDepth: 4096 },
      { triggerId: "refresh-query", targetNodeId: "build-query", targetPortId: "tick", backpressurePolicy: "latest", queueDepth: 1 },
    ],
    editor: {
      viewport: { x: 0, y: 0, zoom: 0.85 },
      nodes: {
        "db-ingest":    { x: 80, y: 160 },
        "build-query":  { x: 80, y: 380 },
        "db-query":     { x: 360, y: 380 },
        "propagate":    { x: 640, y: 380 },
        "generate-oem": { x: 920, y: 380 },
        "write-oem":    { x: 1200, y: 280 },
        "publish-oem":  { x: 1200, y: 480 },
      },
    },
  });
  setStatus("Loaded: ISS Proximity OEM Flow", "success");
  termLog("Loaded template: ISS Proximity OEM Flow", "success");
}

// ── Resize handles ──
function setupResize(handleId, direction, getTarget) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const target = getTarget();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = target.offsetWidth;
    const startH = target.offsetHeight;
    const onMove = (e2) => {
      if (direction === "horizontal") {
        const newW = startW - (e2.clientX - startX);
        target.style.width = `${Math.max(200, newW)}px`;
      } else {
        const newH = startH + (e2.clientY - startY);
        target.style.height = `${Math.max(60, newH)}px`;
      }
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

setupResize("right-resize", "horizontal", () => document.getElementById("right-panel"));

// ── VS Code message handler ──
if (vscode) {
  window.addEventListener("message", ({ data }) => {
    if (data.command === "loadFlow") {
      try {
        model.fromJSON(JSON.parse(data.data));
        setStatus("Flow loaded from VS Code", "success");
      } catch (e) {
        termLog(`VS Code load error: ${e.message}`, "error");
      }
    }
  });
}

// ── Init ──
async function init() {
  await editorPanel.ready();
  editorPanel.bindModel(model);
  updateCounts();
  setStatus("Ready");
  termLog("sdn-flow IDE ready.", "success");
  termLog("Drag nodes from the palette, or load the ISS Proximity template.", "info");
}

init();
