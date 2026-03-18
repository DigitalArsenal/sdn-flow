import test from "node:test";
import assert from "node:assert/strict";

import {
  createSdnFlowEditorFetchHandler,
  listSdnFlowEditorEmbeddedAssets,
  normalizeSdnFlowEditorBasePath,
  startSdnFlowEditorNodeHost,
} from "../src/editor/index.js";

test("normalizeSdnFlowEditorBasePath normalizes root and nested mount paths", () => {
  assert.equal(normalizeSdnFlowEditorBasePath("/"), "/");
  assert.equal(normalizeSdnFlowEditorBasePath("editor"), "/editor");
  assert.equal(normalizeSdnFlowEditorBasePath("/editor/"), "/editor");
});

test("listSdnFlowEditorEmbeddedAssets includes the editor shell and worker assets", () => {
  const assets = listSdnFlowEditorEmbeddedAssets();
  assert.ok(assets.includes("/"));
  assert.ok(assets.includes("/css/style.css"));
  assert.ok(assets.includes("/js/app.mjs"));
  assert.ok(assets.includes("/js/workers/emception.worker.js"));
  assert.ok(assets.includes("/js/workers/pyodide.worker.js"));
});

test("createSdnFlowEditorFetchHandler serves embedded assets and bootstrap metadata", async () => {
  const exports = [];
  const deployments = [];
  const handler = createSdnFlowEditorFetchHandler({
    basePath: "/editor",
    title: "Embedded Editor",
    engineLabel: "Deno single-file",
    initialFlow: {
      name: "Embedded Flow",
      nodes: [],
      edges: [],
    },
    onExport(payload) {
      exports.push(payload);
      return {
        stored: true,
      };
    },
    onDeploy(payload) {
      deployments.push(payload);
      return {
        deployed: true,
      };
    },
  });

  const redirect = await handler(new Request("http://example.test/editor"));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "http://example.test/editor/");

  const shellResponse = await handler(new Request("http://example.test/editor/"));
  assert.equal(shellResponse.status, 200);
  assert.match(shellResponse.headers.get("content-type"), /text\/html/);
  assert.match(await shellResponse.text(), /Hosted flow editor/);

  const bootstrapResponse = await handler(
    new Request("http://example.test/editor/api/bootstrap"),
  );
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.title, "Embedded Editor");
  assert.equal(bootstrap.engineLabel, "Deno single-file");
  assert.equal(bootstrap.initialFlow.name, "Embedded Flow");
  assert.equal(bootstrap.api.exportUrl, "/editor/api/export");
  assert.equal(bootstrap.api.deployUrl, "/editor/api/deploy");

  const assetResponse = await handler(
    new Request("http://example.test/editor/js/app.mjs"),
  );
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type"), /text\/javascript/);
  assert.match(await assetResponse.text(), /singleFileReady/);

  const exportResponse = await handler(
    new Request("http://example.test/editor/api/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Exported Flow",
      }),
    }),
  );
  assert.equal(exportResponse.status, 200);
  assert.deepEqual(exports, [
    {
      name: "Exported Flow",
    },
  ]);

  const deployResponse = await handler(
    new Request("http://example.test/editor/api/deploy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        artifactId: "flow-123",
      }),
    }),
  );
  assert.equal(deployResponse.status, 200);
  assert.deepEqual(deployments, [
    {
      artifactId: "flow-123",
    },
  ]);
});

test("startSdnFlowEditorNodeHost serves the embedded editor runtime", async () => {
  const host = await startSdnFlowEditorNodeHost({
    hostname: "127.0.0.1",
    port: 0,
    title: "Node Host Editor",
  });

  try {
    const response = await fetch(host.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Hosted flow editor/);
  } finally {
    await host.close();
  }
});
