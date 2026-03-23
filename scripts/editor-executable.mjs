import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTED_URL_PATTERN = /Started sdn-flow editor at (https?:\/\/\S+)/;

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function getNpmCommand(platform = process.platform) {
  return isWindows(platform) ? "npm.cmd" : "npm";
}

function getBrowserOpenCommand(platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [],
    };
  }
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", ""],
    };
  }
  return {
    command: "xdg-open",
    args: [],
  };
}

export function getSdnFlowEditorExecutableName(platform = process.platform) {
  return `sdn-flow-editor${isWindows(platform) ? ".exe" : ""}`;
}

export function getSdnFlowEditorExecutablePath(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const outputPath = normalizeString(options.outputPath, null);
  return outputPath
    ? path.resolve(projectRoot, outputPath)
    : path.join(projectRoot, "generated-tools", getSdnFlowEditorExecutableName(options.platform));
}

function getLocalDenoBinaryPath(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  return path.join(
    projectRoot,
    "node_modules",
    ".bin",
    isWindows(options.platform) ? "deno.cmd" : "deno",
  );
}

export function extractSdnFlowEditorStartedUrl(value) {
  const match = String(value ?? "").match(STARTED_URL_PATTERN);
  return match ? match[1] : null;
}

export function formatSdnFlowEditorExecutableUsage() {
  return [
    "Usage:",
    "  node scripts/editor-executable.mjs start [wrapper-options] [editor-options]",
    "  node scripts/editor-executable.mjs build [wrapper-options]",
    "",
    "Wrapper options:",
    "  --output <path>        Executable output path. Default: generated-tools/sdn-flow-editor",
    "  --no-open              Do not open the editor URL in a browser after startup.",
    "  --build-only           Build the executable without launching it.",
    "  -h, --help             Show this help text.",
    "",
    "Editor options pass through to the compiled executable, for example:",
    "  npm run start -- --port 9090 --flow ./examples/flows/single-plugin-flow.json",
  ].join("\n");
}

export function parseSdnFlowEditorExecutableArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    command: "start",
    outputPath: null,
    openBrowser: true,
    buildOnly: false,
    help: false,
    editorArgs: [],
  };

  if (args[0] === "start" || args[0] === "build") {
    parsed.command = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--output":
        parsed.outputPath = normalizeString(args[index + 1], null);
        index += 1;
        break;
      case "--no-open":
        parsed.openBrowser = false;
        break;
      case "--open":
        parsed.openBrowser = true;
        break;
      case "--build-only":
        parsed.buildOnly = true;
        break;
      case "--":
        parsed.editorArgs.push(...args.slice(index + 1));
        index = args.length;
        break;
      default:
        parsed.editorArgs.push(token);
        break;
    }
  }

  if (parsed.command === "build") {
    parsed.buildOnly = true;
  }

  return parsed;
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function runCommandCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `${command} ${args.join(" ")} exited with code ${code}`).trim()));
    });
  });
}

function isWithinPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getNodeModulePackageRoot(projectRoot, filePath) {
  const nodeModulesRoot = path.join(projectRoot, "node_modules");
  if (!isWithinPath(nodeModulesRoot, filePath)) {
    return null;
  }
  const relativePath = path.relative(nodeModulesRoot, filePath);
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  const packageSegments = segments[0].startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  if (packageSegments.length === 0) {
    return null;
  }
  return path.join(nodeModulesRoot, ...packageSegments);
}

function getNamedNodeModulePackageRoot(projectRoot, packageName) {
  const segments = String(packageName ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  return path.join(projectRoot, "node_modules", ...segments);
}

async function readPackageJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function getStagePackageManifest(projectPackageJson = {}) {
  const manifest = {
    name: "sdn-flow-editor-stage",
    private: true,
    type: "module",
  };
  const dependencies =
    projectPackageJson && typeof projectPackageJson === "object" ? projectPackageJson.dependencies : null;
  const optionalDependencies =
    projectPackageJson && typeof projectPackageJson === "object"
      ? projectPackageJson.optionalDependencies
      : null;

  if (dependencies && Object.keys(dependencies).length > 0) {
    manifest.dependencies = { ...dependencies };
  }
  if (optionalDependencies && Object.keys(optionalDependencies).length > 0) {
    manifest.optionalDependencies = { ...optionalDependencies };
  }

  return manifest;
}

function resolveLocalFileDependencyPath(projectRoot, specifier) {
  const normalizedSpecifier = normalizeString(specifier, null);
  if (!normalizedSpecifier || normalizedSpecifier.startsWith("file:") === false) {
    return null;
  }
  const relativePath = normalizedSpecifier.slice("file:".length);
  if (!relativePath) {
    return null;
  }
  return path.resolve(projectRoot, relativePath);
}

async function getLocalFileDependencies(projectRoot, projectPackageJson = {}) {
  const localDependencies = new Map();
  const dependencyEntries = [
    ...Object.entries(projectPackageJson.dependencies ?? {}),
    ...Object.entries(projectPackageJson.optionalDependencies ?? {}),
  ];

  for (const [packageName, specifier] of dependencyEntries) {
    const packageRoot = resolveLocalFileDependencyPath(projectRoot, specifier);
    if (!packageRoot) {
      continue;
    }
    try {
      await fs.access(path.join(packageRoot, "package.json"));
      localDependencies.set(packageName, {
        packageName,
        packageRoot,
        installedPackageRoot: getNamedNodeModulePackageRoot(projectRoot, packageName),
        filePaths: new Set(),
      });
    } catch {
      // Ignore missing local dependency roots here and let Deno surface the real resolution error later.
    }
  }

  return localDependencies;
}

function findLocalFileDependencyByPath(localDependencies, filePath) {
  for (const dependencyRecord of localDependencies.values()) {
    if (isWithinPath(dependencyRecord.packageRoot, filePath)) {
      return dependencyRecord;
    }
  }
  return null;
}

async function copyFileToStage(stageDir, sourceRoot, sourcePath, targetRoot) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return;
  }
  const targetPath = path.join(stageDir, targetRoot, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function copyLocalDependencyFilesToStage(stageDir, dependencyRecord) {
  const targetRoot = path.join("node_modules", ...dependencyRecord.packageName.split("/"));
  await copyFileToStage(
    stageDir,
    dependencyRecord.packageRoot,
    path.join(dependencyRecord.packageRoot, "package.json"),
    targetRoot,
  );

  for (const filePath of dependencyRecord.filePaths) {
    await copyFileToStage(stageDir, dependencyRecord.packageRoot, filePath, targetRoot);
  }
}

async function collectPackageRootsWithDependencies(projectRoot, initialPackageRoots = []) {
  const discoveredRoots = new Set();
  const pendingRoots = [...initialPackageRoots];

  while (pendingRoots.length > 0) {
    const packageRoot = pendingRoots.shift();
    if (!packageRoot || discoveredRoots.has(packageRoot)) {
      continue;
    }
    discoveredRoots.add(packageRoot);

    try {
      const packageJsonPath = path.join(packageRoot, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      const dependencyNames = [
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.optionalDependencies ?? {}),
      ];
      for (const dependencyName of dependencyNames) {
        const dependencyRoot = getNamedNodeModulePackageRoot(projectRoot, dependencyName);
        if (!dependencyRoot) {
          continue;
        }
        try {
          await fs.access(dependencyRoot);
          if (!discoveredRoots.has(dependencyRoot)) {
            pendingRoots.push(dependencyRoot);
          }
        } catch {
          // Some optional/runtime-specific dependencies may not be installed locally.
        }
      }
    } catch {
      // Ignore malformed or missing package metadata in the staged closure walk.
    }
  }

  return discoveredRoots;
}

export async function prepareStagedSdnFlowEditorWorkspace(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const denoBinaryPath = options.denoBinaryPath ?? getLocalDenoBinaryPath(options);
  const stageDir = path.join(projectRoot, "generated-tools", ".build", "editor-executable-stage");
  const capture = options.runCommandCapture ?? runCommandCapture;
  const projectPackageJson = await readPackageJson(path.join(projectRoot, "package.json")).catch(() => ({}));
  const localDependencies = await getLocalFileDependencies(projectRoot, projectPackageJson);
  const graphResult = await capture(
    denoBinaryPath,
    ["info", "--json", "./tools/sdn-flow-editor.ts"],
    {
      cwd: projectRoot,
      env: options.env ?? process.env,
    },
  );
  const graph = JSON.parse(graphResult.stdout);
  const filePaths = new Set();
  const packageRoots = new Set();

  for (const moduleRecord of graph.modules ?? []) {
    const specifier = String(moduleRecord?.specifier ?? "");
    if (!specifier.startsWith("file://")) {
      continue;
    }
    const filePath = fileURLToPath(specifier);
    if (!isWithinPath(projectRoot, filePath)) {
      const localDependency = findLocalFileDependencyByPath(localDependencies, filePath);
      if (localDependency) {
        localDependency.filePaths.add(filePath);
        if (localDependency.installedPackageRoot) {
          packageRoots.add(localDependency.installedPackageRoot);
        }
      }
      continue;
    }
    const packageRoot = getNodeModulePackageRoot(projectRoot, filePath);
    if (packageRoot) {
      packageRoots.add(packageRoot);
      continue;
    }
    filePaths.add(filePath);
  }
  const expandedPackageRoots = await collectPackageRootsWithDependencies(projectRoot, packageRoots);

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  await fs.writeFile(
    path.join(stageDir, "package.json"),
    JSON.stringify(getStagePackageManifest(projectPackageJson), null, 2),
    "utf8",
  );

  for (const filePath of filePaths) {
    const relativePath = path.relative(projectRoot, filePath);
    const targetPath = path.join(stageDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(filePath, targetPath);
  }

  const localPackageRoots = new Set(
    [...localDependencies.values()]
      .map((dependencyRecord) => dependencyRecord.installedPackageRoot)
      .filter(Boolean),
  );
  for (const packageRoot of expandedPackageRoots) {
    if (localPackageRoots.has(packageRoot)) {
      continue;
    }
    const relativePath = path.relative(projectRoot, packageRoot);
    const targetPath = path.join(stageDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(packageRoot, targetPath, {
      recursive: true,
      force: true,
    });
  }

  for (const dependencyRecord of localDependencies.values()) {
    if (dependencyRecord.filePaths.size > 0) {
      await copyLocalDependencyFilesToStage(stageDir, dependencyRecord);
    }
  }

  return {
    cwd: stageDir,
    entryPath: "./tools/sdn-flow-editor.ts",
    stageDir,
  };
}

export async function buildSdnFlowEditorExecutable(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const outputPath = getSdnFlowEditorExecutablePath({
    projectRoot,
    outputPath: options.outputPath,
    platform: options.platform,
  });
  const denoBinaryPath = getLocalDenoBinaryPath({
    projectRoot,
    platform: options.platform,
  });
  const execute = options.runCommand ?? runCommand;
  const prepareCompileWorkspace =
    options.prepareCompileWorkspace ?? prepareStagedSdnFlowEditorWorkspace;

  await fs.access(denoBinaryPath).catch(() => {
    throw new Error(
      "Local Deno binary not found. Run `npm install` in sdn-flow before building the editor executable.",
    );
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execute(getNpmCommand(options.platform), ["run", "build:shared-runtime-constants"], {
    cwd: projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  await execute(getNpmCommand(options.platform), ["run", "build:editor-assets"], {
    cwd: projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  const compileWorkspace = await prepareCompileWorkspace({
    projectRoot,
    denoBinaryPath,
    platform: options.platform,
    env: options.env,
  });
  await execute(
    denoBinaryPath,
    [
      "compile",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-sys",
      "--output",
      outputPath,
      compileWorkspace.entryPath ?? "./tools/sdn-flow-editor.ts",
    ],
    {
      cwd: compileWorkspace.cwd ?? projectRoot,
      env: options.env,
      stdio: "inherit",
    },
  );

  return {
    outputPath,
    denoBinaryPath,
  };
}

export async function openSdnFlowEditorBrowser(url, options = {}) {
  const launch = options.launchCommand ?? runCommand;
  const { command, args } = getBrowserOpenCommand(options.platform);
  await launch(command, [...args, url], {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env,
    stdio: "ignore",
  });
}

function installSignalForwarding(child, options = {}) {
  if (options.registerSignalHandlers === false) {
    return () => {};
  }

  const relay = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);
  return () => {
    process.off("SIGINT", relay);
    process.off("SIGTERM", relay);
  };
}

export async function launchSdnFlowEditorExecutable(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const outputPath = getSdnFlowEditorExecutablePath({
    projectRoot,
    outputPath: options.outputPath,
    platform: options.platform,
  });
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const openBrowser = options.openBrowser !== false;
  const openUrl = options.openUrl ?? openSdnFlowEditorBrowser;

  await fs.access(outputPath).catch(() => {
    throw new Error(
      `Editor executable not found at ${outputPath}. Run \`npm run build:editor-executable\` first.`,
    );
  });

  const child = spawnProcess(outputPath, options.editorArgs ?? [], {
    cwd: projectRoot,
    env: options.env ?? process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let outputBuffer = "";
  let opened = false;

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout.write(text);
      outputBuffer = `${outputBuffer}${text}`.slice(-4096);
      const startedUrl = extractSdnFlowEditorStartedUrl(outputBuffer);
      if (startedUrl && opened === false) {
        opened = true;
        options.onStarted?.(startedUrl);
        if (openBrowser) {
          void openUrl(startedUrl, {
            cwd: projectRoot,
            env: options.env,
            platform: options.platform,
            launchCommand: options.launchCommand,
          }).catch((error) => {
            const warn = options.warn ?? console.warn.bind(console);
            warn(
              `Failed to open browser automatically: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
    });
  }

  const disposeSignalHandlers = installSignalForwarding(child, options);

  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      disposeSignalHandlers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      disposeSignalHandlers();
      resolve({
        code,
        signal,
      });
    });
  });

  return {
    child,
    exitPromise,
    outputPath,
  };
}

export async function runSdnFlowEditorExecutableCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseSdnFlowEditorExecutableArgs(argv);
  const log = options.log ?? console.log.bind(console);

  if (parsed.help) {
    log(formatSdnFlowEditorExecutableUsage());
    return {
      kind: "help",
      args: parsed,
    };
  }

  const buildResult = await buildSdnFlowEditorExecutable({
    projectRoot: options.projectRoot,
    outputPath: parsed.outputPath,
    platform: options.platform,
    env: options.env,
    runCommand: options.runCommand,
  });

  if (options.quiet !== true) {
    log(`Built sdn-flow editor executable at ${buildResult.outputPath}`);
  }

  if (parsed.buildOnly) {
    return {
      kind: "built",
      args: parsed,
      outputPath: buildResult.outputPath,
    };
  }

  const launched = await launchSdnFlowEditorExecutable({
    projectRoot: options.projectRoot,
    outputPath: buildResult.outputPath,
    platform: options.platform,
    env: options.env,
    editorArgs: parsed.editorArgs,
    openBrowser: parsed.openBrowser,
    spawnProcess: options.spawnProcess,
    openUrl: options.openUrl,
    launchCommand: options.launchCommand,
    registerSignalHandlers: options.registerSignalHandlers,
    stdout: options.stdout,
    stderr: options.stderr,
    onStarted: options.onStarted,
    warn: options.warn,
  });

  const exitResult = await launched.exitPromise;
  if (exitResult.code && exitResult.code !== 0) {
    throw new Error(`sdn-flow editor executable exited with code ${exitResult.code}`);
  }

  return {
    kind: "stopped",
    args: parsed,
    outputPath: buildResult.outputPath,
    exit: exitResult,
  };
}

if (import.meta.main) {
  try {
    await runSdnFlowEditorExecutableCommand();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(formatSdnFlowEditorExecutableUsage());
    process.exit(1);
  }
}
