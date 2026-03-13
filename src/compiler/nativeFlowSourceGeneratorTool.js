import { mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NATIVE_SOURCE_PATH = fileURLToPath(
  new URL("../../native/flow_source_generator.cpp", import.meta.url),
);
const GENERATED_DIR = fileURLToPath(
  new URL("../../generated-tools/", import.meta.url),
);
const MODULE_PATH = path.join(GENERATED_DIR, "flow-source-generator.mjs");
const WASM_PATH = path.join(GENERATED_DIR, "flow-source-generator.wasm");
const EMXX_FLAGS = Object.freeze([
  "-std=c++20",
  "-O2",
  "-sWASM=1",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=node",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sFORCE_FILESYSTEM=1",
  "-sEXPORTED_RUNTIME_METHODS=['FS','callMain']",
]);

function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function toolBuildIsCurrent() {
  const sourceTime = getMtimeMs(NATIVE_SOURCE_PATH);
  const moduleTime = getMtimeMs(MODULE_PATH);
  const wasmTime = getMtimeMs(WASM_PATH);
  return moduleTime >= sourceTime && wasmTime >= sourceTime;
}

function assertToolExists() {
  if (!toolBuildIsCurrent()) {
    throw new Error(
      "flow source generator tool is not built. Run ensureNativeFlowSourceGeneratorTool() first.",
    );
  }
}

export function getNativeFlowSourceGeneratorToolInfo() {
  return {
    packageRoot: PACKAGE_ROOT,
    sourcePath: NATIVE_SOURCE_PATH,
    generatedDir: GENERATED_DIR,
    modulePath: MODULE_PATH,
    wasmPath: WASM_PATH,
    command: ["em++", ...EMXX_FLAGS, NATIVE_SOURCE_PATH, "-o", MODULE_PATH],
  };
}

export async function ensureNativeFlowSourceGeneratorTool({
  force = false,
} = {}) {
  mkdirSync(GENERATED_DIR, { recursive: true });
  if (!force && toolBuildIsCurrent()) {
    return getNativeFlowSourceGeneratorToolInfo();
  }

  const result = spawnSync(
    "em++",
    [...EMXX_FLAGS, NATIVE_SOURCE_PATH, "-o", MODULE_PATH],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(
      `failed to run em++ for flow source generator: ${result.error.message}`,
    );
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `failed to build flow source generator wasm tool:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }

  assertToolExists();
  return getNativeFlowSourceGeneratorToolInfo();
}

async function importToolModule(modulePath) {
  const moduleUrl = `${pathToFileURL(modulePath).href}?v=${getMtimeMs(modulePath)}`;
  return import(moduleUrl);
}

export async function runNativeFlowSourceGenerator(requestBytes, options = {}) {
  const tool = await ensureNativeFlowSourceGeneratorTool(options);
  const toolModule = await importToolModule(tool.modulePath);
  const stdout = [];
  const stderr = [];
  const generator = await toolModule.default({
    locateFile(file) {
      return path.join(tool.generatedDir, file);
    },
    print(...args) {
      stdout.push(args.join(" "));
    },
    printErr(...args) {
      stderr.push(args.join(" "));
    },
  });

  generator.FS.writeFile("/request.bin", requestBytes);
  let exitError = null;
  try {
    generator.callMain(["/request.bin", "/output.cpp"]);
  } catch (error) {
    exitError = error;
  }

  if (!generator.FS.analyzePath("/output.cpp").exists) {
    const details = stderr.join("\n");
    if (exitError) {
      throw new Error(
        `native flow source generator failed: ${exitError.message}\n${details}`.trim(),
      );
    }
    throw new Error(
      `native flow source generator did not produce output.\n${details}`.trim(),
    );
  }

  return {
    source: generator.FS.readFile("/output.cpp", { encoding: "utf8" }),
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    tool,
    generatorModel: "native-cpp-wasm",
  };
}

export default runNativeFlowSourceGenerator;
