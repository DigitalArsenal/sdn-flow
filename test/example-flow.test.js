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

test("Flow designer requirements merge shared external interfaces by interfaceId", () => {
  const session = new FlowDesignerSession({
    program: {
      programId: "com.digitalarsenal.examples.interface-identity",
      nodes: [
        {
          nodeId: "catalog-source",
          pluginId: "com.digitalarsenal.examples.catalog-source",
          methodId: "fetch_catalog",
        },
      ],
      edges: [],
      triggers: [],
      triggerBindings: [],
      requiredPlugins: ["com.digitalarsenal.examples.catalog-source"],
      externalInterfaces: [
        {
          interfaceId: "catalog-source",
          kind: "http",
          direction: "output",
          capability: "http",
          resource: "https://example.test/catalog",
        },
      ],
    },
  });

  const summary = session.inspectRequirements({
    manifests: [
      {
        pluginId: "com.digitalarsenal.examples.catalog-source",
        name: "Catalog Source",
        version: "1.0.0",
        pluginFamily: "analysis",
        capabilities: ["http"],
        methods: [
          {
            methodId: "fetch_catalog",
            inputPorts: [{ portId: "request" }],
            outputPorts: [{ portId: "records" }],
          },
        ],
        externalInterfaces: [
          {
            interfaceId: "catalog-source",
            kind: "http",
            direction: "output",
            capability: "http",
            resource: "https://example.test/catalog",
            description: "Outbound catalog source",
          },
        ],
      },
    ],
  });

  const matchingInterfaces = summary.externalInterfaces.filter(
    (item) => item.interfaceId === "catalog-source",
  );
  assert.equal(matchingInterfaces.length, 1);
  assert.deepEqual(matchingInterfaces[0].owners, [
    "plugin:com.digitalarsenal.examples.catalog-source",
    "program",
  ]);
});

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

test("Space weather publisher example summarizes scheduled ingest, archive download, PNM, and REST query requirements", async () => {
  const flow = await readJson(
    "../examples/flows/space-weather-publisher/flow.json",
  );
  const manifests = await Promise.all([
    readJson("../examples/plugins/http-fetcher/manifest.json"),
    readJson("../examples/plugins/filesystem-writer/manifest.json"),
    readJson("../examples/plugins/flatsql-store/manifest.json"),
    readJson("../examples/plugins/pnm-notifier/manifest.json"),
    readJson("../examples/plugins/sql-http-bridge/manifest.json"),
    readJson("../examples/plugins/https-file-server/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, [
    "filesystem",
    "http",
    "protocol_dial",
    "storage_adapter",
    "storage_query",
    "storage_write",
  ]);
  assert.equal(summary.artifactDependencies.length, 6);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "http" &&
        item.direction === "output" &&
        item.resource ===
          "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "filesystem" &&
        item.resource === "file:///var/lib/sdn/space-weather/k-index",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "protocol" &&
        item.protocolId === "/sds/pnm/1.0.0",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "http" &&
        item.direction === "input" &&
        item.path === "/space-weather/k-index/query",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "http" &&
        item.direction === "input" &&
        item.path === "/space-weather/k-index/latest",
    ),
    true,
  );
});

test("Space weather publisher example runs through the reference harness end-to-end", async () => {
  const flow = await readJson(
    "../examples/flows/space-weather-publisher/flow.json",
  );
  const manifests = {
    fetcher: await readJson("../examples/plugins/http-fetcher/manifest.json"),
    writer: await readJson("../examples/plugins/filesystem-writer/manifest.json"),
    flatsql: await readJson("../examples/plugins/flatsql-store/manifest.json"),
    pnm: await readJson("../examples/plugins/pnm-notifier/manifest.json"),
    bridge: await readJson("../examples/plugins/sql-http-bridge/manifest.json"),
    fileServer: await readJson(
      "../examples/plugins/https-file-server/manifest.json",
    ),
  };

  const registry = new MethodRegistry();
  const storedRecords = new Map();
  const archivedRecords = [];
  const notifications = [];

  registry.registerPlugin({
    manifest: manifests.fetcher,
    handlers: {
      fetch_records: ({ inputs }) => ({
        outputs: inputs.flatMap(() => [
          frame("records", "AlignedRecordBatch.fbs", "RECS", {
            timeTag: "2026-03-24T00:00:00Z",
            kp: 4.67,
            source: "noaa-swpc",
            product: "planetary-k-index",
          }),
          frame("records", "AlignedRecordBatch.fbs", "RECS", {
            timeTag: "2026-03-24T03:00:00Z",
            kp: 6.33,
            source: "noaa-swpc",
            product: "planetary-k-index",
          }),
        ]),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.writer,
    handlers: {
      write_records: ({ inputs }) => {
        archivedRecords.push(...inputs.map((input) => input.payload));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.flatsql,
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          storedRecords.set(input.payload.timeTag, input.payload);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
              {
                timeTag: input.payload.timeTag,
                kp: input.payload.kp,
              },
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
        const minKp = Number(request.params?.minKp ?? request.minKp ?? 0);
        const rows = Array.from(storedRecords.values()).filter(
          (record) => Number(record.kp) >= minKp,
        );
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
    manifest: manifests.pnm,
    handlers: {
      send_notification: ({ inputs }) => {
        notifications.push(...inputs.map((input) => input.payload));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.bridge,
    handlers: {
      build_sql_query_from_http_request: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "SqlQueryRequest.fbs", "SQLQ", {
            sql: "SELECT * FROM space_weather WHERE kp >= :minKp",
            params: {
              minKp: Number(input.payload.minKp ?? 0),
            },
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
      build_http_response_from_rows: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame(
            "response",
            "HttpResponse.fbs",
            "HRSP",
            JSON.stringify(input.payload),
            {
              traceId: input.traceId,
            },
          ),
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

  registry.registerPlugin({
    manifest: manifests.fileServer,
    handlers: {
      serve_http_request: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame(
            "response",
            "HttpResponse.fbs",
            "HRSP",
            JSON.stringify({
              records: archivedRecords,
            }),
            {
              traceId: input.traceId,
            },
          ),
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
  runtime.enqueueTriggerFrames("sync-space-weather", [
    frame("trigger", "TimerTick.fbs", "TICK", {
      at: "2026-03-24T00:00:00.000Z",
    }),
  ]);
  const syncResult = await runtime.drain();

  assert.equal(syncResult.idle, true);
  assert.equal(storedRecords.size, 2);
  assert.equal(archivedRecords.length, 2);
  assert.deepEqual(notifications, [
    {
      timeTag: "2026-03-24T00:00:00Z",
      kp: 4.67,
    },
    {
      timeTag: "2026-03-24T03:00:00Z",
      kp: 6.33,
    },
  ]);

  const querySinkOutputs = [];
  const queryRuntime = new FlowRuntime({
    registry,
    onSinkOutput(event) {
      querySinkOutputs.push(event);
    },
  });
  queryRuntime.loadProgram(flow);
  queryRuntime.enqueueTriggerFrames("query-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      minKp: 5,
    }),
  ]);
  const queryResult = await queryRuntime.drain();

  assert.equal(queryResult.idle, true);
  assert.equal(querySinkOutputs.length, 1);
  assert.equal(querySinkOutputs[0].nodeId, "respond-query");
  assert.deepEqual(JSON.parse(querySinkOutputs[0].frame.payload), {
    rows: [
      {
        timeTag: "2026-03-24T03:00:00Z",
        kp: 6.33,
        source: "noaa-swpc",
        product: "planetary-k-index",
      },
    ],
  });

  const downloadSinkOutputs = [];
  const downloadRuntime = new FlowRuntime({
    registry,
    onSinkOutput(event) {
      downloadSinkOutputs.push(event);
    },
  });
  downloadRuntime.loadProgram(flow);
  downloadRuntime.enqueueTriggerFrames("download-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      path: "/space-weather/k-index/latest",
    }),
  ]);
  const downloadResult = await downloadRuntime.drain();

  assert.equal(downloadResult.idle, true);
  assert.equal(downloadSinkOutputs.length, 1);
  assert.equal(downloadSinkOutputs[0].nodeId, "serve-archive");
  assert.deepEqual(JSON.parse(downloadSinkOutputs[0].frame.payload), {
    records: [
      {
        timeTag: "2026-03-24T00:00:00Z",
        kp: 4.67,
        source: "noaa-swpc",
        product: "planetary-k-index",
      },
      {
        timeTag: "2026-03-24T03:00:00Z",
        kp: 6.33,
        source: "noaa-swpc",
        product: "planetary-k-index",
      },
    ],
  });
});

test("SDN IPFS pull and pin example summarizes profile import, PNM watch, and retention requirements", async () => {
  const flow = await readJson("../examples/flows/sdn-ipfs-pull-pin/flow.json");
  const manifests = await Promise.all([
    readJson("../examples/plugins/entity-profile-importer/manifest.json"),
    readJson("../examples/plugins/offer-discovery/manifest.json"),
    readJson("../examples/plugins/pnm-watch/manifest.json"),
    readJson("../examples/plugins/ipfs-puller/manifest.json"),
    readJson("../examples/plugins/pin-retention/manifest.json"),
    readJson("../examples/plugins/filesystem-writer/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, [
    "filesystem",
    "ipfs",
    "protocol_handle",
    "pubsub",
  ]);
  assert.equal(summary.artifactDependencies.length, 6);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "pubsub" &&
        item.direction === "input" &&
        item.resource === "/sdn/entity/profile",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "protocol" &&
        item.direction === "input" &&
        item.protocolId === "/sds/pnm/1.0.0",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "host-service" &&
        item.resource === "ipfs://content-pull",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "host-service" &&
        item.resource === "ipfs://pin-retention",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "filesystem" &&
        item.resource === "file:///var/lib/sdn/ipfs-pull-cache",
    ),
    true,
  );
});

test("SDN IPFS pull and pin example runs through the reference harness end-to-end", async () => {
  const flow = await readJson("../examples/flows/sdn-ipfs-pull-pin/flow.json");
  const manifests = {
    importer: await readJson(
      "../examples/plugins/entity-profile-importer/manifest.json",
    ),
    discovery: await readJson(
      "../examples/plugins/offer-discovery/manifest.json",
    ),
    watcher: await readJson("../examples/plugins/pnm-watch/manifest.json"),
    puller: await readJson("../examples/plugins/ipfs-puller/manifest.json"),
    retention: await readJson("../examples/plugins/pin-retention/manifest.json"),
    writer: await readJson("../examples/plugins/filesystem-writer/manifest.json"),
  };

  const registry = new MethodRegistry();
  const watchedOffers = new Map();
  const pinnedCids = [];
  const unpinnedCids = [];
  const archivedRecords = [];
  const ipfsStore = new Map([
    [
      "bafyspaceweather0001",
      {
        product: "planetary-k-index",
        kp: 4.67,
        publishedAt: "2026-03-24T00:05:00Z",
      },
    ],
    [
      "bafyspaceweather0002",
      {
        product: "planetary-k-index",
        kp: 6.33,
        publishedAt: "2026-03-24T00:10:00Z",
      },
    ],
  ]);

  registry.registerPlugin({
    manifest: manifests.importer,
    handlers: {
      import_entity_profile: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("profile", "EntityProfile.fbs", "ENPF", input.payload, {
            sequence: input.sequence,
            traceId: input.traceId,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.discovery,
    handlers: {
      discover_offered_messages: ({ inputs }) => ({
        outputs: inputs.flatMap((input) =>
          (input.payload.offeredMessages ?? []).map((offer, index) =>
            frame("offers", "OfferedMessage.fbs", "OFMS", offer, {
              sequence: index + 1,
              traceId: `${input.traceId}:offer:${offer.messageId}`,
            }),
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.watcher,
    handlers: {
      watch_notifications: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          if (input.portId === "offers") {
            watchedOffers.set(input.payload.messageId, input.payload);
            continue;
          }
          if (input.portId !== "notification") {
            continue;
          }
          const watchedOffer = watchedOffers.get(input.payload.messageId);
          if (!watchedOffer) {
            continue;
          }
          outputs.push(
            frame(
              "pull-requests",
              "IpfsPullRequest.fbs",
              "IPRQ",
              {
                cid: input.payload.cid,
                messageId: input.payload.messageId,
                interfaceId: watchedOffer.interfaceId,
                retentionPolicy: watchedOffer.retentionPolicy,
              },
              {
                sequence: input.sequence,
                traceId: input.traceId,
              },
            ),
          );
        }
        return { outputs, backlogRemaining: 0, yielded: false };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.puller,
    handlers: {
      pull_records: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame(
            "records",
            "AlignedRecordBatch.fbs",
            "RECS",
            {
              cid: input.payload.cid,
              messageId: input.payload.messageId,
              interfaceId: input.payload.interfaceId,
              retentionPolicy: input.payload.retentionPolicy,
              source: "ipfs",
              body: ipfsStore.get(input.payload.cid),
            },
            {
              sequence: input.sequence,
              traceId: input.traceId,
            },
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  registry.registerPlugin({
    manifest: manifests.retention,
    handlers: {
      apply_pin_retention_policy: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const cid = input.payload.cid;
          const maxPinned = Number(
            input.payload.retentionPolicy?.maxPinned ??
              input.payload.retentionPolicy?.retainLatest ??
              1,
          );
          const existingIndex = pinnedCids.indexOf(cid);
          if (existingIndex >= 0) {
            pinnedCids.splice(existingIndex, 1);
          }
          pinnedCids.push(cid);
          while (pinnedCids.length > maxPinned) {
            const evictedCid = pinnedCids.shift();
            if (evictedCid) {
              unpinnedCids.push(evictedCid);
            }
          }
          outputs.push(
            frame(
              "retained-records",
              "AlignedRecordBatch.fbs",
              "RECS",
              {
                ...input.payload,
                retained: true,
              },
              {
                sequence: input.sequence,
                traceId: input.traceId,
              },
            ),
          );
        }
        return { outputs, backlogRemaining: 0, yielded: false };
      },
    },
  });

  registry.registerPlugin({
    manifest: manifests.writer,
    handlers: {
      write_records: ({ inputs }) => {
        archivedRecords.push(...inputs.map((input) => input.payload));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  const runtime = new FlowRuntime({
    registry,
    maxInvocationsPerDrain: 64,
  });
  runtime.loadProgram(flow);

  runtime.enqueueTriggerFrames("entity-profile-feed", [
    frame("profile", "EntityProfile.fbs", "ENPF", {
      entityId: "space-weather-node",
      offeredMessages: [
        {
          messageId: "space-weather.k-index",
          interfaceId: "ipfs-space-weather-feed",
          retentionPolicy: {
            maxPinned: 1,
          },
        },
      ],
    }),
  ]);
  const importResult = await runtime.drain();

  assert.equal(importResult.idle, true);
  assert.deepEqual(Array.from(watchedOffers.keys()), ["space-weather.k-index"]);

  runtime.enqueueTriggerFrames("pnm-notification-feed", [
    frame("notification", "PublishNotification.fbs", "PNOT", {
      messageId: "space-weather.k-index",
      cid: "bafyspaceweather0001",
      publishedAt: "2026-03-24T00:05:00Z",
    }),
  ]);
  const firstPullResult = await runtime.drain();

  assert.equal(firstPullResult.idle, true);
  assert.deepEqual(pinnedCids, ["bafyspaceweather0001"]);
  assert.deepEqual(unpinnedCids, []);
  assert.deepEqual(archivedRecords.map((record) => record.cid), [
    "bafyspaceweather0001",
  ]);

  runtime.enqueueTriggerFrames("pnm-notification-feed", [
    frame("notification", "PublishNotification.fbs", "PNOT", {
      messageId: "space-weather.k-index",
      cid: "bafyspaceweather0002",
      publishedAt: "2026-03-24T00:10:00Z",
    }),
  ]);
  const secondPullResult = await runtime.drain();

  assert.equal(secondPullResult.idle, true);
  assert.deepEqual(pinnedCids, ["bafyspaceweather0002"]);
  assert.deepEqual(unpinnedCids, ["bafyspaceweather0001"]);
  assert.deepEqual(
    archivedRecords.map((record) => ({
      cid: record.cid,
      kp: record.body?.kp,
      retained: record.retained,
    })),
    [
      {
        cid: "bafyspaceweather0001",
        kp: 4.67,
        retained: true,
      },
      {
        cid: "bafyspaceweather0002",
        kp: 6.33,
        retained: true,
      },
    ],
  );
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
