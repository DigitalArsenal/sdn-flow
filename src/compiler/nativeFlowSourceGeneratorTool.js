import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NATIVE_SOURCE_PATH = fileURLToPath(
  new URL("../../native/flow_source_generator.cpp", import.meta.url),
);
const GENERATED_DIR = fileURLToPath(
  new URL("../../generated-tools/", import.meta.url),
);
const BUILD_LOCK_DIR = path.join(GENERATED_DIR, ".flow-source-generator.lock");
const MODULE_PATH = path.join(GENERATED_DIR, "flow-source-generator.mjs");
const WASM_PATH = path.join(GENERATED_DIR, "flow-source-generator.wasm");
const BUILD_LOCK_POLL_MS = 50;
const BUILD_LOCK_STALE_MS = 120_000;
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

function getSizeBytes(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function toolBuildIsCurrent() {
  const sourceTime = getMtimeMs(NATIVE_SOURCE_PATH);
  const moduleTime = getMtimeMs(MODULE_PATH);
  const wasmTime = getMtimeMs(WASM_PATH);
  return (
    moduleTime >= sourceTime &&
    wasmTime >= sourceTime &&
    getSizeBytes(MODULE_PATH) > 0 &&
    getSizeBytes(WASM_PATH) > 0
  );
}

function moveFileIntoPlace(sourcePath, targetPath) {
  try {
    renameSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
      throw error;
    }
    rmSync(targetPath, { force: true });
    renameSync(sourcePath, targetPath);
  }
}

async function acquireBuildLock() {
  mkdirSync(GENERATED_DIR, { recursive: true });
  while (true) {
    try {
      mkdirSync(BUILD_LOCK_DIR);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const lockAgeMs = Date.now() - getMtimeMs(BUILD_LOCK_DIR);
      if (lockAgeMs > BUILD_LOCK_STALE_MS) {
        rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      await delay(BUILD_LOCK_POLL_MS);
    }
  }
}

function releaseBuildLock() {
  rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
}

function buildToolArtifacts() {
  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tempModulePath = path.join(
    GENERATED_DIR,
    `flow-source-generator.${uniqueSuffix}.mjs`,
  );
  const tempWasmPath = path.join(
    GENERATED_DIR,
    `flow-source-generator.${uniqueSuffix}.wasm`,
  );
  try {
    const result = spawnSync(
      "em++",
      [...EMXX_FLAGS, NATIVE_SOURCE_PATH, "-o", tempModulePath],
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
    if (getSizeBytes(tempModulePath) <= 0 || getSizeBytes(tempWasmPath) <= 0) {
      throw new Error("flow source generator build produced empty artifacts.");
    }
    moveFileIntoPlace(tempModulePath, MODULE_PATH);
    moveFileIntoPlace(tempWasmPath, WASM_PATH);
  } finally {
    rmSync(tempModulePath, { force: true });
    rmSync(tempWasmPath, { force: true });
  }
}

function shouldRetryToolLoad(error) {
  return /BufferSource argument is empty/i.test(String(error?.message ?? error));
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
  if (!force && toolBuildIsCurrent()) {
    return getNativeFlowSourceGeneratorToolInfo();
  }
  await acquireBuildLock();
  try {
    if (!force && toolBuildIsCurrent()) {
      return getNativeFlowSourceGeneratorToolInfo();
    }
    buildToolArtifacts();
    assertToolExists();
    return getNativeFlowSourceGeneratorToolInfo();
  } finally {
    releaseBuildLock();
  }
}

async function importToolModule(modulePath) {
  const moduleUrl = `${pathToFileURL(modulePath).href}?v=${getMtimeMs(modulePath)}`;
  return import(moduleUrl);
}

export async function runNativeFlowSourceGenerator(requestBytes, options = {}) {
  const stdout = [];
  const stderr = [];
  let tool = await ensureNativeFlowSourceGeneratorTool(options);
  let generator = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const toolModule = await importToolModule(tool.modulePath);
      generator = await toolModule.default({
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
      break;
    } catch (error) {
      if (attempt > 0 || !shouldRetryToolLoad(error)) {
        throw error;
      }
      stderr.push(String(error?.message ?? error));
      tool = await ensureNativeFlowSourceGeneratorTool({
        ...options,
        force: true,
      });
    }
  }

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
