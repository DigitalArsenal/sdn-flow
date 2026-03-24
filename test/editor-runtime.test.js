import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  createSdnFlowEditorFetchHandler,
  listSdnFlowEditorEmbeddedAssets,
  normalizeSdnFlowEditorBasePath,
  startSdnFlowEditorNodeHost,
} from "../src/editor/index.js";

function requestTextOverHttps(url, ca) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ca }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: chunks.join(""),
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

test("normalizeSdnFlowEditorBasePath normalizes root and nested mount paths", () => {
  assert.equal(normalizeSdnFlowEditorBasePath("/"), "/");
  assert.equal(normalizeSdnFlowEditorBasePath("editor"), "/editor");
  assert.equal(normalizeSdnFlowEditorBasePath("/editor/"), "/editor");
});

test("listSdnFlowEditorEmbeddedAssets includes the embedded editor shell assets", () => {
  const assets = listSdnFlowEditorEmbeddedAssets();
  assert.ok(assets.includes("/"));
  assert.ok(assets.includes("/red/main.js"));
  assert.ok(assets.includes("/red/red.js"));
  assert.ok(assets.includes("/vendor/vendor.js"));
  assert.ok(assets.includes("/css/node-red-overrides.css"));
  assert.ok(assets.includes("/js/node-red-bootstrap.js"));
  assert.ok(assets.includes("/brand/sdn-flow-icon.svg"));
  assert.ok(assets.includes("/brand/sdn-flow-logo.svg"));
});

test("createSdnFlowEditorFetchHandler serves editor routes and strips upstream branding docs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-fetch-"));
  const compileCalls = [];
  const compilePreviewCalls = [];
  const deletedArchives = [];
  const injectCalls = [];
  const debugStateCalls = [];
  const executablePath = path.join(tempDir, "sdn-flow-editor");
  let security = {
    storageDir: path.join(tempDir, ".sdn-flow"),
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
  };
  let flowState = "start";
  let startup = {
    protocol: "http",
    hostname: "127.0.0.1",
    port: 1990,
    basePath: "/editor",
    title: "Embedded Editor",
    artifactArchiveLimit: 100,
  };
  const handler = createSdnFlowEditorFetchHandler({
    basePath: "/editor",
    title: "Embedded Editor",
    initialFlow: {
      name: "Embedded Flow",
      nodes: [],
      edges: [],
    },
    runtimeManager: {
      getRuntimeStatus() {
        return {
          runtimeId: "runtime-123",
          flowState,
          startup,
          activeStartup: startup,
          compilePending: false,
          compileId: null,
          restartUrl: "http://127.0.0.1:1990/editor/",
          artifactArchiveLimit: startup.artifactArchiveLimit,
          security,
          activeSecurity: security,
          securityStatus: {
            storageDir: security.storageDir,
            wallet: {
              enabled: false,
            },
            tls: {
              enabled: false,
            },
          },
          compiledRuntimeLoaded: true,
          runtimeClassification: {
            summary: {
              totalNodes: 3,
              families: 3,
              handlers: 2,
              byClassification: {
                compiled: 1,
                delegated: 1,
                "js-shim": 1,
              },
            },
            nodeFamilies: [
              {
                family: "inject",
                classification: "compiled",
                count: 1,
                nodeIds: ["inject-1"],
                triggerIds: ["trigger-inject-1"],
                pluginIds: [],
                methodIds: [],
                handlerKeys: [],
              },
            ],
            handlers: [
              {
                key: "com.digitalarsenal.editor.function:invoke",
                classification: "js-shim",
                count: 1,
                nodeIds: ["function-1"],
                families: ["function"],
                pluginIds: ["com.digitalarsenal.editor.function"],
                methodIds: ["invoke"],
              },
            ],
          },
          activeBuild: {
            compileId: "compile-123",
            createdAt: "2026-03-18T12:00:00.000Z",
            outputName: "flow-runtime",
            programId: "flow-1",
            runtimeModel: "compiled-cpp-wasm",
          },
          debugSequence: 0,
          debugMessages: [],
        };
      },
      getStartupSettings() {
        return { ...startup };
      },
      getSecuritySettings() {
        return structuredClone(security);
      },
      getFlowState() {
        return flowState;
      },
      async updateStartupSettings(nextSettings) {
        startup = {
          ...startup,
          ...nextSettings,
        };
        security = {
          ...security,
          ...(nextSettings?.security ?? {}),
          wallet: {
            ...security.wallet,
            ...(nextSettings?.security?.wallet ?? {}),
          },
          tls: {
            ...security.tls,
            ...(nextSettings?.security?.tls ?? {}),
          },
        };
        return {
          startup,
          activeStartup: startup,
          security,
          activeSecurity: security,
          securityStatus: {
            storageDir: security.storageDir,
            wallet: {
              enabled: false,
            },
            tls: {
              enabled: false,
            },
          },
          restartUrl: `${startup.protocol ?? "http"}://${startup.hostname}:${startup.port}${
            startup.basePath === "/" ? "/" : `${startup.basePath}/`
          }`,
          artifactArchiveLimit: startup.artifactArchiveLimit,
        };
      },
      setFlowState(nextState) {
        flowState = nextState ?? flowState;
        return { state: flowState };
      },
      async listArchives() {
        return [
          {
            id: "flow-1-archive.json",
            name: "flow-1",
            size: 1024,
            programId: "flow-1",
            outputName: "flow-runtime",
            wasmBytes: 2048,
            flowCount: 3,
            modifiedAt: "2026-03-18T12:00:00.000Z",
          },
        ];
      },
      async deleteArchive(id) {
        deletedArchives.push(id);
        return { deleted: true, id };
      },
      getActiveBuild() {
        return {
          outputName: "flow-runtime",
          serializedArtifact: {
            programId: "flow-1",
          },
        };
      },
      async readActiveArtifactWasm() {
        return new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
      },
      getTargetExecutablePath() {
        return executablePath;
      },
      async dispatchInject(nodeId, payload = null) {
        injectCalls.push({
          nodeId,
          payload,
        });
        return {
          injected: true,
          nodeId,
        };
      },
      setDebugNodeState(nodeIds, active) {
        debugStateCalls.push({
          nodeIds,
          active,
        });
        return {
          ok: true,
          nodes: nodeIds,
          active,
        };
      },
      async scheduleCompile(flows) {
        compileCalls.push(flows);
        return {
          compileId: "compile-123",
          restartPending: false,
          restartUrl: null,
        };
      },
    },
    async compilePreviewFactory(flows) {
      compilePreviewCalls.push(flows);
      return {
        language: "cpp",
        source: "// generated preview",
        outputName: "sdn-flow-preview",
        sourceGeneratorModel: "native-cpp-wasm",
        warnings: ["Combined 1 tab into one preview program."],
      };
    },
  });

  try {
    await fs.writeFile(executablePath, "binary", "utf8");

    const redirect = await handler(new Request("http://example.test/editor"));
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "http://example.test/editor/");

    const shellResponse = await handler(new Request("http://example.test/editor/"));
    assert.equal(shellResponse.status, 200);
    assert.match(shellResponse.headers.get("content-type"), /text\/html/);
    assert.match(await shellResponse.text(), /red-ui-editor/);

    const settingsResponse = await handler(
      new Request("http://example.test/editor/settings"),
    );
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.editorTheme.deployButton.label, "Compile");
    assert.equal(settings.editorTheme.deployButton.type, "default");
    assert.equal(settings.user.username, "sdn-flow");
    assert.equal(settings.runtimeState.ui, true);
    assert.equal(settings.editorTheme.menu["menu-item-help"], false);
    assert.equal(settings.editorTheme.menu["menu-item-keyboard-shortcuts"], false);
    assert.deepEqual(settings.editorTheme.palette.catalogues, []);

    const redJsResponse = await handler(
      new Request("http://example.test/editor/red/red.js"),
    );
    assert.equal(redJsResponse.status, 200);
    const redJs = await redJsResponse.text();
    assert.match(redJs, /sdn-flow: /);
    assert.doesNotMatch(redJs, /Node-RED:/);
    assert.doesNotMatch(redJs, /https:\/\/nodered\.org\/docs/);

    const aboutResponse = await handler(
      new Request("http://example.test/editor/red/about"),
    );
    assert.equal(aboutResponse.status, 200);
    const aboutText = await aboutResponse.text();
    assert.match(aboutText, /sdn-flow Editor/);
    assert.doesNotMatch(aboutText, /Node-RED/);

    const debugViewResponse = await handler(
      new Request("http://example.test/editor/debug/view/view.html"),
    );
    assert.equal(debugViewResponse.status, 200);
    const debugViewText = await debugViewResponse.text();
    assert.match(debugViewText, /sdn-flow Runtime Debug/);
    assert.doesNotMatch(debugViewText, /Node-RED Debug Tools/);

    const bootstrapScriptResponse = await handler(
      new Request("http://example.test/editor/js/node-red-bootstrap.js"),
    );
    assert.equal(bootstrapScriptResponse.status, 200);
    const bootstrapScript = await bootstrapScriptResponse.text();
    assert.match(bootstrapScript, /preferredSidebarTabId/);
    assert.match(bootstrapScript, /red-ui-tab-info-link-button/);
    assert.match(bootstrapScript, /Download WASM Artifact/);
    assert.match(bootstrapScript, /deploymenu-item-node/);
    assert.match(bootstrapScript, /canRenderDebugEventPayload/);
    assert.match(bootstrapScript, /Runtime Debug/);
    assert.match(bootstrapScript, /Wallet & HTTPS/);
    assert.match(bootstrapScript, /sdn-flow-security-button/);

    const flowsResponse = await handler(
      new Request("http://example.test/editor/flows"),
    );
    const flows = await flowsResponse.json();
    assert.equal(flows.flows[0].type, "tab");
    assert.equal(flows.flows[0].label, "Embedded Flow");

    const compilePreviewResponse = await handler(
      new Request("http://example.test/editor/api/compile-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          flows: [
            {
              id: "flow-1",
              type: "tab",
              label: "Flow 1",
              disabled: false,
              info: "",
            },
            {
              id: "node-1",
              z: "flow-1",
              type: "function",
              x: 120,
              y: 80,
              wires: [[]],
            },
          ],
        }),
      }),
    );
    assert.equal(compilePreviewResponse.status, 200);
    const compilePreview = await compilePreviewResponse.json();
    assert.equal(compilePreview.source, "// generated preview");
    assert.deepEqual(compilePreview.warnings, ["Combined 1 tab into one preview program."]);
    assert.equal(compilePreviewCalls.length, 1);
    assert.equal(compilePreviewCalls[0][1].type, "function");

    const artifactResponse = await handler(
      new Request("http://example.test/editor/api/runtime-artifact"),
    );
    assert.equal(artifactResponse.status, 200);
    const artifactPayload = await artifactResponse.json();
    assert.equal(artifactPayload.build.outputName, "flow-runtime");

    const wasmDownloadResponse = await handler(
      new Request("http://example.test/editor/api/download/wasm"),
    );
    assert.equal(wasmDownloadResponse.status, 200);
    assert.equal(wasmDownloadResponse.headers.get("content-type"), "application/wasm");
    assert.equal(wasmDownloadResponse.headers.get("content-disposition"), 'attachment; filename="flow-runtime.wasm"');

    const executableDownloadResponse = await handler(
      new Request("http://example.test/editor/api/download/executable"),
    );
    assert.equal(executableDownloadResponse.status, 200);
    assert.equal(executableDownloadResponse.headers.get("content-type"), "application/octet-stream");

    const compileResponse = await handler(
      new Request("http://example.test/editor/flows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          flows: [
            {
              id: "flow-1",
              type: "tab",
              label: "Flow 1",
              disabled: false,
              info: "",
            },
          ],
        }),
      }),
    );
    assert.equal(compileResponse.status, 200);
    assert.equal(compileResponse.headers.get("x-sdn-flow-compile-pending"), "1");
    assert.equal(compileResponse.headers.get("x-sdn-flow-restart-pending"), null);
    assert.equal(compileCalls.length, 1);
    assert.equal(compileCalls[0][0].type, "tab");

    const runtimeSettingsResponse = await handler(
      new Request("http://example.test/editor/api/runtime-settings"),
    );
    assert.equal(runtimeSettingsResponse.status, 200);
    const runtimeSettings = await runtimeSettingsResponse.json();
    assert.equal(runtimeSettings.startup.protocol, "http");
    assert.equal(runtimeSettings.startup.basePath, "/editor");
    assert.equal(runtimeSettings.artifactArchiveLimit, 100);
    assert.equal(typeof runtimeSettings.security.storageDir, "string");

    const runtimeStatusResponse = await handler(
      new Request("http://example.test/editor/api/runtime-status"),
    );
    assert.equal(runtimeStatusResponse.status, 200);
    const runtimeStatus = await runtimeStatusResponse.json();
    assert.equal(runtimeStatus.compiledRuntimeLoaded, true);
    assert.equal(runtimeStatus.activeBuild.outputName, "flow-runtime");
    assert.deepEqual(runtimeStatus.runtimeClassification.summary, {
      totalNodes: 3,
      families: 3,
      handlers: 2,
      byClassification: {
        compiled: 1,
        delegated: 1,
        "js-shim": 1,
      },
    });
    assert.equal(runtimeStatus.runtimeClassification.nodeFamilies[0].classification, "compiled");
    assert.equal(runtimeStatus.runtimeClassification.handlers[0].key, "com.digitalarsenal.editor.function:invoke");

    const updateRuntimeSettingsResponse = await handler(
      new Request("http://example.test/editor/api/runtime-settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          port: 9090,
          artifactArchiveLimit: 50,
        }),
      }),
    );
    const updatedRuntimeSettings = await updateRuntimeSettingsResponse.json();
    assert.equal(updatedRuntimeSettings.startup.port, 9090);
    assert.equal(updatedRuntimeSettings.artifactArchiveLimit, 50);

    const flowStateResponse = await handler(
      new Request("http://example.test/editor/flows/state"),
    );
    assert.equal((await flowStateResponse.json()).state, "start");

    const stopFlowStateResponse = await handler(
      new Request("http://example.test/editor/flows/state", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: "state=stop",
      }),
    );
    assert.equal((await stopFlowStateResponse.json()).state, "stop");

    const stoppedInjectResponse = await handler(
      new Request("http://example.test/editor/inject/node-1", {
        method: "POST",
      }),
    );
    assert.equal(stoppedInjectResponse.status, 409);

    flowState = "start";
    const injectResponse = await handler(
      new Request("http://example.test/editor/inject/node-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          __user_inject_props__: [
            {
              p: "payload",
              v: "override",
              vt: "str",
            },
          ],
        }),
      }),
    );
    assert.equal(injectResponse.status, 200);
    assert.equal((await injectResponse.json()).nodeId, "node-1");
    assert.deepEqual(injectCalls, [
      {
        nodeId: "node-1",
        payload: {
          __user_inject_props__: [
            {
              p: "payload",
              v: "override",
              vt: "str",
            },
          ],
        },
      },
    ]);

    const enableDebugResponse = await handler(
      new Request("http://example.test/editor/debug/node-1/enable", {
        method: "POST",
      }),
    );
    assert.equal(enableDebugResponse.status, 200);

    const disableDebugResponse = await handler(
      new Request("http://example.test/editor/debug/disable", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: "nodes=node-1&nodes=node-2",
      }),
    );
    assert.equal(disableDebugResponse.status, 201);
    assert.deepEqual(debugStateCalls, [
      {
        nodeIds: ["node-1"],
        active: true,
      },
      {
        nodeIds: ["node-1", "node-2"],
        active: false,
      },
    ]);

    const archivesResponse = await handler(
      new Request("http://example.test/editor/api/archives"),
    );
    assert.equal(archivesResponse.status, 200);
    const archives = await archivesResponse.json();
    assert.equal(archives.length, 1);

    const deleteArchiveResponse = await handler(
      new Request("http://example.test/editor/api/archives/flow-1-archive.json", {
        method: "DELETE",
      }),
    );
    assert.equal(deleteArchiveResponse.status, 200);
    assert.deepEqual(deletedArchives, ["flow-1-archive.json"]);

    const nodeCatalogResponse = await handler(
      new Request("http://example.test/editor/nodes", {
        headers: {
          accept: "application/json",
        },
      }),
    );
    const nodeCatalog = await nodeCatalogResponse.json();
    assert.ok(nodeCatalog.some((entry) => entry.types.includes("inject")));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createSdnFlowEditorFetchHandler routes unmatched requests into the active flow HTTP runtime", async () => {
  const runtimeRequests = [];
  const handler = createSdnFlowEditorFetchHandler({
    basePath: "/editor",
    runtimeManager: {
      getRuntimeStatus() {
        return {
          runtimeId: "runtime-http",
          flowState: "start",
          startup: {
            protocol: "http",
            hostname: "127.0.0.1",
            port: 1990,
            basePath: "/editor",
            title: "HTTP Editor",
          },
          activeStartup: {
            protocol: "http",
            hostname: "127.0.0.1",
            port: 1990,
            basePath: "/editor",
            title: "HTTP Editor",
          },
          compilePending: false,
          compileId: null,
          restartUrl: "http://127.0.0.1:1990/editor/",
          artifactArchiveLimit: 100,
          compiledRuntimeLoaded: true,
          activeBuild: {
            compileId: "compile-http",
            createdAt: "2026-03-18T12:00:00.000Z",
            outputName: "flow-runtime",
            programId: "flow-http",
            runtimeModel: "compiled-cpp-wasm",
          },
          debugSequence: 0,
          debugMessages: [],
        };
      },
      getStartupSettings() {
        return {
          protocol: "http",
          hostname: "127.0.0.1",
          port: 1990,
          basePath: "/editor",
          title: "HTTP Editor",
        };
      },
      getFlowState() {
        return "start";
      },
      async handleHttpRequest(request) {
        runtimeRequests.push(request);
        return {
          triggerId: "trigger-http-in-1",
          route: "/hello/:name",
          outputs: [
            {
              frame: {
                payload: "hello ada",
                metadata: {
                  statusCode: 201,
                  responseHeaders: {
                    "content-type": "text/plain; charset=utf-8",
                    "x-runtime": "connected",
                  },
                },
              },
            },
          ],
        };
      },
    },
  });

  const response = await handler(
    new Request("http://example.test/editor/hello/ada?lang=en", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "runtime-req-1",
      },
      body: JSON.stringify({
        enabled: true,
      }),
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-runtime"), "connected");
  assert.equal(await response.text(), "hello ada");
  assert.equal(runtimeRequests.length, 1);
  assert.equal(runtimeRequests[0].path, "/hello/ada");
  assert.equal(runtimeRequests[0].method, "POST");
  assert.equal(runtimeRequests[0].requestId, "runtime-req-1");
  assert.deepEqual(runtimeRequests[0].query, {
    lang: "en",
  });
  assert.equal(runtimeRequests[0].metadata.originalUrl, "http://example.test/editor/hello/ada?lang=en");
});

test("createSdnFlowEditorFetchHandler prefers active compiled build flows when no explicit initial flow is provided", async () => {
  const handler = createSdnFlowEditorFetchHandler({
    runtimeManager: {
      getRuntimeStatus() {
        return {
          runtimeId: "runtime-active-build",
          flowState: "start",
          startup: {
            protocol: "http",
            hostname: "127.0.0.1",
            port: 1990,
            basePath: "/",
            title: "Active Build Editor",
          },
          activeStartup: {
            protocol: "http",
            hostname: "127.0.0.1",
            port: 1990,
            basePath: "/",
            title: "Active Build Editor",
          },
          compilePending: false,
          compileId: null,
          restartUrl: "http://127.0.0.1:1990/",
          artifactArchiveLimit: 100,
          compiledRuntimeLoaded: true,
          activeBuild: {
            compileId: "compile-build",
            createdAt: "2026-03-18T12:00:00.000Z",
            outputName: "flow-runtime",
            programId: "flow-1",
            runtimeModel: "compiled-cpp-wasm",
          },
          debugSequence: 0,
          debugMessages: [],
        };
      },
      getStartupSettings() {
        return {
          protocol: "http",
          hostname: "127.0.0.1",
          port: 1990,
          basePath: "/",
          title: "Active Build Editor",
        };
      },
      getFlowState() {
        return "start";
      },
      getActiveBuild() {
        return {
          flows: [
            {
              id: "flow-active",
              type: "tab",
              label: "Active Build Flow",
              disabled: false,
              info: "",
            },
            {
              id: "debug-active",
              z: "flow-active",
              type: "debug",
              name: "runtime debug",
              active: true,
              tosidebar: true,
              console: false,
              tostatus: false,
              complete: "payload",
              targetType: "msg",
              x: 240,
              y: 80,
              wires: [],
            },
          ],
        };
      },
      async updateStartupSettings() {
        return {
          startup: this.getStartupSettings(),
          activeStartup: this.getStartupSettings(),
          restartUrl: "http://127.0.0.1:1990/",
          artifactArchiveLimit: 100,
        };
      },
      setFlowState(state) {
        return { state };
      },
      async listArchives() {
        return [];
      },
      async deleteArchive(id) {
        return { deleted: true, id };
      },
      async readActiveArtifactWasm() {
        return null;
      },
      getTargetExecutablePath() {
        return null;
      },
      async dispatchInject(nodeId) {
        return { injected: true, nodeId };
      },
      setDebugNodeState(nodeIds, active) {
        return { ok: true, nodes: nodeIds, active };
      },
      async scheduleCompile() {
        return {
          compileId: "compile-build",
          restartPending: false,
          restartUrl: null,
        };
      },
    },
  });

  const flowsResponse = await handler(
    new Request("http://example.test/flows"),
  );
  assert.equal(flowsResponse.status, 200);
  const flows = await flowsResponse.json();
  assert.equal(flows.flows[0].id, "flow-active");
  assert.equal(flows.flows[0].label, "Active Build Flow");
  assert.equal(flows.flows[1].id, "debug-active");

  const bootstrapResponse = await handler(
    new Request("http://example.test/api/bootstrap"),
  );
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.initialFlow[0].id, "flow-active");
  assert.equal(bootstrap.initialFlow[1].id, "debug-active");
});

test("startSdnFlowEditorNodeHost serves the embedded runtime shell", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-host-"));
  const host = await startSdnFlowEditorNodeHost({
    projectRoot: tempDir,
    hostname: "127.0.0.1",
    port: 0,
    title: "Node Host Editor",
  });

  try {
    const response = await fetch(host.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /red-ui-editor/);
    assert.equal(typeof host.runtimeManager.getRuntimeStatus().runtimeId, "string");
  } finally {
    await host.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startSdnFlowEditorNodeHost provisions managed HTTPS certificates and serves the shell over TLS", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-host-https-"));
  const host = await startSdnFlowEditorNodeHost({
    projectRoot: tempDir,
    protocol: "https",
    hostname: "127.0.0.1",
    port: 0,
    title: "Node Host HTTPS Editor",
    security: {
      storageDir: path.join(tempDir, ".sdn-flow-security"),
    },
  });

  try {
    const securityStatus = host.runtimeManager.getRuntimeStatus().securityStatus;
    assert.equal(host.protocol, "https");
    assert.match(host.url, /^https:\/\//);
    assert.equal(typeof securityStatus?.wallet?.recordPath, "string");
    assert.equal(typeof securityStatus?.tls?.trustCertificatePath, "string");

    const trustCertificate = await fs.readFile(
      securityStatus.tls.trustCertificatePath,
      "utf8",
    );
    const response = await requestTextOverHttps(host.url, trustCertificate);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /red-ui-editor/);
  } finally {
    await host.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
