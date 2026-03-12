import test from "node:test";
import assert from "node:assert/strict";

import {
  assertDeploymentAuthorization,
  createDeploymentAuthorization,
  createHdWalletSigner,
  createHdWalletVerifier,
  signAuthorization,
  verifyAuthorization,
} from "../src/index.js";

test("deployment authorization can be signed and verified", async () => {
  const signer = createHdWalletSigner({
    publicKeyHex: "02deadbeef",
    derivationPath: "m/44'/501'/0'/0/0",
    async signDigest(digest) {
      return digest;
    },
  });
  const verifier = createHdWalletVerifier({
    async verifyDigest(digest, signature) {
      assert.deepEqual(Array.from(signature), Array.from(digest));
      return true;
    },
  });

  const artifact = {
    artifactId: "flow:abc",
    programId: "flow.program",
    graphHash: "abc123",
    manifestHash: "manifest123",
    requiredCapabilities: ["pubsub", "timers"],
  };
  const authorization = createDeploymentAuthorization({
    artifact,
    target: {
      kind: "remote",
      id: "node-1",
      audience: "sdn://node-1",
    },
    ttlMs: 60_000,
  });
  const envelope = await signAuthorization({ authorization, signer });
  const ok = await verifyAuthorization({ envelope, verifier });

  assert.equal(ok, true);
  assert.equal(
    assertDeploymentAuthorization({
      envelope,
      artifact,
      target: {
        kind: "remote",
        id: "node-1",
        audience: "sdn://node-1",
      },
      requiredCapabilities: ["pubsub"],
    }),
    true,
  );
});
