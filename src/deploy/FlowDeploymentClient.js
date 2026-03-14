import {
  assertDeploymentAuthorization,
  createDeploymentAuthorization,
  signAuthorization,
} from "../auth/index.js";
import { DefaultManifestExports } from "../runtime/constants.js";
import { encryptJsonForRecipient } from "../transport/index.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  toUint8Array,
} from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";

function serializeTarget(target = null) {
  if (typeof target === "string") {
    return {
      kind: "remote",
      id: null,
      audience: null,
      url: target,
      runtimeId: null,
      transport: null,
      protocolId: null,
      peerId: null,
      startupPhase: null,
      adapter: null,
      disconnected: false,
    };
  }
  return {
    kind: target?.kind ?? "remote",
    id: target?.id ?? target?.targetId ?? target?.runtimeId ?? null,
    audience: target?.audience ?? null,
    url: target?.url ?? null,
    runtimeId: target?.runtimeId ?? target?.runtime_id ?? null,
    transport: target?.transport ?? null,
    protocolId: target?.protocolId ?? target?.protocol_id ?? null,
    peerId: target?.peerId ?? target?.peer_id ?? null,
    startupPhase: target?.startupPhase ?? target?.startup_phase ?? null,
    adapter: target?.adapter ?? target?.hostAdapter ?? null,
    disconnected: Boolean(target?.disconnected ?? false),
  };
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
        serializedArtifact.runtimeExports ??
        serializedArtifact.runtime_exports,
    });
  }

  return normalizeCompiledArtifact(serializedArtifact);
}

export async function resolveCompiledArtifactInput(input = {}, options = {}) {
  if (input && typeof input === "object") {
    if (input.encrypted === true && input.envelope) {
      if (typeof options.decrypt !== "function") {
        throw new Error(
          "Encrypted compiled flow deployments must be decrypted before host startup.",
        );
      }
      const decrypted = await options.decrypt(input.envelope, input);
      return resolveCompiledArtifactInput(decrypted, options);
    }
    if (
      input.payload &&
      typeof input.payload === "object" &&
      input.payload.kind === "compiled-flow-wasm-deployment"
    ) {
      return deserializeCompiledArtifact(input.payload.artifact);
    }
    if (input.kind === "compiled-flow-wasm-deployment") {
      return deserializeCompiledArtifact(input.artifact);
    }
    if (input.artifact) {
      return deserializeCompiledArtifact(input.artifact);
    }
  }

  return deserializeCompiledArtifact(input);
}

export class FlowDeploymentClient {
  #fetch;

  #now;

  constructor(options = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch ?? null;
    this.#now = options.now ?? (() => Date.now());
  }

  async prepareDeployment({
    artifact,
    target,
    signer = null,
    requiredCapabilities = null,
    recipientPublicKey = null,
    authorization = null,
    encrypt = undefined,
  } = {}) {
    const normalizedArtifact = await normalizeCompiledArtifact(artifact);
    const targetDescriptor = serializeTarget(target);
    const capabilities =
      requiredCapabilities ?? normalizedArtifact.requiredCapabilities;
    const authorizationPayload =
      authorization ??
      createDeploymentAuthorization({
        artifact: normalizedArtifact,
        target: targetDescriptor,
        capabilities,
        issuedAt: this.#now(),
      });
    const signedAuthorization = signer
      ? await signAuthorization({
          authorization: authorizationPayload,
          signer,
        })
      : null;

    if (signedAuthorization) {
      assertDeploymentAuthorization({
        envelope: signedAuthorization,
        artifact: normalizedArtifact,
        target: targetDescriptor,
        requiredCapabilities: capabilities,
        now: this.#now(),
      });
    }

    const payload = {
      version: 1,
      kind: "compiled-flow-wasm-deployment",
      artifact: serializeCompiledArtifact(normalizedArtifact),
      authorization: signedAuthorization,
      target: targetDescriptor,
    };

    const shouldEncrypt =
      encrypt ?? Boolean(recipientPublicKey ?? target?.recipientPublicKey);
    if (shouldEncrypt) {
      return {
        version: 1,
        encrypted: true,
        envelope: await encryptJsonForRecipient({
          payload,
          recipientPublicKey: recipientPublicKey ?? target?.recipientPublicKey,
          context: `sdn-flow/deploy:${normalizedArtifact.programId}`,
        }),
      };
    }

    return {
      version: 1,
      encrypted: false,
      payload,
    };
  }

  async deployLocal({ target, deployment }) {
    if (!target || typeof target.deploy !== "function") {
      throw new Error("Local deployment target must expose deploy().");
    }
    return target.deploy(deployment);
  }

  async deployRemote({ target, deployment }) {
    if (!this.#fetch) {
      throw new Error("Remote deployment requires fetch.");
    }
    const url = typeof target === "string" ? target : target?.url;
    if (!url) {
      throw new Error("Remote deployment target must define url.");
    }
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target?.headers ?? {}),
      },
      body: JSON.stringify(deployment),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      const errorBody = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      throw new Error(
        `Remote deployment failed (${response.status}): ${JSON.stringify(errorBody)}`,
      );
    }
    return contentType.includes("application/json")
      ? response.json()
      : response.text();
  }

  async deploy(options = {}) {
    const deployment = await this.prepareDeployment(options);
    if (
      options.target?.kind === "local" ||
      typeof options.target?.deploy === "function"
    ) {
      return this.deployLocal({
        target: options.target,
        deployment,
      });
    }
    return this.deployRemote({
      target: options.target,
      deployment,
    });
  }
}

export default FlowDeploymentClient;
