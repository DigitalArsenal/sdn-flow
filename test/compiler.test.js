import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import {
  createSingleFileBundle,
  SDS_GUEST_LINK_METADATA_ENTRY_ID,
  SDS_GUEST_LINK_OBJECT_ENTRY_ID,
  SDS_GUEST_LINK_SECTION_NAME,
} from "space-data-module-sdk";
import {
  buildDefaultFlowManifestBuffer,
  decodeCompiledArtifactManifest,
  createSdkEmceptionSession,
  EmceptionCompilerAdapter,
  RuntimeTarget,
  SignedArtifactCatalog,
} from "../src/index.js";
import {
  createGeneratorRequest,
  INVALID_INDEX,
} from "../src/compiler/CppFlowSourceGenerator.js";
import { SDK_EMCEPTION_SESSION_KIND } from "../src/compiler/sdkEmceptionSession.js";
import { compileLinkedFlowArtifact } from "../test-support/linkedFlowArtifact.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function wasmBytes(seed) {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, seed, seed + 1, seed + 2]);
}

function bundledCarrierWasmBytes() {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
}

function createStubFlowRuntimeSource() {
  const pointerFunctions = [
    "sdn_flow_get_runtime_descriptor",
    "sdn_flow_get_type_descriptors",
    "sdn_flow_get_accepted_type_indices",
    "sdn_flow_get_trigger_descriptors",
    "sdn_flow_get_node_descriptors",
    "sdn_flow_get_node_dispatch_descriptors",
    "sdn_flow_get_edge_descriptors",
    "sdn_flow_get_trigger_binding_descriptors",
    "sdn_flow_get_dependency_descriptors",
    "sdn_flow_get_ingress_descriptors",
    "sdn_flow_get_ingress_frame_descriptors",
    "sdn_flow_get_node_ingress_indices",
    "sdn_flow_get_external_interface_descriptors",
    "sdn_flow_get_ingress_runtime_states",
    "sdn_flow_get_node_runtime_states",
    "sdn_flow_get_current_invocation_descriptor",
  ];
  const countFunctions = [
    "flow_get_manifest_flatbuffer_size",
    "sdn_flow_get_editor_metadata_size",
    "sdn_flow_get_type_descriptor_count",
    "sdn_flow_get_accepted_type_index_count",
    "sdn_flow_get_trigger_descriptor_count",
    "sdn_flow_get_node_descriptor_count",
    "sdn_flow_get_node_dispatch_descriptor_count",
    "sdn_flow_get_edge_descriptor_count",
    "sdn_flow_get_trigger_binding_descriptor_count",
    "sdn_flow_get_dependency_count",
    "sdn_flow_get_ingress_descriptor_count",
    "sdn_flow_get_ingress_frame_descriptor_count",
    "sdn_flow_get_node_ingress_index_count",
    "sdn_flow_get_external_interface_descriptor_count",
    "sdn_flow_get_ingress_runtime_state_count",
    "sdn_flow_get_node_runtime_state_count",
    "sdn_flow_prepare_node_invocation_descriptor",
    "sdn_flow_enqueue_trigger_frames",
    "sdn_flow_enqueue_trigger_frame",
    "sdn_flow_enqueue_edge_frames",
    "sdn_flow_enqueue_edge_frame",
    "sdn_flow_get_ready_node_index",
    "sdn_flow_begin_node_invocation",
    "sdn_flow_apply_node_invocation_result",
    "sdn_flow_dispatch_next_ready_node_with_host",
    "sdn_flow_drain_with_host_dispatch",
  ];
  const stringFunctions = [
    ["sdn_flow_get_program_id", "com.digitalarsenal.tests.flow"],
    ["sdn_flow_get_program_name", "Compiler Test Flow"],
    ["sdn_flow_get_program_version", "0.1.0"],
    ["sdn_flow_get_editor_metadata_json", "{}"],
  ];
  const voidFunctions = [
    "sdn_flow_reset_runtime_state",
    "sdn_flow_complete_node_invocation",
  ];

  return [
    "#include <cstddef>",
    "#include <cstdint>",
    'extern "C" {',
    "#define SDN_USED __attribute__((used))",
    "static const unsigned char kManifest[] = {0x46, 0x4c, 0x4f, 0x57, 0x31};",
    "int main() { return 0; }",
    "SDN_USED const unsigned char * flow_get_manifest_flatbuffer() { return kManifest; }",
    ...countFunctions.map(
      (name) => `SDN_USED unsigned int ${name}() { return 0u; }`,
    ),
    ...stringFunctions.map(
      ([name, value]) => `SDN_USED const char * ${name}() { return "${value}"; }`,
    ),
    ...pointerFunctions.map(
      (name) => `SDN_USED const void * ${name}() { return nullptr; }`,
    ),
    ...voidFunctions.map((name) => `SDN_USED void ${name}() {}`),
    "}",
    "",
  ].join("\n");
}

test("signed artifact catalog resolves guest-link metadata from bundled wasm", async () => {
  const guestObjectBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]);
  const bundle = await createSingleFileBundle({
    wasmBytes: bundledCarrierWasmBytes(),
    entries: [
      {
        entryId: SDS_GUEST_LINK_OBJECT_ENTRY_ID,
        role: "auxiliary",
        sectionName: SDS_GUEST_LINK_SECTION_NAME,
        payloadEncoding: "raw-bytes",
        mediaType: "application/wasm",
        payload: guestObjectBytes,
      },
      {
        entryId: SDS_GUEST_LINK_METADATA_ENTRY_ID,
        role: "auxiliary",
        sectionName: SDS_GUEST_LINK_SECTION_NAME,
        payloadEncoding: "json-utf8",
        payload: {
          version: 1,
          format: "wasm-object",
          language: "cpp",
          symbolPrefix: "sdsguest_",
          methodSymbols: {
            handle_frame: "sdsguest_handle_frame",
          },
        },
      },
    ],
  });

  const catalog = new SignedArtifactCatalog();
  catalog.registerArtifact({
    dependencyId: "dep-bundled",
    pluginId: "com.digitalarsenal.tests.bundled",
    version: "1.0.0",
    signature: "sig",
    signerPublicKey: "pub",
    singleFileBundle: bundle,
  });

  const [resolved] = await catalog.resolveProgramDependencies({
    programId: "com.digitalarsenal.tests.catalog",
    nodes: [],
    edges: [],
    triggers: [],
    triggerBindings: [],
    requiredPlugins: [],
    artifactDependencies: [
      {
        dependencyId: "dep-bundled",
        pluginId: "com.digitalarsenal.tests.bundled",
        version: "1.0.0",
      },
    ],
  });

  assert.equal(resolved.wasm instanceof Uint8Array, true);
  assert.equal(resolved.guestLink?.symbolPrefix, "sdsguest_");
  assert.equal(
    resolved.guestLink?.methodSymbols?.handle_frame,
    "sdsguest_handle_frame",
  );
  assert.deepEqual(resolved.guestLink?.objectBytes, guestObjectBytes);
});

test("cpp flow source generator request carries resolved dependency link symbols", async () => {
  const request = createGeneratorRequest({
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
    program: {
      programId: "com.digitalarsenal.tests.linked-request",
      nodes: [
        {
          nodeId: "linked-node",
          pluginId: "com.digitalarsenal.tests.linked",
          methodId: "handle_frame",
          kind: "method",
        },
        {
          nodeId: "unresolved-node",
          pluginId: "com.digitalarsenal.tests.unresolved",
          methodId: "noop",
          kind: "method",
        },
      ],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: [],
      artifactDependencies: [
        {
          dependencyId: "dep-linked",
          pluginId: "com.digitalarsenal.tests.linked",
          version: "1.0.0",
        },
      ],
    },
    dependencies: [
      {
        dependencyId: "dep-linked",
        pluginId: "com.digitalarsenal.tests.linked",
        version: "1.0.0",
        signature: "sig",
        signerPublicKey: "pub",
        wasm: wasmBytes(1),
        guestLink: {
          methodSymbols: {
            handle_frame: "sdsguest_handle_frame",
          },
        },
      },
    ],
  });

  assert.equal(request.nodes[0].dependencyId, "dep-linked");
  assert.equal(request.nodes[0].dependencyIndex, 0);
  assert.equal(
    request.nodes[0].linkedMethodSymbol,
    "sdsguest_handle_frame",
  );
  assert.equal(request.nodes[1].dependencyId, "");
  assert.equal(request.nodes[1].dependencyIndex, INVALID_INDEX);
  assert.equal(request.nodes[1].linkedMethodSymbol, "");
});

test("emception compiler adapter prepares standalone compile plans with linked guest objects", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const catalog = new SignedArtifactCatalog();
  flow.artifactDependencies.forEach((dependency, index) => {
    catalog.registerArtifact({
      dependencyId: dependency.dependencyId,
      pluginId: dependency.pluginId,
      version: dependency.version,
      signature: dependency.signature,
      signerPublicKey: dependency.signerPublicKey,
      entrypoint: "main",
      runtimeExports: {
        initSymbol: "plugin_init",
        destroySymbol: "plugin_destroy",
        mallocSymbol: "malloc",
        freeSymbol: "free",
        streamInvokeSymbol: "plugin_stream_invoke",
      },
      wasm: wasmBytes(index + 1),
      manifestBuffer: new Uint8Array([0x50, 0x4c, 0x55, 0x47, index + 1]),
      guestLink:
        index === 0
          ? {
              format: "wasm-object",
              language: "cpp",
              symbolPrefix: "sdsguest_",
              methodSymbols: {
                source: "sdsguest_source",
              },
              objectBytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]),
            }
          : null,
    });
  });

  const compiler = new EmceptionCompilerAdapter({
    artifactCatalog: catalog,
    sourceGenerator: async () => ({
      source: createStubFlowRuntimeSource(),
      generatorModel: "test-stub-cpp",
    }),
    manifestBuilder: async () =>
      new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
  });

  const prepared = await compiler.prepareCompile({ program: flow });
  const expectedLinkedPath = "linked-dependencies/0-flatsql-store-signed.o";
  assert.equal(prepared.dependencies.length, 6);
  assert.equal(prepared.runtimeModel, "compiled-cpp-wasm");
  assert.equal(prepared.sourceGeneratorModel, "test-stub-cpp");
  assert.equal(prepared.runtimeExports.mallocSymbol, "malloc");
  assert.equal(
    prepared.runtimeExports.descriptorSymbol,
    "sdn_flow_get_runtime_descriptor",
  );
  assert.equal(prepared.linkedDependencySourceFiles.length, 1);
  assert.equal(prepared.sourceFiles.length, 2);
  assert.equal(prepared.sourceFiles[1].path, `/working/${expectedLinkedPath}`);
  assert.deepEqual(
    prepared.sourceFiles[1].content,
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]),
  );
  assert.match(prepared.command, /-sSTANDALONE_WASM=1/);
  assert.doesNotMatch(prepared.command, /--no-entry/);
  assert.match(prepared.command, new RegExp(expectedLinkedPath));
  assert.match(prepared.command, /\/working\/flow-runtime\.wasm$/);
  assert.match(prepared.command, /_sdn_flow_get_runtime_descriptor/);
  assert.match(prepared.command, /_malloc/);
  assert.match(prepared.command, /_free/);
});

test("emception compiler adapter compiles standalone flow wasm with a stub source generator", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const workingDirectory = `/working/compiler-test-${randomUUID()}`;
  const emception = await createSdkEmceptionSession({
    workingDirectory,
  });

  try {
    const compiler = new EmceptionCompilerAdapter({
      emception,
      artifactCatalog: {
        async resolveProgramDependencies() {
          return [];
        },
      },
      sourceGenerator: async () => ({
        source: createStubFlowRuntimeSource(),
        generatorModel: "test-stub-cpp",
      }),
      manifestBuilder: async () =>
        new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
    });

    const artifact = await compiler.compile({ program: flow });
    assert.equal(artifact.programId, flow.programId);
    assert.equal(artifact.runtimeModel, "compiled-cpp-wasm");
    assert.equal(artifact.sourceGeneratorModel, "test-stub-cpp");
    assert.equal(
      artifact.runtimeExports.descriptorSymbol,
      "sdn_flow_get_runtime_descriptor",
    );
    assert.equal(artifact.runtimeExports.freeSymbol, "free");
    assert.equal(
      artifact.runtimeExports.typeDescriptorsSymbol,
      "sdn_flow_get_type_descriptors",
    );
    assert.equal(
      artifact.runtimeExports.nodeIngressIndicesSymbol,
      "sdn_flow_get_node_ingress_indices",
    );
    assert.equal(
      artifact.runtimeExports.nodeDispatchDescriptorCountSymbol,
      "sdn_flow_get_node_dispatch_descriptor_count",
    );
    assert.equal(
      artifact.runtimeExports.currentInvocationDescriptorSymbol,
      "sdn_flow_get_current_invocation_descriptor",
    );
    assert.equal(
      artifact.runtimeExports.readyNodeSymbol,
      "sdn_flow_get_ready_node_index",
    );
    assert.equal(
      artifact.runtimeExports.applyInvocationResultSymbol,
      "sdn_flow_apply_node_invocation_result",
    );
    assert.equal(
      artifact.runtimeExports.dispatchHostInvocationSymbol,
      "sdn_flow_dispatch_next_ready_node_with_host",
    );
    assert.equal(
      artifact.runtimeExports.drainWithHostDispatchSymbol,
      "sdn_flow_drain_with_host_dispatch",
    );
    assert.equal(
      artifact.runtimeExports.editorMetadataJsonSymbol,
      "sdn_flow_get_editor_metadata_json",
    );
    assert.equal(
      artifact.runtimeExports.editorMetadataSizeSymbol,
      "sdn_flow_get_editor_metadata_size",
    );
    assert.ok(artifact.wasm instanceof Uint8Array);
    assert.equal(artifact.loaderModule.includes("export default"), true);
  } finally {
    await emception.removeDirectory(workingDirectory).catch(() => {});
    await emception.dispose().catch(() => {});
  }
});

test("emception compiler adapter compiles fully linked standalone flow wasm without the sdn_flow_host dispatch import", async () => {
  const { artifact } = await compileLinkedFlowArtifact({
    runtimeTargets: [RuntimeTarget.WASMEDGE],
    workingDirectory: `/working/compiler-linked-${randomUUID()}`,
  });

  const module = new WebAssembly.Module(artifact.wasm);
  const imports = WebAssembly.Module.imports(module);
  const exportNames = WebAssembly.Module.exports(module).map(
    (entry) => entry.name,
  );

  assert.equal(
    imports.some(
      (entry) =>
        entry.module === "sdn_flow_host" &&
        entry.name === "dispatch_current_invocation",
    ),
    false,
  );
  assert.equal(exportNames.includes("_start"), true);
  assert.equal(
    exportNames.includes("sdn_flow_dispatch_next_ready_node_with_host"),
    true,
  );
});

test("emception compiler adapter carries dependency invoke-surface metadata into the manifest buffer", async () => {
  const program = {
    programId: "com.digitalarsenal.tests.command-only",
    version: "0.2.8",
    nodes: [],
    edges: [],
    triggers: [],
    triggerBindings: [],
    requiredPlugins: [],
    artifactDependencies: [
      {
        dependencyId: "dep-command",
        pluginId: "com.digitalarsenal.runtime.command",
        version: "1.0.0",
        invokeSurface: "command",
      },
    ],
  };
  const catalog = new SignedArtifactCatalog();
  catalog.registerArtifact({
    dependencyId: "dep-command",
    pluginId: "com.digitalarsenal.runtime.command",
    version: "1.0.0",
    signature: "sig",
    signerPublicKey: "pub",
    invokeSurface: "command",
    runtimeExports: {
      initSymbol: null,
      destroySymbol: null,
      mallocSymbol: null,
      freeSymbol: null,
      streamInvokeSymbol: null,
    },
    wasm: wasmBytes(9),
    manifestBuffer: new Uint8Array([0x50, 0x4c, 0x55, 0x47, 0x09]),
  });

  const compiler = new EmceptionCompilerAdapter({
    artifactCatalog: catalog,
    manifestBuilder: buildDefaultFlowManifestBuffer,
  });

  const prepared = await compiler.prepareCompile({ program });
  const manifest = decodeCompiledArtifactManifest({
    manifestBuffer: prepared.manifestBuffer,
  });
  assert.deepEqual(manifest?.invokeSurfaces, ["command"]);
});

test("emception compiler adapter rejects artifact compilation without an SDK emception session", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const compiler = new EmceptionCompilerAdapter({
    artifactCatalog: {
      async resolveProgramDependencies() {
        return [];
      },
    },
    manifestBuilder: async () => new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
  });

  await assert.rejects(
    compiler.compile({ program: flow }),
    /Artifact compilation requires an SDK emception session/,
  );
});

test("emception compiler adapter rejects SDK-labeled impostor sessions for artifact compilation", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const compiler = new EmceptionCompilerAdapter({
    artifactCatalog: {
      async resolveProgramDependencies() {
        return [];
      },
    },
    emception: {
      sessionKind: SDK_EMCEPTION_SESSION_KIND,
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
    },
    manifestBuilder: async () => new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x31]),
  });

  await assert.rejects(
    compiler.compile({ program: flow }),
    /only supports SDK emception sessions/,
  );
});
