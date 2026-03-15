import { canonicalBytes } from "../auth/canonicalize.js";
import {
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
  toUint8Array,
} from "../utils/encoding.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfBytes,
  randomBytes,
  x25519PublicKey,
  x25519SharedSecret,
} from "../utils/wasmCrypto.js";

const HKDF_SALT_LABEL = new TextEncoder().encode("sdn-flow");

function normalizePublicKey(value) {
  if (typeof value === "string") {
    return hexToBytes(value);
  }
  return toUint8Array(value);
}

function normalizePrivateKey(value) {
  if (typeof value === "string") {
    return hexToBytes(value);
  }
  return toUint8Array(value);
}

async function deriveSharedSecret(privateKey, publicKey) {
  return x25519SharedSecret(
    normalizePrivateKey(privateKey),
    normalizePublicKey(publicKey),
  );
}

async function deriveAesKey(sharedSecret, salt, context) {
  return hkdfBytes(
    sharedSecret,
    salt,
    new TextEncoder().encode(context),
    32,
  );
}

export async function generateX25519Keypair() {
  const privateKey = await randomBytes(32);
  const publicKey = await x25519PublicKey(privateKey);
  return {
    publicKey,
    privateKey,
  };
}

export async function encryptBytesForRecipient({
  plaintext,
  recipientPublicKey,
  context = "sdn-flow/deploy",
  senderKeyPair = null,
} = {}) {
  if (!recipientPublicKey) {
    throw new Error("encryptBytesForRecipient requires recipientPublicKey.");
  }
  const sender = senderKeyPair ?? (await generateX25519Keypair());
  const salt = await randomBytes(32);
  salt.set(HKDF_SALT_LABEL.slice(0, Math.min(HKDF_SALT_LABEL.length, salt.length)));
  const iv = await randomBytes(12);
  const sharedSecret = await deriveSharedSecret(
    sender.privateKey,
    recipientPublicKey,
  );
  const aesKey = await deriveAesKey(sharedSecret, salt, context);
  const { ciphertext, tag } = await aesGcmEncrypt(
    aesKey,
    toUint8Array(plaintext),
    iv,
  );
  const packedCiphertext = new Uint8Array(ciphertext.length + tag.length);
  packedCiphertext.set(ciphertext, 0);
  packedCiphertext.set(tag, ciphertext.length);
  return {
    version: 1,
    scheme: "x25519-hkdf-aes-256-gcm",
    context,
    senderPublicKeyBase64: bytesToBase64(sender.publicKey),
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(packedCiphertext),
  };
}

export async function decryptBytesFromEnvelope({
  envelope,
  recipientPrivateKey,
} = {}) {
  if (!envelope || !recipientPrivateKey) {
    throw new Error("decryptBytesFromEnvelope requires envelope and recipientPrivateKey.");
  }
  const sharedSecret = await deriveSharedSecret(
    recipientPrivateKey,
    base64ToBytes(envelope.senderPublicKeyBase64),
  );
  const aesKey = await deriveAesKey(
    sharedSecret,
    base64ToBytes(envelope.saltBase64),
    envelope.context,
  );
  const packedCiphertext = base64ToBytes(envelope.ciphertextBase64);
  if (packedCiphertext.length < 16) {
    throw new Error("Encrypted envelope payload is truncated.");
  }
  const ciphertext = packedCiphertext.slice(0, packedCiphertext.length - 16);
  const tag = packedCiphertext.slice(packedCiphertext.length - 16);
  return aesGcmDecrypt(
    aesKey,
    ciphertext,
    tag,
    base64ToBytes(envelope.ivBase64),
  );
}

export async function encryptJsonForRecipient(options = {}) {
  return encryptBytesForRecipient({
    ...options,
    plaintext: canonicalBytes(options.payload ?? {}),
  });
}

export async function decryptJsonFromEnvelope(options = {}) {
  const bytes = await decryptBytesFromEnvelope(options);
  return JSON.parse(new TextDecoder().decode(bytes));
}
