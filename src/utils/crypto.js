import { toUint8Array } from "./encoding.js";

export function getCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("WebCrypto is required.");
  }
  return cryptoApi;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

export async function sha256Bytes(value) {
  const bytes = toUint8Array(value);
  const digest = await getCrypto().subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}
