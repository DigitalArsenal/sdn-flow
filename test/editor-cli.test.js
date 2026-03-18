import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  formatSdnFlowEditorUsage,
  parseSdnFlowEditorCliArgs,
  runSdnFlowEditorCli,
} from "../bin/sdn-flow-editor.js";

test("parseSdnFlowEditorCliArgs supports host, port, base path, flow, and help", () => {
  assert.deepEqual(
    parseSdnFlowEditorCliArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "9090",
      "--base-path",
      "/editor",
      "--flow",
      "./flow.json",
      "--title",
      "Demo",
    ]),
    {
      hostname: "0.0.0.0",
      port: 9090,
      basePath: "/editor",
      flowPath: "./flow.json",
      title: "Demo",
      help: false,
    },
  );

  assert.deepEqual(parseSdnFlowEditorCliArgs(["--help"]), {
    hostname: "127.0.0.1",
    port: 8080,
    basePath: "/",
    flowPath: null,
    title: null,
    help: true,
  });
});

test("formatSdnFlowEditorUsage documents the editor CLI flags", () => {
  const usage = formatSdnFlowEditorUsage();
  assert.match(usage, /--base-path <path>/);
  assert.match(usage, /--flow <flow\.json>/);
});

test("runSdnFlowEditorCli loads an initial flow and starts the Node editor host", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-"));
  const flowPath = path.join(tempDir, "flow.json");
  await fs.writeFile(
    flowPath,
    JSON.stringify({
      name: "CLI Flow",
      nodes: [],
      edges: [],
    }),
    "utf8",
  );

  const logs = [];
  const calls = [];

  try {
    const result = await runSdnFlowEditorCli(
      [
        "--host",
        "127.0.0.1",
        "--port",
        "9001",
        "--base-path",
        "/editor",
        "--flow",
        flowPath,
        "--title",
        "CLI Editor",
      ],
      {
        log(message) {
          logs.push(message);
        },
        registerSignalHandlers: false,
        startEditorHost: async (options) => {
          calls.push(options);
          return {
            url: "http://127.0.0.1:9001/editor",
            async close() {},
          };
        },
      },
    );

    assert.equal(result.kind, "started");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, "127.0.0.1");
    assert.equal(calls[0].port, 9001);
    assert.equal(calls[0].basePath, "/editor");
    assert.equal(calls[0].title, "CLI Editor");
    assert.equal(calls[0].initialFlow.name, "CLI Flow");
    assert.match(logs[0], /Started sdn-flow editor/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
