import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  resolveInstalledFlowAutoHostEngine,
  startInstalledFlowAutoHost,
  writeInstalledFlowWorkspace,
} from "../src/index.js";

const SinglePluginFlowPath = new URL(
  "../examples/flows/single-plugin-flow.json",
  import.meta.url,
).pathname;

function buildWorkspace(engine) {
  return {
    workspaceId: `${engine}-auto-host`,
    flowPath: SinglePluginFlowPath,
    discover: false,
    engine,
    hostPlan: {
      hostId: `${engine}-auto-host`,
      hostKind: "sdn-js",
      adapter: "sdn-js",
      engine,
      runtimes: [],
    },
  };
}

test("resolveInstalledFlowAutoHostEngine prefers explicit engine overrides", async () => {
  const engine = await resolveInstalledFlowAutoHostEngine({
    engine: "bun",
    workspace: buildWorkspace("browser"),
  });

  assert.equal(engine, "bun");
});

test("resolveInstalledFlowAutoHostEngine can read persisted workspace metadata", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-auto-host-"),
  );
  const workspacePath = path.join(workspaceDirectory, "workspace.json");

  await writeInstalledFlowWorkspace(workspacePath, buildWorkspace("deno"));

  const engine = await resolveInstalledFlowAutoHostEngine({
    workspacePath,
  });

  assert.equal(engine, "deno");
});

test("startInstalledFlowAutoHost dispatches to the matching concrete starter", async () => {
  const calls = [];
  const starters = {
    startBrowserHost: async (options) => {
      calls.push({
        platform: "browser",
        engine: options.engine,
        workspaceId: options.workspace.workspaceId,
      });
      return {
        platform: "browser",
      };
    },
    startDenoHost: async (options) => {
      calls.push({
        platform: "deno",
        engine: options.engine,
        workspaceId: options.workspace.workspaceId,
      });
      return {
        platform: "deno",
      };
    },
    startBunHost: async (options) => {
      calls.push({
        platform: "bun",
        engine: options.engine,
        workspaceId: options.workspace.workspaceId,
      });
      return {
        platform: "bun",
      };
    },
    startNodeHost: async (options) => {
      calls.push({
        platform: "node",
        engine: options.engine,
        workspaceId: options.workspace.workspaceId,
      });
      return {
        platform: "node",
      };
    },
  };

  const browserHost = await startInstalledFlowAutoHost({
    workspace: buildWorkspace("browser"),
    ...starters,
  });
  const denoHost = await startInstalledFlowAutoHost({
    workspace: buildWorkspace("deno"),
    ...starters,
  });
  const bunHost = await startInstalledFlowAutoHost({
    workspace: buildWorkspace("bun"),
    ...starters,
  });
  const nodeHost = await startInstalledFlowAutoHost({
    workspace: buildWorkspace("node"),
    ...starters,
  });

  assert.equal(browserHost.platform, "browser");
  assert.equal(denoHost.platform, "deno");
  assert.equal(bunHost.platform, "bun");
  assert.equal(nodeHost.platform, "node");
  assert.deepEqual(calls, [
    {
      platform: "browser",
      engine: "browser",
      workspaceId: "browser-auto-host",
    },
    {
      platform: "deno",
      engine: "deno",
      workspaceId: "deno-auto-host",
    },
    {
      platform: "bun",
      engine: "bun",
      workspaceId: "bun-auto-host",
    },
    {
      platform: "node",
      engine: "node",
      workspaceId: "node-auto-host",
    },
  ]);
});
