import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileNodeRedFlowsToSdnArtifact } from "../src/editor/compileArtifact.js";
import { resolveSdnFlowEditorCompileArtifactScriptPath } from "../src/editor/compileArtifactSubprocess.js";
import { SDK_EMCEPTION_SESSION_KIND } from "../src/compiler/sdkEmceptionSession.js";

function createFakeSdkEmceptionSession({
  files = new Map(),
  steps = null,
  wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
} = {}) {
  return {
    sessionKind: SDK_EMCEPTION_SESSION_KIND,
    async init() {
      steps?.push(["init"]);
    },
    async writeFile(filePath, content) {
      steps?.push(["write", filePath]);
      files.set(filePath, content);
    },
    async run(command) {
      steps?.push(["run", command]);
      const outputMatch = String(command).match(/ -o (\S+\.wasm)$/);
      assert.ok(outputMatch);
      files.set(outputMatch[1], wasmBytes);
      return {
        returncode: 0,
        stdout: "",
        stderr: "",
      };
    },
    async readFile(filePath, readOptions = {}) {
      steps?.push(["read", filePath]);
      const value = files.get(filePath);
      return readOptions.encoding === "utf8" ? value : value;
    },
    async removeDirectory(directoryPath) {
      steps?.push(["remove", directoryPath]);
    },
    async dispose() {
      steps?.push(["dispose"]);
    },
  };
}

test("compileNodeRedFlowsToSdnArtifact lowers editor flows into a serialized compiled artifact payload", async () => {
  const files = new Map();
  const result = await compileNodeRedFlowsToSdnArtifact(
    [
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        x: 100,
        y: 80,
        wires: [["debug-1"]],
      },
      {
        id: "debug-1",
        z: "flow-1",
        type: "debug",
        x: 240,
        y: 80,
        wires: [],
      },
    ],
    {
      outputName: "flow-runtime",
      sourceGenerator: async ({ program }) => {
        assert.equal(program.programId, "flow-1");
        assert.equal(program.triggers.length, 1);
        assert.equal(program.nodes.length, 1);
        return {
          source: "// generated source",
          generatorModel: "native-cpp-wasm",
        };
      },
      emceptionSessionFactory: async () =>
        createFakeSdkEmceptionSession({
          files,
        }),
    },
  );

  assert.equal(result.outputName, "flow-runtime");
  assert.equal(result.source, "// generated source");
  assert.equal(result.serializedArtifact.programId, "flow-1");
  assert.equal(result.serializedArtifact.wasmBase64, "AGFzbQ==");
  assert.equal(result.artifactSummary.programId, "flow-1");
  assert.equal(result.artifactSummary.wasmBytes, 4);
  assert.equal(result.program.triggers[0].triggerId, "trigger-inject-1");
  assert.equal(result.deploymentPlan.pluginId, "flow-1");
  assert.equal(result.deploymentPlan.scheduleBindings.length, 0);
});

test("compile artifact subprocess resolves helper scripts from the real project root when provided", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-editor-artifact-script-"));
  const scriptPath = path.join(tempDir, "scripts", "editor-compile-artifact.mjs");

  try {
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "export {};\n", "utf8");

    assert.equal(
      resolveSdnFlowEditorCompileArtifactScriptPath({
        cwd: tempDir,
      }),
      scriptPath,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("compileNodeRedFlowsToSdnArtifact derives delegated HTTP service bindings from http-in triggers", async () => {
  const files = new Map();
  const result = await compileNodeRedFlowsToSdnArtifact(
    [
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "http-in-1",
        z: "flow-1",
        type: "http in",
        method: "get",
        url: "/catalog",
        wires: [["debug-1"]],
      },
      {
        id: "debug-1",
        z: "flow-1",
        type: "debug",
        wires: [],
      },
    ],
    {
      serviceBindingMode: "delegated",
      delegatedServiceBaseUrl: "https://gateway.example.test/base/",
      defaultHttpAuthPolicyId: "approved-keys",
      deploymentPlan: {
        authPolicies: [
          {
            policyId: "approved-keys",
            bindingMode: "delegated",
            targetKind: "service",
            targetId: "service-trigger-http-in-1",
            allowServerKeys: ["ed25519:test-key"],
          },
        ],
      },
      sourceGenerator: async () => ({
        source: "// generated source",
        generatorModel: "native-cpp-wasm",
      }),
      emceptionSessionFactory: async () =>
        createFakeSdkEmceptionSession({
          files,
        }),
    },
  );

  assert.equal(result.deploymentPlan.serviceBindings.length, 1);
  assert.deepEqual(result.deploymentPlan.serviceBindings[0], {
    serviceId: "service-trigger-http-in-1",
    bindingMode: "delegated",
    serviceKind: "http-server",
    triggerId: "trigger-http-in-1",
    protocolId: null,
    routePath: "/catalog",
    method: "GET",
    transportKind: null,
    adapter: null,
    listenHost: null,
    listenPort: 0,
    remoteUrl: "https://gateway.example.test/catalog",
    allowTransports: ["https", "wss"],
    authPolicyId: "approved-keys",
    description: "[GET] /catalog",
    properties: {},
  });
});

test("compileNodeRedFlowsToSdnArtifact uses the emception session interface instead of shelling out to host em++", async () => {
  const files = new Map();
  const steps = [];

  const result = await compileNodeRedFlowsToSdnArtifact(
    [
      {
        id: "flow-1",
        type: "tab",
        label: "Flow 1",
      },
      {
        id: "inject-1",
        z: "flow-1",
        type: "inject",
        wires: [["debug-1"]],
      },
      {
        id: "debug-1",
        z: "flow-1",
        type: "debug",
        wires: [],
      },
    ],
    {
          sourceGenerator: async () => ({
            source: "int main() { return 0; }\n",
            generatorModel: "test-generator",
          }),
          emceptionSessionFactory: async ({ workingDirectory }) => {
            steps.push(["session", workingDirectory]);
            return createFakeSdkEmceptionSession({
              files,
              steps,
            });
          },
        },
      );

  assert.equal(result.sourceGeneratorModel, "test-generator");
  assert.equal(result.serializedArtifact.programId, "flow-1");
  assert.match(
    steps.find((entry) => entry[0] === "run")?.[1] ?? "",
    /^em\+\+/,
  );
  assert.match(
    steps.find((entry) => entry[0] === "session")?.[1] ?? "",
    /^\/working\/sdn-flow-editor-artifact-/,
  );
  assert.equal(steps.some((entry) => entry[0] === "remove"), true);
  assert.equal(result.deploymentPlan.scheduleBindings.length, 0);
});

test("compileNodeRedFlowsToSdnArtifact rejects direct compiler overrides for artifact builds", async () => {
  await assert.rejects(
    compileNodeRedFlowsToSdnArtifact(
      [
        {
          id: "flow-1",
          type: "tab",
          label: "Flow 1",
        },
      ],
      {
        compiler: {
          async compile() {
            throw new Error("should not be called");
          },
        },
      },
    ),
    /Artifact compilation no longer accepts compiler overrides/,
  );
});

test("compileNodeRedFlowsToSdnArtifact rejects unmarked alternate emception session factories", async () => {
  await assert.rejects(
    compileNodeRedFlowsToSdnArtifact(
      [
        {
          id: "flow-1",
          type: "tab",
          label: "Flow 1",
        },
      ],
      {
        sourceGenerator: async () => ({
          source: "int main() { return 0; }\n",
          generatorModel: "test-generator",
        }),
        emceptionSessionFactory: async () => ({
          async init() {},
          async writeFile() {},
          async readFile() {
            return new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
          },
          async run() {
            return {
              returncode: 0,
              stdout: "",
              stderr: "",
            };
          },
          async removeDirectory() {},
        }),
      },
    ),
    /only supports SDK emception sessions/,
  );
});
