import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DefaultManifestExports,
  findManifestFiles,
  getWasmExportNames,
  resolveManifestFiles,
  validatePluginArtifact,
  validatePluginManifest,
} from "../src/index.js";

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function encodeString(value) {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...encodeU32(bytes.length), ...bytes];
}

function createSection(sectionId, payload) {
  return [sectionId, ...encodeU32(payload.length), ...payload];
}

function buildWasmWithExportedFunctions(names) {
  const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const typeSection = createSection(1, [
    ...encodeU32(1),
    0x60,
    ...encodeU32(0),
    ...encodeU32(0),
  ]);
  const functionSection = createSection(3, [
    ...encodeU32(names.length),
    ...names.flatMap(() => encodeU32(0)),
  ]);
  const exportSection = createSection(7, [
    ...encodeU32(names.length),
    ...names.flatMap((name, index) => [
      ...encodeString(name),
      0x00,
      ...encodeU32(index),
    ]),
  ]);
  const codeSection = createSection(10, [
    ...encodeU32(names.length),
    ...names.flatMap(() => {
      const body = [0x00, 0x0b];
      return [...encodeU32(body.length), ...body];
    }),
  ]);
  return new Uint8Array([
    ...magicAndVersion,
    ...typeSection,
    ...functionSection,
    ...exportSection,
    ...codeSection,
  ]);
}

test("validatePluginManifest accepts canonical example manifests", async () => {
  const manifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../examples/plugins/basic-propagator/manifest.json", import.meta.url), "utf8"),
    ),
  );

  const report = validatePluginManifest(manifest, {
    sourceName: "examples/plugins/basic-propagator/manifest.json",
  });

  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

test("validatePluginManifest rejects malformed manifests", () => {
  const report = validatePluginManifest(
    {
      pluginId: "",
      name: "Broken Plugin",
      version: "1.0.0",
      pluginFamily: "infrastructure",
      capabilities: ["random", "random"],
      methods: [
        {
          methodId: "broken",
          inputPorts: [],
          outputPorts: [],
          maxBatch: 0,
          drainPolicy: "bogus",
        },
      ],
    },
    { sourceName: "broken.json" },
  );

  assert.equal(report.ok, false);
  assert.ok(report.errors.length >= 4);
});

test("validatePluginArtifact verifies required manifest export symbols", async () => {
  const wasmBytes = buildWasmWithExportedFunctions([
    DefaultManifestExports.pluginBytesSymbol,
    DefaultManifestExports.pluginSizeSymbol,
  ]);
  const exportNames = getWasmExportNames(wasmBytes);
  const report = await validatePluginArtifact({
    manifest: {
      pluginId: "com.digitalarsenal.infrastructure.example",
      name: "Example",
      version: "1.0.0",
      pluginFamily: "infrastructure",
      capabilities: [],
      externalInterfaces: [],
      methods: [
        {
          methodId: "do_work",
          inputPorts: [
            {
              portId: "request",
              acceptedTypeSets: [
                {
                  setId: "req",
                  allowedTypes: [{ schemaName: "Req.fbs", fileIdentifier: "REQ1" }],
                },
              ],
              minStreams: 1,
              maxStreams: 1,
              required: true,
            },
          ],
          outputPorts: [],
          maxBatch: 1,
          drainPolicy: "single-shot",
        },
      ],
    },
    exportNames,
    sourceName: "example",
  });

  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.checkedArtifact, true);
});

test("findManifestFiles scans repo trees and ignores node_modules", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sdn-flow-manifests-"));
  const pluginDir = path.join(tempRoot, "plugins", "example");
  const ignoredDir = path.join(tempRoot, "node_modules", "pkg");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(ignoredDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify({
      pluginId: "com.example.test",
      name: "Test",
      version: "1.0.0",
      pluginFamily: "infrastructure",
      methods: [],
    }),
  );
  await writeFile(path.join(ignoredDir, "manifest.json"), "{}");

  const manifestFiles = await findManifestFiles(tempRoot);

  assert.deepEqual(manifestFiles, [path.join(pluginDir, "manifest.json")]);
});

test("resolveManifestFiles honors repo compliance config", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sdn-flow-configured-manifests-"));
  const configuredDir = path.join(tempRoot, "plugins");
  const ignoredDir = path.join(tempRoot, "other");
  await mkdir(configuredDir, { recursive: true });
  await mkdir(ignoredDir, { recursive: true });
  await writeFile(
    path.join(tempRoot, "sdn-plugin-compliance.json"),
    JSON.stringify({ scanDirectories: ["plugins"] }),
  );
  await writeFile(path.join(configuredDir, "manifest.json"), "{}");
  await writeFile(path.join(ignoredDir, "manifest.json"), "{}");

  const manifestFiles = await resolveManifestFiles(tempRoot);

  assert.deepEqual(manifestFiles, [path.join(configuredDir, "manifest.json")]);
});
