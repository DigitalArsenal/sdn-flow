import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { decodePluginManifest } from "space-data-module-sdk/manifest";

import { summarizeProgramRequirements } from "../designer/requirements.js";
import {
  RuntimeTarget,
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

const execFileAsync = promisify(execFile);

const DEFAULT_FLAGS = Object.freeze([
  "-std=c++20",
  "-O2",
  "-sWASM=1",
  "-sSTANDALONE_WASM=1",
  "-sERROR_ON_UNDEFINED_SYMBOLS=0",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_flow_get_manifest_flatbuffer','_flow_get_manifest_flatbuffer_size','_sdn_flow_get_program_id','_sdn_flow_get_program_name','_sdn_flow_get_program_version','_sdn_flow_get_editor_metadata_json','_sdn_flow_get_editor_metadata_size','_sdn_flow_get_type_descriptors','_sdn_flow_get_type_descriptor_count','_sdn_flow_get_accepted_type_indices','_sdn_flow_get_accepted_type_index_count','_sdn_flow_get_trigger_descriptors','_sdn_flow_get_trigger_descriptor_count','_sdn_flow_get_node_descriptors','_sdn_flow_get_node_descriptor_count','_sdn_flow_get_node_dispatch_descriptors','_sdn_flow_get_node_dispatch_descriptor_count','_sdn_flow_get_edge_descriptors','_sdn_flow_get_edge_descriptor_count','_sdn_flow_get_trigger_binding_descriptors','_sdn_flow_get_trigger_binding_descriptor_count','_sdn_flow_get_dependency_descriptors','_sdn_flow_get_dependency_count','_sdn_flow_get_ingress_descriptors','_sdn_flow_get_ingress_descriptor_count','_sdn_flow_get_ingress_frame_descriptors','_sdn_flow_get_ingress_frame_descriptor_count','_sdn_flow_get_node_ingress_indices','_sdn_flow_get_node_ingress_index_count','_sdn_flow_get_external_interface_descriptors','_sdn_flow_get_external_interface_descriptor_count','_sdn_flow_get_ingress_runtime_states','_sdn_flow_get_ingress_runtime_state_count','_sdn_flow_get_node_runtime_states','_sdn_flow_get_node_runtime_state_count','_sdn_flow_get_current_invocation_descriptor','_sdn_flow_prepare_node_invocation_descriptor','_sdn_flow_reset_runtime_state','_sdn_flow_enqueue_trigger_frames','_sdn_flow_enqueue_trigger_frame','_sdn_flow_enqueue_edge_frames','_sdn_flow_enqueue_edge_frame','_sdn_flow_get_ready_node_index','_sdn_flow_begin_node_invocation','_sdn_flow_complete_node_invocation','_sdn_flow_apply_node_invocation_result','_sdn_flow_dispatch_current_invocation_direct','_sdn_flow_get_runtime_descriptor']",
]);

const DEFAULT_RUNTIME_MODEL = "compiled-cpp-wasm";
const DEFAULT_WORKING_DIRECTORY = "/working";
const THREAD_MODEL_SINGLE_THREAD = "single-thread";
const THREAD_MODEL_EMSCRIPTEN_PTHREADS = "emscripten-pthreads";
const TOOLCHAIN_EMCEPTION = "sdn-emception";
const TOOLCHAIN_SYSTEM_EMSCRIPTEN = "system-emscripten";
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
  dispatchCurrentInvocationSymbol: "sdn_flow_dispatch_current_invocation_direct",
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

function normalizeThreadModel(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === THREAD_MODEL_SINGLE_THREAD) {
    return THREAD_MODEL_SINGLE_THREAD;
  }
  if (normalized === THREAD_MODEL_EMSCRIPTEN_PTHREADS) {
    return THREAD_MODEL_EMSCRIPTEN_PTHREADS;
  }
  return null;
}

function dependencyRequiresPthreads(dependency) {
  if (!(dependency?.guestLink?.objectBytes instanceof Uint8Array)) {
    return false;
  }
  if (dependency.guestLink.objectBytes.length === 0) {
    return false;
  }
  return (
    normalizeThreadModel(dependency?.guestLink?.threadModel) ===
    THREAD_MODEL_EMSCRIPTEN_PTHREADS
  );
}

function linkedDependenciesRequirePthreads(dependencies = []) {
  return dependencies.some((dependency) => dependencyRequiresPthreads(dependency));
}

function buildCompileFlags(flags, { requiresPthreads } = {}) {
  const resolved = Array.isArray(flags) ? [...flags] : [...DEFAULT_FLAGS];
  if (requiresPthreads && !resolved.includes("-pthread")) {
    resolved.splice(2, 0, "-pthread");
  }
  return resolved;
}

function buildToolchainMetadata({ runtimeTargets, flags, threadModel }) {
  const wasmedgeRequested = Array.isArray(runtimeTargets)
    ? runtimeTargets.includes(RuntimeTarget.WASMEDGE)
    : false;
  return {
    kind:
      threadModel === THREAD_MODEL_EMSCRIPTEN_PTHREADS
        ? TOOLCHAIN_SYSTEM_EMSCRIPTEN
        : TOOLCHAIN_EMCEPTION,
    command: "em++",
    flags: [...flags],
    threadModel,
    wasmedgeDirectRuntimeStatus: wasmedgeRequested
      ? threadModel === THREAD_MODEL_EMSCRIPTEN_PTHREADS
        ? "unverified-pthread-artifact"
        : "verified-standalone"
      : "not-requested",
  };
}

async function ensureSystemCompilerAvailable(command) {
  try {
    await execFileAsync(command, ["--version"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `System Emscripten toolchain is required for "${THREAD_MODEL_EMSCRIPTEN_PTHREADS}" flow links, but "${command}" was not found on PATH.`,
      );
    }
    throw error;
  }
}

async function runSystemCompiler(command, args, options = {}) {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const detail = stderr || stdout || error?.message || "unknown error";
    throw new Error(
      `System Emscripten flow link failed: ${detail}`,
    );
  }
}

function resolveVirtualCompilePath(compilePlan, tempDir, virtualPath) {
  const relativePath = path.posix.relative(
    compilePlan.workingDirectory,
    virtualPath,
  );
  if (relativePath.startsWith("../")) {
    throw new Error(
      `Compile plan path "${virtualPath}" escapes working directory "${compilePlan.workingDirectory}".`,
    );
  }
  return path.join(tempDir, relativePath);
}

async function compileWithSystemToolchain(compilePlan) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-flow-compile-"));
  try {
    await ensureSystemCompilerAvailable("em++");
    for (const file of compilePlan.sourceFiles) {
      const destinationPath = resolveVirtualCompilePath(
        compilePlan,
        tempDir,
        file.path,
      );
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, file.content);
    }
    const mainSourcePath = resolveVirtualCompilePath(
      compilePlan,
      tempDir,
      compilePlan.mainSourcePath,
    );
    const linkedDependencyPaths = compilePlan.linkedDependencySourceFiles.map((file) =>
      resolveVirtualCompilePath(compilePlan, tempDir, file.path),
    );
    const outputPath = resolveVirtualCompilePath(
      compilePlan,
      tempDir,
      compilePlan.outputPath,
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await runSystemCompiler("em++", [
      ...compilePlan.flags,
      mainSourcePath,
      ...linkedDependencyPaths,
      "-o",
      outputPath,
    ]);
    return {
      wasm: new Uint8Array(await readFile(outputPath)),
      tempDir,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
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
    const runtimeTargets = decodeManifestRuntimeTargets(manifestBuffer);
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
    const threadModel = linkedDependenciesRequirePthreads(dependencies)
      ? THREAD_MODEL_EMSCRIPTEN_PTHREADS
      : THREAD_MODEL_SINGLE_THREAD;
    const flags = buildCompileFlags(
      Array.isArray(metadata?.flags) ? metadata.flags : this.#flags,
      {
        requiresPthreads: threadModel === THREAD_MODEL_EMSCRIPTEN_PTHREADS,
      },
    );
    const linkedDependencySourceFiles = createLinkedDependencySourceFiles(
      dependencies,
      workingDirectory,
    );
    const mainSourcePath = path.posix.join(workingDirectory, "main.cpp");
    const outputPath = path.posix.join(workingDirectory, `${outputName}.wasm`);
    const toolchain = buildToolchainMetadata({
      runtimeTargets,
      flags,
      threadModel,
    });
    return {
      program: normalizedProgram,
      manifestBuffer,
      dependencies,
      runtimeModel: DEFAULT_RUNTIME_MODEL,
      runtimeExports: { ...DEFAULT_RUNTIME_EXPORTS },
      sourceGeneratorModel,
      outputName,
      workingDirectory,
      threadModel,
      toolchain,
      flags,
      source,
      mainSourcePath,
      outputPath,
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
    if (compilePlan.toolchain?.kind === TOOLCHAIN_SYSTEM_EMSCRIPTEN) {
      const systemResult = await compileWithSystemToolchain(compilePlan);
      const requirements = summarizeProgramRequirements({
        program: compilePlan.program,
      });
      return {
        artifactId: `${compilePlan.program.programId}:${bytesToHex(
          await sha256Bytes(systemResult.wasm),
        ).slice(0, 16)}`,
        programId: compilePlan.program.programId,
        runtimeModel: compilePlan.runtimeModel,
        sourceGeneratorModel: compilePlan.sourceGeneratorModel,
        format: "application/wasm",
        wasm: systemResult.wasm,
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
