import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  createCommandPackageManager,
  createNpmPackageManager,
  installWorkspacePackageReference,
  resolveInstalledFlowWorkspace,
} from "../src/index.js";

const BasicPropagatorPackageRoot = new URL(
  "../examples/plugins/basic-propagator",
  import.meta.url,
).pathname;
const SinglePluginFlowPath = new URL(
  "../examples/flows/single-plugin-flow.json",
  import.meta.url,
).pathname;

test("createCommandPackageManager delegates command phases and resolves install records", async () => {
  const commands = [];
  const packageManager = createCommandPackageManager({
    async runCommand(commandSpec, context) {
      commands.push({
        ...commandSpec,
        phase: context.phase,
      });
      return {
        ...commandSpec,
        phase: context.phase,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      };
    },
    installCommand(packageReference, workspace) {
      return {
        command: "mockpm",
        args: ["install", packageReference.sourceRef],
        cwd: workspace.baseDirectory,
      };
    },
    updateCommand(packageReference, workspace) {
      return {
        command: "mockpm",
        args: ["update", packageReference.packageId],
        cwd: workspace.baseDirectory,
      };
    },
    removeCommand(packageReference, workspace) {
      return {
        command: "mockpm",
        args: ["remove", packageReference.packageId],
        cwd: workspace.baseDirectory,
      };
    },
    resolveInstallRecord({ phase, packageReference, workspace }) {
      return {
        packageId: packageReference.packageId,
        pluginId: "com.digitalarsenal.examples.basic-propagator",
        version: phase === "update" ? "2.0.0" : packageReference.version,
        sourceType: packageReference.sourceType,
        sourceRef: packageReference.sourceRef,
        installPath: BasicPropagatorPackageRoot,
        pluginPackage: {
          packageId: packageReference.packageId,
          pluginId: "com.digitalarsenal.examples.basic-propagator",
          packageRoot: BasicPropagatorPackageRoot,
        },
        metadata: {
          workspaceId: workspace.workspaceId,
        },
      };
    },
  });
  const workspace = await resolveInstalledFlowWorkspace({
    workspaceId: "package-manager-test",
    flowPath: SinglePluginFlowPath,
    discover: false,
  });

  const installedRecord = await packageManager.install(
    {
      packageId: "basic-propagator-package",
      version: "1.0.0",
      sourceType: "filesystem",
      sourceRef: "file:basic-propagator",
    },
    workspace,
  );
  const updatedRecord = await packageManager.update(installedRecord, workspace);
  await packageManager.remove(updatedRecord, workspace);

  assert.deepEqual(
    commands.map((entry) => ({
      phase: entry.phase,
      command: entry.command,
      args: entry.args,
    })),
    [
      {
        phase: "install",
        command: "mockpm",
        args: ["install", "file:basic-propagator"],
      },
      {
        phase: "update",
        command: "mockpm",
        args: ["update", "basic-propagator-package"],
      },
      {
        phase: "remove",
        command: "mockpm",
        args: ["remove", "basic-propagator-package"],
      },
    ],
  );
  assert.equal(installedRecord.installPath, BasicPropagatorPackageRoot);
  assert.equal(updatedRecord.version, "2.0.0");
});

test("createNpmPackageManager builds npm-style commands and install paths", async () => {
  const commands = [];
  const workspace = await resolveInstalledFlowWorkspace({
    workspaceId: "npm-package-manager-test",
    baseDirectory: "/tmp/sdn-flow-npm-workspace",
    flowPath: SinglePluginFlowPath,
    discover: false,
  });
  const packageManager = createNpmPackageManager({
    async runCommand(commandSpec, context) {
      commands.push({
        ...commandSpec,
        phase: context.phase,
      });
      return {
        ...commandSpec,
        phase: context.phase,
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
    resolvePluginPackage() {
      return {
        packageId: "@digitalarsenal/basic-propagator",
        pluginId: "com.digitalarsenal.examples.basic-propagator",
        packageRoot: BasicPropagatorPackageRoot,
      };
    },
  });

  const installedRecord = await packageManager.install(
    {
      packageId: "@digitalarsenal/basic-propagator",
      version: "1.2.3",
      sourceType: "npm",
    },
    workspace,
  );
  await packageManager.update(installedRecord, workspace);
  await packageManager.remove(installedRecord, workspace);

  assert.deepEqual(
    commands.map((entry) => ({
      phase: entry.phase,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
    })),
    [
      {
        phase: "install",
        command: "npm",
        args: ["install", "--no-save", "@digitalarsenal/basic-propagator@1.2.3"],
        cwd: "/tmp/sdn-flow-npm-workspace",
      },
      {
        phase: "update",
        command: "npm",
        args: ["install", "--no-save", "@digitalarsenal/basic-propagator"],
        cwd: "/tmp/sdn-flow-npm-workspace",
      },
      {
        phase: "remove",
        command: "npm",
        args: ["uninstall", "--no-save", "@digitalarsenal/basic-propagator"],
        cwd: "/tmp/sdn-flow-npm-workspace",
      },
    ],
  );
  assert.equal(
    installedRecord.installPath,
    path.resolve(
      "/tmp/sdn-flow-npm-workspace",
      "node_modules",
      "@digitalarsenal",
      "basic-propagator",
    ),
  );
  assert.equal(installedRecord.metadata.packageManager, "npm");
});

test("workspace package references can use the npm package manager adapter", async () => {
  const workspace = await resolveInstalledFlowWorkspace({
    workspaceId: "npm-adapter-workspace",
    flowPath: SinglePluginFlowPath,
    discover: false,
  });
  const packageManager = createNpmPackageManager({
    async runCommand(commandSpec) {
      return {
        ...commandSpec,
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
    resolvePluginPackage() {
      return {
        packageId: "basic-propagator-package",
        pluginId: "com.digitalarsenal.examples.basic-propagator",
        packageRoot: BasicPropagatorPackageRoot,
      };
    },
  });

  const updatedWorkspace = await installWorkspacePackageReference(
    workspace,
    {
      packageId: "basic-propagator-package",
      version: "1.0.0",
      sourceType: "npm",
    },
    {
      packageManager,
    },
  );

  assert.equal(updatedWorkspace.packageCatalog.length, 1);
  assert.equal(updatedWorkspace.packageCatalog[0].sourceType, "npm");
  assert.equal(updatedWorkspace.pluginPackages.length, 1);
  assert.equal(
    updatedWorkspace.pluginPackages[0].pluginId,
    "com.digitalarsenal.examples.basic-propagator",
  );
});
