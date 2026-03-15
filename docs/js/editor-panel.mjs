/**
 * editor-panel.mjs — Monaco editor integration with multi-language
 * intellisense for C++, Python, TypeScript, JavaScript, Rust, Go, etc.
 */

// Language ID mapping for Monaco
const LANG_MAP = {
  cpp: "cpp",
  c: "c",
  python: "python",
  typescript: "typescript",
  javascript: "javascript",
  rust: "rust",
  go: "go",
  json: "json",
  yaml: "yaml",
};

// Emscripten C++ completion items
const EMSCRIPTEN_COMPLETIONS = [
  { label: "EM_JS", kind: "Function", detail: "Inline JavaScript in C++ (Emscripten)", insertText: 'EM_JS(${1:return_type}, ${2:name}, (${3:args}), {\n  ${4}\n})' },
  { label: "EM_ASM", kind: "Function", detail: "Execute JavaScript (Emscripten)", insertText: 'EM_ASM({\n  ${1}\n})' },
  { label: "EMSCRIPTEN_KEEPALIVE", kind: "Keyword", detail: "Prevent dead-code elimination", insertText: "EMSCRIPTEN_KEEPALIVE" },
  { label: "emscripten_run_script", kind: "Function", detail: "Run JavaScript string", insertText: 'emscripten_run_script("${1}")' },
  { label: "emscripten_get_now", kind: "Function", detail: "High-resolution timer (ms)", insertText: "emscripten_get_now()" },
  { label: "WASM_EXPORT", kind: "Keyword", detail: 'extern "C" export', insertText: 'extern "C" EMSCRIPTEN_KEEPALIVE' },
];

// FlatBuffer C++ completions
const FLATBUFFER_CPP_COMPLETIONS = [
  { label: "flatbuffers::FlatBufferBuilder", kind: "Class", detail: "FlatBuffer builder", insertText: "flatbuffers::FlatBufferBuilder ${1:builder}(${2:1024})" },
  { label: "flatbuffers::GetRoot", kind: "Function", detail: "Get root object from buffer", insertText: "flatbuffers::GetRoot<${1:Type}>(${2:buf})" },
  { label: "flatbuffers::Verifier", kind: "Class", detail: "FlatBuffer verifier", insertText: "flatbuffers::Verifier ${1:verifier}(${2:buf}, ${3:size})" },
  { label: "CreateString", kind: "Function", detail: "Create FlatBuffer string", insertText: "${1:builder}.CreateString(${2:str})" },
  { label: "Finish", kind: "Function", detail: "Finish building buffer", insertText: "${1:builder}.Finish(${2:offset})" },
  { label: "GetBufferPointer", kind: "Function", detail: "Get raw buffer pointer", insertText: "${1:builder}.GetBufferPointer()" },
  { label: "GetSize", kind: "Function", detail: "Get buffer size", insertText: "${1:builder}.GetSize()" },
];

// SDN-Flow Python completions (Pyodide context)
const PYTHON_SDN_COMPLETIONS = [
  { label: "import flatbuffers", kind: "Module", insertText: "import flatbuffers" },
  { label: "from flatbuffers import Builder", kind: "Module", insertText: "from flatbuffers import Builder" },
  { label: "Builder", kind: "Class", detail: "FlatBuffer builder", insertText: "Builder(${1:initial_size})" },
  { label: "process", kind: "Function", detail: "SDN flow process function", insertText: 'def process(input_bytes: bytes) -> bytes:\n    """Process a FlatBuffer frame."""\n    ${1:pass}\n' },
  { label: "pybind11_module", kind: "Snippet", detail: "pybind11 module template", insertText: '#include <pybind11/pybind11.h>\nnamespace py = pybind11;\n\nint process(py::bytes input) {\n    ${1}\n    return 0;\n}\n\nPYBIND11_MODULE(${2:module_name}, m) {\n    m.def("process", &process);\n}\n' },
];

export class EditorPanel {
  constructor(containerId, langSelectId) {
    this.containerId = containerId;
    this.langSelectId = langSelectId;
    this.editor = null;
    this.monaco = null;
    this._currentNodeId = null;
    this._model = null;
    this._suppressChange = false;
    this._initPromise = this._init();
  }

  async _init() {
    return new Promise((resolve) => {
      // AMD require for Monaco from CDN
      require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
      require(["vs/editor/editor.main"], (monaco) => {
        this.monaco = monaco;

        // Configure themes
        monaco.editor.defineTheme("sdn-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "comment", foreground: "6A9955" },
            { token: "keyword", foreground: "569CD6" },
            { token: "string", foreground: "CE9178" },
            { token: "number", foreground: "B5CEA8" },
            { token: "type", foreground: "4EC9B0" },
          ],
          colors: {
            "editor.background": "#1e1e1e",
            "editor.foreground": "#d4d4d4",
            "editorLineNumber.foreground": "#858585",
            "editor.selectionBackground": "#264f78",
            "editor.lineHighlightBackground": "#2a2d2e",
          },
        });

        // Create editor
        this.editor = monaco.editor.create(document.getElementById(this.containerId), {
          value: "",
          language: "cpp",
          theme: "sdn-dark",
          fontSize: 13,
          fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
          fontLigatures: true,
          minimap: { enabled: true, maxColumn: 80 },
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          tabSize: 4,
          insertSpaces: true,
          automaticLayout: true,
          wordWrap: "off",
          lineNumbers: "on",
          glyphMargin: true,
          folding: true,
          bracketPairColorization: { enabled: true },
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          parameterHints: { enabled: true },
          formatOnPaste: true,
          formatOnType: true,
        });

        // Register completion providers
        this._registerCompletions(monaco);

        // Language select binding
        const langSelect = document.getElementById(this.langSelectId);
        if (langSelect) {
          langSelect.addEventListener("change", () => {
            const lang = LANG_MAP[langSelect.value] || langSelect.value;
            monaco.editor.setModelLanguage(this.editor.getModel(), lang);
            if (this._currentNodeId && this._model) {
              this._model.updateNode(this._currentNodeId, { lang: langSelect.value });
            }
          });
        }

        // Content change → update model
        this.editor.onDidChangeModelContent(() => {
          if (this._suppressChange) return;
          if (this._currentNodeId && this._model) {
            this._model.updateNode(this._currentNodeId, { source: this.editor.getValue() });
          }
        });

        resolve();
      });
    });
  }

  async ready() { return this._initPromise; }

  bindModel(model) {
    this._model = model;
  }

  setNode(nodeId) {
    this._currentNodeId = nodeId;
    if (!nodeId || !this._model) {
      this._suppressChange = true;
      this.editor?.setValue("");
      this._suppressChange = false;
      return;
    }
    const node = this._model.nodes.get(nodeId);
    if (!node) return;

    this._suppressChange = true;
    this.editor.setValue(node.source || "");
    this._suppressChange = false;

    // Set language
    if (node.lang && this.monaco) {
      const lang = LANG_MAP[node.lang] || node.lang;
      this.monaco.editor.setModelLanguage(this.editor.getModel(), lang);
      const langSelect = document.getElementById(this.langSelectId);
      if (langSelect) langSelect.value = node.lang;
    }
  }

  getValue() {
    return this.editor?.getValue() || "";
  }

  layout() {
    this.editor?.layout();
  }

  _registerCompletions(monaco) {
    // C++ completions for Emscripten + FlatBuffers
    monaco.languages.registerCompletionItemProvider("cpp", {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: [...EMSCRIPTEN_COMPLETIONS, ...FLATBUFFER_CPP_COMPLETIONS].map(item => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind[item.kind] || monaco.languages.CompletionItemKind.Text,
            detail: item.detail || "",
            insertText: item.insertText,
            insertTextRules: item.insertText.includes("$") ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range,
          })),
        };
      },
    });

    // Python completions for SDN flow
    monaco.languages.registerCompletionItemProvider("python", {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: PYTHON_SDN_COMPLETIONS.map(item => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind[item.kind] || monaco.languages.CompletionItemKind.Text,
            detail: item.detail || "",
            insertText: item.insertText,
            insertTextRules: item.insertText.includes("$") ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range,
          })),
        };
      },
    });
  }
}
