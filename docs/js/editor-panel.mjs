/**
 * editor-panel.mjs — Lightweight generated-source viewer for the hosted editor.
 *
 * The runtime ships as embedded assets, so this panel stays self-contained and
 * avoids CDN-hosted editor dependencies. It exposes the same minimal surface as
 * the previous Monaco wrapper because the rest of the app only needs a
 * read-only generated-source view.
 */

const LANG_LABELS = {
  cpp: "C++",
  c: "C",
  python: "Python",
  typescript: "TypeScript",
  javascript: "JavaScript",
  rust: "Rust",
  go: "Go",
  json: "JSON",
  yaml: "YAML",
};

export class EditorPanel {
  constructor(containerId, langBadgeId = null) {
    this.containerId = containerId;
    this.langBadgeId = langBadgeId;
    this.editor = null;
    this._currentNodeId = null;
    this._model = null;
    this._source = "";
    this._initPromise = this._init();
  }

  async _init() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      throw new Error(`Editor container not found: ${this.containerId}`);
    }
    container.innerHTML = "";
    const shell = document.createElement("div");
    shell.className = "code-viewer";

    const gutter = document.createElement("div");
    gutter.className = "code-viewer-gutter";

    const pre = document.createElement("pre");
    pre.className = "code-viewer-content";
    pre.textContent = "";

    shell.append(gutter, pre);
    container.appendChild(shell);

    this.editor = {
      shell,
      gutter,
      pre,
    };
    this._render();
  }

  async ready() {
    return this._initPromise;
  }

  bindModel(model) {
    this._model = model;
  }

  setNode(nodeId) {
    this._currentNodeId = nodeId;
  }

  setGeneratedSource(source, language = "cpp") {
    this._source = typeof source === "string" ? source : "";
    this._language = language;
    this._render();
  }

  getValue() {
    return this._source;
  }

  layout() {}

  _render() {
    if (!this.editor) {
      return;
    }
    const source = this._source || "";
    const lines = source.split("\n");
    this.editor.pre.textContent = source;
    this.editor.gutter.innerHTML = lines
      .map((_, index) => `<span>${index + 1}</span>`)
      .join("");

    const badge = this.langBadgeId
      ? document.getElementById(this.langBadgeId)
      : null;
    if (badge) {
      badge.textContent = LANG_LABELS[this._language] || (this._language || "Text");
    }
  }
}
