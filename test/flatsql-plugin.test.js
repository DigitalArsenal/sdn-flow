import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MethodRegistry,
  registerInstalledPluginPackage,
} from "../src/index.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function frame(portId, schemaName, fileIdentifier, payload, overrides = {}) {
  return {
    portId,
    typeRef: {
      schemaName,
      fileIdentifier,
      schemaHash: [1, 2, 3, 4],
    },
    alignment: 8,
    offset: overrides.offset ?? 4096,
    size: overrides.size ?? 64,
    ownership: "shared",
    generation: 0,
    mutability: "immutable",
    traceId:
      overrides.traceId ??
      `${schemaName}:${payload?.norad ?? payload?.anchorNorad ?? "x"}`,
    streamId: overrides.streamId ?? 1,
    sequence: overrides.sequence ?? 1,
    payload,
  };
}

test("local FlatSQL plugin package exercises all canonical store methods", async () => {
  const registry = new MethodRegistry();
  const packageRoot = fileURLToPath(
    new URL("../examples/plugins/flatsql-store/", import.meta.url),
  );
  const manifestPath = path.join(packageRoot, "manifest.json");
  const modulePath = path.join(packageRoot, "plugin.js");

  await registerInstalledPluginPackage({
    registry,
    pluginPackage: {
      packageName: "local-flatsql-store",
      packageRoot,
      manifestPath,
      modulePath,
    },
  });

  const manifest = await readJson("../examples/plugins/flatsql-store/manifest.json");
  assert.equal(registry.getPlugin(manifest.pluginId)?.manifest.pluginId, manifest.pluginId);

  const upsert = await registry.invoke({
    pluginId: manifest.pluginId,
    methodId: "upsert_records",
    inputs: [
      frame("records", "StoredRecordRef.fbs", "STRF", {
        norad: 25544,
        name: "ISS",
        distanceKm: 12.4,
      }),
      frame("records", "StoredRecordRef.fbs", "STRF", {
        norad: 20580,
        name: "HST",
        distanceKm: 88.2,
      }),
      frame(
        "records",
        "StoredRecordRef.fbs",
        "STRF",
        {
          norad: 25544,
          name: "ISS-UPDATED",
          distanceKm: 18.5,
        },
        {
          sequence: 3,
        },
      ),
    ],
  });

  assert.equal(upsert.outputs.length, 3);
  assert.equal(upsert.outputs[0].portId, "stored");
  assert.equal(upsert.outputs[0].payload.norad, 25544);

  const querySql = await registry.invoke({
    pluginId: manifest.pluginId,
    methodId: "query_sql",
    inputs: [
      frame("query", "SqlQueryRequest.fbs", "SQLQ", {
        sql: "SELECT norad, name, distanceKm FROM OrbitalRecord WHERE distanceKm BETWEEN 0 AND 50",
      }),
    ],
  });

  assert.equal(querySql.outputs.length, 1);
  assert.equal(querySql.outputs[0].portId, "rows");
  assert.deepEqual(querySql.outputs[0].payload.columns, [
    "norad",
    "name",
    "distanceKm",
  ]);
  assert.equal(querySql.outputs[0].payload.rowCount, 1);
  assert.deepEqual(querySql.outputs[0].payload.rows, [
    [25544, "ISS-UPDATED", 18.5],
  ]);

  const radiusQuery = await registry.invoke({
    pluginId: manifest.pluginId,
    methodId: "query_objects_within_radius",
    inputs: [
      frame("query", "AnchorRadiusQuery.fbs", "ARQY", {
        anchorNorad: 25544,
        radiusKm: 50,
        samplesPerOrbit: 90,
        orbitCount: 1,
      }),
    ],
  });

  assert.equal(radiusQuery.outputs.length, 1);
  assert.equal(radiusQuery.outputs[0].portId, "matches");
  assert.deepEqual(radiusQuery.outputs[0].payload, {
    anchorNorad: 25544,
    radiusKm: 50,
    sampleCount: 90,
    orbitCount: 1,
    matches: [25544],
  });
});
