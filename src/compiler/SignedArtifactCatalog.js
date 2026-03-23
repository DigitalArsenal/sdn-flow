import {
  normalizeArtifactDependency,
  normalizeProgram,
} from "../runtime/index.js";
import { sha256Bytes } from "../utils/crypto.js";
import { bytesToHex, toUint8Array } from "../utils/encoding.js";

function normalizeSignedArtifact(artifact = {}) {
  const normalized = normalizeArtifactDependency(artifact);
  return {
    ...normalized,
    wasm:
      artifact.wasm === undefined || artifact.wasm === null
        ? null
        : toUint8Array(artifact.wasm),
    manifestBuffer:
      artifact.manifestBuffer === undefined || artifact.manifestBuffer === null
        ? null
        : toUint8Array(artifact.manifestBuffer),
  };
}

function preferNonEmptyString(primary, fallback = null) {
  if (typeof primary === "string" && primary.trim().length > 0) {
    return primary;
  }
  return fallback;
}

function dependencyKey(dependency) {
  if (dependency.dependencyId) {
    return `dependency:${dependency.dependencyId}`;
  }
  if (dependency.artifactId) {
    return `artifact:${dependency.artifactId}`;
  }
  if (dependency.pluginId && dependency.version) {
    return `plugin:${dependency.pluginId}@${dependency.version}`;
  }
  if (dependency.pluginId) {
    return `plugin:${dependency.pluginId}`;
  }
  throw new Error(
    "Signed artifact is missing dependencyId/artifactId/pluginId.",
  );
}

export class SignedArtifactCatalog {
  #artifacts = new Map();

  registerArtifact(artifact) {
    const normalized = normalizeSignedArtifact(artifact);
    const key = dependencyKey(normalized);
    this.#artifacts.set(key, normalized);
    return normalized;
  }

  registerArtifacts(artifacts = []) {
    return artifacts.map((artifact) => this.registerArtifact(artifact));
  }

  getArtifact(selector) {
    const normalized = normalizeSignedArtifact(selector);
    const attemptedKeys = [];
    for (const key of [
      normalized.dependencyId ? `dependency:${normalized.dependencyId}` : null,
      normalized.artifactId ? `artifact:${normalized.artifactId}` : null,
      normalized.pluginId && normalized.version
        ? `plugin:${normalized.pluginId}@${normalized.version}`
        : null,
      normalized.pluginId ? `plugin:${normalized.pluginId}` : null,
    ]) {
      if (!key) {
        continue;
      }
      attemptedKeys.push(key);
      const artifact = this.#artifacts.get(key);
      if (artifact) {
        return artifact;
      }
    }
    throw new Error(
      `Signed artifact dependency not found in catalog (${attemptedKeys.join(", ")}).`,
    );
  }

  async resolveProgramDependencies(program) {
    const normalizedProgram = normalizeProgram(program);
    const rawArtifactDependencies = Array.isArray(program?.artifactDependencies)
      ? program.artifactDependencies
      : [];
    const resolved = [];
    for (
      let index = 0;
      index < normalizedProgram.artifactDependencies.length;
      index += 1
    ) {
      const dependency = normalizedProgram.artifactDependencies[index];
      const rawDependency = rawArtifactDependencies[index] ?? {};
      const artifact = this.getArtifact(dependency);
      if (!artifact.signature || !artifact.signerPublicKey) {
        throw new Error(
          `Signed artifact "${dependency.dependencyId || dependency.pluginId}" is missing signature metadata.`,
        );
      }
      if (!artifact.wasm || artifact.wasm.length === 0) {
        throw new Error(
          `Signed artifact "${dependency.dependencyId || dependency.pluginId}" is missing wasm bytes.`,
        );
      }
      const computedSha256 = bytesToHex(await sha256Bytes(artifact.wasm));
      if (artifact.sha256 && artifact.sha256 !== computedSha256) {
        throw new Error(
          `Signed artifact "${dependency.dependencyId || dependency.pluginId}" sha256 mismatch.`,
        );
      }
      resolved.push({
        ...artifact,
        ...dependency,
        wasm: artifact.wasm,
        manifestBuffer: artifact.manifestBuffer,
        sha256: artifact.sha256 ?? computedSha256,
        manifestExports: {
          bytesSymbol: preferNonEmptyString(
            rawDependency.manifestExports?.bytesSymbol ??
              rawDependency.manifest_exports?.bytes_symbol,
            artifact.manifestExports?.bytesSymbol,
          ),
          sizeSymbol: preferNonEmptyString(
            rawDependency.manifestExports?.sizeSymbol ??
              rawDependency.manifest_exports?.size_symbol,
            artifact.manifestExports?.sizeSymbol,
          ),
        },
        runtimeExports: {
          initSymbol: preferNonEmptyString(
            rawDependency.runtimeExports?.initSymbol ??
              rawDependency.runtime_exports?.init_symbol,
            artifact.runtimeExports?.initSymbol,
          ),
          destroySymbol: preferNonEmptyString(
            rawDependency.runtimeExports?.destroySymbol ??
              rawDependency.runtime_exports?.destroy_symbol,
            artifact.runtimeExports?.destroySymbol,
          ),
          mallocSymbol: preferNonEmptyString(
            rawDependency.runtimeExports?.mallocSymbol ??
              rawDependency.runtime_exports?.malloc_symbol,
            artifact.runtimeExports?.mallocSymbol,
          ),
          freeSymbol: preferNonEmptyString(
            rawDependency.runtimeExports?.freeSymbol ??
              rawDependency.runtime_exports?.free_symbol,
            artifact.runtimeExports?.freeSymbol,
          ),
          streamInvokeSymbol: preferNonEmptyString(
            rawDependency.runtimeExports?.streamInvokeSymbol ??
              rawDependency.runtime_exports?.stream_invoke_symbol,
            artifact.runtimeExports?.streamInvokeSymbol,
          ),
        },
      });
    }
    return resolved;
  }
}

export default SignedArtifactCatalog;
