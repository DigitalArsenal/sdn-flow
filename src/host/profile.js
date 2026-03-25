import { RuntimeTarget } from "../runtime/index.js";
import { HostedRuntimeAdapter, HostedRuntimeEngine } from "./constants.js";

const RecommendedCapabilityIds = Object.freeze([
  "clock",
  "random",
  "logging",
  "timers",
  "schedule_cron",
  "http",
  "tls",
  "websocket",
  "mqtt",
  "tcp",
  "udp",
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
  "context_read",
  "context_write",
  "process_exec",
  "crypto_hash",
  "crypto_sign",
  "crypto_verify",
  "crypto_encrypt",
  "crypto_decrypt",
  "crypto_key_agreement",
  "crypto_kdf",
  "wallet_sign",
  "ipfs",
  "scene_access",
  "entity_access",
  "render_hooks",
]);

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeString(value, null))
    .filter((value) => value !== null);
}

function normalizeRuntimeTarget(value, fallback = null) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return fallback;
  }
  return Object.values(RuntimeTarget).includes(normalized)
    ? normalized
    : fallback;
}

function normalizeRuntimeTargetArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeRuntimeTarget(value, null))
        .filter((value) => value !== null),
    ),
  ).sort();
}

const AllKnownCapabilities = Object.freeze(
  Array.from(new Set(RecommendedCapabilityIds)).sort(),
);

const BrowserCapabilityProfile = Object.freeze([
  "clock",
  "random",
  "logging",
  "timers",
  "schedule_cron",
  "http",
  "websocket",
  "pubsub",
  "protocol_dial",
  "storage_query",
  "context_read",
  "context_write",
  "crypto_hash",
  "crypto_sign",
  "crypto_verify",
  "crypto_encrypt",
  "crypto_decrypt",
  "crypto_key_agreement",
  "crypto_kdf",
  "scene_access",
  "entity_access",
  "render_hooks",
]);

const WasiCapabilityProfile = Object.freeze([
  "clock",
  "random",
  "pipe",
  "filesystem",
  "storage_query",
  "context_read",
  "crypto_hash",
]);

const EngineCapabilityProfiles = Object.freeze({
  [HostedRuntimeEngine.NODE]: AllKnownCapabilities,
  [HostedRuntimeEngine.DENO]: AllKnownCapabilities,
  [HostedRuntimeEngine.BUN]: AllKnownCapabilities,
  [HostedRuntimeEngine.BROWSER]: BrowserCapabilityProfile,
  [HostedRuntimeEngine.WASI]: WasiCapabilityProfile,
  [HostedRuntimeEngine.GO]: AllKnownCapabilities,
});

export function normalizeHostedRuntimeEngine(value, fallback = null) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return fallback;
  }
  return Object.values(HostedRuntimeEngine).includes(normalized)
    ? normalized
    : fallback;
}

export function listHostedRuntimeTargets({
  hostKind = null,
  adapter = null,
  engine = null,
} = {}) {
  const normalizedHostKind = normalizeString(hostKind, null);
  const normalizedAdapter = normalizeString(adapter, null);
  const normalizedEngine = normalizeHostedRuntimeEngine(engine, null);
  const targets = new Set();

  if (normalizedHostKind === "wasmedge") {
    targets.add(RuntimeTarget.WASMEDGE);
    targets.add(RuntimeTarget.WASI);
    targets.add(RuntimeTarget.SERVER);
    targets.add(RuntimeTarget.EDGE);
  }

  switch (normalizedEngine) {
    case HostedRuntimeEngine.BROWSER:
      targets.add(RuntimeTarget.BROWSER);
      break;
    case HostedRuntimeEngine.NODE:
      targets.add(RuntimeTarget.NODE);
      targets.add(RuntimeTarget.SERVER);
      break;
    case HostedRuntimeEngine.DENO:
    case HostedRuntimeEngine.BUN:
    case HostedRuntimeEngine.GO:
      targets.add(RuntimeTarget.SERVER);
      break;
    case HostedRuntimeEngine.WASI:
      targets.add(RuntimeTarget.WASI);
      break;
    default:
      break;
  }

  if (normalizedAdapter === HostedRuntimeAdapter.GO_SDN) {
    targets.add(RuntimeTarget.SERVER);
  }
  if (
    normalizedAdapter === HostedRuntimeAdapter.SDN_JS &&
    normalizedEngine === HostedRuntimeEngine.BROWSER
  ) {
    targets.add(RuntimeTarget.BROWSER);
  }
  if (
    normalizedAdapter === HostedRuntimeAdapter.HOST_INTERNAL &&
    normalizedEngine === HostedRuntimeEngine.WASI
  ) {
    targets.add(RuntimeTarget.WASI);
  }

  return Array.from(targets).sort();
}

export function listHostedRuntimeCapabilities({ adapter = null, engine = null } = {}) {
  const normalizedAdapter = normalizeString(adapter, null);
  const normalizedEngine = normalizeHostedRuntimeEngine(engine, null);

  if (normalizedAdapter === HostedRuntimeAdapter.GO_SDN) {
    return [...AllKnownCapabilities];
  }

  if (
    normalizedAdapter === HostedRuntimeAdapter.SDN_JS ||
    normalizedEngine !== null
  ) {
    return [
      ...(
        EngineCapabilityProfiles[
          normalizedEngine ?? HostedRuntimeEngine.NODE
        ] ?? AllKnownCapabilities
      ),
    ];
  }

  return [...AllKnownCapabilities];
}

export function evaluateHostedCapabilitySupport({
  adapter = null,
  engine = null,
  requiredCapabilities = [],
} = {}) {
  const supportedCapabilities = listHostedRuntimeCapabilities({
    adapter,
    engine,
  });
  const supportedSet = new Set(supportedCapabilities);
  const normalizedRequired = Array.from(
    new Set(normalizeStringArray(requiredCapabilities)),
  ).sort();
  const unsupportedCapabilities = normalizedRequired.filter(
    (capability) => !supportedSet.has(capability),
  );

  return {
    adapter: normalizeString(adapter, null),
    engine: normalizeHostedRuntimeEngine(engine, null),
    supportedCapabilities,
    requiredCapabilities: normalizedRequired,
    unsupportedCapabilities,
    ok: unsupportedCapabilities.length === 0,
  };
}

export function evaluateHostedRuntimeTargetSupport({
  hostKind = null,
  adapter = null,
  engine = null,
  runtimeTargets = [],
} = {}) {
  const supportedTargets = listHostedRuntimeTargets({
    hostKind,
    adapter,
    engine,
  });
  const supportedSet = new Set(supportedTargets);
  const normalizedTargets = normalizeRuntimeTargetArray(runtimeTargets);
  const unsupportedTargets = normalizedTargets.filter(
    (runtimeTarget) => !supportedSet.has(runtimeTarget),
  );

  return {
    hostKind: normalizeString(hostKind, null),
    adapter: normalizeString(adapter, null),
    engine: normalizeHostedRuntimeEngine(engine, null),
    runtimeTargets: normalizedTargets,
    supportedTargets,
    unsupportedTargets,
    ok: unsupportedTargets.length === 0,
  };
}

export function describeHostedRuntimeTargetProfile({
  hostKind = null,
  runtimeTargets = [],
} = {}) {
  const normalizedHostKind = normalizeString(hostKind, null);
  const normalizedTargets = normalizeRuntimeTargetArray(runtimeTargets);
  if (normalizedTargets.includes(RuntimeTarget.WASMEDGE)) {
    return {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.WASMEDGE,
    };
  }
  if (normalizedTargets.includes(RuntimeTarget.SERVER)) {
    return {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.SERVER,
    };
  }
  if (normalizedTargets.includes(RuntimeTarget.WASI)) {
    return {
      runtimeTargetClass: "standalone",
      standardRuntimeTarget: RuntimeTarget.WASI,
    };
  }
  if (normalizedTargets.includes(RuntimeTarget.BROWSER)) {
    return {
      runtimeTargetClass: "delegated",
      standardRuntimeTarget: RuntimeTarget.BROWSER,
    };
  }
  if (normalizedHostKind === "wasmedge") {
    return {
      runtimeTargetClass: "server-side",
      standardRuntimeTarget: RuntimeTarget.WASMEDGE,
    };
  }
  return {
    runtimeTargetClass: null,
    standardRuntimeTarget: null,
  };
}

export default {
  evaluateHostedCapabilitySupport,
  evaluateHostedRuntimeTargetSupport,
  describeHostedRuntimeTargetProfile,
  listHostedRuntimeCapabilities,
  listHostedRuntimeTargets,
  normalizeHostedRuntimeEngine,
};
