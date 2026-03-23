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
    traceId:
      overrides.traceId ??
      `${schemaName}:${payload?.norad ?? payload?.anchorNorad ?? payload?.objectNorad ?? "x"}`,
    streamId: overrides.streamId ?? 1,
    sequence: overrides.sequence ?? 1,
    payload,
  };
}

test("CSV OMM query service example summarizes CelesTrak ingest, FlatSQL persistence, and HTTP query requirements", async () => {
  const flow = await readJson(
    "../examples/flows/csv-omm-query-service/flow.json",
  );
  const manifests = await Promise.all([
    readJson("../examples/plugins/http-fetcher/manifest.json"),
    readJson("../examples/plugins/flatsql-store/manifest.json"),
    readJson("../examples/plugins/sql-http-bridge/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, [
    "http",
    "storage_adapter",
    "storage_query",
    "storage_write",
  ]);
  assert.equal(summary.artifactDependencies.length, 3);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "http" &&
        item.direction === "output" &&
        item.resource?.includes("FORMAT=csv"),
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "database" &&
        item.resource === "file:///var/lib/sdn/flatsql/celestrak-omm.db",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "http" &&
        item.direction === "input" &&
        item.path === "/catalog/omm/query",
    ),
    true,
  );
});

test("CSV OMM query service example runs through the reference harness end-to-end", async () => {
  const flow = await readJson(
    "../examples/flows/csv-omm-query-service/flow.json",
  );
  const manifests = {
    fetcher: await readJson("../examples/plugins/http-fetcher/manifest.json"),
    flatsql: await readJson("../examples/plugins/flatsql-store/manifest.json"),
    bridge: await readJson("../examples/plugins/sql-http-bridge/manifest.json"),
  };

  const registry = new MethodRegistry();
  const storedRecords = new Map();

  registry.registerPlugin({
    manifest: manifests.fetcher,
    handlers: {
      fetch_records: ({ inputs }) => ({
        outputs: inputs.flatMap((input) => [
          frame("records", "AlignedRecordBatch.fbs", "RECS", {
            norad: 25544,
            name: "ISS (ZARYA)",
            source: "celestrak-csv",
          }),
          frame("records", "AlignedRecordBatch.fbs", "RECS", {
            norad: 43013,
            name: "AO-91",
            source: "celestrak-csv",
          }),
        ]),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.flatsql,
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          storedRecords.set(input.payload.norad, input.payload);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
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
      query_sql: ({ inputs }) => {
        const request = inputs.at(-1)?.payload ?? {};
        const requestedNorad = Number(request.params?.norad ?? request.norad ?? 0);
        const rows = requestedNorad
          ? [storedRecords.get(requestedNorad)].filter(Boolean)
          : Array.from(storedRecords.values());
        return {
          outputs: [
            frame("rows", "SqlQueryResult.fbs", "SQLR", {
              rows,
            }),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
      query_objects_within_radius: () => ({
        outputs: [
          frame("matches", "ProximitySelection.fbs", "PRXY", {
            matches: [],
          }),
        ],
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.bridge,
    handlers: {
      build_sql_query_from_http_request: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "SqlQueryRequest.fbs", "SQLQ", {
            sql: "SELECT * FROM omm WHERE norad = :norad",
            params: {
              norad: Number(input.payload.norad),
            },
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
      build_http_response_from_rows: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("response", "HttpResponse.fbs", "HRSP", JSON.stringify(input.payload), {
            traceId: input.traceId,
          }),
        ).map((output) => ({
          ...output,
          metadata: {
            statusCode: 200,
            responseHeaders: {
              "content-type": "application/json",
            },
          },
        })),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  const runtime = new FlowRuntime({ registry });
  runtime.loadProgram(flow);

  runtime.enqueueTriggerFrames("sync-celestrak-csv", [
    frame("trigger", "TimerTick.fbs", "TICK", {
      at: "2026-03-23T00:00:00.000Z",
    }),
  ]);
  const syncResult = await runtime.drain();
  assert.equal(syncResult.idle, true);
  assert.equal(storedRecords.size, 2);

  const sinkOutputs = [];
  const queryRuntime = new FlowRuntime({
    registry,
    onSinkOutput(event) {
      sinkOutputs.push(event);
    },
  });
  queryRuntime.loadProgram(flow);
  queryRuntime.enqueueTriggerFrames("query-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      norad: 25544,
    }),
  ]);
  const queryResult = await queryRuntime.drain();

  assert.equal(queryResult.idle, true);
  assert.equal(sinkOutputs.length, 1);
  assert.equal(sinkOutputs[0].nodeId, "respond-query");
  assert.deepEqual(JSON.parse(sinkOutputs[0].frame.payload), {
    rows: [
      {
        norad: 25544,
        name: "ISS (ZARYA)",
        source: "celestrak-csv",
      },
    ],
  });
});

test("ISS proximity OEM example summarizes external requirements for the visual editor", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const manifests = await Promise.all([
    readJson("../examples/plugins/flatsql-store/manifest.json"),
    readJson("../examples/plugins/query-anchor/manifest.json"),
    readJson("../examples/plugins/sgp4-propagator/manifest.json"),
    readJson("../examples/plugins/oem-generator/manifest.json"),
    readJson("../examples/plugins/oem-file-writer/manifest.json"),
    readJson("../examples/plugins/oem-publisher/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, [
    "pubsub",
    "storage_adapter",
    "storage_query",
    "storage_write",
  ]);
  assert.equal(summary.artifactDependencies.length, 6);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "pubsub" &&
        item.direction === "input" &&
        item.resource === "/sdn/catalog/omm",
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
      (item) =>
        item.kind === "host-service" &&
        item.resource === "storage-adapter://flatsql",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "database" && item.resource === "memory://iss-proximity",
    ),
    true,
  );
});

test("ISS proximity OEM example runs through the temporary reference harness end-to-end", async () => {
  const flow = await readJson("../examples/flows/iss-proximity-oem/flow.json");
  const manifests = {
    flatsql: await readJson("../examples/plugins/flatsql-store/manifest.json"),
    queryAnchor: await readJson(
      "../examples/plugins/query-anchor/manifest.json",
    ),
    sgp4: await readJson("../examples/plugins/sgp4-propagator/manifest.json"),
    oemGenerator: await readJson(
      "../examples/plugins/oem-generator/manifest.json",
    ),
    oemFileWriter: await readJson(
      "../examples/plugins/oem-file-writer/manifest.json",
    ),
    oemPublisher: await readJson(
      "../examples/plugins/oem-publisher/manifest.json",
    ),
  };

  const registry = new MethodRegistry();
  const ommStore = new Map();
  const writtenOems = [];
  const publishedOems = [];

  registry.registerPlugin({
    manifest: manifests.flatsql,
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          ommStore.set(input.payload.norad, input.payload);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
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
      query_sql: () => ({
        outputs: [
          frame("rows", "SqlQueryResult.fbs", "SQLR", {
            rows: Array.from(ommStore.keys()),
          }),
        ],
        backlogRemaining: 0,
        yielded: false,
      }),
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
    frame(
      "records",
      "OMM.fbs",
      "OMM ",
      { norad: 25544, distanceKm: 0 },
      { sequence: 1 },
    ),
    frame(
      "omms",
      "OMM.fbs",
      "OMM ",
      { norad: 40967, distanceKm: 24 },
      { sequence: 2 },
    ),
    frame(
      "omms",
      "OMM.fbs",
      "OMM ",
      { norad: 12345, distanceKm: 72 },
      { sequence: 3 },
    ),
  ]);
  runtime.enqueueTriggerFrames("refresh-query", [
    frame("tick", "TimerTick.fbs", "TICK", { at: "2026-03-12T12:00:00Z" }),
  ]);

  const result = await runtime.drain();

  assert.equal(result.idle, true);
  assert.deepEqual(
    writtenOems.sort((left, right) => left - right),
    [25544, 40967],
  );
  assert.deepEqual(
    publishedOems.sort((left, right) => left - right),
    [25544, 40967],
  );
});
