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
  "-sEXPORTED_FUNCTIONS=['_main','_flow_get_manifest_flatbuffer','_flow_get_manifest_flatbuffer_size','_sdn_flow_get_program_id','_sdn_flow_get_program_name','_sdn_flow_get_program_version','_sdn_flow_get_dependency_descriptors','_sdn_flow_get_dependency_count']",
]);

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
    const dependencies = await this.#artifactCatalog.resolveProgramDependencies(
      normalizedProgram,
    );
    const manifestBuffer = await this.#buildManifestBuffer({
      program: normalizedProgram,
      metadata,
      dependencies,
    });
    const source = this.#sourceGenerator({
      program: normalizedProgram,
      manifestBuffer,
      dependencies,
    });
    const outputName = String(metadata?.outputName ?? this.#outputName);
    const flags = Array.isArray(metadata?.flags) ? metadata.flags : this.#flags;
    return {
      program: normalizedProgram,
      manifestBuffer,
      dependencies,
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
      format: "application/wasm",
      wasm,
      loaderModule,
      manifestBuffer: compilePlan.manifestBuffer,
      entrypoint: "main",
      graphHash: bytesToHex(
        await sha256Bytes(new TextEncoder().encode(JSON.stringify(compilePlan.program))),
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
