import { normalizeProgram } from "../runtime/index.js";
import { toUint8Array } from "../utils/encoding.js";

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

function renderNodeRuntimeStateArray(symbolName, count) {
  if (count <= 0) {
    return `static FlowNodeRuntimeState ${symbolName}[] = { {} };`;
  }
  return `static FlowNodeRuntimeState ${symbolName}[${count}] = {};`;
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

  const nodeRecords = normalizedProgram.nodes.map(
    (node) => `  {
    ${cppStringLiteral(node.nodeId)},
    ${cppStringLiteral(node.pluginId)},
    ${cppStringLiteral(node.methodId)},
    ${cppStringLiteral(node.kind)},
    ${cppStringLiteral(node.drainPolicy ?? "")},
    ${formatUnsigned(node.timeSliceMicros)}
  }`,
  );

  const edgeRecords = normalizedProgram.edges.map((edge) => {
    const acceptedTypes = typeRegistry.reserveTypeRefs(edge.acceptedTypes);
    return `  {
    ${cppStringLiteral(edge.edgeId)},
    ${cppStringLiteral(edge.fromNodeId)},
    ${cppStringLiteral(edge.fromPortId)},
    ${cppStringLiteral(edge.toNodeId)},
    ${cppStringLiteral(edge.toPortId)},
    ${cppStringLiteral(edge.backpressurePolicy ?? "")},
    ${formatUnsigned(edge.queueDepth)},
    ${formatUnsigned(acceptedTypes.offset)},
    ${formatUnsigned(acceptedTypes.count)}
  }`;
  });

  const triggerBindingRecords = normalizedProgram.triggerBindings.map(
    (binding) => `  {
    ${cppStringLiteral(binding.triggerId)},
    ${cppStringLiteral(binding.targetNodeId)},
    ${cppStringLiteral(binding.targetPortId)},
    ${cppStringLiteral(binding.backpressurePolicy ?? "")},
    ${formatUnsigned(binding.queueDepth)}
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
};

struct FlowEdgeDescriptor {
  const char * edge_id;
  const char * from_node_id;
  const char * from_port_id;
  const char * to_node_id;
  const char * to_port_id;
  const char * backpressure_policy;
  std::uint32_t queue_depth;
  std::uint32_t accepted_type_index_offset;
  std::uint32_t accepted_type_index_count;
};

struct FlowTriggerBindingDescriptor {
  const char * trigger_id;
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

struct FlowNodeRuntimeState {
  std::uint64_t invocation_count;
  std::uint32_t queued_frames;
  std::uint32_t last_status;
  bool ready;
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
  const FlowExternalInterfaceDescriptor * external_interfaces;
  std::size_t external_interface_count;
  const SignedArtifactDependency * dependencies;
  std::size_t dependency_count;
  FlowNodeRuntimeState * node_runtime_states;
  std::size_t node_runtime_state_count;
};

${renderByteArray("kFlowManifest", normalizedManifestBuffer)}

${renderStringPointerArray("kRequiredPlugins", requiredPlugins)}

${renderRecordArray("FlowTypeDescriptor", "kTypeDescriptors", typeDescriptorRecords)}

${renderIntegerArray(
  "std::uint32_t",
  "kAcceptedTypeIndices",
  typeRegistry.indices.map((value) => `${value}u`),
)}

${renderRecordArray("FlowTriggerDescriptor", "kTriggerDescriptors", triggerRecords)}

${renderRecordArray("FlowNodeDescriptor", "kNodeDescriptors", nodeRecords)}

${renderRecordArray("FlowEdgeDescriptor", "kEdgeDescriptors", edgeRecords)}

${renderRecordArray(
  "FlowTriggerBindingDescriptor",
  "kTriggerBindingDescriptors",
  triggerBindingRecords,
)}

${renderRecordArray(
  "FlowExternalInterfaceDescriptor",
  "kExternalInterfaceDescriptors",
  externalInterfaceRecords,
)}

${renderNodeRuntimeStateArray("kNodeRuntimeStates", normalizedProgram.nodes.length)}

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
  kExternalInterfaceDescriptors,
  ${externalInterfaceRecords.length},
  kDependencies,
  ${dependencyRecords.length},
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

extern "C" ${namespace}::FlowNodeRuntimeState * sdn_flow_get_node_runtime_states() {
  return ${namespace}::kNodeRuntimeStates;
}

extern "C" std::size_t sdn_flow_get_node_runtime_state_count() {
  return ${namespace}::kRuntimeDescriptor.node_runtime_state_count;
}

extern "C" void sdn_flow_reset_runtime_state() {
  for (std::size_t index = 0; index < ${namespace}::kRuntimeDescriptor.node_runtime_state_count; ++index) {
    ${namespace}::kNodeRuntimeStates[index].invocation_count = 0;
    ${namespace}::kNodeRuntimeStates[index].queued_frames = 0;
    ${namespace}::kNodeRuntimeStates[index].last_status = 0;
    ${namespace}::kNodeRuntimeStates[index].ready = false;
  }
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
