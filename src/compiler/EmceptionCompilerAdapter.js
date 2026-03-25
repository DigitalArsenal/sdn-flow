import path from "node:path";

import { decodePluginManifest } from "space-data-module-sdk";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import {
  RuntimeTarget,
  canUseDirectFlowWasmInstantiation,
  normalizeManifest,
  normalizeProgram,
} from "../runtime/index.js";
import { bytesToHex, toUint8Array } from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";
import {
  createGeneratorRequest,
  generateCppFlowRuntimeSource,
  INVALID_INDEX,
} from "./CppFlowSourceGenerator.js";
import { SignedArtifactCatalog } from "./SignedArtifactCatalog.js";
import { isSdkEmceptionSession } from "./sdkEmceptionSession.js";

const DEFAULT_FLAGS = Object.freeze([
  "-std=c++20",
  "-O2",
  "-sWASM=1",
  "-sSTANDALONE_WASM=1",
  "-sERROR_ON_UNDEFINED_SYMBOLS=0",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_flow_get_manifest_flatbuffer','_flow_get_manifest_flatbuffer_size','_sdn_flow_get_program_id','_sdn_flow_get_program_name','_sdn_flow_get_program_version','_sdn_flow_get_editor_metadata_json','_sdn_flow_get_editor_metadata_size','_sdn_flow_get_type_descriptors','_sdn_flow_get_type_descriptor_count','_sdn_flow_get_accepted_type_indices','_sdn_flow_get_accepted_type_index_count','_sdn_flow_get_trigger_descriptors','_sdn_flow_get_trigger_descriptor_count','_sdn_flow_get_node_descriptors','_sdn_flow_get_node_descriptor_count','_sdn_flow_get_node_dispatch_descriptors','_sdn_flow_get_node_dispatch_descriptor_count','_sdn_flow_get_edge_descriptors','_sdn_flow_get_edge_descriptor_count','_sdn_flow_get_trigger_binding_descriptors','_sdn_flow_get_trigger_binding_descriptor_count','_sdn_flow_get_dependency_descriptors','_sdn_flow_get_dependency_count','_sdn_flow_get_ingress_descriptors','_sdn_flow_get_ingress_descriptor_count','_sdn_flow_get_ingress_frame_descriptors','_sdn_flow_get_ingress_frame_descriptor_count','_sdn_flow_get_node_ingress_indices','_sdn_flow_get_node_ingress_index_count','_sdn_flow_get_external_interface_descriptors','_sdn_flow_get_external_interface_descriptor_count','_sdn_flow_get_ingress_runtime_states','_sdn_flow_get_ingress_runtime_state_count','_sdn_flow_get_node_runtime_states','_sdn_flow_get_node_runtime_state_count','_sdn_flow_get_current_invocation_descriptor','_sdn_flow_prepare_node_invocation_descriptor','_sdn_flow_reset_runtime_state','_sdn_flow_enqueue_trigger_frames','_sdn_flow_enqueue_trigger_frame','_sdn_flow_enqueue_edge_frames','_sdn_flow_enqueue_edge_frame','_sdn_flow_get_ready_node_index','_sdn_flow_begin_node_invocation','_sdn_flow_complete_node_invocation','_sdn_flow_apply_node_invocation_result','_sdn_flow_dispatch_next_ready_node_with_host','_sdn_flow_drain_with_host_dispatch','_sdn_flow_get_runtime_descriptor']",
]);

const DEFAULT_RUNTIME_MODEL = "compiled-cpp-wasm";
const DEFAULT_WORKING_DIRECTORY = "/working";
const PureGuestRuntimeTargets = new Set([
  RuntimeTarget.EDGE,
  RuntimeTarget.WASI,
  RuntimeTarget.WASMEDGE,
]);
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

function normalizeObjectFileStem(value, fallback) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? "";
  const stem = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem.length > 0 ? stem : fallback;
}

function createLinkedDependencySourceFiles(dependencies = [], workingDirectory) {
  return dependencies.flatMap((dependency, index) => {
    const objectBytes = toUint8Array(dependency?.guestLink?.objectBytes ?? []);
    if (objectBytes.length === 0) {
      return [];
    }
    const stem = normalizeObjectFileStem(
      dependency?.dependencyId ?? dependency?.pluginId,
      `dependency-${index}`,
    );
    return [
      {
        path: path.posix.join(
          workingDirectory,
          "linked-dependencies",
          `${index}-${stem}.o`,
        ),
        content: objectBytes,
        dependencyId: dependency?.dependencyId ?? "",
        pluginId: dependency?.pluginId ?? "",
        linkedMethodSymbols: {
          ...(dependency?.guestLink?.methodSymbols ?? {}),
        },
      },
    ];
  });
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
    "  let activeInstance = null;",
    "  const getMemory = () =>",
    "    activeInstance?.exports?.memory ?? module.wasmMemory ?? module.memory ?? null;",
    "  const writeU32 = (pointer, value) => {",
    "    const memory = getMemory();",
    "    if (!memory || !(memory.buffer instanceof ArrayBuffer) || !pointer) {",
    "      return;",
    "    }",
    "    new DataView(memory.buffer).setUint32(Number(pointer) >>> 0, Number(value) >>> 0, true);",
    "  };",
    "  const writeU64 = (pointer, value) => {",
    "    const memory = getMemory();",
    "    if (!memory || !(memory.buffer instanceof ArrayBuffer) || !pointer) {",
    "      return;",
    "    }",
    "    new DataView(memory.buffer).setBigUint64(Number(pointer) >>> 0, BigInt(value), true);",
    "  };",
    "  const incomingImports = module.imports ?? {};",
    "  const baseImports = {",
    "    ...incomingImports,",
    "    wasi_snapshot_preview1: {",
    "      args_sizes_get() { return 0; },",
    "      args_get() { return 0; },",
    "      proc_exit() { return 0; },",
    "      fd_close() { return 0; },",
    "      fd_seek(_fd, _offsetLow, _offsetHigh, _whence, newOffsetPtr) {",
    "        writeU64(newOffsetPtr, 0n);",
    "        return 0;",
    "      },",
    "      fd_write(_fd, iovs, iovsLen, bytesWrittenPtr) {",
    "        const memory = getMemory();",
    "        if (!memory || !(memory.buffer instanceof ArrayBuffer)) {",
    "          writeU32(bytesWrittenPtr, 0);",
    "          return 0;",
    "        }",
    "        const view = new DataView(memory.buffer);",
    "        let written = 0;",
    "        for (let index = 0; index < Number(iovsLen ?? 0); index += 1) {",
    "          const base = (Number(iovs) >>> 0) + index * 8;",
    "          written += view.getUint32(base + 4, true);",
    "        }",
    "        writeU32(bytesWrittenPtr, written);",
    "        return 0;",
    "      },",
    "      ...(incomingImports.wasi_snapshot_preview1 ?? {}),",
    "    },",
    "  };",
    "  if (typeof module.instantiateWasm === 'function') {",
    "    let instance = null;",
    "    let wasmModule = null;",
    "    const result = await module.instantiateWasm(baseImports, (nextInstance, nextModule) => {",
    "      instance = nextInstance;",
    "      activeInstance = nextInstance;",
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
    "  activeInstance = instantiated.instance;",
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

function decodeManifestRuntimeTargets(manifestBuffer) {
  try {
    return normalizeManifest(decodePluginManifest(manifestBuffer)).runtimeTargets;
  } catch {
    return [];
  }
}

function describeHostDispatchRequirement({ request, dependencies = [] }) {
  const issues = [];
  request.nodes.forEach((node) => {
    if (typeof node.linkedMethodSymbol === "string" && node.linkedMethodSymbol) {
      return;
    }
    const dependency =
      node.dependencyIndex !== INVALID_INDEX
        ? dependencies[node.dependencyIndex] ?? null
        : null;
    let reason = "no guest-link symbol is available";
    if (!dependency) {
      reason = "no resolved artifact dependency was found";
    } else if (dependency?.guestLink?.methodSymbols) {
      reason = `guestLink metadata does not export method "${node.methodId}"`;
    } else if (dependency?.runtimeExports?.streamInvokeSymbol) {
      reason = "dependency only exposes host-side stream/command invocation";
    } else {
      reason = "dependency does not expose guest-link metadata";
    }
    issues.push({
      nodeId: node.nodeId,
      pluginId: node.pluginId,
      methodId: node.methodId,
      dependencyId:
        node.dependencyId ??
        dependency?.dependencyId ??
        dependency?.pluginId ??
        "",
      reason,
    });
  });
  return issues;
}

function assertPureGuestCompilationCompatibility({
  program,
  manifestBuffer,
  dependencies,
}) {
  const runtimeTargets = decodeManifestRuntimeTargets(manifestBuffer);
  const pureGuestTargets = runtimeTargets.filter((target) =>
    PureGuestRuntimeTargets.has(target),
  );
  if (pureGuestTargets.length === 0) {
    return;
  }

  const request = createGeneratorRequest({
    program,
    manifestBuffer,
    dependencies,
  });
  const hostDispatchNodes = describeHostDispatchRequirement({
    request,
    dependencies,
  });
  if (hostDispatchNodes.length === 0) {
    return;
  }

  const issueSummary = hostDispatchNodes
    .map(
      (issue) =>
        `${issue.nodeId} (${issue.pluginId}.${issue.methodId}): ${issue.reason}`,
    )
    .join("; ");
  throw new Error(
    `Runtime targets ${pureGuestTargets.join(", ")} require a fully guest-linkable flow artifact. The following nodes would still require sdn_flow_host dispatch: ${issueSummary}`,
  );
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
    assertPureGuestCompilationCompatibility({
      program: normalizedProgram,
      manifestBuffer,
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
    const linkedDependencySourceFiles = createLinkedDependencySourceFiles(
      dependencies,
      workingDirectory,
    );
    const mainSourcePath = path.posix.join(workingDirectory, "main.cpp");
    const outputPath = path.posix.join(workingDirectory, `${outputName}.wasm`);
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
      linkedDependencySourceFiles,
      sourceFiles: [
        {
          path: mainSourcePath,
          content: source,
        },
        ...linkedDependencySourceFiles,
      ],
      command: `em++ ${flags.join(" ")} ${mainSourcePath} ${linkedDependencySourceFiles
        .map((file) => file.path)
        .join(" ")} -o ${outputPath}`.replace(/\s+/g, " ").trim(),
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
    const loaderModule = canUseDirectFlowWasmInstantiation(wasm)
      ? null
      : createPortableLoaderModuleSource();
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
