import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import * as flatbuffers from "flatbuffers";

import {
  FlowDesignerSession,
  FlowRuntime,
  MethodRegistry,
} from "../src/index.js";
import { getWasmWallet } from "../src/utils/wasmCrypto.js";

const { Builder, ByteBuffer } = flatbuffers;

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function buildFrame(
  portId,
  schemaName,
  fileIdentifier,
  payload,
  overrides = {},
) {
  return {
    portId,
    typeRef: {
      schemaName,
      fileIdentifier,
      schemaHash: [5, 4, 3, 2],
    },
    alignment: 8,
    offset: overrides.offset ?? 4096,
    size: overrides.size ?? 64,
    ownership: "shared",
    generation: 0,
    mutability: "immutable",
    traceId: overrides.traceId ?? `${schemaName}:${portId}`,
    streamId: overrides.streamId ?? 1,
    sequence: overrides.sequence ?? 1,
    payload,
  };
}

function vectorBytes(bb, tablePosition, fieldOffset) {
  const offset = bb.__offset(tablePosition, fieldOffset);
  if (!offset) {
    return new Uint8Array(0);
  }
  const start = bb.__vector(tablePosition + offset);
  const length = bb.__vector_len(tablePosition + offset);
  return bb.bytes().slice(start, start + length);
}

class CatalogEntryRecord {
  bb = null;
  bb_pos = 0;

  static getRoot(data) {
    const bb = new ByteBuffer(data);
    return new CatalogEntryRecord().__init(
      bb.readInt32(bb.position()) + bb.position(),
      bb,
    );
  }

  __init(position, bb) {
    this.bb_pos = position;
    this.bb = bb;
    return this;
  }

  noradCatId() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }

  objectName() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }

  observerNote() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }

  source() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }
}

function buildCatalogEntry({ noradCatId, objectName, observerNote, source }) {
  const builder = new Builder(256);
  const objectNameOffset = builder.createString(objectName);
  const observerNoteOffset = builder.createString(observerNote);
  const sourceOffset = builder.createString(source);

  builder.startObject(4);
  builder.addFieldInt32(0, noradCatId, 0);
  builder.addFieldOffset(1, objectNameOffset, 0);
  builder.addFieldOffset(2, observerNoteOffset, 0);
  builder.addFieldOffset(3, sourceOffset, 0);
  const root = builder.endObject();
  builder.finish(root, "CATE");

  return builder.asUint8Array().slice();
}

class ProtectedCatalogEntryRecord {
  bb = null;
  bb_pos = 0;

  static getRoot(data) {
    const bb = new ByteBuffer(data);
    return new ProtectedCatalogEntryRecord().__init(
      bb.readInt32(bb.position()) + bb.position(),
      bb,
    );
  }

  __init(position, bb) {
    this.bb_pos = position;
    this.bb = bb;
    return this;
  }

  noradCatId() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }

  objectName() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }

  source() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }

  encryptedObserverNote() {
    return vectorBytes(this.bb, this.bb_pos, 10);
  }

  cipherSuite() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__string(this.bb_pos + offset) : "";
  }
}

function buildProtectedCatalogEntry({
  noradCatId,
  objectName,
  source,
  encryptedObserverNote,
  cipherSuite,
}) {
  const builder = new Builder(512);
  const objectNameOffset = builder.createString(objectName);
  const sourceOffset = builder.createString(source);
  const encryptedOffset = builder.createByteVector(encryptedObserverNote);
  const cipherSuiteOffset = builder.createString(cipherSuite);

  builder.startObject(5);
  builder.addFieldInt32(0, noradCatId, 0);
  builder.addFieldOffset(1, objectNameOffset, 0);
  builder.addFieldOffset(2, sourceOffset, 0);
  builder.addFieldOffset(3, encryptedOffset, 0);
  builder.addFieldOffset(4, cipherSuiteOffset, 0);
  const root = builder.endObject();
  builder.finish(root, "PRTC");

  return builder.asUint8Array().slice();
}

function buildCollectorManifest() {
  return {
    pluginId: "com.digitalarsenal.test.collector",
    name: "Collector",
    version: "0.1.0",
    pluginFamily: "test",
    methods: [
      {
        methodId: "collect_protected",
        inputPorts: [
          {
            portId: "in",
            acceptedTypeSets: [
              {
                setId: "protected-record",
                allowedTypes: [
                  {
                    schemaName: "ProtectedCatalogEntry.fbs",
                    fileIdentifier: "PRTC",
                  },
                ],
              },
            ],
            minStreams: 1,
            maxStreams: 1,
            required: true,
          },
        ],
        outputPorts: [],
        maxBatch: 64,
      },
      {
        methodId: "collect_signature",
        inputPorts: [
          {
            portId: "in",
            acceptedTypeSets: [
              {
                setId: "signature",
                allowedTypes: [
                  {
                    schemaName: "DetachedSignature.fbs",
                    fileIdentifier: "SIGD",
                  },
                ],
              },
            ],
            minStreams: 1,
            maxStreams: 1,
            required: true,
          },
        ],
        outputPorts: [],
        maxBatch: 64,
      },
    ],
  };
}

function withCollectorNodes(program) {
  const cloned = structuredClone(program);
  cloned.nodes.push(
    {
      nodeId: "collect-protected-record",
      pluginId: "com.digitalarsenal.test.collector",
      methodId: "collect_protected",
      kind: "sink",
      drainPolicy: "drain-until-yield",
    },
    {
      nodeId: "collect-signature",
      pluginId: "com.digitalarsenal.test.collector",
      methodId: "collect_signature",
      kind: "sink",
      drainPolicy: "drain-until-yield",
    },
  );
  cloned.edges.push(
    {
      fromNodeId: "pack-record",
      fromPortId: "protected_record",
      toNodeId: "collect-protected-record",
      toPortId: "in",
    },
    {
      fromNodeId: "sign-record",
      fromPortId: "signature",
      toNodeId: "collect-signature",
      toPortId: "in",
    },
  );
  cloned.requiredPlugins.push("com.digitalarsenal.test.collector");
  return cloned;
}

test("field-protection example surfaces hd-wallet-wasm and da-flatbuffers as normal flow plugins", async () => {
  const flow = await readJson(
    "../examples/flows/field-protected-catalog-entry/flow.json",
  );
  const manifests = await Promise.all([
    readJson("../examples/plugins/da-flatbuffers-codec/manifest.json"),
    readJson("../examples/plugins/hd-wallet-crypto/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["random", "wallet_sign"]);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "host-service" && item.resource === "wallet://active-key",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "host-service" && item.resource === "host-rng://default",
    ),
    true,
  );
  assert.equal(
    summary.plugins.some(
      (plugin) =>
        plugin.pluginId ===
          "com.digitalarsenal.infrastructure.da-flatbuffers" &&
        plugin.resolved === true,
    ),
    true,
  );
  assert.equal(
    summary.plugins.some(
      (plugin) =>
        plugin.pluginId ===
          "com.digitalarsenal.infrastructure.hd-wallet-wasm" &&
        plugin.resolved === true,
    ),
    true,
  );
});

test("field-protection example can encrypt selected FlatBuffer fields and sign the protected record inside the flow runtime", async () => {
  const wallet = await getWasmWallet();
  const registry = new MethodRegistry();
  const protectedRecords = [];
  const signatures = [];
  const encryptedFieldSets = [];

  const daFlatbuffersManifest = await readJson(
    "../examples/plugins/da-flatbuffers-codec/manifest.json",
  );
  const hdWalletManifest = await readJson(
    "../examples/plugins/hd-wallet-crypto/manifest.json",
  );
  const collectorManifest = buildCollectorManifest();
  const flow = withCollectorNodes(
    await readJson("../examples/flows/field-protected-catalog-entry/flow.json"),
  );

  registry.registerPlugin({
    manifest: daFlatbuffersManifest,
    handlers: {
      extract_fields: ({ inputs }) => {
        const request = inputs.at(-1)?.payload;
        const record = CatalogEntryRecord.getRoot(request.recordBytes);
        const protectedPaths = new Set(request.protectedFields ?? []);
        const publicFields = {
          noradCatId: record.noradCatId(),
          objectName: record.objectName(),
          source: record.source(),
          signerPrivateKey: request.signerPrivateKey,
        };
        const protectedFieldSet = {
          senderPrivateKey: request.senderPrivateKey,
          recipientPublicKey: request.recipientPublicKey,
          fields: [],
        };

        if (protectedPaths.has("observerNote")) {
          protectedFieldSet.fields.push({
            fieldPath: "observerNote",
            plaintext: new TextEncoder().encode(record.observerNote()),
          });
        }

        return {
          outputs: [
            buildFrame(
              "public_fields",
              "FieldSelectionBundle.fbs",
              "FSLB",
              publicFields,
              {
                traceId: inputs[0].traceId,
                sequence: inputs[0].sequence,
              },
            ),
            buildFrame(
              "protected_fields",
              "FieldSelectionBundle.fbs",
              "FSLB",
              protectedFieldSet,
              {
                traceId: inputs[0].traceId,
                sequence: inputs[0].sequence,
              },
            ),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
      pack_protected_record: ({ inputs }) => {
        const publicFields = inputs.find(
          (input) => input.portId === "public_fields",
        )?.payload;
        const encryptedFieldSet = inputs.find(
          (input) => input.portId === "encrypted_fields",
        )?.payload;
        const encryptedObserverNote =
          encryptedFieldSet?.fields?.find(
            (field) => field.fieldPath === "observerNote",
          ) ?? null;

        if (!publicFields || !encryptedObserverNote) {
          throw new Error(
            "pack_protected_record requires public and encrypted fields.",
          );
        }

        const packedEncryptedField = new Uint8Array(
          encryptedObserverNote.iv.length +
            encryptedObserverNote.tag.length +
            encryptedObserverNote.ciphertext.length,
        );
        packedEncryptedField.set(encryptedObserverNote.iv, 0);
        packedEncryptedField.set(
          encryptedObserverNote.tag,
          encryptedObserverNote.iv.length,
        );
        packedEncryptedField.set(
          encryptedObserverNote.ciphertext,
          encryptedObserverNote.iv.length + encryptedObserverNote.tag.length,
        );

        const protectedRecordBytes = buildProtectedCatalogEntry({
          noradCatId: publicFields.noradCatId,
          objectName: publicFields.objectName,
          source: publicFields.source,
          encryptedObserverNote: packedEncryptedField,
          cipherSuite: encryptedObserverNote.algorithm,
        });

        return {
          outputs: [
            buildFrame(
              "protected_record",
              "ProtectedCatalogEntry.fbs",
              "PRTC",
              {
                protectedRecordBytes,
                signerPrivateKey: publicFields.signerPrivateKey,
                encryptionEnvelope: encryptedObserverNote,
              },
              {
                traceId: inputs[0].traceId,
                sequence: inputs[0].sequence,
                size: protectedRecordBytes.length,
              },
            ),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  registry.registerPlugin({
    manifest: hdWalletManifest,
    handlers: {
      encrypt_fields: ({ inputs }) => {
        const fieldSet = inputs.at(-1)?.payload;
        const fields = [];

        for (const field of fieldSet.fields ?? []) {
          const salt = wallet.utils.getRandomBytes(32);
          const iv = wallet.utils.getRandomBytes(12);
          const senderPublicKey = wallet.curves.x25519.publicKey(
            fieldSet.senderPrivateKey,
          );
          const sharedSecret = wallet.curves.x25519.ecdh(
            fieldSet.senderPrivateKey,
            fieldSet.recipientPublicKey,
          );
          const info = new TextEncoder().encode(`field:${field.fieldPath}`);
          const aesKey = wallet.utils.hkdf(sharedSecret, salt, info, 32);
          const { ciphertext, tag } = wallet.utils.aesGcm.encrypt(
            aesKey,
            field.plaintext,
            iv,
          );

          fields.push({
            fieldPath: field.fieldPath,
            algorithm: "x25519-hkdf-aes-256-gcm",
            salt,
            iv,
            tag,
            ciphertext,
            senderPublicKey,
          });
        }

        const payload = { fields };
        encryptedFieldSets.push(payload);
        return {
          outputs: [
            buildFrame(
              "encrypted_fields",
              "EncryptedFieldSet.fbs",
              "EFLD",
              payload,
              {
                traceId: inputs[0].traceId,
                sequence: inputs[0].sequence,
              },
            ),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
      sign_detached: ({ inputs }) => {
        const message = inputs.at(-1)?.payload;
        const digest = wallet.utils.sha256(message.protectedRecordBytes);
        const signature = wallet.curves.secp256k1.sign(
          digest,
          message.signerPrivateKey,
        );
        const publicKey = wallet.curves.publicKeyFromPrivate(
          message.signerPrivateKey,
        );

        return {
          outputs: [
            buildFrame(
              "signature",
              "DetachedSignature.fbs",
              "SIGD",
              {
                algorithm: "secp256k1-sha256",
                digest,
                signature,
                publicKey,
                protectedRecordBytes: message.protectedRecordBytes,
              },
              {
                traceId: inputs[0].traceId,
                sequence: inputs[0].sequence,
              },
            ),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  registry.registerPlugin({
    manifest: collectorManifest,
    handlers: {
      collect_protected: ({ inputs }) => {
        protectedRecords.push(inputs[0].payload);
        return {
          outputs: [],
          backlogRemaining: 0,
          yielded: false,
        };
      },
      collect_signature: ({ inputs }) => {
        signatures.push(inputs[0].payload);
        return {
          outputs: [],
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  const runtime = new FlowRuntime({
    registry,
    maxInvocationsPerDrain: 64,
  });
  runtime.loadProgram(flow);

  const signerPrivateKey = wallet.utils.getRandomBytes(32);
  const senderPrivateKey = wallet.utils.getRandomBytes(32);
  const recipientPrivateKey = wallet.utils.getRandomBytes(32);
  const recipientPublicKey =
    wallet.curves.x25519.publicKey(recipientPrivateKey);
  const observerNote = "Classified observer note";
  const recordBytes = buildCatalogEntry({
    noradCatId: 25544,
    objectName: "ISS (ZARYA)",
    observerNote,
    source: "SeeSat-L",
  });

  runtime.enqueueTriggerFrames("manual-request", [
    buildFrame(
      "request",
      "FieldProtectionRequest.fbs",
      "FPRQ",
      {
        recordBytes,
        protectedFields: ["observerNote"],
        signerPrivateKey,
        senderPrivateKey,
        recipientPublicKey,
      },
      {
        traceId: "catalog-entry-25544",
        sequence: 1,
        size: recordBytes.length,
      },
    ),
  ]);

  const result = await runtime.drain();

  assert.equal(result.idle, true);
  assert.equal(protectedRecords.length, 1);
  assert.equal(signatures.length, 1);
  assert.equal(encryptedFieldSets.length, 1);

  const protectedRecordBytes = protectedRecords[0].protectedRecordBytes;
  const protectedRecord =
    ProtectedCatalogEntryRecord.getRoot(protectedRecordBytes);
  assert.equal(protectedRecord.noradCatId(), 25544);
  assert.equal(protectedRecord.objectName(), "ISS (ZARYA)");
  assert.equal(protectedRecord.source(), "SeeSat-L");
  assert.equal(protectedRecord.cipherSuite(), "x25519-hkdf-aes-256-gcm");
  assert.equal(
    Buffer.from(protectedRecord.encryptedObserverNote()).includes(
      Buffer.from(observerNote),
    ),
    false,
  );

  const encryptedField = encryptedFieldSets[0].fields[0];
  const decryptSharedSecret = wallet.curves.x25519.ecdh(
    recipientPrivateKey,
    encryptedField.senderPublicKey,
  );
  const decryptKey = wallet.utils.hkdf(
    decryptSharedSecret,
    encryptedField.salt,
    new TextEncoder().encode(`field:${encryptedField.fieldPath}`),
    32,
  );
  const decryptedObserverNote = wallet.utils.aesGcm.decrypt(
    decryptKey,
    encryptedField.ciphertext,
    encryptedField.tag,
    encryptedField.iv,
  );
  assert.equal(new TextDecoder().decode(decryptedObserverNote), observerNote);

  const signatureEnvelope = signatures[0];
  assert.equal(
    wallet.curves.secp256k1.verify(
      signatureEnvelope.digest,
      signatureEnvelope.signature,
      signatureEnvelope.publicKey,
    ),
    true,
  );
});
