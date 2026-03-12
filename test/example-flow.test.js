import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  FlowDesignerSession,
  FlowRuntime,
  MethodRegistry,
} from "../src/index.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function typeRef(schemaName, fileIdentifier) {
  return {
    schemaName,
    fileIdentifier,
    schemaHash: [1, 2, 3, 4],
  };
}

function frame(portId, schemaName, fileIdentifier, payload, overrides = {}) {
  return {
    portId,
    typeRef: typeRef(schemaName, fileIdentifier),
    alignment: 8,
    offset: overrides.offset ?? 4096,
    size: overrides.size ?? 64,
    ownership: "shared",
    generation: 0,
    mutability: "immutable",
    traceId: overrides.traceId ?? `${schemaName}:${payload?.norad ?? payload?.anchorNorad ?? payload?.objectNorad ?? "x"}`,
    streamId: overrides.streamId ?? 1,
    sequence: overrides.sequence ?? 1,
    payload,
  };
}

test("ISS proximity OEM example summarizes external requirements for the visual editor", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const manifests = await Promise.all([
    readJson("../examples/plugins/flatsql-memory/manifest.json"),
    readJson("../examples/plugins/query-anchor/manifest.json"),
    readJson("../examples/plugins/sgp4-propagator/manifest.json"),
    readJson("../examples/plugins/oem-generator/manifest.json"),
    readJson("../examples/plugins/oem-file-writer/manifest.json"),
    readJson("../examples/plugins/oem-publisher/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["pubsub", "storage_query", "storage_write"]);
  assert.equal(summary.artifactDependencies.length, 6);
  assert.equal(
    summary.externalInterfaces.some(
      (item) => item.kind === "pubsub" && item.direction === "input" && item.resource === "/sdn/catalog/omm",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) => item.kind === "filesystem" && item.direction === "output",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) => item.kind === "database" && item.resource === "memory://iss-proximity",
    ),
    true,
  );
});

test("ISS proximity OEM example runs in interpreted mode end-to-end", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const manifests = {
    flatsql: await readJson("../examples/plugins/flatsql-memory/manifest.json"),
    queryAnchor: await readJson("../examples/plugins/query-anchor/manifest.json"),
    sgp4: await readJson("../examples/plugins/sgp4-propagator/manifest.json"),
    oemGenerator: await readJson("../examples/plugins/oem-generator/manifest.json"),
    oemFileWriter: await readJson("../examples/plugins/oem-file-writer/manifest.json"),
    oemPublisher: await readJson("../examples/plugins/oem-publisher/manifest.json"),
  };

  const registry = new MethodRegistry();
  const ommStore = new Map();
  const writtenOems = [];
  const publishedOems = [];

  registry.registerPlugin({
    manifest: manifests.flatsql,
    handlers: {
      upsert_omm_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          ommStore.set(input.payload.norad, input.payload);
          outputs.push(
            frame(
              "records",
              "CatalogRecord.fbs",
              "CTLG",
              { norad: input.payload.norad },
              {
                sequence: input.sequence,
                traceId: input.traceId,
              },
            ),
          );
        }
        return { outputs, backlogRemaining: 0, yielded: false };
      },
      query_objects_within_radius: ({ inputs }) => {
        const query = inputs.at(-1)?.payload;
        const matches = Array.from(ommStore.values())
          .filter((record) => record.distanceKm <= query.radiusKm)
          .map((record) => record.norad);
        return {
          outputs: [
            frame("matches", "ProximitySelection.fbs", "PRXY", {
              anchorNorad: query.anchorNorad,
              radiusKm: query.radiusKm,
              sampleCount: query.samplesPerOrbit,
              orbitCount: query.orbitCount,
              matches,
            }),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.queryAnchor,
    handlers: {
      build_radius_query: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "AnchorRadiusQuery.fbs", "ARQY", {
            anchorNorad: 25544,
            radiusKm: 50,
            samplesPerOrbit: 90,
            orbitCount: 1,
            at: input.payload.at,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.sgp4,
    handlers: {
      propagate_one_orbit_samples: ({ inputs }) => ({
        outputs: inputs.flatMap((input) =>
          input.payload.matches.map((norad) =>
            frame("samples", "SampledOrbit.fbs", "SAMP", {
              objectNorad: norad,
              sampleCount: input.payload.sampleCount,
              orbitCount: input.payload.orbitCount,
            }),
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.oemGenerator,
    handlers: {
      generate_oem: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("oems", "OEM.fbs", "OEM ", {
            objectNorad: input.payload.objectNorad,
            sampleCount: input.payload.sampleCount,
            orbitCount: input.payload.orbitCount,
            name: `OEM-${input.payload.objectNorad}`,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.oemFileWriter,
    handlers: {
      write_oem_files: ({ inputs }) => {
        writtenOems.push(...inputs.map((input) => input.payload.objectNorad));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.oemPublisher,
    handlers: {
      publish_oem: ({ inputs }) => {
        publishedOems.push(...inputs.map((input) => input.payload.objectNorad));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  const runtime = new FlowRuntime({
    registry,
    maxInvocationsPerDrain: 64,
  });
  runtime.loadProgram(flow);

  runtime.enqueueTriggerFrames("omm-subscription", [
    frame("omms", "OMM.fbs", "OMM ", { norad: 25544, distanceKm: 0 }, { sequence: 1 }),
    frame("omms", "OMM.fbs", "OMM ", { norad: 40967, distanceKm: 24 }, { sequence: 2 }),
    frame("omms", "OMM.fbs", "OMM ", { norad: 12345, distanceKm: 72 }, { sequence: 3 }),
  ]);
  runtime.enqueueTriggerFrames("refresh-query", [
    frame("tick", "TimerTick.fbs", "TICK", { at: "2026-03-12T12:00:00Z" }),
  ]);

  const result = await runtime.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(writtenOems.sort((left, right) => left - right), [25544, 40967]);
  assert.deepEqual(publishedOems.sort((left, right) => left - right), [25544, 40967]);
});
