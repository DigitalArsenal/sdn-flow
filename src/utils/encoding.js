function assertByteValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError("Expected byte values in range 0..255.");
  }
}

export function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    value.forEach(assertByteValue);
    return Uint8Array.from(value);
  }
  throw new TypeError("Expected Uint8Array, ArrayBuffer, ArrayBufferView, or byte array.");
}

export function bytesToHex(bytes) {
  return Array.from(toUint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function hexToBytes(hex) {
  const normalized = String(hex ?? "").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new TypeError("Expected even-length hex string.");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  const normalized = toUint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized).toString("base64");
  }
  let binary = "";
  for (const byte of normalized) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const normalized = String(base64 ?? "").trim();
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(normalized, "base64"));
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
