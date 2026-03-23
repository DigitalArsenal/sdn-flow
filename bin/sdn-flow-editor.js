#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startSdnFlowEditorNodeHost } from "../src/editor/index.js";
import { normalizeSdnFlowEditorInitialFlows } from "../src/editor/flowFormat.js";
import {
  getSdnFlowEditorRuntimePaths,
  isLegacyDefaultSdnFlowEditorStartup,
  migrateLegacyDefaultSdnFlowEditorStartup,
  readSdnFlowEditorSettingsFile,
  readSdnFlowEditorSessionFile,
  writeSdnFlowEditorSettingsFile,
  writeSdnFlowEditorSessionFile,
} from "../src/editor/runtimeManager.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 1990;
const DEFAULT_BASE_PATH = "/";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePort(value, fallback = 1990) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

export function formatSdnFlowEditorUsage() {
  return [
    "Usage: sdn-flow-editor [--host <hostname>] [--port <port>] [--base-path <path>] [--flow <flow.json>] [--session-file <session.json>]",
    "",
    "Options:",
    "  --host <hostname>      Hostname to bind. Default: 127.0.0.1",
    "  --port <port>          Port to bind. Default: 1990",
    "  --base-path <path>     Optional mount path, such as /editor.",
    "  --flow <flow.json>     Optional initial flow JSON to load in the editor.",
    "  --session-file <path>  Restart session file written by the Compile workflow.",
    "  --title <title>        Optional window title shown in the editor.",
    "  -h, --help             Show this help text.",
  ].join("\n");
}

export function parseSdnFlowEditorCliArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    hostname: "127.0.0.1",
    port: DEFAULT_PORT,
    basePath: DEFAULT_BASE_PATH,
    flowPath: null,
    sessionFile: null,
    title: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--host":
        parsed.hostname = normalizeString(args[index + 1], parsed.hostname);
        index += 1;
        break;
      case "--port":
        parsed.port = normalizePort(args[index + 1], parsed.port);
        index += 1;
        break;
      case "--base-path":
        parsed.basePath = normalizeString(args[index + 1], parsed.basePath);
        index += 1;
        break;
      case "--flow":
        parsed.flowPath = normalizeString(args[index + 1], null);
        index += 1;
        break;
      case "--session-file":
        parsed.sessionFile = normalizeString(args[index + 1], null);
        index += 1;
        break;
      case "--title":
        parsed.title = normalizeString(args[index + 1], null);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

async function readInitialFlow(flowPath) {
  if (!flowPath) {
    return null;
  }
  const resolvedPath = path.resolve(flowPath);
  const json = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  return {
    resolvedPath,
    json: normalizeSdnFlowEditorInitialFlows(json),
  };
}

async function readSessionFile(sessionFile) {
  if (!sessionFile) {
    return null;
  }
  const resolvedPath = path.resolve(sessionFile);
  return {
    resolvedPath,
    session: await readSdnFlowEditorSessionFile(resolvedPath),
  };
}

async function readRuntimeSettingsFile(projectRoot) {
  const { settingsFilePath } = getSdnFlowEditorRuntimePaths({ projectRoot });
  try {
    return {
      resolvedPath: settingsFilePath,
      settings: await readSdnFlowEditorSettingsFile(settingsFilePath),
    };
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null;
    const name = error && typeof error === "object" ? error.name : null;
    const message =
      error && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : String(error ?? "");
    if (code === "ENOENT" || name === "NotFound" || /ENOENT|NotFound/i.test(message)) {
      return null;
    }
    throw error;
  }
}

function resolveStartupValue(parsedValue, defaultValue, sessionValue, persistedValue) {
  if (sessionValue !== undefined && sessionValue !== null) {
    return parsedValue === defaultValue ? sessionValue : parsedValue;
  }
  if (persistedValue !== undefined && persistedValue !== null) {
    return parsedValue === defaultValue ? persistedValue : parsedValue;
  }
  return parsedValue;
}

function installShutdownHooks(host, options = {}) {
  if (
    options.registerSignalHandlers === false ||
    typeof host?.close !== "function" ||
    typeof process.on !== "function"
  ) {
    return;
  }

  let closing = false;
  const closeHost = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await host.close();
    if (options.exitProcess !== false) {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void closeHost();
  });
  process.on("SIGTERM", () => {
    void closeHost();
  });
}

export async function runSdnFlowEditorCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseSdnFlowEditorCliArgs(argv);
  const log = options.log ?? console.log.bind(console);
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);

  if (parsed.help) {
    log(formatSdnFlowEditorUsage());
    return {
      kind: "help",
      args: parsed,
    };
  }

  const sessionFile = await readSessionFile(parsed.sessionFile);
  const runtimeSettingsFile = sessionFile ? null : await readRuntimeSettingsFile(projectRoot);
  const initialFlow = await readInitialFlow(parsed.flowPath);
  const startup = sessionFile?.session?.startup
    ? migrateLegacyDefaultSdnFlowEditorStartup(sessionFile.session.startup)
    : {};
  if (sessionFile?.session?.startup && isLegacyDefaultSdnFlowEditorStartup(sessionFile.session.startup)) {
    sessionFile.session = {
      ...sessionFile.session,
      startup,
    };
    await writeSdnFlowEditorSessionFile(sessionFile.resolvedPath, sessionFile.session);
  }
  const persistedStartup = runtimeSettingsFile?.settings?.startup
    ? migrateLegacyDefaultSdnFlowEditorStartup(runtimeSettingsFile.settings.startup)
    : {};
  if (
    runtimeSettingsFile?.settings?.startup &&
    isLegacyDefaultSdnFlowEditorStartup(runtimeSettingsFile.settings.startup)
  ) {
    runtimeSettingsFile.settings = {
      ...runtimeSettingsFile.settings,
      startup: persistedStartup,
    };
    await writeSdnFlowEditorSettingsFile(
      runtimeSettingsFile.resolvedPath,
      runtimeSettingsFile.settings,
    );
  }
  const startEditorHost =
    options.startEditorHost ?? startSdnFlowEditorNodeHost;
  const hostname = resolveStartupValue(
    parsed.hostname,
    DEFAULT_HOSTNAME,
    startup.hostname,
    persistedStartup.hostname,
  );
  const port = resolveStartupValue(
    parsed.port,
    DEFAULT_PORT,
    startup.port,
    persistedStartup.port,
  );
  const basePath = resolveStartupValue(
    parsed.basePath,
    DEFAULT_BASE_PATH,
    startup.basePath,
    persistedStartup.basePath,
  );
  const title = resolveStartupValue(
    parsed.title,
    null,
    startup.title,
    persistedStartup.title,
  ) ?? "sdn-flow Editor";
  const protocol = startup.protocol ?? persistedStartup.protocol ?? "http";
  const security = sessionFile?.session?.security ?? runtimeSettingsFile?.settings?.security ?? null;
  const host = await startEditorHost({
    projectRoot,
    protocol,
    hostname,
    port,
    basePath,
    title,
    security,
    initialFlow: sessionFile?.session?.flows ?? initialFlow?.json ?? null,
  });

  if (options.quiet !== true) {
    log(`Started sdn-flow editor at ${host.url}`);
  }

  installShutdownHooks(host, options);

  return {
    kind: "started",
    args: {
      ...parsed,
      flowPath: initialFlow?.resolvedPath ?? parsed.flowPath,
      sessionFile: sessionFile?.resolvedPath ?? parsed.sessionFile,
    },
    host,
  };
}

if (import.meta.main) {
  try {
    await runSdnFlowEditorCli();
  } catch (error) {
    console.error(
      typeof error?.message === "string" ? error.message : String(error),
    );
    console.error("");
    console.error(formatSdnFlowEditorUsage());
    process.exit(1);
  }
}
