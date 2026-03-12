import { bytesToBase64 } from "../utils/encoding.js";
import { sha256Bytes } from "../utils/crypto.js";

function normalizeCanonicalValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical payloads cannot contain non-finite numbers.");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return {
      __type: "bytes",
      base64: bytesToBase64(
        value instanceof Uint8Array
          ? value
          : new Uint8Array(
              value.buffer ?? value,
              value.byteOffset ?? 0,
              value.byteLength ?? value.byteLength,
            ),
      ),
    };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeCanonicalValue(item);
      return normalized === undefined ? null : normalized;
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeCanonicalValue(nestedValue)]);
    return Object.fromEntries(entries);
  }
  throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
}

export function stableStringify(value) {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(stableStringify(value));
}

export async function hashCanonicalValue(value) {
  return sha256Bytes(canonicalBytes(value));
}
