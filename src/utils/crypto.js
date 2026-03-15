export function getCrypto() {
  throw new Error(
    "Direct WebCrypto access is forbidden. Use the WASM crypto helpers instead.",
  );
}

export { randomBytes, sha256Bytes } from "./wasmCrypto.js";
