import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  createInstalledFlowHost,
  serializeCompiledArtifact,
} from "../src/index.js";
import { createBootstrapDemoWorkspace } from "../examples/bootstrap/installed-flow-http-demo.js";
import {
  AutoBootstrapWorkspacePath,
  startAutoBootstrapExample,
} from "../examples/bootstrap/start-auto-host.mjs";
import {
  createBrowserBootstrapWorkspace,
  startBrowserBootstrapExample,
} from "../examples/bootstrap/start-browser-worker.mjs";
import {
  createBunBootstrapWorkspace,
  startBunBootstrapExample,
} from "../examples/bootstrap/start-bun-http-host.mjs";
import {
  createDenoBootstrapWorkspace,
  startDenoBootstrapExample,
} from "../examples/bootstrap/start-deno-http-host.mjs";
import {
  createNodeBootstrapWorkspace,
  startNodeBootstrapExample,
} from "../examples/bootstrap/start-node-http-host.mjs";
import {
  createEditorBootstrapFlow,
  startNodeEditorBootstrapExample,
} from "../examples/bootstrap/start-node-editor-host.mjs";

async function compileBootstrapWorkspace(workspace) {
  const host = createInstalledFlowHost({
    allowLiveProgramCompilation: true,
    program: workspace.program,
    hostPlan: workspace.hostPlan,
    pluginPackages: workspace.pluginPackages,
    discover: false,
  });

  await host.start();
  return {
    ...workspace,
    serializedArtifact: serializeCompiledArtifact(host.getArtifact()),
  };
}

test("bootstrap demo workspace factory produces a runnable HTTP host workspace", () => {
  const workspace = createBootstrapDemoWorkspace({
    engine: "node",
    url: "http://127.0.0.1:9080/demo",
  });

  assert.equal(workspace.hostPlan.engine, "node");
  assert.equal(workspace.program.programId, "com.digitalarsenal.examples.bootstrap.http-host");
  assert.equal(workspace.pluginPackages.length, 1);
  assert.equal(
    workspace.hostPlan.runtimes[0].bindings[0].url,
    "http://127.0.0.1:9080/demo",
  );
});

test("Deno and Bun bootstrap scripts start through their injected serve functions", async () => {
  const serveCalls = [];
  const denoWorkspace = await compileBootstrapWorkspace(
    createDenoBootstrapWorkspace(),
  );
  const bunWorkspace = await compileBootstrapWorkspace(
    createBunBootstrapWorkspace(),
  );
  const denoHost = await startDenoBootstrapExample({
    workspace: denoWorkspace,
    serve(options, handler) {
      serveCalls.push({
        platform: "deno",
        options,
        handler,
      });
      return {
        shutdown() {},
      };
    },
  });
  const bunHost = await startBunBootstrapExample({
    workspace: bunWorkspace,
    serve(options) {
      serveCalls.push({
        platform: "bun",
        options,
      });
      return {
        stop() {},
      };
    },
  });

  assert.equal(createDenoBootstrapWorkspace().hostPlan.engine, "deno");
  assert.equal(createBunBootstrapWorkspace().hostPlan.engine, "bun");
  assert.equal(denoHost.listeners.length, 1);
  assert.equal(bunHost.listeners.length, 1);
  assert.equal(serveCalls[0].platform, "deno");
  assert.equal(serveCalls[1].platform, "bun");
});

test("Node and browser bootstrap scripts can start with injected host hooks", async () => {
  const serveHttpCalls = [];
  const addEventListenerCalls = [];
  const removeEventListenerCalls = [];
  const nodeWorkspace = await compileBootstrapWorkspace(
    createNodeBootstrapWorkspace(),
  );
  const browserWorkspace = await compileBootstrapWorkspace(
    createBrowserBootstrapWorkspace(),
  );

  const nodeHost = await startNodeBootstrapExample({
    workspace: nodeWorkspace,
    serveHttp: async ({ binding, handler }) => {
      serveHttpCalls.push({
        binding,
        handler,
      });
      return {
        close() {},
      };
    },
  });
  const browserHost = await startBrowserBootstrapExample({
    workspace: browserWorkspace,
    addEventListener(eventType, listener) {
      addEventListenerCalls.push({
        eventType,
        listener,
      });
    },
    removeEventListener(eventType, listener) {
      removeEventListenerCalls.push({
        eventType,
        listener,
      });
    },
  });

  assert.equal(createNodeBootstrapWorkspace().hostPlan.engine, "node");
  assert.equal(createBrowserBootstrapWorkspace().hostPlan.engine, "browser");
  assert.equal(nodeHost.listeners.length, 1);
  assert.equal(serveHttpCalls.length, 1);
  assert.equal(browserHost.bindingContexts.length, 1);
  assert.equal(addEventListenerCalls.length, 1);

  browserHost.stop();

  assert.deepEqual(removeEventListenerCalls, [
    {
      eventType: "fetch",
      listener: addEventListenerCalls[0].listener,
    },
  ]);
});

test("auto-host bootstrap script dispatches through the environment-neutral starter", async () => {
  const calls = [];
  const host = await startAutoBootstrapExample({
    startDenoHost: async (options) => {
      calls.push({
        platform: "deno",
        workspacePath: options.workspacePath,
        engine: options.engine,
      });
      return {
        platform: "deno",
      };
    },
  });

  assert.match(AutoBootstrapWorkspacePath, /sdn-js-catalog-gateway\/workspace\.json$/);
  assert.equal(host.platform, "deno");
  assert.deepEqual(calls, [
    {
      platform: "deno",
      workspacePath: path.resolve(AutoBootstrapWorkspacePath),
      engine: "deno",
    },
  ]);
});

test("editor bootstrap example can start through an injected editor host", async () => {
  const calls = [];
  const host = await startNodeEditorBootstrapExample({
    startEditorHost: async (options) => {
      calls.push(options);
      return {
        url: "http://127.0.0.1:9082/editor",
      };
    },
  });

  assert.equal(createEditorBootstrapFlow().name, "Editor Bootstrap Flow");
  assert.equal(host.url, "http://127.0.0.1:9082/editor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].basePath, "/editor");
  assert.equal(calls[0].initialFlow.name, "Editor Bootstrap Flow");
});
