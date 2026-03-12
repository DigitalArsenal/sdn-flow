import { canonicalBytes } from "../auth/canonicalize.js";
import {
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
  toUint8Array,
} from "../utils/encoding.js";
import { getCrypto, randomBytes } from "../utils/crypto.js";

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

function buildPkcs8(privateKeyBytes) {
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8Key = new Uint8Array(pkcs8Header.length + privateKeyBytes.length);
  pkcs8Key.set(pkcs8Header, 0);
  pkcs8Key.set(privateKeyBytes, pkcs8Header.length);
  return pkcs8Key;
}

async function importPrivateKey(privateKey) {
  return getCrypto().subtle.importKey(
    "pkcs8",
    buildPkcs8(normalizePrivateKey(privateKey)),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
}

async function importPublicKey(publicKey) {
  return getCrypto().subtle.importKey(
    "raw",
    normalizePublicKey(publicKey),
    { name: "X25519" },
    false,
    [],
  );
}

async function deriveSharedSecret(privateKey, publicKey) {
  const sharedBits = await getCrypto().subtle.deriveBits(
    {
      name: "X25519",
      public: await importPublicKey(publicKey),
    },
    await importPrivateKey(privateKey),
    256,
  );
  return new Uint8Array(sharedBits);
}

async function deriveAesKey(sharedSecret, salt, context) {
  const hkdfKey = await getCrypto().subtle.importKey(
    "raw",
    sharedSecret,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return getCrypto().subtle.deriveKey(
    {
      name: "HKDF",
      salt,
      info: new TextEncoder().encode(context),
      hash: "SHA-256",
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateX25519Keypair() {
  const keyPair = await getCrypto().subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  const publicKeyBuffer = await getCrypto().subtle.exportKey(
    "raw",
    keyPair.publicKey,
  );
  const privateKeyBuffer = await getCrypto().subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );
  const privateKey = new Uint8Array(privateKeyBuffer).slice(16, 48);
  return {
    publicKey: new Uint8Array(publicKeyBuffer),
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
  const salt = randomBytes(32);
  salt.set(HKDF_SALT_LABEL.slice(0, Math.min(HKDF_SALT_LABEL.length, salt.length)));
  const iv = randomBytes(12);
  const sharedSecret = await deriveSharedSecret(
    sender.privateKey,
    recipientPublicKey,
  );
  const aesKey = await deriveAesKey(sharedSecret, salt, context);
  const ciphertext = await getCrypto().subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    toUint8Array(plaintext),
  );
  return {
    version: 1,
    scheme: "x25519-hkdf-aes-256-gcm",
    context,
    senderPublicKeyBase64: bytesToBase64(sender.publicKey),
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)),
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
  const plaintext = await getCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.ivBase64) },
    aesKey,
    base64ToBytes(envelope.ciphertextBase64),
  );
  return new Uint8Array(plaintext);
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
