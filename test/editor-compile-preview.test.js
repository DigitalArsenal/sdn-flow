import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertNodeRedFlowsToSdnProgram } from "../src/editor/compilePreview.js";
import { resolveSdnFlowEditorCompilePreviewScriptPath } from "../src/editor/compilePreviewSubprocess.js";

test("convertNodeRedFlowsToSdnProgram lowers inject bindings, runtime nodes, and warnings", () => {
  const { program, warnings } = convertNodeRedFlowsToSdnProgram([
    {
      id: "tab-1",
      type: "tab",
      label: "Main Flow",
      disabled: false,
      info: "preview flow",
    },
    {
      id: "inject-1",
      z: "tab-1",
      type: "inject",
      name: "tick",
      repeat: "2.5",
      x: 80,
      y: 80,
      wires: [["fn-1"]],
    },
    {
      id: "fn-1",
      z: "tab-1",
      type: "function",
      x: 220,
      y: 80,
      wires: [["debug-1"]],
    },
    {
      id: "debug-1",
      z: "tab-1",
      type: "debug",
      x: 380,
      y: 80,
      wires: [],
    },
    {
      id: "config-1",
      type: "tls-config",
      name: "ignored config node",
    },
  ]);

  assert.equal(program.programId, "main-flow");
  assert.equal(program.name, "Main Flow");
  assert.equal(program.description, "preview flow");
  assert.equal(program.triggers.length, 1);
  assert.equal(program.triggers[0].kind, "timer");
  assert.equal(program.triggers[0].defaultIntervalMs, 2500);
  assert.equal(program.triggerBindings.length, 1);
  assert.equal(program.triggerBindings[0].targetNodeId, "fn-1");
  assert.equal(program.nodes.length, 2);
  assert.deepEqual(
    program.nodes.map((node) => node.pluginId),
    [
      "com.digitalarsenal.editor.function",
      "com.digitalarsenal.editor.debug",
    ],
  );
  assert.equal(program.edges.length, 1);
  assert.deepEqual(program.edges[0], {
    edgeId: "edge-fn-1-1-debug-1",
    fromNodeId: "fn-1",
    fromPortId: "out",
    toNodeId: "debug-1",
    toPortId: "in",
  });
  assert.deepEqual(program.requiredPlugins, [
    "com.digitalarsenal.editor.debug",
    "com.digitalarsenal.editor.function",
  ]);
  assert.deepEqual(program.editor.nodes["fn-1"], {
    x: 220,
    y: 80,
    type: "function",
    config: {},
  });
  assert.deepEqual(program.editor.nodes["inject-1"], {
    x: 80,
    y: 80,
    type: "inject",
    config: {
      name: "tick",
      repeat: "2.5",
    },
  });
  assert.match(warnings[0], /Ignored config node/);
});

test("convertNodeRedFlowsToSdnProgram lowers http in nodes into HTTP triggers", () => {
  const { program, warnings } = convertNodeRedFlowsToSdnProgram([
    {
      id: "tab-1",
      type: "tab",
      label: "HTTP Flow",
    },
    {
      id: "http-in-1",
      z: "tab-1",
      type: "http in",
      method: "post",
      url: "/widgets/:widgetId",
      x: 80,
      y: 80,
      wires: [["fn-1"]],
    },
    {
      id: "fn-1",
      z: "tab-1",
      type: "function",
      x: 220,
      y: 80,
      wires: [["http-response-1"]],
    },
    {
      id: "http-response-1",
      z: "tab-1",
      type: "http response",
      x: 380,
      y: 80,
      wires: [],
    },
  ]);

  assert.equal(warnings.length, 0);
  assert.deepEqual(program.triggers, [
    {
      triggerId: "trigger-http-in-1",
      kind: "http-request",
      source: "/widgets/:widgetId",
      description: "[POST] /widgets/:widgetId",
    },
  ]);
  assert.deepEqual(program.triggerBindings, [
    {
      triggerId: "trigger-http-in-1",
      targetNodeId: "fn-1",
      targetPortId: "in",
    },
  ]);
  assert.deepEqual(
    program.nodes.map((node) => ({
      nodeId: node.nodeId,
      pluginId: node.pluginId,
      methodId: node.methodId,
    })),
    [
      {
        nodeId: "fn-1",
        pluginId: "com.digitalarsenal.editor.function",
        methodId: "invoke",
      },
      {
        nodeId: "http-response-1",
        pluginId: "com.digitalarsenal.flow.http-response",
        methodId: "send",
      },
    ],
  );
  assert.deepEqual(program.edges, [
    {
      edgeId: "edge-fn-1-1-http-response-1",
      fromNodeId: "fn-1",
      fromPortId: "out",
      toNodeId: "http-response-1",
      toPortId: "response",
    },
  ]);
});

test("compile preview subprocess always resolves the packaged helper script", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-preview-script-"));
  const scriptPath = path.join(tempDir, "scripts", "editor-compile-preview.mjs");
  const packagedScriptPath = fileURLToPath(
    new URL("../scripts/editor-compile-preview.mjs", import.meta.url),
  );

  try {
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "export {};\n", "utf8");

    assert.equal(
      resolveSdnFlowEditorCompilePreviewScriptPath({
        cwd: tempDir,
      }),
      packagedScriptPath,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
