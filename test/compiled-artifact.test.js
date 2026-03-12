import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCompiledArtifact } from "../src/index.js";

test("compiled artifacts require an embedded manifest and default manifest exports", async () => {
  const artifact = await normalizeCompiledArtifact({
    programId: "flow.artifact.test",
    wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    manifestBuffer: new Uint8Array([0x46, 0x4c, 0x4f, 0x57]),
  });

  assert.equal(artifact.programId, "flow.artifact.test");
  assert.equal(artifact.manifestExports.bytesSymbol, "flow_get_manifest_flatbuffer");
  assert.equal(artifact.manifestExports.sizeSymbol, "flow_get_manifest_flatbuffer_size");
});

test("compiled artifacts reject missing embedded manifest bytes", async () => {
  await assert.rejects(
    normalizeCompiledArtifact({
      programId: "flow.artifact.invalid",
      wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    }),
    /embedded FlatBuffer manifest/,
  );
});
