#include <cctype>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr std::uint32_t kInvalidIndex = 0xffffffffu;
constexpr char kRequestMagic[] = "SDNFLOWCPPGEN1";
constexpr std::uint32_t kPluginPayloadWireFormatFlatbuffer = 0u;
constexpr std::uint32_t kPluginPayloadWireFormatAlignedBinary = 1u;

struct TypeDescriptor {
  std::string schema_name;
  std::string file_identifier;
  std::string schema_hash_hex;
  bool accepts_any_flatbuffer = false;
};

struct TriggerDescriptor {
  std::string trigger_id;
  std::string kind;
  std::string source;
  std::string protocol_id;
  std::uint32_t default_interval_ms = 0;
  std::uint32_t accepted_type_index_offset = 0;
  std::uint32_t accepted_type_index_count = 0;
  std::string description;
};

struct NodeDescriptor {
  std::string node_id;
  std::string plugin_id;
  std::string method_id;
  std::string dependency_id;
  std::uint32_t dependency_index = kInvalidIndex;
  std::string linked_method_symbol;
  std::string kind;
  std::string drain_policy;
  std::uint32_t time_slice_micros = 0;
  std::uint32_t ingress_index_offset = 0;
  std::uint32_t ingress_index_count = 0;
};

struct EdgeDescriptor {
  std::string edge_id;
  std::string from_node_id;
  std::uint32_t from_node_index = kInvalidIndex;
  std::string from_port_id;
  std::string to_node_id;
  std::uint32_t to_node_index = kInvalidIndex;
  std::string to_port_id;
  std::string backpressure_policy;
  std::uint32_t queue_depth = 0;
  std::uint32_t accepted_type_index_offset = 0;
  std::uint32_t accepted_type_index_count = 0;
  std::uint32_t target_ingress_index = kInvalidIndex;
};

struct TriggerBindingDescriptor {
  std::string trigger_id;
  std::uint32_t trigger_index = kInvalidIndex;
  std::string target_node_id;
  std::uint32_t target_node_index = kInvalidIndex;
  std::string target_port_id;
  std::string backpressure_policy;
  std::uint32_t queue_depth = 0;
  std::uint32_t target_ingress_index = kInvalidIndex;
};

struct IngressDescriptor {
  std::string ingress_id;
  std::string source_kind;
  std::uint32_t source_index = kInvalidIndex;
  std::uint32_t source_node_index = kInvalidIndex;
  std::string source_port_id;
  std::uint32_t target_node_index = kInvalidIndex;
  std::string target_node_id;
  std::string target_port_id;
  std::string backpressure_policy;
  std::uint32_t queue_depth = 0;
};

struct ExternalInterfaceDescriptor {
  std::string interface_id;
  std::string kind;
  std::string direction;
  std::string capability;
  std::string resource;
  std::string protocol_id;
  std::string topic;
  std::string path;
  bool required = true;
  std::uint32_t accepted_type_index_offset = 0;
  std::uint32_t accepted_type_index_count = 0;
  std::string description;
};

struct SignedArtifactDependency {
  std::string dependency_id;
  std::string plugin_id;
  std::string version;
  std::string sha256;
  std::string signature;
  std::string signer_public_key;
  std::string entrypoint;
  std::string manifest_bytes_symbol;
  std::string manifest_size_symbol;
  std::string init_symbol;
  std::string destroy_symbol;
  std::string malloc_symbol;
  std::string free_symbol;
  std::string stream_invoke_symbol;
  std::vector<std::uint8_t> wasm_bytes;
  std::vector<std::uint8_t> manifest_bytes;
};

struct Request {
  std::string namespace_name;
  std::vector<std::uint8_t> manifest_buffer;
  std::string program_id;
  std::string program_name;
  std::string program_version;
  std::string program_description;
  std::vector<std::string> required_plugins;
  std::vector<TypeDescriptor> type_descriptors;
  std::vector<std::uint32_t> accepted_type_indices;
  std::vector<TriggerDescriptor> triggers;
  std::vector<NodeDescriptor> nodes;
  std::vector<EdgeDescriptor> edges;
  std::vector<TriggerBindingDescriptor> trigger_bindings;
  std::vector<IngressDescriptor> ingress_descriptors;
  std::vector<ExternalInterfaceDescriptor> external_interfaces;
  std::vector<SignedArtifactDependency> dependencies;
  std::vector<std::uint32_t> node_ingress_indices;
  std::string editor_metadata_json;
};

class BinaryReader {
 public:
  explicit BinaryReader(std::vector<std::uint8_t> bytes)
      : bytes_(std::move(bytes)) {}

  void expectMagic() {
    const std::string magic = readString();
    if (magic != kRequestMagic) {
      throw std::runtime_error("invalid flow source generator request header");
    }
  }

  std::uint8_t readU8() {
    ensureAvailable(1);
    return bytes_[offset_++];
  }

  bool readBool() { return readU8() != 0; }

  std::uint32_t readU32() {
    ensureAvailable(4);
    const std::uint32_t value =
        static_cast<std::uint32_t>(bytes_[offset_]) |
        (static_cast<std::uint32_t>(bytes_[offset_ + 1]) << 8u) |
        (static_cast<std::uint32_t>(bytes_[offset_ + 2]) << 16u) |
        (static_cast<std::uint32_t>(bytes_[offset_ + 3]) << 24u);
    offset_ += 4;
    return value;
  }

  std::string readString() {
    const auto data = readBytes();
    return std::string(data.begin(), data.end());
  }

  std::vector<std::uint8_t> readBytes() {
    const std::uint32_t size = readU32();
    ensureAvailable(size);
    std::vector<std::uint8_t> result(bytes_.begin() + offset_,
                                     bytes_.begin() + offset_ + size);
    offset_ += size;
    return result;
  }

  bool hasRemaining() const { return offset_ < bytes_.size(); }

 private:
  void ensureAvailable(std::size_t count) const {
    if (offset_ + count > bytes_.size()) {
      throw std::runtime_error("unexpected end of flow generator request");
    }
  }

  std::vector<std::uint8_t> bytes_;
  std::size_t offset_ = 0;
};

std::vector<std::uint8_t> readFileBytes(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("failed to open input request file");
  }
  input.seekg(0, std::ios::end);
  const auto size = static_cast<std::size_t>(input.tellg());
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> buffer(size);
  if (size > 0) {
    input.read(reinterpret_cast<char*>(buffer.data()),
               static_cast<std::streamsize>(buffer.size()));
  }
  return buffer;
}

void writeFileString(const std::filesystem::path& path, const std::string& text) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("failed to open output source file");
  }
  output.write(text.data(), static_cast<std::streamsize>(text.size()));
}

std::string cppStringLiteral(std::string_view value) {
  std::ostringstream out;
  out << '"';
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (std::isprint(ch) != 0) {
          out << static_cast<char>(ch);
        } else {
          out << "\\x" << std::hex << std::setw(2) << std::setfill('0')
              << static_cast<int>(ch) << std::dec << std::setfill(' ');
        }
        break;
    }
  }
  out << '"';
  return out.str();
}

std::string cppBoolLiteral(bool value) { return value ? "true" : "false"; }

std::string formatUnsigned(std::uint32_t value) {
  return std::to_string(value) + "u";
}

std::string formatIndex(std::uint32_t value) {
  if (value == kInvalidIndex) {
    return "kInvalidIndex";
  }
  return std::to_string(value) + "u";
}

std::string sanitizeIdentifier(std::string_view value, std::string_view fallback) {
  std::string normalized;
  normalized.reserve(value.size());
  for (const unsigned char ch : value) {
    if (std::isalnum(ch) != 0 || ch == '_') {
      normalized.push_back(static_cast<char>(ch));
    } else {
      normalized.push_back('_');
    }
  }
  if (normalized.empty()) {
    normalized.assign(fallback);
  }
  if (!(std::isalpha(static_cast<unsigned char>(normalized.front())) != 0 ||
        normalized.front() == '_')) {
    normalized.insert(normalized.begin(), '_');
  }
  while (normalized.find("__") != std::string::npos) {
    normalized.replace(normalized.find("__"), 2, "_");
  }
  bool only_underscores = true;
  for (const char ch : normalized) {
    if (ch != '_') {
      only_underscores = false;
      break;
    }
  }
  if (only_underscores) {
    normalized.assign(fallback);
  }
  return normalized;
}

std::string renderByteArray(std::string_view symbol_name,
                            const std::vector<std::uint8_t>& bytes) {
  std::ostringstream out;
  if (bytes.empty()) {
    out << "static const std::uint8_t " << symbol_name
        << "[] = { 0x00 };";
    return out.str();
  }
  out << "static const std::uint8_t " << symbol_name << "[] = {\n";
  for (std::size_t index = 0; index < bytes.size(); index += 12) {
    out << "  ";
    const auto stop = std::min<std::size_t>(bytes.size(), index + 12);
    for (std::size_t cursor = index; cursor < stop; ++cursor) {
      if (cursor > index) {
        out << ", ";
      }
      out << "0x" << std::hex << std::setw(2) << std::setfill('0')
          << static_cast<int>(bytes[cursor]) << std::dec << std::setfill(' ');
    }
    if (stop < bytes.size()) {
      out << ',';
    }
    out << '\n';
  }
  out << "};";
  return out.str();
}

std::string renderRecordArray(std::string_view type_name,
                              std::string_view symbol_name,
                              const std::vector<std::string>& records,
                              std::string_view empty_initializer = "{}") {
  std::ostringstream out;
  if (records.empty()) {
    out << "static const " << type_name << ' ' << symbol_name << "[] = { "
        << empty_initializer << " };";
    return out.str();
  }
  out << "static const " << type_name << ' ' << symbol_name << "[] = {\n";
  for (std::size_t index = 0; index < records.size(); ++index) {
    out << records[index];
    if (index + 1 < records.size()) {
      out << ',';
    }
    out << '\n';
  }
  out << "};";
  return out.str();
}

std::string renderMutableRecordArray(std::string_view type_name,
                                     std::string_view symbol_name,
                                     std::size_t count) {
  std::ostringstream out;
  if (count == 0) {
    out << "static " << type_name << ' ' << symbol_name << "[] = { {} };";
    return out.str();
  }
  out << "static " << type_name << ' ' << symbol_name << '[' << count
      << "] = {};";
  return out.str();
}

std::string renderStringPointerArray(std::string_view symbol_name,
                                     const std::vector<std::string>& values) {
  std::ostringstream out;
  if (values.empty()) {
    out << "static const char * " << symbol_name << "[] = { nullptr };";
    return out.str();
  }
  out << "static const char * " << symbol_name << "[] = {\n";
  for (std::size_t index = 0; index < values.size(); ++index) {
    out << "  " << cppStringLiteral(values[index]);
    if (index + 1 < values.size()) {
      out << ',';
    }
    out << '\n';
  }
  out << "};";
  return out.str();
}

std::string renderIntegerArray(std::string_view type_name,
                               std::string_view symbol_name,
                               const std::vector<std::uint32_t>& values) {
  std::ostringstream out;
  if (values.empty()) {
    out << "static const " << type_name << ' ' << symbol_name
        << "[] = { 0 };";
    return out.str();
  }
  out << "static const " << type_name << ' ' << symbol_name << "[] = {\n";
  for (std::size_t index = 0; index < values.size(); ++index) {
    out << "  " << values[index] << 'u';
    if (index + 1 < values.size()) {
      out << ',';
    }
    out << '\n';
  }
  out << "};";
  return out.str();
}

Request readRequest(BinaryReader& reader) {
  Request request;
  reader.expectMagic();
  request.namespace_name = reader.readString();
  request.manifest_buffer = reader.readBytes();
  request.program_id = reader.readString();
  request.program_name = reader.readString();
  request.program_version = reader.readString();
  request.program_description = reader.readString();

  const std::uint32_t required_plugin_count = reader.readU32();
  request.required_plugins.reserve(required_plugin_count);
  for (std::uint32_t index = 0; index < required_plugin_count; ++index) {
    request.required_plugins.push_back(reader.readString());
  }

  const std::uint32_t type_descriptor_count = reader.readU32();
  request.type_descriptors.reserve(type_descriptor_count);
  for (std::uint32_t index = 0; index < type_descriptor_count; ++index) {
    TypeDescriptor descriptor;
    descriptor.schema_name = reader.readString();
    descriptor.file_identifier = reader.readString();
    descriptor.schema_hash_hex = reader.readString();
    descriptor.accepts_any_flatbuffer = reader.readBool();
    request.type_descriptors.push_back(std::move(descriptor));
  }

  const std::uint32_t accepted_type_index_count = reader.readU32();
  request.accepted_type_indices.reserve(accepted_type_index_count);
  for (std::uint32_t index = 0; index < accepted_type_index_count; ++index) {
    request.accepted_type_indices.push_back(reader.readU32());
  }

  const std::uint32_t trigger_count = reader.readU32();
  request.triggers.reserve(trigger_count);
  for (std::uint32_t index = 0; index < trigger_count; ++index) {
    TriggerDescriptor descriptor;
    descriptor.trigger_id = reader.readString();
    descriptor.kind = reader.readString();
    descriptor.source = reader.readString();
    descriptor.protocol_id = reader.readString();
    descriptor.default_interval_ms = reader.readU32();
    descriptor.accepted_type_index_offset = reader.readU32();
    descriptor.accepted_type_index_count = reader.readU32();
    descriptor.description = reader.readString();
    request.triggers.push_back(std::move(descriptor));
  }

  const std::uint32_t node_count = reader.readU32();
  request.nodes.reserve(node_count);
  for (std::uint32_t index = 0; index < node_count; ++index) {
    NodeDescriptor descriptor;
    descriptor.node_id = reader.readString();
    descriptor.plugin_id = reader.readString();
    descriptor.method_id = reader.readString();
    descriptor.dependency_id = reader.readString();
    descriptor.dependency_index = reader.readU32();
    descriptor.linked_method_symbol = reader.readString();
    descriptor.kind = reader.readString();
    descriptor.drain_policy = reader.readString();
    descriptor.time_slice_micros = reader.readU32();
    descriptor.ingress_index_offset = reader.readU32();
    descriptor.ingress_index_count = reader.readU32();
    request.nodes.push_back(std::move(descriptor));
  }

  const std::uint32_t edge_count = reader.readU32();
  request.edges.reserve(edge_count);
  for (std::uint32_t index = 0; index < edge_count; ++index) {
    EdgeDescriptor descriptor;
    descriptor.edge_id = reader.readString();
    descriptor.from_node_id = reader.readString();
    descriptor.from_node_index = reader.readU32();
    descriptor.from_port_id = reader.readString();
    descriptor.to_node_id = reader.readString();
    descriptor.to_node_index = reader.readU32();
    descriptor.to_port_id = reader.readString();
    descriptor.backpressure_policy = reader.readString();
    descriptor.queue_depth = reader.readU32();
    descriptor.accepted_type_index_offset = reader.readU32();
    descriptor.accepted_type_index_count = reader.readU32();
    descriptor.target_ingress_index = reader.readU32();
    request.edges.push_back(std::move(descriptor));
  }

  const std::uint32_t trigger_binding_count = reader.readU32();
  request.trigger_bindings.reserve(trigger_binding_count);
  for (std::uint32_t index = 0; index < trigger_binding_count; ++index) {
    TriggerBindingDescriptor descriptor;
    descriptor.trigger_id = reader.readString();
    descriptor.trigger_index = reader.readU32();
    descriptor.target_node_id = reader.readString();
    descriptor.target_node_index = reader.readU32();
    descriptor.target_port_id = reader.readString();
    descriptor.backpressure_policy = reader.readString();
    descriptor.queue_depth = reader.readU32();
    descriptor.target_ingress_index = reader.readU32();
    request.trigger_bindings.push_back(std::move(descriptor));
  }

  const std::uint32_t ingress_count = reader.readU32();
  request.ingress_descriptors.reserve(ingress_count);
  for (std::uint32_t index = 0; index < ingress_count; ++index) {
    IngressDescriptor descriptor;
    descriptor.ingress_id = reader.readString();
    descriptor.source_kind = reader.readString();
    descriptor.source_index = reader.readU32();
    descriptor.source_node_index = reader.readU32();
    descriptor.source_port_id = reader.readString();
    descriptor.target_node_index = reader.readU32();
    descriptor.target_node_id = reader.readString();
    descriptor.target_port_id = reader.readString();
    descriptor.backpressure_policy = reader.readString();
    descriptor.queue_depth = reader.readU32();
    request.ingress_descriptors.push_back(std::move(descriptor));
  }

  const std::uint32_t external_interface_count = reader.readU32();
  request.external_interfaces.reserve(external_interface_count);
  for (std::uint32_t index = 0; index < external_interface_count; ++index) {
    ExternalInterfaceDescriptor descriptor;
    descriptor.interface_id = reader.readString();
    descriptor.kind = reader.readString();
    descriptor.direction = reader.readString();
    descriptor.capability = reader.readString();
    descriptor.resource = reader.readString();
    descriptor.protocol_id = reader.readString();
    descriptor.topic = reader.readString();
    descriptor.path = reader.readString();
    descriptor.required = reader.readBool();
    descriptor.accepted_type_index_offset = reader.readU32();
    descriptor.accepted_type_index_count = reader.readU32();
    descriptor.description = reader.readString();
    request.external_interfaces.push_back(std::move(descriptor));
  }

  const std::uint32_t dependency_count = reader.readU32();
  request.dependencies.reserve(dependency_count);
  for (std::uint32_t index = 0; index < dependency_count; ++index) {
    SignedArtifactDependency dependency;
    dependency.dependency_id = reader.readString();
    dependency.plugin_id = reader.readString();
    dependency.version = reader.readString();
    dependency.sha256 = reader.readString();
    dependency.signature = reader.readString();
    dependency.signer_public_key = reader.readString();
    dependency.entrypoint = reader.readString();
    dependency.manifest_bytes_symbol = reader.readString();
    dependency.manifest_size_symbol = reader.readString();
    dependency.init_symbol = reader.readString();
    dependency.destroy_symbol = reader.readString();
    dependency.malloc_symbol = reader.readString();
    dependency.free_symbol = reader.readString();
    dependency.stream_invoke_symbol = reader.readString();
    dependency.wasm_bytes = reader.readBytes();
    dependency.manifest_bytes = reader.readBytes();
    request.dependencies.push_back(std::move(dependency));
  }

  const std::uint32_t node_ingress_index_count = reader.readU32();
  request.node_ingress_indices.reserve(node_ingress_index_count);
  for (std::uint32_t index = 0; index < node_ingress_index_count; ++index) {
    request.node_ingress_indices.push_back(reader.readU32());
  }
  request.editor_metadata_json = reader.readString();

  if (reader.hasRemaining()) {
    throw std::runtime_error("unexpected trailing bytes in generator request");
  }

  if (request.manifest_buffer.empty()) {
    throw std::runtime_error("flow generator request requires manifest bytes");
  }

  return request;
}

std::string generateSource(const Request& request) {
  std::vector<std::string> type_descriptor_records;
  type_descriptor_records.reserve(request.type_descriptors.size());
  for (const auto& descriptor : request.type_descriptors) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(descriptor.schema_name) << ",\n"
           << "    " << cppStringLiteral(descriptor.file_identifier) << ",\n"
           << "    " << cppStringLiteral(descriptor.schema_hash_hex) << ",\n"
           << "    " << cppBoolLiteral(descriptor.accepts_any_flatbuffer)
           << "\n"
           << "  }";
    type_descriptor_records.push_back(record.str());
  }

  std::vector<std::string> trigger_records;
  trigger_records.reserve(request.triggers.size());
  for (const auto& trigger : request.triggers) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(trigger.trigger_id) << ",\n"
           << "    " << cppStringLiteral(trigger.kind) << ",\n"
           << "    " << cppStringLiteral(trigger.source) << ",\n"
           << "    " << cppStringLiteral(trigger.protocol_id) << ",\n"
           << "    " << formatUnsigned(trigger.default_interval_ms) << ",\n"
           << "    " << formatUnsigned(trigger.accepted_type_index_offset)
           << ",\n"
           << "    " << formatUnsigned(trigger.accepted_type_index_count)
           << ",\n"
           << "    " << cppStringLiteral(trigger.description) << "\n"
           << "  }";
    trigger_records.push_back(record.str());
  }

  std::vector<std::string> node_records;
  node_records.reserve(request.nodes.size());
  for (const auto& node : request.nodes) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(node.node_id) << ",\n"
           << "    " << cppStringLiteral(node.plugin_id) << ",\n"
           << "    " << cppStringLiteral(node.method_id) << ",\n"
           << "    " << cppStringLiteral(node.kind) << ",\n"
           << "    " << cppStringLiteral(node.drain_policy) << ",\n"
           << "    " << formatUnsigned(node.time_slice_micros) << ",\n"
           << "    " << formatUnsigned(node.ingress_index_offset) << ",\n"
           << "    " << formatUnsigned(node.ingress_index_count) << "\n"
           << "  }";
    node_records.push_back(record.str());
  }

  std::vector<std::string> linked_method_declarations;
  std::vector<std::string> linked_method_symbols;
  std::vector<std::string> linked_node_records;
  std::vector<std::string> node_dispatch_records;
  bool has_linked_direct_nodes = false;
  linked_node_records.reserve(request.nodes.size());
  node_dispatch_records.reserve(request.nodes.size());
  for (std::size_t node_index = 0; node_index < request.nodes.size(); ++node_index) {
    const auto& node = request.nodes[node_index];
    std::uint32_t dependency_index = node.dependency_index;
    const SignedArtifactDependency* dependency = nullptr;
    if (dependency_index != kInvalidIndex &&
        dependency_index < request.dependencies.size()) {
      dependency = &request.dependencies[dependency_index];
    }
    if (dependency == nullptr) {
      for (std::size_t candidate_index = 0; candidate_index < request.dependencies.size();
           ++candidate_index) {
        if (request.dependencies[candidate_index].plugin_id == node.plugin_id) {
          dependency_index = static_cast<std::uint32_t>(candidate_index);
          dependency = &request.dependencies[candidate_index];
          break;
        }
      }
    }

    const std::string dependency_id =
        !node.dependency_id.empty()
            ? node.dependency_id
            : (dependency != nullptr ? dependency->dependency_id : "");
    const bool linked_direct = !node.linked_method_symbol.empty();
    if (linked_direct) {
      bool seen = false;
      for (const auto& symbol : linked_method_symbols) {
        if (symbol == node.linked_method_symbol) {
          seen = true;
          break;
        }
      }
      if (!seen) {
        linked_method_symbols.push_back(node.linked_method_symbol);
        linked_method_declarations.push_back(
            "extern \"C\" int " + node.linked_method_symbol + "(void);");
      }
    }
    const std::string dispatch_model =
        linked_direct
            ? "linked-direct"
            : (dependency == nullptr
            ? "unresolved"
            : (!dependency->stream_invoke_symbol.empty() ? "stream-invoke"
                                                        : "unresolved"));
    has_linked_direct_nodes = has_linked_direct_nodes || linked_direct;

    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(node.node_id) << ",\n"
           << "    " << formatUnsigned(static_cast<std::uint32_t>(node_index))
           << ",\n"
           << "    " << cppStringLiteral(dependency_id) << ",\n"
           << "    " << formatIndex(dependency_index) << ",\n"
           << "    " << cppStringLiteral(node.plugin_id) << ",\n"
           << "    " << cppStringLiteral(node.method_id) << ",\n"
           << "    " << cppStringLiteral(dispatch_model) << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr ? dependency->entrypoint : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr
                                   ? dependency->manifest_bytes_symbol
                                   : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr
                                   ? dependency->manifest_size_symbol
                                   : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr ? dependency->init_symbol
                                                     : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr
                                   ? dependency->destroy_symbol
                                   : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr ? dependency->malloc_symbol
                                                     : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr ? dependency->free_symbol
                                                     : "")
           << ",\n"
           << "    "
           << cppStringLiteral(dependency != nullptr
                                   ? dependency->stream_invoke_symbol
                                   : "")
           << "\n"
           << "  }";
    node_dispatch_records.push_back(record.str());
    linked_node_records.push_back(
        std::string("  { ") +
        (linked_direct ? "&" + node.linked_method_symbol : "nullptr") + ", " +
        cppStringLiteral(node.linked_method_symbol) + " }");
  }

  std::vector<std::string> edge_records;
  edge_records.reserve(request.edges.size());
  for (const auto& edge : request.edges) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(edge.edge_id) << ",\n"
           << "    " << cppStringLiteral(edge.from_node_id) << ",\n"
           << "    " << formatIndex(edge.from_node_index) << ",\n"
           << "    " << cppStringLiteral(edge.from_port_id) << ",\n"
           << "    " << cppStringLiteral(edge.to_node_id) << ",\n"
           << "    " << formatIndex(edge.to_node_index) << ",\n"
           << "    " << cppStringLiteral(edge.to_port_id) << ",\n"
           << "    " << cppStringLiteral(edge.backpressure_policy) << ",\n"
           << "    " << formatUnsigned(edge.queue_depth) << ",\n"
           << "    " << formatUnsigned(edge.accepted_type_index_offset)
           << ",\n"
           << "    " << formatUnsigned(edge.accepted_type_index_count)
           << ",\n"
           << "    " << formatIndex(edge.target_ingress_index) << "\n"
           << "  }";
    edge_records.push_back(record.str());
  }

  std::vector<std::string> trigger_binding_records;
  trigger_binding_records.reserve(request.trigger_bindings.size());
  for (const auto& binding : request.trigger_bindings) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(binding.trigger_id) << ",\n"
           << "    " << formatIndex(binding.trigger_index) << ",\n"
           << "    " << cppStringLiteral(binding.target_node_id) << ",\n"
           << "    " << formatIndex(binding.target_node_index) << ",\n"
           << "    " << cppStringLiteral(binding.target_port_id) << ",\n"
           << "    " << cppStringLiteral(binding.backpressure_policy) << ",\n"
           << "    " << formatUnsigned(binding.queue_depth) << ",\n"
           << "    " << formatIndex(binding.target_ingress_index) << "\n"
           << "  }";
    trigger_binding_records.push_back(record.str());
  }

  std::vector<std::string> ingress_records;
  ingress_records.reserve(request.ingress_descriptors.size());
  for (const auto& ingress : request.ingress_descriptors) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(ingress.ingress_id) << ",\n"
           << "    " << cppStringLiteral(ingress.source_kind) << ",\n"
           << "    " << formatIndex(ingress.source_index) << ",\n"
           << "    " << formatIndex(ingress.source_node_index) << ",\n"
           << "    " << cppStringLiteral(ingress.source_port_id) << ",\n"
           << "    " << formatIndex(ingress.target_node_index) << ",\n"
           << "    " << cppStringLiteral(ingress.target_node_id) << ",\n"
           << "    " << cppStringLiteral(ingress.target_port_id) << ",\n"
           << "    " << cppStringLiteral(ingress.backpressure_policy) << ",\n"
           << "    " << formatUnsigned(ingress.queue_depth) << "\n"
           << "  }";
    ingress_records.push_back(record.str());
  }

  std::vector<std::string> external_interface_records;
  external_interface_records.reserve(request.external_interfaces.size());
  for (const auto& external_interface : request.external_interfaces) {
    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(external_interface.interface_id)
           << ",\n"
           << "    " << cppStringLiteral(external_interface.kind) << ",\n"
           << "    " << cppStringLiteral(external_interface.direction)
           << ",\n"
           << "    " << cppStringLiteral(external_interface.capability)
           << ",\n"
           << "    " << cppStringLiteral(external_interface.resource) << ",\n"
           << "    " << cppStringLiteral(external_interface.protocol_id)
           << ",\n"
           << "    " << cppStringLiteral(external_interface.topic) << ",\n"
           << "    " << cppStringLiteral(external_interface.path) << ",\n"
           << "    " << cppBoolLiteral(external_interface.required) << ",\n"
           << "    " << formatUnsigned(external_interface.accepted_type_index_offset)
           << ",\n"
           << "    " << formatUnsigned(external_interface.accepted_type_index_count)
           << ",\n"
           << "    " << cppStringLiteral(external_interface.description) << "\n"
           << "  }";
    external_interface_records.push_back(record.str());
  }

  std::vector<std::string> dependency_blocks;
  std::vector<std::string> dependency_records;
  dependency_blocks.reserve(request.dependencies.size() * 2);
  dependency_records.reserve(request.dependencies.size());
  for (std::size_t index = 0; index < request.dependencies.size(); ++index) {
    const auto& dependency = request.dependencies[index];
    const std::string dependency_name = sanitizeIdentifier(
        !dependency.dependency_id.empty()
            ? dependency.dependency_id
            : (!dependency.plugin_id.empty()
                   ? dependency.plugin_id
                   : std::string("dependency_") + std::to_string(index)),
        std::string("dependency_") + std::to_string(index));
    const std::string wasm_symbol = "k" + dependency_name + "Wasm";
    const std::string manifest_symbol = "k" + dependency_name + "Manifest";
    dependency_blocks.push_back(renderByteArray(wasm_symbol, dependency.wasm_bytes));
    if (!dependency.manifest_bytes.empty()) {
      dependency_blocks.push_back(
          renderByteArray(manifest_symbol, dependency.manifest_bytes));
    }

    std::ostringstream record;
    record << "  {\n"
           << "    " << cppStringLiteral(dependency.dependency_id) << ",\n"
           << "    " << cppStringLiteral(dependency.plugin_id) << ",\n"
           << "    " << cppStringLiteral(dependency.version) << ",\n"
           << "    " << cppStringLiteral(dependency.sha256) << ",\n"
           << "    " << cppStringLiteral(dependency.signature) << ",\n"
           << "    " << cppStringLiteral(dependency.signer_public_key) << ",\n"
           << "    " << cppStringLiteral(dependency.entrypoint) << ",\n"
           << "    " << cppStringLiteral(dependency.manifest_bytes_symbol)
           << ",\n"
           << "    " << cppStringLiteral(dependency.manifest_size_symbol)
           << ",\n"
           << "    " << cppStringLiteral(dependency.init_symbol) << ",\n"
           << "    " << cppStringLiteral(dependency.destroy_symbol) << ",\n"
           << "    " << cppStringLiteral(dependency.malloc_symbol) << ",\n"
           << "    " << cppStringLiteral(dependency.free_symbol) << ",\n"
           << "    "
           << cppStringLiteral(dependency.stream_invoke_symbol) << ",\n"
           << "    " << wasm_symbol << ",\n"
           << "    sizeof(" << wasm_symbol << "),\n"
           << "    "
           << (!dependency.manifest_bytes.empty() ? manifest_symbol : "nullptr")
           << ",\n"
           << "    "
           << (!dependency.manifest_bytes.empty()
                   ? "sizeof(" + manifest_symbol + ")"
                   : "0")
           << "\n"
           << "  }";
    dependency_records.push_back(record.str());
  }

  const std::string namespace_name =
      request.namespace_name.empty() ? "sdn_flow_generated"
                                     : request.namespace_name;

  std::ostringstream out;
  out << "// generated by the native sdn-flow C++ source generator\n";
  out << "#include <algorithm>\n";
  out << "#include <cstddef>\n";
  out << "#include <cstdint>\n\n";
  out << "#include <cstdlib>\n";
  out << "#include <cstring>\n";
  out << "#include <string>\n";
  out << "#include <utility>\n";
  out << "#include <vector>\n\n";
  out << "extern \"C\" {\n";
  out << "enum plugin_payload_wire_format_t {\n"
      << "  PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER = 0,\n"
      << "  PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY = 1,\n"
      << "};\n\n";
  out << "typedef struct plugin_input_frame_t {\n"
      << "  const char *port_id;\n"
      << "  const char *schema_name;\n"
      << "  const char *file_identifier;\n"
      << "  std::uint32_t wire_format;\n"
      << "  const char *root_type_name;\n"
      << "  std::uint16_t fixed_string_length;\n"
      << "  std::uint32_t byte_length;\n"
      << "  std::uint16_t required_alignment;\n"
      << "  std::uint16_t alignment;\n"
      << "  std::uint32_t size;\n"
      << "  std::uint32_t generation;\n"
      << "  std::uint64_t trace_id;\n"
      << "  std::uint32_t stream_id;\n"
      << "  std::uint64_t sequence;\n"
      << "  std::int32_t end_of_stream;\n"
      << "  const std::uint8_t *payload;\n"
      << "  std::uint32_t payload_length;\n"
      << "} plugin_input_frame_t;\n"
      << "}  // extern \"C\"\n\n";
  out << "static constexpr std::uint32_t kPluginPayloadWireFormatFlatbuffer =\n"
      << "  static_cast<std::uint32_t>(PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER);\n";
  out << "static constexpr std::uint32_t kPluginPayloadWireFormatAlignedBinary =\n"
      << "  static_cast<std::uint32_t>(PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY);\n\n";
  for (const auto& declaration : linked_method_declarations) {
    out << declaration << '\n';
  }
  if (!linked_method_declarations.empty()) {
    out << '\n';
  }
  out << "namespace " << namespace_name << " {\n\n";
  out << "static constexpr std::uint32_t kInvalidIndex = 0xffffffffu;\n\n";
  out << "struct SignedArtifactDependency {\n"
      << "  const char * dependency_id;\n"
      << "  const char * plugin_id;\n"
      << "  const char * version;\n"
      << "  const char * sha256;\n"
      << "  const char * signature;\n"
      << "  const char * signer_public_key;\n"
      << "  const char * entrypoint;\n"
      << "  const char * manifest_bytes_symbol;\n"
      << "  const char * manifest_size_symbol;\n"
      << "  const char * init_symbol;\n"
      << "  const char * destroy_symbol;\n"
      << "  const char * malloc_symbol;\n"
      << "  const char * free_symbol;\n"
      << "  const char * stream_invoke_symbol;\n"
      << "  const std::uint8_t * wasm_bytes;\n"
      << "  std::size_t wasm_size;\n"
      << "  const std::uint8_t * manifest_bytes;\n"
      << "  std::size_t manifest_size;\n"
      << "};\n\n";
  out << "struct FlowTypeDescriptor {\n"
      << "  const char * schema_name;\n"
      << "  const char * file_identifier;\n"
      << "  const char * schema_hash_hex;\n"
      << "  bool accepts_any_flatbuffer;\n"
      << "};\n\n";
  out << "struct FlowTriggerDescriptor {\n"
      << "  const char * trigger_id;\n"
      << "  const char * kind;\n"
      << "  const char * source;\n"
      << "  const char * protocol_id;\n"
      << "  std::uint32_t default_interval_ms;\n"
      << "  std::uint32_t accepted_type_index_offset;\n"
      << "  std::uint32_t accepted_type_index_count;\n"
      << "  const char * description;\n"
      << "};\n\n";
  out << "struct FlowNodeDescriptor {\n"
      << "  const char * node_id;\n"
      << "  const char * plugin_id;\n"
      << "  const char * method_id;\n"
      << "  const char * kind;\n"
      << "  const char * drain_policy;\n"
      << "  std::uint32_t time_slice_micros;\n"
      << "  std::uint32_t ingress_index_offset;\n"
      << "  std::uint32_t ingress_index_count;\n"
      << "};\n\n";
  out << "struct FlowNodeDispatchDescriptor {\n"
      << "  const char * node_id;\n"
      << "  std::uint32_t node_index;\n"
      << "  const char * dependency_id;\n"
      << "  std::uint32_t dependency_index;\n"
      << "  const char * plugin_id;\n"
      << "  const char * method_id;\n"
      << "  const char * dispatch_model;\n"
      << "  const char * entrypoint;\n"
      << "  const char * manifest_bytes_symbol;\n"
      << "  const char * manifest_size_symbol;\n"
      << "  const char * init_symbol;\n"
      << "  const char * destroy_symbol;\n"
      << "  const char * malloc_symbol;\n"
      << "  const char * free_symbol;\n"
      << "  const char * stream_invoke_symbol;\n"
      << "};\n\n";
  out << "struct FlowEdgeDescriptor {\n"
      << "  const char * edge_id;\n"
      << "  const char * from_node_id;\n"
      << "  std::uint32_t from_node_index;\n"
      << "  const char * from_port_id;\n"
      << "  const char * to_node_id;\n"
      << "  std::uint32_t to_node_index;\n"
      << "  const char * to_port_id;\n"
      << "  const char * backpressure_policy;\n"
      << "  std::uint32_t queue_depth;\n"
      << "  std::uint32_t accepted_type_index_offset;\n"
      << "  std::uint32_t accepted_type_index_count;\n"
      << "  std::uint32_t target_ingress_index;\n"
      << "};\n\n";
  out << "struct FlowTriggerBindingDescriptor {\n"
      << "  const char * trigger_id;\n"
      << "  std::uint32_t trigger_index;\n"
      << "  const char * target_node_id;\n"
      << "  std::uint32_t target_node_index;\n"
      << "  const char * target_port_id;\n"
      << "  const char * backpressure_policy;\n"
      << "  std::uint32_t queue_depth;\n"
      << "  std::uint32_t target_ingress_index;\n"
      << "};\n\n";
  out << "struct FlowIngressDescriptor {\n"
      << "  const char * ingress_id;\n"
      << "  const char * source_kind;\n"
      << "  std::uint32_t source_index;\n"
      << "  std::uint32_t source_node_index;\n"
      << "  const char * source_port_id;\n"
      << "  std::uint32_t target_node_index;\n"
      << "  const char * target_node_id;\n"
      << "  const char * target_port_id;\n"
      << "  const char * backpressure_policy;\n"
      << "  std::uint32_t queue_depth;\n"
      << "};\n\n";
  out << "struct FlowExternalInterfaceDescriptor {\n"
      << "  const char * interface_id;\n"
      << "  const char * kind;\n"
      << "  const char * direction;\n"
      << "  const char * capability;\n"
      << "  const char * resource;\n"
      << "  const char * protocol_id;\n"
      << "  const char * topic;\n"
      << "  const char * path;\n"
      << "  bool required;\n"
      << "  std::uint32_t accepted_type_index_offset;\n"
      << "  std::uint32_t accepted_type_index_count;\n"
      << "  const char * description;\n"
      << "};\n\n";
  out << "struct FlowFrameDescriptor {\n"
      << "  std::uint32_t ingress_index;\n"
      << "  std::uint32_t type_descriptor_index;\n"
      << "  const char * port_id;\n"
      << "  std::uint32_t alignment;\n"
      << "  std::uint32_t offset;\n"
      << "  std::uint32_t size;\n"
      << "  std::uint32_t stream_id;\n"
      << "  std::uint32_t sequence;\n"
      << "  std::uint64_t trace_token;\n"
      << "  bool end_of_stream;\n"
      << "  bool occupied;\n"
      << "};\n\n";
  out << "static_assert(sizeof(FlowFrameDescriptor) == 48u,\n"
      << "              \"FlowFrameDescriptor must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(alignof(FlowFrameDescriptor) == 8u,\n"
      << "              \"FlowFrameDescriptor alignment must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, ingress_index) == 0u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, type_descriptor_index) == 4u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, port_id) == 8u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, alignment) == 12u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, offset) == 16u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, size) == 20u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, stream_id) == 24u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, sequence) == 28u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, trace_token) == 32u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, end_of_stream) == 40u);\n";
  out << "static_assert(offsetof(FlowFrameDescriptor, occupied) == 41u);\n\n";
  out << "struct FlowInvocationDescriptor {\n"
      << "  std::uint32_t node_index;\n"
      << "  std::uint32_t dispatch_descriptor_index;\n"
      << "  const char * plugin_id;\n"
      << "  const char * method_id;\n"
      << "  const FlowFrameDescriptor * frames;\n"
      << "  std::uint32_t frame_count;\n"
      << "};\n\n";
  out << "static_assert(sizeof(FlowInvocationDescriptor) == 24u,\n"
      << "              \"FlowInvocationDescriptor must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(alignof(FlowInvocationDescriptor) == 4u,\n"
      << "              \"FlowInvocationDescriptor alignment must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, node_index) == 0u);\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, dispatch_descriptor_index) == 4u);\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, plugin_id) == 8u);\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, method_id) == 12u);\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, frames) == 16u);\n";
  out << "static_assert(offsetof(FlowInvocationDescriptor, frame_count) == 20u);\n\n";
  out << "static_assert(sizeof(FlowNodeDispatchDescriptor) == 60u,\n"
      << "              \"FlowNodeDispatchDescriptor must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(alignof(FlowNodeDispatchDescriptor) == 4u,\n"
      << "              \"FlowNodeDispatchDescriptor alignment must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, node_id) == 0u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, node_index) == 4u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, dependency_id) == 8u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, dependency_index) == 12u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, plugin_id) == 16u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, method_id) == 20u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, dispatch_model) == 24u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, entrypoint) == 28u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, manifest_bytes_symbol) == 32u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, manifest_size_symbol) == 36u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, init_symbol) == 40u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, destroy_symbol) == 44u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, malloc_symbol) == 48u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, free_symbol) == 52u);\n";
  out << "static_assert(offsetof(FlowNodeDispatchDescriptor, stream_invoke_symbol) == 56u);\n\n";
  out << "static_assert(sizeof(SignedArtifactDependency) == 72u,\n"
      << "              \"SignedArtifactDependency must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(alignof(SignedArtifactDependency) == 4u,\n"
      << "              \"SignedArtifactDependency alignment must match schemas/FlowRuntimeAbi.fbs\");\n";
  out << "static_assert(offsetof(SignedArtifactDependency, dependency_id) == 0u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, plugin_id) == 4u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, version) == 8u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, sha256) == 12u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, signature) == 16u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, signer_public_key) == 20u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, entrypoint) == 24u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, manifest_bytes_symbol) == 28u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, manifest_size_symbol) == 32u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, init_symbol) == 36u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, destroy_symbol) == 40u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, malloc_symbol) == 44u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, free_symbol) == 48u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, stream_invoke_symbol) == 52u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, wasm_bytes) == 56u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, wasm_size) == 60u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, manifest_bytes) == 64u);\n";
  out << "static_assert(offsetof(SignedArtifactDependency, manifest_size) == 68u);\n\n";
  out << "struct FlowIngressRuntimeState {\n"
      << "  std::uint64_t total_received;\n"
      << "  std::uint64_t total_dropped;\n"
      << "  std::uint32_t queued_frames;\n"
      << "};\n\n";
  out << "struct FlowNodeRuntimeState {\n"
      << "  std::uint64_t invocation_count;\n"
      << "  std::uint64_t consumed_frames;\n"
      << "  std::uint32_t queued_frames;\n"
      << "  std::uint32_t backlog_remaining;\n"
      << "  std::uint32_t last_status;\n"
      << "  bool ready;\n"
      << "  bool yielded;\n"
      << "};\n\n";
  out << "struct FlowRuntimeDescriptor {\n"
      << "  const char * program_id;\n"
      << "  const char * program_name;\n"
      << "  const char * program_version;\n"
      << "  const char * program_description;\n"
      << "  const char * execution_model;\n"
      << "  const char * entrypoint;\n"
      << "  const char * manifest_bytes_symbol;\n"
      << "  const char * manifest_size_symbol;\n"
      << "  const char * const * required_plugins;\n"
      << "  std::size_t required_plugin_count;\n"
      << "  const FlowTypeDescriptor * type_descriptors;\n"
      << "  std::size_t type_descriptor_count;\n"
      << "  const std::uint32_t * accepted_type_indices;\n"
      << "  std::size_t accepted_type_index_count;\n"
      << "  const FlowTriggerDescriptor * triggers;\n"
      << "  std::size_t trigger_count;\n"
      << "  const FlowNodeDescriptor * nodes;\n"
      << "  std::size_t node_count;\n"
      << "  const FlowNodeDispatchDescriptor * node_dispatch_descriptors;\n"
      << "  std::size_t node_dispatch_descriptor_count;\n"
      << "  const FlowEdgeDescriptor * edges;\n"
      << "  std::size_t edge_count;\n"
      << "  const FlowTriggerBindingDescriptor * trigger_bindings;\n"
      << "  std::size_t trigger_binding_count;\n"
      << "  const FlowIngressDescriptor * ingress_descriptors;\n"
      << "  std::size_t ingress_count;\n"
      << "  const std::uint32_t * node_ingress_indices;\n"
      << "  std::size_t node_ingress_index_count;\n"
      << "  const FlowExternalInterfaceDescriptor * external_interfaces;\n"
      << "  std::size_t external_interface_count;\n"
      << "  const SignedArtifactDependency * dependencies;\n"
      << "  std::size_t dependency_count;\n"
      << "  FlowFrameDescriptor * ingress_frame_descriptors;\n"
      << "  std::size_t ingress_frame_descriptor_count;\n"
      << "  FlowInvocationDescriptor * current_invocation_descriptor;\n"
      << "  FlowIngressRuntimeState * ingress_runtime_states;\n"
      << "  std::size_t ingress_runtime_state_count;\n"
      << "  FlowNodeRuntimeState * node_runtime_states;\n"
      << "  std::size_t node_runtime_state_count;\n"
      << "};\n\n";
  out << "typedef int (*FlowLinkedNodeHandler)(void);\n\n";
  out << "struct FlowLinkedNodeHandlerDescriptor {\n"
      << "  FlowLinkedNodeHandler handler;\n"
      << "  const char * symbol_name;\n"
      << "};\n\n";
  out << "struct DirectInputFrameOwned {\n"
      << "  plugin_input_frame_t view;\n"
      << "  std::string schema_name;\n"
      << "  std::string file_identifier;\n"
      << "  std::string root_type_name;\n"
      << "};\n\n";
  out << "struct DirectOutputFrameOwned {\n"
      << "  std::string port_id;\n"
      << "  std::string schema_name;\n"
      << "  std::string file_identifier;\n"
      << "  std::string root_type_name;\n"
      << "  std::vector<std::uint8_t> payload;\n"
      << "  std::uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;\n"
      << "  std::uint16_t fixed_string_length = 0;\n"
      << "  std::uint32_t byte_length = 0;\n"
      << "  std::uint16_t required_alignment = 0;\n"
      << "  std::uint16_t alignment = 8;\n"
      << "  std::uint32_t stream_id = 0;\n"
      << "  std::uint64_t sequence = 0;\n"
      << "  std::uint64_t trace_token = 0;\n"
      << "  bool end_of_stream = false;\n"
      << "};\n\n";
  out << "static std::uint32_t min_u32(std::uint32_t left, std::uint32_t right) {\n"
      << "  return left < right ? left : right;\n"
      << "}\n\n";
  out << "static bool string_equals(const char * left, const char * right) {\n"
      << "  if (left == right) {\n"
      << "    return true;\n"
      << "  }\n"
      << "  if (left == nullptr || right == nullptr) {\n"
      << "    return false;\n"
      << "  }\n"
      << "  while (*left != '\\0' && *right != '\\0') {\n"
      << "    if (*left != *right) {\n"
      << "      return false;\n"
      << "    }\n"
      << "    ++left;\n"
      << "    ++right;\n"
      << "  }\n"
      << "  return *left == *right;\n"
      << "}\n\n";
  out << "static void clear_frame_descriptor(FlowFrameDescriptor & descriptor) {\n"
      << "  descriptor.ingress_index = kInvalidIndex;\n"
      << "  descriptor.type_descriptor_index = kInvalidIndex;\n"
      << "  descriptor.port_id = nullptr;\n"
      << "  descriptor.alignment = 0;\n"
      << "  descriptor.offset = 0;\n"
      << "  descriptor.size = 0;\n"
      << "  descriptor.stream_id = 0;\n"
      << "  descriptor.sequence = 0;\n"
      << "  descriptor.trace_token = 0;\n"
      << "  descriptor.end_of_stream = false;\n"
      << "  descriptor.occupied = false;\n"
      << "}\n\n";
  out << renderByteArray("kFlowManifest", request.manifest_buffer) << "\n\n";
  out << renderStringPointerArray("kRequiredPlugins", request.required_plugins)
      << "\n\n";
  out << renderRecordArray("FlowTypeDescriptor", "kTypeDescriptors",
                           type_descriptor_records)
      << "\n\n";
  out << renderIntegerArray("std::uint32_t", "kAcceptedTypeIndices",
                            request.accepted_type_indices)
      << "\n\n";
  out << renderRecordArray("FlowTriggerDescriptor", "kTriggerDescriptors",
                           trigger_records)
      << "\n\n";
  out << renderRecordArray("FlowNodeDescriptor", "kNodeDescriptors", node_records)
      << "\n\n";
  out << renderRecordArray("FlowNodeDispatchDescriptor",
                           "kNodeDispatchDescriptors",
                           node_dispatch_records)
      << "\n\n";
  out << renderRecordArray("FlowLinkedNodeHandlerDescriptor",
                           "kLinkedNodeHandlers",
                           linked_node_records,
                           "{ nullptr, nullptr }")
      << "\n\n";
  out << renderRecordArray("FlowEdgeDescriptor", "kEdgeDescriptors", edge_records)
      << "\n\n";
  out << renderRecordArray("FlowTriggerBindingDescriptor",
                           "kTriggerBindingDescriptors",
                           trigger_binding_records)
      << "\n\n";
  out << renderRecordArray("FlowIngressDescriptor", "kIngressDescriptors",
                           ingress_records)
      << "\n\n";
  out << renderIntegerArray("std::uint32_t", "kNodeIngressIndices",
                            request.node_ingress_indices)
      << "\n\n";
  out << renderRecordArray("FlowExternalInterfaceDescriptor",
                           "kExternalInterfaceDescriptors",
                           external_interface_records)
      << "\n\n";
  out << renderMutableRecordArray("FlowFrameDescriptor",
                                  "kIngressFrameDescriptors",
                                  request.ingress_descriptors.size())
      << "\n\n";
  out << renderMutableRecordArray("FlowFrameDescriptor",
                                  "kInvocationFrameBuffer",
                                  request.ingress_descriptors.size())
      << "\n\n";
  out << "static FlowInvocationDescriptor kCurrentInvocationDescriptor = {};\n\n";
  out << renderMutableRecordArray("FlowIngressRuntimeState",
                                  "kIngressRuntimeStates",
                                  request.ingress_descriptors.size())
      << "\n\n";
  out << renderMutableRecordArray("FlowNodeRuntimeState", "kNodeRuntimeStates",
                                  request.nodes.size())
      << "\n\n";
  out << "static std::uint32_t kRetainedIngressPayloadPointers["
      << (request.ingress_descriptors.empty() ? 1 : request.ingress_descriptors.size())
      << "] = {};\n\n";
  out << "static std::vector<DirectInputFrameOwned> kDirectInputFrames;\n";
  out << "static std::vector<DirectOutputFrameOwned> kDirectOutputFrames;\n";
  out << "static std::uint32_t kDirectBacklogRemaining = 0u;\n";
  out << "static bool kDirectYielded = false;\n";
  out << "static std::uint32_t kDirectOutputStreamCap = 16u;\n";
  out << "static std::string kDirectErrorCode;\n";
  out << "static std::string kDirectErrorMessage;\n\n";
  for (std::size_t index = 0; index < dependency_blocks.size(); ++index) {
    out << dependency_blocks[index];
    if (index + 1 < dependency_blocks.size()) {
      out << "\n\n";
    }
  }
  out << "\n\n";
  out << renderRecordArray("SignedArtifactDependency", "kDependencies",
                           dependency_records)
      << "\n\n";
  out << "static const char kProgramId[] = "
      << cppStringLiteral(request.program_id) << ";\n";
  out << "static const char kProgramName[] = "
      << cppStringLiteral(request.program_name) << ";\n";
  out << "static const char kProgramVersion[] = "
      << cppStringLiteral(request.program_version) << ";\n";
  out << "static const char kProgramDescription[] = "
      << cppStringLiteral(request.program_description) << ";\n";
  out << "static const char kEditorMetadataJson[] = "
      << cppStringLiteral(request.editor_metadata_json) << ";\n";
  out << "static const char kExecutionModel[] = \"compiled-cpp-wasm\";\n";
  out << "static const char kEntrypoint[] = \"main\";\n";
  out << "static const char kManifestBytesSymbol[] = "
      << "\"flow_get_manifest_flatbuffer\";\n";
  out << "static const char kManifestSizeSymbol[] = "
      << "\"flow_get_manifest_flatbuffer_size\";\n\n";
  out << "static void recompute_node_runtime_state(std::uint32_t node_index) {\n"
      << "  if (node_index >= " << request.nodes.size() << ") {\n"
      << "    return;\n"
      << "  }\n\n"
      << "  const FlowNodeDescriptor & node_descriptor = "
         "kNodeDescriptors[node_index];\n"
      << "  FlowNodeRuntimeState & node_state = kNodeRuntimeStates[node_index];\n"
      << "  std::uint32_t queued_frames = 0;\n"
      << "  for (\n"
      << "    std::uint32_t offset = 0;\n"
      << "    offset < node_descriptor.ingress_index_count;\n"
      << "    ++offset\n"
      << "  ) {\n"
      << "    const std::uint32_t ingress_index =\n"
      << "      kNodeIngressIndices[node_descriptor.ingress_index_offset + "
         "offset];\n"
      << "    queued_frames += kIngressRuntimeStates[ingress_index].queued_frames;\n"
      << "  }\n"
      << "  node_state.queued_frames = queued_frames;\n"
      << "  node_state.ready = queued_frames > 0 || "
         "node_state.backlog_remaining > 0;\n"
      << "}\n\n";
  out << "static void recompute_all_node_runtime_state() {\n"
      << "  for (std::uint32_t node_index = 0; node_index < "
      << request.nodes.size() << "; ++node_index) {\n"
      << "    recompute_node_runtime_state(node_index);\n"
      << "  }\n"
      << "}\n\n";
  out << "static void apply_backpressure(std::uint32_t ingress_index, "
         "std::uint32_t frame_count) {\n"
      << "  if (ingress_index >= " << request.ingress_descriptors.size()
      << ") {\n"
      << "    return;\n"
      << "  }\n\n"
      << "  FlowIngressRuntimeState & ingress_state = "
         "kIngressRuntimeStates[ingress_index];\n"
      << "  const FlowIngressDescriptor & ingress_descriptor = "
         "kIngressDescriptors[ingress_index];\n"
      << "  ingress_state.total_received += frame_count;\n\n"
      << "  const bool bounded = ingress_descriptor.queue_depth > 0;\n"
      << "  if (string_equals(ingress_descriptor.backpressure_policy, "
         "\"drop\")) {\n"
      << "    std::uint32_t accepted = frame_count;\n"
      << "    if (bounded) {\n"
      << "      const std::uint32_t available =\n"
      << "        ingress_descriptor.queue_depth > ingress_state.queued_frames\n"
      << "          ? ingress_descriptor.queue_depth - "
         "ingress_state.queued_frames\n"
      << "          : 0;\n"
      << "      accepted = min_u32(frame_count, available);\n"
      << "      ingress_state.total_dropped += frame_count - accepted;\n"
      << "    }\n"
      << "    ingress_state.queued_frames += accepted;\n"
      << "    return;\n"
      << "  }\n\n"
      << "  if (\n"
      << "    string_equals(ingress_descriptor.backpressure_policy, "
         "\"latest\") ||\n"
      << "    string_equals(ingress_descriptor.backpressure_policy, "
         "\"coalesce\")\n"
      << "  ) {\n"
      << "    if (!bounded) {\n"
      << "      ingress_state.queued_frames += frame_count;\n"
      << "      return;\n"
      << "    }\n"
      << "    if (frame_count == 0) {\n"
      << "      return;\n"
      << "    }\n"
      << "    if (ingress_state.queued_frames + frame_count > "
         "ingress_descriptor.queue_depth) {\n"
      << "      ingress_state.total_dropped +=\n"
      << "        static_cast<std::uint64_t>(ingress_state.queued_frames) +\n"
      << "        static_cast<std::uint64_t>(frame_count) -\n"
      << "        1u;\n"
      << "      ingress_state.queued_frames = 1u;\n"
      << "      return;\n"
      << "    }\n"
      << "    ingress_state.queued_frames += frame_count;\n"
      << "    return;\n"
      << "  }\n\n"
      << "  if (string_equals(ingress_descriptor.backpressure_policy, "
         "\"block-request\")) {\n"
      << "    if (\n"
      << "      bounded &&\n"
      << "      ingress_state.queued_frames + frame_count > "
         "ingress_descriptor.queue_depth\n"
      << "    ) {\n"
      << "      ingress_state.total_dropped += frame_count;\n"
      << "      return;\n"
      << "    }\n"
      << "    ingress_state.queued_frames += frame_count;\n"
      << "    return;\n"
      << "  }\n\n"
      << "  if (\n"
      << "    bounded &&\n"
      << "    ingress_state.queued_frames + frame_count > "
         "ingress_descriptor.queue_depth\n"
      << "  ) {\n"
      << "    ingress_state.total_dropped +=\n"
      << "      static_cast<std::uint64_t>(ingress_state.queued_frames) +\n"
      << "      static_cast<std::uint64_t>(frame_count) -\n"
      << "      static_cast<std::uint64_t>(ingress_descriptor.queue_depth);\n"
      << "    ingress_state.queued_frames = ingress_descriptor.queue_depth;\n"
      << "    return;\n"
      << "  }\n\n"
      << "  ingress_state.queued_frames += frame_count;\n"
      << "}\n\n";
  out << "static void release_retained_ingress_payload(std::uint32_t ingress_index) {\n"
      << "  if (ingress_index >= " << request.ingress_descriptors.size() << ") {\n"
      << "    return;\n"
      << "  }\n"
      << "  if (kRetainedIngressPayloadPointers[ingress_index] != 0u) {\n"
      << "    std::free(reinterpret_cast<void *>(\n"
      << "      static_cast<std::uintptr_t>(kRetainedIngressPayloadPointers[ingress_index])\n"
      << "    ));\n"
      << "    kRetainedIngressPayloadPointers[ingress_index] = 0u;\n"
      << "  }\n"
      << "}\n\n";
  out << "static void stage_ingress_frame(\n"
      << "  std::uint32_t ingress_index,\n"
      << "  const FlowFrameDescriptor * frame,\n"
      << "  std::uint32_t retained_payload_pointer = 0u\n"
      << ") {\n"
      << "  if (frame == nullptr || ingress_index >= "
      << request.ingress_descriptors.size() << ") {\n"
      << "    return;\n"
      << "  }\n"
      << "  release_retained_ingress_payload(ingress_index);\n"
      << "  kRetainedIngressPayloadPointers[ingress_index] = retained_payload_pointer;\n"
      << "  kIngressFrameDescriptors[ingress_index] = *frame;\n"
      << "  kIngressFrameDescriptors[ingress_index].ingress_index = ingress_index;\n"
      << "  kIngressFrameDescriptors[ingress_index].port_id =\n"
      << "    kIngressDescriptors[ingress_index].target_port_id;\n"
      << "  kIngressFrameDescriptors[ingress_index].occupied = true;\n"
      << "}\n\n";
  out << "static const FlowTypeDescriptor * resolve_type_descriptor(std::uint32_t type_descriptor_index) {\n"
      << "  if (type_descriptor_index >= " << request.type_descriptors.size() << ") {\n"
      << "    return nullptr;\n"
      << "  }\n"
      << "  return &kTypeDescriptors[type_descriptor_index];\n"
      << "}\n\n";
  out << "static std::uint32_t find_type_descriptor_index(\n"
      << "  const char * schema_name,\n"
      << "  const char * file_identifier\n"
      << ") {\n"
      << "  for (std::uint32_t index = 0; index < " << request.type_descriptors.size() << "; ++index) {\n"
      << "    const FlowTypeDescriptor & descriptor = kTypeDescriptors[index];\n"
      << "    const bool schema_matches =\n"
      << "      (schema_name == nullptr || schema_name[0] == '\\0')\n"
      << "        ? true\n"
      << "        : string_equals(descriptor.schema_name, schema_name);\n"
      << "    const bool file_identifier_matches =\n"
      << "      (file_identifier == nullptr || file_identifier[0] == '\\0')\n"
      << "        ? true\n"
      << "        : string_equals(descriptor.file_identifier, file_identifier);\n"
      << "    if (schema_matches && file_identifier_matches) {\n"
      << "      return index;\n"
      << "    }\n"
      << "  }\n"
      << "  return kInvalidIndex;\n"
      << "}\n\n";
  out << "static std::uint32_t infer_input_wire_format(const FlowFrameDescriptor & frame) {\n"
      << "  return frame.alignment > 1u\n"
      << "    ? kPluginPayloadWireFormatAlignedBinary\n"
      << "    : kPluginPayloadWireFormatFlatbuffer;\n"
      << "}\n\n";
  out << "static void reset_direct_output_state() {\n"
      << "  kDirectOutputFrames.clear();\n"
      << "  kDirectBacklogRemaining = 0u;\n"
      << "  kDirectYielded = false;\n"
      << "  kDirectErrorCode.clear();\n"
      << "  kDirectErrorMessage.clear();\n"
      << "}\n\n";
  out << "static void reset_direct_dispatch_state() {\n"
      << "  kDirectInputFrames.clear();\n"
      << "  reset_direct_output_state();\n"
      << "  kDirectOutputStreamCap = 16u;\n"
      << "}\n\n";
  out << "static void prepare_direct_input_frames(std::uint32_t output_stream_cap) {\n"
      << "  kDirectInputFrames.clear();\n"
      << "  reset_direct_output_state();\n"
      << "  kDirectOutputStreamCap = output_stream_cap == 0u ? 16u : output_stream_cap;\n"
      << "  for (std::uint32_t index = 0; index < kCurrentInvocationDescriptor.frame_count; ++index) {\n"
      << "    const FlowFrameDescriptor & frame = kCurrentInvocationDescriptor.frames[index];\n"
      << "    DirectInputFrameOwned owned{};\n"
      << "    const FlowTypeDescriptor * type_descriptor = resolve_type_descriptor(frame.type_descriptor_index);\n"
      << "    if (type_descriptor != nullptr) {\n"
      << "      owned.schema_name = type_descriptor->schema_name != nullptr\n"
      << "        ? type_descriptor->schema_name\n"
      << "        : \"\";\n"
      << "      owned.file_identifier = type_descriptor->file_identifier != nullptr\n"
      << "        ? type_descriptor->file_identifier\n"
      << "        : \"\";\n"
      << "    }\n"
      << "    owned.view.port_id = frame.port_id;\n"
      << "    owned.view.schema_name = nullptr;\n"
      << "    owned.view.file_identifier = nullptr;\n"
      << "    owned.view.wire_format = infer_input_wire_format(frame);\n"
      << "    owned.view.root_type_name = nullptr;\n"
      << "    owned.view.fixed_string_length = 0u;\n"
      << "    owned.view.byte_length = frame.size;\n"
      << "    owned.view.required_alignment = static_cast<std::uint16_t>(frame.alignment);\n"
      << "    owned.view.alignment = static_cast<std::uint16_t>(frame.alignment);\n"
      << "    owned.view.size = frame.size;\n"
      << "    owned.view.generation = 0u;\n"
      << "    owned.view.trace_id = frame.trace_token;\n"
      << "    owned.view.stream_id = frame.stream_id;\n"
      << "    owned.view.sequence = frame.sequence;\n"
      << "    owned.view.end_of_stream = frame.end_of_stream ? 1 : 0;\n"
      << "    owned.view.payload = reinterpret_cast<const std::uint8_t *>(\n"
      << "      static_cast<std::uintptr_t>(frame.offset)\n"
      << "    );\n"
      << "    owned.view.payload_length = frame.size;\n"
      << "    kDirectInputFrames.push_back(std::move(owned));\n"
      << "    DirectInputFrameOwned & stored = kDirectInputFrames.back();\n"
      << "    stored.view.schema_name = stored.schema_name.empty() ? nullptr : stored.schema_name.c_str();\n"
      << "    stored.view.file_identifier = stored.file_identifier.empty() ? nullptr : stored.file_identifier.c_str();\n"
      << "    stored.view.root_type_name = stored.root_type_name.empty() ? nullptr : stored.root_type_name.c_str();\n"
      << "  }\n"
      << "}\n\n";
  out << "static std::uint32_t route_direct_output_frame(\n"
      << "  std::uint32_t node_index,\n"
      << "  const DirectOutputFrameOwned & output\n"
      << ") {\n"
      << "  if (output.port_id.empty()) {\n"
      << "    return 0u;\n"
      << "  }\n"
      << "  std::uint32_t routed = 0u;\n"
      << "  for (std::size_t edge_index = 0; edge_index < " << request.edges.size() << "; ++edge_index) {\n"
      << "    const FlowEdgeDescriptor & edge = kEdgeDescriptors[edge_index];\n"
      << "    if (edge.from_node_index != node_index) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (!string_equals(edge.from_port_id, output.port_id.c_str())) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (edge.target_ingress_index == kInvalidIndex) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    FlowFrameDescriptor frame{};\n"
      << "    clear_frame_descriptor(frame);\n"
      << "    frame.type_descriptor_index = find_type_descriptor_index(\n"
      << "      output.schema_name.c_str(),\n"
      << "      output.file_identifier.c_str()\n"
      << "    );\n"
      << "    frame.alignment = output.required_alignment > 0\n"
      << "      ? output.required_alignment\n"
      << "      : (output.wire_format == kPluginPayloadWireFormatAlignedBinary ? 8u : 1u);\n"
      << "    frame.size = static_cast<std::uint32_t>(output.payload.size());\n"
      << "    frame.stream_id = output.stream_id;\n"
      << "    frame.sequence = static_cast<std::uint32_t>(output.sequence);\n"
      << "    frame.trace_token = output.trace_token;\n"
      << "    frame.end_of_stream = output.end_of_stream;\n"
      << "    std::uint32_t retained_payload_pointer = 0u;\n"
      << "    if (!output.payload.empty()) {\n"
      << "      void * payload_ptr = std::malloc(output.payload.size());\n"
      << "      if (payload_ptr == nullptr) {\n"
      << "        continue;\n"
      << "      }\n"
      << "      std::memcpy(payload_ptr, output.payload.data(), output.payload.size());\n"
      << "      retained_payload_pointer = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(payload_ptr));\n"
      << "    }\n"
      << "    frame.offset = retained_payload_pointer;\n"
      << "    stage_ingress_frame(edge.target_ingress_index, &frame, retained_payload_pointer);\n"
      << "    apply_backpressure(edge.target_ingress_index, 1u);\n"
      << "    if (edge.to_node_index != kInvalidIndex) {\n"
      << "      recompute_node_runtime_state(edge.to_node_index);\n"
      << "    }\n"
      << "    routed += 1u;\n"
      << "  }\n"
      << "  return routed;\n"
      << "}\n\n";

  out << "static FlowRuntimeDescriptor kRuntimeDescriptor = {\n"
      << "  kProgramId,\n"
      << "  kProgramName,\n"
      << "  kProgramVersion,\n"
      << "  kProgramDescription,\n"
      << "  kExecutionModel,\n"
      << "  kEntrypoint,\n"
      << "  kManifestBytesSymbol,\n"
      << "  kManifestSizeSymbol,\n"
      << "  kRequiredPlugins,\n"
      << "  " << request.required_plugins.size() << ",\n"
      << "  kTypeDescriptors,\n"
      << "  " << request.type_descriptors.size() << ",\n"
      << "  kAcceptedTypeIndices,\n"
      << "  " << request.accepted_type_indices.size() << ",\n"
      << "  kTriggerDescriptors,\n"
      << "  " << request.triggers.size() << ",\n"
      << "  kNodeDescriptors,\n"
      << "  " << request.nodes.size() << ",\n"
      << "  kNodeDispatchDescriptors,\n"
      << "  " << request.nodes.size() << ",\n"
      << "  kEdgeDescriptors,\n"
      << "  " << request.edges.size() << ",\n"
      << "  kTriggerBindingDescriptors,\n"
      << "  " << request.trigger_bindings.size() << ",\n"
      << "  kIngressDescriptors,\n"
      << "  " << request.ingress_descriptors.size() << ",\n"
      << "  kNodeIngressIndices,\n"
      << "  " << request.node_ingress_indices.size() << ",\n"
      << "  kExternalInterfaceDescriptors,\n"
      << "  " << request.external_interfaces.size() << ",\n"
      << "  kDependencies,\n"
      << "  " << request.dependencies.size() << ",\n"
      << "  kIngressFrameDescriptors,\n"
      << "  " << request.ingress_descriptors.size() << ",\n"
      << "  &kCurrentInvocationDescriptor,\n"
      << "  kIngressRuntimeStates,\n"
      << "  " << request.ingress_descriptors.size() << ",\n"
      << "  kNodeRuntimeStates,\n"
      << "  " << request.nodes.size() << '\n'
      << "};\n\n";
  out << "static void clear_invocation_descriptor() {\n"
      << "  kCurrentInvocationDescriptor.node_index = kInvalidIndex;\n"
      << "  kCurrentInvocationDescriptor.dispatch_descriptor_index = kInvalidIndex;\n"
      << "  kCurrentInvocationDescriptor.plugin_id = nullptr;\n"
      << "  kCurrentInvocationDescriptor.method_id = nullptr;\n"
      << "  kCurrentInvocationDescriptor.frames = kInvocationFrameBuffer;\n"
      << "  kCurrentInvocationDescriptor.frame_count = 0;\n"
      << "  for (std::size_t index = 0; index < "
      << (request.ingress_descriptors.empty() ? 1 : request.ingress_descriptors.size())
      << "; ++index) {\n"
      << "    clear_frame_descriptor(kInvocationFrameBuffer[index]);\n"
      << "  }\n"
      << "}\n\n";
  out << "static std::uint32_t route_output_frame(\n"
      << "  std::uint32_t node_index,\n"
      << "  const FlowFrameDescriptor * frame\n"
      << ") {\n"
      << "  if (frame == nullptr || frame->port_id == nullptr) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  std::uint32_t routed = 0;\n"
      << "  for (std::size_t edge_index = 0; edge_index < kRuntimeDescriptor.edge_count; ++edge_index) {\n"
      << "    const FlowEdgeDescriptor & edge = kEdgeDescriptors[edge_index];\n"
      << "    if (edge.from_node_index != node_index) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (!string_equals(edge.from_port_id, frame->port_id)) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (edge.target_ingress_index == kInvalidIndex) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    stage_ingress_frame(edge.target_ingress_index, frame);\n"
      << "    apply_backpressure(edge.target_ingress_index, 1u);\n"
      << "    if (edge.to_node_index != kInvalidIndex) {\n"
      << "      recompute_node_runtime_state(edge.to_node_index);\n"
      << "    }\n"
      << "    routed += 1u;\n"
      << "  }\n"
      << "  return routed;\n"
      << "}\n\n";
  out << "static void populate_invocation_descriptor(\n"
      << "  std::uint32_t node_index,\n"
      << "  std::uint32_t frame_budget\n"
      << ") {\n"
      << "  clear_invocation_descriptor();\n"
      << "  if (node_index >= " << request.nodes.size() << ") {\n"
      << "    return;\n"
      << "  }\n"
      << "  const FlowNodeDescriptor & node_descriptor = "
         "kNodeDescriptors[node_index];\n"
      << "  kCurrentInvocationDescriptor.node_index = node_index;\n"
      << "  kCurrentInvocationDescriptor.dispatch_descriptor_index = node_index;\n"
      << "  kCurrentInvocationDescriptor.plugin_id = node_descriptor.plugin_id;\n"
      << "  kCurrentInvocationDescriptor.method_id = node_descriptor.method_id;\n"
      << "  const std::uint32_t budget = frame_budget == 0 ? 1u : frame_budget;\n"
      << "  for (\n"
      << "    std::uint32_t offset = 0;\n"
      << "    offset < node_descriptor.ingress_index_count &&\n"
      << "    kCurrentInvocationDescriptor.frame_count < budget;\n"
      << "    ++offset\n"
      << "  ) {\n"
      << "    const std::uint32_t ingress_index =\n"
      << "      kNodeIngressIndices[node_descriptor.ingress_index_offset + offset];\n"
      << "    const FlowIngressRuntimeState & ingress_state =\n"
      << "      kIngressRuntimeStates[ingress_index];\n"
      << "    const FlowFrameDescriptor & ingress_frame =\n"
      << "      kIngressFrameDescriptors[ingress_index];\n"
      << "    if (ingress_state.queued_frames == 0 || !ingress_frame.occupied) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    kInvocationFrameBuffer[kCurrentInvocationDescriptor.frame_count] =\n"
      << "      ingress_frame;\n"
      << "    kCurrentInvocationDescriptor.frame_count += 1;\n"
      << "  }\n"
      << "}\n\n";
  out << "}  // namespace " << namespace_name << "\n\n";
  if (has_linked_direct_nodes) {
    out << "extern \"C\" std::uint32_t plugin_get_input_count(void) {\n"
        << "  return static_cast<std::uint32_t>(" << namespace_name
        << "::kDirectInputFrames.size());\n"
        << "}\n\n";
    out << "extern \"C\" const plugin_input_frame_t * plugin_get_input_frame(std::uint32_t index) {\n"
        << "  if (index >= " << namespace_name << "::kDirectInputFrames.size()) {\n"
        << "    return nullptr;\n"
        << "  }\n"
        << "  return &" << namespace_name << "::kDirectInputFrames[index].view;\n"
        << "}\n\n";
    out << "extern \"C\" std::int32_t plugin_find_input_index(const char * port_id, std::uint32_t ordinal) {\n"
        << "  if (port_id == nullptr || port_id[0] == '\\0') {\n"
        << "    return -1;\n"
        << "  }\n"
        << "  std::uint32_t seen = 0u;\n"
        << "  for (std::size_t index = 0; index < " << namespace_name << "::kDirectInputFrames.size(); ++index) {\n"
        << "    if (!" << namespace_name << "::string_equals(" << namespace_name
        << "::kDirectInputFrames[index].view.port_id, port_id)) {\n"
        << "      continue;\n"
        << "    }\n"
        << "    if (seen == ordinal) {\n"
        << "      return static_cast<std::int32_t>(index);\n"
        << "    }\n"
        << "    seen += 1u;\n"
        << "  }\n"
        << "  return -1;\n"
        << "}\n\n";
    out << "extern \"C\" void plugin_reset_output_state(void) {\n"
        << "  " << namespace_name << "::kDirectOutputFrames.clear();\n"
        << "  " << namespace_name << "::kDirectBacklogRemaining = 0u;\n"
        << "  " << namespace_name << "::kDirectYielded = false;\n"
        << "  " << namespace_name << "::kDirectErrorCode.clear();\n"
        << "  " << namespace_name << "::kDirectErrorMessage.clear();\n"
        << "}\n\n";
    out << "extern \"C\" std::int32_t plugin_push_output_typed(\n"
        << "  const char * port_id,\n"
        << "  const char * schema_name,\n"
        << "  const char * file_identifier,\n"
        << "  std::uint32_t wire_format,\n"
        << "  const char * root_type_name,\n"
        << "  std::uint16_t fixed_string_length,\n"
        << "  std::uint32_t byte_length,\n"
        << "  std::uint16_t required_alignment,\n"
        << "  const std::uint8_t * payload_ptr,\n"
        << "  std::uint32_t payload_length\n"
        << ") {\n"
        << "  if (port_id == nullptr || port_id[0] == '\\0') {\n"
        << "    " << namespace_name << "::kDirectErrorCode = \"invalid-output-port\";\n"
        << "    " << namespace_name << "::kDirectErrorMessage = \"Output frames must declare a non-empty port id.\";\n"
        << "    return -1;\n"
        << "  }\n"
        << "  if (" << namespace_name << "::kDirectOutputFrames.size() >= " << namespace_name
        << "::kDirectOutputStreamCap) {\n"
        << "    " << namespace_name << "::kDirectErrorCode = \"output-stream-cap-exceeded\";\n"
        << "    " << namespace_name << "::kDirectErrorMessage = \"Direct flow invocation exceeded the configured output stream cap.\";\n"
        << "    return -1;\n"
        << "  }\n"
        << "  " << namespace_name << "::DirectOutputFrameOwned output{};\n"
        << "  output.port_id = port_id != nullptr ? port_id : \"\";\n"
        << "  output.schema_name = schema_name != nullptr ? schema_name : \"\";\n"
        << "  output.file_identifier = file_identifier != nullptr ? file_identifier : \"\";\n"
        << "  output.root_type_name = root_type_name != nullptr ? root_type_name : \"\";\n"
        << "  output.wire_format = wire_format;\n"
        << "  output.fixed_string_length = fixed_string_length;\n"
        << "  output.byte_length = byte_length > 0u ? byte_length : payload_length;\n"
        << "  output.required_alignment = required_alignment;\n"
        << "  output.alignment = required_alignment > 0u ? required_alignment : 8u;\n"
        << "  if (payload_ptr != nullptr && payload_length > 0u) {\n"
        << "    output.payload.assign(payload_ptr, payload_ptr + payload_length);\n"
        << "  }\n"
        << "  " << namespace_name << "::kDirectOutputFrames.push_back(std::move(output));\n"
        << "  return static_cast<std::int32_t>(" << namespace_name
        << "::kDirectOutputFrames.size() - 1u);\n"
        << "}\n\n";
    out << "extern \"C\" std::int32_t plugin_push_output(\n"
        << "  const char * port_id,\n"
        << "  const char * schema_name,\n"
        << "  const char * file_identifier,\n"
        << "  const std::uint8_t * payload_ptr,\n"
        << "  std::uint32_t payload_length\n"
        << ") {\n"
        << "  return plugin_push_output_typed(\n"
        << "    port_id,\n"
        << "    schema_name,\n"
        << "    file_identifier,\n"
        << "    static_cast<std::uint32_t>(PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER),\n"
        << "    nullptr,\n"
        << "    0u,\n"
        << "    payload_length,\n"
        << "    0u,\n"
        << "    payload_ptr,\n"
        << "    payload_length\n"
        << "  );\n"
        << "}\n\n";
    out << "extern \"C\" std::int32_t plugin_push_output_ex(\n"
        << "  const char * port_id,\n"
        << "  const char * schema_name,\n"
        << "  const char * file_identifier,\n"
        << "  std::uint32_t wire_format,\n"
        << "  const char * root_type_name,\n"
        << "  std::uint16_t fixed_string_length,\n"
        << "  std::uint16_t required_alignment,\n"
        << "  const std::uint8_t * payload_ptr,\n"
        << "  std::uint32_t payload_length\n"
        << ") {\n"
        << "  return plugin_push_output_typed(\n"
        << "    port_id,\n"
        << "    schema_name,\n"
        << "    file_identifier,\n"
        << "    wire_format,\n"
        << "    root_type_name,\n"
        << "    fixed_string_length,\n"
        << "    payload_length,\n"
        << "    required_alignment,\n"
        << "    payload_ptr,\n"
        << "    payload_length\n"
        << "  );\n"
        << "}\n\n";
    out << "extern \"C\" void plugin_set_yielded(std::int32_t yielded) {\n"
        << "  " << namespace_name << "::kDirectYielded = yielded != 0;\n"
        << "}\n\n";
    out << "extern \"C\" void plugin_set_backlog_remaining(std::uint32_t backlog_remaining) {\n"
        << "  " << namespace_name << "::kDirectBacklogRemaining = backlog_remaining;\n"
        << "}\n\n";
    out << "extern \"C\" void plugin_set_error(const char * error_code, const char * error_message) {\n"
        << "  " << namespace_name << "::kDirectErrorCode = error_code != nullptr ? error_code : \"\";\n"
        << "  " << namespace_name << "::kDirectErrorMessage = error_message != nullptr ? error_message : \"\";\n"
        << "}\n\n";
  }
  out << "extern \"C\" const std::uint8_t * flow_get_manifest_flatbuffer() {\n"
      << "  return " << namespace_name << "::kFlowManifest;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t flow_get_manifest_flatbuffer_size() {\n"
      << "  return sizeof(" << namespace_name << "::kFlowManifest);\n"
      << "}\n\n";
  out << "extern \"C\" const char * sdn_flow_get_program_id() {\n"
      << "  return " << namespace_name << "::kProgramId;\n"
      << "}\n\n";
  out << "extern \"C\" const char * sdn_flow_get_program_name() {\n"
      << "  return " << namespace_name << "::kProgramName;\n"
      << "}\n\n";
  out << "extern \"C\" const char * sdn_flow_get_program_version() {\n"
      << "  return " << namespace_name << "::kProgramVersion;\n"
      << "}\n\n";
  out << "extern \"C\" const char * sdn_flow_get_editor_metadata_json() {\n"
      << "  return " << namespace_name << "::kEditorMetadataJson;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_editor_metadata_size() {\n"
      << "  return sizeof(" << namespace_name << "::kEditorMetadataJson) - 1;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowTypeDescriptor * sdn_flow_get_type_descriptors() {\n"
      << "  return " << namespace_name << "::kTypeDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_type_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.type_descriptor_count;\n"
      << "}\n\n";
  out << "extern \"C\" const std::uint32_t * sdn_flow_get_accepted_type_indices() {\n"
      << "  return " << namespace_name << "::kAcceptedTypeIndices;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_accepted_type_index_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.accepted_type_index_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowTriggerDescriptor * sdn_flow_get_trigger_descriptors() {\n"
      << "  return " << namespace_name << "::kTriggerDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_trigger_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.trigger_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowNodeDescriptor * sdn_flow_get_node_descriptors() {\n"
      << "  return " << namespace_name << "::kNodeDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_node_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.node_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowNodeDispatchDescriptor * sdn_flow_get_node_dispatch_descriptors() {\n"
      << "  return " << namespace_name << "::kNodeDispatchDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_node_dispatch_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.node_dispatch_descriptor_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowEdgeDescriptor * sdn_flow_get_edge_descriptors() {\n"
      << "  return " << namespace_name << "::kEdgeDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_edge_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.edge_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowTriggerBindingDescriptor * sdn_flow_get_trigger_binding_descriptors() {\n"
      << "  return " << namespace_name << "::kTriggerBindingDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_trigger_binding_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.trigger_binding_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::SignedArtifactDependency * sdn_flow_get_dependency_descriptors() {\n"
      << "  return " << namespace_name << "::kDependencies;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_dependency_count() {\n"
      << "  return " << namespace_name << "::kRuntimeDescriptor.dependency_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowIngressDescriptor * sdn_flow_get_ingress_descriptors() {\n"
      << "  return " << namespace_name << "::kIngressDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_ingress_descriptor_count() {\n"
      << "  return " << namespace_name << "::kRuntimeDescriptor.ingress_count;\n"
      << "}\n\n";
  out << "extern \"C\" " << namespace_name
      << "::FlowFrameDescriptor * sdn_flow_get_ingress_frame_descriptors() {\n"
      << "  return " << namespace_name << "::kIngressFrameDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_ingress_frame_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.ingress_frame_descriptor_count;\n"
      << "}\n\n";
  out << "extern \"C\" const std::uint32_t * sdn_flow_get_node_ingress_indices() {\n"
      << "  return " << namespace_name << "::kNodeIngressIndices;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_node_ingress_index_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.node_ingress_index_count;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowExternalInterfaceDescriptor * sdn_flow_get_external_interface_descriptors() {\n"
      << "  return " << namespace_name
      << "::kExternalInterfaceDescriptors;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_external_interface_descriptor_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.external_interface_count;\n"
      << "}\n\n";
  out << "extern \"C\" " << namespace_name
      << "::FlowIngressRuntimeState * sdn_flow_get_ingress_runtime_states() {\n"
      << "  return " << namespace_name << "::kIngressRuntimeStates;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_ingress_runtime_state_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.ingress_runtime_state_count;\n"
      << "}\n\n";
  out << "extern \"C\" " << namespace_name
      << "::FlowNodeRuntimeState * sdn_flow_get_node_runtime_states() {\n"
      << "  return " << namespace_name << "::kNodeRuntimeStates;\n"
      << "}\n\n";
  out << "extern \"C\" std::size_t sdn_flow_get_node_runtime_state_count() {\n"
      << "  return " << namespace_name
      << "::kRuntimeDescriptor.node_runtime_state_count;\n"
      << "}\n\n";
  out << "extern \"C\" " << namespace_name
      << "::FlowInvocationDescriptor * sdn_flow_get_current_invocation_descriptor() {\n"
      << "  return " << namespace_name << "::kRuntimeDescriptor.current_invocation_descriptor;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_prepare_node_invocation_descriptor(\n"
      << "  std::uint32_t node_index,\n"
      << "  std::uint32_t frame_budget\n"
      << ") {\n"
      << "  " << namespace_name
      << "::populate_invocation_descriptor(node_index, frame_budget);\n"
      << "  return static_cast<std::uint32_t>(\n"
      << "    " << namespace_name
      << "::kCurrentInvocationDescriptor.frame_count\n"
      << "  );\n"
      << "}\n\n";
  out << "extern \"C\" void sdn_flow_reset_runtime_state() {\n"
      << "  " << namespace_name << "::clear_invocation_descriptor();\n"
      << "  for (std::size_t index = 0; index < " << namespace_name
      << "::kRuntimeDescriptor.ingress_runtime_state_count; ++index) {\n"
      << "    " << namespace_name << "::release_retained_ingress_payload(static_cast<std::uint32_t>(index));\n"
      << "    " << namespace_name
      << "::kIngressRuntimeStates[index].total_received = 0;\n"
      << "    " << namespace_name
      << "::kIngressRuntimeStates[index].total_dropped = 0;\n"
      << "    " << namespace_name
      << "::kIngressRuntimeStates[index].queued_frames = 0;\n"
      << "    " << namespace_name
      << "::clear_frame_descriptor(" << namespace_name
      << "::kIngressFrameDescriptors[index]);\n"
      << "  }\n"
      << "  for (std::size_t index = 0; index < " << namespace_name
      << "::kRuntimeDescriptor.node_runtime_state_count; ++index) {\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].invocation_count = 0;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].consumed_frames = 0;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].queued_frames = 0;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].backlog_remaining = 0;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].last_status = 0;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].ready = false;\n"
      << "    " << namespace_name
      << "::kNodeRuntimeStates[index].yielded = false;\n"
      << "  }\n"
      << "  " << namespace_name << "::reset_direct_dispatch_state();\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_enqueue_trigger_frames("
         "std::uint32_t trigger_index, std::uint32_t frame_count) {\n"
      << "  std::uint32_t routed_binding_count = 0;\n"
      << "  for (std::size_t binding_index = 0; binding_index < "
      << namespace_name << "::kRuntimeDescriptor.trigger_binding_count; "
         "++binding_index) {\n"
      << "    const " << namespace_name
      << "::FlowTriggerBindingDescriptor & binding =\n"
      << "      " << namespace_name
      << "::kTriggerBindingDescriptors[binding_index];\n"
      << "    if (binding.trigger_index != trigger_index) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (binding.target_ingress_index == " << namespace_name
      << "::kInvalidIndex) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    " << namespace_name
      << "::apply_backpressure(binding.target_ingress_index, frame_count);\n"
      << "    if (binding.target_node_index != " << namespace_name
      << "::kInvalidIndex) {\n"
      << "      " << namespace_name
      << "::recompute_node_runtime_state(binding.target_node_index);\n"
      << "    }\n"
      << "    routed_binding_count += 1;\n"
      << "  }\n"
      << "  return routed_binding_count;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_enqueue_trigger_frame(\n"
      << "  std::uint32_t trigger_index,\n"
      << "  const " << namespace_name << "::FlowFrameDescriptor * frame\n"
      << ") {\n"
      << "  if (frame == nullptr) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  std::uint32_t routed_binding_count = 0;\n"
      << "  for (std::size_t binding_index = 0; binding_index < "
      << namespace_name << "::kRuntimeDescriptor.trigger_binding_count; "
         "++binding_index) {\n"
      << "    const " << namespace_name
      << "::FlowTriggerBindingDescriptor & binding =\n"
      << "      " << namespace_name
      << "::kTriggerBindingDescriptors[binding_index];\n"
      << "    if (binding.trigger_index != trigger_index) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (binding.target_ingress_index == " << namespace_name
      << "::kInvalidIndex) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    " << namespace_name
      << "::stage_ingress_frame(binding.target_ingress_index, frame);\n"
      << "    " << namespace_name
      << "::apply_backpressure(binding.target_ingress_index, 1u);\n"
      << "    if (binding.target_node_index != " << namespace_name
      << "::kInvalidIndex) {\n"
      << "      " << namespace_name
      << "::recompute_node_runtime_state(binding.target_node_index);\n"
      << "    }\n"
      << "    routed_binding_count += 1;\n"
      << "  }\n"
      << "  return routed_binding_count;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_enqueue_edge_frames("
         "std::uint32_t edge_index, std::uint32_t frame_count) {\n"
      << "  if (edge_index >= " << namespace_name
      << "::kRuntimeDescriptor.edge_count) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  const " << namespace_name
      << "::FlowEdgeDescriptor & edge = " << namespace_name
      << "::kEdgeDescriptors[edge_index];\n"
      << "  if (edge.target_ingress_index == " << namespace_name
      << "::kInvalidIndex) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  " << namespace_name
      << "::apply_backpressure(edge.target_ingress_index, frame_count);\n"
      << "  if (edge.to_node_index != " << namespace_name
      << "::kInvalidIndex) {\n"
      << "    " << namespace_name
      << "::recompute_node_runtime_state(edge.to_node_index);\n"
      << "  }\n"
      << "  return 1;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_enqueue_edge_frame(\n"
      << "  std::uint32_t edge_index,\n"
      << "  const " << namespace_name << "::FlowFrameDescriptor * frame\n"
      << ") {\n"
      << "  if (frame == nullptr || edge_index >= " << namespace_name
      << "::kRuntimeDescriptor.edge_count) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  const " << namespace_name
      << "::FlowEdgeDescriptor & edge = " << namespace_name
      << "::kEdgeDescriptors[edge_index];\n"
      << "  if (edge.target_ingress_index == " << namespace_name
      << "::kInvalidIndex) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  " << namespace_name
      << "::stage_ingress_frame(edge.target_ingress_index, frame);\n"
      << "  " << namespace_name
      << "::apply_backpressure(edge.target_ingress_index, 1u);\n"
      << "  if (edge.to_node_index != " << namespace_name
      << "::kInvalidIndex) {\n"
      << "    " << namespace_name
      << "::recompute_node_runtime_state(edge.to_node_index);\n"
      << "  }\n"
      << "  return 1;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_get_ready_node_index() {\n"
      << "  " << namespace_name << "::recompute_all_node_runtime_state();\n"
      << "  for (std::uint32_t node_index = 0; node_index < " << namespace_name
      << "::kRuntimeDescriptor.node_count; ++node_index) {\n"
      << "    if (" << namespace_name
      << "::kNodeRuntimeStates[node_index].ready) {\n"
      << "      return node_index;\n"
      << "    }\n"
      << "  }\n"
      << "  return " << namespace_name << "::kInvalidIndex;\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_begin_node_invocation("
         "std::uint32_t node_index, std::uint32_t frame_budget) {\n"
      << "  if (node_index >= " << namespace_name
      << "::kRuntimeDescriptor.node_count) {\n"
      << "    return 0;\n"
      << "  }\n\n"
      << "  " << namespace_name
      << "::populate_invocation_descriptor(node_index, frame_budget);\n"
      << "  " << namespace_name
      << "::FlowNodeRuntimeState & node_state =\n"
      << "    " << namespace_name << "::kNodeRuntimeStates[node_index];\n"
      << "  const " << namespace_name
      << "::FlowNodeDescriptor & node_descriptor =\n"
      << "    " << namespace_name << "::kNodeDescriptors[node_index];\n"
      << "  const std::uint32_t budget = frame_budget == 0 ? 1u : frame_budget;\n"
      << "  std::uint32_t consumed = 0;\n\n"
      << "  for (\n"
      << "    std::uint32_t offset = 0;\n"
      << "    offset < node_descriptor.ingress_index_count && consumed < budget;\n"
      << "    ++offset\n"
      << "  ) {\n"
      << "    const std::uint32_t ingress_index =\n"
      << "      " << namespace_name
      << "::kNodeIngressIndices[node_descriptor.ingress_index_offset + offset];\n"
      << "    " << namespace_name
      << "::FlowIngressRuntimeState & ingress_state =\n"
      << "      " << namespace_name
      << "::kIngressRuntimeStates[ingress_index];\n"
      << "    if (ingress_state.queued_frames == 0) {\n"
      << "      continue;\n"
      << "    }\n"
      << "    const std::uint32_t taken =\n"
      << "      " << namespace_name
      << "::min_u32(ingress_state.queued_frames, budget - consumed);\n"
      << "    ingress_state.queued_frames -= taken;\n"
      << "    consumed += taken;\n"
      << "  }\n\n"
      << "  if (consumed > 0) {\n"
      << "    node_state.invocation_count += 1;\n"
      << "    node_state.consumed_frames += consumed;\n"
      << "  }\n"
      << "  node_state.backlog_remaining = 0;\n"
      << "  node_state.yielded = false;\n"
      << "  " << namespace_name
      << "::recompute_node_runtime_state(node_index);\n"
      << "  return consumed;\n"
      << "}\n\n";
  out << "extern \"C\" void sdn_flow_complete_node_invocation(\n"
      << "  std::uint32_t node_index,\n"
      << "  std::uint32_t status_code,\n"
      << "  std::uint32_t backlog_remaining,\n"
      << "  bool yielded\n"
      << ") {\n"
      << "  if (node_index >= " << namespace_name
      << "::kRuntimeDescriptor.node_count) {\n"
      << "    return;\n"
      << "  }\n"
      << "  " << namespace_name
      << "::FlowNodeRuntimeState & node_state =\n"
      << "    " << namespace_name << "::kNodeRuntimeStates[node_index];\n"
      << "  node_state.last_status = status_code;\n"
      << "  node_state.backlog_remaining = backlog_remaining;\n"
      << "  node_state.yielded = yielded;\n"
      << "  " << namespace_name << "::clear_invocation_descriptor();\n"
      << "  " << namespace_name
      << "::recompute_node_runtime_state(node_index);\n"
      << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_dispatch_current_invocation_direct(\n"
      << "  std::uint32_t output_stream_cap\n"
      << ") {\n"
      << "  const std::uint32_t node_index = " << namespace_name
      << "::kCurrentInvocationDescriptor.node_index;\n"
      << "  if (node_index == " << namespace_name << "::kInvalidIndex ||\n"
      << "      node_index >= " << namespace_name << "::kRuntimeDescriptor.node_count) {\n"
      << "    return 0u;\n"
      << "  }\n"
      << "  const " << namespace_name
      << "::FlowLinkedNodeHandlerDescriptor & handler_descriptor =\n"
      << "    " << namespace_name << "::kLinkedNodeHandlers[node_index];\n"
      << "  if (handler_descriptor.handler == nullptr) {\n"
      << "    return 0u;\n"
      << "  }\n";
  if (has_linked_direct_nodes) {
    out << "  " << namespace_name
        << "::prepare_direct_input_frames(output_stream_cap);\n"
        << "  const std::int32_t status_code = static_cast<std::int32_t>(handler_descriptor.handler());\n"
        << "  std::uint32_t routed = 0u;\n"
        << "  for (const auto & output : " << namespace_name << "::kDirectOutputFrames) {\n"
        << "    routed += " << namespace_name
        << "::route_direct_output_frame(node_index, output);\n"
        << "  }\n"
        << "  std::uint32_t resolved_status_code = static_cast<std::uint32_t>(status_code);\n"
        << "  if (!" << namespace_name
        << "::kDirectErrorCode.empty() && resolved_status_code == 0u) {\n"
        << "    resolved_status_code = 1u;\n"
        << "  }\n"
        << "  sdn_flow_complete_node_invocation(\n"
        << "    node_index,\n"
        << "    resolved_status_code,\n"
        << "    " << namespace_name << "::kDirectBacklogRemaining,\n"
        << "    " << namespace_name << "::kDirectYielded\n"
        << "  );\n"
        << "  " << namespace_name << "::reset_direct_dispatch_state();\n"
        << "  return routed;\n";
  } else {
    out << "  (void)output_stream_cap;\n"
        << "  sdn_flow_complete_node_invocation(node_index, 1u, 0u, false);\n"
        << "  return 0u;\n";
  }
  out << "}\n\n";
  out << "extern \"C\" std::uint32_t sdn_flow_apply_node_invocation_result(\n"
      << "  std::uint32_t node_index,\n"
      << "  std::uint32_t status_code,\n"
      << "  std::uint32_t backlog_remaining,\n"
      << "  bool yielded,\n"
      << "  const " << namespace_name << "::FlowFrameDescriptor * output_frames,\n"
      << "  std::uint32_t output_frame_count\n"
      << ") {\n"
      << "  if (node_index >= " << namespace_name
      << "::kRuntimeDescriptor.node_count) {\n"
      << "    return 0;\n"
      << "  }\n"
      << "  std::uint32_t routed = 0;\n"
      << "  if (output_frames != nullptr) {\n"
      << "    for (std::uint32_t index = 0; index < output_frame_count; ++index) {\n"
      << "      routed += " << namespace_name
      << "::route_output_frame(node_index, &output_frames[index]);\n"
      << "    }\n"
      << "  }\n"
      << "  sdn_flow_complete_node_invocation(\n"
      << "    node_index,\n"
      << "    status_code,\n"
      << "    backlog_remaining,\n"
      << "    yielded\n"
      << "  );\n"
      << "  return routed;\n"
      << "}\n\n";
  out << "static std::uint32_t sdn_flow_drain_standalone(\n"
      << "  std::uint32_t frame_budget,\n"
      << "  std::uint32_t output_stream_cap,\n"
      << "  std::uint32_t max_iterations,\n"
      << "  bool * encountered_host_bound_node\n"
      << ") {\n"
      << "  const std::uint32_t iteration_limit = max_iterations == 0 ? 1024u : max_iterations;\n"
      << "  std::uint32_t executed = 0u;\n"
      << "  if (encountered_host_bound_node != nullptr) {\n"
      << "    *encountered_host_bound_node = false;\n"
      << "  }\n"
      << "  while (executed < iteration_limit) {\n"
      << "    const std::uint32_t node_index = sdn_flow_get_ready_node_index();\n"
      << "    if (node_index == " << namespace_name << "::kInvalidIndex) {\n"
      << "      break;\n"
      << "    }\n"
      << "    sdn_flow_begin_node_invocation(node_index, frame_budget);\n"
      << "    if (" << namespace_name << "::kLinkedNodeHandlers[node_index].handler == nullptr) {\n"
      << "      sdn_flow_complete_node_invocation(node_index, 1u, 0u, false);\n"
      << "      if (encountered_host_bound_node != nullptr) {\n"
      << "        *encountered_host_bound_node = true;\n"
      << "      }\n"
      << "      break;\n"
      << "    }\n"
      << "    sdn_flow_dispatch_current_invocation_direct(output_stream_cap);\n"
      << "    executed += 1u;\n"
      << "  }\n"
      << "  return executed;\n"
      << "}\n\n";
  out << "extern \"C\" const " << namespace_name
      << "::FlowRuntimeDescriptor * sdn_flow_get_runtime_descriptor() {\n"
      << "  return &" << namespace_name << "::kRuntimeDescriptor;\n"
      << "}\n\n";
  out << "static bool sdn_flow_arg_equals(const char * value, const char * expected) {\n"
      << "  return " << namespace_name << "::string_equals(value, expected);\n"
      << "}\n\n";
  out << "static bool sdn_flow_arg_starts_with(const char * value, const char * prefix) {\n"
      << "  if (value == nullptr || prefix == nullptr) {\n"
      << "    return false;\n"
      << "  }\n"
      << "  while (*prefix != '\\0') {\n"
      << "    if (*value == '\\0' || *value != *prefix) {\n"
      << "      return false;\n"
      << "    }\n"
      << "    ++value;\n"
      << "    ++prefix;\n"
      << "  }\n"
      << "  return true;\n"
      << "}\n\n";
  out << "static std::uint32_t sdn_flow_parse_u32(const char * value, std::uint32_t fallback) {\n"
      << "  if (value == nullptr || *value == '\\0') {\n"
      << "    return fallback;\n"
      << "  }\n"
      << "  std::uint64_t parsed = 0;\n"
      << "  while (*value != '\\0') {\n"
      << "    if (*value < '0' || *value > '9') {\n"
      << "      return fallback;\n"
      << "    }\n"
      << "    parsed = parsed * 10u + static_cast<std::uint64_t>(*value - '0');\n"
      << "    if (parsed > 0xffffffffu) {\n"
      << "      return fallback;\n"
      << "    }\n"
      << "    ++value;\n"
      << "  }\n"
      << "  return static_cast<std::uint32_t>(parsed);\n"
      << "}\n\n";
  out << "int main(int argc, char ** argv) {\n"
      << "  std::uint32_t frame_budget = 1u;\n"
      << "  std::uint32_t output_stream_cap = 16u;\n"
      << "  std::uint32_t max_iterations = 1024u;\n"
      << "  for (int index = 1; index < argc; ++index) {\n"
      << "    const char * argument = argv[index];\n"
      << "    if (sdn_flow_arg_equals(argument, \"--reset\")) {\n"
      << "      sdn_flow_reset_runtime_state();\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (sdn_flow_arg_starts_with(argument, \"--frame-budget=\")) {\n"
      << "      frame_budget = sdn_flow_parse_u32(argument + 15, frame_budget);\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (sdn_flow_arg_starts_with(argument, \"--output-stream-cap=\")) {\n"
      << "      output_stream_cap = sdn_flow_parse_u32(argument + 20, output_stream_cap);\n"
      << "      continue;\n"
      << "    }\n"
      << "    if (sdn_flow_arg_starts_with(argument, \"--max-iterations=\")) {\n"
      << "      max_iterations = sdn_flow_parse_u32(argument + 17, max_iterations);\n"
      << "      continue;\n"
      << "    }\n"
      << "  }\n"
      << "  bool encountered_host_bound_node = false;\n"
      << "  sdn_flow_drain_standalone(\n"
      << "    frame_budget,\n"
      << "    output_stream_cap,\n"
      << "    max_iterations,\n"
      << "    &encountered_host_bound_node\n"
      << "  );\n"
      << "  return encountered_host_bound_node ? 1 : 0;\n"
      << "}\n";
  return out.str();
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 3) {
      std::cerr << "usage: flow-source-generator <request.bin> <output.cpp>\n";
      return 64;
    }
    BinaryReader reader(readFileBytes(argv[1]));
    const Request request = readRequest(reader);
    const std::string output = generateSource(request);
    writeFileString(argv[2], output);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "flow source generator failed: " << error.what() << '\n';
    return 1;
  }
}
