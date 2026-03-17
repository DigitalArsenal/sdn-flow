import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  createInstalledFlowApp,
  installWorkspacePluginPackage,
  readInstalledFlowWorkspace,
  uninstallWorkspacePluginPackage,
  writeInstalledFlowWorkspace,
} from "../src/index.js";

const ExamplePluginsDirectory = new URL("../examples/plugins", import.meta.url)
  .pathname;
const BasicPropagatorPackageRoot = new URL(
  "../examples/plugins/basic-propagator",
  import.meta.url,
).pathname;
const SinglePluginFlowPath = new URL(
  "../examples/flows/single-plugin-flow.json",
  import.meta.url,
).pathname;
const SdnJsCatalogGatewayFlowPath = new URL(
  "../examples/environments/sdn-js-catalog-gateway/flow.json",
  import.meta.url,
).pathname;
const SdnJsCatalogGatewayHostPlanPath = new URL(
  "../examples/environments/sdn-js-catalog-gateway/host-plan.json",
  import.meta.url,
).pathname;

test("readInstalledFlowWorkspace resolves relative flow, host-plan, and plugin roots", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-workspace-"),
  );
  const workspacePath = path.join(workspaceDirectory, "workspace.json");

  await writeInstalledFlowWorkspace(workspacePath, {
    workspaceId: "catalog-gateway",
    flowPath: path.relative(workspaceDirectory, SdnJsCatalogGatewayFlowPath),
    hostPlanPath: path.relative(
      workspaceDirectory,
      SdnJsCatalogGatewayHostPlanPath,
    ),
    pluginRootDirectories: [
      path.relative(workspaceDirectory, ExamplePluginsDirectory),
    ],
    fetch: {
      baseUrl: "http://127.0.0.1:9080",
    },
  });

  const workspace = await readInstalledFlowWorkspace(workspacePath);

  assert.equal(workspace.workspaceId, "catalog-gateway");
  assert.equal(
    workspace.program?.programId,
    "com.digitalarsenal.examples.sdn-js-catalog-gateway",
  );
  assert.equal(workspace.hostPlan?.hostId, "sdn-js-local");
  assert.equal(workspace.engine, "deno");
  assert.deepEqual(workspace.pluginRootDirectories, [
    path.resolve(ExamplePluginsDirectory),
  ]);
});

test("writeInstalledFlowWorkspace stores relative paths and round-trips back to absolute paths", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-workspace-write-"),
  );
  const workspacePath = path.join(workspaceDirectory, "workspace.json");

  await writeInstalledFlowWorkspace(workspacePath, {
    workspaceId: "single-plugin",
    description: "Single plugin workspace",
    flowPath: SinglePluginFlowPath,
    hostPlanPath: SdnJsCatalogGatewayHostPlanPath,
    pluginRootDirectories: [ExamplePluginsDirectory],
  });

  const rawWorkspace = JSON.parse(await readFile(workspacePath, "utf8"));
  const workspace = await readInstalledFlowWorkspace(workspacePath);

  assert.equal(rawWorkspace.flowPath, path.relative(workspaceDirectory, SinglePluginFlowPath));
  assert.equal(
    rawWorkspace.hostPlanPath,
    path.relative(workspaceDirectory, SdnJsCatalogGatewayHostPlanPath),
  );
  assert.equal(
    rawWorkspace.pluginRootDirectories[0],
    path.relative(workspaceDirectory, ExamplePluginsDirectory),
  );
  assert.equal(
    workspace.program?.programId,
    "com.digitalarsenal.examples.single-plugin-flow",
  );
  assert.deepEqual(workspace.pluginRootDirectories, [
    path.resolve(ExamplePluginsDirectory),
  ]);
});

test("createInstalledFlowApp boots a persisted workspace and runs the installed flow host", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-installed-app-"),
  );
  const workspacePath = path.join(workspaceDirectory, "workspace.json");

  await writeInstalledFlowWorkspace(workspacePath, {
    workspaceId: "single-plugin-app",
    flowPath: path.relative(workspaceDirectory, SinglePluginFlowPath),
    pluginRootDirectories: [
      path.relative(workspaceDirectory, ExamplePluginsDirectory),
    ],
  });

  const app = await createInstalledFlowApp({
    workspacePath,
  });
  const startup = await app.start();
  const result = await app.service.dispatchTriggerFrames("manual-request", [
    {
      streamId: 1,
      sequence: 1,
      typeRef: {
        schemaName: "StateRequest.fbs",
        fileIdentifier: "SREQ",
      },
      payload: new Uint8Array([1, 2, 3]),
    },
  ]);

  assert.equal(startup.workspace.workspaceId, "single-plugin-app");
  assert.equal(
    startup.registeredPluginIds.includes(
      "com.digitalarsenal.examples.basic-propagator",
    ),
    true,
  );
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].frame.portId, "state");
  assert.deepEqual(app.getSummary(), {
    workspaceId: "single-plugin-app",
    programId: "com.digitalarsenal.examples.single-plugin-flow",
    adapter: null,
    engine: null,
    pluginRootDirectories: [path.resolve(ExamplePluginsDirectory)],
    hostId: null,
  });
});

test("workspace package install and uninstall helpers maintain the explicit plugin catalog", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-workspace-catalog-"),
  );
  let workspace = await readInstalledFlowWorkspace(
    await (async () => {
      const workspacePath = path.join(workspaceDirectory, "workspace.json");
      await writeInstalledFlowWorkspace(workspacePath, {
        workspaceId: "catalog-workspace",
        flowPath: SinglePluginFlowPath,
        discover: false,
      });
      return workspacePath;
    })(),
  );

  workspace = await installWorkspacePluginPackage(workspace, {
    packageRoot: BasicPropagatorPackageRoot,
  });

  assert.equal(workspace.pluginPackages.length, 1);
  assert.equal(
    workspace.pluginPackages[0].pluginId,
    "com.digitalarsenal.examples.basic-propagator",
  );
  assert.match(
    workspace.pluginPackages[0].modulePath ?? "",
    /basic-propagator\/plugin\.js$/,
  );

  workspace = await uninstallWorkspacePluginPackage(
    workspace,
    "com.digitalarsenal.examples.basic-propagator",
  );

  assert.equal(workspace.pluginPackages.length, 0);
});

test("createInstalledFlowApp can install and uninstall explicit plugin packages through workspace state", async () => {
  const workspaceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sdn-flow-installed-app-catalog-"),
  );
  const workspacePath = path.join(workspaceDirectory, "workspace.json");

  await writeInstalledFlowWorkspace(workspacePath, {
    workspaceId: "catalog-app",
    flowPath: path.relative(workspaceDirectory, SinglePluginFlowPath),
    discover: false,
  });

  const app = await createInstalledFlowApp({
    workspacePath,
  });

  await app.installPluginPackage({
    packageRoot: BasicPropagatorPackageRoot,
  });

  const startup = await app.start();
  const installedWorkspace = await readInstalledFlowWorkspace(workspacePath);

  assert.equal(
    startup.registeredPluginIds.includes(
      "com.digitalarsenal.examples.basic-propagator",
    ),
    true,
  );
  assert.equal(installedWorkspace.pluginPackages.length, 1);

  await app.uninstallPluginPackage(
    "com.digitalarsenal.examples.basic-propagator",
  );
  const uninstalledWorkspace = await readInstalledFlowWorkspace(workspacePath);

  assert.equal(
    app.host.registry.listPlugins().some(
      (plugin) =>
        plugin.pluginId === "com.digitalarsenal.examples.basic-propagator",
    ),
    false,
  );
  assert.equal(uninstalledWorkspace.pluginPackages.length, 0);
});
