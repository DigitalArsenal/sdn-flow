import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createInstalledFlowHost,
  FlowDesignerSession,
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
  const metadata = {
    ...(overrides.metadata ?? {}),
    structuredPayload: payload,
  };
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
    payload:
      payload instanceof Uint8Array
        ? payload
        : typeof payload === "string"
          ? new TextEncoder().encode(payload)
          : new Uint8Array(),
    metadata,
  };
}

function payloadOf(frameValue) {
  if (frameValue?.metadata?.structuredPayload !== undefined) {
    return frameValue.metadata.structuredPayload;
  }
  if (typeof frameValue?.payload === "string") {
    return frameValue.payload;
  }
  if (frameValue?.payload instanceof Uint8Array) {
    return new TextDecoder().decode(frameValue.payload);
  }
  return null;
}

function hostManifest(manifest, mutate = null) {
  const normalized = structuredClone(manifest);
  normalized.artifactDependencies = [];
  if (typeof mutate === "function") {
    mutate(normalized);
  }
  return normalized;
}

async function startReferenceHost(program, pluginPackages, runtimeOptions = {}) {
  const normalizedProgram = structuredClone(program);
  normalizedProgram.artifactDependencies = [];
  const host = createInstalledFlowHost({
    program: normalizedProgram,
    discover: false,
    pluginPackages,
    allowLiveProgramCompilation: true,
    runtimeOptions,
  });
  await host.start();
  return host;
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

  const storedRecords = new Map();
  const pluginPackages = [];

  pluginPackages.push({
    manifest: hostManifest(manifests.fetcher),
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

  pluginPackages.push({
    manifest: hostManifest(manifests.flatsql),
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const record = payloadOf(input);
          storedRecords.set(record.norad, record);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
              { norad: record.norad },
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
        const request = payloadOf(inputs.at(-1)) ?? {};
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

  pluginPackages.push({
    manifest: hostManifest(manifests.bridge),
    handlers: {
      build_sql_query_from_http_request: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "SqlQueryRequest.fbs", "SQLQ", {
            sql: "SELECT * FROM omm WHERE norad = :norad",
            params: {
              norad: Number(payloadOf(input)?.norad),
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
            JSON.stringify(payloadOf(input)),
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

  const runtime = await startReferenceHost(flow, pluginPackages);

  runtime.enqueueTriggerFrames("sync-celestrak-csv", [
    frame("trigger", "TimerTick.fbs", "TICK", {
      at: "2026-03-23T00:00:00.000Z",
    }),
  ]);
  const syncResult = await runtime.drain();
  assert.equal(syncResult.idle, true);
  assert.equal(storedRecords.size, 2);

  const sinkOutputs = [];
  const queryRuntime = await startReferenceHost(flow, pluginPackages, {
    onSinkOutput(event) {
      sinkOutputs.push(event);
    },
  });
  queryRuntime.enqueueTriggerFrames("query-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      norad: 25544,
    }),
  ]);
  const queryResult = await queryRuntime.drain();

  assert.equal(queryResult.idle, true);
  assert.equal(sinkOutputs.length, 1);
  assert.equal(sinkOutputs[0].nodeId, "respond-query");
  assert.deepEqual(JSON.parse(payloadOf(sinkOutputs[0].frame)), {
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

  const storedRecords = new Map();
  const archivedRecords = [];
  const notifications = [];
  const pluginPackages = [];

  pluginPackages.push({
    manifest: hostManifest(manifests.fetcher),
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

  pluginPackages.push({
    manifest: hostManifest(manifests.writer),
    handlers: {
      write_records: ({ inputs }) => {
        archivedRecords.push(...inputs.map((input) => payloadOf(input)));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.flatsql),
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const record = payloadOf(input);
          storedRecords.set(record.timeTag, record);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
              {
                timeTag: record.timeTag,
                kp: record.kp,
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
        const request = payloadOf(inputs.at(-1)) ?? {};
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

  pluginPackages.push({
    manifest: hostManifest(manifests.pnm),
    handlers: {
      send_notification: ({ inputs }) => {
        notifications.push(...inputs.map((input) => payloadOf(input)));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.bridge),
    handlers: {
      build_sql_query_from_http_request: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "SqlQueryRequest.fbs", "SQLQ", {
            sql: "SELECT * FROM space_weather WHERE kp >= :minKp",
            params: {
              minKp: Number(payloadOf(input)?.minKp ?? 0),
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
            JSON.stringify(payloadOf(input)),
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

  pluginPackages.push({
    manifest: hostManifest(manifests.fileServer),
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

  const runtime = await startReferenceHost(flow, pluginPackages);
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
  const queryRuntime = await startReferenceHost(flow, pluginPackages, {
    onSinkOutput(event) {
      querySinkOutputs.push(event);
    },
  });
  queryRuntime.enqueueTriggerFrames("query-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      minKp: 5,
    }),
  ]);
  const queryResult = await queryRuntime.drain();

  assert.equal(queryResult.idle, true);
  assert.equal(querySinkOutputs.length, 1);
  assert.equal(querySinkOutputs[0].nodeId, "respond-query");
  assert.deepEqual(JSON.parse(payloadOf(querySinkOutputs[0].frame)), {
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
  const downloadRuntime = await startReferenceHost(flow, pluginPackages, {
    onSinkOutput(event) {
      downloadSinkOutputs.push(event);
    },
  });
  downloadRuntime.enqueueTriggerFrames("download-http", [
    frame("request", "HttpRequest.fbs", "HREQ", {
      path: "/space-weather/k-index/latest",
    }),
  ]);
  const downloadResult = await downloadRuntime.drain();

  assert.equal(downloadResult.idle, true);
  assert.equal(downloadSinkOutputs.length, 1);
  assert.equal(downloadSinkOutputs[0].nodeId, "serve-archive");
  assert.deepEqual(JSON.parse(payloadOf(downloadSinkOutputs[0].frame)), {
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

  const watchedOffers = new Map();
  const pinnedCids = [];
  const unpinnedCids = [];
  const archivedRecords = [];
  const pluginPackages = [];
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

  pluginPackages.push({
    manifest: hostManifest(manifests.importer),
    handlers: {
      import_entity_profile: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("profile", "ProtectedCatalogEntry.fbs", "PRTC", payloadOf(input), {
            sequence: input.sequence,
            traceId: input.traceId,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.discovery),
    handlers: {
      discover_offered_messages: ({ inputs }) => ({
        outputs: inputs.flatMap((input) =>
          (payloadOf(input)?.offeredMessages ?? []).map((offer, index) =>
            frame("offers", "CatalogQueryResult.fbs", "CQRS", offer, {
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

  pluginPackages.push({
    manifest: hostManifest(manifests.watcher),
    handlers: {
      watch_notifications: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const payload = payloadOf(input);
          if (input.portId === "offers") {
            watchedOffers.set(payload.messageId, payload);
            continue;
          }
          if (input.portId !== "notification") {
            continue;
          }
          const watchedOffer = watchedOffers.get(payload.messageId);
          if (!watchedOffer) {
            continue;
          }
          outputs.push(
            frame(
              "pull-requests",
              "CidRef.fbs",
              "CIDR",
              {
                cid: payload.cid,
                messageId: payload.messageId,
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

  pluginPackages.push({
    manifest: hostManifest(manifests.puller),
    handlers: {
      pull_records: ({ inputs }) => ({
        outputs: inputs.map((input) => {
          const payload = payloadOf(input);
          return frame(
            "records",
            "AlignedRecordBatch.fbs",
            "RECS",
            {
              cid: payload.cid,
              messageId: payload.messageId,
              interfaceId: payload.interfaceId,
              retentionPolicy: payload.retentionPolicy,
              source: "ipfs",
              body: ipfsStore.get(payload.cid),
            },
            {
              sequence: input.sequence,
              traceId: input.traceId,
            },
          );
        }),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.retention),
    handlers: {
      apply_pin_retention_policy: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const payload = payloadOf(input);
          const cid = payload.cid;
          const maxPinned = Number(
            payload.retentionPolicy?.maxPinned ??
              payload.retentionPolicy?.retainLatest ??
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
                ...payload,
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

  pluginPackages.push({
    manifest: hostManifest(manifests.writer),
    handlers: {
      write_records: ({ inputs }) => {
        archivedRecords.push(...inputs.map((input) => payloadOf(input)));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  const runtime = await startReferenceHost(flow, pluginPackages, {
    maxInvocationsPerDrain: 64,
  });

  runtime.enqueueTriggerFrames("entity-profile-feed", [
    frame("profile", "ProtectedCatalogEntry.fbs", "PRTC", {
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
    frame("notification", "CidRef.fbs", "CIDR", {
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
    frame("notification", "CidRef.fbs", "CIDR", {
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

test("HE conjunction assessor example summarizes direct protocol ingress and flatbuffers/wasm HE source-of-truth metadata", async () => {
  const flow = await readJson("../examples/flows/he-conjunction-assessor/flow.json");
  const manifests = await Promise.all([
    readJson("../examples/plugins/flatbuffers-he-session/manifest.json"),
    readJson("../examples/plugins/flatbuffers-he-conjunction/manifest.json"),
  ]);

  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["protocol_handle", "wallet_sign"]);
  assert.equal(summary.artifactDependencies.length, 2);
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "protocol" &&
        item.direction === "input" &&
        item.protocolId === "/sds/he/conjunction/assessment/1.0.0",
    ),
    true,
  );
  assert.equal(
    summary.externalInterfaces.some(
      (item) =>
        item.kind === "host-service" &&
        item.resource === "wallet://active-key",
    ),
    true,
  );
  assert.deepEqual(
    summary.artifactDependencies.find(
      (dependency) =>
        dependency.pluginId ===
        "com.digitalarsenal.infrastructure.flatbuffers-he-session",
    )?.metadata?.sourceOfTruth,
    {
      workspacePath: "../flatbuffers/wasm",
      packageName: "flatc-wasm",
      exports: ["./he", "./he-bridge"],
    },
  );
  assert.deepEqual(
    summary.artifactDependencies.find(
      (dependency) =>
        dependency.pluginId ===
        "com.digitalarsenal.infrastructure.flatbuffers-he-conjunction",
    )?.metadata?.sourceOfTruth,
    {
      workspacePath: "../flatbuffers/wasm",
      packageName: "flatc-wasm",
      exports: ["./he"],
    },
  );
});

test("HE conjunction assessor example runs through the reference harness end-to-end", async () => {
  const flow = await readJson("../examples/flows/he-conjunction-assessor/flow.json");
  const manifests = {
    session: await readJson(
      "../examples/plugins/flatbuffers-he-session/manifest.json",
    ),
    conjunction: await readJson(
      "../examples/plugins/flatbuffers-he-conjunction/manifest.json",
    ),
  };

  const pluginPackages = [];
  let pendingRequest = null;
  let pendingSessionBundle = null;

  pluginPackages.push({
    manifest: hostManifest(manifests.session),
    handlers: {
      derive_public_bundle: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame(
            "session_bundle",
            "AlignedRecordBatch.fbs",
            "RECS",
            {
              assessmentId: payloadOf(input).assessmentId,
              sourcePackage: "flatc-wasm",
              sourceExports: ["./he", "./he-bridge"],
              publicKey: [1, 2, 3, 4],
              relinKeys: [5, 6, 7, 8],
              polyDegree: 4096,
            },
            {
              traceId: input.traceId,
              sequence: input.sequence,
            },
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.conjunction, (manifest) => {
      const method = manifest.methods?.find(
        (candidate) => candidate.methodId === "evaluate_pairwise_distance",
      );
      for (const inputPort of method?.inputPorts ?? []) {
        inputPort.required = false;
      }
    }),
    handlers: {
      evaluate_pairwise_distance: ({ inputs }) => {
        const nextRequest = inputs.find((input) => input.portId === "request");
        const nextSessionBundle = inputs.find(
          (input) => input.portId === "session_bundle",
        );
        if (nextRequest) {
          pendingRequest = nextRequest;
        }
        if (nextSessionBundle) {
          pendingSessionBundle = nextSessionBundle;
        }
        if (!pendingRequest || !pendingSessionBundle) {
          return {
            outputs: [],
            backlogRemaining: 0,
            yielded: false,
          };
        }

        const request = pendingRequest;
        const sessionBundle = pendingSessionBundle;
        pendingRequest = null;
        pendingSessionBundle = null;
        const requestPayload = payloadOf(request);
        const sessionBundlePayload = payloadOf(sessionBundle);
        const primary = requestPayload.parties.primary.positionCiphertexts;
        const secondary = requestPayload.parties.secondary.positionCiphertexts;
        const dx = Number(primary.x?.[0] ?? 0) - Number(secondary.x?.[0] ?? 0);
        const dy = Number(primary.y?.[0] ?? 0) - Number(secondary.y?.[0] ?? 0);
        const dz = Number(primary.z?.[0] ?? 0) - Number(secondary.z?.[0] ?? 0);
        const distanceSqKm = dx * dx + dy * dy + dz * dz;

        return {
          outputs: [
            frame(
              "assessment_result",
              "AlignedRecordBatch.fbs",
              "RECS",
              {
                assessmentId: requestPayload.assessmentId,
                operatorIds: [
                  requestPayload.parties.primary.operatorId,
                  requestPayload.parties.secondary.operatorId,
                ],
                thresholdKm: requestPayload.thresholdKm,
                distanceSqKm,
                alert:
                  distanceSqKm <
                  requestPayload.thresholdKm * requestPayload.thresholdKm,
                sourcePackage: sessionBundlePayload.sourcePackage,
              },
              {
                traceId: request.traceId,
                sequence: request.sequence,
              },
            ),
          ],
          backlogRemaining: 0,
          yielded: false,
        };
      },
      build_assessment_decision: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame(
            "decision",
            "AlignedRecordBatch.fbs",
            "RECS",
            {
              assessmentId: payloadOf(input).assessmentId,
              status: payloadOf(input).alert ? "alert" : "safe",
              thresholdKm: payloadOf(input).thresholdKm,
              distanceSqKm: payloadOf(input).distanceSqKm,
              operatorIds: payloadOf(input).operatorIds,
              sourcePackage: payloadOf(input).sourcePackage,
            },
            {
              traceId: input.traceId,
              sequence: input.sequence,
            },
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  const sinkOutputs = [];
  const runtime = await startReferenceHost(flow, pluginPackages, {
    maxInvocationsPerDrain: 32,
    onSinkOutput(event) {
      sinkOutputs.push(event);
    },
  });

  runtime.enqueueTriggerFrames("assessment-request", [
    frame("request", "AlignedRecordBatch.fbs", "RECS", {
      assessmentId: "assess-42",
      thresholdKm: 6,
      parties: {
        primary: {
          operatorId: "operator-a",
          positionCiphertexts: {
            x: [7000],
            y: [0],
            z: [0],
          },
        },
        secondary: {
          operatorId: "operator-b",
          positionCiphertexts: {
            x: [7003],
            y: [4],
            z: [0],
          },
        },
      },
    }),
  ]);
  const runtimeResult = await runtime.drain();

  assert.equal(runtimeResult.idle, true);
  assert.equal(sinkOutputs.length, 1);
  assert.equal(sinkOutputs[0].nodeId, "emit-decision");
  assert.deepEqual(payloadOf(sinkOutputs[0].frame), {
    assessmentId: "assess-42",
    status: "alert",
    thresholdKm: 6,
    distanceSqKm: 25,
    operatorIds: ["operator-a", "operator-b"],
    sourcePackage: "flatc-wasm",
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

  const ommStore = new Map();
  const writtenOems = [];
  const publishedOems = [];
  const pluginPackages = [];

  pluginPackages.push({
    manifest: hostManifest(manifests.flatsql),
    handlers: {
      upsert_records: ({ inputs }) => {
        const outputs = [];
        for (const input of inputs) {
          const record = payloadOf(input);
          ommStore.set(record.norad, record);
          outputs.push(
            frame(
              "stored",
              "StoredRecordRef.fbs",
              "STRF",
              { norad: record.norad },
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
        const query = payloadOf(inputs.at(-1));
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

  pluginPackages.push({
    manifest: hostManifest(manifests.queryAnchor),
    handlers: {
      build_radius_query: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("query", "AnchorRadiusQuery.fbs", "ARQY", {
            anchorNorad: 25544,
            radiusKm: 50,
            samplesPerOrbit: 90,
            orbitCount: 1,
            at: payloadOf(input).at,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.sgp4),
    handlers: {
      propagate_one_orbit_samples: ({ inputs }) => ({
        outputs: inputs.flatMap((input) =>
          payloadOf(input).matches.map((norad) =>
            frame("samples", "SampledOrbit.fbs", "SAMP", {
              objectNorad: norad,
              sampleCount: payloadOf(input).sampleCount,
              orbitCount: payloadOf(input).orbitCount,
            }),
          ),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.oemGenerator),
    handlers: {
      generate_oem: ({ inputs }) => ({
        outputs: inputs.map((input) =>
          frame("oems", "OEM.fbs", "OEM ", {
            objectNorad: payloadOf(input).objectNorad,
            sampleCount: payloadOf(input).sampleCount,
            orbitCount: payloadOf(input).orbitCount,
            name: `OEM-${payloadOf(input).objectNorad}`,
          }),
        ),
        backlogRemaining: 0,
        yielded: false,
      }),
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.oemFileWriter),
    handlers: {
      write_oem_files: ({ inputs }) => {
        writtenOems.push(...inputs.map((input) => payloadOf(input).objectNorad));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  pluginPackages.push({
    manifest: hostManifest(manifests.oemPublisher),
    handlers: {
      publish_oem: ({ inputs }) => {
        publishedOems.push(...inputs.map((input) => payloadOf(input).objectNorad));
        return { outputs: [], backlogRemaining: 0, yielded: false };
      },
    },
  });

  const runtime = await startReferenceHost(flow, pluginPackages, {
    maxInvocationsPerDrain: 64,
  });

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
