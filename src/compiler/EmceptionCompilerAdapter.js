import { summarizeProgramRequirements } from "../designer/requirements.js";
import { normalizeProgram } from "../runtime/index.js";
import { bytesToHex, toUint8Array } from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";
import { generateCppFlowRuntimeSource } from "./CppFlowSourceGenerator.js";
import { SignedArtifactCatalog } from "./SignedArtifactCatalog.js";

const DEFAULT_FLAGS = Object.freeze([
  "-std=c++20",
  "-O2",
  "-sWASM=1",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sNO_EXIT_RUNTIME=1",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web,worker,node",
  "-sEXPORTED_FUNCTIONS=['_main','_malloc','_free','_flow_get_manifest_flatbuffer','_flow_get_manifest_flatbuffer_size','_sdn_flow_get_program_id','_sdn_flow_get_program_name','_sdn_flow_get_program_version','_sdn_flow_get_type_descriptors','_sdn_flow_get_type_descriptor_count','_sdn_flow_get_accepted_type_indices','_sdn_flow_get_accepted_type_index_count','_sdn_flow_get_trigger_descriptors','_sdn_flow_get_trigger_descriptor_count','_sdn_flow_get_node_descriptors','_sdn_flow_get_node_descriptor_count','_sdn_flow_get_node_dispatch_descriptors','_sdn_flow_get_node_dispatch_descriptor_count','_sdn_flow_get_edge_descriptors','_sdn_flow_get_edge_descriptor_count','_sdn_flow_get_trigger_binding_descriptors','_sdn_flow_get_trigger_binding_descriptor_count','_sdn_flow_get_dependency_descriptors','_sdn_flow_get_dependency_count','_sdn_flow_get_ingress_descriptors','_sdn_flow_get_ingress_descriptor_count','_sdn_flow_get_ingress_frame_descriptors','_sdn_flow_get_ingress_frame_descriptor_count','_sdn_flow_get_node_ingress_indices','_sdn_flow_get_node_ingress_index_count','_sdn_flow_get_external_interface_descriptors','_sdn_flow_get_external_interface_descriptor_count','_sdn_flow_get_ingress_runtime_states','_sdn_flow_get_ingress_runtime_state_count','_sdn_flow_get_node_runtime_states','_sdn_flow_get_node_runtime_state_count','_sdn_flow_get_current_invocation_descriptor','_sdn_flow_prepare_node_invocation_descriptor','_sdn_flow_reset_runtime_state','_sdn_flow_enqueue_trigger_frames','_sdn_flow_enqueue_trigger_frame','_sdn_flow_enqueue_edge_frames','_sdn_flow_enqueue_edge_frame','_sdn_flow_get_ready_node_index','_sdn_flow_begin_node_invocation','_sdn_flow_complete_node_invocation','_sdn_flow_get_runtime_descriptor']",
]);

const DEFAULT_RUNTIME_MODEL = "compiled-cpp-wasm";
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
});

async function maybeCall(value) {
  return value instanceof Promise ? value : Promise.resolve(value);
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
      await this.#artifactCatalog.resolveProgramDependencies(normalizedProgram);
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
    const flags = Array.isArray(metadata?.flags) ? metadata.flags : this.#flags;
    return {
      program: normalizedProgram,
      manifestBuffer,
      dependencies,
      runtimeModel: DEFAULT_RUNTIME_MODEL,
      runtimeExports: { ...DEFAULT_RUNTIME_EXPORTS },
      sourceGeneratorModel,
      outputName,
      flags,
      source,
      sourceFiles: [
        {
          path: "/working/main.cpp",
          content: source,
        },
      ],
      command: `em++ ${flags.join(" ")} /working/main.cpp -o /working/${outputName}.mjs`,
    };
  }

  async compile({ program, metadata = null } = {}) {
    const compilePlan = await this.prepareCompile({ program, metadata });
    if (!this.#emception) {
      return {
        programId: compilePlan.program.programId,
        manifestBuffer: compilePlan.manifestBuffer,
        runtimeModel: compilePlan.runtimeModel,
        runtimeExports: compilePlan.runtimeExports,
        sourceGeneratorModel: compilePlan.sourceGeneratorModel,
        compilePlan,
      };
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
        this.#emception.readFile(`/working/${compilePlan.outputName}.wasm`),
      ),
    );
    const loaderModule = await maybeCall(
      this.#emception.readFile(`/working/${compilePlan.outputName}.mjs`, {
        encoding: "utf8",
      }),
    );
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
