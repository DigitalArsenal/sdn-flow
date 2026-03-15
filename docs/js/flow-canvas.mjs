/**
 * flow-canvas.mjs — SVG flow canvas with draggable nodes, port wiring,
 * pan/zoom, selection, and grid snapping. Node-RED style.
 */

import { KIND_COLORS } from "./flow-model.mjs";

const NODE_W = 160;
const TITLE_H = 22;       // compact title bar
const PORT_ROW_H = 16;    // space per port row
const NODE_PAD_BOTTOM = 4;
const PORT_R = 5;
const GRID_SNAP = 20;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;

function snap(v) { return Math.round(v / GRID_SNAP) * GRID_SNAP; }

function bezierWire(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(50, dx * 0.4);
  return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`;
}

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export class FlowCanvas {
  constructor(svgElement, model) {
    this.svg = svgElement;
    this.model = model;
    this.viewport = svgElement.querySelector("#canvas-viewport");
    this.wiresLayer = svgElement.querySelector("#layer-wires");
    this.nodesLayer = svgElement.querySelector("#layer-nodes");
    this.tempWire = svgElement.querySelector("#temp-wire");

    // State
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.selectedNodes = new Set();
    this.selectedEdge = null;
    this.nodeElements = new Map();  // nodeId → SVG <g>
    this.wireElements = new Map();  // edgeId → SVG <path>
    this.portPositions = new Map(); // "nodeId:dir:portId" → {x, y}

    // Drag state
    this._drag = null; // { type: 'node'|'wire'|'pan'|'select', ... }
    this._onNodeSelect = null; // callback
    this._onEdgeSelect = null;

    this._bindEvents();
    this._bindModelEvents();
  }

  // ── Public API ──

  onNodeSelect(fn) { this._onNodeSelect = fn; }
  onEdgeSelect(fn) { this._onEdgeSelect = fn; }
  onNodeDblClick(fn) { this._onNodeDblClick = fn; }

  selectNode(nodeId, additive = false) {
    if (!additive) {
      this.selectedNodes.forEach(id => this.nodeElements.get(id)?.classList.remove("selected"));
      this.selectedNodes.clear();
    }
    this.selectedNodes.add(nodeId);
    this.nodeElements.get(nodeId)?.classList.add("selected");
    this._clearEdgeSelection();
    this._onNodeSelect?.(nodeId);
  }

  deselectAll() {
    this.selectedNodes.forEach(id => this.nodeElements.get(id)?.classList.remove("selected"));
    this.selectedNodes.clear();
    this._clearEdgeSelection();
    this._onNodeSelect?.(null);
  }

  fitView() {
    const positions = Object.values(this.model.editorMeta.nodes);
    if (positions.length === 0) return;
    const xs = positions.map(p => p.x);
    const ys = positions.map(p => p.y);
    const minX = Math.min(...xs) - 100;
    const minY = Math.min(...ys) - 100;
    const maxX = Math.max(...xs) + NODE_W + 100;
    const maxY = Math.max(...ys) + TITLE_H + 60 + 100;
    const rect = this.svg.getBoundingClientRect();
    const scaleX = rect.width / (maxX - minX);
    const scaleY = rect.height / (maxY - minY);
    this.zoom = Math.min(scaleX, scaleY, 1.5);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom));
    this.panX = -minX * this.zoom + (rect.width - (maxX - minX) * this.zoom) / 2;
    this.panY = -minY * this.zoom + (rect.height - (maxY - minY) * this.zoom) / 2;
    this._applyTransform();
  }

  rebuild() {
    this.wiresLayer.innerHTML = "";
    this.nodesLayer.innerHTML = "";
    this.nodeElements.clear();
    this.wireElements.clear();
    this.portPositions.clear();
    for (const node of this.model.nodes.values()) this._renderNode(node);
    for (const edge of this.model.edges.values()) this._renderWire(edge);
    this._updateAllWires();
    this.fitView();
  }

  // Convert page coords to canvas coords
  pageToCanvas(px, py) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (px - rect.left - this.panX) / this.zoom,
      y: (py - rect.top - this.panY) / this.zoom,
    };
  }

  // ── Node Rendering ──

  _renderNode(node) {
    const pos = this.model.editorMeta.nodes[node.nodeId] || { x: 200, y: 200 };
    const color = KIND_COLORS[node.kind] || "#569cd6";
    const nInputs = node.ports?.inputs?.length || 0;
    const nOutputs = node.ports?.outputs?.length || 0;
    const portRows = Math.max(nInputs, nOutputs);
    const bodyH = portRows > 0 ? portRows * PORT_ROW_H + NODE_PAD_BOTTOM : NODE_PAD_BOTTOM;
    const totalH = TITLE_H + bodyH;

    const g = svgEl("g", { class: "flow-node", "data-node-id": node.nodeId, transform: `translate(${pos.x},${pos.y})` }, this.nodesLayer);

    // ── Title bar (colored background) ──
    svgEl("rect", { class: "node-title-bg", x: 0, y: 0, width: NODE_W, height: TITLE_H, rx: 4, ry: 4, fill: color }, g);
    // Square off bottom corners of title bar
    svgEl("rect", { fill: color, x: 0, y: TITLE_H - 4, width: NODE_W, height: 4 }, g);

    // Title text — small, white, truncated
    const titleText = svgEl("text", { class: "node-title", x: 8, y: 15 }, g);
    titleText.textContent = node.label || node.nodeId;

    // Status dot in title bar
    svgEl("circle", { class: "node-status", cx: NODE_W - 10, cy: 11, r: 3 }, g);

    // ── Body (dark background for ports) ──
    svgEl("rect", { class: "node-body", x: 0, y: TITLE_H, width: NODE_W, height: bodyH, rx: 0, ry: 0 }, g);
    // Round bottom corners
    svgEl("rect", { class: "node-body-bottom", x: 0, y: TITLE_H + bodyH - 4, width: NODE_W, height: 4, rx: 4, ry: 4, fill: "var(--node-bg, #1e1e1e)" }, g);

    // ── Sublabel (pluginId — tiny, inside body) ──
    if (node.pluginId || node.lang) {
      const sub = node.pluginId || node.lang || "";
      // Truncate long plugin IDs
      const truncated = sub.length > 28 ? sub.slice(0, 27) + "\u2026" : sub;
      svgEl("text", { class: "node-sublabel", x: NODE_W / 2, y: TITLE_H + bodyH - 2, "text-anchor": "middle" }, g).textContent = truncated;
    }

    // ── Input ports (left side, in body area) ──
    if (node.ports?.inputs) {
      node.ports.inputs.forEach((port, i) => {
        const py = TITLE_H + 10 + i * PORT_ROW_H;
        const circle = svgEl("circle", { class: "port port-in", cx: 0, cy: py, r: PORT_R, "data-port-id": port.id, "data-dir": "input" }, g);
        circle._nodeId = node.nodeId;
        circle._portId = port.id;
        circle._dir = "input";
        svgEl("text", { class: "port-label", x: 8, y: py + 3, "text-anchor": "start" }, g).textContent = port.label || port.id;
      });
    }

    // ── Output ports (right side, in body area) ──
    if (node.ports?.outputs) {
      node.ports.outputs.forEach((port, i) => {
        const py = TITLE_H + 10 + i * PORT_ROW_H;
        const circle = svgEl("circle", { class: "port port-out", cx: NODE_W, cy: py, r: PORT_R, "data-port-id": port.id, "data-dir": "output" }, g);
        circle._nodeId = node.nodeId;
        circle._portId = port.id;
        circle._dir = "output";
        svgEl("text", { class: "port-label", x: NODE_W - 8, y: py + 3, "text-anchor": "end" }, g).textContent = port.label || port.id;
      });
    }

    // ── Outer border (full node outline) ──
    svgEl("rect", { class: "node-outline", x: 0, y: 0, width: NODE_W, height: totalH, rx: 4, ry: 4 }, g);

    this.nodeElements.set(node.nodeId, g);
    this._updatePortPositions(node.nodeId);

    if (this.selectedNodes.has(node.nodeId)) g.classList.add("selected");
    return g;
  }

  _updatePortPositions(nodeId) {
    const node = this.model.nodes.get(nodeId);
    const pos = this.model.editorMeta.nodes[nodeId];
    if (!node || !pos) return;
    if (node.ports?.inputs) {
      node.ports.inputs.forEach((port, i) => {
        this.portPositions.set(`${nodeId}:input:${port.id}`, { x: pos.x, y: pos.y + TITLE_H + 10 + i * PORT_ROW_H });
      });
    }
    if (node.ports?.outputs) {
      node.ports.outputs.forEach((port, i) => {
        this.portPositions.set(`${nodeId}:output:${port.id}`, { x: pos.x + NODE_W, y: pos.y + TITLE_H + 10 + i * PORT_ROW_H });
      });
    }
  }

  // ── Wire Rendering ──

  _renderWire(edge) {
    const from = this.portPositions.get(`${edge.fromNodeId}:output:${edge.fromPortId}`);
    const to = this.portPositions.get(`${edge.toNodeId}:input:${edge.toPortId}`);
    if (!from || !to) return;
    const path = svgEl("path", {
      class: "wire",
      d: bezierWire(from.x, from.y, to.x, to.y),
      "data-edge-id": edge.edgeId,
    }, this.wiresLayer);
    this.wireElements.set(edge.edgeId, path);
  }

  _updateAllWires() {
    for (const [edgeId, edge] of this.model.edges) {
      this._updateWire(edgeId, edge);
    }
  }

  _updateWire(edgeId, edge) {
    const path = this.wireElements.get(edgeId);
    if (!path) return;
    const from = this.portPositions.get(`${edge.fromNodeId}:output:${edge.fromPortId}`);
    const to = this.portPositions.get(`${edge.toNodeId}:input:${edge.toPortId}`);
    if (from && to) {
      path.setAttribute("d", bezierWire(from.x, from.y, to.x, to.y));
    }
  }

  _updateNodeWires(nodeId) {
    for (const [edgeId, edge] of this.model.edges) {
      if (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) {
        this._updateWire(edgeId, edge);
      }
    }
  }

  _clearEdgeSelection() {
    if (this.selectedEdge) {
      this.wireElements.get(this.selectedEdge)?.classList.remove("selected");
      this.selectedEdge = null;
    }
  }

  // ── Transform ──

  _applyTransform() {
    this.viewport.setAttribute("transform", `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
    // Update grid pattern scale
    const bg = this.svg.querySelector(".canvas-bg");
    if (bg) {
      bg.setAttribute("transform", `translate(${this.panX % (20 * this.zoom)},${this.panY % (20 * this.zoom)})`);
    }
  }

  // ── Events ──

  _bindEvents() {
    // Wheel zoom
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const oldZoom = this.zoom;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * delta));
      this.panX = mx - (mx - this.panX) * (this.zoom / oldZoom);
      this.panY = my - (my - this.panY) * (this.zoom / oldZoom);
      this._applyTransform();
    }, { passive: false });

    // Mouse down
    this.svg.addEventListener("mousedown", (e) => {
      const target = e.target;

      // Port drag (wire creation)
      if (target.classList.contains("port")) {
        e.stopPropagation();
        const nodeId = target._nodeId;
        const portId = target._portId;
        const dir = target._dir;
        if (dir === "output") {
          const pos = this.portPositions.get(`${nodeId}:output:${portId}`);
          if (pos) {
            this._drag = { type: "wire", fromNodeId: nodeId, fromPortId: portId, startX: pos.x, startY: pos.y };
            this.tempWire.style.display = "";
            target.classList.add("active");
          }
        }
        return;
      }

      // Node drag
      const nodeG = target.closest(".flow-node");
      if (nodeG) {
        const nodeId = nodeG.dataset.nodeId;
        if (!e.shiftKey && !this.selectedNodes.has(nodeId)) {
          this.selectNode(nodeId);
        } else if (e.shiftKey) {
          this.selectNode(nodeId, true);
        }
        const pos = this.model.editorMeta.nodes[nodeId];
        if (pos) {
          const canvasPos = this.pageToCanvas(e.clientX, e.clientY);
          this._drag = {
            type: "node",
            startMouseX: canvasPos.x,
            startMouseY: canvasPos.y,
            startPositions: new Map([...this.selectedNodes].map(id => [id, { ...this.model.editorMeta.nodes[id] }])),
          };
        }
        return;
      }

      // Wire selection
      if (target.classList.contains("wire") && !target.classList.contains("temp")) {
        const edgeId = target.dataset.edgeId;
        this.deselectAll();
        this.selectedEdge = edgeId;
        target.classList.add("selected");
        this._onEdgeSelect?.(edgeId);
        return;
      }

      // Pan (middle button or canvas background)
      if (e.button === 1 || (e.button === 0 && (target === this.svg || target.classList.contains("canvas-bg")))) {
        if (e.button === 0 && !e.ctrlKey && !e.metaKey) {
          // Selection rectangle
          this.deselectAll();
          this._drag = { type: "select", startX: e.clientX, startY: e.clientY };
        } else {
          this._drag = { type: "pan", startX: e.clientX, startY: e.clientY, startPanX: this.panX, startPanY: this.panY };
        }
      }
    });

    // Mouse move
    window.addEventListener("mousemove", (e) => {
      if (!this._drag) return;

      if (this._drag.type === "node") {
        const canvasPos = this.pageToCanvas(e.clientX, e.clientY);
        const dx = canvasPos.x - this._drag.startMouseX;
        const dy = canvasPos.y - this._drag.startMouseY;
        for (const [nodeId, startPos] of this._drag.startPositions) {
          const x = snap(startPos.x + dx);
          const y = snap(startPos.y + dy);
          this.model.editorMeta.nodes[nodeId] = { ...this.model.editorMeta.nodes[nodeId], x, y };
          this.nodeElements.get(nodeId)?.setAttribute("transform", `translate(${x},${y})`);
          this._updatePortPositions(nodeId);
          this._updateNodeWires(nodeId);
        }
      } else if (this._drag.type === "wire") {
        const canvasPos = this.pageToCanvas(e.clientX, e.clientY);
        this.tempWire.setAttribute("d", bezierWire(this._drag.startX, this._drag.startY, canvasPos.x, canvasPos.y));
      } else if (this._drag.type === "pan") {
        this.panX = this._drag.startPanX + (e.clientX - this._drag.startX);
        this.panY = this._drag.startPanY + (e.clientY - this._drag.startY);
        this._applyTransform();
      } else if (this._drag.type === "select") {
        const selectRect = document.getElementById("select-rect");
        const x1 = Math.min(this._drag.startX, e.clientX);
        const y1 = Math.min(this._drag.startY, e.clientY);
        const w = Math.abs(e.clientX - this._drag.startX);
        const h = Math.abs(e.clientY - this._drag.startY);
        selectRect.style.display = "";
        selectRect.style.left = `${x1}px`;
        selectRect.style.top = `${y1}px`;
        selectRect.style.width = `${w}px`;
        selectRect.style.height = `${h}px`;
      }
    });

    // Mouse up
    window.addEventListener("mouseup", (e) => {
      if (!this._drag) return;

      if (this._drag.type === "node") {
        // Persist positions to model
        for (const nodeId of this.selectedNodes) {
          const pos = this.model.editorMeta.nodes[nodeId];
          if (pos) this.model.moveNode(nodeId, pos.x, pos.y);
        }
      } else if (this._drag.type === "wire") {
        this.tempWire.style.display = "none";
        this.tempWire.setAttribute("d", "");
        // Remove active class from all ports
        this.svg.querySelectorAll(".port.active").forEach(p => p.classList.remove("active"));
        // Find target port
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (target?.classList.contains("port") && target._dir === "input") {
          this.model.addEdge({
            fromNodeId: this._drag.fromNodeId,
            fromPortId: this._drag.fromPortId,
            toNodeId: target._nodeId,
            toPortId: target._portId,
          });
        }
      } else if (this._drag.type === "select") {
        const selectRect = document.getElementById("select-rect");
        selectRect.style.display = "none";
        // Select nodes in rectangle
        const rect = {
          x1: Math.min(this._drag.startX, e.clientX),
          y1: Math.min(this._drag.startY, e.clientY),
          x2: Math.max(this._drag.startX, e.clientX),
          y2: Math.max(this._drag.startY, e.clientY),
        };
        for (const [nodeId, el] of this.nodeElements) {
          const bbox = el.getBoundingClientRect();
          if (bbox.left >= rect.x1 && bbox.right <= rect.x2 && bbox.top >= rect.y1 && bbox.bottom <= rect.y2) {
            this.selectNode(nodeId, true);
          }
        }
      }

      this._drag = null;
    });

    // Delete key
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.target.closest("#editor-container")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.selectedEdge) {
          this.model.removeEdge(this.selectedEdge);
          this.selectedEdge = null;
        }
        if (this.selectedNodes.size > 0) {
          for (const nodeId of [...this.selectedNodes]) {
            this.model.removeNode(nodeId);
          }
          this.selectedNodes.clear();
          this._onNodeSelect?.(null);
        }
      }
      // Ctrl+A select all
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !e.target.closest("#editor-container")) {
        e.preventDefault();
        for (const nodeId of this.model.nodes.keys()) {
          this.selectNode(nodeId, true);
        }
      }
    });

    // Double-click node → load plugin metadata
    this.svg.addEventListener("dblclick", (e) => {
      const nodeG = e.target.closest(".flow-node");
      if (nodeG) {
        const nodeId = nodeG.dataset.nodeId;
        this._onNodeDblClick?.(nodeId);
      }
    });

    // Drop from palette
    this.svg.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    this.svg.addEventListener("drop", (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("text/x-sdn-kind");
      const lang = e.dataTransfer.getData("text/x-sdn-lang") || null;
      if (!kind) return;
      const pos = this.pageToCanvas(e.clientX, e.clientY);
      const node = this.model.addNode({
        kind,
        lang,
        x: snap(pos.x),
        y: snap(pos.y),
        label: lang ? `${lang}-module` : kind,
      });
      this.selectNode(node.nodeId);
    });
  }

  _bindModelEvents() {
    this.model.addEventListener("node-add", (e) => {
      this._renderNode(e.detail.node);
    });
    this.model.addEventListener("node-remove", (e) => {
      const el = this.nodeElements.get(e.detail.nodeId);
      if (el) { el.remove(); this.nodeElements.delete(e.detail.nodeId); }
    });
    this.model.addEventListener("node-update", (e) => {
      // Re-render node
      const el = this.nodeElements.get(e.detail.node.nodeId);
      if (el) {
        el.remove();
        this.nodeElements.delete(e.detail.node.nodeId);
      }
      this._renderNode(e.detail.node);
      this._updateNodeWires(e.detail.node.nodeId);
    });
    this.model.addEventListener("edge-add", (e) => {
      this._renderWire(e.detail.edge);
    });
    this.model.addEventListener("edge-remove", (e) => {
      const el = this.wireElements.get(e.detail.edgeId);
      if (el) { el.remove(); this.wireElements.delete(e.detail.edgeId); }
    });
    this.model.addEventListener("load", () => this.rebuild());
    this.model.addEventListener("clear", () => this.rebuild());
  }
}
