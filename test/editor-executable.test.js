import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import {
  buildSdnFlowEditorExecutable,
  extractSdnFlowEditorStartedUrl,
  formatSdnFlowEditorExecutableUsage,
  getSdnFlowEditorExecutableName,
  getSdnFlowEditorExecutablePath,
  launchSdnFlowEditorExecutable,
  parseSdnFlowEditorExecutableArgs,
  prepareStagedSdnFlowEditorWorkspace,
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
    extractSdnFlowEditorStartedUrl("Built...\nStarted sdn-flow editor at http://127.0.0.1:1990/\n"),
    "http://127.0.0.1:1990/",
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
      prepareCompileWorkspace: async () => ({
        cwd: tempDir,
        entryPath: "./tools/sdn-flow-editor.ts",
      }),
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
      },
    });

    assert.equal(result.outputPath, path.join(tempDir, "generated-tools", "sdn-flow-editor"));
    assert.deepEqual(calls, [
      {
        command: "npm",
        args: ["run", "build:shared-runtime-constants"],
        cwd: tempDir,
      },
      {
        command: "npm",
        args: ["run", "build:editor-assets"],
        cwd: tempDir,
      },
      {
        command: path.join(tempDir, "node_modules", ".bin", "deno"),
        args: [
          "compile",
          "--no-check",
          "--allow-net",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "--allow-env",
          "--allow-sys",
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

test("prepareStagedSdnFlowEditorWorkspace copies imported packages with transitive runtime deps", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-stage-"));

  try {
    await fs.mkdir(path.join(tempDir, "tools"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "tools", "sdn-flow-editor.ts"), "export {};\n", "utf8");
    await fs.writeFile(path.join(tempDir, "src", "runtime.js"), "export const value = 1;\n", "utf8");

    const packageSpecs = [
      ["xml2js", { dependencies: { sax: "^1.0.0", xmlbuilder: "^11.0.0" } }],
      ["sax", { dependencies: {} }],
      ["xmlbuilder", { dependencies: {} }],
    ];
    for (const [packageName, packageJson] of packageSpecs) {
      const packageDir = path.join(tempDir, "node_modules", ...packageName.split("/"));
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
        name: packageName,
        version: "1.0.0",
        ...packageJson,
      }, null, 2), "utf8");
      await fs.writeFile(path.join(packageDir, "index.js"), `module.exports = ${JSON.stringify(packageName)};\n`, "utf8");
    }

    const graph = {
      modules: [
        {
          specifier: pathToFileURL(path.join(tempDir, "tools", "sdn-flow-editor.ts")).href,
        },
        {
          specifier: pathToFileURL(path.join(tempDir, "src", "runtime.js")).href,
        },
        {
          specifier: pathToFileURL(path.join(tempDir, "node_modules", "xml2js", "index.js")).href,
        },
      ],
    };

    const workspace = await prepareStagedSdnFlowEditorWorkspace({
      projectRoot: tempDir,
      denoBinaryPath: "/bin/deno",
      runCommandCapture: async () => ({
        stdout: JSON.stringify(graph),
        stderr: "",
      }),
    });

    await assert.doesNotReject(fs.access(path.join(workspace.stageDir, "src", "runtime.js")));
    await assert.doesNotReject(fs.access(path.join(workspace.stageDir, "node_modules", "xml2js", "index.js")));
    await assert.doesNotReject(fs.access(path.join(workspace.stageDir, "node_modules", "sax", "index.js")));
    await assert.doesNotReject(fs.access(path.join(workspace.stageDir, "node_modules", "xmlbuilder", "index.js")));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("prepareStagedSdnFlowEditorWorkspace stages local file dependencies used through package export subpaths", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-local-stage-"));
  const projectRoot = path.join(workspaceRoot, "sdn-flow");
  const sdkRoot = path.join(workspaceRoot, "space-data-module-sdk");

  try {
    await fs.mkdir(path.join(projectRoot, "tools"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "node_modules", "space-data-module-sdk"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectRoot, "node_modules", "flatbuffers"), {
      recursive: true,
    });
    await fs.mkdir(path.join(sdkRoot, "src", "compliance"), { recursive: true });
    await fs.mkdir(path.join(sdkRoot, "src", "runtime"), { recursive: true });
    await fs.mkdir(path.join(sdkRoot, "src", "unused"), { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(
        {
          name: "sdn-flow-test-project",
          private: true,
          type: "module",
          dependencies: {
            "space-data-module-sdk": "file:../space-data-module-sdk",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(projectRoot, "tools", "sdn-flow-editor.ts"), "export {};\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "src", "runtime.js"), "export const value = 1;\n", "utf8");

    const sdkPackageJson = {
      name: "space-data-module-sdk",
      version: "1.0.0",
      type: "module",
      exports: {
        "./compliance": "./src/compliance/index.js",
      },
      dependencies: {
        flatbuffers: "^1.0.0",
      },
    };
    await fs.writeFile(path.join(sdkRoot, "package.json"), JSON.stringify(sdkPackageJson, null, 2), "utf8");
    await fs.writeFile(
      path.join(projectRoot, "node_modules", "space-data-module-sdk", "package.json"),
      JSON.stringify(sdkPackageJson, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(sdkRoot, "src", "compliance", "index.js"),
      'export { value } from "./pluginCompliance.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(sdkRoot, "src", "compliance", "pluginCompliance.js"),
      'export const value = "ok";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(sdkRoot, "src", "runtime", "constants.js"),
      'export const runtimeConstant = "runtime";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(sdkRoot, "src", "unused", "ignored.js"),
      'export const ignored = true;\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "node_modules", "flatbuffers", "package.json"),
      JSON.stringify({
        name: "flatbuffers",
        version: "1.0.0",
        dependencies: {},
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "node_modules", "flatbuffers", "index.js"),
      'module.exports = "flatbuffers";\n',
      "utf8",
    );

    const graph = {
      modules: [
        {
          specifier: pathToFileURL(path.join(projectRoot, "tools", "sdn-flow-editor.ts")).href,
        },
        {
          specifier: pathToFileURL(path.join(projectRoot, "src", "runtime.js")).href,
        },
        {
          specifier: pathToFileURL(path.join(sdkRoot, "src", "compliance", "index.js")).href,
        },
        {
          specifier: pathToFileURL(path.join(sdkRoot, "src", "compliance", "pluginCompliance.js")).href,
        },
        {
          specifier: pathToFileURL(path.join(sdkRoot, "src", "runtime", "constants.js")).href,
        },
      ],
    };

    const workspace = await prepareStagedSdnFlowEditorWorkspace({
      projectRoot,
      denoBinaryPath: "/bin/deno",
      runCommandCapture: async () => ({
        stdout: JSON.stringify(graph),
        stderr: "",
      }),
    });

    const stagedPackageJson = JSON.parse(
      await fs.readFile(path.join(workspace.stageDir, "package.json"), "utf8"),
    );
    assert.equal(
      stagedPackageJson.dependencies["space-data-module-sdk"],
      "file:../space-data-module-sdk",
    );
    await assert.doesNotReject(
      fs.access(path.join(workspace.stageDir, "node_modules", "space-data-module-sdk", "package.json")),
    );
    await assert.doesNotReject(
      fs.access(
        path.join(
          workspace.stageDir,
          "node_modules",
          "space-data-module-sdk",
          "src",
          "compliance",
          "index.js",
        ),
      ),
    );
    await assert.doesNotReject(
      fs.access(
        path.join(
          workspace.stageDir,
          "node_modules",
          "space-data-module-sdk",
          "src",
          "runtime",
          "constants.js",
        ),
      ),
    );
    await assert.rejects(
      fs.access(
        path.join(
          workspace.stageDir,
          "node_modules",
          "space-data-module-sdk",
          "src",
          "unused",
          "ignored.js",
        ),
      ),
    );
    await assert.doesNotReject(
      fs.access(path.join(workspace.stageDir, "node_modules", "flatbuffers", "index.js")),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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
