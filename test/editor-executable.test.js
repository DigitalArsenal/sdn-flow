import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import {
  buildSdnFlowEditorExecutable,
  extractSdnFlowEditorStartedUrl,
  formatSdnFlowEditorExecutableUsage,
  getSdnFlowEditorExecutableName,
  getSdnFlowEditorExecutablePath,
  launchSdnFlowEditorExecutable,
  parseSdnFlowEditorExecutableArgs,
} from "../scripts/editor-executable.mjs";

test("parseSdnFlowEditorExecutableArgs keeps wrapper flags separate from editor args", () => {
  assert.deepEqual(
    parseSdnFlowEditorExecutableArgs([
      "start",
      "--output",
      "./dist/editor",
      "--no-open",
      "--",
      "--port",
      "9090",
      "--flow",
      "./flow.json",
    ]),
    {
      command: "start",
      outputPath: "./dist/editor",
      openBrowser: false,
      buildOnly: false,
      help: false,
      editorArgs: ["--port", "9090", "--flow", "./flow.json"],
    },
  );

  assert.deepEqual(parseSdnFlowEditorExecutableArgs(["build"]), {
    command: "build",
    outputPath: null,
    openBrowser: true,
    buildOnly: true,
    help: false,
    editorArgs: [],
  });
});

test("editor executable helpers format expected names and usage", () => {
  assert.equal(getSdnFlowEditorExecutableName("darwin"), "sdn-flow-editor");
  assert.equal(getSdnFlowEditorExecutableName("win32"), "sdn-flow-editor.exe");
  assert.equal(
    getSdnFlowEditorExecutablePath({
      projectRoot: "/tmp/project",
      platform: "linux",
    }),
    path.join("/tmp/project", "generated-tools", "sdn-flow-editor"),
  );
  assert.match(formatSdnFlowEditorExecutableUsage(), /npm run start -- --port 9090/);
});

test("extractSdnFlowEditorStartedUrl finds the launched editor URL", () => {
  assert.equal(
    extractSdnFlowEditorStartedUrl("Built...\nStarted sdn-flow editor at http://127.0.0.1:8080/\n"),
    "http://127.0.0.1:8080/",
  );
  assert.equal(extractSdnFlowEditorStartedUrl("no match"), null);
});

test("buildSdnFlowEditorExecutable runs asset build and Deno compile", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-build-"));
  const denoDir = path.join(tempDir, "node_modules", ".bin");
  const calls = [];

  try {
    await fs.mkdir(denoDir, { recursive: true });
    await fs.writeFile(path.join(denoDir, "deno"), "#!/bin/sh\n", "utf8");

    const result = await buildSdnFlowEditorExecutable({
      projectRoot: tempDir,
      platform: "linux",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
      },
    });

    assert.equal(result.outputPath, path.join(tempDir, "generated-tools", "sdn-flow-editor"));
    assert.deepEqual(calls, [
      {
        command: "npm",
        args: ["run", "build:editor-assets"],
        cwd: tempDir,
      },
      {
        command: path.join(tempDir, "node_modules", ".bin", "deno"),
        args: [
          "compile",
          "--allow-net",
          "--allow-read",
          "--output",
          path.join(tempDir, "generated-tools", "sdn-flow-editor"),
          "./tools/sdn-flow-editor.ts",
        ],
        cwd: tempDir,
      },
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("launchSdnFlowEditorExecutable relays output and opens the browser when startup URL appears", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-launch-"));
  const outputPath = path.join(tempDir, "generated-tools", "sdn-flow-editor");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emittedStdout = [];
  const openedUrls = [];

  stdout.on("data", (chunk) => {
    emittedStdout.push(String(chunk));
  });

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killed = false;
    }

    kill() {
      this.killed = true;
    }
  }

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, "placeholder", "utf8");

    const child = new FakeChild();
    const launch = await launchSdnFlowEditorExecutable({
      projectRoot: tempDir,
      outputPath,
      editorArgs: ["--port", "9000"],
      stdout,
      stderr,
      spawnProcess(executablePath, args, options) {
        assert.equal(executablePath, outputPath);
        assert.deepEqual(args, ["--port", "9000"]);
        assert.equal(options.cwd, tempDir);
        return child;
      },
      async openUrl(url) {
        openedUrls.push(url);
      },
    });

    child.stdout.write("Started sdn-flow editor at http://127.0.0.1:9000/\n");
    child.stdout.end();
    child.emit("close", 0, null);

    const exit = await launch.exitPromise;
    assert.equal(exit.code, 0);
    assert.deepEqual(openedUrls, ["http://127.0.0.1:9000/"]);
    assert.match(emittedStdout.join(""), /Started sdn-flow editor/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
