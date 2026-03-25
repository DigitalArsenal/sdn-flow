import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  FlowDesignerSession,
  summarizeHostedRuntimePlan,
} from "../src/index.js";

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf8"));
}

async function loadDemoManifests() {
  const manifests = await Promise.all([
    readJson("../examples/plugins/http-fetcher/manifest.json"),
    readJson("../examples/plugins/browser-cache-store/manifest.json"),
    readJson("../examples/plugins/filesystem-writer/manifest.json"),
    readJson("../examples/plugins/https-file-server/manifest.json"),
    readJson("../examples/plugins/ipfs-publisher/manifest.json"),
    readJson("../examples/plugins/pnm-notifier/manifest.json"),
    readJson("../examples/plugins/obs-associator/manifest.json"),
    readJson("../examples/plugins/pipe-logger/manifest.json"),
    readJson("../examples/plugins/udp-spooler/manifest.json"),
    readJson("../examples/plugins/flatsql-store/manifest.json"),
  ]);
  return manifests;
}

function hasInterface(summary, predicate) {
  return summary.externalInterfaces.some(predicate);
}

test("browser demo declares outbound HTTP and browser-managed cache storage", async () => {
  const flow = await readJson(
    "../examples/environments/orbpro-browser-omm-cache/flow.json",
  );
  const manifests = await loadDemoManifests();
  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["http", "storage_query", "storage_write"]);
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "http" &&
        item.direction === "output" &&
        item.resource?.includes("celestrak.org"),
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "database" &&
        item.resource === "opfs://orbpro-browser-omm-cache",
    ),
    true,
  );
});

test("sdn-js demo declares filesystem, pipe, and inbound HTTP bindings", async () => {
  const flow = await readJson(
    "../examples/environments/sdn-js-catalog-gateway/flow.json",
  );
  const manifests = await loadDemoManifests();
  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["filesystem", "http", "pipe"]);
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "filesystem" &&
        item.resource === "file:///var/lib/sdn/catalog-cache",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) => item.kind === "pipe" && item.resource === "stderr",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "http" &&
        item.direction === "input" &&
        item.path === "/catalog/latest",
    ),
    true,
  );
});

test("go demo declares HTTP, FlatSQL, IPFS, and SDS protocol requirements", async () => {
  const flow = await readJson(
    "../examples/environments/go-sdn-omm-service/flow.json",
  );
  const manifests = await loadDemoManifests();
  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, [
    "filesystem",
    "http",
    "ipfs",
    "protocol_dial",
    "storage_adapter",
    "storage_query",
    "storage_write",
  ]);
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "host-service" &&
        item.resource === "ipfs://publish-and-pin" &&
        item.properties?.implementation?.clientPackage ===
          "github.com/ipfs/kubo/client/rpc",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "protocol" &&
        item.protocolId === "/sds/pnm/1.0.0",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "database" &&
        item.resource === "file:///var/lib/sdn/flatsql/omm.db",
    ),
    true,
  );
});

test("wasmedge demo marks UDP and filesystem access as explicit host-profile requirements", async () => {
  const flow = await readJson(
    "../examples/environments/wasmedge-udp-spooler/flow.json",
  );
  const manifests = await loadDemoManifests();
  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["filesystem", "network"]);
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "network" &&
        item.resource === "udp://0.0.0.0:40123",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "filesystem" &&
        item.resource === "file:///var/lib/wasmedge/spool",
    ),
    true,
  );
});

test("sdn-js HE assessor demo declares direct protocol ingress and wallet-backed HE session requirements", async () => {
  const flow = await readJson(
    "../examples/environments/sdn-js-he-conjunction-assessor/flow.json",
  );
  const manifests = await Promise.all([
    readJson("../examples/plugins/flatbuffers-he-session/manifest.json"),
    readJson("../examples/plugins/flatbuffers-he-conjunction/manifest.json"),
  ]);
  const session = new FlowDesignerSession({ program: flow });
  const summary = session.inspectRequirements({ manifests });

  assert.deepEqual(summary.capabilities, ["protocol_handle", "wallet_sign"]);
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "protocol" &&
        item.direction === "input" &&
        item.protocolId === "/sds/he/conjunction/assessment/1.0.0",
    ),
    true,
  );
  assert.equal(
    hasInterface(
      summary,
      (item) =>
        item.kind === "host-service" &&
        item.resource === "wallet://active-key",
    ),
    true,
  );
});

test("environment host plans summarize the intended host adapters and bindings", async () => {
  const browserPlan = await readJson(
    "../examples/environments/orbpro-browser-omm-cache/host-plan.json",
  );
  const jsPlan = await readJson(
    "../examples/environments/sdn-js-catalog-gateway/host-plan.json",
  );
  const goPlan = await readJson(
    "../examples/environments/go-sdn-omm-service/host-plan.json",
  );
  const hePlan = await readJson(
    "../examples/environments/sdn-js-he-conjunction-assessor/host-plan.json",
  );
  const wasmedgePlan = await readJson(
    "../examples/environments/wasmedge-udp-spooler/host-plan.json",
  );

  const browserSummary = summarizeHostedRuntimePlan(browserPlan);
  const jsSummary = summarizeHostedRuntimePlan(jsPlan);
  const goSummary = summarizeHostedRuntimePlan(goPlan);
  const heSummary = summarizeHostedRuntimePlan(hePlan);
  const wasmedgeSummary = summarizeHostedRuntimePlan(wasmedgePlan);

  assert.equal(browserSummary.adapter, "sdn-js");
  assert.equal(browserSummary.engine, "browser");
  assert.equal(browserSummary.transports.includes("same-app"), true);
  assert.deepEqual(
    browserSummary.delegatedBindings.map((binding) => binding.bindingId),
    ["browser-cache-loopback"],
  );
  assert.deepEqual(browserSummary.standaloneBindings, []);
  assert.deepEqual(browserSummary.delegatedBindings[0].delegationReasons, [
    "browser-host-surface",
    "browser-inbound-listener",
    "browser-same-app-bridge",
  ]);
  assert.equal(jsSummary.engine, "deno");
  assert.equal(jsSummary.transports.includes("http"), true);
  assert.equal(goSummary.engine, "go");
  assert.equal(goSummary.transports.includes("http"), true);
  assert.equal(goSummary.transports.includes("same-app"), true);
  assert.equal(goSummary.transports.includes("sdn-protocol"), true);
  assert.equal(
    goSummary.bindings.some(
      (binding) =>
        binding.bindingId === "ipfs-publish" &&
        binding.transport === "same-app" &&
        binding.url === "ipfs://publish-and-pin" &&
        binding.implementation?.clientPackage ===
          "github.com/ipfs/kubo/client/rpc" &&
        binding.implementation?.apiBaseUrl === "http://127.0.0.1:5001/api/v0",
    ),
    true,
  );
  assert.equal(heSummary.adapter, "sdn-js");
  assert.equal(heSummary.engine, "deno");
  assert.equal(heSummary.transports.includes("same-app"), true);
  assert.equal(heSummary.transports.includes("sdn-protocol"), true);
  assert.equal(
    heSummary.bindings.some(
      (binding) =>
        binding.bindingId === "he-assessment-listener" &&
        binding.transport === "sdn-protocol" &&
        binding.protocolId === "/sds/he/conjunction/assessment/1.0.0" &&
        binding.url ===
          "https://assessor.example.test/sds/he/conjunction/assessment/1.0.0",
    ),
    true,
  );
  assert.equal(
    heSummary.bindings.some(
      (binding) =>
        binding.bindingId === "wallet-active-key" &&
        binding.transport === "same-app" &&
        binding.url === "wallet://active-key",
    ),
    true,
  );
  assert.equal(wasmedgeSummary.adapter, "host-internal");
  assert.equal(wasmedgeSummary.engine, "wasi");
  assert.equal(wasmedgeSummary.startupOrder[0].runtimeTargetClass, "server-side");
  assert.equal(
    wasmedgeSummary.startupOrder[0].standardRuntimeTarget,
    "wasmedge",
  );
  assert.equal(wasmedgeSummary.transports.includes("direct"), true);
  assert.equal(
    wasmedgeSummary.bindings.some(
      (binding) => binding.url === "udp://0.0.0.0:40123",
    ),
    true,
  );
});
