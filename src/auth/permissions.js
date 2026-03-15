import { canonicalBytes } from "./canonicalize.js";
import { bytesToHex, hexToBytes, toUint8Array } from "../utils/encoding.js";
import { randomBytes, sha256Bytes } from "../utils/crypto.js";

function normalizeCapabilityList(capabilities) {
  if (!Array.isArray(capabilities)) {
    return [];
  }
  return capabilities
    .map((capability) => String(capability ?? "").trim())
    .filter(Boolean);
}

function normalizeTarget(target = null) {
  if (typeof target === "string") {
    return {
      kind: "remote",
      id: null,
      audience: null,
      url: target,
    };
  }
  return {
    kind: target?.kind ?? "remote",
    id: target?.id ?? target?.targetId ?? null,
    audience: target?.audience ?? null,
    url: target?.url ?? null,
  };
}

export async function createDeploymentAuthorization(options = {}) {
  const issuedAt = Number(options.issuedAt ?? Date.now());
  const ttlMs = Number(options.ttlMs ?? 5 * 60 * 1000);
  const artifact = options.artifact ?? {};
  const target = normalizeTarget(options.target);

  return {
    version: 1,
    action: "deploy-flow",
    artifactId: String(artifact.artifactId ?? options.artifactId ?? "").trim(),
    programId: String(artifact.programId ?? options.programId ?? "").trim(),
    graphHash:
      artifact.graphHash ?? options.graphHash ?? null,
    manifestHash:
      artifact.manifestHash ?? options.manifestHash ?? null,
    target,
    capabilities: normalizeCapabilityList(
      options.capabilities ?? artifact.requiredCapabilities ?? [],
    ),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    nonce: options.nonce ?? bytesToHex(await randomBytes(16)),
    constraints: options.constraints ?? null,
  };
}

export function createHdWalletSigner(options = {}) {
  if (typeof options.signDigest !== "function") {
    throw new Error("createHdWalletSigner requires signDigest.");
  }
  const publicKeyHex = String(options.publicKeyHex ?? "").trim();
  if (!publicKeyHex) {
    throw new Error("createHdWalletSigner requires publicKeyHex.");
  }
  return {
    algorithm: options.algorithm ?? "secp256k1-sha256",
    curve: options.curve ?? "secp256k1",
    publicKeyHex,
    derivationPath: options.derivationPath ?? null,
    keyId: options.keyId ?? null,
    async sign(bytes) {
      const digest = await sha256Bytes(bytes);
      return toUint8Array(await options.signDigest(digest));
    },
  };
}

export function createHdWalletVerifier(options = {}) {
  if (typeof options.verifyDigest !== "function") {
    throw new Error("createHdWalletVerifier requires verifyDigest.");
  }
  return {
    async verify(bytes, signature, header, payload) {
      const digest = await sha256Bytes(bytes);
      return options.verifyDigest(digest, signature, header, payload);
    },
  };
}

export async function signAuthorization({ authorization, signer }) {
  if (!signer || typeof signer.sign !== "function") {
    throw new Error("signAuthorization requires a signer.");
  }
  const payload = authorization ?? {};
  const payloadBytes = canonicalBytes(payload);
  const signature = await signer.sign(payloadBytes);
  return {
    protected: {
      algorithm: signer.algorithm ?? "unknown",
      curve: signer.curve ?? null,
      publicKeyHex: signer.publicKeyHex ?? null,
      derivationPath: signer.derivationPath ?? null,
      keyId: signer.keyId ?? null,
    },
    payload,
    signatureHex: bytesToHex(signature),
  };
}

export async function verifyAuthorization({
  envelope,
  verifier,
  now = Date.now(),
}) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("verifyAuthorization requires a verifier.");
  }
  if (!envelope?.payload || !envelope?.signatureHex) {
    return false;
  }
  if (
    typeof envelope.payload.expiresAt === "number" &&
    envelope.payload.expiresAt < now
  ) {
    return false;
  }
  const payloadBytes = canonicalBytes(envelope.payload);
  return verifier.verify(
    payloadBytes,
    hexToBytes(envelope.signatureHex),
    envelope.protected ?? {},
    envelope.payload,
  );
}

export function assertDeploymentAuthorization({
  envelope,
  artifact,
  target,
  requiredCapabilities = [],
  now = Date.now(),
}) {
  const payload = envelope?.payload;
  if (!payload) {
    throw new Error("Deployment authorization envelope is missing payload.");
  }
  if (payload.action !== "deploy-flow") {
    throw new Error(`Unexpected authorization action "${payload.action}".`);
  }
  if (typeof payload.expiresAt === "number" && payload.expiresAt < now) {
    throw new Error("Deployment authorization has expired.");
  }
  if (artifact?.artifactId && payload.artifactId !== artifact.artifactId) {
    throw new Error("Deployment authorization artifactId mismatch.");
  }
  if (artifact?.programId && payload.programId !== artifact.programId) {
    throw new Error("Deployment authorization programId mismatch.");
  }
  if (artifact?.graphHash && payload.graphHash !== artifact.graphHash) {
    throw new Error("Deployment authorization graphHash mismatch.");
  }
  if (artifact?.manifestHash && payload.manifestHash !== artifact.manifestHash) {
    throw new Error("Deployment authorization manifestHash mismatch.");
  }

  const normalizedTarget = normalizeTarget(target);
  if (
    normalizedTarget.id &&
    payload.target?.id &&
    normalizedTarget.id !== payload.target.id
  ) {
    throw new Error("Deployment authorization target id mismatch.");
  }
  if (
    normalizedTarget.audience &&
    payload.target?.audience &&
    normalizedTarget.audience !== payload.target.audience
  ) {
    throw new Error("Deployment authorization target audience mismatch.");
  }

  const granted = new Set(normalizeCapabilityList(payload.capabilities));
  for (const capability of normalizeCapabilityList(requiredCapabilities)) {
    if (!granted.has(capability)) {
      throw new Error(`Deployment authorization missing capability "${capability}".`);
    }
  }
  return true;
}
