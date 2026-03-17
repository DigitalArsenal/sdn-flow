import { spawn } from "node:child_process";
import path from "node:path";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommandArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args
    .map((value) => {
      if (value === undefined || value === null) {
        return null;
      }
      return String(value);
    })
    .filter((value) => value !== null);
}

function normalizeCommandSpec(commandSpec, defaults = {}) {
  const input =
    typeof commandSpec === "string"
      ? { command: commandSpec }
      : isObject(commandSpec)
        ? commandSpec
        : null;
  const command = normalizeString(input?.command ?? input?.cmd, null);
  if (!command) {
    throw new Error(
      "Command-backed package-manager operations require a command string.",
    );
  }
  return {
    command,
    args: normalizeCommandArgs(input.args),
    cwd: path.resolve(
      normalizeString(input.cwd ?? defaults.cwd, null) ?? process.cwd(),
    ),
    env: isObject(input.env)
      ? {
          ...(isObject(defaults.env) ? defaults.env : process.env),
          ...input.env,
        }
      : defaults.env,
    input:
      typeof input.input === "string" || input.input instanceof Uint8Array
        ? input.input
        : null,
    allowedExitCodes: Array.isArray(input.allowedExitCodes)
      ? input.allowedExitCodes
      : Array.isArray(defaults.allowedExitCodes)
        ? defaults.allowedExitCodes
        : [0],
  };
}

function createCommandError(commandResult) {
  const commandLine = [commandResult.command, ...commandResult.args].join(" ");
  const stderr =
    normalizeString(commandResult.stderr, null) ?? "Command exited without stderr.";
  return new Error(
    `Package-manager command failed (${commandResult.exitCode}): ${commandLine}\n${stderr}`,
  );
}

function formatPackageInstallSpecifier(packageReference = {}) {
  const sourceRef = normalizeString(packageReference.sourceRef, null);
  if (sourceRef) {
    return sourceRef;
  }
  const packageId = normalizeString(packageReference.packageId, null);
  if (!packageId) {
    throw new Error(
      "Package references require packageId or sourceRef for installation.",
    );
  }
  const version = normalizeString(packageReference.version, null);
  return version ? `${packageId}@${version}` : packageId;
}

function formatPackageUpdateSpecifier(packageReference = {}) {
  const sourceRef = normalizeString(packageReference.sourceRef, null);
  if (sourceRef) {
    return sourceRef;
  }
  const packageId = normalizeString(packageReference.packageId, null);
  if (!packageId) {
    throw new Error(
      "Package references require packageId or sourceRef for updates.",
    );
  }
  return packageId;
}

function resolvePackageReferenceCwd(packageReference, workspace, options = {}) {
  return path.resolve(
    normalizeString(
      options.cwd ??
        options.baseDirectory ??
        workspace?.baseDirectory ??
        process.cwd(),
      process.cwd(),
    ),
  );
}

function resolveNodeModulesInstallPath(installRoot, packageId) {
  const normalizedPackageId = normalizeString(packageId, null);
  if (!normalizedPackageId) {
    return null;
  }
  return path.resolve(installRoot, "node_modules", ...normalizedPackageId.split("/"));
}

export function createNodeCommandRunner(defaultOptions = {}) {
  return async function runCommand(commandSpec, context = {}) {
    const normalizedCommand = normalizeCommandSpec(commandSpec, defaultOptions);
    const {
      command,
      args,
      cwd,
      env,
      input,
      allowedExitCodes,
    } = normalizedCommand;

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        const commandResult = {
          phase: context.phase ?? null,
          command,
          args,
          cwd,
          exitCode: Number.isInteger(exitCode) ? exitCode : -1,
          stdout,
          stderr,
        };
        if (!allowedExitCodes.includes(commandResult.exitCode)) {
          reject(createCommandError(commandResult));
          return;
        }
        resolve(commandResult);
      });

      if (input instanceof Uint8Array || typeof input === "string") {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
  };
}

export function createCommandPackageManager(options = {}) {
  const runCommand =
    typeof options.runCommand === "function"
      ? options.runCommand
      : createNodeCommandRunner(options.runnerOptions);
  const installCommand =
    typeof options.installCommand === "function"
      ? options.installCommand
      : null;
  const updateCommand =
    typeof options.updateCommand === "function"
      ? options.updateCommand
      : null;
  const removeCommand =
    typeof options.removeCommand === "function"
      ? options.removeCommand
      : null;
  const resolveInstallRecord =
    typeof options.resolveInstallRecord === "function"
      ? options.resolveInstallRecord
      : null;

  if (!installCommand || !updateCommand || !resolveInstallRecord) {
    throw new Error(
      "Command-backed package managers require installCommand, updateCommand, and resolveInstallRecord callbacks.",
    );
  }

  async function executePhase(phase, packageReference, workspace, operationOptions) {
    const commandFactory =
      phase === "install"
        ? installCommand
        : phase === "update"
          ? updateCommand
          : removeCommand;
    if (typeof commandFactory !== "function") {
      return null;
    }
    const commandSpec = commandFactory(
      packageReference,
      workspace,
      operationOptions,
    );
    return runCommand(commandSpec, {
      phase,
      packageReference,
      workspace,
      options: operationOptions,
    });
  }

  return {
    async install(packageReference, workspace, operationOptions = {}) {
      const commandResult = await executePhase(
        "install",
        packageReference,
        workspace,
        operationOptions,
      );
      return resolveInstallRecord({
        phase: "install",
        packageReference,
        workspace,
        commandResult,
        options: operationOptions,
      });
    },
    async update(packageReference, workspace, operationOptions = {}) {
      const commandResult = await executePhase(
        "update",
        packageReference,
        workspace,
        operationOptions,
      );
      return resolveInstallRecord({
        phase: "update",
        packageReference,
        workspace,
        commandResult,
        options: operationOptions,
      });
    },
    async remove(packageReference, workspace, operationOptions = {}) {
      return executePhase(
        "remove",
        packageReference,
        workspace,
        operationOptions,
      );
    },
  };
}

export function createNpmPackageManager(options = {}) {
  const packageManagerCommand = normalizeString(
    options.packageManagerCommand ?? options.command,
    "npm",
  );
  const resolveCwd =
    typeof options.resolveCwd === "function"
      ? options.resolveCwd
      : (packageReference, workspace) =>
          resolvePackageReferenceCwd(packageReference, workspace, options);
  const resolvePluginPackage =
    typeof options.resolvePluginPackage === "function"
      ? options.resolvePluginPackage
      : null;

  return createCommandPackageManager({
    ...options,
    installCommand(packageReference, workspace, operationOptions = {}) {
      const cwd = resolveCwd(packageReference, workspace, operationOptions);
      return {
        command: packageManagerCommand,
        args: [
          "install",
          "--no-save",
          formatPackageInstallSpecifier(packageReference),
        ],
        cwd,
      };
    },
    updateCommand(packageReference, workspace, operationOptions = {}) {
      const cwd = resolveCwd(packageReference, workspace, operationOptions);
      return {
        command: packageManagerCommand,
        args: [
          "install",
          "--no-save",
          formatPackageUpdateSpecifier(packageReference),
        ],
        cwd,
      };
    },
    removeCommand(packageReference, workspace, operationOptions = {}) {
      const cwd = resolveCwd(packageReference, workspace, operationOptions);
      const packageId = normalizeString(packageReference.packageId, null);
      if (!packageId) {
        throw new Error(
          "npm package-manager removal requires packageId on the workspace package reference.",
        );
      }
      return {
        command: packageManagerCommand,
        args: ["uninstall", "--no-save", packageId],
        cwd,
      };
    },
    async resolveInstallRecord({
      packageReference,
      workspace,
      commandResult,
      options: operationOptions = {},
    }) {
      const cwd = resolveCwd(packageReference, workspace, operationOptions);
      const explicitSourceRef = normalizeString(packageReference.sourceRef, null);
      const installPath =
        normalizeString(packageReference.installPath, null) ??
        resolveNodeModulesInstallPath(cwd, packageReference.packageId);
      const pluginPackage = resolvePluginPackage
        ? await resolvePluginPackage(
            packageReference,
            workspace,
            commandResult,
            operationOptions,
          )
        : undefined;
      return {
        packageId: normalizeString(packageReference.packageId, null),
        pluginId: normalizeString(packageReference.pluginId, null),
        version: normalizeString(packageReference.version, null),
        sourceType:
          normalizeString(packageReference.sourceType, null) ?? "npm",
        sourceRef: explicitSourceRef,
        installPath,
        metadata: {
          packageManager: packageManagerCommand,
          requestedSpecifier:
            explicitSourceRef ?? formatPackageInstallSpecifier(packageReference),
          ...(isObject(packageReference.metadata) ? packageReference.metadata : {}),
        },
        ...(pluginPackage ? { pluginPackage } : {}),
      };
    },
  });
}

export default {
  createCommandPackageManager,
  createNodeCommandRunner,
  createNpmPackageManager,
};
