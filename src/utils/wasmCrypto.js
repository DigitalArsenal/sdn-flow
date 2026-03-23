import { toUint8Array } from "./encoding.js";
import { getHdWalletRuntime } from "./hdWalletRuntime.js";

let walletPromise = null;

export async function getWasmWallet() {
  if (!walletPromise) {
    walletPromise = getHdWalletRuntime();
  }

  return walletPromise;
}

export async function randomBytes(length) {
  const wallet = await getWasmWallet();
  return wallet.utils.getRandomBytes(length);
}

export async function sha256Bytes(value) {
  const wallet = await getWasmWallet();
  return wallet.utils.sha256(toUint8Array(value));
}

export async function hkdfBytes(ikm, salt, info, length) {
  const wallet = await getWasmWallet();
  return wallet.utils.hkdf(
    toUint8Array(ikm),
    toUint8Array(salt),
    toUint8Array(info),
    length,
  );
}

export async function x25519PublicKey(privateKey) {
  const wallet = await getWasmWallet();
  return wallet.curves.x25519.publicKey(toUint8Array(privateKey));
}

export async function x25519SharedSecret(privateKey, publicKey) {
  const wallet = await getWasmWallet();
  return wallet.curves.x25519.ecdh(
    toUint8Array(privateKey),
    toUint8Array(publicKey),
  );
}

export async function aesGcmEncrypt(key, plaintext, iv, aad = null) {
  const wallet = await getWasmWallet();
  return wallet.utils.aesGcm.encrypt(
    toUint8Array(key),
    toUint8Array(plaintext),
    toUint8Array(iv),
    aad ? toUint8Array(aad) : undefined,
  );
}

export async function aesGcmDecrypt(key, ciphertext, tag, iv, aad = null) {
  const wallet = await getWasmWallet();
  return wallet.utils.aesGcm.decrypt(
    toUint8Array(key),
    toUint8Array(ciphertext),
    toUint8Array(tag),
    toUint8Array(iv),
    aad ? toUint8Array(aad) : undefined,
  );
}
