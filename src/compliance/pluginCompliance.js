import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DefaultManifestExports,
  DrainPolicy,
  ExternalInterfaceDirection,
  ExternalInterfaceKind,
} from "../runtime/constants.js";

export const RecommendedCapabilityIds = Object.freeze([
  "clock",
  "random",
  "timers",
  "http",
  "network",
  "filesystem",
  "pipe",
  "pubsub",
  "protocol_handle",
  "protocol_dial",
  "database",
  "storage_adapter",
  "storage_query",
  "storage_write",
  "wallet_sign",
  "ipfs",
  "scene_access",
  "render_hooks",
]);

const RecommendedCapabilitySet = new Set(RecommendedCapabilityIds);
const DrainPolicySet = new Set(Object.values(DrainPolicy));
const ExternalInterfaceDirectionSet = new Set(
  Object.values(ExternalInterfaceDirection),
);
const ExternalInterfaceKindSet = new Set(Object.values(ExternalInterfaceKind));
const IgnoredDirectoryNames = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  "build",
  "Build",
  "dist",
  "coverage",
  "node_modules",
  "vendor",
  "docs-html",
  "out",
]);

function createIssue(severity, code, message, location) {
  return { severity, code, message, location };
}

function pushIssue(issues, severity, code, message, location) {
  issues.push(createIssue(severity, code, message, location));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringField(issues, value, location, label) {
  if (!isNonEmptyString(value)) {
    pushIssue(issues, "error", "missing-string", `${label} must be a non-empty string.`, location);
    return false;
  }
  return true;
}

function validateIntegerField(issues, value, location, label, { min = null } = {}) {
  if (!Number.isInteger(value)) {
    pushIssue(issues, "error", "invalid-integer", `${label} must be an integer.`, location);
    return false;
  }
  if (min !== null && value < min) {
    pushIssue(
      issues,
      "error",
      "integer-range",
      `${label} must be greater than or equal to ${min}.`,
      location,
    );
    return false;
  }
  return true;
}

function validateAllowedType(type, issues, location) {
  if (!type || typeof type !== "object" || Array.isArray(type)) {
    pushIssue(issues, "error", "invalid-type-record", "Allowed type entries must be objects.", location);
    return;
  }
  if (type.acceptsAnyFlatbuffer === true) {
    return;
  }
  if (
    !isNonEmptyString(type.schemaName) &&
    !isNonEmptyString(type.fileIdentifier) &&
    !isNonEmptyString(type.schemaHash)
  ) {
    pushIssue(
      issues,
      "error",
      "missing-type-identity",
      "Allowed type must declare at least one stable identity field: schemaName, fileIdentifier, or schemaHash.",
      location,
    );
  }
}

function validateAcceptedTypeSet(typeSet, issues, location) {
  if (!typeSet || typeof typeSet !== "object" || Array.isArray(typeSet)) {
    pushIssue(issues, "error", "invalid-type-set", "Accepted type sets must be objects.", location);
    return;
  }
  validateStringField(issues, typeSet.setId, `${location}.setId`, "Accepted type set setId");
  if (!Array.isArray(typeSet.allowedTypes) || typeSet.allowedTypes.length === 0) {
    pushIssue(
      issues,
      "error",
      "missing-allowed-types",
      "Accepted type sets must declare one or more allowedTypes.",
      `${location}.allowedTypes`,
    );
    return;
  }
  typeSet.allowedTypes.forEach((allowedType, index) => {
    validateAllowedType(allowedType, issues, `${location}.allowedTypes[${index}]`);
  });
}

function validatePort(port, issues, location, label) {
  if (!port || typeof port !== "object" || Array.isArray(port)) {
    pushIssue(issues, "error", "invalid-port", `${label} entries must be objects.`, location);
    return;
  }
  validateStringField(issues, port.portId, `${location}.portId`, `${label} portId`);
  if (!Array.isArray(port.acceptedTypeSets) || port.acceptedTypeSets.length === 0) {
    pushIssue(
      issues,
      "error",
      "missing-accepted-type-sets",
      `${label} must declare one or more acceptedTypeSets.`,
      `${location}.acceptedTypeSets`,
    );
  } else {
    port.acceptedTypeSets.forEach((typeSet, index) => {
      validateAcceptedTypeSet(typeSet, issues, `${location}.acceptedTypeSets[${index}]`);
    });
  }
  const minStreamsValid = validateIntegerField(
    issues,
    port.minStreams,
    `${location}.minStreams`,
    `${label} minStreams`,
    { min: 0 },
  );
  const maxStreamsValid = validateIntegerField(
    issues,
    port.maxStreams,
    `${location}.maxStreams`,
    `${label} maxStreams`,
    { min: 0 },
  );
  if (minStreamsValid && maxStreamsValid && port.maxStreams < port.minStreams) {
    pushIssue(
      issues,
      "error",
      "stream-range",
      `${label} maxStreams must be greater than or equal to minStreams.`,
      location,
    );
  }
  if (typeof port.required !== "boolean") {
    pushIssue(issues, "error", "invalid-required-flag", `${label} required must be a boolean.`, `${location}.required`);
  }
}

function validateExternalInterface(externalInterface, issues, location, declaredCapabilities) {
  if (!externalInterface || typeof externalInterface !== "object" || Array.isArray(externalInterface)) {
    pushIssue(
      issues,
      "error",
      "invalid-external-interface",
      "externalInterfaces entries must be objects.",
      location,
    );
    return;
  }
  validateStringField(
    issues,
    externalInterface.interfaceId,
    `${location}.interfaceId`,
    "External interface interfaceId",
  );
  if (!isNonEmptyString(externalInterface.kind)) {
    pushIssue(issues, "error", "missing-interface-kind", "External interface kind must be a non-empty string.", `${location}.kind`);
  } else if (!ExternalInterfaceKindSet.has(externalInterface.kind)) {
    pushIssue(
      issues,
      "warning",
      "unknown-interface-kind",
      `External interface kind "${externalInterface.kind}" is not in the canonical SDN interface kind set.`,
      `${location}.kind`,
    );
  }
  if (!isNonEmptyString(externalInterface.direction)) {
    pushIssue(
      issues,
      "error",
      "missing-interface-direction",
      "External interface direction must be a non-empty string.",
      `${location}.direction`,
    );
  } else if (!ExternalInterfaceDirectionSet.has(externalInterface.direction)) {
    pushIssue(
      issues,
      "error",
      "invalid-interface-direction",
      `External interface direction "${externalInterface.direction}" is invalid.`,
      `${location}.direction`,
    );
  }
  if (!isNonEmptyString(externalInterface.capability)) {
    pushIssue(
      issues,
      "warning",
      "missing-interface-capability",
      "External interface should declare the coarse capability it consumes.",
      `${location}.capability`,
    );
  } else if (Array.isArray(declaredCapabilities) && !declaredCapabilities.includes(externalInterface.capability)) {
    pushIssue(
      issues,
      "error",
      "undeclared-interface-capability",
      `External interface capability "${externalInterface.capability}" is not declared in manifest.capabilities.`,
      `${location}.capability`,
    );
  }
}

export function validatePluginManifest(manifest, options = {}) {
  const { sourceName = "manifest" } = options;
  const issues = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    pushIssue(issues, "error", "invalid-manifest", "Manifest must be a JSON object.", sourceName);
    return buildComplianceReport({
      sourceName,
      manifest,
      issues,
      exportNames: [],
      checkedArtifact: false,
    });
  }

  validateStringField(issues, manifest.pluginId, `${sourceName}.pluginId`, "pluginId");
  validateStringField(issues, manifest.name, `${sourceName}.name`, "name");
  validateStringField(issues, manifest.version, `${sourceName}.version`, "version");
  validateStringField(issues, manifest.pluginFamily, `${sourceName}.pluginFamily`, "pluginFamily");

  const declaredCapabilities = manifest.capabilities;
  if (!Array.isArray(declaredCapabilities)) {
    pushIssue(
      issues,
      "warning",
      "missing-capabilities-array",
      "manifest.capabilities should be present as an explicit array, even when empty.",
      `${sourceName}.capabilities`,
    );
  } else {
    const seenCapabilities = new Set();
    for (const capability of declaredCapabilities) {
      if (!isNonEmptyString(capability)) {
        pushIssue(
          issues,
          "error",
          "invalid-capability",
          "Capability entries must be non-empty strings.",
          `${sourceName}.capabilities`,
        );
        continue;
      }
      if (seenCapabilities.has(capability)) {
        pushIssue(
          issues,
          "warning",
          "duplicate-capability",
          `Capability "${capability}" is declared more than once.`,
          `${sourceName}.capabilities`,
        );
      }
      seenCapabilities.add(capability);
      if (!RecommendedCapabilitySet.has(capability)) {
        pushIssue(
          issues,
          "warning",
          "noncanonical-capability",
          `Capability "${capability}" is not in the current canonical SDN coarse capability set.`,
          `${sourceName}.capabilities`,
        );
      }
    }
  }

  if (!Array.isArray(manifest.externalInterfaces)) {
    pushIssue(
      issues,
      "warning",
      "missing-external-interfaces-array",
      "manifest.externalInterfaces should be present as an explicit array, even when empty.",
      `${sourceName}.externalInterfaces`,
    );
  } else {
    manifest.externalInterfaces.forEach((externalInterface, index) => {
      validateExternalInterface(
        externalInterface,
        issues,
        `${sourceName}.externalInterfaces[${index}]`,
        declaredCapabilities,
      );
    });
  }

  if (!Array.isArray(manifest.methods) || manifest.methods.length === 0) {
    pushIssue(
      issues,
      "error",
      "missing-methods",
      "manifest.methods must declare at least one method.",
      `${sourceName}.methods`,
    );
  } else {
    const seenMethodIds = new Set();
    manifest.methods.forEach((method, index) => {
      const location = `${sourceName}.methods[${index}]`;
      if (!method || typeof method !== "object" || Array.isArray(method)) {
        pushIssue(issues, "error", "invalid-method", "Method entries must be objects.", location);
        return;
      }
      const methodIdValid = validateStringField(issues, method.methodId, `${location}.methodId`, "methodId");
      if (methodIdValid) {
        if (seenMethodIds.has(method.methodId)) {
          pushIssue(
            issues,
            "error",
            "duplicate-method-id",
            `Method "${method.methodId}" is declared more than once.`,
            `${location}.methodId`,
          );
        }
        seenMethodIds.add(method.methodId);
      }
      if (!Array.isArray(method.inputPorts) || method.inputPorts.length === 0) {
        pushIssue(
          issues,
          "error",
          "missing-input-ports",
          "Methods must declare one or more inputPorts.",
          `${location}.inputPorts`,
        );
      } else {
        method.inputPorts.forEach((port, portIndex) => {
          validatePort(port, issues, `${location}.inputPorts[${portIndex}]`, "Input port");
        });
      }
      if (!Array.isArray(method.outputPorts)) {
        pushIssue(
          issues,
          "error",
          "missing-output-ports",
          "Methods must declare outputPorts as an array.",
          `${location}.outputPorts`,
        );
      } else {
        method.outputPorts.forEach((port, portIndex) => {
          validatePort(port, issues, `${location}.outputPorts[${portIndex}]`, "Output port");
        });
      }
      validateIntegerField(issues, method.maxBatch, `${location}.maxBatch`, "maxBatch", {
        min: 1,
      });
      if (!isNonEmptyString(method.drainPolicy)) {
        pushIssue(
          issues,
          "error",
          "missing-drain-policy",
          "Methods must declare drainPolicy.",
          `${location}.drainPolicy`,
        );
      } else if (!DrainPolicySet.has(method.drainPolicy)) {
        pushIssue(
          issues,
          "error",
          "invalid-drain-policy",
          `Drain policy "${method.drainPolicy}" is invalid.`,
          `${location}.drainPolicy`,
        );
      }
    });
  }

  return buildComplianceReport({
    sourceName,
    manifest,
    issues,
    exportNames: [],
    checkedArtifact: false,
  });
}

export async function loadManifestFromFile(manifestPath) {
  const contents = await readFile(manifestPath, "utf8");
  return JSON.parse(contents);
}

export function getWasmExportNames(wasmBytes) {
  const module = new WebAssembly.Module(wasmBytes);
  return WebAssembly.Module.exports(module).map((entry) => entry.name).sort();
}

export async function getWasmExportNamesFromFile(wasmPath) {
  const wasmBytes = await readFile(wasmPath);
  return getWasmExportNames(wasmBytes);
}

export async function validatePluginArtifact(options) {
  const {
    manifest,
    manifestPath = null,
    wasmPath = null,
    exportNames = null,
    sourceName = manifestPath ?? "manifest",
  } = options;
  const report = validatePluginManifest(manifest, { sourceName });
  const issues = [...report.issues];
  let resolvedExportNames = [];
  let checkedArtifact = false;

  if (Array.isArray(exportNames)) {
    resolvedExportNames = [...exportNames];
    checkedArtifact = true;
  } else if (isNonEmptyString(wasmPath)) {
    resolvedExportNames = await getWasmExportNamesFromFile(wasmPath);
    checkedArtifact = true;
  }

  if (checkedArtifact) {
    for (const symbol of [
      DefaultManifestExports.pluginBytesSymbol,
      DefaultManifestExports.pluginSizeSymbol,
    ]) {
      if (!resolvedExportNames.includes(symbol)) {
        pushIssue(
          issues,
          "error",
          "missing-plugin-manifest-export",
          `Plugin artifact is missing required export "${symbol}".`,
          wasmPath ?? sourceName,
        );
      }
    }
  } else {
    pushIssue(
      issues,
      "warning",
      "artifact-abi-not-checked",
      "No WASM artifact or export list was provided, so ABI export checks were skipped.",
      sourceName,
    );
  }

  return buildComplianceReport({
    sourceName,
    manifest,
    issues,
    exportNames: resolvedExportNames,
    checkedArtifact,
  });
}

function buildComplianceReport({
  sourceName,
  manifest,
  issues,
  exportNames,
  checkedArtifact,
}) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    ok: errors.length === 0,
    sourceName,
    manifest,
    issues,
    errors,
    warnings,
    checkedArtifact,
    exportNames,
  };
}

export async function findManifestFiles(rootDirectory) {
  const manifestPaths = [];
  await walkDirectory(rootDirectory, manifestPaths);
  manifestPaths.sort();
  return manifestPaths;
}

export async function loadComplianceConfig(rootDirectory) {
  for (const candidate of [
    path.join(rootDirectory, "sdn-plugin-compliance.json"),
    path.join(rootDirectory, ".claude", "sdn-plugin-compliance.json"),
  ]) {
    try {
      await access(candidate);
      return {
        path: candidate,
        config: JSON.parse(await readFile(candidate, "utf8")),
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

export async function resolveManifestFiles(rootDirectory) {
  const loadedConfig = await loadComplianceConfig(rootDirectory);
  if (!loadedConfig) {
    return findManifestFiles(rootDirectory);
  }

  const { config } = loadedConfig;
  const resolvedPaths = new Set();
  if (Array.isArray(config.manifestPaths)) {
    for (const relativePath of config.manifestPaths) {
      resolvedPaths.add(path.resolve(rootDirectory, relativePath));
    }
  }
  if (Array.isArray(config.scanDirectories)) {
    for (const relativeDirectory of config.scanDirectories) {
      const scanRoot = path.resolve(rootDirectory, relativeDirectory);
      const discoveredPaths = await findManifestFiles(scanRoot);
      for (const discoveredPath of discoveredPaths) {
        resolvedPaths.add(discoveredPath);
      }
    }
  }
  return [...resolvedPaths].sort();
}

async function walkDirectory(currentDirectory, manifestPaths) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const resolvedPath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!IgnoredDirectoryNames.has(entry.name)) {
        await walkDirectory(resolvedPath, manifestPaths);
      }
      continue;
    }
    if (entry.isFile() && entry.name === "manifest.json") {
      manifestPaths.push(resolvedPath);
    }
  }
}
