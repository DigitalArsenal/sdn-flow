import { normalizeProgram } from "../runtime/index.js";
import { toUint8Array } from "../utils/encoding.js";

const INVALID_INDEX = 0xffffffff;

function sanitizeIdentifier(value, fallback = "value") {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1")
    .replace(/_{2,}/g, "_")
    .replace(/^_+$/, fallback);
  return normalized.length > 0 ? normalized : fallback;
}

function cppStringLiteral(value) {
  return JSON.stringify(String(value ?? ""));
}

function cppBoolLiteral(value) {
  return value ? "true" : "false";
}

function renderByteArray(symbolName, bytes) {
  const normalized = toUint8Array(bytes);
  if (normalized.length === 0) {
    return `static const std::uint8_t ${symbolName}[] = { 0x00 };`;
  }
  const rows = [];
  for (let index = 0; index < normalized.length; index += 12) {
    const slice = normalized.slice(index, index + 12);
    rows.push(
      `  ${Array.from(slice, (byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")}`,
    );
  }
  return `static const std::uint8_t ${symbolName}[] = {\n${rows.join(",\n")}\n};`;
}

function renderRecordArray(
  typeName,
  symbolName,
  records,
  emptyInitializer = "{}",
) {
  if (records.length === 0) {
    return `static const ${typeName} ${symbolName}[] = { ${emptyInitializer} };`;
  }
  return `static const ${typeName} ${symbolName}[] = {\n${records.join(",\n")}\n};`;
}

function renderMutableRecordArray(typeName, symbolName, count) {
  if (count <= 0) {
    return `static ${typeName} ${symbolName}[] = { {} };`;
  }
  return `static ${typeName} ${symbolName}[${count}] = {};`;
}

function renderStringPointerArray(symbolName, values) {
  if (values.length === 0) {
    return `static const char * ${symbolName}[] = { nullptr };`;
  }
  return `static const char * ${symbolName}[] = {\n${values
    .map((value) => `  ${cppStringLiteral(value)}`)
    .join(",\n")}\n};`;
}

function renderIntegerArray(typeName, symbolName, values) {
  if (values.length === 0) {
    return `static const ${typeName} ${symbolName}[] = { 0 };`;
  }
  return `static const ${typeName} ${symbolName}[] = {\n${values
    .map((value) => `  ${value}`)
    .join(",\n")}\n};`;
}

function toHexString(bytes) {
  return Array.from(Array.isArray(bytes) ? bytes : [], (byte) =>
    Number(byte).toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeTypeDescriptor(typeRef = {}) {
  return {
    schemaName: typeRef.schemaName ?? "",
    fileIdentifier: typeRef.fileIdentifier ?? "",
    schemaHashHex: toHexString(typeRef.schemaHash ?? []),
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

function formatUnsigned(value) {
  return `${Math.max(0, Number(value ?? 0)) >>> 0}u`;
}

function formatIndex(value) {
  return value === null || value === undefined ? "kInvalidIndex" : `${value}u`;
}

function getMapIndex(indexMap, key) {
  if (!indexMap.has(key)) {
    return null;
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
      sourceNodeIndex: null,
      sourcePortId: null,
      targetNodeIndex,
      targetNodeId: binding.targetNodeId,
      targetPortId: binding.targetPortId,
      backpressurePolicy: binding.backpressurePolicy ?? "queue",
      queueDepth: binding.queueDepth ?? 0,
    });
    triggerBindingIngressIndexByBindingIndex.set(bindingIndex, ingressIndex);
    if (targetNodeIndex !== null) {
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
    if (targetNodeIndex !== null) {
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

export function generateCppFlowRuntimeSource({
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

  const triggerRecords = normalizedProgram.triggers.map((trigger) => {
    const acceptedTypes = typeRegistry.reserveTypeRefs(trigger.acceptedTypes);
    return `  {
    ${cppStringLiteral(trigger.triggerId)},
    ${cppStringLiteral(trigger.kind)},
    ${cppStringLiteral(trigger.source ?? "")},
    ${cppStringLiteral(trigger.protocolId ?? "")},
    ${formatUnsigned(trigger.defaultIntervalMs)},
    ${formatUnsigned(acceptedTypes.offset)},
    ${formatUnsigned(acceptedTypes.count)},
    ${cppStringLiteral(trigger.description ?? "")}
  }`;
  });

  const nodeRecords = normalizedProgram.nodes.map((node, nodeIndex) => {
    const ingressRange = ingressTopology.nodeIngressRanges[nodeIndex];
    return `  {
    ${cppStringLiteral(node.nodeId)},
    ${cppStringLiteral(node.pluginId)},
    ${cppStringLiteral(node.methodId)},
    ${cppStringLiteral(node.kind)},
    ${cppStringLiteral(node.drainPolicy ?? "")},
    ${formatUnsigned(node.timeSliceMicros)},
    ${formatUnsigned(ingressRange.offset)},
    ${formatUnsigned(ingressRange.count)}
  }`;
  });

  const edgeRecords = normalizedProgram.edges.map((edge, edgeIndex) => {
    const acceptedTypes = typeRegistry.reserveTypeRefs(edge.acceptedTypes);
    return `  {
    ${cppStringLiteral(edge.edgeId)},
    ${cppStringLiteral(edge.fromNodeId)},
    ${formatIndex(getMapIndex(nodeIndexById, edge.fromNodeId))},
    ${cppStringLiteral(edge.fromPortId)},
    ${cppStringLiteral(edge.toNodeId)},
    ${formatIndex(getMapIndex(nodeIndexById, edge.toNodeId))},
    ${cppStringLiteral(edge.toPortId)},
    ${cppStringLiteral(edge.backpressurePolicy ?? "")},
    ${formatUnsigned(edge.queueDepth)},
    ${formatUnsigned(acceptedTypes.offset)},
    ${formatUnsigned(acceptedTypes.count)},
    ${formatIndex(ingressTopology.edgeIngressIndexByEdgeIndex.get(edgeIndex))}
  }`;
  });

  const triggerBindingRecords = normalizedProgram.triggerBindings.map(
    (binding, bindingIndex) => `  {
    ${cppStringLiteral(binding.triggerId)},
    ${formatIndex(getMapIndex(triggerIndexById, binding.triggerId))},
    ${cppStringLiteral(binding.targetNodeId)},
    ${formatIndex(getMapIndex(nodeIndexById, binding.targetNodeId))},
    ${cppStringLiteral(binding.targetPortId)},
    ${cppStringLiteral(binding.backpressurePolicy ?? "")},
    ${formatUnsigned(binding.queueDepth)},
    ${formatIndex(
      ingressTopology.triggerBindingIngressIndexByBindingIndex.get(
        bindingIndex,
      ),
    )}
  }`,
  );

  const ingressDescriptorRecords = ingressTopology.ingressDescriptors.map(
    (ingress) => `  {
    ${cppStringLiteral(ingress.ingressId)},
    ${cppStringLiteral(ingress.sourceKind)},
    ${formatIndex(ingress.sourceIndex)},
    ${formatIndex(ingress.sourceNodeIndex)},
    ${cppStringLiteral(ingress.sourcePortId ?? "")},
    ${formatIndex(ingress.targetNodeIndex)},
    ${cppStringLiteral(ingress.targetNodeId)},
    ${cppStringLiteral(ingress.targetPortId)},
    ${cppStringLiteral(ingress.backpressurePolicy)},
    ${formatUnsigned(ingress.queueDepth)}
  }`,
  );

  const externalInterfaceRecords = normalizedProgram.externalInterfaces.map(
    (externalInterface) => {
      const acceptedTypes = typeRegistry.reserveTypeRefs(
        externalInterface.acceptedTypes,
      );
      return `  {
    ${cppStringLiteral(externalInterface.interfaceId)},
    ${cppStringLiteral(externalInterface.kind ?? "")},
    ${cppStringLiteral(externalInterface.direction ?? "")},
    ${cppStringLiteral(externalInterface.capability ?? "")},
    ${cppStringLiteral(externalInterface.resource ?? "")},
    ${cppStringLiteral(externalInterface.protocolId ?? "")},
    ${cppStringLiteral(externalInterface.topic ?? "")},
    ${cppStringLiteral(externalInterface.path ?? "")},
    ${cppBoolLiteral(externalInterface.required !== false)},
    ${formatUnsigned(acceptedTypes.offset)},
    ${formatUnsigned(acceptedTypes.count)},
    ${cppStringLiteral(externalInterface.description ?? "")}
  }`;
    },
  );

  const typeDescriptorRecords = typeRegistry.descriptors.map(
    (descriptor) => `  {
    ${cppStringLiteral(descriptor.schemaName)},
    ${cppStringLiteral(descriptor.fileIdentifier)},
    ${cppStringLiteral(descriptor.schemaHashHex)},
    ${cppBoolLiteral(descriptor.acceptsAnyFlatbuffer)}
  }`,
  );

  const dependencyBlocks = [];
  const dependencyRecords = [];
  dependencies.forEach((dependency, index) => {
    const dependencyName = sanitizeIdentifier(
      dependency.dependencyId ??
        dependency.pluginId ??
        dependency.artifactId ??
        `dependency_${index}`,
      `dependency_${index}`,
    );
    const wasmSymbol = `k${dependencyName}Wasm`;
    const manifestSymbol = `k${dependencyName}Manifest`;
    dependencyBlocks.push(renderByteArray(wasmSymbol, dependency.wasm));
    if (dependency.manifestBuffer) {
      dependencyBlocks.push(
        renderByteArray(manifestSymbol, dependency.manifestBuffer),
      );
    }
    dependencyRecords.push(`  {
    ${cppStringLiteral(dependency.dependencyId ?? dependencyName)},
    ${cppStringLiteral(dependency.pluginId ?? "")},
    ${cppStringLiteral(dependency.version ?? "")},
    ${cppStringLiteral(dependency.sha256 ?? "")},
    ${cppStringLiteral(dependency.signature ?? "")},
    ${cppStringLiteral(dependency.signerPublicKey ?? "")},
    ${wasmSymbol},
    sizeof(${wasmSymbol}),
    ${dependency.manifestBuffer ? manifestSymbol : "nullptr"},
    ${dependency.manifestBuffer ? `sizeof(${manifestSymbol})` : "0"}
  }`);
  });

  const requiredPlugins = normalizedProgram.requiredPlugins.map((pluginId) =>
    String(pluginId),
  );

  return `#include <cstddef>
#include <cstdint>

namespace ${namespace} {

static constexpr std::uint32_t kInvalidIndex = 0xffffffffu;

struct SignedArtifactDependency {
  const char * dependency_id;
  const char * plugin_id;
  const char * version;
  const char * sha256;
  const char * signature;
  const char * signer_public_key;
  const std::uint8_t * wasm_bytes;
  std::size_t wasm_size;
  const std::uint8_t * manifest_bytes;
  std::size_t manifest_size;
};

struct FlowTypeDescriptor {
  const char * schema_name;
  const char * file_identifier;
  const char * schema_hash_hex;
  bool accepts_any_flatbuffer;
};

struct FlowTriggerDescriptor {
  const char * trigger_id;
  const char * kind;
  const char * source;
  const char * protocol_id;
  std::uint32_t default_interval_ms;
  std::uint32_t accepted_type_index_offset;
  std::uint32_t accepted_type_index_count;
  const char * description;
};

struct FlowNodeDescriptor {
  const char * node_id;
  const char * plugin_id;
  const char * method_id;
  const char * kind;
  const char * drain_policy;
  std::uint32_t time_slice_micros;
  std::uint32_t ingress_index_offset;
  std::uint32_t ingress_index_count;
};

struct FlowEdgeDescriptor {
  const char * edge_id;
  const char * from_node_id;
  std::uint32_t from_node_index;
  const char * from_port_id;
  const char * to_node_id;
  std::uint32_t to_node_index;
  const char * to_port_id;
  const char * backpressure_policy;
  std::uint32_t queue_depth;
  std::uint32_t accepted_type_index_offset;
  std::uint32_t accepted_type_index_count;
  std::uint32_t target_ingress_index;
};

struct FlowTriggerBindingDescriptor {
  const char * trigger_id;
  std::uint32_t trigger_index;
  const char * target_node_id;
  std::uint32_t target_node_index;
  const char * target_port_id;
  const char * backpressure_policy;
  std::uint32_t queue_depth;
  std::uint32_t target_ingress_index;
};

struct FlowIngressDescriptor {
  const char * ingress_id;
  const char * source_kind;
  std::uint32_t source_index;
  std::uint32_t source_node_index;
  const char * source_port_id;
  std::uint32_t target_node_index;
  const char * target_node_id;
  const char * target_port_id;
  const char * backpressure_policy;
  std::uint32_t queue_depth;
};

struct FlowExternalInterfaceDescriptor {
  const char * interface_id;
  const char * kind;
  const char * direction;
  const char * capability;
  const char * resource;
  const char * protocol_id;
  const char * topic;
  const char * path;
  bool required;
  std::uint32_t accepted_type_index_offset;
  std::uint32_t accepted_type_index_count;
  const char * description;
};

struct FlowIngressRuntimeState {
  std::uint64_t total_received;
  std::uint64_t total_dropped;
  std::uint32_t queued_frames;
};

struct FlowNodeRuntimeState {
  std::uint64_t invocation_count;
  std::uint64_t consumed_frames;
  std::uint32_t queued_frames;
  std::uint32_t backlog_remaining;
  std::uint32_t last_status;
  bool ready;
  bool yielded;
};

struct FlowRuntimeDescriptor {
  const char * program_id;
  const char * program_name;
  const char * program_version;
  const char * program_description;
  const char * execution_model;
  const char * entrypoint;
  const char * manifest_bytes_symbol;
  const char * manifest_size_symbol;
  const char * const * required_plugins;
  std::size_t required_plugin_count;
  const FlowTypeDescriptor * type_descriptors;
  std::size_t type_descriptor_count;
  const std::uint32_t * accepted_type_indices;
  std::size_t accepted_type_index_count;
  const FlowTriggerDescriptor * triggers;
  std::size_t trigger_count;
  const FlowNodeDescriptor * nodes;
  std::size_t node_count;
  const FlowEdgeDescriptor * edges;
  std::size_t edge_count;
  const FlowTriggerBindingDescriptor * trigger_bindings;
  std::size_t trigger_binding_count;
  const FlowIngressDescriptor * ingress_descriptors;
  std::size_t ingress_count;
  const std::uint32_t * node_ingress_indices;
  std::size_t node_ingress_index_count;
  const FlowExternalInterfaceDescriptor * external_interfaces;
  std::size_t external_interface_count;
  const SignedArtifactDependency * dependencies;
  std::size_t dependency_count;
  FlowIngressRuntimeState * ingress_runtime_states;
  std::size_t ingress_runtime_state_count;
  FlowNodeRuntimeState * node_runtime_states;
  std::size_t node_runtime_state_count;
};

static std::uint32_t min_u32(std::uint32_t left, std::uint32_t right) {
  return left < right ? left : right;
}

static bool string_equals(const char * left, const char * right) {
  if (left == right) {
    return true;
  }
  if (left == nullptr || right == nullptr) {
    return false;
  }
  while (*left != '\\0' && *right != '\\0') {
    if (*left != *right) {
      return false;
    }
    ++left;
    ++right;
  }
  return *left == *right;
}

${renderByteArray("kFlowManifest", normalizedManifestBuffer)}

${renderStringPointerArray("kRequiredPlugins", requiredPlugins)}

${renderRecordArray(
  "FlowTypeDescriptor",
  "kTypeDescriptors",
  typeDescriptorRecords,
)}

${renderIntegerArray(
  "std::uint32_t",
  "kAcceptedTypeIndices",
  typeRegistry.indices.map((value) => `${value}u`),
)}

${renderRecordArray(
  "FlowTriggerDescriptor",
  "kTriggerDescriptors",
  triggerRecords,
)}

${renderRecordArray("FlowNodeDescriptor", "kNodeDescriptors", nodeRecords)}

${renderRecordArray("FlowEdgeDescriptor", "kEdgeDescriptors", edgeRecords)}

${renderRecordArray(
  "FlowTriggerBindingDescriptor",
  "kTriggerBindingDescriptors",
  triggerBindingRecords,
)}

${renderRecordArray(
  "FlowIngressDescriptor",
  "kIngressDescriptors",
  ingressDescriptorRecords,
)}

${renderIntegerArray(
  "std::uint32_t",
  "kNodeIngressIndices",
  ingressTopology.flattenedNodeIngressIndices.map((value) => `${value}u`),
)}

${renderRecordArray(
  "FlowExternalInterfaceDescriptor",
  "kExternalInterfaceDescriptors",
  externalInterfaceRecords,
)}

${renderMutableRecordArray(
  "FlowIngressRuntimeState",
  "kIngressRuntimeStates",
  ingressTopology.ingressDescriptors.length,
)}

${renderMutableRecordArray(
  "FlowNodeRuntimeState",
  "kNodeRuntimeStates",
  normalizedProgram.nodes.length,
)}

${dependencyBlocks.join("\n\n")}

${renderRecordArray("SignedArtifactDependency", "kDependencies", dependencyRecords)}

static const char kProgramId[] = ${cppStringLiteral(normalizedProgram.programId)};
static const char kProgramName[] = ${cppStringLiteral(
    normalizedProgram.name ?? normalizedProgram.programId,
  )};
static const char kProgramVersion[] = ${cppStringLiteral(
    normalizedProgram.version ?? "0.1.0",
  )};
static const char kProgramDescription[] = ${cppStringLiteral(
    normalizedProgram.description ?? "",
  )};
static const char kExecutionModel[] = "compiled-cpp-wasm";
static const char kEntrypoint[] = "main";
static const char kManifestBytesSymbol[] = "flow_get_manifest_flatbuffer";
static const char kManifestSizeSymbol[] = "flow_get_manifest_flatbuffer_size";

static void recompute_node_runtime_state(std::uint32_t node_index) {
  if (node_index >= ${normalizedProgram.nodes.length}) {
    return;
  }

  const FlowNodeDescriptor & node_descriptor = kNodeDescriptors[node_index];
  FlowNodeRuntimeState & node_state = kNodeRuntimeStates[node_index];
  std::uint32_t queued_frames = 0;
  for (
    std::uint32_t offset = 0;
    offset < node_descriptor.ingress_index_count;
    ++offset
  ) {
    const std::uint32_t ingress_index =
      kNodeIngressIndices[node_descriptor.ingress_index_offset + offset];
    queued_frames += kIngressRuntimeStates[ingress_index].queued_frames;
  }
  node_state.queued_frames = queued_frames;
  node_state.ready = queued_frames > 0 || node_state.backlog_remaining > 0;
}

static void recompute_all_node_runtime_state() {
  for (std::uint32_t node_index = 0; node_index < ${normalizedProgram.nodes.length}; ++node_index) {
    recompute_node_runtime_state(node_index);
  }
}

static void apply_backpressure(std::uint32_t ingress_index, std::uint32_t frame_count) {
  if (ingress_index >= ${ingressTopology.ingressDescriptors.length}) {
    return;
  }

  FlowIngressRuntimeState & ingress_state = kIngressRuntimeStates[ingress_index];
  const FlowIngressDescriptor & ingress_descriptor = kIngressDescriptors[ingress_index];
  ingress_state.total_received += frame_count;

  const bool bounded = ingress_descriptor.queue_depth > 0;
  if (string_equals(ingress_descriptor.backpressure_policy, "drop")) {
    std::uint32_t accepted = frame_count;
    if (bounded) {
      const std::uint32_t available =
        ingress_descriptor.queue_depth > ingress_state.queued_frames
          ? ingress_descriptor.queue_depth - ingress_state.queued_frames
          : 0;
      accepted = min_u32(frame_count, available);
      ingress_state.total_dropped += frame_count - accepted;
    }
    ingress_state.queued_frames += accepted;
    return;
  }

  if (
    string_equals(ingress_descriptor.backpressure_policy, "latest") ||
    string_equals(ingress_descriptor.backpressure_policy, "coalesce")
  ) {
    if (!bounded) {
      ingress_state.queued_frames += frame_count;
      return;
    }
    if (frame_count == 0) {
      return;
    }
    if (ingress_state.queued_frames + frame_count > ingress_descriptor.queue_depth) {
      ingress_state.total_dropped +=
        static_cast<std::uint64_t>(ingress_state.queued_frames) +
        static_cast<std::uint64_t>(frame_count) -
        1u;
      ingress_state.queued_frames = 1u;
      return;
    }
    ingress_state.queued_frames += frame_count;
    return;
  }

  if (string_equals(ingress_descriptor.backpressure_policy, "block-request")) {
    if (
      bounded &&
      ingress_state.queued_frames + frame_count > ingress_descriptor.queue_depth
    ) {
      ingress_state.total_dropped += frame_count;
      return;
    }
    ingress_state.queued_frames += frame_count;
    return;
  }

  if (
    bounded &&
    ingress_state.queued_frames + frame_count > ingress_descriptor.queue_depth
  ) {
    ingress_state.total_dropped +=
      static_cast<std::uint64_t>(ingress_state.queued_frames) +
      static_cast<std::uint64_t>(frame_count) -
      static_cast<std::uint64_t>(ingress_descriptor.queue_depth);
    ingress_state.queued_frames = ingress_descriptor.queue_depth;
    return;
  }

  ingress_state.queued_frames += frame_count;
}

static FlowRuntimeDescriptor kRuntimeDescriptor = {
  kProgramId,
  kProgramName,
  kProgramVersion,
  kProgramDescription,
  kExecutionModel,
  kEntrypoint,
  kManifestBytesSymbol,
  kManifestSizeSymbol,
  kRequiredPlugins,
  ${requiredPlugins.length},
  kTypeDescriptors,
  ${typeDescriptorRecords.length},
  kAcceptedTypeIndices,
  ${typeRegistry.indices.length},
  kTriggerDescriptors,
  ${triggerRecords.length},
  kNodeDescriptors,
  ${nodeRecords.length},
  kEdgeDescriptors,
  ${edgeRecords.length},
  kTriggerBindingDescriptors,
  ${triggerBindingRecords.length},
  kIngressDescriptors,
  ${ingressDescriptorRecords.length},
  kNodeIngressIndices,
  ${ingressTopology.flattenedNodeIngressIndices.length},
  kExternalInterfaceDescriptors,
  ${externalInterfaceRecords.length},
  kDependencies,
  ${dependencyRecords.length},
  kIngressRuntimeStates,
  ${ingressDescriptorRecords.length},
  kNodeRuntimeStates,
  ${normalizedProgram.nodes.length}
};

}  // namespace ${namespace}

extern "C" const std::uint8_t * flow_get_manifest_flatbuffer() {
  return ${namespace}::kFlowManifest;
}

extern "C" std::size_t flow_get_manifest_flatbuffer_size() {
  return sizeof(${namespace}::kFlowManifest);
}

extern "C" const char * sdn_flow_get_program_id() {
  return ${namespace}::kProgramId;
}

extern "C" const char * sdn_flow_get_program_name() {
  return ${namespace}::kProgramName;
}

extern "C" const char * sdn_flow_get_program_version() {
  return ${namespace}::kProgramVersion;
}

extern "C" const ${namespace}::SignedArtifactDependency * sdn_flow_get_dependency_descriptors() {
  return ${namespace}::kDependencies;
}

extern "C" std::size_t sdn_flow_get_dependency_count() {
  return ${namespace}::kRuntimeDescriptor.dependency_count;
}

extern "C" const ${namespace}::FlowIngressDescriptor * sdn_flow_get_ingress_descriptors() {
  return ${namespace}::kIngressDescriptors;
}

extern "C" std::size_t sdn_flow_get_ingress_descriptor_count() {
  return ${namespace}::kRuntimeDescriptor.ingress_count;
}

extern "C" ${namespace}::FlowIngressRuntimeState * sdn_flow_get_ingress_runtime_states() {
  return ${namespace}::kIngressRuntimeStates;
}

extern "C" std::size_t sdn_flow_get_ingress_runtime_state_count() {
  return ${namespace}::kRuntimeDescriptor.ingress_runtime_state_count;
}

extern "C" ${namespace}::FlowNodeRuntimeState * sdn_flow_get_node_runtime_states() {
  return ${namespace}::kNodeRuntimeStates;
}

extern "C" std::size_t sdn_flow_get_node_runtime_state_count() {
  return ${namespace}::kRuntimeDescriptor.node_runtime_state_count;
}

extern "C" void sdn_flow_reset_runtime_state() {
  for (std::size_t index = 0; index < ${namespace}::kRuntimeDescriptor.ingress_runtime_state_count; ++index) {
    ${namespace}::kIngressRuntimeStates[index].total_received = 0;
    ${namespace}::kIngressRuntimeStates[index].total_dropped = 0;
    ${namespace}::kIngressRuntimeStates[index].queued_frames = 0;
  }
  for (std::size_t index = 0; index < ${namespace}::kRuntimeDescriptor.node_runtime_state_count; ++index) {
    ${namespace}::kNodeRuntimeStates[index].invocation_count = 0;
    ${namespace}::kNodeRuntimeStates[index].consumed_frames = 0;
    ${namespace}::kNodeRuntimeStates[index].queued_frames = 0;
    ${namespace}::kNodeRuntimeStates[index].backlog_remaining = 0;
    ${namespace}::kNodeRuntimeStates[index].last_status = 0;
    ${namespace}::kNodeRuntimeStates[index].ready = false;
    ${namespace}::kNodeRuntimeStates[index].yielded = false;
  }
}

extern "C" std::uint32_t sdn_flow_enqueue_trigger_frames(std::uint32_t trigger_index, std::uint32_t frame_count) {
  std::uint32_t routed_binding_count = 0;
  for (std::size_t binding_index = 0; binding_index < ${namespace}::kRuntimeDescriptor.trigger_binding_count; ++binding_index) {
    const ${namespace}::FlowTriggerBindingDescriptor & binding =
      ${namespace}::kTriggerBindingDescriptors[binding_index];
    if (binding.trigger_index != trigger_index) {
      continue;
    }
    if (binding.target_ingress_index == ${namespace}::kInvalidIndex) {
      continue;
    }
    ${namespace}::apply_backpressure(binding.target_ingress_index, frame_count);
    if (binding.target_node_index != ${namespace}::kInvalidIndex) {
      ${namespace}::recompute_node_runtime_state(binding.target_node_index);
    }
    routed_binding_count += 1;
  }
  return routed_binding_count;
}

extern "C" std::uint32_t sdn_flow_enqueue_edge_frames(std::uint32_t edge_index, std::uint32_t frame_count) {
  if (edge_index >= ${namespace}::kRuntimeDescriptor.edge_count) {
    return 0;
  }
  const ${namespace}::FlowEdgeDescriptor & edge = ${namespace}::kEdgeDescriptors[edge_index];
  if (edge.target_ingress_index == ${namespace}::kInvalidIndex) {
    return 0;
  }
  ${namespace}::apply_backpressure(edge.target_ingress_index, frame_count);
  if (edge.to_node_index != ${namespace}::kInvalidIndex) {
    ${namespace}::recompute_node_runtime_state(edge.to_node_index);
  }
  return 1;
}

extern "C" std::uint32_t sdn_flow_get_ready_node_index() {
  ${namespace}::recompute_all_node_runtime_state();
  for (std::uint32_t node_index = 0; node_index < ${namespace}::kRuntimeDescriptor.node_count; ++node_index) {
    if (${namespace}::kNodeRuntimeStates[node_index].ready) {
      return node_index;
    }
  }
  return ${namespace}::kInvalidIndex;
}

extern "C" std::uint32_t sdn_flow_begin_node_invocation(std::uint32_t node_index, std::uint32_t frame_budget) {
  if (node_index >= ${namespace}::kRuntimeDescriptor.node_count) {
    return 0;
  }

  ${namespace}::FlowNodeRuntimeState & node_state =
    ${namespace}::kNodeRuntimeStates[node_index];
  const ${namespace}::FlowNodeDescriptor & node_descriptor =
    ${namespace}::kNodeDescriptors[node_index];
  const std::uint32_t budget = frame_budget == 0 ? 1u : frame_budget;
  std::uint32_t consumed = 0;

  for (
    std::uint32_t offset = 0;
    offset < node_descriptor.ingress_index_count && consumed < budget;
    ++offset
  ) {
    const std::uint32_t ingress_index =
      ${namespace}::kNodeIngressIndices[node_descriptor.ingress_index_offset + offset];
    ${namespace}::FlowIngressRuntimeState & ingress_state =
      ${namespace}::kIngressRuntimeStates[ingress_index];
    if (ingress_state.queued_frames == 0) {
      continue;
    }
    const std::uint32_t taken =
      ${namespace}::min_u32(ingress_state.queued_frames, budget - consumed);
    ingress_state.queued_frames -= taken;
    consumed += taken;
  }

  if (consumed > 0) {
    node_state.invocation_count += 1;
    node_state.consumed_frames += consumed;
  }
  node_state.backlog_remaining = 0;
  node_state.yielded = false;
  ${namespace}::recompute_node_runtime_state(node_index);
  return consumed;
}

extern "C" void sdn_flow_complete_node_invocation(
  std::uint32_t node_index,
  std::uint32_t status_code,
  std::uint32_t backlog_remaining,
  bool yielded
) {
  if (node_index >= ${namespace}::kRuntimeDescriptor.node_count) {
    return;
  }
  ${namespace}::FlowNodeRuntimeState & node_state =
    ${namespace}::kNodeRuntimeStates[node_index];
  node_state.last_status = status_code;
  node_state.backlog_remaining = backlog_remaining;
  node_state.yielded = yielded;
  ${namespace}::recompute_node_runtime_state(node_index);
}

extern "C" const ${namespace}::FlowRuntimeDescriptor * sdn_flow_get_runtime_descriptor() {
  return &${namespace}::kRuntimeDescriptor;
}

int main(int argc, char ** argv) {
  (void)argc;
  (void)argv;
  sdn_flow_reset_runtime_state();
  return 0;
}
`;
}

export default generateCppFlowRuntimeSource;
