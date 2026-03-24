import path from "node:path";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import { normalizeProgram } from "../runtime/index.js";
import { bytesToHex, toUint8Array } from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";
import { generateCppFlowRuntimeSource } from "./CppFlowSourceGenerator.js";
import { SignedArtifactCatalog } from "./SignedArtifactCatalog.js";
import { SDK_EMCEPTION_SESSION_KIND } from "./sdkEmceptionSession.js";

const DEFAULT_FLAGS = Object.freeze([
  "-std=c++20",
  "-O2",
  "-sWASM=1",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sERROR_ON_UNDEFINED_SYMBOLS=0",
  "-Wl,--no-entry",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_flow_get_manifest_flatbuffer','_flow_get_manifest_flatbuffer_size','_sdn_flow_get_program_id','_sdn_flow_get_program_name','_sdn_flow_get_program_version','_sdn_flow_get_editor_metadata_json','_sdn_flow_get_editor_metadata_size','_sdn_flow_get_type_descriptors','_sdn_flow_get_type_descriptor_count','_sdn_flow_get_accepted_type_indices','_sdn_flow_get_accepted_type_index_count','_sdn_flow_get_trigger_descriptors','_sdn_flow_get_trigger_descriptor_count','_sdn_flow_get_node_descriptors','_sdn_flow_get_node_descriptor_count','_sdn_flow_get_node_dispatch_descriptors','_sdn_flow_get_node_dispatch_descriptor_count','_sdn_flow_get_edge_descriptors','_sdn_flow_get_edge_descriptor_count','_sdn_flow_get_trigger_binding_descriptors','_sdn_flow_get_trigger_binding_descriptor_count','_sdn_flow_get_dependency_descriptors','_sdn_flow_get_dependency_count','_sdn_flow_get_ingress_descriptors','_sdn_flow_get_ingress_descriptor_count','_sdn_flow_get_ingress_frame_descriptors','_sdn_flow_get_ingress_frame_descriptor_count','_sdn_flow_get_node_ingress_indices','_sdn_flow_get_node_ingress_index_count','_sdn_flow_get_external_interface_descriptors','_sdn_flow_get_external_interface_descriptor_count','_sdn_flow_get_ingress_runtime_states','_sdn_flow_get_ingress_runtime_state_count','_sdn_flow_get_node_runtime_states','_sdn_flow_get_node_runtime_state_count','_sdn_flow_get_current_invocation_descriptor','_sdn_flow_prepare_node_invocation_descriptor','_sdn_flow_reset_runtime_state','_sdn_flow_enqueue_trigger_frames','_sdn_flow_enqueue_trigger_frame','_sdn_flow_enqueue_edge_frames','_sdn_flow_enqueue_edge_frame','_sdn_flow_get_ready_node_index','_sdn_flow_begin_node_invocation','_sdn_flow_complete_node_invocation','_sdn_flow_apply_node_invocation_result','_sdn_flow_dispatch_next_ready_node_with_host','_sdn_flow_drain_with_host_dispatch','_sdn_flow_get_runtime_descriptor']",
]);

const DEFAULT_RUNTIME_MODEL = "compiled-cpp-wasm";
const DEFAULT_WORKING_DIRECTORY = "/working";
const DEFAULT_RUNTIME_EXPORTS = Object.freeze({
  mallocSymbol: "malloc",
  freeSymbol: "free",
  descriptorSymbol: "sdn_flow_get_runtime_descriptor",
  typeDescriptorsSymbol: "sdn_flow_get_type_descriptors",
  typeDescriptorCountSymbol: "sdn_flow_get_type_descriptor_count",
  acceptedTypeIndicesSymbol: "sdn_flow_get_accepted_type_indices",
  acceptedTypeIndexCountSymbol: "sdn_flow_get_accepted_type_index_count",
  triggerDescriptorsSymbol: "sdn_flow_get_trigger_descriptors",
  triggerDescriptorCountSymbol: "sdn_flow_get_trigger_descriptor_count",
  nodeDescriptorsSymbol: "sdn_flow_get_node_descriptors",
  nodeDescriptorCountSymbol: "sdn_flow_get_node_descriptor_count",
  nodeDispatchDescriptorsSymbol: "sdn_flow_get_node_dispatch_descriptors",
  nodeDispatchDescriptorCountSymbol:
    "sdn_flow_get_node_dispatch_descriptor_count",
  edgeDescriptorsSymbol: "sdn_flow_get_edge_descriptors",
  edgeDescriptorCountSymbol: "sdn_flow_get_edge_descriptor_count",
  triggerBindingDescriptorsSymbol: "sdn_flow_get_trigger_binding_descriptors",
  triggerBindingDescriptorCountSymbol:
    "sdn_flow_get_trigger_binding_descriptor_count",
  dependencyDescriptorsSymbol: "sdn_flow_get_dependency_descriptors",
  dependencyCountSymbol: "sdn_flow_get_dependency_count",
  resetStateSymbol: "sdn_flow_reset_runtime_state",
  ingressDescriptorsSymbol: "sdn_flow_get_ingress_descriptors",
  ingressDescriptorCountSymbol: "sdn_flow_get_ingress_descriptor_count",
  ingressFrameDescriptorsSymbol: "sdn_flow_get_ingress_frame_descriptors",
  ingressFrameDescriptorCountSymbol:
    "sdn_flow_get_ingress_frame_descriptor_count",
  nodeIngressIndicesSymbol: "sdn_flow_get_node_ingress_indices",
  nodeIngressIndexCountSymbol: "sdn_flow_get_node_ingress_index_count",
  externalInterfaceDescriptorsSymbol:
    "sdn_flow_get_external_interface_descriptors",
  externalInterfaceDescriptorCountSymbol:
    "sdn_flow_get_external_interface_descriptor_count",
  ingressStatesSymbol: "sdn_flow_get_ingress_runtime_states",
  ingressStateCountSymbol: "sdn_flow_get_ingress_runtime_state_count",
  nodeStatesSymbol: "sdn_flow_get_node_runtime_states",
  nodeStateCountSymbol: "sdn_flow_get_node_runtime_state_count",
  currentInvocationDescriptorSymbol:
    "sdn_flow_get_current_invocation_descriptor",
  prepareInvocationDescriptorSymbol:
    "sdn_flow_prepare_node_invocation_descriptor",
  enqueueTriggerSymbol: "sdn_flow_enqueue_trigger_frames",
  enqueueTriggerFrameSymbol: "sdn_flow_enqueue_trigger_frame",
  enqueueEdgeSymbol: "sdn_flow_enqueue_edge_frames",
  enqueueEdgeFrameSymbol: "sdn_flow_enqueue_edge_frame",
  readyNodeSymbol: "sdn_flow_get_ready_node_index",
  beginInvocationSymbol: "sdn_flow_begin_node_invocation",
  completeInvocationSymbol: "sdn_flow_complete_node_invocation",
  applyInvocationResultSymbol: "sdn_flow_apply_node_invocation_result",
  dispatchHostInvocationSymbol: "sdn_flow_dispatch_next_ready_node_with_host",
  drainWithHostDispatchSymbol: "sdn_flow_drain_with_host_dispatch",
  editorMetadataJsonSymbol: "sdn_flow_get_editor_metadata_json",
  editorMetadataSizeSymbol: "sdn_flow_get_editor_metadata_size",
});

async function maybeCall(value) {
  return value instanceof Promise ? value : Promise.resolve(value);
}

function normalizeWorkingDirectory(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (!normalized) {
    return DEFAULT_WORKING_DIRECTORY;
  }
  return normalized.startsWith("/")
    ? path.posix.normalize(normalized)
    : path.posix.join(DEFAULT_WORKING_DIRECTORY, normalized);
}

function isSdkEmceptionSession(session) {
  return (
    Boolean(session) &&
    session.sessionKind === SDK_EMCEPTION_SESSION_KIND &&
    typeof session.writeFile === "function" &&
    typeof session.readFile === "function" &&
    typeof session.run === "function"
  );
}

function createPortableLoaderModuleSource() {
  return [
    "export default async function createSdnFlowRuntimeLoader(module = {}) {",
    "  const toBytes = (value) => {",
    "    if (value instanceof Uint8Array) {",
    "      return value;",
    "    }",
    "    if (ArrayBuffer.isView(value)) {",
    "      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);",
    "    }",
    "    if (value instanceof ArrayBuffer) {",
    "      return new Uint8Array(value);",
    "    }",
    '    throw new Error("Loader module requires wasmBinary bytes.");',
    "  };",
    "  const incomingImports = module.imports ?? {};",
    "  const baseImports = {",
    "    ...incomingImports,",
    "    env: {",
    "      emscripten_notify_memory_growth() {},",
    "      ...(incomingImports.env ?? {}),",
    "    },",
    "    wasi_snapshot_preview1: {",
    "      args_sizes_get() { return 0; },",
    "      args_get() { return 0; },",
    "      proc_exit() { return 0; },",
    "      ...(incomingImports.wasi_snapshot_preview1 ?? {}),",
    "    },",
    "  };",
    "  if (typeof module.instantiateWasm === 'function') {",
    "    let instance = null;",
    "    let wasmModule = null;",
    "    const result = await module.instantiateWasm(baseImports, (nextInstance, nextModule) => {",
    "      instance = nextInstance;",
    "      wasmModule = nextModule;",
    "    });",
    "    const exports = instance?.exports ?? result ?? {};",
    "    return {",
    "      ...exports,",
    "      memory: exports.memory ?? null,",
    "      wasmMemory: exports.memory ?? null,",
    "      instance,",
    "      module: wasmModule,",
    "    };",
    "  }",
    "  const instantiated = await WebAssembly.instantiate(",
    "    toBytes(module.wasmBinary),",
    "    baseImports,",
    "  );",
    "  return {",
    "    ...instantiated.instance.exports,",
    "    memory: instantiated.instance.exports.memory ?? null,",
    "    wasmMemory: instantiated.instance.exports.memory ?? null,",
    "    instance: instantiated.instance,",
    "    module: instantiated.module,",
    "  };",
    "}",
    "",
  ].join("\n");
}

export class EmceptionCompilerAdapter {
  #emception;

  #manifestBuilder;

  #artifactCatalog;

  #sourceGenerator;

  #flags;

  #outputName;

  constructor(options = {}) {
    this.#emception = options.emception ?? null;
    this.#manifestBuilder = options.manifestBuilder ?? null;
    this.#artifactCatalog =
      options.artifactCatalog ?? new SignedArtifactCatalog();
    this.#sourceGenerator =
      options.sourceGenerator ?? generateCppFlowRuntimeSource;
    this.#flags = Array.isArray(options.flags) ? options.flags : DEFAULT_FLAGS;
    this.#outputName = String(options.outputName ?? "flow-runtime");
  }

  get artifactCatalog() {
    return this.#artifactCatalog;
  }

  async #buildManifestBuffer({ program, metadata, dependencies }) {
    if (metadata?.manifestBuffer) {
      return toUint8Array(metadata.manifestBuffer);
    }
    if (typeof this.#manifestBuilder === "function") {
      return toUint8Array(
        await maybeCall(
          this.#manifestBuilder({
            program,
            metadata,
            dependencies,
          }),
        ),
      );
    }
    throw new Error(
      "EmceptionCompilerAdapter requires metadata.manifestBuffer or manifestBuilder().",
    );
  }

  async prepareCompile({ program, metadata = null } = {}) {
    const normalizedProgram = normalizeProgram(program);
    const dependencies =
      await this.#artifactCatalog.resolveProgramDependencies(program);
    const manifestBuffer = await this.#buildManifestBuffer({
      program: normalizedProgram,
      metadata,
      dependencies,
    });
    const generatedSource = await maybeCall(
      this.#sourceGenerator({
        program: normalizedProgram,
        manifestBuffer,
        dependencies,
      }),
    );
    const source =
      typeof generatedSource === "string"
        ? generatedSource
        : (generatedSource?.source ?? "");
    const sourceGeneratorModel =
      typeof generatedSource === "string"
        ? "native-cpp-wasm"
        : (generatedSource?.generatorModel ?? "native-cpp-wasm");
    const outputName = String(metadata?.outputName ?? this.#outputName);
    const workingDirectory = normalizeWorkingDirectory(
      metadata?.workingDirectory,
    );
    const flags = Array.isArray(metadata?.flags) ? metadata.flags : this.#flags;
    return {
      program: normalizedProgram,
      manifestBuffer,
      dependencies,
      runtimeModel: DEFAULT_RUNTIME_MODEL,
      runtimeExports: { ...DEFAULT_RUNTIME_EXPORTS },
      sourceGeneratorModel,
      outputName,
      workingDirectory,
      flags,
      source,
      sourceFiles: [
        {
          path: path.posix.join(workingDirectory, "main.cpp"),
          content: source,
        },
      ],
      command: `em++ ${flags.join(" ")} ${path.posix.join(workingDirectory, "main.cpp")} -o ${path.posix.join(workingDirectory, `${outputName}.wasm`)}`,
    };
  }

  async compile({ program, metadata = null } = {}) {
    const compilePlan = await this.prepareCompile({ program, metadata });
    if (!this.#emception) {
      throw new Error(
        "Artifact compilation requires an SDK emception session. Use prepareCompile() for preview-only C++ output.",
      );
    }
    if (!isSdkEmceptionSession(this.#emception)) {
      throw new Error(
        "Artifact compilation only supports SDK emception sessions created via createSdkEmceptionSession().",
      );
    }

    if (typeof this.#emception.init === "function") {
      await maybeCall(this.#emception.init());
    }
    for (const file of compilePlan.sourceFiles) {
      await maybeCall(this.#emception.writeFile(file.path, file.content));
    }
    const result = await maybeCall(this.#emception.run(compilePlan.command));
    if (Number(result?.returncode ?? 1) !== 0) {
      throw new Error(
        `Emception compile failed: ${result?.stderr ?? result?.stdout ?? "unknown error"}`,
      );
    }

    const wasm = toUint8Array(
      await maybeCall(
        this.#emception.readFile(
          path.posix.join(
            compilePlan.workingDirectory,
            `${compilePlan.outputName}.wasm`,
          ),
        ),
      ),
    );
    const loaderModule = createPortableLoaderModuleSource();
    const requirements = summarizeProgramRequirements({
      program: compilePlan.program,
    });

    return {
      artifactId: `${compilePlan.program.programId}:${bytesToHex(
        await sha256Bytes(wasm),
      ).slice(0, 16)}`,
      programId: compilePlan.program.programId,
      runtimeModel: compilePlan.runtimeModel,
      sourceGeneratorModel: compilePlan.sourceGeneratorModel,
      format: "application/wasm",
      wasm,
      loaderModule,
      manifestBuffer: compilePlan.manifestBuffer,
      runtimeExports: compilePlan.runtimeExports,
      entrypoint: "main",
      graphHash: bytesToHex(
        await sha256Bytes(
          new TextEncoder().encode(JSON.stringify(compilePlan.program)),
        ),
      ),
      requiredCapabilities: requirements.capabilities,
      pluginVersions: compilePlan.dependencies.map((dependency) => ({
        pluginId: dependency.pluginId,
        version: dependency.version,
        sha256: dependency.sha256,
      })),
      schemaBindings: metadata?.schemaBindings ?? [],
      abiVersion: 1,
      compilePlan,
    };
  }
}

export default EmceptionCompilerAdapter;
