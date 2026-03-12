import test from "node:test";
import assert from "node:assert/strict";

import {
  decryptJsonFromEnvelope,
  encryptJsonForRecipient,
  generateX25519Keypair,
} from "../src/index.js";

test("json deployment payloads can be encrypted and decrypted", async () => {
  const recipient = await generateX25519Keypair();
  const envelope = await encryptJsonForRecipient({
    payload: {
      version: 1,
      kind: "compiled-flow-wasm-deployment",
      artifactId: "flow:123",
    },
    recipientPublicKey: recipient.publicKey,
    context: "sdn-flow/test",
  });
  const payload = await decryptJsonFromEnvelope({
    envelope,
    recipientPrivateKey: recipient.privateKey,
  });

  assert.equal(payload.kind, "compiled-flow-wasm-deployment");
  assert.equal(payload.artifactId, "flow:123");
});
