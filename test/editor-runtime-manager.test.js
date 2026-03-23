import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  buildSdnFlowEditorUrl,
  createSdnFlowEditorRuntimeManager,
  deleteArchivedSdnFlowEditorBuild,
  deleteArchivedSdnFlowEditorExecutable,
  getSdnFlowEditorRuntimePaths,
  isLegacyDefaultSdnFlowEditorStartup,
  listArchivedSdnFlowEditorBuilds,
  migrateLegacyDefaultSdnFlowEditorStartup,
  readSdnFlowEditorBuildFile,
  readSdnFlowEditorSettingsFile,
  listArchivedSdnFlowEditorExecutables,
  readSdnFlowEditorSessionFile,
  writeSdnFlowEditorBuildFile,
  writeSdnFlowEditorSettingsFile,
  writeSdnFlowEditorSessionFile,
} from "../src/editor/runtimeManager.js";
import { compileNodeRedFlowsToSdnArtifact } from "../src/editor/compileArtifact.js";

async function compileEditorFlowInRepo(flows) {
  return compileNodeRedFlowsToSdnArtifact(flows, {
    cwd: "/Users/tj/software/sdn-flow",
    env: process.env,
  });
}

async function writeDummyEditorExecutable(_command, args) {
  const outputPath = String(args?.at?.(-1) ?? "");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, "binary", "utf8");
}

test("runtime paths resolve generated-tools, archive, and session locations", () => {
  const runtimePaths = getSdnFlowEditorRuntimePaths({
    projectRoot: "/tmp/project",
    platform: "linux",
  });
  assert.equal(runtimePaths.targetExecutablePath, "/tmp/project/generated-tools/sdn-flow-editor");
  assert.equal(runtimePaths.archiveDir, "/tmp/project/generated-tools/archives");
  assert.equal(runtimePaths.artifactArchiveDir, "/tmp/project/generated-tools/.runtime/artifacts");
  assert.equal(runtimePaths.sessionFilePath, "/tmp/project/generated-tools/.runtime/session.json");
  assert.equal(runtimePaths.settingsFilePath, "/tmp/project/generated-tools/.runtime/editor-settings.json");
  assert.equal(runtimePaths.currentBuildFilePath, "/tmp/project/generated-tools/.runtime/current-flow-build.json");
});

test("runtime session files can be written and read back", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-session-"));
  const sessionPath = path.join(tempDir, "session.json");
  const session = {
    kind: "sdn-flow-editor-session",
    version: 1,
    startup: {
      hostname: "127.0.0.1",
      port: 9000,
      basePath: "/editor",
      title: "Session Editor",
    },
    flows: [{ id: "flow-1", type: "tab", label: "Flow 1" }],
  };

  try {
    await writeSdnFlowEditorSessionFile(sessionPath, session);
    assert.deepEqual(await readSdnFlowEditorSessionFile(sessionPath), session);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime settings files can be written and read back", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-settings-"));
  const settingsPath = path.join(tempDir, "editor-settings.json");
  const settings = {
    kind: "sdn-flow-editor-settings",
    version: 1,
    startup: {
      protocol: "http",
      hostname: "127.0.0.1",
      port: 9090,
      basePath: "/editor",
      title: "Settings Editor",
    },
    artifactArchiveLimit: 24,
    security: {
      storageDir: path.join(os.homedir(), ".sdn-flow"),
      wallet: {
        enabled: false,
        coinType: 0,
        account: "0",
        signingIndex: "0",
        encryptionIndex: "0",
      },
      tls: {
        enabled: false,
        certificateDays: 365,
        organization: "sdn-flow",
        country: "US",
      },
    },
  };

  try {
    await writeSdnFlowEditorSettingsFile(settingsPath, settings);
    assert.deepEqual(await readSdnFlowEditorSettingsFile(settingsPath), settings);
    assert.equal(buildSdnFlowEditorUrl(settings.startup), "http://127.0.0.1:9090/editor/");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archived flow builds can be listed and deleted", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-build-archives-"));
  const { artifactArchiveDir } = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
  const archivePath = path.join(artifactArchiveDir, "flow-1-archive.json");

  try {
    await fs.mkdir(artifactArchiveDir, { recursive: true });
    await writeSdnFlowEditorBuildFile(archivePath, {
      kind: "sdn-flow-editor-flow-build",
      version: 1,
      compileId: "compile-archive",
      createdAt: "2026-03-18T12:00:00.000Z",
      outputName: "flow-runtime",
      flows: [
        { id: "tab-1", type: "tab", label: "Flow 1" },
        { id: "debug-1", z: "tab-1", type: "debug" },
      ],
      artifactSummary: {
        artifactId: "flow-1:deadbeef",
        programId: "flow-1",
        wasmBytes: 4096,
        manifestBytes: 128,
      },
      serializedArtifact: {
        artifactId: "flow-1:deadbeef",
        programId: "flow-1",
      },
    });

    const archives = await listArchivedSdnFlowEditorBuilds({ projectRoot: tempDir });
    assert.equal(archives.length, 1);
    assert.equal(archives[0].programId, "flow-1");
    assert.equal(archives[0].wasmBytes, 4096);
    assert.equal(archives[0].flowCount, 2);

    const deleted = await deleteArchivedSdnFlowEditorBuild("flow-1-archive.json", {
      projectRoot: tempDir,
    });
    assert.equal(deleted.deleted, true);
    assert.equal(await fs.stat(archivePath).catch(() => null), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime build files can be written and read back", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-build-"));
  const buildPath = path.join(tempDir, "current-flow-build.json");
  const build = {
    kind: "sdn-flow-editor-flow-build",
    version: 1,
    compileId: "compile-123",
    createdAt: "2026-03-18T12:00:00.000Z",
    outputName: "flow-runtime",
    runtimeModel: "compiled-cpp-wasm",
    serializedArtifact: {
      artifactId: "flow-1:deadbeef",
      programId: "flow-1",
    },
  };

  try {
    await writeSdnFlowEditorBuildFile(buildPath, build);
    assert.deepEqual(await readSdnFlowEditorBuildFile(buildPath), build);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("legacy implicit editor startup defaults migrate from 8080 to 1990", () => {
  const legacyStartup = {
    hostname: "127.0.0.1",
    port: 8080,
    basePath: "/",
    title: "sdn-flow Editor",
  };

  assert.equal(isLegacyDefaultSdnFlowEditorStartup(legacyStartup), true);
  assert.deepEqual(migrateLegacyDefaultSdnFlowEditorStartup(legacyStartup), {
    protocol: "http",
    hostname: "127.0.0.1",
    port: 1990,
    basePath: "/",
    title: "sdn-flow Editor",
  });
});

test("archived executables can be listed and deleted", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-archives-"));
  const archiveDir = path.join(tempDir, "generated-tools", "archives");
  const archivePath = path.join(archiveDir, "sdn-flow-editor-archive");

  try {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(archivePath, "binary", "utf8");

    const archives = await listArchivedSdnFlowEditorExecutables({ projectRoot: tempDir });
    assert.equal(archives.length, 1);
    assert.equal(archives[0].id, "sdn-flow-editor-archive");

    const deleted = await deleteArchivedSdnFlowEditorExecutable("sdn-flow-editor-archive", {
      projectRoot: tempDir,
    });
    assert.equal(deleted.deleted, true);
    assert.equal(await fs.stat(archivePath).catch(() => null), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager compiles, persists a flow build, hot-loads runtime state, and updates the standalone executable in place", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-"));
  const targetExecutablePath = path.join(tempDir, "generated-tools", "sdn-flow-editor");
  const stagingExecutablePath = path.join(
    tempDir,
    "generated-tools",
    ".runtime",
    "staging",
    "sdn-flow-editor",
  );
  const steps = [];

  try {
    await fs.mkdir(path.dirname(targetExecutablePath), { recursive: true });
    await fs.writeFile(targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      hostname: "127.0.0.1",
      port: 8081,
      basePath: "/editor",
      title: "Runtime Test",
      async compileFlowArtifact(flows) {
        steps.push(["compile-flow", flows[0]?.label ?? null]);
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
            graphHash: "graph-123",
            manifestHash: "manifest-123",
            runtimeModel: "compiled-cpp-wasm",
            abiVersion: 1,
            wasmBytes: 4,
            manifestBytes: 4,
            warnings: [],
            createdAt: "2026-03-18T12:00:00.000Z",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
            format: "application/wasm",
            runtimeModel: "compiled-cpp-wasm",
            wasmBase64: "AGFzbQ==",
            manifestBase64: "RkxPVw==",
            manifestExports: {
              bytesSymbol: "flow_get_manifest_flatbuffer",
              sizeSymbol: "flow_get_manifest_flatbuffer_size",
            },
            runtimeExports: {
              mallocSymbol: "malloc",
              freeSymbol: "free",
              descriptorSymbol: "sdn_flow_get_runtime_descriptor",
              resetStateSymbol: "sdn_flow_reset_runtime_state",
              enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
              enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
              readyNodeSymbol: "sdn_flow_get_ready_node_index",
              beginInvocationSymbol: "sdn_flow_begin_node_invocation",
              completeInvocationSymbol: "sdn_flow_complete_node_invocation",
            },
            entrypoint: "main",
            graphHash: "graph-123",
            manifestHash: "manifest-123",
            requiredCapabilities: [],
            pluginVersions: [],
            schemaBindings: [],
            abiVersion: 1,
          },
          source: "// compiled source",
          outputName: "flow-runtime",
          runtimeModel: "compiled-cpp-wasm",
          sourceGeneratorModel: "native-cpp-wasm",
          program: {
            programId: "flow-1",
          },
          warnings: [],
        };
      },
      currentExecutablePath: targetExecutablePath,
      async runBuildCommand(command, args, options) {
        steps.push(["build", command, args, options.cwd]);
        await fs.mkdir(path.dirname(stagingExecutablePath), { recursive: true });
        await fs.writeFile(stagingExecutablePath, "new-binary", "utf8");
      },
      async loadCompiledRuntimeHost(buildRecord) {
        steps.push(["load-runtime", buildRecord.serializedArtifact.programId]);
        return {
          artifact: {
            programId: buildRecord.serializedArtifact.programId,
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
    });

    const result = await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
    ]);
    await manager.waitForActiveCompile();

    assert.equal(result.compileId.startsWith("compile-"), true);
    assert.deepEqual(steps, [
      ["compile-flow", "Flow 1"],
      ["load-runtime", "flow-1"],
      [
        "build",
        "node",
        [
          path.join(tempDir, "scripts", "editor-executable.mjs"),
          "build",
          "--output",
          stagingExecutablePath,
        ],
        tempDir,
      ],
    ]);
    assert.equal(await fs.readFile(targetExecutablePath, "utf8"), "new-binary");

    const session = await readSdnFlowEditorSessionFile(
      path.join(tempDir, "generated-tools", ".runtime", "session.json"),
    );
    assert.equal(session.startup.port, 8081);
    assert.equal(session.flows[0].label, "Flow 1");
    const build = await readSdnFlowEditorBuildFile(
      path.join(tempDir, "generated-tools", ".runtime", "current-flow-build.json"),
    );
    assert.equal(build.outputName, "flow-runtime");
    assert.equal(build.serializedArtifact.programId, "flow-1");
    assert.equal(build.source, "// compiled source");
    const archives = await listArchivedSdnFlowEditorExecutables({
      projectRoot: tempDir,
    });
    assert.equal(archives.length, 1);
    assert.equal(await fs.readFile(archives[0].path, "utf8"), "old-binary");
    const status = manager.getRuntimeStatus();
    assert.equal(status.compilePending, false);
    assert.equal(status.compiledRuntimeLoaded, true);
    assert.equal(status.activeBuild.programId, "flow-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager dispatches inject triggers through the active compiled runtime", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-inject-"));
  const capturedFrames = [];

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact(flows) {
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          program: {
            programId: "flow-1",
            triggers: [
              {
                triggerId: "trigger-inject-1",
              },
            ],
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-1",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            enqueueTriggerFrame(triggerIndex, frame) {
              capturedFrames.push({
                triggerIndex,
                frame,
              });
            },
            async drain() {
              return {
                idle: true,
                iterations: 1,
              };
            },
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      async runBuildCommand() {},
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        name: "Tick",
        payloadType: "str",
        payload: "hello",
        topic: "demo",
        props: [
          {
            p: "payload",
            v: "hello",
            vt: "str",
          },
          {
            p: "topic",
            v: "demo",
            vt: "str",
          },
        ],
      },
    ]);
    await manager.waitForActiveCompile();

    const result = await manager.dispatchInject("inject-1");
    assert.equal(result.idle, true);
    assert.equal(capturedFrames.length, 1);
    assert.equal(capturedFrames[0].triggerIndex, 0);
    const payload = JSON.parse(Buffer.from(capturedFrames[0].frame.bytes).toString("utf8"));
    assert.equal(payload.payload, "hello");
    assert.equal(payload.topic, "demo");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager honors custom inject props sent by the editor UI", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-custom-inject-"));
  const capturedFrames = [];

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact() {
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          program: {
            programId: "flow-1",
            triggers: [
              {
                triggerId: "trigger-inject-1",
              },
            ],
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-1",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            enqueueTriggerFrame(triggerIndex, frame) {
              capturedFrames.push({
                triggerIndex,
                frame,
              });
            },
            async drain() {
              return {
                idle: true,
                iterations: 1,
              };
            },
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      async runBuildCommand() {},
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        name: "Tick",
        payloadType: "str",
        payload: "hello",
        topic: "demo",
        props: [
          {
            p: "payload",
            v: "hello",
            vt: "str",
          },
          {
            p: "topic",
            v: "demo",
            vt: "str",
          },
        ],
      },
    ]);
    await manager.waitForActiveCompile();

    const result = await manager.dispatchInject("inject-1", {
      __user_inject_props__: [
        {
          p: "payload",
          v: "override",
          vt: "str",
        },
        {
          p: "topic",
          v: "custom",
          vt: "str",
        },
      ],
      traceId: "trace-123",
    });
    assert.equal(result.idle, true);
    assert.equal(capturedFrames.length, 1);
    const payload = JSON.parse(Buffer.from(capturedFrames[0].frame.bytes).toString("utf8"));
    assert.equal(payload.payload, "override");
    assert.equal(payload.topic, "custom");
    assert.equal(payload.traceId, "trace-123");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager dispatches HTTP requests through http in triggers and returns http response outputs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-http-"));
  const capturedFrames = [];

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact() {
        return {
          artifactSummary: {
            artifactId: "flow-http:deadbeef",
            programId: "flow-http",
          },
          serializedArtifact: {
            artifactId: "flow-http:deadbeef",
            programId: "flow-http",
          },
          program: {
            programId: "flow-http",
            triggers: [
              {
                triggerId: "trigger-http-in-1",
                kind: "http-request",
                source: "/widgets/:widgetId",
              },
            ],
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-http",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            enqueueTriggerFrame(triggerIndex, frame) {
              capturedFrames.push({
                triggerIndex,
                frame,
              });
            },
            async drain() {
              return {
                idle: true,
                iterations: 1,
                executions: [
                  {
                    pluginId: "com.digitalarsenal.flow.http-response",
                    methodId: "send",
                    dispatchDescriptor: {
                      nodeId: "http-response-1",
                    },
                    outputs: [
                      {
                        portId: "response",
                        payload: "created",
                        bytes: Buffer.from("created", "utf8"),
                        metadata: {
                          statusCode: 201,
                          responseHeaders: {
                            "content-type": "text/plain; charset=utf-8",
                            "x-flow": "ok",
                          },
                        },
                      },
                    ],
                  },
                ],
              };
            },
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      async runBuildCommand() {},
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-http",
        type: "tab",
        label: "HTTP Flow",
      },
      {
        id: "http-in-1",
        z: "flow-http",
        type: "http in",
        method: "post",
        url: "/widgets/:widgetId",
      },
      {
        id: "http-response-1",
        z: "flow-http",
        type: "http response",
        statusCode: "201",
      },
    ]);
    await manager.waitForActiveCompile();

    const result = await manager.handleHttpRequest({
      method: "POST",
      path: "/widgets/abc-123",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-123",
      },
      query: {
        view: "full",
      },
      body: Buffer.from(JSON.stringify({
        enabled: true,
      }), "utf8"),
      metadata: {
        originalUrl: "http://127.0.0.1:1990/widgets/abc-123?view=full",
      },
    });

    assert.equal(result.triggerId, "trigger-http-in-1");
    assert.equal(result.route, "/widgets/:widgetId");
    assert.deepEqual(result.params, {
      widgetId: "abc-123",
    });
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].frame.metadata.statusCode, 201);
    assert.equal(result.outputs[0].frame.metadata.responseHeaders["x-flow"], "ok");

    assert.equal(capturedFrames.length, 1);
    assert.equal(capturedFrames[0].triggerIndex, 0);
    const payload = JSON.parse(Buffer.from(capturedFrames[0].frame.bytes).toString("utf8"));
    assert.equal(payload._msgid, "req-123");
    assert.deepEqual(payload.payload, {
      enabled: true,
    });
    assert.equal(payload.req.method, "POST");
    assert.equal(payload.req.path, "/widgets/abc-123");
    assert.equal(payload.req.originalUrl, "http://127.0.0.1:1990/widgets/abc-123?view=full");
    assert.deepEqual(payload.req.params, {
      widgetId: "abc-123",
    });
    assert.deepEqual(payload.req.query, {
      view: "full",
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager routes link out messages into linked link in nodes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-link-"));

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      compileFlowArtifact: compileEditorFlowInRepo,
      runBuildCommand: writeDummyEditorExecutable,
      logError() {},
    });

    await manager.initialize();
    await manager.scheduleCompile([
      { id: "tab-link", type: "tab", label: "Link Flow" },
      {
        id: "inject-link",
        z: "tab-link",
        type: "inject",
        props: [
          {
            p: "payload",
            v: "hello link",
            vt: "str",
          },
        ],
        repeat: "",
        crontab: "",
        once: false,
        onceDelay: 0.1,
        wires: [["link-out-1"]],
      },
      {
        id: "link-out-1",
        z: "tab-link",
        type: "link out",
        mode: "link",
        links: ["link-in-1"],
        wires: [],
      },
      {
        id: "link-in-1",
        z: "tab-link",
        type: "link in",
        links: ["link-out-1"],
        wires: [["debug-link"]],
      },
      {
        id: "debug-link",
        z: "tab-link",
        type: "debug",
        active: true,
        complete: "payload",
        targetType: "msg",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();

    await manager.dispatchInject("inject-link");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const debugMessages = manager.getRuntimeStatus().debugMessages;
    assert.equal(debugMessages.length > 0, true);
    assert.equal(debugMessages.at(-1)?.message?.msg, "hello link");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager returns link call responses through return-mode link out nodes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-link-call-"));

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      compileFlowArtifact: compileEditorFlowInRepo,
      runBuildCommand: writeDummyEditorExecutable,
      logError() {},
    });

    await manager.initialize();
    await manager.scheduleCompile([
      { id: "tab-link-call", type: "tab", label: "Link Call Flow" },
      {
        id: "inject-call",
        z: "tab-link-call",
        type: "inject",
        props: [
          {
            p: "payload",
            v: "hello call",
            vt: "str",
          },
        ],
        repeat: "",
        crontab: "",
        once: false,
        onceDelay: 0.1,
        wires: [["link-call-1"]],
      },
      {
        id: "link-call-1",
        z: "tab-link-call",
        type: "link call",
        links: ["link-in-call-1"],
        linkType: "static",
        timeout: "2",
        wires: [["debug-call"]],
      },
      {
        id: "link-in-call-1",
        z: "tab-link-call",
        type: "link in",
        links: [],
        wires: [["fn-call-1"]],
      },
      {
        id: "fn-call-1",
        z: "tab-link-call",
        type: "function",
        func: "msg.payload = String(msg.payload).toUpperCase(); return msg;",
        outputs: 1,
        noerr: 0,
        wires: [["link-out-return-1"]],
      },
      {
        id: "link-out-return-1",
        z: "tab-link-call",
        type: "link out",
        mode: "return",
        links: [],
        wires: [],
      },
      {
        id: "debug-call",
        z: "tab-link-call",
        type: "debug",
        active: true,
        complete: "payload",
        targetType: "msg",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();

    await manager.dispatchInject("inject-call");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const debugMessages = manager.getRuntimeStatus().debugMessages;
    assert.equal(debugMessages.length > 0, true);
    assert.equal(debugMessages.at(-1)?.message?.msg, "HELLO CALL");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager schedules inject once and repeat timers across flow-state changes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-schedule-"));
  const capturedFrames = [];
  const scheduledTimeouts = [];
  const scheduledIntervals = [];

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact() {
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          program: {
            programId: "flow-1",
            triggers: [
              {
                triggerId: "trigger-inject-1",
              },
            ],
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-1",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            enqueueTriggerFrame(triggerIndex, frame) {
              capturedFrames.push({
                triggerIndex,
                frame,
              });
            },
            async drain() {
              return {
                idle: true,
                iterations: 1,
              };
            },
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      setTimer(callback, delay) {
        const handle = {
          kind: "timeout",
          delay,
          callback,
          cleared: false,
        };
        scheduledTimeouts.push(handle);
        return handle;
      },
      clearTimer(handle) {
        handle.cleared = true;
      },
      setRepeatingTimer(callback, delay) {
        const handle = {
          kind: "interval",
          delay,
          callback,
          cleared: false,
        };
        scheduledIntervals.push(handle);
        return handle;
      },
      clearRepeatingTimer(handle) {
        handle.cleared = true;
      },
      async runBuildCommand() {},
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        name: "Tick",
        once: true,
        onceDelay: 0.25,
        repeat: "2",
        payloadType: "str",
        payload: "hello",
        props: [
          {
            p: "payload",
            v: "hello",
            vt: "str",
          },
        ],
      },
    ]);
    await manager.waitForActiveCompile();

    const initialStatus = manager.getRuntimeStatus();
    assert.equal(initialStatus.scheduledInjects.length, 1);
    assert.equal(initialStatus.scheduledInjects[0].mode, "once+repeat");
    assert.equal(initialStatus.scheduledInjects[0].onceDelayMs, 250);
    assert.equal(initialStatus.scheduledInjects[0].repeatIntervalMs, 2000);
    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(scheduledTimeouts[0].delay, 250);
    assert.equal(scheduledIntervals.length, 0);

    await scheduledTimeouts[0].callback();
    assert.equal(capturedFrames.length, 1);
    assert.equal(scheduledIntervals.length, 1);
    assert.equal(scheduledIntervals[0].delay, 2000);

    await scheduledIntervals[0].callback();
    assert.equal(capturedFrames.length, 2);

    manager.setFlowState("stop");
    assert.equal(scheduledTimeouts[0].cleared, true);
    assert.equal(scheduledIntervals[0].cleared, true);
    assert.equal(manager.getRuntimeStatus().scheduledInjects.length, 0);

    manager.setFlowState("start");
    assert.equal(scheduledTimeouts.length, 2);
    assert.equal(scheduledTimeouts[1].delay, 250);
    assert.equal(manager.getRuntimeStatus().scheduledInjects.length, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager schedules cron injects when repeat is not configured", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-cron-"));
  const capturedFrames = [];
  const scheduledCronTasks = [];

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact() {
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          program: {
            programId: "flow-1",
            triggers: [
              {
                triggerId: "trigger-inject-1",
              },
            ],
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-1",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            enqueueTriggerFrame(triggerIndex, frame) {
              capturedFrames.push({
                triggerIndex,
                frame,
              });
            },
            async drain() {
              return {
                idle: true,
                iterations: 1,
              };
            },
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      scheduleCronTask(expression, callback) {
        const handle = {
          expression,
          callback,
          stopped: false,
          stop() {
            this.stopped = true;
          },
        };
        scheduledCronTasks.push(handle);
        return handle;
      },
      async runBuildCommand() {},
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        name: "Cron Tick",
        crontab: "*/5 * * * * *",
        payloadType: "str",
        payload: "hello",
        props: [
          {
            p: "payload",
            v: "hello",
            vt: "str",
          },
        ],
      },
    ]);
    await manager.waitForActiveCompile();

    assert.equal(scheduledCronTasks.length, 1);
    assert.equal(scheduledCronTasks[0].expression, "*/5 * * * * *");
    assert.equal(manager.getRuntimeStatus().scheduledInjects[0].mode, "crontab");

    await scheduledCronTasks[0].callback();
    assert.equal(capturedFrames.length, 1);

    manager.setFlowState("safe");
    assert.equal(scheduledCronTasks[0].stopped, true);
    assert.equal(manager.getRuntimeStatus().scheduledInjects.length, 0);

    manager.setFlowState("start");
    assert.equal(scheduledCronTasks.length, 2);
    assert.equal(scheduledCronTasks[1].expression, "*/5 * * * * *");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager clears compile pending and exposes rebuild errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-error-"));

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async compileFlowArtifact() {
        return {
          artifactSummary: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
          serializedArtifact: {
            artifactId: "flow-1:deadbeef",
            programId: "flow-1",
          },
        };
      },
      async loadCompiledRuntimeHost() {
        return {
          artifact: {
            programId: "flow-1",
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      async runBuildCommand() {
        throw new Error("build failed");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
    ]);
    await manager.waitForActiveCompile();

    const status = manager.getRuntimeStatus();
    assert.equal(status.compilePending, false);
    assert.match(status.lastCompileError, /build failed/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager initializes an already-persisted flow build", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-init-"));

  try {
    const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
    await writeSdnFlowEditorBuildFile(runtimePaths.currentBuildFilePath, {
      kind: "sdn-flow-editor-flow-build",
      version: 1,
      compileId: "compile-123",
      createdAt: "2026-03-18T12:00:00.000Z",
      outputName: "flow-runtime",
      runtimeModel: "compiled-cpp-wasm",
      serializedArtifact: {
        artifactId: "flow-1:deadbeef",
        programId: "flow-1",
      },
      artifactSummary: {
        artifactId: "flow-1:deadbeef",
        programId: "flow-1",
      },
    });

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async loadCompiledRuntimeHost(buildRecord) {
        return {
          artifact: {
            programId: buildRecord.serializedArtifact.programId,
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          },
          host: {
            resetRuntimeState() {},
            async destroyDependencies() {},
          },
        };
      },
      logError() {},
    });

    await manager.initialize();

    assert.equal(manager.getRuntimeStatus().activeBuild.programId, "flow-1");
    assert.equal(manager.getRuntimeStatus().compiledRuntimeLoaded, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager preserves the active startup when persisted settings exist", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-persisted-startup-"));

  try {
    const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
    await writeSdnFlowEditorSettingsFile(runtimePaths.settingsFilePath, {
      kind: "sdn-flow-editor-settings",
      version: 1,
      startup: {
        hostname: "127.0.0.1",
        port: 1995,
        basePath: "/persisted",
        title: "Persisted Startup",
      },
      artifactArchiveLimit: 12,
    });

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      hostname: "127.0.0.1",
      port: 2018,
      basePath: "/",
      title: "Active Startup",
      logError() {},
    });

    await manager.initialize();

    const status = manager.getRuntimeStatus();
    assert.equal(status.activeStartup.port, 2018);
    assert.equal(status.startup.port, 2018);
    assert.equal(status.restartUrl, "http://127.0.0.1:2018/");
    assert.equal(status.artifactArchiveLimit, 12);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager routes link out fan-out and link call returns through the compiled runtime", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-links-"));
  const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });

  try {
    await fs.mkdir(path.dirname(runtimePaths.targetExecutablePath), { recursive: true });
    await fs.writeFile(runtimePaths.targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async runBuildCommand() {
        await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), { recursive: true });
        await fs.writeFile(runtimePaths.stagingExecutablePath, "new-binary", "utf8");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "tab-links",
        type: "tab",
        label: "Link Flow",
      },
      {
        id: "inject-link-out",
        z: "tab-links",
        type: "inject",
        name: "emit link out",
        props: [
          {
            p: "payload",
            v: "fanout",
            vt: "str",
          },
        ],
        wires: [["link-out-1"]],
      },
      {
        id: "link-out-1",
        z: "tab-links",
        type: "link out",
        mode: "link",
        links: ["link-in-1"],
        wires: [],
      },
      {
        id: "link-in-1",
        z: "tab-links",
        type: "link in",
        name: "fanout target",
        links: ["link-out-1"],
        wires: [["debug-link-out"]],
      },
      {
        id: "debug-link-out",
        z: "tab-links",
        type: "debug",
        name: "fanout debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: "payload",
        targetType: "msg",
        wires: [],
      },
      {
        id: "inject-link-call",
        z: "tab-links",
        type: "inject",
        name: "emit link call",
        props: [
          {
            p: "payload",
            v: "call",
            vt: "str",
          },
        ],
        wires: [["link-call-1"]],
      },
      {
        id: "link-call-1",
        z: "tab-links",
        type: "link call",
        name: "call target",
        links: ["link-in-2"],
        linkType: "static",
        timeout: "1",
        wires: [["debug-link-call"]],
      },
      {
        id: "link-in-2",
        z: "tab-links",
        type: "link in",
        name: "call target",
        links: ["link-out-return"],
        wires: [["fn-return"]],
      },
      {
        id: "fn-return",
        z: "tab-links",
        type: "function",
        name: "prepare return",
        func: "msg.payload = 'returned:' + msg.payload; return msg;",
        outputs: 1,
        noerr: 0,
        initialize: "",
        finalize: "",
        libs: [],
        wires: [["link-out-return"]],
      },
      {
        id: "link-out-return",
        z: "tab-links",
        type: "link out",
        mode: "return",
        links: [],
        wires: [],
      },
      {
        id: "debug-link-call",
        z: "tab-links",
        type: "debug",
        name: "call debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: "payload",
        targetType: "msg",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();

    await manager.dispatchInject("inject-link-out");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.dispatchInject("inject-link-call");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const debugMessages = manager.getRuntimeStatus().debugMessages.map((entry) => entry.message);
    assert.ok(
      debugMessages.some((entry) => entry.name === "fanout debug" && entry.msg === "fanout"),
    );
    assert.ok(
      debugMessages.some((entry) => entry.name === "call debug" && entry.msg === "returned:call"),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager executes sort and batch nodes through the compiled runtime", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-sort-batch-"));
  const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });

  try {
    await fs.mkdir(path.dirname(runtimePaths.targetExecutablePath), { recursive: true });
    await fs.writeFile(runtimePaths.targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async runBuildCommand() {
        await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), { recursive: true });
        await fs.writeFile(runtimePaths.stagingExecutablePath, "new-binary", "utf8");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "tab-sort-batch",
        type: "tab",
        label: "Sort Batch Flow",
      },
      {
        id: "inject-sort-runtime",
        z: "tab-sort-batch",
        type: "inject",
        name: "emit sort",
        props: [{ p: "payload", v: "", vt: "str" }],
        wires: [["sort-runtime"]],
      },
      {
        id: "sort-runtime",
        z: "tab-sort-batch",
        type: "sort",
        target: "payload",
        targetType: "msg",
        msgKey: "score",
        msgKeyType: "elem",
        order: "ascending",
        as_num: true,
        wires: [["debug-sort-runtime"]],
      },
      {
        id: "debug-sort-runtime",
        z: "tab-sort-batch",
        type: "debug",
        name: "sort debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
      {
        id: "inject-batch-runtime",
        z: "tab-sort-batch",
        type: "inject",
        name: "emit batch",
        props: [{ p: "payload", v: "", vt: "str" }],
        wires: [["batch-runtime"]],
      },
      {
        id: "batch-runtime",
        z: "tab-sort-batch",
        type: "batch",
        mode: "count",
        count: "2",
        overlap: "0",
        honourParts: false,
        wires: [["debug-batch-runtime"]],
      },
      {
        id: "debug-batch-runtime",
        z: "tab-sort-batch",
        type: "debug",
        name: "batch debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();

    await manager.dispatchInject("inject-sort-runtime", {
      payload: [
        { score: 20, name: "later" },
        { score: 5, name: "earlier" },
      ],
    });
    await manager.dispatchInject("inject-batch-runtime", {
      payload: "first",
    });
    await manager.dispatchInject("inject-batch-runtime", {
      payload: "second",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const debugMessages = manager.getRuntimeStatus().debugMessages.map((entry) => entry.message);
    const sortEvent = debugMessages.find((entry) => entry.name === "sort debug");
    const batchEvents = debugMessages.filter((entry) => entry.name === "batch debug");

    assert.deepEqual(sortEvent.msg.payload.map((entry) => entry.name), ["earlier", "later"]);
    assert.equal(batchEvents.length, 2);
    assert.deepEqual(batchEvents.map((entry) => entry.msg.payload), ["first", "second"]);
    assert.deepEqual(batchEvents.map((entry) => entry.msg.parts.index), [0, 1]);
    assert.ok(batchEvents.every((entry) => entry.msg.parts.count === 2));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager executes file write and file in nodes through the compiled runtime", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-file-"));
  const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
  const relativeFilePath = "runtime/output.txt";

  try {
    await fs.mkdir(path.dirname(runtimePaths.targetExecutablePath), { recursive: true });
    await fs.writeFile(runtimePaths.targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async runBuildCommand() {
        await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), { recursive: true });
        await fs.writeFile(runtimePaths.stagingExecutablePath, "new-binary", "utf8");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "tab-file-runtime",
        type: "tab",
        label: "File Flow",
      },
      {
        id: "inject-file-write-runtime",
        z: "tab-file-runtime",
        type: "inject",
        name: "write file",
        props: [{ p: "payload", v: "", vt: "str" }],
        wires: [["file-write-runtime"]],
      },
      {
        id: "file-write-runtime",
        z: "tab-file-runtime",
        type: "file",
        filename: relativeFilePath,
        filenameType: "str",
        appendNewline: false,
        createDir: true,
        overwriteFile: "true",
        encoding: "none",
        wires: [[]],
      },
      {
        id: "inject-file-read-runtime",
        z: "tab-file-runtime",
        type: "inject",
        name: "read file",
        props: [{ p: "payload", v: "", vt: "str" }],
        wires: [["file-read-runtime"]],
      },
      {
        id: "file-read-runtime",
        z: "tab-file-runtime",
        type: "file in",
        filename: relativeFilePath,
        filenameType: "str",
        format: "lines",
        encoding: "none",
        allProps: false,
        wires: [["debug-file-runtime"]],
      },
      {
        id: "debug-file-runtime",
        z: "tab-file-runtime",
        type: "debug",
        name: "file debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();

    await manager.dispatchInject("inject-file-write-runtime", {
      payload: "alpha\nbeta",
    });
    await manager.dispatchInject("inject-file-read-runtime");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const debugMessages = manager.getRuntimeStatus().debugMessages.map((entry) => entry.message);
    const fileEvents = debugMessages.filter((entry) => entry.name === "file debug");

    assert.deepEqual(fileEvents.map((entry) => entry.msg.payload), ["alpha", "beta"]);
    assert.deepEqual(fileEvents.map((entry) => entry.msg.parts.index), [0, 1]);
    assert.ok(fileEvents.every((entry) => entry.msg.parts.count === 2));
    assert.equal(
      await fs.readFile(path.join(tempDir, relativeFilePath), "utf8"),
      "alpha\nbeta",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager executes buffered exec nodes and emits stdout, stderr, and rc outputs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-exec-"));
  const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
  const script = "process.stdout.write('exec-out'); process.stderr.write('exec-err'); process.exit(3);";
  const command = `"${process.execPath}" -e ${JSON.stringify(script)}`;

  try {
    await fs.mkdir(path.dirname(runtimePaths.targetExecutablePath), { recursive: true });
    await fs.writeFile(runtimePaths.targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async runBuildCommand() {
        await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), { recursive: true });
        await fs.writeFile(runtimePaths.stagingExecutablePath, "new-binary", "utf8");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "tab-exec",
        type: "tab",
        label: "Exec Flow",
      },
      {
        id: "inject-exec",
        z: "tab-exec",
        type: "inject",
        name: "run exec",
        props: [
          {
            p: "payload",
            v: "",
            vt: "str",
          },
        ],
        wires: [["exec-1"]],
      },
      {
        id: "exec-1",
        z: "tab-exec",
        type: "exec",
        command,
        addpay: "",
        append: "",
        useSpawn: "false",
        timer: "",
        winHide: false,
        oldrc: false,
        wires: [["debug-stdout"], ["debug-stderr"], ["debug-rc"]],
      },
      {
        id: "debug-stdout",
        z: "tab-exec",
        type: "debug",
        name: "stdout debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
      {
        id: "debug-stderr",
        z: "tab-exec",
        type: "debug",
        name: "stderr debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
      {
        id: "debug-rc",
        z: "tab-exec",
        type: "debug",
        name: "rc debug",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();
    await manager.dispatchInject("inject-exec");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const debugMessages = manager.getRuntimeStatus().debugMessages.map((entry) => entry.message);
    const stdoutEvent = debugMessages.find((entry) => entry.name === "stdout debug");
    const stderrEvent = debugMessages.find((entry) => entry.name === "stderr debug");
    const rcEvent = debugMessages.find((entry) => entry.name === "rc debug");

    assert.equal(stdoutEvent.msg.payload, "exec-out");
    assert.equal(stdoutEvent.msg.rc.code, 3);
    assert.equal(stderrEvent.msg.payload, "exec-err");
    assert.equal(stderrEvent.msg.rc.code, 3);
    assert.equal(rcEvent.msg.payload.code, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager executes spawn-mode exec nodes and streams stdout, stderr, and rc outputs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-exec-spawn-"));
  const runtimePaths = getSdnFlowEditorRuntimePaths({ projectRoot: tempDir });
  const script = "process.stdout.write('spawn-out'); process.stderr.write('spawn-err'); process.exit(0);";
  const command = `"${process.execPath}" -e ${JSON.stringify(script)}`;

  try {
    await fs.mkdir(path.dirname(runtimePaths.targetExecutablePath), { recursive: true });
    await fs.writeFile(runtimePaths.targetExecutablePath, "old-binary", "utf8");

    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      async runBuildCommand() {
        await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), { recursive: true });
        await fs.writeFile(runtimePaths.stagingExecutablePath, "new-binary", "utf8");
      },
      logError() {},
    });

    await manager.scheduleCompile([
      {
        id: "tab-spawn",
        type: "tab",
        label: "Spawn Flow",
      },
      {
        id: "inject-spawn",
        z: "tab-spawn",
        type: "inject",
        name: "run spawn",
        props: [
          {
            p: "payload",
            v: "",
            vt: "str",
          },
        ],
        wires: [["exec-spawn"]],
      },
      {
        id: "exec-spawn",
        z: "tab-spawn",
        type: "exec",
        command,
        addpay: "",
        append: "",
        useSpawn: "true",
        timer: "",
        winHide: false,
        oldrc: false,
        wires: [["debug-spawn-stdout"], ["debug-spawn-stderr"], ["debug-spawn-rc"]],
      },
      {
        id: "debug-spawn-stdout",
        z: "tab-spawn",
        type: "debug",
        name: "spawn stdout",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
      {
        id: "debug-spawn-stderr",
        z: "tab-spawn",
        type: "debug",
        name: "spawn stderr",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
      {
        id: "debug-spawn-rc",
        z: "tab-spawn",
        type: "debug",
        name: "spawn rc",
        active: true,
        tosidebar: true,
        console: false,
        complete: true,
        targetType: "full",
        wires: [],
      },
    ]);
    await manager.waitForActiveCompile();
    await manager.dispatchInject("inject-spawn");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const debugMessages = manager.getRuntimeStatus().debugMessages.map((entry) => entry.message);
    const stdoutEvent = debugMessages.find((entry) => entry.name === "spawn stdout");
    const stderrEvent = debugMessages.find((entry) => entry.name === "spawn stderr");
    const rcEvent = debugMessages.find((entry) => entry.name === "spawn rc");

    assert.equal(stdoutEvent.msg.payload, "spawn-out");
    assert.equal(stderrEvent.msg.payload, "spawn-err");
    assert.equal(rcEvent.msg.payload.code, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager updates startup settings and persists them for future launches", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-settings-"));

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      hostname: "127.0.0.1",
      port: 1990,
      basePath: "/",
      title: "Runtime Settings",
      logError() {},
    });

    const updated = await manager.updateStartupSettings({
      port: 18181,
      basePath: "/editor",
      title: "Runtime Settings Updated",
      artifactArchiveLimit: 12,
    });

    assert.equal(updated.startup.port, 18181);
    assert.equal(updated.artifactArchiveLimit, 12);
    assert.equal(updated.restartUrl, "http://127.0.0.1:18181/editor/");
    const settings = await readSdnFlowEditorSettingsFile(
      path.join(tempDir, "generated-tools", ".runtime", "editor-settings.json"),
    );
    assert.equal(settings.startup.port, 18181);
    assert.equal(settings.artifactArchiveLimit, 12);
    assert.equal(manager.getRuntimeStatus().startup.basePath, "/editor");
    assert.equal(manager.getRuntimeStatus().artifactArchiveLimit, 12);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime manager provisions managed wallet and TLS assets for pending https settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-runtime-https-settings-"));

  try {
    const manager = createSdnFlowEditorRuntimeManager({
      projectRoot: tempDir,
      hostname: "127.0.0.1",
      port: 1990,
      basePath: "/",
      title: "Runtime HTTPS Settings",
      logError() {},
    });

    const updated = await manager.updateStartupSettings({
      protocol: "https",
      port: 18443,
      security: {
        storageDir: path.join(tempDir, ".sdn-flow-security"),
      },
    });

    assert.equal(updated.startup.protocol, "https");
    assert.equal(updated.restartUrl, "https://127.0.0.1:18443/");
    assert.equal(updated.securityStatus.wallet.enabled, true);
    assert.equal(updated.securityStatus.tls.enabled, true);
    assert.equal(await fs.stat(updated.securityStatus.wallet.recordPath).catch(() => null) !== null, true);
    assert.equal(await fs.stat(updated.securityStatus.tls.trustCertificatePath).catch(() => null) !== null, true);
    assert.equal(manager.getRuntimeStatus().securityStatus.tls.enabled, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
