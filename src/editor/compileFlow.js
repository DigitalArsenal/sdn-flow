import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";

import { EmceptionCompilerAdapter } from "../compiler/index.js";
import { buildDefaultFlowManifestBuffer } from "../compiler/flowManifest.js";
import { createSdkEmceptionSession } from "../compiler/sdkEmceptionSession.js";
import { createFlowDeploymentPlan } from "../deploy/deploymentPlan.js";
import { serializeCompiledArtifact } from "../deploy/compiledArtifact.js";
import { convertNodeRedFlowsToSdnProgram } from "./flowLowering.js";
import { SDN_FLOW_EDITOR_ARTIFACT_OUTPUT_NAME } from "./compileConfig.js";
import {
  collectEditorOnlyLiveRuntimeNodes,
  createEditorOnlyLiveRuntimeError,
} from "./liveRuntimeSupport.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const SdnFlowEditorCompileMode = Object.freeze({
  PREVIEW: "preview",
  ARTIFACT: "artifact",
});

const SCRIPT_NAME_BY_MODE = Object.freeze({
  [SdnFlowEditorCompileMode.PREVIEW]: "editor-compile-preview.mjs",
  [SdnFlowEditorCompileMode.ARTIFACT]: "editor-compile-artifact.mjs",
});

function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function maybeCall(value) {
  return value instanceof Promise ? value : Promise.resolve(value);
}

function normalizeCompileMode(mode) {
  return mode === SdnFlowEditorCompileMode.ARTIFACT
    ? SdnFlowEditorCompileMode.ARTIFACT
    : SdnFlowEditorCompileMode.PREVIEW;
}

function buildArtifactSummary(artifact, warnings = []) {
  return {
    artifactId: artifact.artifactId,
    programId: artifact.programId,
    graphHash: artifact.graphHash,
    manifestHash: artifact.manifestHash,
    runtimeModel: artifact.runtimeModel,
    abiVersion: artifact.abiVersion,
    wasmBytes: artifact.wasm?.length ?? 0,
    manifestBytes: artifact.manifestBuffer?.length ?? 0,
    requiredCapabilities: artifact.requiredCapabilities ?? [],
    pluginVersions: artifact.pluginVersions ?? [],
    warnings,
    createdAt: new Date().toISOString(),
  };
}

function createEditorCompiler(options = {}) {
  return new EmceptionCompilerAdapter({
    emception: options.emception ?? null,
    artifactCatalog:
      options.artifactCatalog ??
      {
        async resolveProgramDependencies() {
          return [];
        },
      },
    manifestBuilder:
      options.manifestBuilder ??
      (({ program, metadata }) =>
        buildDefaultFlowManifestBuffer({
          program,
          deploymentPlan: metadata?.deploymentPlan ?? null,
          hostPlan: metadata?.hostPlan ?? null,
          runtimeTargets: metadata?.runtimeTargets ?? null,
          pluginId: metadata?.pluginId ?? null,
          version: metadata?.version ?? null,
        })),
    outputName: options.outputName ?? SDN_FLOW_EDITOR_ARTIFACT_OUTPUT_NAME,
    sourceGenerator: options.sourceGenerator,
  });
}

function getNodeCommand(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

export function resolveNodeCommand(options = {}) {
  const resolveExecutablePath = (candidate) => {
    if (!candidate || !existsSync(candidate)) {
      return candidate;
    }
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  };
  const explicitCommand = normalizeString(options.command, null);
  if (explicitCommand) {
    return resolveExecutablePath(explicitCommand);
  }

  const envCommand =
    normalizeString(process.env.SDN_FLOW_NODE_PATH, null) ??
    normalizeString(process.env.NODE_BINARY, null) ??
    normalizeString(process.env.NODE, null);
  if (envCommand) {
    return resolveExecutablePath(envCommand);
  }

  const execPath = normalizeString(process.execPath, null);
  if (execPath && /^node(\.exe)?$/i.test(path.basename(execPath))) {
    return resolveExecutablePath(execPath);
  }

  const candidates =
    options.platform === "win32"
      ? [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files (x86)\\nodejs\\node.exe",
        ]
      : [
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
          "/bin/node",
        ];
  const resolvedCandidate = candidates.find((candidate) => existsSync(candidate));
  if (resolvedCandidate) {
    return resolveExecutablePath(resolvedCandidate);
  }

  return getNodeCommand(options.platform);
}

export function resolveSdnFlowEditorCompileScriptPath(mode, options = {}) {
  const normalizedMode = normalizeCompileMode(mode);
  const scriptName = SCRIPT_NAME_BY_MODE[normalizedMode];
  return path.join(PACKAGE_ROOT, "scripts", scriptName);
}

function resolveEmceptionWorkingDirectory(workingDirectory) {
  const normalized = normalizeString(workingDirectory, null);
  if (!normalized) {
    return path.posix.join(
      "/working",
      `sdn-flow-editor-artifact-${randomUUID()}`,
    );
  }
  const posixPath = normalized.replaceAll("\\", "/");
  return posixPath.startsWith("/") ? posixPath : path.posix.join("/working", posixPath);
}

export async function compileNodeRedFlows(flows = [], options = {}) {
  const mode = normalizeCompileMode(options.mode);
  const outputName =
    options.outputName ?? SDN_FLOW_EDITOR_ARTIFACT_OUTPUT_NAME;
  const { program, warnings } = convertNodeRedFlowsToSdnProgram(flows);
  const unsupportedLiveRuntimeNodes = collectEditorOnlyLiveRuntimeNodes(flows);
  if (
    mode === SdnFlowEditorCompileMode.ARTIFACT &&
    unsupportedLiveRuntimeNodes.length > 0
  ) {
    throw new Error(
      createEditorOnlyLiveRuntimeError(unsupportedLiveRuntimeNodes),
    );
  }
  const deploymentPlan = createFlowDeploymentPlan(program, {
    deploymentPlan: options.deploymentPlan,
    pluginId: options.pluginId,
    version: options.version,
    environmentId: options.environmentId,
    scheduleBindingMode: options.scheduleBindingMode,
    serviceBindingMode: options.serviceBindingMode,
    delegatedServiceBaseUrl: options.delegatedServiceBaseUrl,
    defaultHttpAuthPolicyId: options.defaultHttpAuthPolicyId,
    httpAdapter: options.httpAdapter,
    timezone: options.timezone,
  });

  if (mode === SdnFlowEditorCompileMode.PREVIEW) {
    const compiler =
      options.compiler ??
      createEditorCompiler({
        outputName,
        artifactCatalog: options.artifactCatalog,
        manifestBuilder: options.manifestBuilder,
        sourceGenerator: options.sourceGenerator,
      });
    const compilePlan = await compiler.prepareCompile({
      program,
      metadata: {
        outputName,
        deploymentPlan,
        hostPlan: options.hostPlan ?? null,
        pluginId: options.pluginId ?? null,
        runtimeTargets: options.runtimeTargets ?? null,
        version: options.version ?? null,
      },
    });
    return {
      language: "cpp",
      source: compilePlan.source,
      command: compilePlan.command,
      outputName: compilePlan.outputName,
      runtimeModel: compilePlan.runtimeModel,
      sourceGeneratorModel: compilePlan.sourceGeneratorModel,
      program,
      deploymentPlan,
      warnings,
    };
  }

  if (options.compiler) {
    throw new Error(
      "Artifact compilation no longer accepts compiler overrides. Use preview mode for compile plans instead.",
    );
  }
  if (options.emception) {
    throw new Error(
      "Artifact compilation no longer accepts direct emception overrides.",
    );
  }
  if (options.emceptionSessionFactory) {
    throw new Error(
      "Artifact compilation no longer accepts custom emceptionSessionFactory overrides.",
    );
  }
  if (options.sourceGenerator) {
    throw new Error(
      "Artifact compilation no longer accepts sourceGenerator overrides. Use preview mode for custom compile plans instead.",
    );
  }

  let emception = null;
  let ownsSession = false;
  let cleanupWorkingDirectory = null;
  const metadata = {
    outputName,
    deploymentPlan,
    hostPlan: options.hostPlan ?? null,
    pluginId: options.pluginId ?? null,
    runtimeTargets: options.runtimeTargets ?? null,
    version: options.version ?? null,
  };
  const workingDirectory = resolveEmceptionWorkingDirectory(
    options.workingDirectory,
  );
  metadata.workingDirectory = workingDirectory;
  cleanupWorkingDirectory = workingDirectory;
  emception = await maybeCall(
    createSdkEmceptionSession({
      workingDirectory,
    }),
  );
  ownsSession = true;
  const compiler = createEditorCompiler({
    emception,
    outputName,
    artifactCatalog: options.artifactCatalog,
    manifestBuilder: options.manifestBuilder,
  });

  try {
    const artifact = await compiler.compile({
      program,
      metadata,
    });
    return {
      serializedArtifact: serializeCompiledArtifact(artifact),
      artifactSummary: buildArtifactSummary(artifact, warnings),
      language: "cpp",
      source: artifact.compilePlan?.source ?? "",
      loaderModule: artifact.loaderModule ?? null,
      outputName:
        artifact.compilePlan?.outputName ?? outputName,
      runtimeModel: artifact.runtimeModel,
      sourceGeneratorModel: artifact.sourceGeneratorModel,
      program,
      deploymentPlan,
      warnings,
    };
  } finally {
    if (
      cleanupWorkingDirectory &&
      options.keepWorkingDirectory !== true &&
      typeof emception?.removeDirectory === "function"
    ) {
      await emception.removeDirectory(cleanupWorkingDirectory).catch(() => {});
    }
    if (ownsSession && typeof emception?.dispose === "function") {
      await emception.dispose().catch(() => {});
    }
  }
}

export async function runSdnFlowEditorCompileInSubprocess(
  flows = [],
  options = {},
) {
  const mode = normalizeCompileMode(options.mode);
  const command = resolveNodeCommand(options);
  const args = [resolveSdnFlowEditorCompileScriptPath(mode, options)];
  const payload = JSON.stringify({
    mode,
    flows,
    options: {
      outputName: options.outputName ?? SDN_FLOW_EDITOR_ARTIFACT_OUTPUT_NAME,
    },
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PACKAGE_ROOT,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            (stderr ||
              stdout ||
              `${mode} subprocess exited with code ${code}`).trim(),
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `Failed to parse ${mode} subprocess output: ${error.message}\n${stdout}`.trim(),
          ),
        );
      }
    });
    child.stdin.end(payload);
  });
}

export default {
  SdnFlowEditorCompileMode,
  compileNodeRedFlows,
  resolveNodeCommand,
  resolveSdnFlowEditorCompileScriptPath,
  runSdnFlowEditorCompileInSubprocess,
};
