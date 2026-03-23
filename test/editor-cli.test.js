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

test("parseSdnFlowEditorCliArgs supports host, port, base path, flow, session file, and help", () => {
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
      "--session-file",
      "./session.json",
      "--title",
      "Demo",
    ]),
    {
      hostname: "0.0.0.0",
      port: 9090,
      basePath: "/editor",
      flowPath: "./flow.json",
      sessionFile: "./session.json",
      title: "Demo",
      help: false,
    },
  );

  assert.deepEqual(parseSdnFlowEditorCliArgs(["--help"]), {
    hostname: "127.0.0.1",
    port: 1990,
    basePath: "/",
    flowPath: null,
    sessionFile: null,
    title: null,
    help: true,
  });
});

test("formatSdnFlowEditorUsage documents the editor CLI flags", () => {
  const usage = formatSdnFlowEditorUsage();
  assert.match(usage, /--base-path <path>/);
  assert.match(usage, /--flow <flow\.json>/);
  assert.match(usage, /--session-file <path>/);
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
        projectRoot: tempDir,
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
    assert.equal(calls[0].initialFlow[0].type, "tab");
    assert.equal(calls[0].initialFlow[0].label, "CLI Flow");
    assert.match(logs[0], /Started sdn-flow editor/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runSdnFlowEditorCli uses persisted runtime settings when explicit flags are omitted", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-settings-cli-"));
  const settingsDir = path.join(tempDir, "generated-tools", ".runtime");
  const calls = [];

  try {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "editor-settings.json"),
      JSON.stringify(
        {
          kind: "sdn-flow-editor-settings",
          version: 1,
          startup: {
            hostname: "127.0.0.1",
            port: 18181,
            basePath: "/editor",
            title: "Persisted Editor",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runSdnFlowEditorCli([], {
      projectRoot: tempDir,
      quiet: true,
      registerSignalHandlers: false,
      startEditorHost: async (options) => {
        calls.push(options);
        return {
          url: "http://127.0.0.1:18181/editor/",
          async close() {},
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].port, 18181);
    assert.equal(calls[0].basePath, "/editor");
    assert.equal(calls[0].title, "Persisted Editor");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runSdnFlowEditorCli migrates the legacy implicit 8080 runtime default to 1990", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-legacy-settings-cli-"));
  const settingsDir = path.join(tempDir, "generated-tools", ".runtime");
  const settingsPath = path.join(settingsDir, "editor-settings.json");
  const calls = [];

  try {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          kind: "sdn-flow-editor-settings",
          version: 1,
          startup: {
            hostname: "127.0.0.1",
            port: 8080,
            basePath: "/",
            title: "sdn-flow Editor",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runSdnFlowEditorCli([], {
      projectRoot: tempDir,
      quiet: true,
      registerSignalHandlers: false,
      startEditorHost: async (options) => {
        calls.push(options);
        return {
          url: "http://127.0.0.1:1990/",
          async close() {},
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].port, 1990);
    const rewrittenSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(rewrittenSettings.startup.port, 1990);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
