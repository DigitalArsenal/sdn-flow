import { DefaultManifestExports } from "../runtime/constants.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  toUint8Array,
} from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";

function maybeParseStructuredInput(input) {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
    return input;
  }
  if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    const decoded = new TextDecoder().decode(
      input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    );
    const trimmed = decoded.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
  }
  if (input instanceof ArrayBuffer) {
    const decoded = new TextDecoder().decode(new Uint8Array(input));
    const trimmed = decoded.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
  }
  return input;
}

function normalizeManifestExports(exports = {}) {
  return {
    bytesSymbol:
      exports.bytesSymbol ??
      exports.bytes_symbol ??
      DefaultManifestExports.flowBytesSymbol,
    sizeSymbol:
      exports.sizeSymbol ??
      exports.size_symbol ??
      DefaultManifestExports.flowSizeSymbol,
  };
}

function normalizeRuntimeExports(exports = {}) {
  return {
    mallocSymbol: exports.mallocSymbol ?? exports.malloc_symbol ?? null,
    freeSymbol: exports.freeSymbol ?? exports.free_symbol ?? null,
    descriptorSymbol:
      exports.descriptorSymbol ?? exports.descriptor_symbol ?? null,
    typeDescriptorsSymbol:
      exports.typeDescriptorsSymbol ?? exports.type_descriptors_symbol ?? null,
    typeDescriptorCountSymbol:
      exports.typeDescriptorCountSymbol ??
      exports.type_descriptor_count_symbol ??
      null,
    acceptedTypeIndicesSymbol:
      exports.acceptedTypeIndicesSymbol ??
      exports.accepted_type_indices_symbol ??
      null,
    acceptedTypeIndexCountSymbol:
      exports.acceptedTypeIndexCountSymbol ??
      exports.accepted_type_index_count_symbol ??
      null,
    triggerDescriptorsSymbol:
      exports.triggerDescriptorsSymbol ??
      exports.trigger_descriptors_symbol ??
      null,
    triggerDescriptorCountSymbol:
      exports.triggerDescriptorCountSymbol ??
      exports.trigger_descriptor_count_symbol ??
      null,
    nodeDescriptorsSymbol:
      exports.nodeDescriptorsSymbol ?? exports.node_descriptors_symbol ?? null,
    nodeDescriptorCountSymbol:
      exports.nodeDescriptorCountSymbol ??
      exports.node_descriptor_count_symbol ??
      null,
    nodeDispatchDescriptorsSymbol:
      exports.nodeDispatchDescriptorsSymbol ??
      exports.node_dispatch_descriptors_symbol ??
      null,
    nodeDispatchDescriptorCountSymbol:
      exports.nodeDispatchDescriptorCountSymbol ??
      exports.node_dispatch_descriptor_count_symbol ??
      null,
    edgeDescriptorsSymbol:
      exports.edgeDescriptorsSymbol ?? exports.edge_descriptors_symbol ?? null,
    edgeDescriptorCountSymbol:
      exports.edgeDescriptorCountSymbol ??
      exports.edge_descriptor_count_symbol ??
      null,
    triggerBindingDescriptorsSymbol:
      exports.triggerBindingDescriptorsSymbol ??
      exports.trigger_binding_descriptors_symbol ??
      null,
    triggerBindingDescriptorCountSymbol:
      exports.triggerBindingDescriptorCountSymbol ??
      exports.trigger_binding_descriptor_count_symbol ??
      null,
    dependencyDescriptorsSymbol:
      exports.dependencyDescriptorsSymbol ??
      exports.dependency_descriptors_symbol ??
      null,
    dependencyCountSymbol:
      exports.dependencyCountSymbol ?? exports.dependency_count_symbol ?? null,
    resetStateSymbol:
      exports.resetStateSymbol ?? exports.reset_state_symbol ?? null,
    ingressDescriptorsSymbol:
      exports.ingressDescriptorsSymbol ??
      exports.ingress_descriptors_symbol ??
      null,
    ingressDescriptorCountSymbol:
      exports.ingressDescriptorCountSymbol ??
      exports.ingress_descriptor_count_symbol ??
      null,
    ingressFrameDescriptorsSymbol:
      exports.ingressFrameDescriptorsSymbol ??
      exports.ingress_frame_descriptors_symbol ??
      null,
    ingressFrameDescriptorCountSymbol:
      exports.ingressFrameDescriptorCountSymbol ??
      exports.ingress_frame_descriptor_count_symbol ??
      null,
    nodeIngressIndicesSymbol:
      exports.nodeIngressIndicesSymbol ??
      exports.node_ingress_indices_symbol ??
      null,
    nodeIngressIndexCountSymbol:
      exports.nodeIngressIndexCountSymbol ??
      exports.node_ingress_index_count_symbol ??
      null,
    externalInterfaceDescriptorsSymbol:
      exports.externalInterfaceDescriptorsSymbol ??
      exports.external_interface_descriptors_symbol ??
      null,
    externalInterfaceDescriptorCountSymbol:
      exports.externalInterfaceDescriptorCountSymbol ??
      exports.external_interface_descriptor_count_symbol ??
      null,
    ingressStatesSymbol:
      exports.ingressStatesSymbol ?? exports.ingress_states_symbol ?? null,
    ingressStateCountSymbol:
      exports.ingressStateCountSymbol ??
      exports.ingress_state_count_symbol ??
      null,
    nodeStatesSymbol:
      exports.nodeStatesSymbol ?? exports.node_states_symbol ?? null,
    nodeStateCountSymbol:
      exports.nodeStateCountSymbol ?? exports.node_state_count_symbol ?? null,
    currentInvocationDescriptorSymbol:
      exports.currentInvocationDescriptorSymbol ??
      exports.current_invocation_descriptor_symbol ??
      null,
    prepareInvocationDescriptorSymbol:
      exports.prepareInvocationDescriptorSymbol ??
      exports.prepare_invocation_descriptor_symbol ??
      null,
    enqueueTriggerSymbol:
      exports.enqueueTriggerSymbol ?? exports.enqueue_trigger_symbol ?? null,
    enqueueTriggerFrameSymbol:
      exports.enqueueTriggerFrameSymbol ??
      exports.enqueue_trigger_frame_symbol ??
      null,
    enqueueEdgeSymbol:
      exports.enqueueEdgeSymbol ?? exports.enqueue_edge_symbol ?? null,
    enqueueEdgeFrameSymbol:
      exports.enqueueEdgeFrameSymbol ??
      exports.enqueue_edge_frame_symbol ??
      null,
    readyNodeSymbol:
      exports.readyNodeSymbol ?? exports.ready_node_symbol ?? null,
    beginInvocationSymbol:
      exports.beginInvocationSymbol ?? exports.begin_invocation_symbol ?? null,
    completeInvocationSymbol:
      exports.completeInvocationSymbol ??
      exports.complete_invocation_symbol ??
      null,
    applyInvocationResultSymbol:
      exports.applyInvocationResultSymbol ??
      exports.apply_invocation_result_symbol ??
      null,
    dispatchHostInvocationSymbol:
      exports.dispatchHostInvocationSymbol ??
      exports.dispatch_host_invocation_symbol ??
      null,
    drainWithHostDispatchSymbol:
      exports.drainWithHostDispatchSymbol ??
      exports.drain_with_host_dispatch_symbol ??
      null,
    editorMetadataJsonSymbol:
      exports.editorMetadataJsonSymbol ??
      exports.editor_metadata_json_symbol ??
      null,
    editorMetadataSizeSymbol:
      exports.editorMetadataSizeSymbol ??
      exports.editor_metadata_size_symbol ??
      null,
  };
}

export async function normalizeCompiledArtifact(artifact = {}) {
  if (artifact.wasm === undefined || artifact.wasm === null) {
    throw new Error("Compiled flow artifact must include wasm bytes.");
  }
  if (
    artifact.manifestBuffer === undefined &&
    artifact.manifest_buffer === undefined
  ) {
    throw new Error(
      "Compiled flow artifact must include an embedded FlatBuffer manifest.",
    );
  }

  const wasm = toUint8Array(artifact.wasm);
  const manifestBuffer = toUint8Array(
    artifact.manifestBuffer ?? artifact.manifest_buffer,
  );
  if (wasm.length === 0) {
    throw new Error("Compiled flow artifact must include wasm bytes.");
  }
  if (manifestBuffer.length === 0) {
    throw new Error(
      "Compiled flow artifact must include an embedded FlatBuffer manifest.",
    );
  }

  const graphHash = artifact.graphHash ?? bytesToHex(await sha256Bytes(wasm));
  const manifestHash =
    artifact.manifestHash ?? bytesToHex(await sha256Bytes(manifestBuffer));

  return {
    artifactId:
      artifact.artifactId ??
      `${artifact.programId ?? "flow"}:${String(graphHash).slice(0, 16)}`,
    programId: String(artifact.programId ?? "").trim(),
    format: artifact.format ?? "application/wasm",
    runtimeModel:
      artifact.runtimeModel ?? artifact.runtime_model ?? "compiled-cpp-wasm",
    wasm,
    manifestBuffer,
    manifestExports: normalizeManifestExports(
      artifact.manifestExports ?? artifact.manifest_exports,
    ),
    runtimeExports: normalizeRuntimeExports(
      artifact.runtimeExports ?? artifact.runtime_exports,
    ),
    entrypoint: artifact.entrypoint ?? "_start",
    graphHash,
    manifestHash,
    requiredCapabilities: Array.isArray(artifact.requiredCapabilities)
      ? artifact.requiredCapabilities.map((value) => String(value))
      : [],
    pluginVersions: Array.isArray(artifact.pluginVersions)
      ? artifact.pluginVersions
      : [],
    schemaBindings: Array.isArray(artifact.schemaBindings)
      ? artifact.schemaBindings
      : [],
    abiVersion: Number(artifact.abiVersion ?? artifact.abi_version ?? 1),
  };
}

export function serializeCompiledArtifact(artifact) {
  return {
    artifactId: artifact.artifactId,
    programId: artifact.programId,
    format: artifact.format,
    runtimeModel: artifact.runtimeModel,
    wasmBase64: bytesToBase64(artifact.wasm),
    manifestBase64: bytesToBase64(artifact.manifestBuffer),
    manifestExports: artifact.manifestExports,
    runtimeExports: artifact.runtimeExports,
    entrypoint: artifact.entrypoint,
    graphHash: artifact.graphHash,
    manifestHash: artifact.manifestHash,
    requiredCapabilities: artifact.requiredCapabilities,
    pluginVersions: artifact.pluginVersions,
    schemaBindings: artifact.schemaBindings,
    abiVersion: artifact.abiVersion,
  };
}

export async function deserializeCompiledArtifact(serializedArtifact = {}) {
  if (
    serializedArtifact.wasmBase64 !== undefined ||
    serializedArtifact.manifestBase64 !== undefined
  ) {
    return normalizeCompiledArtifact({
      ...serializedArtifact,
      wasm: base64ToBytes(serializedArtifact.wasmBase64),
      manifestBuffer: base64ToBytes(serializedArtifact.manifestBase64),
      manifestExports:
        serializedArtifact.manifestExports ??
        serializedArtifact.manifest_exports,
      runtimeExports:
        serializedArtifact.runtimeExports ?? serializedArtifact.runtime_exports,
    });
  }

  return normalizeCompiledArtifact(serializedArtifact);
}

export async function resolveCompiledArtifactEnvelope(
  input = {},
  options = {},
) {
  const normalizedInput = maybeParseStructuredInput(input);
  if (normalizedInput && typeof normalizedInput === "object") {
    if (normalizedInput.encrypted === true && normalizedInput.envelope) {
      if (typeof options.decrypt !== "function") {
        throw new Error(
          "Encrypted compiled flow deployments must be decrypted before host startup.",
        );
      }
      const decrypted = await options.decrypt(
        normalizedInput.envelope,
        normalizedInput,
      );
      return resolveCompiledArtifactEnvelope(decrypted, options);
    }
    if (
      normalizedInput.payload &&
      typeof normalizedInput.payload === "object" &&
      normalizedInput.payload.kind === "compiled-flow-wasm-deployment"
    ) {
      return normalizedInput.payload;
    }
    if (normalizedInput.kind === "compiled-flow-wasm-deployment") {
      return normalizedInput;
    }
    if (normalizedInput.artifact) {
      return {
        kind: "compiled-flow-artifact-input",
        artifact: normalizedInput.artifact,
        source: normalizedInput,
      };
    }
  }

  return {
    kind: "compiled-flow-artifact-input",
    artifact: normalizedInput,
  };
}

export async function resolveCompiledArtifactInput(input = {}, options = {}) {
  const resolved = await resolveCompiledArtifactEnvelope(input, options);
  if (
    resolved &&
    typeof resolved === "object" &&
    resolved.kind === "compiled-flow-wasm-deployment"
  ) {
    return deserializeCompiledArtifact(resolved.artifact);
  }
  if (resolved && typeof resolved === "object" && resolved.artifact) {
    return deserializeCompiledArtifact(resolved.artifact);
  }

  return deserializeCompiledArtifact(resolved);
}

export default {
  deserializeCompiledArtifact,
  normalizeCompiledArtifact,
  resolveCompiledArtifactEnvelope,
  resolveCompiledArtifactInput,
  serializeCompiledArtifact,
};
