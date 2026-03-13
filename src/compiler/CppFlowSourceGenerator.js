import { normalizeProgram } from "../runtime/index.js";
import { toUint8Array } from "../utils/encoding.js";
import { runNativeFlowSourceGenerator } from "./nativeFlowSourceGeneratorTool.js";

const INVALID_INDEX = 0xffffffff;
const REQUEST_MAGIC = "SDNFLOWCPPGEN1";

function normalizeTypeDescriptor(typeRef = {}) {
  return {
    schemaName: typeRef.schemaName ?? "",
    fileIdentifier: typeRef.fileIdentifier ?? "",
    schemaHashHex: Array.from(typeRef.schemaHash ?? [], (byte) =>
      Number(byte).toString(16).padStart(2, "0"),
    ).join(""),
    acceptsAnyFlatbuffer: typeRef.acceptsAnyFlatbuffer ?? false,
  };
}

function createTypeIndexRegistry() {
  const descriptors = [];
  const indices = [];
  const descriptorIndexByKey = new Map();

  function registerTypeRef(typeRef) {
    const normalized = normalizeTypeDescriptor(typeRef);
    const key = JSON.stringify([
      normalized.schemaName,
      normalized.fileIdentifier,
      normalized.schemaHashHex,
      normalized.acceptsAnyFlatbuffer,
    ]);
    if (!descriptorIndexByKey.has(key)) {
      descriptorIndexByKey.set(key, descriptors.length);
      descriptors.push(normalized);
    }
    return descriptorIndexByKey.get(key);
  }

  function reserveTypeRefs(typeRefs = []) {
    const offset = indices.length;
    for (const typeRef of typeRefs) {
      indices.push(registerTypeRef(typeRef));
    }
    return {
      offset,
      count: typeRefs.length,
    };
  }

  return {
    descriptors,
    indices,
    reserveTypeRefs,
  };
}

function getMapIndex(indexMap, key) {
  if (!indexMap.has(key)) {
    return INVALID_INDEX;
  }
  return indexMap.get(key);
}

function createIngressTopology(
  normalizedProgram,
  nodeIndexById,
  triggerIndexById,
) {
  const ingressDescriptors = [];
  const edgeIngressIndexByEdgeIndex = new Map();
  const triggerBindingIngressIndexByBindingIndex = new Map();
  const nodeIngressIndexMap = new Map(
    normalizedProgram.nodes.map((node) => [node.nodeId, []]),
  );

  normalizedProgram.triggerBindings.forEach((binding, bindingIndex) => {
    const targetNodeIndex = getMapIndex(nodeIndexById, binding.targetNodeId);
    const ingressIndex = ingressDescriptors.length;
    ingressDescriptors.push({
      ingressId: `trigger:${binding.triggerId}->${binding.targetNodeId}:${binding.targetPortId}`,
      sourceKind: "trigger",
      sourceIndex: getMapIndex(triggerIndexById, binding.triggerId),
      sourceNodeIndex: INVALID_INDEX,
      sourcePortId: "",
      targetNodeIndex,
      targetNodeId: binding.targetNodeId,
      targetPortId: binding.targetPortId,
      backpressurePolicy: binding.backpressurePolicy ?? "queue",
      queueDepth: binding.queueDepth ?? 0,
    });
    triggerBindingIngressIndexByBindingIndex.set(bindingIndex, ingressIndex);
    if (targetNodeIndex !== INVALID_INDEX) {
      nodeIngressIndexMap.get(binding.targetNodeId).push(ingressIndex);
    }
  });

  normalizedProgram.edges.forEach((edge, edgeIndex) => {
    const targetNodeIndex = getMapIndex(nodeIndexById, edge.toNodeId);
    const sourceNodeIndex = getMapIndex(nodeIndexById, edge.fromNodeId);
    const ingressIndex = ingressDescriptors.length;
    ingressDescriptors.push({
      ingressId: `edge:${edge.edgeId}`,
      sourceKind: "edge",
      sourceIndex: edgeIndex,
      sourceNodeIndex,
      sourcePortId: edge.fromPortId,
      targetNodeIndex,
      targetNodeId: edge.toNodeId,
      targetPortId: edge.toPortId,
      backpressurePolicy: edge.backpressurePolicy ?? "queue",
      queueDepth: edge.queueDepth ?? 0,
    });
    edgeIngressIndexByEdgeIndex.set(edgeIndex, ingressIndex);
    if (targetNodeIndex !== INVALID_INDEX) {
      nodeIngressIndexMap.get(edge.toNodeId).push(ingressIndex);
    }
  });

  const flattenedNodeIngressIndices = [];
  const nodeIngressRanges = normalizedProgram.nodes.map((node) => {
    const ingressIndices = nodeIngressIndexMap.get(node.nodeId) ?? [];
    const offset = flattenedNodeIngressIndices.length;
    flattenedNodeIngressIndices.push(...ingressIndices);
    return {
      offset,
      count: ingressIndices.length,
    };
  });

  return {
    ingressDescriptors,
    edgeIngressIndexByEdgeIndex,
    triggerBindingIngressIndexByBindingIndex,
    nodeIngressRanges,
    flattenedNodeIngressIndices,
  };
}

function createBinaryWriter() {
  const chunks = [];

  function pushBytes(value) {
    const bytes = toUint8Array(value);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, bytes.length, true);
    chunks.push(size, bytes);
  }

  function pushString(value) {
    pushBytes(new TextEncoder().encode(String(value ?? "")));
  }

  function pushU8(value) {
    chunks.push(Uint8Array.of(value ? 1 : 0));
  }

  function pushU32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(value ?? 0) >>> 0, true);
    chunks.push(bytes);
  }

  function finish() {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  return {
    pushBytes,
    pushString,
    pushU8,
    pushU32,
    finish,
  };
}

function createGeneratorRequest({
  program,
  manifestBuffer,
  dependencies = [],
  namespace = "sdn_flow_generated",
} = {}) {
  const normalizedProgram = normalizeProgram(program);
  const normalizedManifestBuffer = toUint8Array(manifestBuffer);

  if (normalizedManifestBuffer.length === 0) {
    throw new Error(
      "generateCppFlowRuntimeSource requires manifestBuffer bytes.",
    );
  }

  const typeRegistry = createTypeIndexRegistry();
  const nodeIndexById = new Map(
    normalizedProgram.nodes.map((node, index) => [node.nodeId, index]),
  );
  const triggerIndexById = new Map(
    normalizedProgram.triggers.map((trigger, index) => [
      trigger.triggerId,
      index,
    ]),
  );
  const ingressTopology = createIngressTopology(
    normalizedProgram,
    nodeIndexById,
    triggerIndexById,
  );

  return {
    namespace,
    manifestBuffer: normalizedManifestBuffer,
    programId: normalizedProgram.programId,
    programName: normalizedProgram.name ?? normalizedProgram.programId,
    programVersion: normalizedProgram.version ?? "0.1.0",
    programDescription: normalizedProgram.description ?? "",
    requiredPlugins: normalizedProgram.requiredPlugins.map((pluginId) =>
      String(pluginId),
    ),
    typeDescriptors: typeRegistry.descriptors,
    acceptedTypeIndices: typeRegistry.indices,
    triggers: normalizedProgram.triggers.map((trigger) => {
      const acceptedTypes = typeRegistry.reserveTypeRefs(trigger.acceptedTypes);
      return {
        triggerId: trigger.triggerId,
        kind: trigger.kind,
        source: trigger.source ?? "",
        protocolId: trigger.protocolId ?? "",
        defaultIntervalMs: trigger.defaultIntervalMs,
        acceptedTypeIndexOffset: acceptedTypes.offset,
        acceptedTypeIndexCount: acceptedTypes.count,
        description: trigger.description ?? "",
      };
    }),
    nodes: normalizedProgram.nodes.map((node, nodeIndex) => {
      const ingressRange = ingressTopology.nodeIngressRanges[nodeIndex];
      return {
        nodeId: node.nodeId,
        pluginId: node.pluginId,
        methodId: node.methodId,
        kind: node.kind,
        drainPolicy: node.drainPolicy ?? "",
        timeSliceMicros: node.timeSliceMicros,
        ingressIndexOffset: ingressRange.offset,
        ingressIndexCount: ingressRange.count,
      };
    }),
    edges: normalizedProgram.edges.map((edge, edgeIndex) => {
      const acceptedTypes = typeRegistry.reserveTypeRefs(edge.acceptedTypes);
      return {
        edgeId: edge.edgeId,
        fromNodeId: edge.fromNodeId,
        fromNodeIndex: getMapIndex(nodeIndexById, edge.fromNodeId),
        fromPortId: edge.fromPortId,
        toNodeId: edge.toNodeId,
        toNodeIndex: getMapIndex(nodeIndexById, edge.toNodeId),
        toPortId: edge.toPortId,
        backpressurePolicy: edge.backpressurePolicy ?? "",
        queueDepth: edge.queueDepth,
        acceptedTypeIndexOffset: acceptedTypes.offset,
        acceptedTypeIndexCount: acceptedTypes.count,
        targetIngressIndex:
          ingressTopology.edgeIngressIndexByEdgeIndex.get(edgeIndex) ??
          INVALID_INDEX,
      };
    }),
    triggerBindings: normalizedProgram.triggerBindings.map(
      (binding, bindingIndex) => ({
        triggerId: binding.triggerId,
        triggerIndex: getMapIndex(triggerIndexById, binding.triggerId),
        targetNodeId: binding.targetNodeId,
        targetNodeIndex: getMapIndex(nodeIndexById, binding.targetNodeId),
        targetPortId: binding.targetPortId,
        backpressurePolicy: binding.backpressurePolicy ?? "",
        queueDepth: binding.queueDepth,
        targetIngressIndex:
          ingressTopology.triggerBindingIngressIndexByBindingIndex.get(
            bindingIndex,
          ) ?? INVALID_INDEX,
      }),
    ),
    ingressDescriptors: ingressTopology.ingressDescriptors,
    externalInterfaces: normalizedProgram.externalInterfaces.map(
      (externalInterface) => {
        const acceptedTypes = typeRegistry.reserveTypeRefs(
          externalInterface.acceptedTypes,
        );
        return {
          interfaceId: externalInterface.interfaceId,
          kind: externalInterface.kind ?? "",
          direction: externalInterface.direction ?? "",
          capability: externalInterface.capability ?? "",
          resource: externalInterface.resource ?? "",
          protocolId: externalInterface.protocolId ?? "",
          topic: externalInterface.topic ?? "",
          path: externalInterface.path ?? "",
          required: externalInterface.required !== false,
          acceptedTypeIndexOffset: acceptedTypes.offset,
          acceptedTypeIndexCount: acceptedTypes.count,
          description: externalInterface.description ?? "",
        };
      },
    ),
    dependencies: dependencies.map((dependency) => ({
      dependencyId: dependency.dependencyId ?? "",
      pluginId: dependency.pluginId ?? "",
      version: dependency.version ?? "",
      sha256: dependency.sha256 ?? "",
      signature: dependency.signature ?? "",
      signerPublicKey: dependency.signerPublicKey ?? "",
      entrypoint: dependency.entrypoint ?? "",
      manifestExports: {
        bytesSymbol: dependency.manifestExports?.bytesSymbol ?? "",
        sizeSymbol: dependency.manifestExports?.sizeSymbol ?? "",
      },
      runtimeExports: {
        initSymbol: dependency.runtimeExports?.initSymbol ?? "",
        destroySymbol: dependency.runtimeExports?.destroySymbol ?? "",
        mallocSymbol: dependency.runtimeExports?.mallocSymbol ?? "",
        freeSymbol: dependency.runtimeExports?.freeSymbol ?? "",
        streamInvokeSymbol: dependency.runtimeExports?.streamInvokeSymbol ?? "",
      },
      wasm: toUint8Array(dependency.wasm),
      manifestBuffer: dependency.manifestBuffer
        ? toUint8Array(dependency.manifestBuffer)
        : new Uint8Array(),
    })),
    nodeIngressIndices: ingressTopology.flattenedNodeIngressIndices,
  };
}

function encodeGeneratorRequest(request) {
  const writer = createBinaryWriter();
  writer.pushString(REQUEST_MAGIC);
  writer.pushString(request.namespace);
  writer.pushBytes(request.manifestBuffer);
  writer.pushString(request.programId);
  writer.pushString(request.programName);
  writer.pushString(request.programVersion);
  writer.pushString(request.programDescription);

  writer.pushU32(request.requiredPlugins.length);
  request.requiredPlugins.forEach((value) => writer.pushString(value));

  writer.pushU32(request.typeDescriptors.length);
  request.typeDescriptors.forEach((descriptor) => {
    writer.pushString(descriptor.schemaName);
    writer.pushString(descriptor.fileIdentifier);
    writer.pushString(descriptor.schemaHashHex);
    writer.pushU8(descriptor.acceptsAnyFlatbuffer);
  });

  writer.pushU32(request.acceptedTypeIndices.length);
  request.acceptedTypeIndices.forEach((value) => writer.pushU32(value));

  writer.pushU32(request.triggers.length);
  request.triggers.forEach((trigger) => {
    writer.pushString(trigger.triggerId);
    writer.pushString(trigger.kind);
    writer.pushString(trigger.source);
    writer.pushString(trigger.protocolId);
    writer.pushU32(trigger.defaultIntervalMs);
    writer.pushU32(trigger.acceptedTypeIndexOffset);
    writer.pushU32(trigger.acceptedTypeIndexCount);
    writer.pushString(trigger.description);
  });

  writer.pushU32(request.nodes.length);
  request.nodes.forEach((node) => {
    writer.pushString(node.nodeId);
    writer.pushString(node.pluginId);
    writer.pushString(node.methodId);
    writer.pushString(node.kind);
    writer.pushString(node.drainPolicy);
    writer.pushU32(node.timeSliceMicros);
    writer.pushU32(node.ingressIndexOffset);
    writer.pushU32(node.ingressIndexCount);
  });

  writer.pushU32(request.edges.length);
  request.edges.forEach((edge) => {
    writer.pushString(edge.edgeId);
    writer.pushString(edge.fromNodeId);
    writer.pushU32(edge.fromNodeIndex);
    writer.pushString(edge.fromPortId);
    writer.pushString(edge.toNodeId);
    writer.pushU32(edge.toNodeIndex);
    writer.pushString(edge.toPortId);
    writer.pushString(edge.backpressurePolicy);
    writer.pushU32(edge.queueDepth);
    writer.pushU32(edge.acceptedTypeIndexOffset);
    writer.pushU32(edge.acceptedTypeIndexCount);
    writer.pushU32(edge.targetIngressIndex);
  });

  writer.pushU32(request.triggerBindings.length);
  request.triggerBindings.forEach((binding) => {
    writer.pushString(binding.triggerId);
    writer.pushU32(binding.triggerIndex);
    writer.pushString(binding.targetNodeId);
    writer.pushU32(binding.targetNodeIndex);
    writer.pushString(binding.targetPortId);
    writer.pushString(binding.backpressurePolicy);
    writer.pushU32(binding.queueDepth);
    writer.pushU32(binding.targetIngressIndex);
  });

  writer.pushU32(request.ingressDescriptors.length);
  request.ingressDescriptors.forEach((ingress) => {
    writer.pushString(ingress.ingressId);
    writer.pushString(ingress.sourceKind);
    writer.pushU32(ingress.sourceIndex);
    writer.pushU32(ingress.sourceNodeIndex);
    writer.pushString(ingress.sourcePortId ?? "");
    writer.pushU32(ingress.targetNodeIndex);
    writer.pushString(ingress.targetNodeId);
    writer.pushString(ingress.targetPortId);
    writer.pushString(ingress.backpressurePolicy);
    writer.pushU32(ingress.queueDepth);
  });

  writer.pushU32(request.externalInterfaces.length);
  request.externalInterfaces.forEach((externalInterface) => {
    writer.pushString(externalInterface.interfaceId);
    writer.pushString(externalInterface.kind);
    writer.pushString(externalInterface.direction);
    writer.pushString(externalInterface.capability);
    writer.pushString(externalInterface.resource);
    writer.pushString(externalInterface.protocolId);
    writer.pushString(externalInterface.topic);
    writer.pushString(externalInterface.path);
    writer.pushU8(externalInterface.required);
    writer.pushU32(externalInterface.acceptedTypeIndexOffset);
    writer.pushU32(externalInterface.acceptedTypeIndexCount);
    writer.pushString(externalInterface.description);
  });

  writer.pushU32(request.dependencies.length);
  request.dependencies.forEach((dependency) => {
    writer.pushString(dependency.dependencyId);
    writer.pushString(dependency.pluginId);
    writer.pushString(dependency.version);
    writer.pushString(dependency.sha256);
    writer.pushString(dependency.signature);
    writer.pushString(dependency.signerPublicKey);
    writer.pushString(dependency.entrypoint);
    writer.pushString(dependency.manifestExports.bytesSymbol);
    writer.pushString(dependency.manifestExports.sizeSymbol);
    writer.pushString(dependency.runtimeExports.initSymbol);
    writer.pushString(dependency.runtimeExports.destroySymbol);
    writer.pushString(dependency.runtimeExports.mallocSymbol);
    writer.pushString(dependency.runtimeExports.freeSymbol);
    writer.pushString(dependency.runtimeExports.streamInvokeSymbol);
    writer.pushBytes(dependency.wasm);
    writer.pushBytes(dependency.manifestBuffer);
  });

  writer.pushU32(request.nodeIngressIndices.length);
  request.nodeIngressIndices.forEach((value) => writer.pushU32(value));

  return writer.finish();
}

export async function generateCppFlowRuntimeSource(options = {}) {
  const request = createGeneratorRequest(options);
  const encodedRequest = encodeGeneratorRequest(request);
  const result = await runNativeFlowSourceGenerator(encodedRequest);
  return result.source;
}

export default generateCppFlowRuntimeSource;
