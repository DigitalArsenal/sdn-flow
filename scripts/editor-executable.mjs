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

  await fs.access(denoBinaryPath).catch(() => {
    throw new Error(
      "Local Deno binary not found. Run `npm install` in sdn-flow before building the editor executable.",
    );
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execute(getNpmCommand(options.platform), ["run", "build:editor-assets"], {
    cwd: projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  await execute(
    denoBinaryPath,
    [
      "compile",
      "--allow-net",
      "--allow-read",
      "--output",
      outputPath,
      "./tools/sdn-flow-editor.ts",
    ],
    {
      cwd: projectRoot,
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
