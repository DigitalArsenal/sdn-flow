import { RecommendedCapabilityIds } from "../compliance/index.js";
import { HostedRuntimeAdapter, HostedRuntimeEngine } from "./constants.js";

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

export default {
  evaluateHostedCapabilitySupport,
  listHostedRuntimeCapabilities,
  normalizeHostedRuntimeEngine,
};
