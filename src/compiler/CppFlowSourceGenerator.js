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

export function generateCppFlowRuntimeSource({
  program,
  manifestBuffer,
  dependencies = [],
  namespace = "sdn_flow_generated",
} = {}) {
  const normalizedProgram = normalizeProgram(program);
  const normalizedManifestBuffer = toUint8Array(manifestBuffer);

  if (normalizedManifestBuffer.length === 0) {
    throw new Error("generateCppFlowRuntimeSource requires manifestBuffer bytes.");
  }

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
      dependencyBlocks.push(renderByteArray(manifestSymbol, dependency.manifestBuffer));
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

${renderByteArray("kFlowManifest", normalizedManifestBuffer)}

${dependencyBlocks.join("\n\n")}

static const SignedArtifactDependency kDependencies[] = {
${dependencyRecords.join(",\n")}
};

static const char kProgramId[] = ${cppStringLiteral(normalizedProgram.programId)};
static const char kProgramName[] = ${cppStringLiteral(normalizedProgram.name ?? normalizedProgram.programId)};
static const char kProgramVersion[] = ${cppStringLiteral(normalizedProgram.version ?? "0.1.0")};

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
  return sizeof(${namespace}::kDependencies) / sizeof(${namespace}::kDependencies[0]);
}

int main(int argc, char ** argv) {
  (void)argc;
  (void)argv;
  return 0;
}
`;
}

export default generateCppFlowRuntimeSource;
